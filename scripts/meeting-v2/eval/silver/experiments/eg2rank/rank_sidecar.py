# EG2 audio rank sidecar for the Openstyle POC (OPENSTYLE_ASR_AUDIO_RANK).
# POST /rank {wav_path, start_ms, end_ms, terms[]} -> {order[], ms}
# Method M7 neighbor: mean of the audio vectors of [start-22.5s, start],
# [start, end] and [end, end+22.5s] (clipped to the file), renormalized,
# cosine against bare term vectors (document prefix).
# GET /stats -> call count and latency. Logs numbers only, never text.
# Run: <EG2 venv python> -I rank_sidecar.py   (RANK_PORT, default 8790; loopback only)
# Auth: every request needs the token, as ?token=<t> or the X-Rank-Token header.
# The token is RANK_TOKEN, else a random one that is printed once to stderr.
# The POC client sends it in its URL: OPENSTYLE_ASR_AUDIO_RANK_URL=http://127.0.0.1:8790/rank?token=<t>.
# Without it, any local process could make the sidecar read a wav file and rank terms.
import hmac, json, os, secrets, sys, threading, time, wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit
import numpy as np, torch
from sentence_transformers import SentenceTransformer

PORT = int(os.environ.get("RANK_PORT", "8790"))
TOKEN = os.environ.get("RANK_TOKEN", "").strip()
if not TOKEN:
    TOKEN = secrets.token_urlsafe(24)
    print(f"token {TOKEN} (terminal only)", file=sys.stderr, flush=True)
SR, NB_S, MIN_S = 16000, 22.5, 1.0

dev = "mps" if torch.backends.mps.is_available() else "cpu"
t0 = time.time()
model = SentenceTransformer("google/embeddinggemma-2", device=dev,
                            model_kwargs={"torch_dtype": torch.bfloat16},
                            config_kwargs={"vision_config": None})
print(f"loaded on {dev} in {time.time() - t0:.1f}s", file=sys.stderr, flush=True)

def norm(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)

term_vec = {}     # term text -> unit vector
wav_cache = {}    # path -> (size, mtime, samples)
win_cache = {}    # (meeting dir, file, size, a, b) -> unit vector
stats = {"calls": 0, "ms": [], "windows_encoded": 0, "windows_cached": 0, "errors": 0}

def read_wav(path):
    st = os.stat(path)
    hit = wav_cache.get(path)
    if hit and hit[0] == st.st_size and hit[1] == st.st_mtime:
        return hit[2], st.st_size
    w = wave.open(path)
    ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    if sw != 2:
        raise ValueError(f"sample width {sw}")
    a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    w.close()
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if sr != SR:
        a = np.interp(np.arange(int(len(a) * SR / sr)) * (sr / SR), np.arange(len(a)), a).astype(np.float32)
    if len(wav_cache) > 4:
        wav_cache.clear()
    wav_cache[path] = (st.st_size, st.st_mtime, a)
    return a, st.st_size

def rank(req):
    path, s_ms, e_ms, terms = req["wav_path"], int(req["start_ms"]), int(req["end_ms"]), req["terms"]
    audio, size = read_wav(path)
    n = len(audio)
    s, e, nb = int(s_ms * SR / 1000), int(e_ms * SR / 1000), int(NB_S * SR)
    vecs = []
    for a, b in ((s - nb, s), (s, e), (e, e + nb)):
        a, b = max(0, a), min(n, b)
        if b - a < MIN_S * SR:
            continue
        key = (os.path.basename(os.path.dirname(path)), os.path.basename(path), size, a, b)
        v = win_cache.get(key)
        if v is None:
            v = norm(model.encode([{"audio": {"array": audio[a:b], "sampling_rate": SR}}],
                                  convert_to_numpy=True)[0].astype(np.float32))
            if not np.isfinite(v).all():
                raise ValueError("non-finite audio vector")
            win_cache[key] = v
            stats["windows_encoded"] += 1
        else:
            stats["windows_cached"] += 1
        vecs.append(v)
    if not vecs:
        return list(terms)
    q = norm(np.mean(vecs, axis=0))
    missing = [t for t in dict.fromkeys(terms) if t not in term_vec]
    if missing:
        M = norm(model.encode(missing, prompt_name="document", convert_to_numpy=True, batch_size=16).astype(np.float32))
        term_vec.update(zip(missing, M))
    D = np.stack([term_vec[t] for t in terms])
    order = np.argsort(-(D @ q), kind="stable")
    return [terms[i] for i in order]

lock = threading.Lock()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def authorized(self):
        """Split the query from self.path, and check the token (constant-time compare)."""
        u = urlsplit(self.path)
        self.path = u.path
        got = self.headers.get("X-Rank-Token") or (parse_qs(u.query).get("token") or [""])[0]
        if hmac.compare_digest(got.encode(), TOKEN.encode()):
            return True
        self.reply(401, {})
        return False

    def do_GET(self):
        if not self.authorized():
            return
        if self.path != "/stats":
            return self.reply(404, {})
        ms = stats["ms"]
        self.reply(200, {k: v for k, v in stats.items() if k != "ms"} | {
            "mean_ms": round(float(np.mean(ms)), 1) if ms else None,
            "p95_ms": round(float(np.percentile(ms, 95)), 1) if ms else None})

    def do_POST(self):
        if not self.authorized():
            return
        if self.path == "/reset":
            stats.update(calls=0, ms=[], windows_encoded=0, windows_cached=0, errors=0)
            return self.reply(200, {"ok": True})
        if self.path != "/rank":
            return self.reply(404, {})
        try:
            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with lock:
                t = time.perf_counter()
                order = rank(req)
                dt = (time.perf_counter() - t) * 1000
                stats["calls"] += 1
                stats["ms"].append(dt)
            self.reply(200, {"order": order, "ms": round(dt, 1)})
        except Exception as ex:
            stats["errors"] += 1
            print(f"error: {type(ex).__name__}", file=sys.stderr, flush=True)
            self.reply(500, {"error": type(ex).__name__})

HTTPServer(("127.0.0.1", PORT), H).serve_forever()
