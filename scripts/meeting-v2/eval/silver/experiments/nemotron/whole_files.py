"""Nemotron 3.5 Transcribe on WHOLE channel files (no app pipeline), several prompt modes.
Writes one private text file per meeting, channel and mode. Prints numbers only.
Run: venv/bin/python -I whole_files.py <model_dir> <keys_file> <entities.json> <out_dir> <modes> [id8,id8,...]
  keys_file: lines "<id8> <cache key>" (only the meeting ids are used)
  entities.json: from entities.mts: {id8: {meeting: [...], merged: [...]}}
  modes (comma list):
    plain   "Transcribe with punctuation and capitalization."   (model card)
    card_m  plain + " Context terms: <meeting terms>."            (model card format)
    off_m   report A.5 prefix "This audio may contain the following words or phrases (some may not be
            present in the clip): <meeting terms>." + report A.1 structured instruction
    off_mv  same, with the meeting terms merged with the global vocabulary (capped at 900 chars, like the app)
    off_mw  off_m with the written-form wording of report A.1 (SPGISpeech): "omit fillers and accidental
            repetitions; keep the remaining spoken wording unchanged"
    saa     task="saa" (speaker-attributed; <spk:N> tags)
Sources: Technical Report appendix A.1, A.5, A.7; HF model card. Pieces: a channel longer than 3300 s is cut into
55 min pieces (report 4.3: 55 min chunks); no overlap. Greedy decoding (temperature 0), max_tokens by length.
The GPU lock is taken per meeting (queue order of /tmp/openstyle-gpu.queue) and released between meetings.
"""
import glob
import json
import os
import sys
import time

import mlx.core as mx
import psutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
import silver_paths as P  # noqa: E402

MD, KEYS, ENT, OUT, MODES = sys.argv[1:6]
ONLY = sys.argv[6].split(",") if len(sys.argv) > 6 else None
MODES = MODES.split(",")
if P.inside_repo(OUT):
    raise SystemExit("out_dir points into the repo: the transcripts are private meeting text")
os.makedirs(OUT, mode=0o700, exist_ok=True)
AUDIO = os.path.expanduser("~/Library/Application Support/Openstyle-eval/audio")
PLAIN = "Transcribe with punctuation and capitalization."
A1 = (
    "Audio transcription. Language: as spoken. Wording: verbatim, including fillers and repetitions. "
    "Formatting: punctuation and capitalization. Output: transcript only."
)
SEG_S = 3300
ENTS = json.load(open(ENT))
proc = psutil.Process()


def cap(terms, n=900):
    out, used = [], 0
    for t in terms:
        if used + len(t) + 2 > n:
            break
        out.append(t)
        used += len(t) + 2
    return out


def build(mode, i8):
    e = ENTS[i8]
    if mode == "plain":
        return dict(prompt=PLAIN)
    if mode == "card_m":
        return dict(prompt=f"{PLAIN} Context terms: {', '.join(e['meeting'])}.")
    if mode in ("off_m", "off_mv", "off_mw"):
        terms = cap(e["merged"]) if mode == "off_mv" else e["meeting"]
        a1 = A1.replace("verbatim, including fillers and repetitions", "omit fillers and accidental repetitions; keep the remaining spoken wording unchanged") if mode == "off_mw" else A1
        return dict(
            prompt=(
                "This audio may contain the following words or phrases (some may not be present in the clip): "
                f"{', '.join(terms)}. {a1}"
            )
        )
    if mode == "saa":
        return dict(task="saa")
    raise SystemExit("unknown mode " + mode)


from mlx_audio.stt import load  # noqa: E402
from mlx_audio.stt.utils import load_audio  # noqa: E402

t = time.perf_counter()
model = load(MD, strict=True)
mx.eval(model.parameters())
print(f"LOAD s={time.perf_counter()-t:.1f} rss_gb={proc.memory_info().rss/2**30:.1f}", flush=True)
peak = 0
ids = [ln.split()[0] for ln in open(KEYS)]
for i8 in ids:
    if ONLY and i8 not in ONLY:
        continue
    todo = [m for m in MODES if not all(os.path.exists(f"{OUT}/{i8}.{m}.{c}.txt") for c in ("mic", "system"))]
    if not todo:
        continue
    print(f"{i8}: waiting for the GPU lock", flush=True)
    print("waited", P.take_lock("nemotron whole-files", 15), flush=True)
    try:
        mdir = glob.glob(f"{AUDIO}/{i8}*")[0]
        for ch in ("mic", "system"):
            a = load_audio(f"{mdir}/{ch}.wav", sr=16000)
            dur = a.shape[0] / 16000
            for mode in todo:
                kw = build(mode, i8)
                parts, gen_s, gen_tok, capped = [], 0.0, 0, 0
                for j in range(int(-(-dur // SEG_S))):
                    piece = a[int(j * SEG_S * 16000) : int(min(dur, (j + 1) * SEG_S) * 16000)]
                    mt = min(32768, int(piece.shape[0] / 16000 * 5) + 100)
                    mx.reset_peak_memory()
                    t0 = time.perf_counter()
                    r = model.generate(piece, max_tokens=mt, **kw)
                    gen_s += time.perf_counter() - t0
                    gen_tok += r.generation_tokens
                    capped += r.generation_tokens >= mt
                    parts.append(r.text)
                    peak = max(peak, mx.get_peak_memory())
                fd = os.open(f"{OUT}/{i8}.{mode}.{ch}.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                os.write(fd, "\n".join(parts).encode())
                os.close(fd)
                s = dict(i8=i8, ch=ch, mode=mode, audio_s=round(dur), gen_s=round(gen_s, 1), gen_tok=gen_tok, capped=capped)
                with open(f"{OUT}/stats.jsonl", "a") as f:
                    f.write(json.dumps(s) + "\n")
                print(
                    f"{i8} {ch} {mode} audio={dur:.0f}s time={gen_s:.1f}s RTF={gen_s/dur:.4f} tok={gen_tok} "
                    f"capped={capped} mlx_peak_gb={peak/2**30:.1f} rss_gb={proc.memory_info().rss/2**30:.1f}",
                    flush=True,
                )
    finally:
        P.release_lock()
        print(f"{i8}: released", flush=True)
print("DONE mlx_peak_gb", round(peak / 2**30, 1), flush=True)
