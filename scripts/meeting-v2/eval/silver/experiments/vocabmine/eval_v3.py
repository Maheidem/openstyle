"""Held-out evaluation of suggest_v3 against v2 and a frequency-only baseline.

TIME SPLIT (same rule as eval_v2): meetings sorted by started_at; TRAIN = older 60 %, TEST = newer 40 %.
Dictation rows split by created_at at the same instant. Every method runs on a temporary TRAIN-only
copy of the DB (deleted at the end), so no method can see TEST.

Run:  <eg2 venv python> -I eval_v3.py --db PATH --tag NAME            -> $SILVER_WORK/experiments/vocabmine/eval_v3_<tag>.json (masked) + table
      <eg2 venv python> -I eval_v3.py --db PATH --tag NAME --train-only  -> TRAIN lists only, no TEST metric
      add --sheet to print a labeling sheet with real terms (terminal only)
Evaluator labels (agent labels, NOT part of any pipeline): eval_labels.json (v2 round) and
eval_labels_v3.json (new terms): {"<sha1-12 of lower term>": {"l": "R|C|G|U", "p": 0|1}}
  R = ASR is likely to mishear it and it is a real term/name; C = real term, but the ASR already
  writes it right; G = not a term (garbage); U = unsure.   p = person name, for masking only.
"""
import datetime as dt, difflib, json, os, re, sqlite3, sys, time
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import suggest_v2 as v2  # noqa: E402
import suggest_v3 as v3  # noqa: E402
DATA = v2.DATA

T0 = time.time()
DB = sys.argv[sys.argv.index("--db") + 1]
TAG = sys.argv[sys.argv.index("--tag") + 1]
TRAIN_FRAC = 0.6
KS = (10, 20, 40)
TMP = os.path.join(DATA, f"_train_tmp_{TAG}.db")
SHEET = "--sheet" in sys.argv
TRAIN_ONLY = "--train-only" in sys.argv

src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
ms = src.execute("select id, started_at from meetings order by started_at, id").fetchall()
k_tr = round(TRAIN_FRAC * len(ms))
cut_ms = ms[k_tr][1]
cut_txt = dt.datetime.fromtimestamp(cut_ms / 1000, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
TEST_M = {m for m, _ in ms[k_tr:]}


def utc(ms_):
    return dt.datetime.fromtimestamp(ms_ / 1000, dt.timezone.utc).strftime("%Y-%m-%d %H:%M")


# ------------------------------------------------------------------ TRAIN-only DB copy
if os.path.exists(TMP):
    os.remove(TMP)
t = sqlite3.connect(f"file:{TMP}", uri=True)
os.chmod(TMP, 0o600)
t.execute("attach database ? as s", (f"file:{DB}?mode=ro",))
t.execute("create table meetings as select * from s.meetings where started_at < ?", (cut_ms,))
t.execute("create table meeting_segments as select * from s.meeting_segments where meeting_id in (select id from meetings)")
t.execute("create table meeting_speakers as select * from s.meeting_speakers where meeting_id in (select id from meetings)")
t.execute("create table meeting_folders as select * from s.meeting_folders")
t.execute("create table transcription_history as select * from s.transcription_history where created_at < ?", (cut_txt,))
t.execute("create table vocabulary as select * from s.vocabulary where created_at < ?", (cut_txt,))
t.execute("create table settings as select * from s.settings")
t.execute("create table sessions as select * from s.sessions")
t.commit()
q1 = lambda c, sql, *a: c.execute(sql, a).fetchone()[0]  # noqa: E731
split = {
    "db": os.path.basename(DB),
    "train_meetings": q1(t, "select count(*) from meetings"), "test_meetings": len(TEST_M),
    "train_from": utc(ms[0][1]), "train_to": utc(ms[k_tr - 1][1]),
    "test_from": utc(ms[k_tr][1]), "test_to": utc(ms[-1][1]), "cutoff_utc": cut_txt,
    "train_dictation_rows": q1(t, "select count(*) from transcription_history"),
    "test_dictation_rows": q1(src, "select count(*) from transcription_history where created_at >= ?", cut_txt),
    "train_segments": q1(t, "select count(*) from meeting_segments"),
    "train_enhanced_segments": q1(t, "select count(*) from meeting_segments where enhanced_text is not null"),
    "test_enhanced_segments": q1(src, f"select count(*) from meeting_segments where enhanced_text is not null "
                                      f"and meeting_id in ({','.join('?' * len(TEST_M))})", *TEST_M),
    "train_meetings_with_attendees": q1(t, "select count(*) from meetings where calendar_attendees is not null "
                                           "and calendar_attendees not in ('', '[]')"),
    "vocabulary_rows_at_cutoff": q1(t, "select count(*) from vocabulary"),
    "vocabulary_rows_after_cutoff": q1(src, "select count(*) from vocabulary where created_at >= ?", cut_txt),
}
t.close()

try:
    tv = time.time()
    model, devinfo = v3.load_model(mps="--mps" in sys.argv)
    rt_load = round(time.time() - tv, 1)
    tm = time.time()
    v3_sugg, v3_info = v3.run(TMP, model=model)
    rt_v3 = round(time.time() - tm, 1)
    tm = time.time()
    v2_sugg, v2_info = v2.run(TMP, model=model)
    rt_v2 = round(time.time() - tm, 1)

    # -------------------------------------------------------------- frequency-only (as in eval_v2)
    tc = sqlite3.connect(f"file:{TMP}?mode=ro", uri=True)
    langs = json.loads(tc.execute("select value from settings where key='languages'").fetchone()[0])
    lex = v2.Lexicon(langs, v2.CONFIG)
    vocab_rows = [r[0].strip() for r in tc.execute("select term from vocabulary")]
    VOCAB = {x.lower() for x in vocab_rows} | {v2.nkey(x) for x in vocab_rows}

    def in_vocab(x):
        kx = v2.nkey(x)
        return x.lower() in VOCAB or kx in VOCAB or (kx.endswith("s") and kx[:-1] in VOCAB)

    TOK = re.compile(r"[^\W_][\w'’\-.]*[^\W_]|[^\W_]")
    cnt, forms = Counter(), defaultdict(Counter)
    tr_texts = [x for (x,) in tc.execute("select coalesce(enhanced_text, text) from meeting_segments")] + \
               [x for (x,) in tc.execute("select coalesce(cleaned_text, raw_text) from transcription_history")]
    for x in tr_texts:
        for w in TOK.findall(x or ""):
            if v2.term_token(w, lex) and not in_vocab(w):
                cnt[w.lower()] += 1
                forms[w.lower()][w] += 1
    freq_sugg = [{"term": forms[w].most_common(1)[0][0], "kind": "term", "variants": []}
                 for w, _ in cnt.most_common(v2.CONFIG["top_k"])]
    tc.close()
finally:
    if os.path.exists(TMP):
        os.remove(TMP)

METHODS = {"v3": v3_sugg, "v2": v2_sugg, "freq_only": freq_sugg}


def load_labels():
    lab = {}
    for f in ("eval_labels.json", "eval_labels_v3.json"):
        p = os.path.join(DATA, f)
        if os.path.exists(p):
            lab.update(json.load(open(p)))
    return lab


labels = load_labels()

# ------------------------------------------------------------------ masking (names from the full DB + evaluator flags)
full_names = set()
for (att,) in src.execute("select calendar_attendees from meetings"):
    try:
        lst = json.loads(att) if att else []
    except Exception:
        lst = []
    for a in lst or []:
        n, _ = v3.attendee_name(a, v3.CONFIG)
        if n:
            full_names.update(x.lower() for x in v2.WORDTOK.findall(n) if len(x) >= 3)
for dn, sn, kd in src.execute("select display_name, suggested_name, suggested_kind from meeting_speakers"):
    for n in (dn, sn if kd != "role" else None):
        if n and "@" not in n:
            full_names.update(x.lower() for x in v2.WORDTOK.findall(n) if len(x) >= 3)
full_names |= v2_info["name_tokens"] | v3_info["name_tokens"]
person_h = {h for h, v in labels.items() if v.get("p")}
mask, _ = v2.make_masker([l[:40] for l in METHODS.values()], full_names, person_h)

if SHEET:  # terminal only: real terms for the evaluator to label
    print("LABEL SHEET (terminal only)")
    seen = set()
    for name, lst in METHODS.items():
        for i, s in enumerate(lst[:40], 1):
            h = v2.h12(s["term"])
            if h not in seen and h not in labels:
                seen.add(h)
                print(f"{h} {name}#{i:<3} {s['term']!r} kind={s.get('kind')} var={s.get('variants', [])[:4]} "
                      f"ev={s.get('evidence')} src={s.get('sources', '')}")

if TRAIN_ONLY:
    print(json.dumps({"split": split, "v3_rules_fired": v3_info["rules_fired"],
                      "v3_owner_source": v3_info["owner_source"]}, indent=1))
    for i, s in enumerate(v3.masked_view(v3_sugg, mask, 40), 1):
        print(i, s["term"], s["kind"], s["sources"], s["evidence"], s["meetings"], s["variants"][:3],
              labels.get(v2.h12(v3_sugg[i - 1]["term"]), {}).get("l"))
    sys.exit(0)

# ------------------------------------------------------------------ TEST signals (TEST rows only)
qm = ",".join("?" * len(TEST_M))
test_texts = [x for (x,) in src.execute(f"select coalesce(enhanced_text, text) from meeting_segments "
                                        f"where meeting_id in ({qm})", tuple(TEST_M)) if x]
test_texts += [x for (x,) in src.execute("select coalesce(cleaned_text, raw_text) from transcription_history "
                                         "where created_at >= ?", (cut_txt,)) if x]
CORPUS = "\n".join(test_texts).lower()
test_att, train_att = set(), set()
for mid, att in src.execute("select id, calendar_attendees from meetings"):
    try:
        lst = json.loads(att) if att else []
    except Exception:
        lst = []
    for a in lst or []:
        n, _ = v3.attendee_name(a, v3.CONFIG)
        if n:
            (test_att if mid in TEST_M else train_att).add(n.lower())
test_att_new = {n for n in test_att if not in_vocab(n)}


def norm(tok):
    return re.sub(r"[^\w'’-]", "", tok.lower()).strip("'’-")


def raw_pairs(raw, enh):
    """Method-neutral correction targets (as in eval_v2): replace spans <= 3 tokens, enhanced side."""
    rt = [x for x in raw.split() if norm(x)]
    et = [x for x in enh.split() if norm(x)]
    rn, en = [norm(x) for x in rt], [norm(x) for x in et]
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=rn, b=en, autojunk=False).get_opcodes():
        if op == "replace" and "".join(rn[i1:i2]) != "".join(en[j1:j2]) and i2 - i1 <= 3 and j2 - j1 <= 3:
            yield " ".join(x.strip(".,!?;:\"()") for x in et[j1:j2])


tgt_ctx = defaultdict(set)
rows = [(("m", m), r, e) for m, r, e in src.execute(
    f"select meeting_id, text, enhanced_text from meeting_segments where enhanced_text is not null "
    f"and meeting_id in ({qm})", tuple(TEST_M))]
rows += [(("d", i), r, e) for i, r, e in src.execute(
    "select id, raw_text, cleaned_text from transcription_history where cleaned_text is not null and created_at >= ?",
    (cut_txt,))]
for ctx, r, e in rows:
    if r and e and r != e:
        for tg in raw_pairs(r, e):
            if any(c.isupper() or c.isdigit() for c in tg) and sum(c.isalnum() for c in tg) >= 3 and not in_vocab(tg):
                tgt_ctx[v2.nkey(tg)].add(ctx)
targets = set(tgt_ctx)
targets_rec = {x for x, c in tgt_ctx.items() if len(c) >= 2}


def occurs(term):
    tl = term.lower()
    return tl in test_att or re.search(r"(?<!\w)" + re.escape(tl) + r"(?!\w)", CORPUS) is not None


def keys_of(lst):
    """Normalized keys of the terms and variants; an acronym plural also covers its singular."""
    out = set()
    for s in lst:
        for x in [s["term"]] + list(s.get("variants", [])):
            out.add(v2.nkey(x))
    return out


table, unlabeled = {}, set()
covered = {}
for name, lst in METHODS.items():
    row = {}
    for k in KS:
        row[f"hit@{k}"] = round(sum(occurs(s["term"]) for s in lst[:k]) / k, 3)
    for k in (20, 40):
        top = keys_of(lst[:k])
        row[f"cov_targets@{k}"] = f"{len(targets & top)}/{len(targets)}"
        row[f"cov_targets_rec@{k}"] = f"{len(targets_rec & top)}/{len(targets_rec)}"
        covered[(name, k)] = targets & top
    att_keys = {s["term"].lower() for s in lst[:40]} | {x.lower() for s in lst[:40] for x in s.get("variants", [])}
    row["cov_attendees@40"] = f"{sum(1 for n in test_att_new if n in att_keys or v2.nkey(n) in keys_of(lst[:40]))}/{len(test_att_new)}"
    lab = [labels.get(v2.h12(s["term"]), {}).get("l") for s in lst[:40]]
    unlabeled |= {s["term"] for s, l in zip(lst[:40], lab) if l is None}
    for k in KS:
        row[f"eval_prec@{k}"] = round(sum(l == "R" for l in lab[:k]) / k, 3) if all(lab[:k]) else None
    row["eval_labels@40"] = dict(Counter(l or "?" for l in lab))
    table[name] = row

lists_out = {}
for name, lst in METHODS.items():
    vm = v3.masked_view(lst, mask, 40) if name == "v3" else None
    lists_out[name] = [{"rank": i, "term": mask(s["term"]), "label": labels.get(v2.h12(s["term"]), {}).get("l"),
                        "in_test": occurs(s["term"]), "sources": s.get("sources", ""),
                        **({"evidence": s["evidence"], "variants": vm[i - 1]["variants"][:4]} if vm else {})}
                       for i, s in enumerate(lst[:40], 1)]

result = {
    "split": split, "config": v3.CONFIG, "n_knobs": len(v3.CONFIG), "rules": v3.RULES, "n_rules": len(v3.RULES),
    "metric_notes": {
        "cov_targets@k": "PRIMARY. distinct TEST correction targets (<=3 tokens, has capital or digit, >=3 alnum "
                         "chars, not in vocabulary at cutoff) whose normalized form equals a TRAIN top-k term or variant",
        "cov_targets_rec@k": "same, only targets seen in >=2 TEST meetings/dictation rows",
        "hit@k": "fraction of TRAIN top-k terms found in TEST final text as a whole word, or as a TEST attendee",
        "cov_attendees@40": "TEST attendee names (display name or first.last email) not in vocabulary, covered",
        "eval_prec@k": "EVALUATOR label (the agent, not the pipeline): R share in top k; null if a label is missing",
    },
    "n_targets": len(targets), "n_targets_rec": len(targets_rec),
    "targets_covered_by_v3_not_v2@40": len(covered[("v3", 40)] - covered[("v2", 40)]),
    "targets_covered_by_v2_not_v3@40": len(covered[("v2", 40)] - covered[("v3", 40)]),
    "test_attendees_also_in_train": len(test_att_new & train_att),
    "table": table,
    "v3_rules_fired": v3_info["rules_fired"], "v3_owner_source": v3_info["owner_source"],
    "v2_rules_fired": v2_info["rules_fired"],
    "runtime_s": {"model_load": rt_load, "v3_pipeline": rt_v3, "v2_pipeline": rt_v2,
                  "total": round(time.time() - T0, 1)},
    "device": devinfo,
    "top40": lists_out,
}
out = os.path.join(DATA, f"eval_v3_{TAG}.json")
json.dump(result, open(out, "w"), indent=1, ensure_ascii=False)
print(json.dumps({k: result[k] for k in ("split", "table", "n_targets", "n_targets_rec",
                                         "targets_covered_by_v3_not_v2@40", "targets_covered_by_v2_not_v3@40",
                                         "v3_rules_fired", "v3_owner_source", "runtime_s")},
                 indent=1, ensure_ascii=False))
print(f"unlabeled in top40: {len(unlabeled)}; wrote {out}")
