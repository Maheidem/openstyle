#!/usr/bin/env python3
"""Smoke tests of the silver-gold pipeline: path rules and a compile check of every script.

Run: python3 -I scripts/meeting-v2/eval/silver/test_silver_paths.py   (pnpm meeting:silver:test)
No model, no GPU, no private data.
"""
import importlib.util
import os
import py_compile
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
ENV_KEYS = ("SILVER_CORPUS", "SILVER_KEYS", "SILVER_WORK", "SILVER_MEETINGS", "SILVER_ENRICHED_DB",
            "OPENSTYLE_PROFILE", "OPENSTYLE_EVAL_HF_HOME", "SILVER_MLFLOW_URI")


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

    def test_a_symlink_into_the_repo_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            link = os.path.join(d, "link")
            os.symlink(os.path.join(REPO, "scripts"), link)
            for sub in ("", "data"):  # an existing path, and a path that does not exist yet
                with self.assertRaises(SystemExit):
                    load({"SILVER_CORPUS": os.path.join(link, sub) if sub else link})

    def test_a_lower_case_repo_path_is_refused(self):
        with self.assertRaises(SystemExit):
            load({"SILVER_KEYS": os.path.join(REPO.lower(), "scripts", "data")})
        with self.assertRaises(SystemExit):
            load({"SILVER_WORK": REPO.upper()})

    def test_a_normal_outside_path_is_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            P = load({"SILVER_KEYS": os.path.join(d, "keys")})
            self.assertEqual(P.KEYS, os.path.join(d, "keys"))
            self.assertFalse(P.inside_repo(d))

    def test_mlflow_uri_has_no_default(self):
        P = load({})
        with self.assertRaises(SystemExit):
            P.mlflow_uri()
        with mock.patch.dict(os.environ, {"SILVER_MLFLOW_URI": "http://127.0.0.1:5999"}):
            self.assertEqual(P.mlflow_uri(), "http://127.0.0.1:5999")

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


class LockTests(unittest.TestCase):
    """take_lock on a temp lock and queue (never the real /tmp/openstyle-gpu.lock)."""

    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.P = load({})
        self.P.GPU_LOCK = os.path.join(self.d.name, "gpu.lock")
        self.P.GPU_QUEUE = os.path.join(self.d.name, "gpu.queue")
        self.P._log = lambda msg: None

    def tearDown(self):
        self.d.cleanup()

    def queue(self):
        return [l for l in self.P._queue_lines() if l.strip()]

    def test_sigint_during_the_wait_removes_the_queue_line(self):
        os.mkdir(self.P.GPU_LOCK)  # another job holds the lock
        with mock.patch.object(self.P.time, "sleep", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.P.take_lock("test-job", 1)
        self.assertEqual(self.queue(), [])
        self.assertTrue(os.path.isdir(self.P.GPU_LOCK))  # the lock of the other job stays

    def test_a_removed_queue_line_is_queued_again(self):
        os.mkdir(self.P.GPU_LOCK)

        def other_job_cleans_up(_):
            open(self.P.GPU_QUEUE, "w").close()  # another process removes our line
            os.rmdir(self.P.GPU_LOCK)  # and the lock is free

        with mock.patch.object(self.P.time, "sleep", side_effect=other_job_cleans_up):
            self.P.take_lock("test-job", 1)
        self.assertTrue(os.path.isdir(self.P.GPU_LOCK))
        self.assertEqual(self.queue(), [])
        self.P.release_lock()
        self.assertFalse(os.path.exists(self.P.GPU_LOCK))


class RunArmTests(unittest.TestCase):
    """run_arm.sh checks the arm name and SILVER_EVAL_HOME before any delete (dry run: no eval)."""
    SH = os.path.join(HERE, "score", "run_arm.sh")

    def run_arm(self, arm, home="/tmp/meeting-eval"):
        env = {**os.environ, "SILVER_ARM_DRY_RUN": "1", "SILVER_EVAL_HOME": home}
        return subprocess.run(["bash", self.SH, arm], env=env, capture_output=True, text=True)

    def test_bad_arm_names_are_refused(self):
        for arm in ("..", "../..", "a/b", "", ".x", ".", "a b", "x;y"):
            r = self.run_arm(arm)
            self.assertEqual(r.returncode, 2, arm)
            self.assertIn("bad arm name", r.stdout, arm)

    def test_a_good_arm_name_passes_the_dry_run(self):
        r = self.run_arm("s33-B2.v1_x")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("dry run: arm=s33-B2.v1_x", r.stdout)

    def test_bad_eval_homes_are_refused(self):
        for home in ("/", os.path.expanduser("~"), "/tmp", REPO, os.path.join(REPO.lower(), "x"),
                     os.path.expanduser("~/Documents")):
            r = self.run_arm("ok", home)
            self.assertEqual(r.returncode, 2, home)
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.run_arm("ok", os.path.join(d, "meeting-eval")).returncode, 0)


class CompileTests(unittest.TestCase):
    def test_every_script_compiles(self):
        files = [os.path.join(r, f) for r, _, fs in os.walk(HERE) for f in fs if f.endswith(".py")]
        self.assertGreater(len(files), 20)
        with tempfile.TemporaryDirectory() as d:
            for i, f in enumerate(files):
                py_compile.compile(f, cfile=os.path.join(d, f"{i}.pyc"), doraise=True)


if __name__ == "__main__":
    unittest.main()
