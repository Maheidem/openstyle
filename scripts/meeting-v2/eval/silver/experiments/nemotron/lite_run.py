"""Nemotron 3.5 Transcribe Lite (Core ML encoder + CTC head, no LLM, no diarizer) on mic and system.
Writes an h1-format JSON; segments come from the model's own word start times (split at gaps > 1 s or 20 s).
Run: venv/bin/python -I lite_run.py <lite_repo_dir> <work_dir> <out_json> <id8>
"""
import json, sys, time, resource
from pathlib import Path

REPO, WD, OUT, M = sys.argv[1:5]
sys.path.insert(0, str(Path(REPO) / "demo"))  # reviewed code: frontend.py + lite_meeting.py (NumPy + coremltools)
import numpy as np, soundfile as sf
from frontend import AsrEncoder, Frontend, mel, per_feature_norm
from lite_meeting import CtcHead

t = time.time()
fe, enc, head = Frontend(), AsrEncoder(), CtcHead()
enc.warmup(); head.warmup()
print(f"LITE load+warm s={time.time()-t:.1f}", flush=True)
res = {"engine": "nemotron-3.5-transcribe-lite coreml w48 (encoder+CTC, no LLM)", "model": "FluidInference/nemotron-3.5-transcribe-lite-coreml", "language": "English", "meeting": M, "channels": {}}
for ch in ("mic", "system"):
    a, sr = sf.read(f"{WD}/{ch}.wav", dtype="float32", always_2d=True)
    assert sr == 16000
    a = a.mean(1); dur = len(a) / sr
    t0 = time.time()
    m, valid = mel(a, fe)
    states = enc(per_feature_norm(m, valid), valid)
    words = head.words(head(states))
    el = time.time() - t0
    segs, cur = [], []
    for ts, w in words:
        if cur and (ts - cur[-1][0] > 1.0 or ts - cur[0][0] > 20.0):
            segs.append(cur); cur = []
        cur.append((ts, w))
    if cur:
        segs.append(cur)
    res["channels"][ch] = [dict(startMs=int(s[0][0] * 1000), endMs=int(s[-1][0] * 1000) + 500, kind="lite", appIdx=None, text=" ".join(w for _, w in s)) for s in segs]
    print(f"LITE {ch} dur={dur:.0f}s time={el:.2f}s RTF={el/dur:.4f} ({dur/el:.0f}x) words={len(words)} segs={len(segs)}", flush=True)
json.dump(res, open(OUT, "w"), ensure_ascii=False)
print(f"LITE maxrss_GB={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/2**30:.2f}", flush=True)
