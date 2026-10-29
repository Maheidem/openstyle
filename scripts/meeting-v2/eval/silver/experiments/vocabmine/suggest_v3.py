"""Offline vocabulary suggestions for Openstyle, v3 (generic method, mishearing objective).

Objective: suggest only terms that the ASR gets WRONG. A candidate needs MISHEARING EVIDENCE:
  E1  >= 1 correction pair (raw != corrected, meetings or dictation) whose raw form has an
      edit ratio >= raw_edit_min to the corrected term, or
  E2  >= variant_min_spellings distinct spellings of one term in the RAW transcripts
      (meetings and dictation) that merge under the v2 merge rules.
Calendar attendee names and the owner name are included without that evidence.
Recurring frequency only RANKS candidates that already have evidence.

Signals: text shape, counts, calendar attendees, the owner profile, wordfreq, geonamescache and
the local EG2 embedding model (CPU fp32 by default, bf16 on MPS with --mps; never fp16).
No term list from user data. No LLM in the pipeline.

Run:  <eg2 venv python> -I suggest_v3.py --db PATH [--show-terms [--unmask]] [--mps]
--show-terms prints the term list (terminal only, never paste or commit). Default: counts only.
Writes $SILVER_WORK/experiments/vocabmine/suggestions_v3_full.json (masked: person names become "name#N").
--unmask prints real names to stdout only and writes no file.
"""
import difflib, json, os, re, sqlite3, subprocess, sys, time
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# Generic helpers and resources are reused from v2 unchanged: Lexicon (wordfreq, geonamescache),
# term_token, extract_terms (app port of folder-memory.ts), nkey, ratio, norm, masking.
import suggest_v2 as v2  # noqa: E402
DATA = v2.DATA

# ============================================================== CONFIG (all knobs)
CONFIG = {
    # evidence
    "max_pair_tokens": 3,         # longest replace span (tokens) kept from a correction pair
    "raw_edit_min": 0.5,          # E1: raw form edit ratio to the corrected term >= this
    "variant_min_spellings": 2,   # E2: >= N distinct raw spellings that merge
    # names
    "att_min_meetings": 1,        # calendar attendee: in >= N meetings
    "email_part_min_letters": 2,  # first.last@ -> "First Last" when both parts >= N letters
    # generic filters
    "z_common": 4.0,              # wordfreq Zipf: a token is common at >= this in any app language
    "place_min_pop": 1_000_000,   # geonames cities with population >= N are known places
    "short_max_letters": 2,       # a part with <= N letters and no digit is short
    # merge (v2 rules)
    "merge_edit": 0.85,           # merge if edit ratio >= this
    "merge_cos": 0.90,            # or EG2 cosine >= this
    "merge_cos_edit": 0.75,       #   and edit ratio >= this
    "merge_min_chars": 4,         # never merge when one side has fewer chars (except acronym plural)
    # cross-check
    "cross_min": 2,               # a candidate form corrected away >= N times
    "cross_share": 0.5,           #   and in >= this share of its corrections moves to the target
    # score (ranking only)
    "w_corr": 3.0,                # per E1 correction pair
    "w_var": 2.0,                 # per extra distinct raw spelling (E2)
    "w_att": 2.0,                 # per attendee meeting
    "w_rec": 1.0,                 # per meeting where the term recurs in final text
    "w_agree": 2.0,               # bonus when >= agree_min_sources sources agree
    "agree_min_sources": 2,
    "global_min_folders": 3,      # scope = global when the term is in >= N folders
    "top_k": 40,
}
RULES = (
    "term_shape", "short_or_common_parts", "place_name", "contraction", "in_vocabulary",
    "evidence_correction_pair", "evidence_raw_edit_too_low", "evidence_spelling_variants",
    "no_evidence_dropped", "attendee_display_name", "attendee_from_email", "attendee_email_rejected",
    "owner_name_included", "owner_name_invalid", "owner_pairs_dropped", "calendar_spelling_wins",
    "shared_raw_forms", "merge_normalized", "merge_acronym_plural", "merge_edit", "merge_cos_edit",
    "merge_short_block", "names_do_not_merge_with_terms", "spelling_extension_ignored", "merge_word_conflict", "cross_check_absorb",
    "source_agreement_bonus", "recurring_rank_only",
)

DEFAULT_DB = v2.DEFAULT_DB
WORDTOK = v2.WORDTOK
nkey, ratio, norm = v2.nkey, v2.ratio, v2.norm
ACRO_PLURAL = re.compile(r"^([A-Z][A-Z0-9]+)s$")


def sing(form):
    """Acronym plural to singular: 'LLMs' -> 'LLM'. Other forms stay."""
    m = ACRO_PLURAL.match(form.strip())
    return m.group(1) if m else form


def spell_key(form):
    """Two raw forms are distinct spellings when this key differs (case, spaces, hyphens,
    dots and a plural s do not count)."""
    k = nkey(sing(form))
    return k[:-1] if len(k) > 3 and k.endswith("s") else k


# ============================================================== owner profile
def owner_name(con):
    """Owner name: signed-in session, settings, then the macOS full name. The macOS value is
    rejected when it equals the login name or has no space (it is then not a full name)."""
    try:
        r = con.execute("select name from sessions where name is not null and trim(name) != '' "
                        "order by updated_at desc limit 1").fetchone()
        if r:
            return r[0].strip(), "sessions.name"
    except sqlite3.Error:
        pass
    for key in ("user_name", "owner_name", "profile_name", "display_name", "name"):
        try:
            r = con.execute("select value from settings where key = ?", (key,)).fetchone()
        except sqlite3.Error:
            r = None
        if r and r[0] and r[0].strip():
            return r[0].strip(), f"settings.{key}"
    try:
        full = subprocess.run(["id", "-F"], capture_output=True, text=True, timeout=5).stdout.strip()
        login = subprocess.run(["id", "-un"], capture_output=True, text=True, timeout=5).stdout.strip()
        if full and full != login and " " in full:
            return full, "id -F"
        return None, "none (id -F rejected: equals login name or has no space)"
    except Exception:
        return None, "none"


def attendee_name(a, cfg):
    """Display name, else 'First Last' from a first.last@ email. Returns (name, how)."""
    if not isinstance(a, dict):
        return None, None
    n = (a.get("name") or "").strip()
    if n and "@" not in n:
        return n, "attendee_display_name"
    email = (a.get("email") or n or "").strip()
    local = email.split("@", 1)[0] if "@" in email else ""
    parts = local.split(".")
    mn = cfg["email_part_min_letters"]
    if len(parts) == 2 and all(p.isalpha() and len(p) >= mn for p in parts):
        return " ".join(p.capitalize() for p in parts), "attendee_from_email"
    return None, "attendee_email_rejected" if email else None


def load_model(mps=False):
    import torch
    from sentence_transformers import SentenceTransformer
    dev = "mps" if mps and torch.backends.mps.is_available() else "cpu"
    dtype = torch.bfloat16 if dev == "mps" else torch.float32   # never fp16
    m = SentenceTransformer("google/embeddinggemma-2", device=dev, model_kwargs={"torch_dtype": dtype},
                            config_kwargs={"vision_config": None})
    return m, f"{dev}/{dtype}"


# ============================================================== pipeline
def run(db_path, cfg=CONFIG, model=None):
    """Return (suggestions, info). Suggestions carry real names; mask before any write."""
    import numpy as np
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    fired = Counter()

    # ---- app signals: languages, vocabulary, owner, names
    try:
        langs = json.loads(con.execute("select value from settings where key='languages'").fetchone()[0])
    except Exception:
        langs = []
    langs = [l for l in langs if isinstance(l, str)] or ["en"]
    lex = v2.Lexicon(langs, cfg)

    vocab_rows = [r[0].strip() for r in con.execute("select term from vocabulary")]
    VOCAB = {x.lower() for x in vocab_rows} | {nkey(x) for x in vocab_rows}

    def in_vocab(t):
        k = nkey(sing(t))
        return t.lower() in VOCAB or k in VOCAB or (k.endswith("s") and k[:-1] in VOCAB)

    owner, owner_src = owner_name(con)
    if owner is None:
        fired["owner_name_invalid"] += 1
    owner_l = owner.lower() if owner else None
    owner_toks = {t.lower() for t in WORDTOK.findall(owner)} if owner else set()

    name_tokens = set(owner_toks)
    attendee_meetings, attendee_forms = defaultdict(set), defaultdict(Counter)
    for mid, att in con.execute("select id, calendar_attendees from meetings"):
        try:
            lst = json.loads(att) if att else []
        except Exception:
            lst = []
        for a in lst or []:
            n, how = attendee_name(a, cfg)
            if how:
                fired[how] += 1
            if not n:
                continue
            attendee_meetings[n.lower()].add(mid)
            attendee_forms[n.lower()][n] += 1
            name_tokens.update(t.lower() for t in WORDTOK.findall(n) if len(t) >= 3)
    for dn, sn, kind in con.execute("select display_name, suggested_name, suggested_kind from meeting_speakers"):
        for n in (dn, sn if kind != "role" else None):
            if n and "@" not in n:
                name_tokens.update(t.lower() for t in WORDTOK.findall(n) if len(t) >= 3)

    def is_name(term):
        toks = [t.lower() for t in WORDTOK.findall(term)]
        return bool(toks) and any(t in name_tokens for t in toks)

    def tok_shaped(t):
        return v2.term_token(t, lex)

    def trim_span(span):
        toks = span.split()
        idx = [i for i, t in enumerate(toks) if tok_shaped(t)]
        if not idx:
            return None
        return " ".join(t.strip(".,!?;:\"()") for t in toks[idx[0]:idx[-1] + 1])

    def part_weak(p):
        """A part is weak when it is short (no digit) or a common word (no digit)."""
        p = p.strip("'’-.,")
        if any(c.isdigit() for c in p):
            return False
        return sum(c.isalpha() for c in p) <= cfg["short_max_letters"] or lex.common(p)

    def reject(term):
        """Generic filter. Returns the rule name that rejects the term, else None.
        v3 fix: every part of a multi-word term gets the short and common checks."""
        toks = term.split()
        if not toks:
            return "short_or_common_parts"
        if any(v2.CONTRACTION.match(t.strip("'’-.,")) for t in toks):
            return "contraction"
        if lex.is_place(term):
            return "place_name"
        if all(part_weak(t) for t in toks):
            return "short_or_common_parts"
        return None

    def pairs(raw, enh):
        rt = [t for t in raw.split() if norm(t)]
        et = [t for t in enh.split() if norm(t)]
        rn, en = [norm(t) for t in rt], [norm(t) for t in et]
        mx = cfg["max_pair_tokens"]
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=rn, b=en, autojunk=False).get_opcodes():
            if op != "replace" or "".join(rn[i1:i2]) == "".join(en[j1:j2]):
                continue
            if i2 - i1 > mx or j2 - j1 > mx:
                continue
            yield (" ".join(t.strip(".,!?;:\"()") for t in rt[i1:i2]).lower(),
                   " ".join(t.strip(".,!?;:\"()") for t in et[j1:j2]))

    def owner_raw(r):
        return owner_l is not None and (r == owner_l or r in owner_toks)

    mfolder = {m: (f or "(none)") for m, f in con.execute("select id, folder_id from meetings")}
    folder_name = dict(con.execute("select id, name from meeting_folders"))

    def new_cand():
        return {"forms": Counter(), "corr": 0, "ctx": set(), "raw": Counter(), "spell": Counter(),
                "rec_meetings": set(), "att_meetings": set(), "kind": "term", "att_form": None,
                "owner": False}

    C = defaultdict(new_cand)
    raw_to_enh = defaultdict(Counter)

    # ---- E1: correction pairs, meetings (raw -> enhanced) and dictation (raw -> cleaned)
    rows = [(("m", mid), raw, enh) for mid, raw, enh in con.execute(
        "select meeting_id, text, enhanced_text from meeting_segments where enhanced_text is not null")]
    rows += [(("d", i), raw, cl) for i, raw, cl in con.execute(
        "select id, raw_text, cleaned_text from transcription_history where cleaned_text is not null")]
    for ctx, raw, enh in rows:
        if not raw or not enh or raw == enh:
            continue
        for r, e in pairs(raw, enh):
            if owner_raw(r):
                fired["owner_pairs_dropped"] += 1
                continue
            term = trim_span(e)
            if not term:
                continue
            term = sing(term)
            raw_to_enh[r][term] += 1
            why = reject(term)
            if why:
                fired[why] += 1
                continue
            if not r or ratio(nkey(r), nkey(term)) < cfg["raw_edit_min"]:
                fired["evidence_raw_edit_too_low"] += 1
                continue
            c = C[term.lower()]
            c["forms"][term] += 3
            c["corr"] += 1
            c["ctx"].add(ctx)
            c["raw"][r] += 1
            fired["evidence_correction_pair"] += 1

    # ---- E2 input: term-shaped runs in RAW text (meetings and dictation), one context per meeting/row
    raw_ctx = defaultdict(list)
    for mid, txt in con.execute("select meeting_id, text from meeting_segments where text is not null "
                                "order by meeting_id, idx"):
        raw_ctx[("m", mid)].append(txt)
    for i, txt in con.execute("select id, raw_text from transcription_history where raw_text is not null"):
        raw_ctx[("d", i)].append(txt)
    rawf = defaultdict(lambda: {"forms": Counter(), "ctx": set()})
    for ctx, texts in raw_ctx.items():
        for term, n, _ in v2.extract_terms(texts):
            if not all(tok_shaped(t) for t in term.split()):
                continue
            term = sing(term)
            if reject(term) or in_vocab(term) or owner_raw(term.lower()):
                continue
            rawf[term.lower()]["forms"][term] += n
            rawf[term.lower()]["ctx"].add(ctx)

    # ---- recurring term-shaped runs in FINAL text (ranking only)
    mtexts = defaultdict(list)
    for mid, txt in con.execute("select meeting_id, coalesce(enhanced_text, text) from meeting_segments "
                                "order by meeting_id, idx"):
        if txt:
            mtexts[mid].append(txt)
    rec = defaultdict(set)
    final_forms = defaultdict(Counter)
    for mid, texts in mtexts.items():
        for term, n, _ in v2.extract_terms(texts):
            if all(tok_shaped(t) for t in term.split()):
                term = sing(term)
                rec[term.lower()].add(mid)
                final_forms[term.lower()][term] += n

    # ---- names: attendees and owner
    for n, ms in attendee_meetings.items():
        if len(ms) >= cfg["att_min_meetings"]:
            c = C[n]
            form = attendee_forms[n].most_common(1)[0][0]
            c["forms"][form] += 10
            c["att_form"] = form
            c["att_meetings"] |= ms
            c["ctx"] |= {("m", m) for m in ms}
            c["kind"] = "name"
    if owner and not in_vocab(owner):
        c = C[owner_l]
        c["forms"][owner] += 10
        c["owner"] = True
        c["kind"] = "name"
        fired["owner_name_included"] += 1

    # ---- embeddings and the v2 merge test (shared by E2 clustering and the final merge)
    if model is None:
        model, devinfo = load_model()
    else:
        devinfo = "shared"
    emb_cache = {}

    def embed(texts):
        todo = [t for t in dict.fromkeys(texts) if t not in emb_cache]
        if todo:
            E = model.encode(todo, prompt_name="document", convert_to_numpy=True, batch_size=64).astype(np.float32)
            E /= np.linalg.norm(E, axis=1, keepdims=True)
            emb_cache.update(zip(todo, E))

    word_blocked = [0]

    def word_conflict(a, b):
        """v3 fix: multi-word forms that share a word are one term only when the other words are close."""
        ta, tb = re.split(r"[\s\-]+", a), re.split(r"[\s\-]+", b)
        if len(ta) < 2 and len(tb) < 2:
            return False
        shared = set(ta) & set(tb)
        ra, rb = [x for x in ta if x not in shared], [x for x in tb if x not in shared]
        if not shared or not ra or not rb:
            return False
        return ratio("".join(ra), "".join(rb)) < cfg["raw_edit_min"]

    def merge_tests(items, kind_of, disp_of):
        """v2 merge rules over keys. Returns (merge pairs with rule, blocked count)."""
        ks = sorted(items)
        nk = {k: nkey(k) for k in ks}
        cand, cos_need = [], []
        for i in range(len(ks)):
            a = ks[i]
            ka = nk[a]
            for j in range(i + 1, len(ks)):
                b = ks[j]
                kb = nk[b]
                la, lb = len(ka), len(kb)
                if 2 * min(la, lb) / max(1, la + lb) < cfg["merge_cos_edit"] and \
                        ka.rstrip("s") != kb.rstrip("s"):
                    continue
                if kind_of(a) != kind_of(b):
                    continue
                if ka == kb or ka.rstrip("s") == kb.rstrip("s"):
                    cand.append((a, b, "merge_normalized"))
                    continue
                sm = difflib.SequenceMatcher(a=ka, b=kb, autojunk=False)
                if sm.real_quick_ratio() < cfg["merge_cos_edit"] or sm.quick_ratio() < cfg["merge_cos_edit"]:
                    continue
                r = sm.ratio()
                if r >= cfg["merge_cos_edit"] and word_conflict(a, b):
                    word_blocked[0] += 1
                    continue
                if r >= cfg["merge_edit"]:
                    cand.append((a, b, "merge_edit"))
                elif r >= cfg["merge_cos_edit"]:
                    cos_need.append((a, b))
        if cos_need:
            embed([disp_of(x) for p in cos_need for x in p])
            for a, b in cos_need:
                if float(emb_cache[disp_of(a)] @ emb_cache[disp_of(b)]) >= cfg["merge_cos"]:
                    cand.append((a, b, "merge_cos_edit"))
        out, blocked = [], 0
        for a, b, why in cand:
            if min(len(nk[a]), len(nk[b])) < cfg["merge_min_chars"]:
                # v3 fix: an all-caps term and its plural ("LLM", "LLMs") merge at any length
                if why == "merge_normalized" and nk[a].rstrip("s") == nk[b].rstrip("s"):
                    out.append((a, b, "merge_acronym_plural"))
                else:
                    blocked += 1
                continue
            out.append((a, b, why))
        return out, blocked

    def union_find(keys, merges):
        parent = {k: k for k in keys}

        def find(k):
            while parent[k] != k:
                parent[k] = parent[parent[k]]
                k = parent[k]
            return k
        for a, b, _ in merges:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra
        groups = defaultdict(list)
        for k in keys:
            groups[find(k)].append(k)
        return groups

    # ---- E2: distinct raw spellings that merge
    r_kind = {k: ("name" if is_name(k) else "term") for k in rawf}
    r_disp = {k: rawf[k]["forms"].most_common(1)[0][0] for k in rawf}
    rmerges, rblocked = merge_tests(rawf, r_kind.get, r_disp.get)
    fired["merge_short_block"] += rblocked
    def extends(k, others):
        """k only adds words to another form of the group ('x api' extends 'x'): no new spelling."""
        tk = re.split(r"[\s\-]+", k)
        for o in others:
            to = re.split(r"[\s\-]+", o)
            if o != k and len(to) < len(tk) and any(tk[i:i + len(to)] == to for i in range(len(tk) - len(to) + 1)):
                return True
        return False

    for root, ks in union_find(list(rawf), rmerges).items():
        spellings = Counter()
        for k in ks:
            if extends(k, ks):
                fired["spelling_extension_ignored"] += 1
                continue
            spellings[spell_key(k)] += sum(rawf[k]["forms"].values())
        if len(spellings) < cfg["variant_min_spellings"]:
            continue
        # canonical: most frequent cased form in final text, else in raw text
        fin = Counter()
        for k in ks:
            fin.update(final_forms.get(k, {}))
        pool = fin if fin else sum((rawf[k]["forms"] for k in ks), Counter())
        cased = [f for f, _ in pool.most_common() if f != f.lower()]
        term = cased[0] if cased else pool.most_common(1)[0][0]
        c = C[term.lower()]
        for k in ks:
            c["forms"].update(rawf[k]["forms"])
            c["ctx"] |= rawf[k]["ctx"]
            if k != term.lower():
                c["raw"][k] += sum(rawf[k]["forms"].values())
        c["spell"].update(spellings)
        fired["evidence_spelling_variants"] += 1

    # ---- cross-check: a candidate form that the LLM corrects away moves to its corrected term
    crosschecks = []
    for k in list(C):
        c = C.get(k)
        if c is None or c["kind"] == "name" or k not in raw_to_enh:
            continue
        fixes = raw_to_enh[k]
        tgt, n = fixes.most_common(1)[0]
        if (tgt.lower() == k or n < cfg["cross_min"] or n < cfg["cross_share"] * sum(fixes.values())
                or n <= c["corr"] or reject(tgt)):
            continue
        t = C[tgt.lower()]
        t["forms"][tgt] += 1
        for f in ("raw", "spell"):
            t[f].update(c[f])
        t["ctx"] |= c["ctx"]
        t["corr"] += c["corr"]
        t["raw"][k] += n
        crosschecks.append((k, tgt))
        fired["cross_check_absorb"] += 1
        del C[k]

    # ---- drop vocabulary terms
    for k in list(C):
        if in_vocab(k) or any(in_vocab(f) for f in C[k]["forms"]):
            fired["in_vocabulary"] += 1
            del C[k]

    # ---- final merge of all candidates (v2 rules; names never merge with terms)
    keys = sorted(C)
    disp = {k: C[k]["forms"].most_common(1)[0][0] for k in keys}
    fmerges, fblocked = merge_tests(keys, lambda k: C[k]["kind"] == "name", disp.get)
    fired["merge_short_block"] += fblocked
    for _, _, why in fmerges:
        fired[why] += 1
    groups = union_find(keys, fmerges)

    # ---- build groups, evidence gate, canonical form, score
    sugg = []
    for root, ks in groups.items():
        g = new_cand()
        for k in ks:
            c = C[k]
            for f in ("forms", "raw", "spell"):
                g[f].update(c[f])
            for f in ("ctx", "att_meetings"):
                g[f] |= c[f]
            g["corr"] += c["corr"]
            g["owner"] |= c["owner"]
            g["att_form"] = g["att_form"] or c["att_form"]
            if c["kind"] == "name":
                g["kind"] = "name"
        nspell = len(g["spell"])
        evid = g["corr"] > 0 or nspell >= cfg["variant_min_spellings"]
        if not (evid or g["att_meetings"] or g["owner"]):
            fired["no_evidence_dropped"] += 1
            continue
        if g["owner"]:
            term = owner
        elif g["att_form"]:
            term = g["att_form"]
            if len(ks) > 1:
                fired["calendar_spelling_wins"] += 1
        else:
            cased = [f for f, _ in g["forms"].most_common() if f != f.lower()]
            term = cased[0] if cased else g["forms"].most_common(1)[0][0]
        if g["kind"] == "term" and is_name(term):
            g["kind"] = "name"
        allk = set(ks) | {f.lower() for f in g["forms"]}
        g["rec_meetings"] = set().union(*(rec.get(k, set()) for k in allk))
        if g["rec_meetings"]:
            fired["recurring_rank_only"] += 1
        srcs = [s for s, on in (("corr", g["corr"]), ("var", nspell >= cfg["variant_min_spellings"]),
                                ("att", g["att_meetings"]), ("owner", g["owner"])) if on]
        score = (cfg["w_corr"] * g["corr"] + cfg["w_var"] * max(0, nspell - 1)
                 + cfg["w_att"] * len(g["att_meetings"]) + cfg["w_rec"] * len(g["rec_meetings"]))
        if len(srcs) >= cfg["agree_min_sources"]:
            score += cfg["w_agree"]
            fired["source_agreement_bonus"] += 1
        meetings = {m for t, m in g["ctx"] if t == "m"} | g["rec_meetings"]
        fcount = Counter(mfolder.get(m, "(none)") for m in meetings)
        real = [f for f in fcount if f != "(none)"]
        if len(real) >= cfg["global_min_folders"]:
            scope = "global"
        elif real:
            scope = folder_name.get(max(real, key=lambda f: fcount[f]), "?")
        else:
            scope = "(no folder)"
        heard = [r for r, _ in g["raw"].most_common() if r and r != term.lower()]
        plaus = {r for r in heard if ratio(nkey(r), nkey(term)) >= cfg["raw_edit_min"]}
        sugg.append({"term": term, "kind": g["kind"], "score": score, "sources": "+".join(srcs),
                     "evidence": {"pairs": g["corr"], "spellings": nspell},
                     "meetings": len(meetings), "folders": len(real), "scope": scope, "heard_as": heard[:4],
                     "variants": sorted((set(ks) | set(g["raw"])) - {term.lower()}), "owner": g["owner"],
                     "_plaus": plaus})

    sugg.sort(key=lambda s: (-s["score"], -s["meetings"], s["term"].lower()))

    # ---- shared raw forms: a plausible heard-as form belongs to the higher-scored term only
    owner_of, kept = {}, []
    for s in sugg:
        hit = next((owner_of[r] for r in s["_plaus"] if r in owner_of), None)
        if hit is not None and not s["owner"] and s["kind"] == hit["kind"]:
            hit["variants"] = sorted(set(hit["variants"]) | {s["term"].lower()} | set(s["variants"]))
            fired["shared_raw_forms"] += 1
            continue
        for r in s["_plaus"]:
            owner_of.setdefault(r, s)
        kept.append(s)
    sugg = kept
    sugg.sort(key=lambda s: (not s["owner"], -s["score"], -s["meetings"], s["term"].lower()))
    for s in sugg:
        s.pop("_plaus", None)

    fired["merge_word_conflict"] += word_blocked[0]
    info = {"owner_source": owner_src, "owner_in_vocab": bool(owner and in_vocab(owner)), "langs": langs,
            "candidates": len(C), "raw_forms": len(rawf), "groups": len(sugg), "rules_fired": dict(fired),
            "device": devinfo, "crosschecks": crosschecks, "name_tokens": name_tokens}
    return sugg, info


def masked_view(sugg, mask, k):
    """v2 masked view, and for a masked person term the variants are masked too."""
    out = v2.masked_view(sugg, mask, k)
    for s, m in zip(sugg[:k], out):
        if m["term"] != s["term"]:
            m["variants"] = [f"({len(s['variants'])} forms masked)"] if s["variants"] else []
    return out


def main():
    t0 = time.time()
    db = sys.argv[sys.argv.index("--db") + 1] if "--db" in sys.argv else DEFAULT_DB
    unmask = "--unmask" in sys.argv
    show = "--show-terms" in sys.argv  # terminal only, never paste or commit
    if unmask and not show:
        raise SystemExit("--unmask needs --show-terms (terminal only, never paste or commit)")
    model, dev = load_model(mps="--mps" in sys.argv)
    sugg, info = run(db, model=model)
    k = CONFIG["top_k"]
    if unmask:
        view = sugg[:k]
    else:
        lp = os.path.join(DATA, "eval_labels.json")
        extra = [h for h, v in json.load(open(lp)).items() if v.get("p")] if os.path.exists(lp) else []
        lp3 = os.path.join(DATA, "eval_labels_v3.json")
        if os.path.exists(lp3):
            extra += [h for h, v in json.load(open(lp3)).items() if v.get("p")]
        mask, _ = v2.make_masker([sugg[:k]], info["name_tokens"], extra)
        view = masked_view(sugg, mask, k)
    print(f"owner from {info['owner_source']}; raw_forms={info['raw_forms']} candidates={info['candidates']} "
          f"groups={info['groups']} device={dev}\nrules fired: {info['rules_fired']}")
    if show:
        print(f"\n{'#':>2} {'term':<24} {'kind':<4} {'score':>6} {'sources':<16} {'pairs':>5} {'spl':>3} {'mtg':>3} variants")
        for i, s in enumerate(view, 1):
            print(f"{i:>2} {s['term']:<24} {s['kind']:<4} {s['score']:>6.1f} {s['sources']:<16} "
                  f"{s['evidence']['pairs']:>5} {s['evidence']['spellings']:>3} {s['meetings']:>3} "
                  f"{', '.join(s['variants'][:3])}")
    else:
        print(f"suggestions {len(view)} (terms hidden; --show-terms prints them)")
    rt = round(time.time() - t0, 1)
    print(f"\nruntime {rt}s, knobs {len(CONFIG)}, rules {len(RULES)}")
    if not unmask:
        out = os.path.join(DATA, "suggestions_v3_full.json")
        json.dump({"note": "full data (TRAIN+TEST) run, for review only; not used for any metric",
                   "db": os.path.basename(db), "config": CONFIG, "n_knobs": len(CONFIG), "rules": RULES,
                   "owner_source": info["owner_source"], "rules_fired": info["rules_fired"],
                   "runtime_s": rt, "device": dev, "top": view},
                  open(out, "w"), indent=1, ensure_ascii=False)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
