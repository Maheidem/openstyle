"""Tests of validate_silver2.key_errors with fictional keys (silver-3.4 ear-check fields).

Run: python3 -I scripts/meeting-v2/eval/silver/vote/test_validate_silver.py   (part of pnpm meeting:silver:test)
"""
import copy, os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate_silver2 as V  # noqa: E402

SRC = "ear-check:b1:2026-10-29"


def key(kind="silver-3.4", **span):
    s = {"channel": "mic", "startMs": 1000, "endMs": 2000, "text": "Zorblax", "label": "product",
         "in_vocab": True, "confidence": "high", "witnesses": ["h1", "h2"]}
    s.update(span)
    return {
        "format": "openstyle-gold", "goldVersion": 3, "goldKind": kind, "meeting": "abcd1234",
        "meetingId": "abcd1234-0000", "id8": "abcd1234", "asrHash": None, "builtAt": "2026-10-29T00:00:00Z",
        "verifiedSpans": 0, "timeToleranceMs": 2000,
        "witnesses": {"h1": {"engine": "one"}, "h2": {"engine": "two"}, "h3": {"engine": "three"}},
        "transcript": {"mic": [{"startMs": 0, "endMs": 4000, "text": "We tried Zorblax.", "verified": False,
                                "basis": ["h1", "h3"], "wer_eligible": True}], "system": []},
        "spans": [s],
        "verification": {"sampled": 1, "agree_text": 1, "agree_conf": None, "conflicts_marked_unsure": 0, "method": "x"},
        "fixes": [], "mustNotChange": [], "summary": None, "tags": None, "speakers": None,
    }


def errs(g, kind="silver-3.4"):
    return V.key_errors(g, "abcd1234", kind)


class EarCheck(unittest.TestCase):
    def test_valid_keys_pass(self):
        self.assertEqual(errs(key()), [])
        self.assertEqual(errs(key(verified=True, verified_source=SRC)), [])
        self.assertEqual(errs(key(verified=True, verified_source=SRC, verified_text="Zorblacks")), [])
        self.assertEqual(errs(key(verified_unsure=True, verified_source=SRC, confidence="unsure")), [])
        # A verified span may keep alt_text and stay high.
        self.assertEqual(errs(key(verified=True, verified_source=SRC, alt_text="Zorblocks")), [])

    def test_planted_faults(self):
        cases = {
            "verified or verified_unsure without verified_source": key(verified=True),
            "verified_source without verified or verified_unsure": key(verified_source=SRC),
            "verified and verified_unsure together": key(verified=True, verified_unsure=True, verified_source=SRC),
            "verified_text without verified, or equal to text": key(verified=True, verified_source=SRC, verified_text="Zorblax"),
        }
        for want, g in cases.items():
            with self.subTest(want=want):
                self.assertIn(f"spans/0: {want}", errs(g))
        self.assertIn("spans/0: verified_text without verified, or equal to text", errs(key(verified_text="Other")))

    def test_schema_types(self):
        self.assertTrue(any(e.startswith("spans/0/verified:") for e in errs(key(verified=False, verified_source=SRC))))
        self.assertTrue(any(e.startswith("spans/0/verified_source:") for e in errs(key(verified=True, verified_source=""))))
        self.assertTrue(any(e.startswith("spans/0:") and "additionalProperties" in e for e in errs(key(verfied=True))))

    def test_errors_never_hold_the_value(self):
        g = key(verified=True, verified_source=SRC, verified_text="Zorblax")
        self.assertFalse(any("Zorblax" in e or SRC in e for e in errs(g)))

    def test_older_kinds_refuse_ear_fields(self):
        g = key(kind="silver-3.3", verified=True, verified_source=SRC)
        self.assertIn("spans/0: ear-check fields in a silver-3.3 key", errs(g, "silver-3.3"))
        self.assertEqual(errs(key(kind="silver-3.3"), "silver-3.3"), [])
        # silver-3.4 under --kind silver-3.3 fails on goldKind.
        self.assertTrue(any(e.startswith("goldKind:") for e in errs(key(), "silver-3.3")))

    def test_alt_text_rule_by_kind(self):
        self.assertIn("spans/0: alt_text but not unsure", errs(key(kind="silver-3", alt_text="Zorblocks"), "silver-3"))
        self.assertEqual(errs(key(alt_text="Zorblocks")), [])

    def test_input_not_changed(self):
        g = key(verified=True, verified_source=SRC)
        before = copy.deepcopy(g)
        errs(g)
        self.assertEqual(g, before)


if __name__ == "__main__":
    unittest.main()
