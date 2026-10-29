"""Feasibility run of Nemotron 3.5 Transcribe (nativ-community MLX 4-bit, mlx-audio).
Prints counts and timings only. Transcripts go to out/ (not printed).
Run: venv/bin/python -I run_full.py <model_dir> <app.json> <context.json> <work_dir> <out_dir> <steps>
steps: comma list of slice,seg,full,saa
"""
import json, os, re, sys, threading, time, collections
import numpy as np, psutil, mlx.core as mx
from mlx_audio.stt import load
from mlx_audio.stt.utils import load_audio

MD, APP, CTX, WD, OD, STEPS = sys.argv[1:7]
STEPS = STEPS.split(",")
CAP = os.environ.get("TOKCAP") == "1"
SUF = "_cap" if CAP else ""
proc = psutil.Process()
peak = {"rss": 0}
stop = False


def poll():
    while not stop:
        peak["rss"] = max(peak["rss"], proc.memory_info().rss)
        time.sleep(0.2)


threading.Thread(target=poll, daemon=True).start()
GB = lambda b: round(b / 2**30, 2)
log = lambda *a: print(*a, flush=True)

PLAIN = "Transcribe with punctuation and capitalization."
c = json.load(open(CTX))
terms = [c["owner_name"]] + [a["name"] for a in c["attendees"] if a.get("name")] + [v["term"] for v in c["vocabulary"]]
seen, T = set(), []
for t in terms:
    if t and t.lower() not in seen:
        seen.add(t.lower()); T.append(t)
CONTEXT = f"{PLAIN} Context terms: {', '.join(T)}."
log(f"context terms: {len(T)}, prompt chars {len(CONTEXT)}")

t0 = time.perf_counter()
model = load(MD, strict=True)
mx.eval(model.parameters())
log(f"LOAD s={time.perf_counter()-t0:.1f} rss_peak_GB={GB(peak['rss'])} mlx_active_GB={GB(mx.get_active_memory())} mlx_peak_GB={GB(mx.get_peak_memory())}")


def loopiness(text):
    w = text.split()
    if len(w) < 8:
        return dict(words=len(w), uniq4=1.0, maxrep=0)
    g = [" ".join(w[i:i + 4]) for i in range(len(w) - 3)]
    return dict(words=len(w), uniq4=round(len(set(g)) / len(g), 3), maxrep=collections.Counter(g).most_common(1)[0][1])


def run(audio, prompt=None, task="asr", max_tokens=1024):
    mx.reset_peak_memory()
    t = time.perf_counter()
    r = model.generate(audio, prompt=prompt, task=task, max_tokens=max_tokens)
    return r, time.perf_counter() - t


audio = {ch: load_audio(f"{WD}/{ch}.wav", sr=16000) for ch in ("mic", "system")}
SR = 16000

if "slice" in STEPS:
    for ch in ("mic", "system"):
        a = load_audio(f"{WD}/{ch}_s2.wav", sr=SR)
        dur = a.shape[0] / SR
        for name, p in (("plain", PLAIN), ("ctx", CONTEXT)):
            r, el = run(a, prompt=p, max_tokens=2048)
            open(f"{OD}/slice_{ch}_{name}.txt", "w").write(r.text)
            log(f"SLICE {ch} {name} dur={dur:.0f}s time={el:.1f}s RTF={el/dur:.3f} prompt_tok={r.prompt_tokens} gen_tok={r.generation_tokens} {loopiness(r.text)} mlx_peak_GB={GB(mx.get_peak_memory())} rss_peak_GB={GB(peak['rss'])}")

if "seg" in STEPS:
    app = json.load(open(APP))
    for name, p in (("plain", PLAIN), ("ctx", CONTEXT)):
        out = {"engine": f"nemotron-3.5-transcribe nativ 4bit ({name})", "model": MD, "language": "English", "meeting": app["meeting"], "channels": {}}
        tt = td = 0.0; gen = 0; empty = 0
        for ch in ("mic", "system"):
            segs = []
            for s in app["channels"][ch]:
                a = audio[ch][int(s["startMs"] * SR / 1000):int(s["endMs"] * SR / 1000)]
                r, el = run(a, prompt=p, max_tokens=min(512, int((s["endMs"] - s["startMs"]) / 1000 * 4) + 24) if CAP else 512)
                tt += el; td += (s["endMs"] - s["startMs"]) / 1000; gen += r.generation_tokens
                empty += not r.text.strip()
                segs.append(dict(startMs=s["startMs"], endMs=s["endMs"], kind="app", appIdx=s["idx"], text=r.text))
            out["channels"][ch] = segs
        json.dump(out, open(f"{OD}/seg_{name}{SUF}.json", "w"), ensure_ascii=False)
        log(f"SEG{SUF} {name} segs={sum(len(v) for v in out['channels'].values())} speech_s={td:.0f} time_s={tt:.1f} RTF={tt/td:.3f} gen_tok={gen} empty={empty} rss_peak_GB={GB(peak['rss'])}")

if "full" in STEPS:
    for ch in ("mic", "system"):
        a = audio[ch]
        dur = a.shape[0] / SR
        r, el = run(a, prompt=PLAIN, max_tokens=8192)
        open(f"{OD}/full_{ch}_plain.txt", "w").write(r.text)
        log(f"FULL {ch} dur={dur:.0f}s time={el:.1f}s RTF={el/dur:.3f} prompt_tok={r.prompt_tokens} gen_tok={r.generation_tokens} {loopiness(r.text)} mlx_peak_GB={GB(mx.get_peak_memory())} rss_peak_GB={GB(peak['rss'])}")

if "saa" in STEPS:
    for ch in ("system", "mic"):
        a = load_audio(f"{WD}/{ch}_s2.wav", sr=SR)
        r, el = run(a, task="saa", max_tokens=2048)
        tags = re.findall(r"<spk:(\d+)>", r.text)
        open(f"{OD}/saa_{ch}.txt", "w").write(r.text)
        log(f"SAA {ch} time={el:.1f}s tags={len(tags)} distinct={sorted(set(tags))} segments={len(r.segments or [])} {loopiness(r.text)}")

stop = True
log(f"END rss_peak_GB={GB(peak['rss'])}")
