"""Offline vocabulary suggestions for Openstyle, v2 (generic method).

The method uses only signals that the app has: text shape, counts, source agreement,
calendar attendees, the owner's profile, two generic resources (wordfreq word frequency,
geonamescache place names) and the local EG2 embedding model. It has no term lists
that come from user data. No LLM judge is part of it.

Run:  <eg2 venv python> -I suggest_v2.py [--db PATH] [--show-terms [--unmask]]
Writes $SILVER_WORK/experiments/vocabmine/suggestions_v2_full.json (masked: person names become "name#N").
--show-terms prints the term list (terminal only, never paste or commit). Default: counts only.
--unmask (needs --show-terms) prints real names to stdout only and writes no file.
"""
import difflib, hashlib, json, os, re, sqlite3, subprocess, sys, time
from collections import Counter, defaultdict

# ============================================================== CONFIG (all knobs)
CONFIG = {
    # candidate sources
    "max_pair_tokens": 3,         # longest replace span (tokens) kept from a correction pair
    "rec_min_meetings": 2,        # recurring term: term-shaped run in >= N meetings
    "att_min_meetings": 2,        # calendar attendee: in >= N meetings
    "cross_min": 2,               # cross-check: a recurring form corrected away >= N times
    "cross_share": 0.5,           #   and in >= this share of its corrections
    # generic filters
    "z_common": 4.0,              # wordfreq Zipf: a token is common at >= this in any app language
    "place_min_pop": 1_000_000,   # geonames cities with population >= N are known places
    "short_max_letters": 2,       # drop terms with <= N letters unless they contain a digit
    "corr_only_min_contexts": 2,  # correction-only term: >= N meetings or dictation rows
    "raw_edit_min": 0.5,          #   or a raw form with edit ratio >= this (also = plausible mishearing)
    # merge
    "merge_edit": 0.85,           # merge if edit ratio >= this
    "merge_cos": 0.90,            # or EG2 cosine >= this
    "merge_cos_edit": 0.75,       #   and edit ratio >= this
    "merge_min_chars": 4,         # never merge when one side has fewer chars (<= 3)
    # score
    "w_corr": 3.0, "w_att": 2.0, "w_rec": 1.0, "w_dict": 0.5,
    "w_agree": 2.0,               # bonus when >= agree_min_sources sources agree
    "agree_min_sources": 2,
    "global_min_folders": 3,      # scope = global when the term is in >= N folders
    "top_k": 40,
}
RULES = (
    "term_shape", "common_word", "place_name", "contraction", "short_term", "in_vocabulary",
    "owner_name_included", "owner_pairs_dropped", "calendar_spelling_wins", "shared_raw_forms",
    "correction_only_gate", "merge_normalized", "merge_edit", "merge_cos_edit", "merge_short_block",
    "names_do_not_merge_with_terms", "cross_check_absorb", "source_agreement_bonus",
)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import silver_paths as P  # noqa: E402
DEFAULT_DB = P.APP_DB
DATA = P.work_dir("experiments", "vocabmine")  # outputs, labels and temp DBs (private, outside the repo)

# ============================================================== text helpers
WORDTOK = re.compile(r"[^\W\d_]+")
CONTRACTION = re.compile(r"^[^\W\d_]+['’](s|m|re|ve|ll|d|t)$", re.I)


def nkey(s):
    """Normalized key: lower case, no spaces, hyphens or dots."""
    return re.sub(r"[\s\-.]+", "", s.lower())


def ratio(a, b):
    return difflib.SequenceMatcher(a=a, b=b, autojunk=False).ratio()


def h12(s):
    return hashlib.sha1(s.lower().encode()).hexdigest()[:12]


def norm(tok):
    return re.sub(r"[^\w'’-]", "", tok.lower()).strip("'’-")


# ============================================================== generic resources
class Lexicon:
    """Common-word frequency (wordfreq) and known places (geonamescache)."""

    def __init__(self, langs, cfg):
        import wordfreq, geonamescache
        self.wf, self.langs, self.z = wordfreq, langs, cfg["z_common"]
        g = geonamescache.GeonamesCache()
        places = set()
        for c in g.get_countries().values():
            places.add(c["name"].lower())
        for c in g.get_continents().values():
            places.add(c["name"].lower())
        for s in g.get_us_states().values():
            places.add(s["name"].lower())
        for c in g.get_cities().values():
            if c.get("population", 0) >= cfg["place_min_pop"]:
                places.add(c["name"].lower())
                places.add(c.get("asciiname", c["name"]).lower())
        self.places = places
        self._cache = {}

    def common(self, tok):
        t = tok.lower().strip("'’-.,")
        if t not in self._cache:
            self._cache[t] = max(self.wf.zipf_frequency(t, l) for l in self.langs) >= self.z
        return self._cache[t]

    def is_place(self, term):
        return term.lower() in self.places


def term_token(t, lex):
    """Generic term shape: digit+letter, acronym, inner capital, or a capitalized uncommon word."""
    t = t.strip("'’-.,")
    if not t or CONTRACTION.match(t):
        return False
    if any(c.isdigit() for c in t) and any(c.isalpha() for c in t):
        return True
    if len(t) >= 2 and t.isupper():
        return True
    if t[:1].islower() and any(c.isupper() for c in t[1:]):
        return True
    return t[:1].isupper() and not lex.common(t)


# ============================================================== app port: extractFolderTerms
# NOT_TERMS and STARTERS mirror apps/server/src/lib/meetings/workflow/folder-memory.ts (app code).
NOT_TERMS = set("i i'm i've i'll i'd ok okay yeah yes no mr mrs ms dr monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december segunda terça quarta quinta sexta sábado domingo janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split())
STARTERS = set("a an the this that these those then and but so or if when also we you he she they it our my your their in on at for with from to after before o os as um uma e mas então nós eu ele ela eles no na em para com".split())
WORD = re.compile(r"[^\W\d_][\w'’-]*")
SPLIT = re.compile(r"[.!?…:;]+\s+|\n+|\s[-*•]\s")


def _is_term_word(w, start):
    if w.lower() in NOT_TERMS:
        return False
    if w[:1].islower() and any(c.isupper() for c in w[1:]):
        return True
    if len(w) >= 2 and not any(c.islower() for c in w):
        return True
    return (not start) and w[:1].isupper()


def extract_terms(texts):
    counts, order = {}, [0]

    def add(words):
        for i in range(0, len(words), 3):
            term = " ".join(words[i:i + 3])
            if len(term) >= 2:
                counts.setdefault(term.lower(), [term, 0, order[0]])[1] += 1
                order[0] += 1

    for text in texts:
        for sent in SPLIT.split(text):
            run, words = [], WORD.findall(sent)
            for i, w in enumerate(words):
                ns = (i == 0 and w[:1].isupper() and w.lower() not in STARTERS and w.lower() not in NOT_TERMS
                      and len(words) > 1 and _is_term_word(words[1], False))
                if ns or _is_term_word(w, i == 0):
                    run.append(w)
                else:
                    if run:
                        add(run)
                    run = []
            if run:
                add(run)
    return counts.values()


# ============================================================== owner profile
def owner_name(con):
    """The owner's name the way the app can get it: signed-in session, settings, then macOS account."""
    try:
        r = con.execute("select name from sessions where name is not null and trim(name) != '' "
                        "order by updated_at desc limit 1").fetchone()
        if r:
            return r[0].strip(), "sessions.name"
    except sqlite3.Error:
        pass
    for key in ("user_name", "owner_name", "profile_name", "display_name", "name"):
        r = con.execute("select value from settings where key = ?", (key,)).fetchone()
        if r and r[0].strip():
            return r[0].strip(), f"settings.{key}"
    try:
        n = subprocess.run(["id", "-F"], capture_output=True, text=True, timeout=5).stdout.strip()
        if n:
            return n, "id -F"
    except Exception:
        pass
    return None, "none"


# ============================================================== pipeline
def load_model():
    import torch
    from sentence_transformers import SentenceTransformer
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.bfloat16 if dev == "mps" else torch.float32   # never fp16
    m = SentenceTransformer("google/embeddinggemma-2", device=dev, model_kwargs={"torch_dtype": dtype},
                            config_kwargs={"vision_config": None})
    return m, f"{dev}/{dtype}"


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
    lex = Lexicon(langs, cfg)

    vocab_rows = [r[0].strip() for r in con.execute("select term from vocabulary")]
    VOCAB = {v.lower() for v in vocab_rows} | {nkey(v) for v in vocab_rows}

    def in_vocab(t):
        k = nkey(t)
        return t.lower() in VOCAB or k in VOCAB or (k.endswith("s") and k[:-1] in VOCAB)

    owner, owner_src = owner_name(con)
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
            n = (a.get("name") or "").strip() if isinstance(a, dict) else ""
            if not n or "@" in n:
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

    # ---- generic shape and filters
    def tok_shaped(t):
        return term_token(t, lex)

    def trim_span(span):
        toks = span.split()
        idx = [i for i, t in enumerate(toks) if tok_shaped(t)]
        if not idx:
            return None
        return " ".join(t.strip(".,!?;:\"()") for t in toks[idx[0]:idx[-1] + 1])

    def reject(term):
        """Generic filter. Returns the rule name that rejects the term, else None."""
        letters = sum(c.isalpha() for c in term)
        if letters <= cfg["short_max_letters"] and not any(c.isdigit() for c in term):
            return "short_term"
        toks = term.split()
        if any(CONTRACTION.match(t.strip("'’-.,")) for t in toks):
            return "contraction"
        if lex.is_place(term):
            return "place_name"
        if all(lex.common(t) and not any(c.isdigit() for c in t) for t in toks):
            return "common_word"
        return None

    def pairs(raw, enh):
        rt = [t for t in raw.split() if norm(t)]
        et = [t for t in enh.split() if norm(t)]
        rn, en = [norm(t) for t in rt], [norm(t) for t in et]
        out = []
        mx = cfg["max_pair_tokens"]
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=rn, b=en, autojunk=False).get_opcodes():
            if op != "replace" or "".join(rn[i1:i2]) == "".join(en[j1:j2]):
                continue
            if i2 - i1 > mx or j2 - j1 > mx:
                continue
            out.append((" ".join(t.strip(".,!?;:\"()") for t in rt[i1:i2]).lower(),
                        " ".join(t.strip(".,!?;:\"()") for t in et[j1:j2])))
        return out

    def owner_raw(r):
        return owner_l is not None and (r == owner_l or r in owner_toks)

    mfolder = {m: (f or "(none)") for m, f in con.execute("select id, folder_id from meetings")}
    folder_name = dict(con.execute("select id, name from meeting_folders"))

    def new_cand():
        return {"forms": Counter(), "corr": 0, "ctx": set(), "raw": Counter(), "rec_meetings": set(),
                "att_meetings": set(), "dict": 0, "dict_raw": Counter(), "kind": "term",
                "att_form": None, "owner": False}

    C = defaultdict(new_cand)
    raw_to_enh = defaultdict(Counter)

    # ---- source 1: meeting correction pairs (raw text -> enhanced text)
    for mid, raw, enh in con.execute("select meeting_id, text, enhanced_text from meeting_segments "
                                     "where enhanced_text is not null"):
        if not raw or raw == enh:
            continue
        for r, e in pairs(raw, enh):
            if owner_raw(r):
                fired["owner_pairs_dropped"] += 1
                continue
            term = trim_span(e)
            if not term:
                continue
            raw_to_enh[r][term] += 1
            why = reject(term)
            if why:
                fired[why] += 1
                continue
            c = C[term.lower()]
            c["forms"][term] += 3
            c["corr"] += 1
            c["ctx"].add(("m", mid))
            c["raw"][r] += 1

    # ---- source 2: recurring term-shaped runs (app port), >= rec_min_meetings meetings
    mtexts = defaultdict(list)
    for mid, txt in con.execute("select meeting_id, coalesce(enhanced_text, text) from meeting_segments "
                                "order by meeting_id, idx"):
        if txt:
            mtexts[mid].append(txt)
    rec = defaultdict(lambda: {"m": set(), "forms": Counter()})
    for mid, texts in mtexts.items():
        for term, n, _ in extract_terms(texts):
            if all(tok_shaped(t) for t in term.split()):
                rec[term.lower()]["m"].add(mid)
                rec[term.lower()]["forms"][term] += n
    for k, r in rec.items():
        if len(r["m"]) < cfg["rec_min_meetings"]:
            continue
        why = reject(r["forms"].most_common(1)[0][0])
        if why:
            fired[why] += 1
            continue
        c = C[k]
        c["forms"].update(r["forms"])
        c["rec_meetings"] |= r["m"]
        c["ctx"] |= {("m", m) for m in r["m"]}

    # ---- source 3: calendar attendees in >= att_min_meetings meetings
    for n, ms in attendee_meetings.items():
        if len(ms) >= cfg["att_min_meetings"]:
            c = C[n]
            form = attendee_forms[n].most_common(1)[0][0]
            c["forms"][form] += 10
            c["att_form"] = form
            c["att_meetings"] |= ms
            c["ctx"] |= {("m", m) for m in ms}
            c["kind"] = "name"

    # ---- source 4: owner name (always, if not in vocabulary)
    if owner and not in_vocab(owner):
        c = C[owner_l]
        c["forms"][owner] += 10
        c["owner"] = True
        c["kind"] = "name"
        fired["owner_name_included"] += 1

    # ---- cross-check: a recurring form that the LLM corrects away moves to its corrected term
    crosschecks = []
    for k in list(C):
        c = C[k]
        if c["kind"] == "name" or k not in raw_to_enh:
            continue
        fixes = raw_to_enh[k]
        tgt, n = fixes.most_common(1)[0]
        if (tgt.lower() == k or n < cfg["cross_min"] or n < cfg["cross_share"] * sum(fixes.values())
                or n <= c["corr"] or reject(tgt)):
            continue
        t = C[tgt.lower()]
        t["forms"][tgt] += 1
        t["rec_meetings"] |= c["rec_meetings"]
        t["ctx"] |= c["ctx"]
        t["corr"] += c["corr"]
        t["raw"].update(c["raw"])
        t["raw"][k] += n
        crosschecks.append((k, tgt))
        fired["cross_check_absorb"] += 1
        del C[k]

    # ---- drop vocabulary terms
    for k in list(C):
        if in_vocab(k) or any(in_vocab(f) for f in C[k]["forms"]):
            fired["in_vocabulary"] += 1
            del C[k]

    # ---- dictation correction pairs (confirming only)
    for _id, raw, cl in con.execute("select id, raw_text, cleaned_text from transcription_history "
                                    "where cleaned_text is not null"):
        if not raw or raw == cl:
            continue
        for r, e in pairs(raw, cl):
            if owner_raw(r):
                fired["owner_pairs_dropped"] += 1
                continue
            term = trim_span(e)
            if term and term.lower() in C:
                c = C[term.lower()]
                c["dict"] += 1
                c["dict_raw"][r] += 1
                c["ctx"].add(("d", _id))

    # ---- correction-only gate
    for k in list(C):
        c = C[k]
        if c["kind"] == "name" or c["rec_meetings"] or c["att_meetings"]:
            continue
        if len(c["ctx"]) >= cfg["corr_only_min_contexts"]:
            continue
        if any(ratio(nkey(r), nkey(k)) >= cfg["raw_edit_min"] for r in c["raw"] if r):
            continue
        fired["correction_only_gate"] += 1
        del C[k]

    # ---- merge variants
    keys = sorted(C)
    parent = {k: k for k in keys}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    if model is None:
        model, devinfo = load_model()
    else:
        devinfo = "shared"
    disp0 = [C[k]["forms"].most_common(1)[0][0] for k in keys]
    if keys:
        E = model.encode(disp0, prompt_name="document", convert_to_numpy=True, batch_size=32).astype(np.float32)
        E /= np.linalg.norm(E, axis=1, keepdims=True)
        S = E @ E.T
    merge_log = []
    nk = [nkey(k) for k in keys]
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = keys[i], keys[j]
            if (C[a]["kind"] == "name") != (C[b]["kind"] == "name"):
                continue
            ka, kb = nk[i], nk[j]
            same = ka == kb or ka.rstrip("s") == kb.rstrip("s")
            r = ratio(ka, kb)
            why = None
            if same:
                why = "merge_normalized"
            elif r >= cfg["merge_edit"]:
                why = "merge_edit"
            elif r >= cfg["merge_cos_edit"] and S[i, j] >= cfg["merge_cos"]:
                why = "merge_cos_edit"
            if not why:
                continue
            if min(len(ka), len(kb)) < cfg["merge_min_chars"]:
                fired["merge_short_block"] += 1
                continue
            if find(a) != find(b):
                parent[find(b)] = find(a)
                merge_log.append((a, b, why))
                fired[why] += 1

    groups = defaultdict(list)
    for k in keys:
        groups[find(k)].append(k)

    # ---- build groups, canonical form, score
    sugg = []
    for root, ks in groups.items():
        g = new_cand()
        for k in ks:
            c = C[k]
            for f in ("forms", "raw", "dict_raw"):
                g[f].update(c[f])
            for f in ("ctx", "rec_meetings", "att_meetings"):
                g[f] |= c[f]
            g["corr"] += c["corr"]
            g["dict"] += c["dict"]
            g["owner"] |= c["owner"]
            g["att_form"] = g["att_form"] or c["att_form"]
            if c["kind"] == "name":
                g["kind"] = "name"
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
        srcs = [s for s, on in (("corr", g["corr"]), ("att", g["att_meetings"]), ("rec", g["rec_meetings"]),
                                ("dict", g["dict"]), ("owner", g["owner"])) if on]
        score = (cfg["w_corr"] * g["corr"] + cfg["w_att"] * len(g["att_meetings"])
                 + cfg["w_rec"] * len(g["rec_meetings"]) + cfg["w_dict"] * g["dict"])
        if len(srcs) >= cfg["agree_min_sources"]:
            score += cfg["w_agree"]
            fired["source_agreement_bonus"] += 1
        meetings = {m for t, m in g["ctx"] if t == "m"}
        fcount = Counter(mfolder.get(m, "(none)") for m in meetings)
        real = [f for f in fcount if f != "(none)"]
        if len(real) >= cfg["global_min_folders"]:
            scope = "global"
        elif real:
            scope = folder_name.get(max(real, key=lambda f: fcount[f]), "?")
        else:
            scope = "(no folder)"
        raws = (g["raw"] + g["dict_raw"])
        heard = [r for r, _ in raws.most_common() if r and r != term.lower()]
        plaus = {r for r in heard if ratio(nkey(r), nkey(term)) >= cfg["raw_edit_min"]}
        sugg.append({"term": term, "kind": g["kind"], "score": score, "sources": "+".join(srcs),
                     "meetings": len(meetings), "folders": len(real), "scope": scope, "heard_as": heard[:4],
                     "variants": sorted(set(ks) - {term.lower()}), "owner": g["owner"], "_plaus": plaus})

    sugg.sort(key=lambda s: (-s["score"], -s["meetings"], s["term"].lower()))

    # ---- shared raw forms: a plausible heard-as form belongs to the higher-scored term only
    owner_of, kept = {}, []
    for s in sugg:
        hit = next((owner_of[r] for r in s["_plaus"] if r in owner_of), None)
        if hit is not None and not s["owner"]:
            hit["variants"] = sorted(set(hit["variants"]) | {s["term"].lower()} | set(s["variants"]))
            fired["shared_raw_forms"] += 1
            continue
        for r in s["_plaus"]:
            owner_of.setdefault(r, s)
        kept.append(s)
    sugg = kept

    # ---- owner always included: pin to rank 1
    sugg.sort(key=lambda s: (not s["owner"], -s["score"], -s["meetings"], s["term"].lower()))
    for s in sugg:
        s.pop("_plaus", None)

    info = {"owner_source": owner_src, "owner_in_vocab": bool(owner and in_vocab(owner)), "langs": langs,
            "candidates": len(C), "groups": len(sugg), "rules_fired": dict(fired), "device": devinfo,
            "merges": merge_log, "crosschecks": crosschecks, "name_tokens": name_tokens}
    return sugg, info


# ============================================================== masking
def make_masker(sugg_lists, name_tokens, extra_person_hashes=()):
    """Person names become name#N (numbered by hash, stable across lists)."""
    extra = set(extra_person_hashes)

    def person(t):
        toks = [x.lower() for x in WORDTOK.findall(t)]
        return h12(t) in extra or (bool(toks) and any(x in name_tokens or h12(x) in extra for x in toks))

    names = set()
    for lst in sugg_lists:
        for s in lst:
            if s.get("kind") == "name" or person(s["term"]):
                names.add(s["term"].lower())
    ids = {n: f"name#{i}" for i, n in enumerate(sorted(names, key=h12), 1)}

    def mask(t):
        if t.lower() in ids:
            return ids[t.lower()]
        return "(name)" if person(t) else t
    return mask, ids


def masked_view(sugg, mask, k):
    out = []
    for s in sugg[:k]:
        s2 = dict(s)
        s2["term"] = mask(s["term"])
        isname = s2["term"] != s["term"]
        s2["heard_as"] = [f"({len(s['heard_as'])} forms masked)"] if isname and s["heard_as"] else \
            [mask(h) for h in s["heard_as"]]
        s2["variants"] = [mask(v) for v in s["variants"]]
        s2["scope"] = "(masked)" if mask(s["scope"]) != s["scope"] else s["scope"]
        out.append(s2)
    return out


def main():
    t0 = time.time()
    db = sys.argv[sys.argv.index("--db") + 1] if "--db" in sys.argv else DEFAULT_DB
    unmask = "--unmask" in sys.argv
    show = "--show-terms" in sys.argv  # terminal only, never paste or commit
    if unmask and not show:
        raise SystemExit("--unmask needs --show-terms (terminal only, never paste or commit)")
    sugg, info = run(db)
    k = CONFIG["top_k"]
    if unmask:
        view = sugg[:k]
    else:
        # Evaluator person flags (eval_labels.json) are used for masking only, never for ranking.
        lp = os.path.join(DATA, "eval_labels.json")
        extra = [h for h, v in json.load(open(lp)).items() if v.get("p")] if os.path.exists(lp) else []
        mask, _ = make_masker([sugg[:k]], info["name_tokens"], extra)
        view = masked_view(sugg, mask, k)
    print(f"owner from {info['owner_source']}; candidates={info['candidates']} groups={info['groups']} "
          f"device={info['device']}\nrules fired: {info['rules_fired']}")
    if show:
        print(f"\n{'#':>2} {'term':<24} {'kind':<4} {'score':>6} {'sources':<20} {'mtg':>3} {'scope':<18} variants")
        for i, s in enumerate(view, 1):
            print(f"{i:>2} {s['term']:<24} {s['kind']:<4} {s['score']:>6.1f} {s['sources']:<20} {s['meetings']:>3} "
                  f"{s['scope'][:18]:<18} {', '.join(s['variants'][:3])}")
    else:
        print(f"suggestions {len(view)} (terms hidden; --show-terms prints them)")
    rt = round(time.time() - t0, 1)
    print(f"\nruntime {rt}s")
    if not unmask:
        out = os.path.join(DATA, "suggestions_v2_full.json")
        json.dump({"note": "full data (TRAIN+TEST) run, for review only; not used for any metric",
                   "config": CONFIG, "rules": RULES, "owner_source": info["owner_source"],
                   "rules_fired": info["rules_fired"], "runtime_s": rt, "top": view},
                  open(out, "w"), indent=1, ensure_ascii=False)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
