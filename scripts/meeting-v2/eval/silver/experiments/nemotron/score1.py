"""Score one meeting: span accuracy (H+M, person, in_vocab) and WER, counts only.
Same span logic as goldsilver/score_silver.py (window +-3 s, wer.mts normal form).
Run: python3 -I score1.py <id8> NAME=path/to/h1-format.json ...   (APP_RAW and H2 are added from the corpus)
"""
import json, os, subprocess, sys, collections
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import silver_paths as P  # noqa: E402

m = sys.argv[1]
KEYS = P.KEYS
CORP = P.CORPUS
TOL = 3000
LGROUP = {"term": "term", "product": "term", "person": "person"}
J = lambda p: json.load(open(p, encoding="utf-8"))
g = J(f"{KEYS}/{m}.json")
assert g["goldVersion"] == 3 and g["goldKind"].startswith("silver-3"), g["goldKind"]
app = J(f"{CORP}/{m}/app.json")
sy = {"APP_RAW": [(c, s["startMs"], s["endMs"], s["text"] or "") for c in ("mic", "system") for s in app["channels"][c]]}
h2 = J(f"{CORP}/{m}/h2.json")
sy["H2"] = [(c, s["startMs"], s["endMs"], s["text"] or "") for c in ("mic", "system") for s in h2["channels"][c]]
for a in sys.argv[2:]:
    n, p = a.split("=", 1)
    h = J(p)
    sy[n] = [(c, s["startMs"], s["endMs"], s["text"] or "") for c in ("mic", "system") for s in h["channels"].get(c, [])]

jobs, norm = [], {}
tr = {c: [dict(t, verified=bool(t.get("wer_eligible"))) for t in g["transcript"][c]] for c in ("mic", "system")}
for n, segs in sy.items():
    jobs.append(dict(key=n, transcript=tr, rows=[dict(id=str(i), source=c, idx=i, start_ms=s, text=t, enhanced_text=None) for i, (c, s, e, t) in enumerate(segs)]))
    for i, (c, s, e, t) in enumerate(segs):
        norm[f"s|{n}|{i}"] = t
for i, sp in enumerate(g["spans"]):
    norm[f"k|{i}"] = sp["text"]
r = subprocess.run(P.node_ts(P.WER_MTS), input=json.dumps(dict(jobs=jobs, spans=norm)), capture_output=True, text=True)
if r.returncode:
    sys.exit("node failed: " + r.stderr[-2000:])
res = json.loads(r.stdout)
N, W = res["norm"], res["wer"]

acc = collections.defaultdict(lambda: [0, 0])
for i, sp in enumerate(g["spans"]):
    if sp["confidence"] not in ("high", "medium"):
        continue
    st = N[f"k|{i}"]
    if not st:
        continue
    for n, segs in sy.items():
        win = " ".join(N[f"s|{n}|{j}"] for j, (c, s, e, t) in enumerate(segs) if c == sp["channel"] and e >= sp["startMs"] - TOL and s <= sp["endMs"] + TOL)
        h = int(f" {st} " in f" {win} ")
        for k in ("all", "lab:" + LGROUP.get(sp["label"], "other"), f"voc:{sp['in_vocab']}", "ch:" + sp["channel"]):
            acc[(n, k)][0] += h
            acc[(n, k)][1] += 1
f = lambda n, k: "-" if not acc[(n, k)][1] else f"{100*acc[(n,k)][0]/acc[(n,k)][1]:.1f} ({acc[(n,k)][0]}/{acc[(n,k)][1]})"
print("| system | H+M all | mic | system | term+product | person | other | in_vocab | not in_vocab | WER mic | WER sys | WER both (all turns) | sub/del/ins |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for n in sy:
    w = W[n]
    pw = lambda x: "-" if not x or not x["wr"] else f"{100*x['w']/x['wr']:.1f}"
    tw = sum(x["w"] for x in w.values() if x); trf = sum(x["wr"] for x in w.values() if x)
    print(f"| {n} | {f(n,'all')} | {f(n,'ch:mic')} | {f(n,'ch:system')} | {f(n,'lab:term')} | {f(n,'lab:person')} | {f(n,'lab:other')} | {f(n,'voc:True')} | {f(n,'voc:False')} | {pw(w['mic'])} | {pw(w['system'])} | {100*tw/max(1,trf):.1f} | {'/'.join(str(sum(x[k] for x in w.values() if x)) for k in ('sub','del','ins'))} |")
