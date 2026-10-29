"""Minimal OpenAI-compatible speech server for Nemotron 3.5 Transcribe (mlx-audio).

oMLX 0.7.3 bundles mlx-audio 0.5.7. That version has no `nemotron_transcribe`
model type. This server loads the model with the pinned mlx-audio instead and
answers `POST /v1/audio/transcriptions` and `GET /v1/models`, so the app can
use it as an "own server" voice provider. It binds to 127.0.0.1 only.

Run: venv/bin/python -I serve_openai.py <model_dir> <stats_dir> [port]
The `model` field of a request selects the bias mode:
  nemotron-ctx    "Transcribe ... Context terms: <the app terms>." (default; any other id too)
  nemotron-hot    the app terms go in the model's `hotwords` field
  nemotron-plain  the app terms are ignored (plain prompt)
Env: NEMO_TOKCAP = 1 (default) caps new tokens by the audio length
The stats file in <stats_dir> holds numbers only (no text).
"""

import json
import os
import sys
import tempfile
import threading
import time
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psutil

MD, STATS_DIR = sys.argv[1], sys.argv[2]
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8765
TOKCAP = os.environ.get("NEMO_TOKCAP", "1") == "1"
MODEL_NAME = os.path.basename(MD.rstrip("/"))
PLAIN = "Transcribe with punctuation and capitalization."
LABEL = "Technical terms:"

os.makedirs(STATS_DIR, mode=0o700, exist_ok=True)
STATS = os.path.join(STATS_DIR, "stats.jsonl")
LOCK = threading.Lock()
STATE = {"model": None, "load_s": None, "peak_rss": 0}
PROC = psutil.Process()


def _poll():
    while True:
        STATE["peak_rss"] = max(STATE["peak_rss"], PROC.memory_info().rss)
        time.sleep(0.2)


threading.Thread(target=_poll, daemon=True).start()


def get_model():
    if STATE["model"] is None:
        import mlx.core as mx
        from mlx_audio.stt import load

        t = time.perf_counter()
        m = load(MD, strict=True)
        mx.eval(m.parameters())
        STATE["load_s"] = time.perf_counter() - t
        STATE["model"] = m
        with open(STATS, "a") as f:
            f.write(json.dumps({"event": "load", "load_s": round(STATE["load_s"], 1),
                                "rss_gb": round(STATE["peak_rss"] / 2**30, 2)}) + "\n")
    return STATE["model"]


def terms_of(prompt):
    p = (prompt or "").strip()
    if p.startswith(LABEL):
        p = p[len(LABEL):].strip()
    return p


def transcribe(wav_bytes, prompt, alias):
    BIAS = {"nemotron-hot": "hotwords", "nemotron-plain": "plain"}.get(alias, "context")
    import mlx.core as mx
    from mlx_audio.stt.utils import load_audio

    model = get_model()
    fd, path = tempfile.mkstemp(suffix=".wav", dir=STATS_DIR)
    try:
        os.write(fd, wav_bytes)
        os.close(fd)
        audio = load_audio(path, sr=16000)
    finally:
        os.unlink(path)
    dur = audio.shape[0] / 16000
    terms = terms_of(prompt)
    kw = {}
    if BIAS == "context" and terms:
        kw["prompt"] = f"{PLAIN} Context terms: {terms}."
    elif BIAS == "hotwords" and terms:
        kw["hotwords"] = terms
    else:
        kw["prompt"] = PLAIN
    max_tokens = min(1024, int(dur * 4) + 24) if TOKCAP else 1024
    mx.reset_peak_memory()
    t = time.perf_counter()
    r = model.generate(audio, max_tokens=max_tokens, **kw)
    el = time.perf_counter() - t
    text = r.text.strip()
    with open(STATS, "a") as f:
        f.write(json.dumps({
            "event": "req", "audio_s": round(dur, 2), "gen_s": round(el, 2),
            "prompt_tok": r.prompt_tokens, "gen_tok": r.generation_tokens,
            "capped": r.generation_tokens >= max_tokens, "empty": not text,
            "mlx_peak_gb": round(mx.get_peak_memory() / 2**30, 2),
            "rss_peak_gb": round(STATE["peak_rss"] / 2**30, 2),
            "bias": bool(terms) and BIAS != "plain", "bias_mode": BIAS,
        }) + "\n")
    return text


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            self._json(200, {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/audio/transcriptions":
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        msg = BytesParser(policy=HTTP).parsebytes(
            b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + body)
        fields = {}
        for part in msg.iter_parts():
            fields[part.get_param("name", header="content-disposition")] = part.get_payload(decode=True)
        try:
            with LOCK:
                text = transcribe(fields["file"], (fields.get("prompt") or b"").decode(),
                                  (fields.get("model") or b"").decode())
            self._json(200, {"text": text})
        except Exception as e:  # numbers and the error class only
            self._json(500, {"error": type(e).__name__ + ": " + str(e)[:200]})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"serving {MODEL_NAME} on 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
