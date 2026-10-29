"""JSON-schema check of the 14 silver keys (goldVersion 3; goldKind silver-2, silver-3, silver-3.1, silver-3.2 or silver-3.3). Prints ids and error paths only.

Run: python3 -I validate_silver2.py [--kind silver-3.3] [--suffix .silver-2]   (pnpm meeting:silver:validate --kind silver-3.3)
Needs the jsonschema package. Paths: silver_paths.py (SILVER_KEYS, SILVER_MEETINGS).
"""
import json, os, sys
import jsonschema
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silver_paths as P  # noqa: E402

KEYS = P.KEYS
IDS = P.meeting_ids()
MS = {"type": "integer", "minimum": 0}
IND = ["h1", "h3", "parakeet", "openai", "gemini", "meet", "krisp"]
KIND = sys.argv[sys.argv.index("--kind") + 1] if "--kind" in sys.argv else "silver-3"
SUF = sys.argv[sys.argv.index("--suffix") + 1] if "--suffix" in sys.argv else ""
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
                       "verifier_conflict": {"const": True}, "alt_text": {"type": "string", "minLength": 1}}}
NN = {"type": ["integer", "null"], "minimum": 0}
SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["format", "goldVersion", "goldKind", "meeting", "meetingId", "id8", "witnesses", "transcript", "spans", "verification",
                 "verifiedSpans", "timeToleranceMs", "fixes", "mustNotChange", "summary", "tags", "speakers", "asrHash", "builtAt"],
    "properties": {
        "format": {"const": "openstyle-gold"}, "goldVersion": {"const": 3}, "goldKind": {"const": KIND},
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
jsonschema.Draft202012Validator.check_schema(SCHEMA)
V = jsonschema.Draft202012Validator(SCHEMA)
bad = 0
for m in IDS:
    g = json.load(open(f"{KEYS}/{m}{SUF}.json", encoding="utf-8"))
    errs = [("/".join(map(str, e.absolute_path)) or "<root>") + ": " + e.validator for e in V.iter_errors(g)]
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
        # silver-3.1, silver-3.2 and silver-3.3 (same rule): a list spelling with a sound-alike alt_text may stay high/medium (it keeps alt_text).
        if s.get("alt_text") and s["confidence"] != "unsure" and KIND not in ("silver-3.1", "silver-3.2", "silver-3.3"):
            errs.append(f"spans/{i}: alt_text but not unsure")
        if s.get("verifier_conflict") and s["confidence"] != "unsure":
            errs.append(f"spans/{i}: verifier_conflict but not unsure")
        for w in s["witnesses"]:
            if w not in ("app",) and w not in g["witnesses"]:
                errs.append(f"spans/{i}: witness {w} not in the witness block")
    bad += bool(errs)
    print(m, "OK" if not errs else f"FAIL ({len(errs)}): " + "; ".join(errs[:5]))
print(f"schema check ({KIND}{SUF}): {len(IDS) - bad}/{len(IDS)} pass")
sys.exit(1 if bad else 0)
