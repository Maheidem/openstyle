#!/usr/bin/env python3
"""Smoke tests of the silver-gold pipeline: path rules and a compile check of every script.

Run: python3 -I scripts/meeting-v2/eval/silver/test_silver_paths.py   (pnpm meeting:silver:test)
No model, no GPU, no private data.
"""
import importlib.util
import os
import py_compile
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
ENV_KEYS = ("SILVER_CORPUS", "SILVER_KEYS", "SILVER_WORK", "SILVER_MEETINGS", "SILVER_ENRICHED_DB",
            "OPENSTYLE_PROFILE", "OPENSTYLE_EVAL_HF_HOME")


def load(env):
    """Import a fresh silver_paths with this env (the module reads the env at import)."""
    clean = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
    with mock.patch.dict(os.environ, {**clean, **env}, clear=True):
        spec = importlib.util.spec_from_file_location("silver_paths_t", os.path.join(HERE, "silver_paths.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod


class PathTests(unittest.TestCase):
    def test_defaults_are_outside_the_repo(self):
        P = load({})
        self.assertEqual(P.REPO, REPO)
        for p in (P.CORPUS, P.KEYS, P.WORK, P.PROFILE, P.HF_HOME, P.ENRICHED_DB):
            self.assertFalse(p.startswith(REPO + os.sep), p)
        self.assertTrue(P.KEYS.endswith(os.path.join(".openstyle-eval", "gold-silver")))

    def test_env_override(self):
        with tempfile.TemporaryDirectory() as d:
            P = load({"SILVER_CORPUS": d, "SILVER_WORK": os.path.join(d, "w")})
            self.assertEqual(P.CORPUS, d)
            w = P.work_dir("cloud", "raw")
            self.assertTrue(os.path.isdir(w))
            self.assertEqual(oct(os.stat(w).st_mode & 0o777), "0o700")

    def test_a_path_in_the_repo_is_refused(self):
        for key in ("SILVER_CORPUS", "SILVER_KEYS", "SILVER_WORK"):
            with self.assertRaises(SystemExit):
                load({key: os.path.join(REPO, "scripts", "meeting-v2", "eval", "silver", "data")})

    def test_meeting_ids(self):
        with tempfile.TemporaryDirectory() as d:
            for m in ("bbbbbbbb", "aaaaaaaa", "cccccccc"):
                os.makedirs(os.path.join(d, m))
            for m in ("bbbbbbbb", "aaaaaaaa"):
                open(os.path.join(d, m, "app.json"), "w").close()
            os.makedirs(os.path.join(d, "clips"))
            P = load({"SILVER_CORPUS": d})
            with mock.patch.dict(os.environ, {"SILVER_MEETINGS": ""}):
                self.assertEqual(P.meeting_ids(), ["aaaaaaaa", "bbbbbbbb"])
            with mock.patch.dict(os.environ, {"SILVER_MEETINGS": "cccccccc, aaaaaaaa"}):
                self.assertEqual(P.meeting_ids(), ["cccccccc", "aaaaaaaa"])

    def test_require_env(self):
        P = load({})
        with mock.patch.dict(os.environ, {"X_TEST_KEY": ""}):
            with self.assertRaises(SystemExit):
                P.require_env("X_TEST_KEY")
        with mock.patch.dict(os.environ, {"X_TEST_KEY": "v"}):
            self.assertEqual(P.require_env("X_TEST_KEY"), "v")


class CompileTests(unittest.TestCase):
    def test_every_script_compiles(self):
        files = [os.path.join(r, f) for r, _, fs in os.walk(HERE) for f in fs if f.endswith(".py")]
        self.assertGreater(len(files), 20)
        with tempfile.TemporaryDirectory() as d:
            for i, f in enumerate(files):
                py_compile.compile(f, cfile=os.path.join(d, f"{i}.pyc"), doraise=True)


if __name__ == "__main__":
    unittest.main()
