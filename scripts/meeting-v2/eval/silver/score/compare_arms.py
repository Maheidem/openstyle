# Compare arm results.json files of score_arms.mts (numbers only).
# usage: python3 -I compare_arms.py BASE ARM1 ARM2 ...   (pnpm meeting:silver:compare-arms BASE ARM1 ...)
# Reads $SILVER_EVAL_HOME/out/<arm>/results.json (default /tmp/meeting-eval).
import json, os, sys
D = os.path.join(os.environ.get("SILVER_EVAL_HOME") or "/tmp/meeting-eval", "out") + "/"
arms = sys.argv[1:]
J = {a: json.load(open(D + a + "/results.json")) for a in arms}
def p(c): return "-" if c["rate"] is None else f"{c['rate']*100:.1f} ({c['hits']}/{c['n']})"
cols = [("All", lambda s: s["all"]), ("High", lambda s: s["high"]), ("Term+product", lambda s: s["byLabel"]["term"]),
        ("Person", lambda s: s["byLabel"]["person"]), ("Person excl. owner", lambda s: s["personNoOwner"]), ("Other", lambda s: s["byLabel"]["other"]),
        ("In vocab", lambda s: s["byVocab"]["inVocab"]), ("Not in vocab", lambda s: s["byVocab"]["notInVocab"])]
print("| Arm | " + " | ".join(c for c, _ in cols) + " |")
for a in arms: print(f"| {a} | " + " | ".join(p(f({**J[a]["pooled"], "personNoOwner": J[a].get("personNoOwner")})) for _, f in cols) + " |")
print("\n| Arm | Vocab occ | Vocab unsup | Name occ | Name unsup | Owner unsup | Non-owner name unsup | Owner occ | Owner supported |")
for a in arms:
    x = J[a]["precision"]
    print(f"| {a} | {x['vocabOcc']} | {x['vocabUnsup']} | {x['nameOcc']} | {x['nameUnsup']} | {x['ownerUnsup']} | {x['nameUnsup']-x['ownerUnsup']} | {x['ownerOcc']} | {x['ownerOcc']-x['ownerUnsup']} |")
base = arms[0]
for a in arms[1:]:
    bm = {m["meeting"]: m for m in J[base]["meetings"]}
    for key, f in [("all", lambda m: m["spans"]["all"]["hits"]), ("person", lambda m: m["spans"]["byLabel"]["person"]["hits"]),
                   ("term", lambda m: m["spans"]["byLabel"]["term"]["hits"]),
                   ("ownerSupported", lambda m: m["precision"]["ownerOcc"] - m["precision"]["ownerUnsup"]),
                   ("nameUnsup(lower=better)", lambda m: -m["precision"]["nameUnsup"])]:
        b = w = s = 0
        for m in J[a]["meetings"]:
            d = f(m) - f(bm[m["meeting"]])
            b += d > 0; w += d < 0; s += d == 0
        print(f"{a} vs {base} {key}: better={b} worse={w} same={s}")
