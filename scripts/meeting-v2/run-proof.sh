#!/bin/bash
# run-proof.sh — committed driver for one meeting proof run (PR #34).
#
# One <RUN> run per meeting on the scratch profile, then the stored chunk
# and turn dumps that scripts/meeting-v2/compare.mts compares. The
# procedure is the one proven by the /tmp/meeting-v2 drivers
# (driver-4f.sh et al.) plus run-baseline.mjs.
#
# Usage (from the repo root):
#   OPENSTYLE_MLX_ASR_WORKER=$PWD/dist/mlx_asr_worker/mlx_asr_worker \
#   ./scripts/meeting-v2/run-proof.sh <RUN> <meetingId> [meetingId ...]
#
# Required env:
#   OPENSTYLE_MLX_ASR_WORKER  the dev worker bundle. The driver refuses to
#                            start without it: the owner's
#                            ~/.cache/freestyle/mlx-asr/runtime is the
#                            integrity-verified cache and must never be
#                            written by the proof runs (council review,
#                            2026-10-07). run-baseline.mjs passes the value
#                            through to the isolated server untouched.
# Isolation (follow-up to PR #34): every server and worker this driver
# starts runs under the scratch HOME via scripts/isolated-env.sh's
# isolated_run — the server writes the managed MLX runtime under
# homedir() (updateManagedMlxRuntimeIfNeeded), and the scratch HOME is
# the only place it may go. The driver refuses to start when
# isolated-env.sh is missing or when it cannot set the scratch HOME.
# SCRATCH must therefore be an absolute path under /tmp or /private/tmp
# (isolated-env.sh's rule).
#
# Optional env:
#   REPO      repo root (default: resolved from this script's location)
#   SCRATCH   scratch profile dir (default /tmp/meeting-v2)
#   HF_CACHE  Hugging Face cache dir argument (default /tmp/meeting-p4b-hf/hf):
#             the automatic aligner download (~1.2 GB) goes here, never into
#             the user's ~/.cache/huggingface.
#   OMLX_URL  oMLX endpoint for the health check (default http://127.0.0.1:8123)
#   PORT      server port for the runs (default 4787): parallel proof
#             children must use their OWN port (never 4649)
#
# oMLX health (HTTP 200 on /v1/models) is checked before the first run and
# after EVERY meeting. It prints counts, statuses and file paths only —
# never transcript text. A failed meeting or dump is logged and the driver
# continues; the exit code is non-zero if anything failed.

set -u

usage() { echo "usage: run-proof.sh <RUN> <meetingId> [meetingId ...]" >&2; }

if [ $# -lt 2 ]; then usage; exit 2; fi
RUN=$1; shift

if [ -z "${OPENSTYLE_MLX_ASR_WORKER:-}" ]; then
  echo "REFUSED: OPENSTYLE_MLX_ASR_WORKER is not set. Point it at the dev worker bundle (scripts/build_mlx_asr_worker.sh), e.g.: OPENSTYLE_MLX_ASR_WORKER=$PWD/dist/mlx_asr_worker/mlx_asr_worker" >&2
  exit 2
fi
if [ ! -x "$OPENSTYLE_MLX_ASR_WORKER" ]; then
  echo "REFUSED: OPENSTYLE_MLX_ASR_WORKER=$OPENSTYLE_MLX_ASR_WORKER is not an executable file" >&2
  exit 2
fi

REPO=$(cd "$(dirname "$0")/../.." && pwd)
SCRATCH=${SCRATCH:-/tmp/meeting-v2}
HF_CACHE=${HF_CACHE:-/tmp/meeting-p4b-hf/hf}
OMLX_URL=${OMLX_URL:-http://127.0.0.1:8123}
PORT=${PORT:-4787}
if [ "$PORT" = "4649" ]; then
  echo "REFUSED: port 4649 (the installed app owns it)" >&2
  exit 2
fi
CMP=$SCRATCH/compare
RUNSDIR=$SCRATCH/runs
RUN_LC=$(printf '%s' "$RUN" | tr 'A-Z' 'a-z')
mkdir -p "$CMP" "$RUNSDIR"

ISO_ENV="$REPO/scripts/isolated-env.sh"
if [ ! -f "$ISO_ENV" ]; then
  echo "REFUSED: $ISO_ENV is missing; run-proof starts every server/worker under the scratch HOME (isolated-env.sh)" >&2
  exit 2
fi
# shellcheck disable=SC1090
source "$ISO_ENV" "$SCRATCH" "$OPENSTYLE_MLX_ASR_WORKER"
if [ -z "${OPENSTYLE_ISOLATED_HOME:-}" ] || ! command -v isolated_run >/dev/null 2>&1; then
  echo "REFUSED: isolated-env.sh did not set the scratch HOME (scratch=$SCRATCH must be an absolute path under /tmp or /private/tmp)" >&2
  exit 2
fi
echo "scratch HOME: $OPENSTYLE_ISOLATED_HOME (every server/worker runs via isolated_run)"

if [ ! -f "$REPO/apps/server/dist/startup.js" ]; then
  echo "REFUSED: the server is not built (pnpm --filter \"@openstyle/server...\" build)" >&2
  exit 2
fi
if [ ! -f "$SCRATCH/test.db" ]; then
  echo "REFUSED: no scratch profile at $SCRATCH (scripts/meeting-v2/setup-scratch.sh first)" >&2
  exit 2
fi

health() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$OMLX_URL/v1/models") || code=000
  if [ "$code" = "200" ]; then
    echo "oMLX $1: 200"
    return 0
  fi
  echo "oMLX UNHEALTHY $1: HTTP $code ($OMLX_URL)" >&2
  return 1
}

fail=0
if ! health "pre-run"; then
  echo "REFUSED: oMLX is not healthy before the run" >&2
  exit 2
fi

for id in "$@"; do
  short=${id:0:8}
  echo "=== $short $RUN start $(date +%H:%M:%S) ==="
  isolated_run SCRATCH="$SCRATCH" node "$REPO/scripts/meeting-v2/run-baseline.mjs" \
    --meeting "$id" --run "$RUN" --hf-cache "$HF_CACHE" --port "$PORT" \
    > "$RUNSDIR/$short-$RUN_LC.log" 2>&1
  status=$?
  echo "$RUN exit=$status $(date +%H:%M:%S)"
  grep -E "status=|chunks=|aligner split" "$RUNSDIR/$short-$RUN_LC.log" | tail -3
  if [ "$status" -ne 0 ]; then fail=1; fi
  if ! health "post-$RUN_LC-$short"; then fail=1; fi
  node "$REPO/scripts/meeting-v2/dump-chunks.mjs" "$SCRATCH/test.db" "$id" \
    "$CMP/$RUN_LC-$short.json" || { echo "DUMP-FAIL $RUN_LC-$short" >&2; fail=1; }
  node "$REPO/scripts/meeting-v2/dump-turns.mjs" "$SCRATCH/test.db" "$id" \
    "$CMP/turns-$short.json" || { echo "DUMP-FAIL turns-$short" >&2; fail=1; }
  echo "=== $short done $(date +%H:%M:%S) ==="
done

if [ "$fail" -ne 0 ]; then
  echo "run-proof $RUN: finished with failures (see above)" >&2
fi
exit "$fail"
