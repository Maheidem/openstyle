"""Pilot WER vs H1 on the pilot chunks. Counts only.

Run: python3 -I pilot_wer.py --pilot id8:ch:k[,id8:ch:k...]   (reads $SILVER_WORK/cloud/raw/*/; --pilot has no default)
Ref = H1 segments whose midpoint is in [lo, e) of the chunk; hyp = the model's chunk text.
lo = chunk start, except for timestamped outputs (Gemini) where lo = k*600 s and only items with
midpoint >= lo count (so the 5 s overlap is out on both sides). OpenAI text has no times: lo = chunk start.
Word normal form: scoreWords + normalizeWords (wer.mts). WER = word edit distance / ref words.
"""
import json, os, sys, glob, subprocess
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

CORP = P.CORPUS
RAW = os.path.join(P.WORK, "cloud", "raw")
if "--pilot" not in sys.argv:
    raise SystemExit("give --pilot id8:ch:k[,id8:ch:k...] (the pilot chunks)")
PILOT = [(m, ch, int(k)) for m, ch, k in (x.split(":") for x in sys.argv[sys.argv.index("--pilot") + 1].split(",") if x)]


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def ed(a, b):
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[-1]


texts, rows = {}, []
for m, ch, k in PILOT:
    s0, e0 = max(0, k * 600 - 5), (k + 1) * 600
    h1 = J(f"{CORP}/{m}/h1.json")["channels"][ch]
    for lo, tag in ((s0, "open"), (k * 600, "cut")):
        texts[f"ref|{m}|{ch}|{tag}"] = " ".join(x["text"] or "" for x in h1 if lo * 1000 <= (x["startMs"] + x["endMs"]) / 2 < e0 * 1000)
    g = J(f"{CORP}/{m}/gemini.json")
    texts[f"hyp|gemini-4-argon (stitched)|{m}|{ch}"] = " ".join(x["text"] for x in g["channels"][ch] if x.get("chunk") == k)
    rows.append((m, ch, "gemini-4-argon (stitched)", "cut"))
    for p in sorted(glob.glob(f"{RAW}/*/{m}_{ch}_{k}.json")):
        name = os.path.basename(os.path.dirname(p))
        d = J(p)
        if name.startswith("openai-"):
            texts[f"hyp|{name}|{m}|{ch}"] = d["text"]
            rows.append((m, ch, name, "open"))
        else:
            texts[f"hyp|{name}|{m}|{ch}"] = " ".join(x["text"] for x in d["segments"] if (x["startMs"] + x["endMs"]) / 2 >= k * 600000)
            rows.append((m, ch, name, "cut"))
r = subprocess.run(P.node_ts(P.WER_MTS), input=json.dumps(dict(jobs=[], spans=texts)), capture_output=True, text=True, check=True)
N = {k: v.split() for k, v in json.loads(r.stdout)["norm"].items()}
agg = {}
print("| model | meeting | channel | ref words | hyp words | WER vs H1 |")
print("|---|---|---|---|---|---|")
for m, ch, name, tag in rows:
    ref, hyp = N[f"ref|{m}|{ch}|{tag}"], N[f"hyp|{name}|{m}|{ch}"]
    e = ed(ref, hyp)
    a = agg.setdefault(name, [0, 0, 0])
    a[0] += e; a[1] += len(ref); a[2] += 1
    print(f"| {name} | {m} | {ch} | {len(ref)} | {len(hyp)} | {100 * e / max(1, len(ref)):.1f}% |")
print("\n| model | chunks | pooled WER vs H1 |")
print("|---|---|---|")
for name, (e, n, c) in sorted(agg.items(), key=lambda x: x[1][0] / max(1, x[1][1])):
    print(f"| {name} | {c} | {100 * e / max(1, n):.2f}% |")
