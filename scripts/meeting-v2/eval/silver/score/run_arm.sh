#!/bin/bash
# Run the ASR phase of pnpm meeting:eval on the silver gold meetings, keep the
# transcribed arm DB, and stop the eval before the LLM stage.
#
# usage: [ENV=...] run_arm.sh <arm> [meetings csv]
#   (pnpm meeting:silver:arm <arm> [meetings csv])
#
# - The arm is the code of THIS worktree plus the env that you set. The script
#   passes your env to the eval unchanged (for example MEETING_EVAL_OWNER_NAME,
#   or the POC toggles OPENSTYLE_ASR_ATTENDEE_TERMS and OPENSTYLE_ASR_AUDIO_RANK
#   of the poc branches).
# - Output: $E/out/<arm>/raw.db (copy of arms/transcribed.db), the log $E/<arm>.out
#   and the bias prompt log lines $E/proof-<arm>-bias.txt (private, 0600; delete
#   it after the count). E = $SILVER_EVAL_HOME, default /tmp/meeting-eval.
#   E must be under /tmp, or its last folder must be named meeting-eval. It must not
#   be /, $HOME or the repo. The script deletes paths under E, so it refuses other folders.
# - The arm name is a folder and file name: only letters, digits, '.', '_' and '-',
#   and not '.' first (so '', '.', '..', '../x' and 'a/b' are refused).
# - SILVER_ARM_DRY_RUN=1 checks the arm name and E, prints the plan and stops.
#   It deletes nothing and starts nothing.
# - It deletes the eval's shared ASR cache (/tmp/meeting-eval/asr/cache; the eval
#   always uses that folder) under the GPU lock, then releases the lock and starts the
#   eval: the cache key does not hold the arm env, so a cache hit could give the
#   transcript of another arm. If the eval still reports a cached transcription (another
#   job filled the cache in between), the run fails.
# - It stops the eval with SIGINT to the PIDs of its own process tree, never pkill.
# - The eval refuses a stale server build: run `pnpm turbo build --filter=@openstyle/server` first.
# - Then: pnpm meeting:silver:score-arms <arm> ...
set -u
ARM=${1-}
case "$ARM" in
  "" | .* | *[!A-Za-z0-9._-]*)
    echo "bad arm name '$ARM': use letters, digits, '.', '_' and '-' only, and not '.' first"; exit 2;;
esac
SP=$(cd "$(dirname "$0")" && pwd)
SILVER=$(dirname "$SP")
REPO=$(cd "$SP/../../../../.." && pwd)
# The real path (symlinks resolved), lower case: the macOS disk ignores case.
real_lc() { python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]).casefold())' "$1"; }
E=${SILVER_EVAL_HOME:-/tmp/meeting-eval}
ER=$(real_lc "$E"); RR=$(real_lc "$REPO"); HR=$(real_lc "$HOME")
case "$ER/" in "$RR"/*) echo "SILVER_EVAL_HOME points into the repo: the arm DBs hold meeting text"; exit 2;; esac
if [ "$ER" = "/" ] || [ "$ER" = "$HR" ]; then echo "SILVER_EVAL_HOME must not be / or \$HOME: $E"; exit 2; fi
case "$ER" in
  /tmp/?* | /private/tmp/?* | */meeting-eval) ;;
  *) echo "SILVER_EVAL_HOME must be under /tmp or a folder named meeting-eval: $E"; exit 2;;
esac
OUT=$E/out/$ARM
# The ASR folder of the eval is fixed (ROOT in scripts/meeting-v2/eval/runtime.mts).
ASR=/tmp/meeting-eval/asr
if [ "${SILVER_ARM_DRY_RUN-}" = 1 ]; then
  echo "dry run: arm=$ARM E=$E; would delete $OUT $E/$ARM.out $E/proof-$ARM-*.txt and $ASR/cache (under the GPU lock)"
  exit 0
fi
KEYS=${SILVER_KEYS:-$HOME/.openstyle-eval/gold-silver}
DEFAULT_M=$(ls "$KEYS" | grep -E '^[0-9a-f]{8}\.json$' | cut -c1-8 | paste -sd, -)
M=${2:-${SILVER_MEETINGS:-$DEFAULT_M}}
M=$(echo "$M" | tr ' ' ',')
[ -n "$M" ] || { echo "no meetings (no keys in $KEYS)"; exit 2; }
WORKER_DEFAULT=$(ls -d "$E"/worker-*/mlx_asr_worker/mlx_asr_worker 2>/dev/null | sort | tail -1)
export OPENSTYLE_MLX_LLM_WORKER=${OPENSTYLE_MLX_LLM_WORKER:-$WORKER_DEFAULT}
[ -x "$OPENSTYLE_MLX_LLM_WORKER" ] || { echo "no worker: set OPENSTYLE_MLX_LLM_WORKER (see the meeting-eval skill)"; exit 2; }
mkdir -p "$E/out"
rm -rf "$OUT" "$E/$ARM.out" "$E"/proof-"$ARM"-*.txt
# Delete the shared ASR cache only while this script holds the GPU lock (silver_paths.take_lock,
# the runtime.mts queue): no other job writes or reads the cache during the delete.
python3 -I - "$SILVER" "$ASR/cache" <<'PY_LOCK' || { echo "cannot clear the ASR cache under the GPU lock"; exit 2; }
import shutil, sys
sys.path.insert(0, sys.argv[1])
import silver_paths as P
P.take_lock("run-arm clear-asr-cache", 5)
try:
    shutil.rmtree(sys.argv[2], ignore_errors=True)
finally:
    P.release_lock()
PY_LOCK
umask 077
cd "$REPO" || exit 2
export OPENSTYLE_ASR_AUDIO_RANK_LOG=$E/proof-$ARM-rank.txt
T0=$(date +%s)
pnpm meeting:eval --models gemma-4-e2b-qat-4bit --meetings "$M" --keep --no-download \
  --gold --gold-dir "$KEYS" --out "$OUT" > "$E/$ARM.out" 2>&1 &
EVAL_PID=$!
until grep -qE "GPU lock taken: gemma|ELIFECYCLE|results.json:" "$E/$ARM.out" 2>/dev/null; do
  kill -0 $EVAL_PID 2>/dev/null || break
  grep -h "ASR bias prompt (" "$ASR"/work/*/baseline/*/server.log 2>/dev/null >> "$E/proof-$ARM-bias.txt"
  sleep 2
done
T1=$(date +%s)
[ -f "$OUT/arms/transcribed.db" ] || { echo "no arms/transcribed.db: see $E/$ARM.out"; kill -INT $EVAL_PID 2>/dev/null; wait; exit 1; }
cp "$OUT/arms/transcribed.db" "$OUT/raw.db"
# SIGINT to the eval tree that this script started (pnpm -> node eval.mts), so eval.mts releases the GPU lock.
tree() { local p=$1; echo "$p"; for c in $(pgrep -P "$p"); do tree "$c"; done; }
for p in $(tree $EVAL_PID); do kill -INT "$p" 2>/dev/null; done; wait
if grep -qE "transcription [0-9a-f]{8}: cached" "$E/$ARM.out"; then
  echo "arm=$ARM FAILED: the eval used a cached transcription (another job filled the ASR cache); run the arm again"; exit 1
fi
touch "$E/proof-$ARM-bias.txt"; sort -u -o "$E/proof-$ARM-bias.txt" "$E/proof-$ARM-bias.txt"
echo "arm=$ARM asr_phase_sec=$((T1-T0)) transcribed=$(grep -c 'status=transcribed' "$E/$ARM.out") asr_wall_sum=$(grep -o 'status=transcribed wallSeconds=[0-9.]*' "$E/$ARM.out" | awk -F= '{s+=$3} END {print s}') segs=$(sqlite3 -readonly "$OUT/raw.db" 'select count(*) from meeting_segments') bias_lines=$(wc -l < "$E/proof-$ARM-bias.txt")"
