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
# - It deletes the shared ASR cache $E/asr/cache first: the cache key does not
#   hold the arm env, so a cache hit could give the transcript of another arm.
# - It stops the eval with SIGINT to the PIDs of its own process tree, never pkill.
# - The eval refuses a stale server build: run `pnpm turbo build --filter=@openstyle/server` first.
# - Then: pnpm meeting:silver:score-arms <arm> ...
set -u
ARM=${1:?usage: run_arm.sh <arm> [meetings csv]}
E=${SILVER_EVAL_HOME:-/tmp/meeting-eval}; OUT=$E/out/$ARM
KEYS=${SILVER_KEYS:-$HOME/.openstyle-eval/gold-silver}
REPO=$(cd "$(dirname "$0")/../../../../.." && pwd)
DEFAULT_M=$(ls "$KEYS" | grep -E '^[0-9a-f]{8}\.json$' | cut -c1-8 | paste -sd, -)
M=${2:-${SILVER_MEETINGS:-$DEFAULT_M}}
M=$(echo "$M" | tr ' ' ',')
[ -n "$M" ] || { echo "no meetings (no keys in $KEYS)"; exit 2; }
WORKER_DEFAULT=$(ls -d "$E"/worker-*/mlx_asr_worker/mlx_asr_worker 2>/dev/null | sort | tail -1)
export OPENSTYLE_MLX_LLM_WORKER=${OPENSTYLE_MLX_LLM_WORKER:-$WORKER_DEFAULT}
[ -x "$OPENSTYLE_MLX_LLM_WORKER" ] || { echo "no worker: set OPENSTYLE_MLX_LLM_WORKER (see the meeting-eval skill)"; exit 2; }
mkdir -p "$E/out"
rm -rf "$E/asr/cache" "$OUT" "$E/$ARM.out" "$E"/proof-"$ARM"-*.txt
umask 077
cd "$REPO" || exit 2
export OPENSTYLE_ASR_AUDIO_RANK_LOG=$E/proof-$ARM-rank.txt
T0=$(date +%s)
pnpm meeting:eval --models gemma-4-e2b-qat-4bit --meetings "$M" --keep --no-download \
  --gold --gold-dir "$KEYS" --out "$OUT" > "$E/$ARM.out" 2>&1 &
EVAL_PID=$!
until grep -qE "GPU lock taken: gemma|ELIFECYCLE|results.json:" "$E/$ARM.out" 2>/dev/null; do
  kill -0 $EVAL_PID 2>/dev/null || break
  grep -h "ASR bias prompt (" "$E"/asr/work/*/baseline/*/server.log 2>/dev/null >> "$E/proof-$ARM-bias.txt"
  sleep 2
done
T1=$(date +%s)
[ -f "$OUT/arms/transcribed.db" ] || { echo "no arms/transcribed.db: see $E/$ARM.out"; kill -INT $EVAL_PID 2>/dev/null; wait; exit 1; }
cp "$OUT/arms/transcribed.db" "$OUT/raw.db"
# SIGINT to the eval tree that this script started (pnpm -> node eval.mts), so eval.mts releases the GPU lock.
tree() { local p=$1; echo "$p"; for c in $(pgrep -P "$p"); do tree "$c"; done; }
for p in $(tree $EVAL_PID); do kill -INT "$p" 2>/dev/null; done; wait
touch "$E/proof-$ARM-bias.txt"; sort -u -o "$E/proof-$ARM-bias.txt" "$E/proof-$ARM-bias.txt"
echo "arm=$ARM asr_phase_sec=$((T1-T0)) transcribed=$(grep -c 'status=transcribed' "$E/$ARM.out") asr_wall_sum=$(grep -o 'status=transcribed wallSeconds=[0-9.]*' "$E/$ARM.out" | awk -F= '{s+=$3} END {print s}') segs=$(sqlite3 -readonly "$OUT/raw.db" 'select count(*) from meeting_segments') bias_lines=$(wc -l < "$E/proof-$ARM-bias.txt")"
