"""Gemini witness: chunk each channel, upload (Files API), transcribe, delete. Counts only on stdout.

Run: GEMINI_API_KEY=... GEM_MODEL=<model> <venv python> -I gemini_run.py [--only id8:ch:k[,id8:ch:k...]] [--workers N]
CLOUD: this sends meeting audio to Google. Run it only with the owner's approval (see the silver-gold skill).
The key is read only from the environment and goes in the x-goog-api-key header (never in a URL, so an error cannot print it).
GEM_MODEL defaults to gemini-4-argon. Raw chunk results go to $SILVER_WORK/cloud/raw/<model>/<id8>_<ch>_<k>.json (mode 600; a rerun skips them).
MLflow: one parent span per meeting/channel, one child span per chunk; attributes hold counts only.
"""
import json, os, sys, time, wave, subprocess, threading, re, concurrent.futures as cf
import requests, mlflow
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

CORP = P.CORPUS
MEET = P.MEET
IDS = P.meeting_ids()
MODEL = os.environ.get("GEM_MODEL", "gemini-4-argon")
# gemini-2.5 models take a thinking budget, not a level; 0 = no thinking.
THINK = {"thinkingBudget": 0} if MODEL.startswith("gemini-2.5") else {"thinkingLevel": "low"}
CHUNK, OVL = 600.0, 5.0
AUTH = {"x-goog-api-key": P.require_env("GEMINI_API_KEY")}
BASE = "https://generativelanguage.googleapis.com"
RAW, TMP = P.work_dir("cloud", "raw", MODEL), P.work_dir("cloud", "tmp")

PROMPT = (
    "Transcribe this audio recording verbatim in English. It is one channel of a work meeting.\n"
    "Rules:\n"
    "- Write every spoken word as it is said. Do not summarize, shorten, paraphrase, translate or correct grammar.\n"
    "- Do not add any word that is not spoken. If a part is silent, noise or music, write nothing for it.\n"
    "- Start a new item at each pause longer than about 1 second and at each speaker change. An item is at most 30 seconds long.\n"
    "- Do not name, label or guess speakers.\n"
    "- start and end are the times of the item, relative to the start of this audio file, as MM:SS.\n"
    "- If there is no speech at all, return an empty list."
)
SCHEMA = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "start": {"type": "STRING"}, "end": {"type": "STRING"}, "text": {"type": "STRING"}}, "required": ["start", "end", "text"]}}


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def full_id(m):
    return next(d for d in os.listdir(MEET) if d.startswith(m))


def chunks_of(dur):
    out, k = [], 0
    while k * CHUNK < dur:
        s = max(0.0, k * CHUNK - (OVL if k else 0.0))
        e = min(dur, (k + 1) * CHUNK)
        out.append((k, s, e))
        k += 1
    return out


def ts(v):
    v = (v or "").strip()
    p = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", v)]
    if not p:
        return None
    sec = 0.0
    for x in p[-3:]:
        sec = sec * 60 + x
    return sec


def req(method, url, headers=None, **kw):
    for a in range(6):
        try:
            r = requests.request(method, url, timeout=900, headers={**AUTH, **(headers or {})}, **kw)
        except requests.RequestException as e:
            err = repr(e)[:200]
        else:
            if r.status_code < 400:
                return r
            err = f"HTTP {r.status_code}: {r.text[:300]}"
            if r.status_code not in (408, 429, 500, 502, 503, 504):
                raise RuntimeError(err)
        time.sleep(min(120, 10 * 2 ** a))
    raise RuntimeError("retries exhausted: " + err)


def upload(path, mime):
    n = os.path.getsize(path)
    r = req("POST", f"{BASE}/upload/v1beta/files", headers={
        "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": str(n), "X-Goog-Upload-Header-Content-Type": mime,
        "Content-Type": "application/json"}, json={"file": {"display_name": "chunk"}})
    up = r.headers["X-Goog-Upload-URL"]
    with open(path, "rb") as f:
        r = req("POST", up, headers={"Content-Length": str(n), "X-Goog-Upload-Offset": "0",
                                     "X-Goog-Upload-Command": "upload, finalize"}, data=f.read())
    fobj = r.json()["file"]
    name = fobj["name"]
    try:
        for _ in range(60):
            if fobj.get("state") == "ACTIVE":
                return fobj
            time.sleep(2)
            fobj = req("GET", f"{BASE}/v1beta/{name}").json()
        raise RuntimeError("file not ACTIVE")
    except BaseException:
        # The file is on Google from here on: delete it when the wait fails.
        delete_logged(name)
        raise


def delete(name):
    r = requests.delete(f"{BASE}/v1beta/{name}", headers=AUTH, timeout=60)
    return r.status_code


def delete_logged(name):
    """Delete an uploaded file and record (name, HTTP code) in DELETED."""
    code = delete(name)
    with LOCK:
        DELETED.append((name, code))
    return code


def h1_words(m, ch, s, e):
    h = J(f"{CORP}/{m}/h1.json")["channels"][ch]
    return sum(len((x["text"] or "").split()) for x in h if s * 1000 <= (x["startMs"] + x["endMs"]) / 2 < e * 1000)


DELETED = []
ATTEMPT = int(os.environ.get("GEM_ATTEMPT", "1"))
LOCK = threading.Lock()


def one_chunk(m, ch, wav, k, s, e):
    rp = f"{RAW}/{m}_{ch}_{k}.json"
    if os.path.exists(rp):
        return J(rp), False
    mp3 = f"{TMP}/{m}_{ch}_{k}.mp3"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{s:.3f}", "-t", f"{e - s:.3f}", "-i", wav,
                    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", mp3], check=True)
    nbytes = os.path.getsize(mp3)
    hw = h1_words(m, ch, s, e)
    with mlflow.start_span(name="gemini.chunk", span_type="LLM") as sp:
        sp.set_attributes({"step": "gemini.chunk", "model": MODEL, "meeting": m, "channel": ch, "chunk": k,
                           "start_s": round(s, 3), "duration_s": round(e - s, 3), "bytes": nbytes, "format": "mp3 16k mono 48 kbps"})
        t0 = time.time()
        fobj = upload(mp3, "audio/mpeg")
        t_up = time.time() - t0
        try:
            body = {"contents": [{"role": "user", "parts": [{"file_data": {"mime_type": "audio/mpeg", "file_uri": fobj["uri"]}}, {"text": PROMPT}]}],
                    "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "responseSchema": SCHEMA,
                                         "thinkingConfig": THINK}}
            t1 = time.time()
            r = req("POST", f"{BASE}/v1beta/models/{MODEL}:generateContent", json=body)
            lat = time.time() - t1
        finally:
            code = delete_logged(fobj["name"])
        d = r.json()
        cand = (d.get("candidates") or [{}])[0]
        txt = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []) if not p.get("thought"))
        items = json.loads(txt) if txt.strip() else []
        segs = []
        for it in items:
            a, b = ts(it.get("start")), ts(it.get("end"))
            t = (it.get("text") or "").strip()
            if a is None or not t:
                continue
            b = b if b is not None and b >= a else a
            segs.append({"startMs": int(round((s + a) * 1000)), "endMs": int(round((s + b) * 1000)), "text": t})
        u = d.get("usageMetadata") or {}
        gw = sum(len(x["text"].split()) for x in segs)
        ratio = (gw / hw) if hw else None
        flag = (ratio is not None and not (0.6 <= ratio <= 1.6)) or (hw == 0 and gw > 20)
        late = sum(1 for x in segs if x["startMs"] > e * 1000 + 2000)
        res = {"meeting": m, "channel": ch, "chunk": k, "startS": s, "endS": e, "bytes": nbytes, "upload_s": round(t_up, 2),
               "latency_s": round(lat, 2), "finishReason": cand.get("finishReason"), "usage": u, "h1_words": hw,
               "gem_words": gw, "ratio": None if ratio is None else round(ratio, 3), "flag": flag, "late_segments": late,
               "model": MODEL, "thinkingConfig": THINK, "modelVersion": d.get("modelVersion"), "promptFeedback": d.get("promptFeedback"), "attempt": ATTEMPT, "segments": segs}
        sp.set_attributes({"upload_s": round(t_up, 2), "latency_s": round(lat, 2), "finish_reason": str(cand.get("finishReason")),
                           "prompt_tokens": u.get("promptTokenCount", 0), "output_tokens": u.get("candidatesTokenCount", 0),
                           "thinking_tokens": u.get("thoughtsTokenCount", 0), "n_segments": len(segs), "n_words": gw,
                           "h1_words": hw, "ratio": -1 if ratio is None else round(ratio, 3), "flag": flag,
                           "model_version": str(d.get("modelVersion")), "thinking_config": json.dumps(THINK), "file_deleted_http": code, "attempt": ATTEMPT,
                           "block_reason": str((d.get("promptFeedback") or {}).get("blockReason"))})
        sp.set_outputs({"n_segments": len(segs), "n_words": gw})
    os.remove(mp3)
    with open(rp + ".tmp", "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False)
    os.chmod(rp + ".tmp", 0o600)
    os.replace(rp + ".tmp", rp)
    return res, True


def run_channel(m, ch, only_k=None):
    wav = f"{MEET}/{full_id(m)}/{ch}.wav"
    w = wave.open(wav)
    dur = w.getnframes() / w.getframerate()
    w.close()
    cl = chunks_of(dur)
    if only_k is not None:
        cl = [c for c in cl if c[0] == only_k]
    out = []
    with mlflow.start_span(name="gemini.channel", span_type="CHAIN") as p:
        p.set_attributes({"step": "gemini.channel", "model": MODEL, "meeting": m, "channel": ch, "chunks": len(cl),
                          "duration_s": round(dur, 1), "chunk_s": CHUNK, "overlap_s": OVL})
        p.set_inputs({"meeting": m, "channel": ch, "chunks": len(cl)})
        for k, s, e in cl:
            res, new = one_chunk(m, ch, wav, k, s, e)
            out.append(res)
            print(f"{m} {ch} k={k} new={new} words={res['gem_words']}/{res['h1_words']} ratio={res['ratio']} flag={res['flag']} "
                  f"fin={res['finishReason']} lat={res['latency_s']}", flush=True)
        p.set_outputs({"chunks_done": len(out), "words": sum(r["gem_words"] for r in out), "flagged": sum(r["flag"] for r in out)})
    return out


if __name__ == "__main__":
    mlflow.set_tracking_uri(P.mlflow_uri())
    exp = mlflow.set_experiment(P.MLFLOW_EXPERIMENT)
    print("experiment", exp.experiment_id, "model", MODEL, flush=True)
    jobs = [(m, ch, None) for m in IDS for ch in ("mic", "system")]
    if "--only" in sys.argv:
        jobs = []
        for it in sys.argv[sys.argv.index("--only") + 1].split(","):
            m, ch, k = it.split(":")
            jobs.append((m, ch, int(k)))
    nw = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 4
    fails = []
    with cf.ThreadPoolExecutor(nw) as ex:
        futs = {ex.submit(run_channel, *j): j for j in jobs}
        for f in cf.as_completed(futs):
            try:
                f.result()
            except Exception as e:
                fails.append((futs[f], repr(e)[:400]))
                print("FAIL", futs[f], repr(e)[:400], flush=True)
    bad = [x for x in DELETED if x[1] != 200]
    print(f"files deleted: {len(DELETED) - len(bad)}/{len(DELETED)} (HTTP 200); non-200: {bad}", flush=True)
    print("failed jobs:", fails, flush=True)
