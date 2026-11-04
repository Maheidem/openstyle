"""Minimal OpenAI-compatible speech server for LFM3-Audio-2B (mlx-vlm).

oMLX 0.7.x does not route audio transcriptions to LFM3-Audio. This server loads the
model with mlx-vlm (>= 0.7.11) and answers `POST /v1/audio/transcriptions` and
`GET /v1/models`, so the lab can use it as an "own server" voice provider
(LAB_ASR_SERVER_URL). It binds to 127.0.0.1 only. The stats file holds numbers only.

Run: python serve_openai.py <model_dir> <stats_dir> [port]
The `model` field of a request selects the system prompt:
  lfm3-auto   "Perform ASR."  (the model infers the language; default)
  lfm3-lang   "Perform ASR in <language>." with the `language` field of the request
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

MD, STATS_DIR = sys.argv[1], sys.argv[2]
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8766
LANGS = {"en": "English", "es": "Spanish", "pt": "Portuguese"}
os.makedirs(STATS_DIR, mode=0o700, exist_ok=True)
STATS = os.path.join(STATS_DIR, "lfm3-stats.jsonl")
LOCK = threading.Lock()
STATE = {"model": None}


def get_model():
    if STATE["model"] is None:
        from mlx_vlm import load

        t = time.perf_counter()
        model, processor = load(MD)
        STATE["model"] = (model, processor)
        with open(STATS, "a") as f:
            f.write(json.dumps({"event": "load", "load_s": round(time.perf_counter() - t, 1)}) + "\n")
    return STATE["model"]


def transcribe(wav_bytes, alias, language):
    from mlx_vlm import generate
    from mlx_vlm.prompt_utils import apply_chat_template

    model, processor = get_model()
    system = "Perform ASR."
    if alias == "lfm3-lang" and language in LANGS:
        system = f"Perform ASR in {LANGS[language]}."
    fd, path = tempfile.mkstemp(suffix=".wav", dir=STATS_DIR)
    try:
        os.write(fd, wav_bytes)
        os.close(fd)
        prompt = apply_chat_template(
            processor, model.config, [{"role": "system", "content": system}, ""],
            num_images=0, num_audios=1, enable_thinking=False,
        )
        t = time.perf_counter()
        r = generate(model, processor, prompt, audio=[path], temperature=0.0, max_tokens=2048, verbose=False)
        el = time.perf_counter() - t
    finally:
        os.unlink(path)
    text = (r.text or "").strip()
    with open(STATS, "a") as f:
        f.write(json.dumps({
            "event": "req", "bytes": len(wav_bytes), "gen_s": round(el, 2),
            "prompt_tok": getattr(r, "prompt_tokens", None), "gen_tok": getattr(r, "generation_tokens", None),
            "peak_gb": round(getattr(r, "peak_memory", 0), 2), "empty": not text, "alias": alias,
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
            self._json(200, {"object": "list", "data": [{"id": "lfm3-auto", "object": "model"}, {"id": "lfm3-lang", "object": "model"}]})
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
                text = transcribe(fields["file"], (fields.get("model") or b"").decode(),
                                  (fields.get("language") or b"").decode())
            self._json(200, {"text": text})
        except Exception as e:  # numbers and the error class only
            self._json(500, {"error": type(e).__name__ + ": " + str(e)[:200]})


if __name__ == "__main__":
    get_model()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"serving LFM3-Audio on 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
