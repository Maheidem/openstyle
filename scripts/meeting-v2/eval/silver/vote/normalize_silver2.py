"""Normalize the 14 silver keys to the silver-2 schema. Prints counts only.

Run: python3 -I normalize_silver2.py [--write]   (history: silver-1 -> silver-2; without --write a dry run)
Input is always <id8>.silver-1.json (made from <id8>.json on the first run),
so a rerun gives the same output. Needs the aligned meet.json / krisp.json
(align_ext.py --write).

Rules (mechanical):
- independent witnesses: h1, h3, meet, krisp. h2 and app are support only.
- a witness "contains" a span: same channel, a segment overlaps
  [start - tol, end + tol] (tol 3 s for h1/h2/h3/app; for meet/krisp the
  line's segment is the local chunk run that EG2 method A aligned it to
  (alignedMs), tol 0, so support comes from the line pairs, not a time window),
  and the span's normal words (scoreWords + normalizeWords of score.mts) are
  a contiguous run of the window's normal words, or their concatenation
  without spaces equals the concatenation of a contiguous run of window
  words (token boundaries kept). meet/krisp count only when time_quality is good.
- high: >= 2 independent, or 1 independent + exact match (case-insensitive
  normal words) to an attendee name, an attendee name part, or a vocabulary term.
- medium: 1 independent + plausible context: h2 or app contains the span, or
  a normal word of the span is a normal word of an attendee name, a
  vocabulary term or a context term.
- unsure: otherwise; and always when verifier_conflict is true.
- turn basis: an independent witness whose same-channel window text
  (tol as above; meet/krisp lines by their aligned chunk run) matches the turn with normalized WER <= 0.15, where WER =
  min edit distance of the turn words to any contiguous run of window words
  / turn words. wer_eligible: >= 2 in basis and one of them is not h1.
"""
import json, os, re, sys, shutil, subprocess, collections, datetime
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

IDS = P.meeting_ids()
KEYS = P.KEYS
CORP = P.CORPUS
WRITE = "--write" in sys.argv
INDEP = ("h1", "h3", "meet", "krisp")
ORDER = ("h1", "h2", "h3", "app", "meet", "krisp")
TOL = {"h1": 3000, "h2": 3000, "h3": 3000, "app": 3000, "meet": 0, "krisp": 0}  # meet/krisp: aligned chunk run, no window
LABELS = {"term", "product", "person", "org", "place", "other"}
MAXWER = 0.15


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


ext_all = [J(f"{CORP}/{m}/{n}.json") for m in IDS for n in ("meet", "krisp") if os.path.exists(f"{CORP}/{m}/{n}.json")]
common = set.intersection(*[set(t["speaker"] for t in d["turns"]) for d in ext_all])
assert len(common) == 1, "owner detection failed"
OWNER = next(iter(common))

# ---- load inputs -----------------------------------------------------------------
M = {}
norm_in = {}
for m in IDS:
    cur, bak = f"{KEYS}/{m}.json", f"{KEYS}/{m}.silver-1.json"
    g = J(bak if os.path.exists(bak) else cur)
    assert g.get("goldVersion") == "silver-1", f"{m}: input is not silver-1"
    app = J(f"{CORP}/{m}/app.json")
    ctx = J(f"{CORP}/{m}/context.json")
    W, segs, ext = {}, {}, {}
    for n in ("h1", "h2", "h3"):
        h = J(f"{CORP}/{m}/{n}.json")
        W[n] = {"engine": h["engine"]}
        segs[n] = [(ch, s["startMs"], s["endMs"], s["text"] or "") for ch in ("mic", "system") for s in h["channels"][ch]]
    segs["app"] = [(ch, s["startMs"], s["endMs"], s["text"] or "") for ch in ("mic", "system") for s in app["channels"][ch]]
    for n in ("meet", "krisp"):
        p = f"{CORP}/{m}/{n}.json"
        if not os.path.exists(p):
            continue
        d = J(p)
        assert "time_quality" in d, f"{m}/{n} is not aligned"
        W[n] = {"source": d["source"], "time_basis": d["time_basis"], "time_quality": d["time_quality"]}
        # Support comes from the method-A line pairs: a line covers the local
        # chunk run it was aligned to (alignedMs). Unmatched lines give no support.
        segs[n] = [("mic" if t["speaker"] == OWNER else "system", t["alignedMs"][0], t["alignedMs"][1], t["text"] or "")
                   for t in d["turns"] if t.get("alignedMs")]
        ext[n] = d["time_quality"]
    M[m] = dict(g=g, app=app, ctx=ctx, W=W, segs=segs, ext=ext)
    for n, L in segs.items():
        for i, (_, _, _, t) in enumerate(L):
            norm_in[f"s|{m}|{n}|{i}"] = t
    for i, sp in enumerate(g["spans"]):
        norm_in[f"k|{m}|{i}"] = sp["text"]
    for ch in ("mic", "system"):
        for i, t in enumerate(g["transcript"][ch]):
            norm_in[f"t|{m}|{ch}|{i}"] = t["text"]
    names = [a["name"] for a in ctx.get("attendees") or [] if a.get("name")]
    for i, a in enumerate(names):
        norm_in[f"a|{m}|{i}"] = a
    for i, v in enumerate(ctx.get("vocabulary") or []):
        norm_in[f"v|{m}|{i}"] = v["term"]
    for i, v in enumerate(ctx.get("contextTerms") or []):
        norm_in[f"c|{m}|{i}"] = v
    M[m]["n_att"], M[m]["n_voc"], M[m]["n_ctx"] = len(names), len(ctx.get("vocabulary") or []), len(ctx.get("contextTerms") or [])

r = subprocess.run(P.node_ts(P.WER_MTS), input=json.dumps(dict(jobs=[], spans=norm_in)), capture_output=True, text=True)
if r.returncode:
    sys.exit("node failed: " + r.stderr[-2000:])
NORM = {k: v.split() for k, v in json.loads(r.stdout)["norm"].items()}


def contains(st, win):
    if not st or not win:
        return False
    n = len(st)
    for i in range(len(win) - n + 1):
        if win[i:i + n] == st:
            return True
    target = "".join(st)
    for i in range(len(win)):
        acc = ""
        for j in range(i, len(win)):
            acc += win[j]
            if len(acc) >= len(target):
                break
        if acc == target:
            return True
    return False


def semi_wer(ref, hyp):
    """Min edit distance of ref to any contiguous run of hyp, over len(ref)."""
    if not ref:
        return None
    prev = [0] * (len(hyp) + 1)  # free start in hyp
    for i in range(1, len(ref) + 1):
        cur = [i] + [0] * len(hyp)
        ri = ref[i - 1]
        for j in range(1, len(hyp) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ri != hyp[j - 1]))
        prev = cur
    return min(prev) / len(ref)  # free end in hyp


def window(m, n, ch, s0, e0):
    tol = TOL[n]
    out = []
    for i, (c, s, e, _) in enumerate(M[m]["segs"][n]):
        if c == ch and e >= s0 - tol and s <= e0 + tol:
            out += NORM[f"s|{m}|{n}|{i}"]
    return out


def usable(m, n):
    if n not in M[m]["segs"]:
        return False
    return n not in ("meet", "krisp") or M[m]["ext"][n] == "good"


# ---- verification block (same logic as score_silver.py, on silver-1) ------------
key_norm = lambda t: "".join(ch for ch in t.lower() if ch.isalnum())
wnorm = lambda t: " " + " ".join(re.sub(r"[^\w]+", " ", t.lower()).split()) + " "


def verification(m, g):
    p = f"{CORP}/{m}/verify_blind.json"
    nconf = sum(1 for sp in g["spans"] if sp.get("verifier_conflict"))
    if not os.path.exists(p):
        return dict(sampled=0, agree_text=0, agree_conf=None, conflicts_marked_unsure=nconf, method="no blind verifier file")
    v = J(p)
    lst = next(v[k] for k in ("items", "spans", "answers", "samples") if k in v)
    chunks, refs = collections.defaultdict(list), collections.defaultdict(set)
    for it in lst:
        for i in (it.get("spanIndices") or [it[k] for k in ("spanIndex", "keyIndex", "idx") if k in it]):
            refs[(it["channel"], it["startMs"])].add(i)
        if "judged" in it:
            ents = [(e.get("text") or "", e.get("confidence")) for e in it["judged"] or []]
        elif "terms" in it:
            ents = list(it["terms"].items())
        else:
            ents = [(it.get("text") or "", it.get("confidence"))]
        chunks[(it["channel"], it["startMs"])].extend(ents)
    allt = [t for es in chunks.values() for t, _ in es]
    mode = "chunk" if sorted(len(t.split()) for t in allt)[len(allt) // 2] > 4 else "entity"
    c = collections.Counter()
    for (chn, stm), es in chunks.items():
        kd = {}
        for i in sorted(refs[(chn, stm)]):
            sp = g["spans"][i]
            kd.setdefault(key_norm(sp["text"]), (sp["text"], sp.get("confidence_before_verify", sp["confidence"])))
        c["key"] += len(kd)
        if mode == "entity":
            jd = {}
            for t, cf in es:
                if key_norm(t):
                    jd.setdefault(key_norm(t), cf)
            both = set(kd) & set(jd)
            c["agree"] += len(both)
            c["confagree"] += sum(1 for k in both if kd[k][1] == jd[k])
        else:
            txt_ = " ".join(wnorm(t) for t, _ in es)
            c["agree"] += sum(1 for k, (t, cf) in kd.items() if wnorm(t) in txt_ or key_norm(t) in txt_.replace(" ", ""))
    return dict(sampled=c["key"], agree_text=c["agree"], agree_conf=c["confagree"] if mode == "entity" else None,
                conflicts_marked_unsure=nconf,
                method=f"blind LLM verifier on sampled chunks ({mode} mode, {len(chunks)} chunks); agree_text = sampled key spans the verifier also gives; "
                       f"agree_conf = of those, same confidence ({'entity mode' if mode == 'entity' else 'n/a in chunk mode'}); "
                       "a verifier_conflict span stays unsure in silver-2")


# ---- build -----------------------------------------------------------------------
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
trans = collections.Counter()
per = {}
wit_changes = collections.Counter()
for m in IDS:
    d = M[m]; g = d["g"]
    att = [NORM[f"a|{m}|{i}"] for i in range(d["n_att"])]
    voc = [NORM[f"v|{m}|{i}"] for i in range(d["n_voc"])]
    cterms = [NORM[f"c|{m}|{i}"] for i in range(d["n_ctx"])]
    exact = {tuple(a) for a in att + voc if a} | {(w,) for a in att for w in a}
    ctxw = {w for a in att + voc + cterms for w in a}
    spans, cc = [], collections.Counter()
    for i, sp in enumerate(g["spans"]):
        st = NORM[f"k|{m}|{i}"]
        hit = [n for n in ORDER if usable(m, n) and contains(st, window(m, n, sp["channel"], sp["startMs"], sp["endMs"]))]
        ind = [n for n in hit if n in INDEP]
        if len(ind) >= 2 or (len(ind) == 1 and tuple(st) in exact):
            conf = "high"
        elif len(ind) == 1 and (("h2" in hit or "app" in hit) or any(w in ctxw for w in st)):
            conf = "medium"
        else:
            conf = "unsure"
        vc = bool(sp.get("verifier_conflict"))
        if vc:
            conf = "unsure"
        old = sp["confidence"]
        trans[(old, conf)] += 1; cc[(old, conf)] += 1
        oldw = set(sp["witnesses"]) & set(INDEP); neww = set(ind)
        wit_changes["krisp removed"] += "krisp" in oldw and "krisp" not in neww
        wit_changes["meet removed"] += "meet" in oldw and "meet" not in neww
        wit_changes["meet added"] += "meet" not in oldw and "meet" in neww
        wit_changes["krisp added"] += "krisp" not in oldw and "krisp" in neww
        assert sp["label"] in LABELS and sp["channel"] in ("mic", "system") and isinstance(sp["in_vocab"], bool)
        o = dict(channel=sp["channel"], startMs=int(sp["startMs"]), endMs=int(sp["endMs"]), text=sp["text"], label=sp["label"],
                 in_vocab=sp["in_vocab"], confidence=conf, witnesses=hit)
        if vc:
            o["verifier_conflict"] = True
        spans.append(o)
    tr, elig = {}, collections.Counter()
    for ch in ("mic", "system"):
        out = []
        for i, t in enumerate(g["transcript"][ch]):
            ref = NORM[f"t|{m}|{ch}|{i}"]
            basis = []
            for n in INDEP:
                if not usable(m, n):
                    continue
                w = semi_wer(ref, window(m, n, ch, t["startMs"], t["endMs"]))
                if w is not None and w <= MAXWER:
                    basis.append(n)
            ok = len(basis) >= 2 and any(b != "h1" for b in basis)
            elig["turns"] += 1; elig["eligible"] += ok
            elig["words"] += len(ref); elig["eligible_words"] += len(ref) * ok
            for b in basis:
                elig["basis:" + b] += 1
            out.append(dict(startMs=int(t["startMs"]), endMs=int(t["endMs"]), text=t["text"], verified=False, basis=basis, wer_eligible=ok))
        tr[ch] = out
    key = {
        "format": "openstyle-gold",
        "goldVersion": "silver-2",
        "meeting": m,
        "meetingId": d["app"]["meetingId"],
        "id8": m,
        "asrHash": g.get("asrHash"),
        "builtAt": now,
        "verifiedSpans": 0,
        "timeToleranceMs": int(g.get("timeToleranceMs") or 2000),
        "witnesses": d["W"],
        "transcript": tr,
        "spans": spans,
        "verification": verification(m, g),
        "fixes": g.get("fixes") or [],
        "mustNotChange": g.get("mustNotChange") or [],
        "summary": g.get("summary"),
        "tags": g.get("tags"),
        "speakers": g.get("speakers"),
    }
    per[m] = dict(cc=cc, elig=elig, wit_in=sorted(g["witnesses"]), wit_out=sorted(d["W"]), quality={n: d["ext"][n] for n in d["ext"]})
    if WRITE:
        cur, bak = f"{KEYS}/{m}.json", f"{KEYS}/{m}.silver-1.json"
        if not os.path.exists(bak):
            shutil.copy2(cur, bak); os.chmod(bak, 0o600)
        tmp = cur + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(key, fh, ensure_ascii=False, indent=1)
        os.chmod(tmp, 0o600); os.replace(tmp, cur)

# ---- report (counts only) -----------------------------------------------------------
LV = {"high": 2, "medium": 1, "unsure": 0}
print("| meeting | key witness block before -> after | spans | up | down | same | eligible turns | eligible share (turns) | eligible share (words) | basis h1/h3/meet/krisp |")
print("|---|---|---|---|---|---|---|---|---|---|")
for m in IDS:
    p = per[m]; cc = p["cc"]; e = p["elig"]
    up = sum(v for (a, b), v in cc.items() if LV[b] > LV[a]); dn = sum(v for (a, b), v in cc.items() if LV[b] < LV[a])
    same = sum(v for (a, b), v in cc.items() if a == b)
    print(f"| {m} | {','.join(p['wit_in'])} -> {','.join(p['wit_out'])} | {sum(cc.values())} | {up} | {dn} | {same} | {e['eligible']}/{e['turns']} | "
          f"{100*e['eligible']/max(1,e['turns']):.1f}% | {100*e['eligible_words']/max(1,e['words']):.1f}% | "
          f"{e['basis:h1']}/{e['basis:h3']}/{e['basis:meet']}/{e['basis:krisp']} |")
print("\nconfidence transitions (silver-1 -> silver-2):", {f"{a}->{b}": v for (a, b), v in sorted(trans.items())})
tot = collections.Counter()
for (a, b), v in trans.items():
    tot[b] += v
print("silver-2 confidence totals:", dict(tot))
print("independent witness changes on spans:", dict(wit_changes))
E = collections.Counter()
for p in per.values():
    E.update(p["elig"])
print(f"eligible turns pooled: {E['eligible']}/{E['turns']} ({100*E['eligible']/E['turns']:.1f}%), words {100*E['eligible_words']/E['words']:.1f}%")
