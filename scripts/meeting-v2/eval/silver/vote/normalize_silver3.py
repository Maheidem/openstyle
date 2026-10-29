"""Silver-3: re-vote the 14 silver-2 keys with the larger witness set. Prints counts only.

Run: python3 -I normalize_silver3.py [--v31 | --v32 | --v33] [--write]   (pnpm meeting:silver:vote --v33)
Without --write it only prints the counts (a dry run). Paths: silver_paths.py (SILVER_KEYS, SILVER_CORPUS, SILVER_MEETINGS).
Input is always <id8>.silver-2.json (made from <id8>.json on the first --write), so a rerun
gives the same output. --v31 writes goldKind silver-3.1 (the list-spelling exception below) and
first backs up the silver-3 key as <id8>.silver-3.json; its "before" is the silver-3 key. --v32 uses the silver-3.1 rule unchanged with the
openai witness (gpt-transcribe, EG2-aligned lines, voted as line pairs like meet/krisp) and the filled Gemini chunks; it writes
goldKind silver-3.2, first backs up the silver-3.1 key as <id8>.silver-3.1.json; its "before" is the silver-3.1 key. --v33 uses the
silver-3.2 rule and data, and adds the owner name (context.json owner_name) to the trusted list with the same rule as an attendee
name; it writes goldKind silver-3.3, first backs up the silver-3.2 key as <id8>.silver-3.2.json; its "before" is the silver-3.2 key. Spans, labels, texts and turn texts are not changed; only
confidence, witnesses, alt_text, basis and wer_eligible.
"""
import json, os, sys, shutil, subprocess, collections, datetime, difflib, unicodedata
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

IDS = P.meeting_ids()
KEYS = P.KEYS
CORP = P.CORPUS
WRITE = "--write" in sys.argv
V33 = "--v33" in sys.argv
V32 = "--v32" in sys.argv or V33  # silver-3.3 keeps the silver-3.2 rule and data
V31 = "--v31" in sys.argv or V32  # silver-3.2 keeps the silver-3.1 rule
KIND = "silver-3.3" if V33 else "silver-3.2" if V32 else "silver-3.1" if V31 else "silver-3"
PREV = "silver-3.2" if V33 else "silver-3.1" if V32 else "silver-3"  # the "before" key of a --v31/--v32 run
SOUND = 0.6
INDEP = ("h1", "h3", "parakeet", "openai", "gemini", "meet", "krisp")
ORDER = ("h1", "h2", "h3", "app", "parakeet", "openai", "gemini", "meet", "krisp")
LOCAL = ("h1", "h2", "h3", "app", "parakeet")
TOL = {n: 3000 for n in ORDER}
TOL.update(meet=0, krisp=0)
if V32:
    TOL["openai"] = 0  # line pairs (see --v32)  # line pairs: the local chunk run that EG2 method A aligned the line to
MAXWER = 0.15
ALT_SIM = 0.75

METHOD = (
    "silver-3 mechanical vote. Independent witnesses: h1 (Qwen3-ASR, no prompt), h3 (Whisper turbo), parakeet "
    "(parakeet-tdt-0.6b-v3), openai, gemini (gemini-4-argon), meet, krisp; h2 and app are not independent and do not vote. "
    "A witness contains a span when the span's normal words (scoreWords + normalizeWords, accents folded) are a contiguous run of the "
    "same-channel window words, or equal a run without spaces. Window: segments within +-3 s of the span for h1/h3/parakeet "
    "and for cloud witnesses whose own clock is good (gemini: anchor p80 <= 5 s; chunks with a word ratio vs h1 outside "
    "0.6-1.6 do not vote); for meet/krisp (time_quality good or coarse) the local chunk run that EG2 method A aligned the "
    "line to (line pairs), bad files do not vote. exact = the normal words equal an attendee name, an attendee name part or "
    "a vocabulary term. high: >= 3 agree, or 2 agree + exact. medium: 2 agree, or 1 + exact. unsure: otherwise; always when "
    "verifier_conflict; and when >= 2 independent witnesses agree on one different spelling at that place (best run of n-1..n+1 "
    "window words with character similarity >= 0.75 to the span, not equal to it and not a plural-only variant); then alt_text = that majority spelling "
    "(normal form). Turn basis: independent witnesses whose window text gives semi-WER <= 0.15; wer_eligible: >= 2 in basis "
    "and at least one is not h1.")


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


ext_all = [J(f"{CORP}/{m}/{n}.json") for m in IDS for n in ("meet", "krisp") if os.path.exists(f"{CORP}/{m}/{n}.json")]
OWNER = next(iter(set.intersection(*[set(t["speaker"] for t in d["turns"]) for d in ext_all])))

METHOD31 = (
    " silver-3.1 exception (replaces the forced unsure in one case): when the span's normal words equal a list entry (an attendee "
    "name, an attendee name part, the first.last local part of an attendee email as 'first last' or its parts, or a vocabulary term) "
    "and the majority alt_text is a sound-alike of it (normalized character edit ratio 1 - levenshtein/max length >= 0.6), the span "
    "is not forced to unsure: it is high when >= 2 independent witnesses contain the list spelling, else medium. alt_text is kept. "
    "verifier_conflict still forces unsure.")
METHOD32 = (
    " silver-3.2 witness data (the rule is the silver-3.1 rule): gemini adds 29 chunks by gemini-3.5-flash-lite (26 missing chunks "
    "and 3 of the 4 flagged chunk-0s re-run; see gemini.json chunks[].model). openai = gpt-transcribe (no own timestamps): its lines are "
    "aligned by EG2 method A (align_eg2) and vote as line pairs like meet/krisp (the local chunk run of the line, time_quality good or "
    "coarse; lines without a match and chunks with a word ratio vs h1 outside 0.6-1.6 do not vote).")
METHOD33 = (
    " silver-3.3 owner name: the owner name (context.json owner_name, the app setting owner_name) joins the list with the same rule "
    "as an attendee name (the full name and each part count as exact and as a list entry). Nothing else changes.")
if V31:
    METHOD = METHOD.replace("silver-3 mechanical vote", f"{KIND} mechanical vote") + METHOD31
if V32:
    METHOD = METHOD.replace("gemini (gemini-4-argon)", "gemini (gemini-4-argon, fill chunks gemini-3.5-flash-lite)") + METHOD32
if V33:
    METHOD += METHOD33


def lev_ratio(a, b):
    if not a and not b:
        return 1.0
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return 1 - prev[-1] / max(len(a), len(b))


M, norm_in = {}, {}
for m in IDS:
    cur, bak = f"{KEYS}/{m}.json", f"{KEYS}/{m}.silver-2.json"
    g = J(bak if os.path.exists(bak) else cur)
    assert g.get("goldKind") == "silver-2" and g.get("goldVersion") == 3, f"{m}: input is not silver-2"
    app = J(f"{CORP}/{m}/app.json"); ctx = J(f"{CORP}/{m}/context.json")
    W, segs, use = {}, {}, {}
    for n in ("h1", "h2", "h3", "parakeet"):
        p = f"{CORP}/{m}/{n}.json"
        if not os.path.exists(p):
            continue
        h = J(p)
        W[n] = {"engine": h["engine"]}
        segs[n] = [(ch, s["startMs"], s["endMs"], s["text"] or "") for ch in ("mic", "system") for s in h["channels"][ch]]
        use[n] = True
    segs["app"] = [(ch, s["startMs"], s["endMs"], s["text"] or "") for ch in ("mic", "system") for s in app["channels"][ch]]
    use["app"] = True
    for n in ("openai", "gemini"):
        p = f"{CORP}/{m}/{n}.json"
        if not os.path.exists(p):
            continue
        d = J(p)
        W[n] = {"engine": d["engine"], "time_basis": d["time_basis"], "time_quality": d["time_quality"]}
        bad = {(c["channel"], c["chunk"]) for c in d.get("chunks", []) if c.get("flag")}
        if V32 and n == "openai":  # EG2-aligned lines: line pairs (the matched local chunk run), like meet/krisp
            segs[n] = [(ch, s["alignedMs"][0], s["alignedMs"][1], s["text"] or "") for ch in ("mic", "system") for s in d["channels"][ch]
                       if (ch, s.get("chunk")) not in bad and s.get("alignedMs")]
            use[n] = d["time_quality"] in ("good", "coarse")
            continue
        segs[n] = [(ch, s["startMs"], s["endMs"], s["text"] or "") for ch in ("mic", "system") for s in d["channels"][ch]
                   if (ch, s.get("chunk")) not in bad]
        use[n] = d["time_quality"] == "good"
    for n in ("meet", "krisp"):
        p = f"{CORP}/{m}/{n}.json"
        if not os.path.exists(p):
            continue
        d = J(p)
        W[n] = {"source": d["source"], "time_basis": d["time_basis"], "time_quality": d["time_quality"]}
        segs[n] = [("mic" if t["speaker"] == OWNER else "system", t["alignedMs"][0], t["alignedMs"][1], t["text"] or "")
                   for t in d["turns"] if t.get("alignedMs")]
        use[n] = d["time_quality"] in ("good", "coarse")
    M[m] = dict(g=g, app=app, W=W, segs=segs, use=use)
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
    emails = [a.split("@")[0] for a in names if "@" in a]
    for i, a in enumerate(emails):
        norm_in[f"e|{m}|{i}"] = " ".join(x for x in a.replace("_", ".").replace("-", ".").split(".") if x)
    M[m]["n_em"] = len(emails)
    for i, v in enumerate(ctx.get("vocabulary") or []):
        norm_in[f"v|{m}|{i}"] = v["term"]
    M[m]["n_att"], M[m]["n_voc"] = len(names), len(ctx.get("vocabulary") or [])
    M[m]["owner"] = bool(V33 and ctx.get("owner_name"))
    if M[m]["owner"]:
        norm_in[f"o|{m}"] = ctx["owner_name"]
    if V31:
        M[m]["s3"] = J(f"{KEYS}/{m}.{PREV}.json" if os.path.exists(f"{KEYS}/{m}.{PREV}.json") else cur)
        assert M[m]["s3"]["goldKind"] == PREV, f"{m}: before key is not {PREV}"

r = subprocess.run(P.node_ts(P.WER_MTS), input=json.dumps(dict(jobs=[], spans=norm_in)), capture_output=True, text=True)
if r.returncode:
    sys.exit("node failed: " + r.stderr[-2000:])
fold = lambda t: "".join(c for c in unicodedata.normalize("NFKD", t) if not unicodedata.combining(c))
NORM = {k: fold(v).split() for k, v in json.loads(r.stdout)["norm"].items()}


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


def alt_at(st, win):
    """Best near-spelling of the span in the window: a run of n-1..n+1 words, char similarity >= ALT_SIM, not the span."""
    if not st or not win:
        return None
    tgt = " ".join(st)
    best, bs = None, ALT_SIM
    for L in range(max(1, len(st) - 1), len(st) + 2):
        for i in range(len(win) - L + 1):
            run = win[i:i + L]
            c = " ".join(run)
            if c == tgt or "".join(run) == "".join(st) or c == tgt + "s" or tgt == c + "s":
                continue  # same text, or a plural-only variant
            s = difflib.SequenceMatcher(None, tgt, c).ratio()
            if s > bs or (s == bs and best is not None and len(c) < len(best)):
                best, bs = c, s
    return best


def semi_wer(ref, hyp):
    if not ref:
        return None
    prev = [0] * (len(hyp) + 1)
    for i in range(1, len(ref) + 1):
        cur = [i] + [0] * len(hyp)
        ri = ref[i - 1]
        for j in range(1, len(hyp) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ri != hyp[j - 1]))
        prev = cur
    return min(prev) / len(ref)


def window(m, n, ch, s0, e0):
    tol = TOL[n]
    out = []
    for i, (c, s, e, _) in enumerate(M[m]["segs"][n]):
        if c == ch and e >= s0 - tol and s <= e0 + tol:
            out += NORM[f"s|{m}|{n}|{i}"]
    return out


usable = lambda m, n: n in M[m]["segs"] and M[m]["use"].get(n, False)
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
LV = {"high": 2, "medium": 1, "unsure": 0}
trans, per, nalt, altkinds = collections.Counter(), {}, 0, collections.Counter()
votes = collections.Counter()
x31 = collections.Counter()
ownc = collections.Counter()  # owner-name spans (normal words = the owner name): (before, after) confidence
for m in IDS:
    d = M[m]; g = d["g"]
    att = [NORM[f"a|{m}|{i}"] for i in range(d["n_att"])]
    own = NORM[f"o|{m}"] if d["owner"] else []
    if own:
        att = att + [own]  # silver-3.3: the owner name is trusted like an attendee name
    voc = [NORM[f"v|{m}|{i}"] for i in range(d["n_voc"])]
    exact = {tuple(a) for a in att + voc if a} | {(w,) for a in att for w in a}
    em = [NORM[f"e|{m}|{i}"] for i in range(d["n_em"])]
    listed = exact | {tuple(a) for a in em if a} | {(w,) for a in em for w in a}
    if V31:
        assert len(d["s3"]["spans"]) == len(g["spans"])
    spans, cc = [], collections.Counter()
    for i, sp in enumerate(g["spans"]):
        st = NORM[f"k|{m}|{i}"]
        wins = {n: window(m, n, sp["channel"], sp["startMs"], sp["endMs"]) for n in ORDER if usable(m, n)}
        hit = [n for n in ORDER if n in wins and contains(st, wins[n])]
        ind = [n for n in hit if n in INDEP]
        ex = tuple(st) in exact
        alts = collections.Counter(a for n in INDEP if n in wins and n not in hit for a in [alt_at(st, wins[n])] if a)
        alt, na = (alts.most_common(1)[0] if alts else (None, 0))
        if len(ind) >= 3 or (len(ind) == 2 and ex):
            conf = "high"
        elif len(ind) == 2 or (len(ind) == 1 and ex):
            conf = "medium"
        else:
            conf = "unsure"
        votes[min(len(ind), 4)] += 1
        vc = bool(sp.get("verifier_conflict"))
        if vc:
            conf = "unsure"
        o = dict(channel=sp["channel"], startMs=int(sp["startMs"]), endMs=int(sp["endMs"]), text=sp["text"], label=sp["label"],
                 in_vocab=sp["in_vocab"], confidence=conf, witnesses=hit)
        if na >= 2:
            altkinds["exact" if ex else "not_exact"] += 1
            o["confidence"] = "unsure"
            o["alt_text"] = alt
            nalt += 1
            altkinds[f"agree{min(len(ind), 3)}"] += 1
            if V31 and tuple(st) in listed:
                snd = lev_ratio(" ".join(st), alt) >= SOUND
                x31[("listed", "exact_s3" if ex else "email_only", "sound" if snd else "not_sound", f"agree{min(len(ind), 3)}")] += 1
                if snd and not vc:
                    o["confidence"] = "high" if len(ind) >= 2 else "medium"
        if vc:
            o["verifier_conflict"] = True
        old = d["s3"]["spans"][i]["confidence"] if V31 else sp["confidence"]
        if V31:
            s3 = d["s3"]["spans"][i]
            assert (s3["text"], s3["startMs"]) == (o["text"], o["startMs"])
            if s3.get("alt_text") != o.get("alt_text") or s3["witnesses"] != o["witnesses"] or s3["confidence"] != o["confidence"]:
                same_in = s3.get("alt_text") == o.get("alt_text") and s3["witnesses"] == o["witnesses"]
                x31[("changed", "rule" if same_in else "witness_data", f"{s3['confidence']}->{o['confidence']}")] += 1
        if own and st == own:
            ownc[(old, o["confidence"])] += 1
        trans[(old, o["confidence"])] += 1; cc[(old, o["confidence"])] += 1
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
            old_ok = t["wer_eligible"]
            elig["turns"] += 1; elig["eligible"] += ok; elig["old_eligible"] += old_ok
            elig["words"] += len(ref); elig["eligible_words"] += len(ref) * ok; elig["old_eligible_words"] += len(ref) * old_ok
            for b in basis:
                elig["basis:" + b] += 1
            out.append(dict(startMs=int(t["startMs"]), endMs=int(t["endMs"]), text=t["text"], verified=False, basis=basis, wer_eligible=ok))
        tr[ch] = out
    ver = dict(g["verification"])
    ver["method"] = METHOD + " Blind verifier (unchanged from silver-2): " + ver["method"]
    key = {k: g[k] for k in ("format", "meeting", "meetingId", "id8", "asrHash", "verifiedSpans", "timeToleranceMs",
                             "fixes", "mustNotChange", "summary", "tags", "speakers")}
    key.update(goldVersion=3, goldKind=KIND, builtAt=now, witnesses=d["W"], transcript=tr, spans=spans, verification=ver)
    per[m] = dict(cc=cc, elig=elig, wits=sorted(n for n in INDEP if usable(m, n)))
    if WRITE:
        cur, bak = f"{KEYS}/{m}.json", f"{KEYS}/{m}.silver-2.json"
        if not os.path.exists(bak):
            shutil.copy2(cur, bak); os.chmod(bak, 0o600)
        if V31:
            b3 = f"{KEYS}/{m}.{PREV}.json"
            if not os.path.exists(b3):
                assert J(cur).get("goldKind") == PREV
                shutil.copy2(cur, b3); os.chmod(b3, 0o600)
            assert J(b3).get("goldKind") == PREV
        tmp = cur + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(key, fh, ensure_ascii=False, indent=1)
        os.chmod(tmp, 0o600); os.replace(tmp, cur)
        assert J(cur)["goldKind"] == KIND

print("| meeting | voting witnesses | spans | up | down | same | eligible turns before -> after | eligible words before -> after |")
print("|---|---|---|---|---|---|---|---|")
for m in IDS:
    p = per[m]; cc = p["cc"]; e = p["elig"]
    up = sum(v for (a, b), v in cc.items() if LV[b] > LV[a]); dn = sum(v for (a, b), v in cc.items() if LV[b] < LV[a])
    print(f"| {m} | {','.join(p['wits'])} | {sum(cc.values())} | {up} | {dn} | {sum(v for (a, b), v in cc.items() if a == b)} | "
          f"{e['old_eligible']} -> {e['eligible']} / {e['turns']} | {100*e['old_eligible_words']/max(1,e['words']):.1f}% -> {100*e['eligible_words']/max(1,e['words']):.1f}% |")
print("\nconfidence transitions (" + (f"{PREV} -> {KIND}" if V31 else "silver-2 -> silver-3") + "):", {f"{a}->{b}": v for (a, b), v in sorted(trans.items())})
before, after = collections.Counter(), collections.Counter()
for (a, b), v in trans.items():
    before[a] += v; after[b] += v
print("before:", dict(before), " after:", dict(after))
print("independent agreeing witnesses per span (4 = 4 or more):", dict(sorted(votes.items())))
print("alt_text cases:", nalt, "by agreeing count on the key text:", dict(altkinds))
E = collections.Counter()
for p in per.values():
    E.update(p["elig"])
print(f"eligible turns pooled: {E['old_eligible']} -> {E['eligible']} of {E['turns']}; words {100*E['old_eligible_words']/E['words']:.1f}% -> {100*E['eligible_words']/E['words']:.1f}%")
print("basis counts:", {k[6:]: v for k, v in E.items() if k.startswith("basis:")})
if V31:
    print("silver-3.1 list-match alt cases (exact_s3 = in the silver-3 exact list):", {"|".join(k[1:]): v for k, v in sorted(x31.items()) if k[0] == "listed"})
    print(f"{KIND} changed spans vs {PREV} (rule = same witnesses and alt_text):", {"|".join(k[1:]): v for k, v in sorted(x31.items()) if k[0] == "changed"})
if V33:
    ob, oa = collections.Counter(), collections.Counter()
    for (a, b), v in ownc.items():
        ob[a] += v; oa[b] += v
    print(f"owner-name spans ({sum(ownc.values())}): before", dict(ob), " after", dict(oa), " transitions", {f"{a}->{b}": v for (a, b), v in sorted(ownc.items())})
