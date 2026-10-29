"""Shared paths and helpers of the silver-gold pipeline (see README.md).

All private data stays OUTSIDE the repo. Each path has an env override:

  SILVER_CORPUS       witness files, one folder per meeting  (default ~/.openstyle-eval/silver/corpus)
  SILVER_KEYS         the silver gold keys <id8>.json        (default ~/.openstyle-eval/gold-silver)
  SILVER_WORK         raw cloud responses, caches, temp wavs (default ~/.openstyle-eval/silver/work)
  SILVER_MEETINGS     meeting ids (id8), comma or space list (default: every corpus folder with app.json)
  SILVER_ENRICHED_DB  optional app DB copy with an extra Enhance run (score_silver APP_ENH_ENRICHED)
  OPENSTYLE_PROFILE   the app profile, read-only             (default ~/Library/Application Support/Openstyle)
  OPENSTYLE_EVAL_HF_HOME  the model cache                    (default ~/Library/Application Support/Openstyle-eval/hf)
  SILVER_ASR_WORKER   the MLX ASR worker binary              (default: the app's shipped worker)
  SILVER_MLFLOW_URI, SILVER_MLFLOW_EXPERIMENT  tracing of the cloud calls (counts only)

A path inside the repo is refused, so private data cannot land in git.
Import it from a script in a subfolder with:
  sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))


def _private_dir(env, default):
    p = os.path.abspath(os.path.expanduser(os.environ.get(env) or default))
    if p == REPO or p.startswith(REPO + os.sep):
        raise SystemExit(f"{env} points into the repo ({p}). Private data must stay outside git.")
    return p


CORPUS = _private_dir("SILVER_CORPUS", "~/.openstyle-eval/silver/corpus")
KEYS = _private_dir("SILVER_KEYS", "~/.openstyle-eval/gold-silver")
WORK = _private_dir("SILVER_WORK", "~/.openstyle-eval/silver/work")
PROFILE = _private_dir("OPENSTYLE_PROFILE", "~/Library/Application Support/Openstyle")
MEET = os.path.join(PROFILE, "meetings")
APP_DB = os.path.join(PROFILE, "freestyle.db")
HF_HOME = _private_dir("OPENSTYLE_EVAL_HF_HOME", "~/Library/Application Support/Openstyle-eval/hf")
ENRICHED_DB = _private_dir("SILVER_ENRICHED_DB", "~/.openstyle-eval/silver/enriched.db")
WORKER = os.path.expanduser(os.environ.get("SILVER_ASR_WORKER")
                            or "~/.cache/freestyle/mlx-asr/runtime/darwin-arm64/mlx_asr_worker/mlx_asr_worker")
MLFLOW_URI = os.environ.get("SILVER_MLFLOW_URI", "http://192.168.31.154:5000")
MLFLOW_EXPERIMENT = os.environ.get("SILVER_MLFLOW_EXPERIMENT", "openstyle-silver-witnesses")
# The GPU lock of scripts/meeting-v2/eval/runtime.mts (same convention).
GPU_LOCK = "/tmp/openstyle-gpu.lock"
GPU_QUEUE = "/tmp/openstyle-gpu.queue"
WER_MTS = os.path.join(HERE, "wer.mts")
TS_REGISTER = os.path.join(REPO, "scripts", "meeting-v2", "ts-register.mjs")


def meeting_ids():
    """SILVER_MEETINGS in the given order, else the sorted corpus folders that have app.json."""
    env = os.environ.get("SILVER_MEETINGS", "").replace(",", " ").split()
    if env:
        return env
    if not os.path.isdir(CORPUS):
        raise SystemExit(f"no corpus folder: {CORPUS} (set SILVER_CORPUS)")
    return sorted(d for d in os.listdir(CORPUS)
                  if re.fullmatch(r"[0-9a-f]{8}", d) and os.path.exists(os.path.join(CORPUS, d, "app.json")))


def work_dir(*parts):
    """A private folder (mode 700) under SILVER_WORK."""
    p = os.path.join(WORK, *parts)
    os.makedirs(p, mode=0o700, exist_ok=True)
    return p


def node_ts(script):
    """The command that runs a repo .mts file (Node type stripping + the repo resolve hook)."""
    return ["node", "--import", TS_REGISTER, script]


def require_env(name):
    """Read a secret from the environment only. Never print or write it."""
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"set {name} in the environment (it is never read from a file)")
    return v


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)
