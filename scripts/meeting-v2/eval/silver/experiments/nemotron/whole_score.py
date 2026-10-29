"""Score whole-channel transcripts on the span gold by presence in the channel text (no timestamps).
Rule: a span (confidence high or medium) is a hit when its normal form (wer.mts normal form) is in the normal
form of the whole channel text. The same rule is applied to the app lab DB of a cell (all segments of the channel
joined), so two systems compare on one basis. Numbers only.
Run: python3 -I whole_score.py <gold_dir> <meetings: id8,...> whole=<out_dir>:<mode> cell=<keysfile>
"""
import collections, glob, json, os, re, sqlite3, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WERMTS = os.path.join(os.path.dirname(os.path.dirname(HERE)), "wer.mts")
REPO = os.path.abspath(os.path.join(HERE, "../../../../../.."))
GOLD, MEET = sys.argv[1], sys.argv[2].split(",")
SYS = sys.argv[3:]
CACHE = os.path.expanduser("~/.openstyle-eval/lab/asr/cache")


def texts(spec, i8):
    kind, arg = spec.split("=", 1)
    if kind == "whole":
        d, mode = arg.split(":")
        tag = re.compile(r"<(?:spk:\d+|/?ev:[^>]*|/?sty:[^>]*)>")
        return {ch: tag.sub(" ", open(f"{d}/{i8}.{mode}.{ch}.txt", encoding="utf-8").read()) for ch in ("mic", "system")}
    key = dict(l.split() for l in open(arg))[i8]
    db = sqlite3.connect(f"file:{glob.glob(f'{CACHE}/{i8}*.{key}.db')[0]}?immutable=1", uri=True)
    out = {"mic": [], "system": []}
    for s, t in db.execute("select source,text from meeting_segments where meeting_id like ? order by start_ms", (i8 + "%",)):
        out[s].append(t or "")
    return {c: " ".join(v) for c, v in out.items()}


acc = collections.defaultdict(lambda: [0, 0])
for i8 in MEET:
    g = json.load(open(f"{GOLD}/{i8}.json", encoding="utf-8"))
    jobs = {}
    for spec in SYS:
        for ch, t in texts(spec, i8).items():
            jobs[f"c|{spec}|{ch}"] = t
    spans = {f"k|{i}": (sp.get("verified_text") or sp["text"]) for i, sp in enumerate(g["spans"])}
    r = subprocess.run(["node", "--import", os.path.join(REPO, "scripts/meeting-v2/ts-register.mjs"), WERMTS],
                       input=json.dumps(dict(jobs=[], spans={**jobs, **spans})), capture_output=True, text=True, cwd=REPO)
    if r.returncode:
        sys.exit("node failed: " + r.stderr[-1500:])
    N = json.loads(r.stdout)["norm"]
    for i, sp in enumerate(g["spans"]):
        if sp["confidence"] not in ("high", "medium") and not sp.get("verified"):
            continue
        st = N[f"k|{i}"]
        if not st:
            continue
        for spec in SYS:
            h = int(f" {st} " in f" {N[f'c|{spec}|{sp['channel']}']} ")
            grp = {"term": "term", "product": "term", "person": "person"}.get(sp["label"], "other")
            for k in ("all", grp, "verified" if sp.get("verified") else "-"):
                acc[(spec, k)][0] += h; acc[(spec, k)][1] += 1
for spec in SYS:
    print(spec, {k: f"{a[(spec,k)][0]}/{a[(spec,k)][1]}" for k in ("all", "person", "term", "other", "verified") for a in [acc] if a[(spec, k)][1]})
