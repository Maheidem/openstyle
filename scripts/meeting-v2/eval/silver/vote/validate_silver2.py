"""JSON-schema check of the 14 silver keys (goldVersion 3; goldKind silver-2, silver-3, silver-3.1, silver-3.2, silver-3.3, silver-3.4, silver-3.5 or silver-3.6). Prints ids and error paths only.

Run: python3 -I validate_silver2.py [--kind silver-3.4] [--suffix .silver-2]   (pnpm meeting:silver:validate --kind silver-3.4)
Needs the jsonschema package. Paths: silver_paths.py (SILVER_KEYS, SILVER_MEETINGS).
silver-3.4 adds the owner's ear check on a span: verified, verified_source, verified_text, verified_unsure.
silver-3.5 and silver-3.6 add verified_none: the owner hears no named entity at this place.
Tests: test_validate_silver.py (fictional keys).
"""
import json, os, re, sys
import jsonschema
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

MS = {"type": "integer", "minimum": 0}
IND = ["h1", "h3", "parakeet", "openai", "gemini", "meet", "krisp"]
CLOUD = {"type": "object", "required": ["engine", "time_basis", "time_quality"], "additionalProperties": False,
         "properties": {"engine": {"type": "string", "minLength": 1}, "time_basis": {"type": "string", "minLength": 1},
                        "time_quality": {"enum": ["good", "coarse", "bad"]}}}
ENG = {"type": "object", "required": ["engine"], "properties": {"engine": {"type": "string", "minLength": 1}}, "additionalProperties": False}
EXT = {"type": "object", "required": ["source", "time_basis", "time_quality"], "additionalProperties": False,
       "properties": {"source": {"type": "string", "minLength": 1}, "time_basis": {"type": "string", "minLength": 1},
                      "time_quality": {"enum": ["good", "coarse", "bad"]}}}
TURN = {"type": "object", "additionalProperties": False, "required": ["startMs", "endMs", "text", "verified", "basis", "wer_eligible"],
        "properties": {"startMs": MS, "endMs": MS, "text": {"type": "string"}, "verified": {"const": False},
                       "basis": {"type": "array", "items": {"enum": IND}, "uniqueItems": True}, "wer_eligible": {"type": "boolean"}}}
SPAN = {"type": "object", "additionalProperties": False,
        "required": ["channel", "startMs", "endMs", "text", "label", "in_vocab", "confidence", "witnesses"],
        "properties": {"channel": {"enum": ["mic", "system"]}, "startMs": MS, "endMs": MS, "text": {"type": "string", "minLength": 1},
                       "label": {"enum": ["term", "product", "person", "org", "place", "other"]}, "in_vocab": {"type": "boolean"},
                       "confidence": {"enum": ["high", "medium", "unsure"]},
                       "witnesses": {"type": "array", "items": {"enum": ["h1", "h2", "h3", "app", "parakeet", "openai", "gemini", "meet", "krisp"]}, "uniqueItems": True},
                       "verifier_conflict": {"const": True}, "alt_text": {"type": "string", "minLength": 1},
                       "verified": {"const": True}, "verified_source": {"type": "string", "minLength": 1},
                       "verified_text": {"type": "string", "minLength": 1}, "verified_unsure": {"const": True},
                       "verified_none": {"const": True}}}
NN = {"type": ["integer", "null"], "minimum": 0}


def schema(kind):
    return {
    "type": "object", "additionalProperties": False,
    "required": ["format", "goldVersion", "goldKind", "meeting", "meetingId", "id8", "witnesses", "transcript", "spans", "verification",
                 "verifiedSpans", "timeToleranceMs", "fixes", "mustNotChange", "summary", "tags", "speakers", "asrHash", "builtAt"],
    "properties": {
        "format": {"const": "openstyle-gold"}, "goldVersion": {"const": 3}, "goldKind": {"const": kind},
        "meeting": {"type": "string", "pattern": "^[0-9a-f]{8}$"}, "id8": {"type": "string", "pattern": "^[0-9a-f]{8}$"},
        "meetingId": {"type": "string", "minLength": 9}, "asrHash": {"type": ["string", "null"]}, "builtAt": {"type": "string"},
        "verifiedSpans": MS, "timeToleranceMs": MS,
        "witnesses": {"type": "object", "additionalProperties": False, "required": ["h1", "h2", "h3"],
                      "properties": {"h1": ENG, "h2": ENG, "h3": ENG, "parakeet": ENG, "openai": CLOUD, "gemini": CLOUD, "meet": EXT, "krisp": EXT}},
        "transcript": {"type": "object", "additionalProperties": False, "required": ["mic", "system"],
                       "properties": {"mic": {"type": "array", "items": TURN}, "system": {"type": "array", "items": TURN}}},
        "spans": {"type": "array", "items": SPAN},
        "verification": {"type": "object", "additionalProperties": False,
                         "required": ["sampled", "agree_text", "agree_conf", "conflicts_marked_unsure", "method"],
                         "properties": {"sampled": MS, "agree_text": MS, "agree_conf": NN, "conflicts_marked_unsure": MS, "method": {"type": "string"}}},
        "fixes": {"type": "array"}, "mustNotChange": {"type": "array"},
        "summary": {"type": ["object", "null"]}, "tags": {"type": ["object", "null"]}, "speakers": {"type": ["object", "null"]},
    },
}


# The kinds where a list spelling with a sound-alike alt_text may stay high/medium (it keeps alt_text).
ALT_TEXT_KEEP = ("silver-3.1", "silver-3.2", "silver-3.3", "silver-3.4", "silver-3.5", "silver-3.6")
# The kinds that carry the ear check. A verified span may keep verifier_conflict and alt_text there:
# the ear check wins and the flag stays as history.
EAR_KINDS = ("silver-3.4", "silver-3.5", "silver-3.6")
# verified_none (no named entity here) starts with silver-3.5.
NONE_KINDS = ("silver-3.5", "silver-3.6")


def key_errors(g, m, kind, validator=None):
    """The error paths of one key (no text). m = the id8 of the file name."""
    v = validator or jsonschema.Draft202012Validator(schema(kind))
    errs = [("/".join(map(str, e.absolute_path)) or "<root>") + ": " + e.validator for e in v.iter_errors(g)]
    if errs:
        return errs
    # cross-field rules the schema cannot say
    if g.get("meeting") != m or g.get("id8") != m or not str(g.get("meetingId", "")).startswith(m):
        errs.append("meeting/id8/meetingId: do not match the file name")
    for ch in ("mic", "system"):
        for i, t in enumerate(g["transcript"][ch]):
            if any(b not in g["witnesses"] for b in t["basis"]):
                errs.append(f"transcript/{ch}/{i}: basis witness not in the witness block")
            if t["endMs"] < t["startMs"]:
                errs.append(f"transcript/{ch}/{i}: endMs < startMs")
            want = len(t["basis"]) >= 2 and any(b != "h1" for b in t["basis"])
            if t["wer_eligible"] != want:
                errs.append(f"transcript/{ch}/{i}: wer_eligible does not follow basis")
    for i, s in enumerate(g["spans"]):
        if s["endMs"] < s["startMs"]:
            errs.append(f"spans/{i}: endMs < startMs")
        if s.get("alt_text") and s["confidence"] != "unsure" and kind not in ALT_TEXT_KEEP:
            errs.append(f"spans/{i}: alt_text but not unsure")
        if s.get("verifier_conflict") and s["confidence"] != "unsure" and not (s.get("verified") and kind in EAR_KINDS):
            errs.append(f"spans/{i}: verifier_conflict but not unsure")
        for w in s["witnesses"]:
            if w not in ("app",) and w not in g["witnesses"]:
                errs.append(f"spans/{i}: witness {w} not in the witness block")
        # The ear check (silver-3.4). The errors name the field, never its value.
        ear = [k for k in ("verified", "verified_source", "verified_text", "verified_unsure", "verified_none") if k in s]
        if ear and kind not in EAR_KINDS:
            errs.append(f"spans/{i}: ear-check fields in a {kind} key")
        if "verified_none" in s and kind not in NONE_KINDS and kind in EAR_KINDS:
            errs.append(f"spans/{i}: verified_none in a {kind} key")
        flags = [k for k in ("verified", "verified_unsure", "verified_none") if s.get(k)]
        if flags and not s.get("verified_source"):
            errs.append(f"spans/{i}: verified, verified_unsure or verified_none without verified_source")
        if s.get("verified_source") and not flags:
            errs.append(f"spans/{i}: verified_source without verified, verified_unsure or verified_none")
        if len(flags) > 1:
            errs.append(f"spans/{i}: more than one of verified, verified_unsure, verified_none")
        if "verified_text" in s and (not s.get("verified") or s["verified_text"] == s["text"]):
            errs.append(f"spans/{i}: verified_text without verified, or equal to text")
    return errs


def main():
    import silver_paths as P
    kind = sys.argv[sys.argv.index("--kind") + 1] if "--kind" in sys.argv else "silver-3"
    suf = sys.argv[sys.argv.index("--suffix") + 1] if "--suffix" in sys.argv else ""
    sch = schema(kind)
    jsonschema.Draft202012Validator.check_schema(sch)
    v = jsonschema.Draft202012Validator(sch)
    # No witness corpus on this Mac: take the ids from the key files.
    if not os.environ.get("SILVER_MEETINGS") and not os.path.isdir(P.CORPUS):
        ids = sorted(f[:-5] for f in os.listdir(P.KEYS) if re.fullmatch(r"[0-9a-f]{8}\.json", f))
    else:
        ids = P.meeting_ids()
    bad = 0
    for m in ids:
        g = json.load(open(f"{P.KEYS}/{m}{suf}.json", encoding="utf-8"))
        errs = key_errors(g, m, kind, v)
        bad += bool(errs)
        print(m, "OK" if not errs else f"FAIL ({len(errs)}): " + "; ".join(errs[:5]))
    print(f"schema check ({kind}{suf}): {len(ids) - bad}/{len(ids)} pass")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
