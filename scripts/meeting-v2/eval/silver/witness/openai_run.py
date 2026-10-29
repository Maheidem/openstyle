"""OpenAI witness: chunk each channel, transcribe (POST /v1/audio/transcriptions). Counts only on stdout.

Run: OPENAI_API_KEY=... OAI_MODEL=<model> <venv python> -I openai_run.py [--only id8:ch:k,...] [--workers N] [--format json]
CLOUD: this sends meeting audio to OpenAI. Run it only with the owner's approval (see the silver-gold skill).
The key is read only from the environment (OPENAI_API_KEY). It is never printed or written.
Raw chunk results: $SILVER_WORK/cloud/raw/openai-<model>/<id8>_<ch>_<k>.json (mode 600; a rerun skips them).
Cost ledger: $SILVER_WORK/cloud/openai_ledger.json (cumulative USD over all models). The run stops before a chunk
when spent + this chunk's estimate would pass STOP_USD (85 % of the 50 BRL cap).
MLflow: one parent span per channel, one child span per chunk; attributes hold counts only.
"""
import json, os, sys, time, wave, subprocess, threading, concurrent.futures as cf
import requests, mlflow
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

CORP = P.CORPUS
MEET = P.MEET
IDS = P.meeting_ids()
MODEL = os.environ.get("OAI_MODEL", "gpt-transcribe")
FMT = sys.argv[sys.argv.index("--format") + 1] if "--format" in sys.argv else "json"
# USD per audio minute (developers.openai.com/api/docs/pricing, read 2026-10-28) and per 1M tokens (in, out).
PER_MIN = {"gpt-transcribe": 0.0045, "gpt-4o-transcribe": 0.006, "gpt-4o-mini-transcribe": 0.003,
           "gpt-4o-transcribe-diarize": 0.006, "whisper-1": 0.006}
PER_TOK = {"gpt-4o-transcribe": (2.5, 10.0), "gpt-4o-mini-transcribe": (1.25, 5.0), "gpt-4o-transcribe-diarize": (2.5, 10.0)}
BRL_PER_USD = 5.348375  # open.er-api.com, time_last_update 2026-10-28 00:02 UTC (ECB/frankfurter: 5.3271)
CAP_USD = 50 / BRL_PER_USD
STOP_USD = 0.85 * CAP_USD
CHUNK, OVL = 600.0, 5.0
BASE = "https://api.openai.com/v1"
RAW, TMP = P.work_dir("cloud", "raw", f"openai-{MODEL}"), P.work_dir("cloud", "tmp")
LEDGER = os.path.join(P.work_dir("cloud"), "openai_ledger.json")
HDR = {"Authorization": "Bearer " + P.require_env("OPENAI_API_KEY")}
LOCK = threading.Lock()
STOPPED = threading.Event()


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def full_id(m):
    return next(d for d in os.listdir(MEET) if d.startswith(m))


def chunks_of(dur):
    out, k = [], 0
    while k * CHUNK < dur:
        out.append((k, max(0.0, k * CHUNK - (OVL if k else 0.0)), min(dur, (k + 1) * CHUNK)))
        k += 1
    return out


def ledger():
    return J(LEDGER) if os.path.exists(LEDGER) else {"usd": 0.0, "chunks": 0, "seconds": 0.0, "by_model": {}}


def save_ledger(L):
    with open(LEDGER + ".tmp", "w") as f:
        json.dump(L, f, indent=1)
    os.replace(LEDGER + ".tmp", LEDGER)


def cost_of(usage, sec):
    by_min = PER_MIN[MODEL] * sec / 60
    by_tok = 0.0
    if (usage or {}).get("type") == "tokens" and MODEL in PER_TOK:
        a, b = PER_TOK[MODEL]
        by_tok = (usage.get("input_tokens", 0) * a + usage.get("output_tokens", 0) * b) / 1e6
    return max(by_min, by_tok), by_min, by_tok


def h1_words(m, ch, s, e):
    h = J(f"{CORP}/{m}/h1.json")["channels"][ch]
    return sum(len((x["text"] or "").split()) for x in h if s * 1000 <= (x["startMs"] + x["endMs"]) / 2 < e * 1000)


def post(mp3, data):
    err = ""
    for a in range(4):
        try:
            with open(mp3, "rb") as fh:
                r = requests.post(f"{BASE}/audio/transcriptions", headers=HDR, timeout=900,
                                  files={"file": (os.path.basename(mp3), fh, "audio/mpeg")}, data=data)
        except requests.RequestException as e:
            err = type(e).__name__
        else:
            if r.status_code < 400:
                return r
            # A 401 body names a masked key: do not print it.
            err = f"HTTP {r.status_code}: " + ("unauthorized (check OPENAI_API_KEY)" if r.status_code == 401 else r.text[:300])
            if r.status_code not in (408, 429, 500, 502, 503, 504) or "insufficient_quota" in r.text:
                raise RuntimeError(err)
        time.sleep(min(60, 5 * 2 ** a))
    raise RuntimeError("retries exhausted: " + err)


def one_chunk(m, ch, wav, k, s, e):
    rp = f"{RAW}/{m}_{ch}_{k}.json"
    if os.path.exists(rp):
        return J(rp), False
    sec = e - s
    with LOCK:
        L = ledger()
        est = cost_of(None, sec)[0]
        if STOPPED.is_set() or L["usd"] + est > STOP_USD:
            STOPPED.set()
            raise RuntimeError(f"budget stop: spent {L['usd']:.4f} + est {est:.4f} > stop {STOP_USD:.4f} USD")
    mp3 = f"{TMP}/oai_{m}_{ch}_{k}.mp3"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{s:.3f}", "-t", f"{sec:.3f}", "-i", wav,
                    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", mp3], check=True)
    nbytes = os.path.getsize(mp3)
    hw = h1_words(m, ch, s, e)
    data = {"model": MODEL, "response_format": FMT, "temperature": "0"}
    if FMT == "verbose_json":
        data["timestamp_granularities[]"] = "segment"
    with mlflow.start_span(name="openai.chunk", span_type="LLM") as sp:
        sp.set_attributes({"step": "openai.chunk", "model": MODEL, "meeting": m, "channel": ch, "chunk": k, "start_s": round(s, 3),
                           "duration_s": round(sec, 3), "bytes": nbytes, "format": "mp3 16k mono 48 kbps", "response_format": FMT})
        t0 = time.time()
        try:
            r = post(mp3, data)
        finally:
            os.remove(mp3)
        lat = time.time() - t0
        d = r.json()
        text = (d.get("text") or "").strip()
        segs = [{"startMs": int(round((s + x["start"]) * 1000)), "endMs": int(round((s + x["end"]) * 1000)), "text": (x.get("text") or "").strip()}
                for x in d.get("segments") or [] if (x.get("text") or "").strip()]
        u = d.get("usage") or {}
        usd, by_min, by_tok = cost_of(u, sec)
        ow = len(text.split())
        ratio = (ow / hw) if hw else None
        flag = (ratio is not None and not (0.6 <= ratio <= 1.6)) or (hw == 0 and ow > 20)
        with LOCK:
            L = ledger()
            L["usd"] += usd; L["chunks"] += 1; L["seconds"] += sec
            bm = L["by_model"].setdefault(MODEL, {"usd": 0.0, "chunks": 0, "seconds": 0.0})
            bm["usd"] += usd; bm["chunks"] += 1; bm["seconds"] += sec
            save_ledger(L)
            spent = L["usd"]
        res = {"meeting": m, "channel": ch, "chunk": k, "startS": s, "endS": e, "bytes": nbytes, "latency_s": round(lat, 2),
               "usage": u, "usd": round(usd, 6), "usd_by_min": round(by_min, 6), "usd_by_tok": round(by_tok, 6),
               "h1_words": hw, "words": ow, "ratio": None if ratio is None else round(ratio, 3), "flag": flag, "model": MODEL,
               "response_format": FMT, "status": "ok", "text": text, "segments": segs, "keys": sorted(d.keys())}
        sp.set_attributes({"latency_s": round(lat, 2), "usage_type": str(u.get("type")), "input_tokens": u.get("input_tokens", 0),
                           "output_tokens": u.get("output_tokens", 0), "usage_seconds": u.get("seconds", 0), "usd": round(usd, 6),
                           "usd_spent_total": round(spent, 6), "n_words": ow, "n_segments": len(segs), "h1_words": hw,
                           "ratio": -1 if ratio is None else round(ratio, 3), "flag": flag})
        sp.set_outputs({"n_words": ow, "n_segments": len(segs)})
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
    cl = [c for c in chunks_of(dur) if only_k is None or c[0] == only_k]
    out = []
    with mlflow.start_span(name="openai.channel", span_type="CHAIN") as p:
        p.set_attributes({"step": "openai.channel", "model": MODEL, "meeting": m, "channel": ch, "chunks": len(cl),
                          "duration_s": round(dur, 1), "chunk_s": CHUNK, "overlap_s": OVL})
        p.set_inputs({"meeting": m, "channel": ch, "chunks": len(cl)})
        for k, s, e in cl:
            res, new = one_chunk(m, ch, wav, k, s, e)
            out.append(res)
            print(f"{m} {ch} k={k} new={new} words={res['words']}/{res['h1_words']} ratio={res['ratio']} flag={res['flag']} "
                  f"segs={len(res['segments'])} usd={res['usd']:.4f} lat={res['latency_s']}", flush=True)
        p.set_outputs({"chunks_done": len(out), "words": sum(r["words"] for r in out), "flagged": sum(r["flag"] for r in out)})
    return out


if __name__ == "__main__":
    mlflow.set_tracking_uri(P.MLFLOW_URI)
    exp = mlflow.set_experiment(P.MLFLOW_EXPERIMENT)
    print("experiment", exp.experiment_id, "model", MODEL, "format", FMT, f"cap {CAP_USD:.3f} stop {STOP_USD:.3f} USD", flush=True)
    jobs = [(m, ch, None) for m in IDS for ch in ("mic", "system")]
    if "--only" in sys.argv:
        jobs = [(a, b, int(c)) for a, b, c in (it.split(":") for it in sys.argv[sys.argv.index("--only") + 1].split(","))]
    nw = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 4
    fails = []
    with cf.ThreadPoolExecutor(nw) as ex:
        futs = {ex.submit(run_channel, *j): j for j in jobs}
        for f in cf.as_completed(futs):
            try:
                f.result()
            except Exception as e:
                fails.append((futs[f], str(e)[:300]))
                print("FAIL", futs[f], str(e)[:300], flush=True)
    L = ledger()
    print(f"ledger: spent {L['usd']:.4f} USD over {L['chunks']} chunks ({L['seconds']/60:.1f} min); stop {STOP_USD:.3f}; by model "
          + json.dumps({k: {"usd": round(v['usd'], 4), "chunks": v['chunks']} for k, v in L['by_model'].items()}), flush=True)
    print("failed jobs:", fails, flush=True)
