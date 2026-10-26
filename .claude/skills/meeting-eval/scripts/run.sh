#!/usr/bin/env bash
# One command: eval one LLM on both gold meetings (5578edb0, ca70f895).
# Usage: .claude/skills/meeting-eval/scripts/run.sh <model-id[,model-id...]> [out-dir]
# Needs: a fresh server build, the diarizer files, a worker (see SKILL.md).
# The GPU lock: pnpm meeting:eval takes /tmp/openstyle-gpu.lock itself, in
# queue order, and releases it at exit. Do not take the lock here.
set -euo pipefail

MODEL=${1:?usage: run.sh <model-id> [out-dir]}
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
EVAL_HOME="$HOME/Library/Application Support/Openstyle-eval"
OUT=${2:-$EVAL_HOME/out/${MODEL}-$(date +%Y%m%d-%H%M)}
HF=${OPENSTYLE_EVAL_HF_HOME:-$EVAL_HOME/hf}
PRIVATE_AUDIO="$EVAL_HOME/audio"
REAL_MEETINGS="$HOME/Library/Application Support/Openstyle/meetings"
GOLD_IDS="5578edb0-68fc-4a7f-9fd5-b9e17e43ed7e ca70f895-ebe9-47e3-b663-eeb2c7bd97a6"
cd "$REPO"

fail() { echo "REFUSED: $*" >&2; exit 1; }

# 1. Gold wav files: the run reads them from the real profile.
for id in $GOLD_IDS; do
  for ch in mic system; do
    [ -s "$REAL_MEETINGS/$id/$ch.wav" ] && continue
    if [ -s "$PRIVATE_AUDIO/$id/$ch.wav" ]; then
      fail "$id/$ch.wav is missing in the real profile. A private copy exists: $PRIVATE_AUDIO/$id/. Ask the owner to restore it (the guard hook blocks an agent from writing into the real profile)."
    fi
    fail "$id/$ch.wav is missing in both places. The gold clips cannot run."
  done
done

# 2. The model weights must be in the cache (the run uses --no-download).
[ -d "$HF/hub" ] || fail "no HF cache at $HF (set OPENSTYLE_EVAL_HF_HOME)"
for m in ${MODEL//,/ }; do
  broken=$(find "$HF/hub" -path "*snapshots*" -type l ! -exec test -e {} \; -print | grep -ci "$(echo "$m" | sed 's/-qat.*//;s/-4bit//')" || true)
  [ "$broken" = 0 ] || echo "WARN: $broken dangling link(s) in the cache for $m (tmp cleanup damage?). The run may fail." >&2
done

# 3. Preconditions of the tool: worker, diarizer, server build.
WORKER=${OPENSTYLE_MLX_LLM_WORKER:-$(ls -d /tmp/meeting-eval/worker-*/mlx_asr_worker/mlx_asr_worker 2>/dev/null | sort -V | tail -1)}
[ -x "${WORKER:-}" ] || fail "no worker. Copy the shipped one to /tmp/meeting-eval/worker-<version>/ (see SKILL.md)"
export OPENSTYLE_MLX_LLM_WORKER=$WORKER
[ -x apps/electron/resources/bin/darwin-arm64/fluidaudio-diarize ] || fail "diarizer binary is missing (copy it from the main checkout)"
[ -d apps/electron/resources/models/speaker-diarization ] || fail "diarizer models are missing (copy them from the main checkout)"
[ -d node_modules/.pnpm ] || fail "no node_modules: run pnpm install --frozen-lockfile --prefer-offline --ignore-scripts"
pnpm turbo build --filter=@openstyle/server >/dev/null

# An unfinished run (failure, INT, TERM) must not leave meeting text without
# results. A finished run keeps pack/ for the blind step.
DONE=0
CHILD=
cleanup() {
  if [ "$DONE" != 1 ]; then
    rm -rf "$OUT/pack" "$OUT/arms" "$OUT/runs"
    rmdir "$OUT" 2>/dev/null || true
    echo "run did not finish: removed pack/ arms/ runs/ of $OUT" >&2
  fi
}
# pnpm does not pass TERM on to node: signal the whole tree under the child.
tree_pids() {
  local p c
  echo "$1"
  for c in $(ps -A -o pid=,ppid= | awk -v p="$1" '$2 == p {print $1}'); do
    tree_pids "$c"
  done
}
on_signal() {
  # A background child of a non-interactive shell ignores SIGINT, so send TERM.
  # eval.mts releases the GPU lock and its scratch profiles on SIGTERM.
  if [ -n "$CHILD" ]; then
    kill -TERM $(tree_pids "$CHILD") 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
  exit 130
}
trap cleanup EXIT
trap on_signal INT TERM

echo "model=$MODEL out=$OUT worker=$WORKER hf=$HF"
START=$(date +%s)
pnpm meeting:eval --models "$MODEL" --meetings 5578edb0,ca70f895 --gold \
  --keep --no-download --hf-cache "$HF" --out "$OUT" &
CHILD=$!
wait "$CHILD"
DONE=1
echo "elapsed_sec=$(( $(date +%s) - START ))"
echo "--- results.md ---"
cat "$OUT/results.md"
echo "out=$OUT (private text in pack/, runs/, arms/: delete when the judging ends)"
