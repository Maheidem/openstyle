"""Parakeet witness on the H1 chunk list (no context). Counts only on stdout.

Run: python3 -I parakeet.py   (pnpm meeting:silver:parakeet; takes the GPU lock with the runtime.mts queue convention)
Writes $SILVER_CORPUS/<id8>/parakeet.json (mode 600) for SILVER_MEETINGS (default: all corpus meetings).
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import witness as W  # lock, worker, wav helpers (same convention as the H1/H3 run)

MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
IDS = W.P.meeting_ids()


def main():
    os.makedirs(W.TMP, mode=0o700, exist_ok=True)
    t_all = time.time()
    rep = {"lockWaitSec": 0, "meetings": []}
    wk = None
    try:
        rep["lockWaitSec"] = W.take_lock()
        wk = W.Worker(MODEL)
        for m in IDS:
            t0 = time.time()
            out = f"{W.CORPUS}/{m}/parakeet.json"
            if os.path.exists(out):
                W.log(f"{m} exists, skip"); continue
            h1 = json.load(open(f"{W.CORPUS}/{m}/h1.json"))
            mid = json.load(open(f"{W.CORPUS}/{m}/app.json"))["meetingId"]
            lang = json.load(open(f"{W.CORPUS}/{m}/context.json"))["language"] or "en"
            chans, fails, asr = {}, 0, 0.0
            for ch in ("mic", "system"):
                pcm = W.read_wav(os.path.join(W.PROFILE, "meetings", mid, f"{ch}.wav"))
                lst = []
                for i, c in enumerate(h1["channels"][ch]):
                    p = os.path.join(W.TMP, f"pk-{m}-{ch}-{i}.wav")
                    W.write_slice(pcm, c["startMs"], c["endMs"], p)
                    t1 = time.time()
                    try:
                        txt, err = wk.transcribe(p, lang), None
                    except Exception as e:
                        txt, err = "", str(e)[:120]; fails += 1
                    asr += time.time() - t1
                    os.remove(p)
                    seg = {"startMs": c["startMs"], "endMs": c["endMs"], "text": txt, "kind": c["kind"], "appIdx": c["appIdx"]}
                    if err:
                        seg["error"] = err
                    lst.append(seg)
                chans[ch] = lst
                del pcm
            W.write_private(out, {"engine": f"{MODEL} (no context)", "model": MODEL, "language": lang, "meeting": m, "channels": chans})
            r = {"id8": m, "chunks": sum(len(v) for v in chans.values()), "failed": fails, "asrSec": round(asr, 1), "wallSec": round(time.time() - t0, 1)}
            rep["meetings"].append(r)
            W.log("done " + json.dumps(r))
    finally:
        if wk:
            wk.close()
        W.release_lock()
    rep["totalSec"] = round(time.time() - t_all, 1)
    print("REPORT " + json.dumps(rep), flush=True)


if __name__ == "__main__":
    main()
