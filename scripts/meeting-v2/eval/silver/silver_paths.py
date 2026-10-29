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
  SILVER_MLFLOW_URI   the MLflow server of the cloud traces (no default; mlflow_uri() stops when it is unset)
  SILVER_MLFLOW_EXPERIMENT  the MLflow experiment             (default openstyle-silver-witnesses)

A path inside the repo is refused, so private data cannot land in git. The check
compares real paths (symlinks resolved) without case (the macOS disk ignores case).
Import it from a script in a subfolder with:
  sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
"""
import json
import os
import re
import shutil
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))


def inside_repo(p):
    """True when p is the repo or a path in it. realpath resolves the symlinks of the
    part of p that exists; casefold makes a lower-case spelling of the repo path match."""
    real, repo = os.path.realpath(p).casefold(), os.path.realpath(REPO).casefold()
    return real == repo or real.startswith(repo + os.sep)


def _private_dir(env, default):
    p = os.path.abspath(os.path.expanduser(os.environ.get(env) or default))
    if inside_repo(p):
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


def mlflow_uri():
    """The MLflow server of the cloud traces. It has no default: set SILVER_MLFLOW_URI."""
    v = os.environ.get("SILVER_MLFLOW_URI", "").strip()
    if not v:
        raise SystemExit("set SILVER_MLFLOW_URI to the MLflow server (for example http://<host>:5000)")
    return v


# ---------- GPU lock (same convention as scripts/meeting-v2/eval/runtime.mts) ----------
_HELD = None
_QLINE = None


def _log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def _queue_lines():
    with open(GPU_QUEUE) as f:
        return f.read().split("\n")


def take_lock(job="witness-corpus asr", minutes=240):
    """Take GPU_LOCK in queue order (GPU_QUEUE). Returns the wait in seconds.
    Our queue line is removed when the lock is taken, and also on any error or
    SIGINT during the wait (KeyboardInterrupt). Release with release_lock()."""
    global _HELD, _QLINE
    _QLINE = f"{job} {minutes} {datetime.now(timezone.utc).isoformat()} pid={os.getpid()}"
    made = False
    try:
        with open(GPU_QUEUE, "a") as f:
            f.write(_QLINE + "\n")
        waited = 0
        while True:
            lines = [l for l in _queue_lines() if l.strip()]
            if _QLINE not in lines:
                # Another process removed our line: queue again at the end (runtime.mts does the same).
                with open(GPU_QUEUE, "a") as f:
                    f.write(_QLINE + "\n")
                lines.append(_QLINE)
            first_live = None
            for l in lines:
                m = re.search(r" (\d{4}-\d{2}-\d{2}T[^ ]+) ", l)
                if m:
                    try:
                        t = datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
                        if (datetime.now(timezone.utc) - t).total_seconds() > 7200:
                            continue
                    except ValueError:
                        pass
                first_live = l
                break
            if first_live == _QLINE:
                try:
                    os.mkdir(GPU_LOCK)
                    made = True
                    break
                except FileExistsError:
                    pass
            if waited >= 3600:
                raise SystemExit("GPU lock wait exceeded 60 min")
            _log(f"GPU lock: waiting ({waited}s)")
            time.sleep(180)
            waited += 180
        held = f"{job} {datetime.now().strftime('%H:%M')} pid={os.getpid()}"
        with open(os.path.join(GPU_LOCK, "owner"), "w") as f:
            f.write(held + "\n")
        _HELD = held
    except BaseException:
        if made and not _HELD:
            shutil.rmtree(GPU_LOCK, ignore_errors=True)
        unqueue()
        raise
    unqueue()
    _log(f"GPU lock taken (waited {waited}s)")
    return waited


def unqueue():
    global _QLINE
    if _QLINE and os.path.exists(GPU_QUEUE):
        kept = [l for l in _queue_lines() if l != _QLINE]
        with open(GPU_QUEUE, "w") as f:
            f.write("\n".join(kept))
    _QLINE = None


def release_lock():
    """Remove GPU_LOCK when we own it (never the lock of another owner), and our queue line."""
    global _HELD
    if _HELD:
        try:
            with open(os.path.join(GPU_LOCK, "owner")) as f:
                owner = f.read().strip()
        except OSError:
            owner = ""
        if owner == _HELD:
            shutil.rmtree(GPU_LOCK, ignore_errors=True)
            _log("GPU lock released")
        _HELD = None
    unqueue()


def J(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)
