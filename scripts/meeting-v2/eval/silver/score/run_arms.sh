#!/bin/bash
# Run several arms one after the other (ASR only) and keep each raw DB
# (private, 0600) in $SILVER_ARMS_KEEP (default ~/.openstyle-eval/silver/arms).
# Keep the arm DBs until the analysis ends: a cleanup forced 3 re-runs on 2026-10-28.
#
# usage: run_arms.sh <arm>[:ENV=value[;ENV=value]] ...
# example (the 2026-10-29 silver-3.3 run on the poc/arms-rescore worktree):
#   SEED_OWNER_NAME=<owner first name> run_arms.sh \
#     s33-A:OPENSTYLE_ASR_ATTENDEE_TERMS=0 s33-B:OPENSTYLE_ASR_ATTENDEE_TERMS=1 \
#     s33-B2:OPENSTYLE_ASR_ATTENDEE_TERMS=2 s33-B3:OPENSTYLE_ASR_ATTENDEE_TERMS=3
set -u
[ $# -ge 1 ] || { sed -n 2,11p "$0"; exit 2; }
SP=$(dirname "$0"); E=${SILVER_EVAL_HOME:-/tmp/meeting-eval}
KEEP=${SILVER_ARMS_KEEP:-$HOME/.openstyle-eval/silver/arms}
REPO=$(cd "$SP/../../../../.." && pwd)
case "$KEEP/" in "$REPO"/*) echo "SILVER_ARMS_KEEP points into the repo; arm DBs hold meeting text"; exit 2;; esac
mkdir -p -m 700 "$KEEP"
for x in "$@"; do
  arm=${x%%:*}; envs=""; [ "$x" != "$arm" ] && envs=${x#*:}
  ( IFS=';'; for kv in $envs; do export "${kv?}"; done; "$SP/run_arm.sh" "$arm" ) || { echo "arm $arm failed"; exit 1; }
  install -m 600 "$E/out/$arm/raw.db" "$KEEP/$arm.db" && echo "kept $arm.db"
done
echo ALL_DONE
