#!/usr/bin/env bash
# App check of one built-in MLX LLM: real app, isolated profile, fictional data.
# Usage: .claude/skills/app-check/scripts/run.sh <catalog-model-id>
# Env: APP_CHECK_OUT (evidence dir), APP_CHECK_SKIP_BUILD=1, APP_CHECK_KEEP_SCRATCH=1,
#      APP_CHECK_WORKER (path of the mlx_asr_worker binary),
#      APP_CHECK_PRESEED=1 (clone the model from the eval cache, skip the download proof).
# The GPU lock is held ONLY for the model steps (Enhance, inspector, dictation). The spec asks for it
# through gate files in <out> after the download step and gives it back after the dictation step.
# Read .claude/skills/app-check/SKILL.md first.
set -euo pipefail

MODEL_ID=${1:?usage: run.sh <catalog-model-id>   (for example gemma-4-e4b-qat-4bit)}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
STAMP=$(date +%Y%m%d-%H%M%S)
# Evidence stays out of /tmp: macOS cleans it (same rule as the HF eval cache).
OUT=${APP_CHECK_OUT:-$HOME/Library/Application Support/Openstyle-eval/app-check/$MODEL_ID-$STAMP}
# APP_CHECK_LOCK and APP_CHECK_QUEUE exist only to test the queue logic without the shared lock.
LOCK=${APP_CHECK_LOCK:-/tmp/openstyle-gpu.lock}
QUEUE=${APP_CHECK_QUEUE:-/tmp/openstyle-gpu.queue}
QLINE=""
SPEC_DST="$REPO/apps/electron/tests/zz-proof-appcheck.test.ts"
BACK_ID=gemma-4-e2b-qat-4bit
BACK_HF=mlx-community/gemma-4-E2B-it-qat-4bit
REAL_HF="$HOME/.cache/huggingface/hub"
WORKER=${APP_CHECK_WORKER:-$HOME/.cache/freestyle/mlx-asr/runtime/darwin-arm64/mlx_asr_worker/mlx_asr_worker}
SAMPLER_PID=""
HAVE_LOCK=0
PW_PID=""
PRESEED=${APP_CHECK_PRESEED:-0}
EVAL_HF="$HOME/Library/Application Support/Openstyle-eval/hf/hub"

cd "$REPO"

# 1. Resolve the catalog entry.
IFS='|' read -r HF_ID MODEL_NAME < <(node -e '
  const fs = require("fs");
  const src = fs.readFileSync("apps/server/src/lib/mlx-llm/constants.ts", "utf8");
  const id = process.argv[1];
  const re = new RegExp(`id:\\s*"${id.replace(/[.+*?^$()[\]{}|\\]/g, "\\$&")}",\\s*hfId:\\s*"([^"]+)",\\s*displayName:\\s*"([^"]+)"`);
  const m = src.match(re);
  if (!m) { console.error("model id not in the catalog: " + id); process.exit(2); }
  console.log(m[1] + "|" + m[2]);
' "$MODEL_ID")
[[ -n ${HF_ID:-} ]] || { echo "catalog lookup failed" >&2; exit 2; }
[[ -x $WORKER ]] || { echo "worker not found: $WORKER (set APP_CHECK_WORKER)" >&2; exit 2; }

# Preflight: the Electron binary must exist. A partial install fails the boot step AFTER the lock wait.
# APP_CHECK_ELECTRON_PKG overrides the package folder (used to test this check).
EL_PKG=${APP_CHECK_ELECTRON_PKG:-$(cd apps/electron && node -p 'require("path").dirname(require.resolve("electron/package.json"))' 2>/dev/null || true)}
if [[ -z $EL_PKG || ! -s $EL_PKG/path.txt || ! -e $EL_PKG/dist/$(cat "$EL_PKG/path.txt" 2>/dev/null) ]]; then
  echo "Electron binary missing or partial in '${EL_PKG:-<not resolved>}' (path.txt or dist/ lacks the binary)." >&2
  echo "Fix: clone dist/ and path.txt from a checkout with the same Electron version. See SKILL.md Traps 9." >&2
  exit 2
fi

unqueue() {
  [[ -n $QLINE && -f $QUEUE ]] || return 0
  { grep -v -x -F -- "$QLINE" "$QUEUE" || true; } > "$QUEUE.$$" && cat "$QUEUE.$$" > "$QUEUE"; rm -f "$QUEUE.$$"
  QLINE=""
}

# Log a lock event with an ISO time, to stdout and to <out>/lock-timeline.log.
lockline() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$OUT/lock-timeline.log"
}

# Release the lock only when THIS script took it (HAVE_LOCK=1 is set only after our own mkdir).
# Every command ends with || true, so the trap never fails under set -e.
release_lock() {
  if [[ $HAVE_LOCK == 1 ]]; then
    rm -f "$LOCK/owner" || true
    rmdir "$LOCK" 2>/dev/null || true
    HAVE_LOCK=0
    lockline "GPU lock released" || true
  fi
  return 0
}

cleanup() {
  # This stops the wrapper only. The Test Runner app starts Playwright detached (parent pid 1): see SKILL.md Traps 10.
  if [[ -n $PW_PID ]]; then kill "$PW_PID" 2>/dev/null || true; fi
  if [[ -n $SAMPLER_PID ]]; then kill "$SAMPLER_PID" 2>/dev/null || true; wait "$SAMPLER_PID" 2>/dev/null || true; fi
  rm -f "$SPEC_DST"
  unqueue
  release_lock
  if [[ ${APP_CHECK_KEEP_SCRATCH:-0} != 1 ]]; then rm -rf "$OUT/scratch"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$OUT/scratch/hf/hub" "$OUT/scratch/home"
echo "model=$MODEL_ID name=\"$MODEL_NAME\" hf=$HF_ID out=$OUT"

# 2. Build (server, then app).
if [[ ${APP_CHECK_SKIP_BUILD:-0} != 1 ]]; then
  pnpm turbo build --filter=@openstyle/server > "$OUT/build-server.log" 2>&1
  (cd apps/electron && OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build) > "$OUT/build-electron.log" 2>&1
  echo "build done"
fi

# 3. Switch-back target: APFS clone of E2B from the real HF cache (read only).
#    cp -Rc keeps the relative symlinks. Do NOT use node cpSync: it rewrites them to absolute paths.
if [[ $MODEL_ID != "$BACK_ID" ]]; then
  src="$REAL_HF/models--${BACK_HF//\//--}"
  [[ -d $src ]] || { echo "E2B is not in $REAL_HF. Download it in the installed app first." >&2; exit 2; }
  cp -Rc "$src" "$OUT/scratch/hf/hub/"
  broken=$(find -L "$OUT/scratch/hf/hub/models--${BACK_HF//\//--}" -type l | wc -l | tr -d ' ')
  [[ $broken == 0 ]] || { echo "E2B clone has $broken dangling symlinks" >&2; exit 2; }
  echo "E2B clone ok (0 dangling symlinks)"
fi

# 3b. Preseed (APP_CHECK_PRESEED=1): clone the checked model too, so the spec skips the download.
#     This does NOT prove the download button. Use it only when the download is not the thing under test.
if [[ $PRESEED == 1 ]]; then
  pname="models--${HF_ID//\//--}"
  [[ -d $EVAL_HF/$pname ]] || { echo "APP_CHECK_PRESEED=1 but $EVAL_HF/$pname does not exist." >&2; exit 2; }
  cp -Rc "$EVAL_HF/$pname" "$OUT/scratch/hf/hub/"
  broken=$(find -L "$OUT/scratch/hf/hub/$pname" -type l | wc -l | tr -d ' ')
  [[ $broken == 0 ]] || { echo "preseed clone has $broken dangling symlinks" >&2; exit 2; }
  echo "preseed clone ok (0 dangling symlinks)"
fi

# 4. Spec copy and sampler. The GPU lock is NOT taken here: setup, build, app start and the download need no GPU.
cp "$HERE/app-check.spec.ts.txt" "$SPEC_DST"

# GPU lock in queue order (owner rule 2026-10-20): queue first, then take the lock only
# when it is free AND our line is the first live line of the queue.
our_turn_and_lock() {
  # Someone removed our line: queue again at the end.
  grep -q -x -F -- "$QLINE" "$QUEUE" 2>/dev/null || echo "$QLINE" >> "$QUEUE"
  python3 -I "$HERE/queue-turn.py" "$QUEUE" "$QLINE" && mkdir "$LOCK" 2>/dev/null
}

LOGS=~/Library/Logs/Openstyle
stat -f '%N %z %Sm' "$LOGS"/* > "$OUT/logs-before.txt" 2>&1 || true
START=$(date '+%Y-%m-%d %H:%M:%S')
df -h / | tail -1 > "$OUT/df-before.txt"
python3 -I "$HERE/sample-rss.py" "$OUT/app.pid" "$OUT/rss.csv" &
SAMPLER_PID=$!

# 5. Run through the Test Runner app (stable Privacy identity).
rm -f "$OUT/gate.want" "$OUT/gate.granted" "$OUT/gate.release"
export APP_CHECK_PRESEED="$PRESEED" APP_CHECK_OUT="$OUT" APP_CHECK_MODEL_ID="$MODEL_ID" APP_CHECK_MODEL_NAME="$MODEL_NAME" \
  APP_CHECK_HF_ID="$HF_ID" APP_CHECK_WORKER="$WORKER" \
  OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false
set +e
scripts/test-runner/run.sh "$REPO/apps/electron" -- timeout 5400 pnpm exec playwright test tests/zz-proof-appcheck.test.ts > "$OUT/run.log" 2>&1 &
PW_PID=$!
# Gate loop: the spec writes gate.want before the first model step and gate.release after the last one.
LAST_MSG=0
while kill -0 "$PW_PID" 2>/dev/null; do
  if [[ $HAVE_LOCK == 0 && -f $OUT/gate.want && ! -f $OUT/gate.release ]]; then
    if [[ -z $QLINE ]]; then
      QLINE="app-check $MODEL_ID 100 $(date -u +%Y-%m-%dT%H:%M:%SZ) pid=$$"
      echo "$QLINE" >> "$QUEUE"
      lockline "GPU lock requested (model steps next)"
    fi
    if our_turn_and_lock; then
      HAVE_LOCK=1
      unqueue
      echo "app-check $MODEL_ID $(date -u +%H:%M:%SZ)" > "$LOCK/owner"
      lockline "GPU lock taken"
      touch "$OUT/gate.granted"
    elif (( $(date +%s) - LAST_MSG >= 30 )); then
      LAST_MSG=$(date +%s)
      echo "$(date +%T) GPU lock or queue busy: $(cat "$LOCK/owner" 2>/dev/null) | queue: $(grep -c . "$QUEUE" 2>/dev/null) line(s)" | tee -a "$OUT/lock-wait.log"
    fi
  elif [[ $HAVE_LOCK == 1 && -f $OUT/gate.release ]]; then
    release_lock
  fi
  sleep 2
done
wait "$PW_PID"
CODE=$?
PW_PID=""
set -e
# Safety net: the lock is already released after the dictation step. This covers a failed run.
release_lock

# 6. Evidence. Every step below may fail on its own: print each field, mark a missing one, keep the real exit code.
set +e
stat -f '%N %z %Sm' "$LOGS"/* > "$OUT/logs-after.txt" 2>&1 || true
df -h / | tail -1 > "$OUT/df-after.txt"
/usr/bin/log show --start "$START" --predicate 'subsystem == "com.apple.TCC"' --style compact 2>/dev/null | grep -c AUTHREQ_PROMPTING > "$OUT/tcc-prompts.txt" || true
UD=$(cat "$OUT/userdata.path" 2>/dev/null || true)
# The profile is in the scratch folder, the app is closed, and the DB is in WAL mode with no -shm file.
# `sqlite3 -readonly` fails on that ("unable to open database file", 2026-10-25), so open it normally.
if [[ -n $UD && -f $UD/freestyle.db ]]; then
  sqlite3 -header "$UD/freestyle.db" \
    "select step_key, provider, finish_unified, count(*) calls, round(avg(latency_ms)) avg_ms, max(latency_ms) max_ms, sum(error_kind is not null) errors from llm_calls group by 1,2,3" > "$OUT/llm-calls.txt" 2>&1 || true
fi
# The installed app writes its own log (updater check every 5 min), so a size change alone proves nothing.
# Proof of isolation: no line of the real logs names this run's folder.
LOGHITS=$(cat "$LOGS"/* 2>/dev/null | grep -c -F "$OUT" || true)
if [[ $LOGHITS == 0 ]]; then LOGSTAT="no line in ~/Library/Logs/Openstyle names this run"; else LOGSTAT="REAL LOGS NAME THIS RUN: $LOGHITS lines"; fi

echo "=== run.log tail ==="; tail -12 "$OUT/run.log" 2>/dev/null || echo "(run.log missing)"
echo "=== results.json ==="; { cat "$OUT/results.json" 2>/dev/null && echo; } || echo "(none)"
echo "=== peak RSS (GiB) per worker kind ==="
python3 -I - "$OUT/rss.csv" <<'PY' || echo "(rss summary failed)"
import csv, os, sys
if not os.path.exists(sys.argv[1]):
    print("(rss.csv missing: the sampler did not write it)")
    sys.exit(0)
peak = {}
for r in csv.DictReader(open(sys.argv[1])):
    peak[r["kind"]] = max(peak.get(r["kind"], 0), int(r["rss_kb"]))
if not peak:
    print("(rss.csv has no samples)")
for k, v in sorted(peak.items()):
    print(f"{k}: {v/1024/1024:.2f}")
PY
echo "=== llm_calls ==="; cat "$OUT/llm-calls.txt" 2>/dev/null || echo "(none)"
echo "=== TCC prompts since start (expect 0) ==="; cat "$OUT/tcc-prompts.txt" 2>/dev/null || echo "(missing)"
echo "=== real log folder: $LOGSTAT ==="; diff "$OUT/logs-before.txt" "$OUT/logs-after.txt"
echo "=== artifacts in $OUT ==="; ls -1 "$OUT"/*.png 2>/dev/null || echo "(no screenshots)"
echo "playwright exit code: $CODE"
exit "$CODE"
