"""Score systems against the silver gold keys. Prints counts only (no text).

silver-2: needs goldVersion "silver-2" keys and aligned meet.json/krisp.json
(every line has startMs; EG2 method A, see align_eg2.py). WER counts only
gold turns with wer_eligible; span accuracy uses the silver-2 confidence.

Run: python3 -I score_silver.py [--suffix .silver-2]   (default: the current <id8>.json keys)
     (pnpm meeting:silver:score; paths and meetings from silver_paths.py: SILVER_KEYS, SILVER_CORPUS,
     SILVER_MEETINGS; APP_ENH_ENRICHED only when SILVER_ENRICHED_DB exists)
Keys: goldVersion 3 with goldKind silver-2, silver-3, silver-3.1, silver-3.2 or silver-3.3. Compare systems only within one gold version.
WER/CER and the word normal form come from the TS scorer (wer.mts calls
scoreChannel, scoreWords, normalizeWords of the repo's eval). No port.
"""
import json, os, sqlite3, subprocess, collections, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

IDS = P.meeting_ids()
KEYS = P.KEYS
CORP = P.CORPUS
ENR = P.ENRICHED_DB
TOL = 3000
WIDE = 60000
INDEP = {"h1", "h3", "parakeet", "openai", "gemini", "meet", "krisp"}
SUF = sys.argv[sys.argv.index("--suffix") + 1] if "--suffix" in sys.argv else ""
SYSTEMS = ["H1", "H2", "H3", "PARAKEET", "OPENAI", "GEMINI", "APP_RAW", "APP_ENH", "APP_ENH_ENRICHED", "MEET", "KRISP"]
WIT = {"PARAKEET": "parakeet", "OPENAI": "openai", "GEMINI": "gemini", "H1": "h1", "H2": "h2", "H3": "h3", "MEET": "meet", "KRISP": "krisp", "MEET_SHIFT": "meet", "KRISP_SHIFT": "krisp",
       "APP_RAW": "app", "APP_ENH": "app", "APP_ENH_ENRICHED": "app"}
LGROUP = {"term": "term", "product": "term", "person": "person"}


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def exists(p):
    return os.path.exists(p)


# Owner speaker label: the one speaker in every Meet/Krisp file. Never printed.
ext_files = [f"{CORP}/{m}/{n}.json" for m in IDS for n in ("meet", "krisp") if exists(f"{CORP}/{m}/{n}.json")]
owner = None
sets = [set(t["speaker"] for t in J(f)["turns"]) for f in ext_files]
common = set.intersection(*sets) if sets else set()
if len(common) == 1:
    owner = next(iter(common))
else:
    sys.exit(f"owner detection failed: {len(common)} common speakers")

enr = sqlite3.connect(f"file:{ENR}?mode=ro", uri=True) if exists(ENR) else None

data = {}  # m -> dict(gold, systems: name -> list of (ch,start,end,text))
for m in IDS:
    g = J(f"{KEYS}/{m}{SUF}.json")
    assert g.get("goldVersion") == 3 and g.get("goldKind") in ("silver-2", "silver-3", "silver-3.1", "silver-3.2", "silver-3.3"), f"{m}: not a silver key"
    app = J(f"{CORP}/{m}/app.json")
    sy = {}
    for n in ("h1", "h2", "h3", "parakeet", "openai", "gemini"):
        if not exists(f"{CORP}/{m}/{n}.json"):
            continue
        h = J(f"{CORP}/{m}/{n}.json")
        sy[n.upper()] = [(ch, s["startMs"], s["endMs"], s["text"] or "") for ch in ("mic", "system") for s in h["channels"][ch]]
    sy["APP_RAW"] = [(ch, s["startMs"], s["endMs"], s["text"] or "") for ch in ("mic", "system") for s in app["channels"][ch]]
    sy["APP_ENH"] = [(ch, s["startMs"], s["endMs"], s["enhancedText"] if s["enhancedText"] is not None else (s["text"] or "")) for ch in ("mic", "system") for s in app["channels"][ch]]
    rows = [] if enr is None else enr.execute("select source, idx, start_ms, end_ms, text, enhanced_text from meeting_segments where meeting_id=? order by source, idx", (app["meetingId"],)).fetchall()
    if rows:
        sy["APP_ENH_ENRICHED"] = [(r[0], r[2] or 0, r[3] or 0, r[5] if r[5] is not None else (r[4] or "")) for r in rows]
    for n in ("meet", "krisp"):
        p = f"{CORP}/{m}/{n}.json"
        if not exists(p):
            continue
        T = J(p)["turns"]
        assert all(isinstance(t["startMs"], int) for t in T), f"{m}/{n}: not aligned"
        segs = []
        for i, t in enumerate(T):
            nxt = T[i + 1]["startMs"] if i + 1 < len(T) else t["startMs"] + 30000
            end = min(max(nxt, t["startMs"] + 1000), t["startMs"] + 30000)
            if end < 0 or t["startMs"] > app["durationMs"]:
                continue  # outside the audio
            segs.append(("mic" if t["speaker"] == owner else "system", t["startMs"], end, t["text"] or ""))
        sy[n.upper()] = segs
    data[m] = dict(gold=g, sys=sy)

# One node call: WER jobs + normal forms for span texts and segment texts.
jobs, norm_in = [], {}
for m, d in data.items():
    # silver-2: verified := wer_eligible, so the verified WER of scoreChannel
    # counts only errors at eligible turns (one global alignment per channel).
    tr = {ch: [dict(t, verified=bool(t["wer_eligible"])) for t in d["gold"]["transcript"][ch]] for ch in ("mic", "system")}
    for sname, segs in d["sys"].items():
        rows = [dict(id=str(i), source=ch, idx=i, start_ms=s, text=t, enhanced_text=None) for i, (ch, s, e, t) in enumerate(segs)]
        jobs.append(dict(key=f"{m}|{sname}", transcript=tr, rows=rows))
        for i, (ch, s, e, t) in enumerate(segs):
            norm_in[f"s|{m}|{sname}|{i}"] = t
    for i, sp in enumerate(d["gold"]["spans"]):
        norm_in[f"k|{m}|{i}"] = sp["text"]
r = subprocess.run(P.node_ts(P.WER_MTS), input=json.dumps(dict(jobs=jobs, spans=norm_in)), capture_output=True, text=True)
if r.returncode:
    sys.exit("node failed: " + r.stderr[-2000:])
res = json.loads(r.stdout)
NORM, WER = res["norm"], res["wer"]

# Diagnostic only: residual shift of MEET/KRISP after alignment = median
# (gold span start - time of the span inside the one external line that
# holds it; time by character position between line start and line end).
SHIFT = {}
for m, d in data.items():
    for base in ("MEET", "KRISP"):
        if base not in d["sys"]:
            continue
        segs = d["sys"][base]
        ds = []
        for i, sp in enumerate(d["gold"]["spans"]):
            if sp["confidence"] not in ("high", "medium"):
                continue
            st = NORM[f"k|{m}|{i}"]
            hits = []
            for j, (ch, s, e, t) in enumerate(segs):
                ln = f" {NORM[f's|{m}|{base}|{j}']} "
                if st and f" {st} " in ln:
                    hits.append(s + (e - s) * ln.index(f" {st} ") / max(1, len(ln)))
            if len(hits) == 1:
                ds.append(int(sp["startMs"] - hits[0]))
        ds.sort()
        SHIFT[(m, base)] = (ds[len(ds) // 2] if ds else 0, len(ds))

# ---- span accuracy -------------------------------------------------------------
# acc[(sys, scope, cut)] = [hit, n]
acc = collections.defaultdict(lambda: [0, 0])


def add(k, hit):
    a = acc[k]
    a[0] += hit
    a[1] += 1


for m, d in data.items():
    for i, sp in enumerate(d["gold"]["spans"]):
        conf = sp["confidence"]
        if conf not in ("high", "medium"):
            continue
        st = NORM[f"k|{m}|{i}"]
        if not st:
            continue
        wits = set(sp["witnesses"])
        lg = LGROUP.get(sp["label"], "other")
        for sname, segs in d["sys"].items():
            def hit_at(tol, loose=False):
                win = " ".join(NORM[f"s|{m}|{sname}|{j}"] for j, (ch, s, e, t) in enumerate(segs)
                               if ch == sp["channel"] and e >= sp["startMs"] - tol and s <= sp["endMs"] + tol)
                if loose:
                    return int(st.replace(" ", "") in win.replace(" ", ""))
                return int(f" {st} " in f" {win} ")
            h = hit_at(TOL)
            w = WIT[sname]
            loo_ok = (w not in wits) or len((wits & INDEP) - {w}) >= 1
            for scope in ("all", f"label:{lg}", f"rawlabel:{sp['label']}", f"vocab:{sp['in_vocab']}"):
                add((sname, m, scope, "hm"), h)
                add((sname, "POOL", scope, "hm"), h)
                if conf == "high":
                    add((sname, m, scope, "high"), h)
                    add((sname, "POOL", scope, "high"), h)
                if loo_ok:
                    add((sname, m, scope, "loo"), h)
                    add((sname, "POOL", scope, "loo"), h)
            add((sname, "POOL", "all", "loose"), hit_at(TOL, True))
            add((sname, m, "all", "wide"), hit_at(WIDE))
            add((sname, "POOL", "all", "wide"), hit_at(WIDE))
            add((sname, "POOL", "all", "self_wit"), int(w in wits))


def pct(k):
    a = acc.get(k)
    if not a or not a[1]:
        return "-"
    return f"{100*a[0]/a[1]:.1f} ({a[0]}/{a[1]})"


out = []
P = out.append
P("## Span accuracy, pooled (percent (hit/n)), window +-3 s, high+medium unless stated")
P("| system | meetings | H+M all | high only | LOO H+M | loose (no spaces) | +-60 s | term+product | person | other(org,place,other) | in_vocab | not in_vocab |")
P("|---|---|---|---|---|---|---|---|---|---|---|---|")
for s in SYSTEMS:
    nm = sum(1 for m in IDS if s in data[m]["sys"])
    P(f"| {s} | {nm} | {pct((s,'POOL','all','hm'))} | {pct((s,'POOL','all','high'))} | {pct((s,'POOL','all','loo'))} | {pct((s,'POOL','all','loose'))} | {pct((s,'POOL','all','wide'))} | "
      f"{pct((s,'POOL','label:term','hm'))} | {pct((s,'POOL','label:person','hm'))} | {pct((s,'POOL','label:other','hm'))} | {pct((s,'POOL','vocab:True','hm'))} | {pct((s,'POOL','vocab:False','hm'))} |")

P("\n## LOO span accuracy by label and in_vocab, pooled")
P("| system | term+product | person | other | in_vocab | not in_vocab | high only, LOO not applied |")
P("|---|---|---|---|---|---|---|")
for s in SYSTEMS:
    P(f"| {s} | {pct((s,'POOL','label:term','loo'))} | {pct((s,'POOL','label:person','loo'))} | {pct((s,'POOL','label:other','loo'))} | {pct((s,'POOL','vocab:True','loo'))} | {pct((s,'POOL','vocab:False','loo'))} | {pct((s,'POOL','all','high'))} |")

P("\n## Span accuracy by raw label, pooled H+M")
labs = ["product", "term", "person", "org", "place", "other"]
P("| system | " + " | ".join(labs) + " |")
P("|---|" + "---|" * len(labs))
for s in SYSTEMS:
    P(f"| {s} | " + " | ".join(pct((s, 'POOL', f'rawlabel:{l}', 'hm')) for l in labs) + " |")

P("\n## Share of H+M spans where the system is a listed witness (circularity size)")
P("| system | " + " | ".join(SYSTEMS) + " |")
P("|---|" + "---|" * len(SYSTEMS))
P("| self witness | " + " | ".join(pct((s, 'POOL', 'all', 'self_wit')) for s in SYSTEMS) + " |")


def short(k):
    a = acc.get(k)
    return "-" if not a or not a[1] else f"{100*a[0]/a[1]:.0f}"


P("\n## Span accuracy per meeting, H+M (percent), with LOO after the slash; n = H+M spans")
P("| meeting | n | " + " | ".join(SYSTEMS) + " |")
P("|---|---|" + "---|" * len(SYSTEMS))
for m in IDS:
    n = acc.get(("H1", m, "all", "hm"), [0, 0])[1]
    P(f"| {m} | {n} | " + " | ".join("-" if s not in data[m]["sys"] else f"{short((s,m,'all','hm'))}/{short((s,m,'all','loo'))}" for s in SYSTEMS) + " |")

# ---- WER / CER -----------------------------------------------------------------
P("\n## WER and CER on wer_eligible gold turns only (silver-2): one global alignment per channel (scoreChannel), errors counted at eligible turns (verified := wer_eligible)")
P("| system | meetings | eligible words | WER mic | WER system | WER both | CER both |")
P("|---|---|---|---|---|---|---|")
for s in SYSTEMS:
    T = collections.defaultdict(int); nm = 0
    for m in IDS:
        w = WER.get(f"{m}|{s}")
        if not w:
            continue
        nm += 1
        for ch in ("mic", "system"):
            x = w[ch]
            if not x:
                continue
            for f in ("wv", "wvr", "cv", "cvr"):
                T[f"{ch}.{f}"] += x[f]; T[f] += x[f]
    r_ = lambda a, b: "-" if not T[b] else f"{100*T[a]/T[b]:.1f}"
    P(f"| {s} | {nm} | {T['wvr']} | {r_('mic.wv','mic.wvr')} | {r_('system.wv','system.wvr')} | {r_('wv','wvr')} | {r_('cv','cvr')} |")

P("\n## WER on wer_eligible turns per meeting (percent, both channels; eligible turns/all turns)")
P("| meeting | eligible | " + " | ".join(SYSTEMS) + " |")
P("|---|---|" + "---|" * len(SYSTEMS))
for m in IDS:
    g = data[m]["gold"]["transcript"]
    ne = sum(t["wer_eligible"] for c in ("mic", "system") for t in g[c]); nt = sum(len(g[c]) for c in ("mic", "system"))
    cells = []
    for s in SYSTEMS:
        w = WER.get(f"{m}|{s}")
        if not w:
            cells.append("-"); continue
        e_ = sum(x["wv"] for x in w.values() if x); r__ = sum(x["wvr"] for x in w.values() if x)
        cells.append("-" if not r__ else f"{100*e_/r__:.0f}")
    P(f"| {m} | {ne}/{nt} | " + " | ".join(cells) + " |")

P("\n## WER and CER vs ALL gold turns, meeting level (old method, for comparison; normalized WER as in score.mts)")
P("| system | meetings | WER mic | WER system | WER both | CER mic | CER system | CER both | sub/del/ins (both) |")
P("|---|---|---|---|---|---|---|---|---|")
werm = {}
for s in SYSTEMS:
    T = collections.defaultdict(int)
    nm = 0
    for m in IDS:
        w = WER.get(f"{m}|{s}")
        if not w:
            continue
        nm += 1
        tw = tr = 0
        for ch in ("mic", "system"):
            x = w[ch]
            if not x:
                continue
            for f in ("w", "wr", "c", "cr", "sub", "del", "ins"):
                T[f"{ch}.{f}"] += x[f]
                T[f] += x[f]
            tw += x["w"]; tr += x["wr"]
        werm[(m, s)] = (tw / tr if tr else None, w)
    r_ = lambda a, b: "-" if not T[b] else f"{100*T[a]/T[b]:.1f}"
    P(f"| {s} | {nm} | {r_('mic.w','mic.wr')} | {r_('system.w','system.wr')} | {r_('w','wr')} | {r_('mic.c','mic.cr')} | {r_('system.c','system.cr')} | {r_('c','cr')} | {T['sub']}/{T['del']}/{T['ins']} |")

P("\n## WER per meeting (percent, mic/system)")
P("| meeting | " + " | ".join(SYSTEMS) + " |")
P("|---|" + "---|" * len(SYSTEMS))
for m in IDS:
    cells = []
    for s in SYSTEMS:
        w = WER.get(f"{m}|{s}")
        if not w:
            cells.append("-"); continue
        f = lambda x: "-" if not x or not x["wr"] else f"{100*x['w']/x['wr']:.0f}"
        cells.append(f"{f(w['mic'])}/{f(w['system'])}")
    P(f"| {m} | " + " | ".join(cells) + " |")

# ---- corpus stats --------------------------------------------------------------
P("\n## Corpus stats")
tm = ts = 0
LC = collections.Counter(); CC = collections.Counter(); VC = collections.Counter(); LCC = collections.Counter()
conflict = collections.Counter(); before = collections.Counter()
for m in IDS:
    g = data[m]["gold"]
    tm += len(g["transcript"]["mic"]); ts += len(g["transcript"]["system"])
    for sp in g["spans"]:
        LC[sp["label"]] += 1; CC[sp["confidence"]] += 1; VC[(sp["in_vocab"], sp["confidence"])] += 1
        LCC[(sp["label"], sp["confidence"])] += 1
        if sp.get("verifier_conflict"):
            conflict[sp.get("verifier_conflict_kind") or "unspecified"] += 1
        if "confidence_before_verify" in sp:
            before[(sp["confidence_before_verify"], sp["confidence"])] += 1
P(f"- meetings: {len(IDS)}; gold turns: mic {tm}, system {ts}, total {tm+ts}")
P(f"- spans: {sum(CC.values())}; high {CC['high']}, medium {CC['medium']}, unsure {CC['unsure']}")
P(f"- in_vocab spans: high {VC[(True,'high')]}, medium {VC[(True,'medium')]}, unsure {VC[(True,'unsure')]}; not in_vocab: high {VC[(False,'high')]}, medium {VC[(False,'medium')]}, unsure {VC[(False,'unsure')]}")
P("\n| label | high | medium | unsure | total |")
P("|---|---|---|---|---|")
for l in labs:
    P(f"| {l} | {LCC[(l,'high')]} | {LCC[(l,'medium')]} | {LCC[(l,'unsure')]} | {LC[l]} |")
P(f"\n- spans with verifier_conflict: {sum(1 for m in IDS for sp in data[m]['gold']['spans'] if sp.get('verifier_conflict'))} (all unsure)")
P("\n| meeting | sampled | agree_text | agree_conf | conflicts_marked_unsure |")
P("|---|---|---|---|---|")
V = collections.Counter()
for m in IDS:
    v = data[m]["gold"]["verification"]
    P(f"| {m} | {v['sampled']} | {v['agree_text']} | {'n/a' if v['agree_conf'] is None else v['agree_conf']} | {v['conflicts_marked_unsure']} |")
    V["s"] += v["sampled"]; V["a"] += v["agree_text"]
P(f"\n- key spans that the blind verifier confirms: {100*V['a']/max(1,V['s']):.1f}% ({V['a']}/{V['s']})")
P("\n- MEET/KRISP residual shift after alignment (s, median gold-minus-line, n unique hits): " + "; ".join(f"{m} {b} {o//1000:+d} (n {n})" for (m, b), (o, n) in SHIFT.items()))
txt = "\n".join(out)
print(txt)
