#!/usr/bin/env bash
# Phase 0a (specs/meeting-transcription-v2.md, sections 5 and 7.2).
#
# Builds the isolated scratch profile: a fresh scratch DB seeded with the
# allow-listed rows of the real DB, plus one or more copied meeting folders.
# No product code. The real profile is read only (sqlite3 -readonly backup).
# This script prints counts and ids only. It never prints transcript text.
#
# Usage:
#   scripts/meeting-v2/setup-scratch.sh <meeting-id> [<meeting-id> ...]
#
# Environment:
#   SCRATCH   scratch dir (default /tmp/meeting-v2)
#   BOOT_PORT port for the one-time migration boot (default 4788, never 4649)
#   MEETING_EVAL_AUDIO_DIR  eval audio copies (default
#             ~/Library/Application Support/Openstyle-eval/audio). A meeting with
#             <dir>/<id>/mic.wav there is copied from it, not from the app folder.
#             The app deletes old meeting audio (retention sweep); see
#             scripts/meeting-v2/eval-audio-copy.sh.
#   MEETING_EVAL_SOURCE_DB  the DB to seed from (default: the real app DB).
#             The Eval Lab sets it to the frozen seed DB of its corpus.

set -euo pipefail

SCRATCH="${SCRATCH:-/tmp/meeting-v2}"
BOOT_PORT="${BOOT_PORT:-4788}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="$HOME/Library/Application Support/Openstyle"
REAL_DB="${MEETING_EVAL_SOURCE_DB:-$PROFILE/freestyle.db}"
SCRATCH_DB="$SCRATCH/test.db"
EVAL_AUDIO_DIR="${MEETING_EVAL_AUDIO_DIR:-$HOME/Library/Application Support/Openstyle-eval/audio}"

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <meeting-id> [<meeting-id> ...]" >&2
  exit 2
fi
if [ "$BOOT_PORT" = "4649" ]; then
  echo "refusing to use port 4649 (the installed app owns it)" >&2
  exit 2
fi

echo "scratch: $SCRATCH"

# --- 1. Copy the real DB into the scratch dir (WAL-safe, read-only) -------
mkdir -p "$SCRATCH/dbcopy" "$SCRATCH/meetings" "$SCRATCH/baseline"
sqlite3 -readonly "$REAL_DB" ".backup '$SCRATCH/dbcopy/real.db'"
SRC_DB="$SCRATCH/dbcopy/real.db"
# A second copy for ATTACH, so the backup stays pristine.
cp "$SRC_DB" "$SCRATCH/dbcopy/attach.db"

# --- 2. Copy the meeting folders, drop old transcripts from the copy ------
for id in "$@"; do
  if [ -f "$EVAL_AUDIO_DIR/$id/mic.wav" ]; then
    src_dir="$EVAL_AUDIO_DIR/$id"
    echo "audio source: eval copy ($id)"
  else
    src_dir="$PROFILE/meetings/$id"
    echo "audio source: app folder ($id)"
  fi
  if [ ! -d "$src_dir" ]; then
    echo "meeting dir missing: $src_dir" >&2
    exit 1
  fi
  rm -rf "$SCRATCH/meetings/$id"
  cp -R "$src_dir" "$SCRATCH/meetings/$id"
  rm -f "$SCRATCH/meetings/$id"/transcript*.md
  echo "copied meeting $id"
done

# --- 3. Fresh scratch DB; the server migrates it on a one-time boot -------
rm -f "$SCRATCH_DB" "$SCRATCH_DB-wal" "$SCRATCH_DB-shm"
: > "$SCRATCH_DB"
BOOT_TOKEN="$(uuidgen)"
(
  cd "$REPO_ROOT/apps/electron" \
    && exec env OPENSTYLE_DB_PATH="$SCRATCH_DB" PORT="$BOOT_PORT" \
      HOST=127.0.0.1 OPENSTYLE_AUTH_TOKEN="$BOOT_TOKEN" \
      node ../server/dist/startup.js > "$SCRATCH/bootstrap.log" 2>&1
) &
boot_pid=$!
stop_boot() {
  kill "$boot_pid" 2>/dev/null || true
  for _ in $(seq 1 25); do
    kill -0 "$boot_pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -9 "$boot_pid" 2>/dev/null || true
  wait "$boot_pid" 2>/dev/null || true
}
booted=0
for _ in $(seq 1 60); do
  if timeout 3 curl -s "http://127.0.0.1:$BOOT_PORT/api/health" >/dev/null 2>&1; then
    booted=1
    break
  fi
  sleep 1
done
if [ "$booted" -ne 1 ]; then
  echo "migration boot did not come up; see $SCRATCH/bootstrap.log" >&2
  stop_boot
  exit 1
fi
stop_boot
# The expected schema version is read from the branch's schema.ts so the
# check does not go stale when a migration lands (it was pinned at 36
# while the branch moved to 37 in phase 4).
SCHEMA_WANT="$(node -e "const fs=require('node:fs');const m=fs.readFileSync(process.argv[1],'utf8').match(/SCHEMA_VERSION = (\\d+)/);if(!m){process.exit(1)}console.log(m[1]);" "$REPO_ROOT/apps/server/src/lib/schema.ts")"
if [ "$(sqlite3 "$SCRATCH_DB" "select version from schema_version limit 1;")" != "$SCHEMA_WANT" ]; then
  echo "scratch DB was not migrated to schema $SCHEMA_WANT; see $SCRATCH/bootstrap.log" >&2
  exit 1
fi

# --- 4. Copy the allow-listed rows, insert the meetings rows --------------
# Copied: vocabulary rows, the `languages` and `owner_name` settings and the
# default llm row (built-in MLX only). MEETING_EVAL_OWNER_NAME sets
# `owner_name` in the scratch DB only. The default voice row is the built-in
# MLX ASR model.
# Never the api_keys table, never the own_servers rows.
node "$REPO_ROOT/scripts/meeting-v2/seed-scratch-db.mjs" "$SCRATCH" "$SCRATCH/dbcopy/attach.db" "$@"

# --- 5. Done-when checks (spec phase 0a) ----------------------------------
V_SCRATCH="$(sqlite3 "$SCRATCH_DB" "select count(*) from vocabulary;")"
V_REAL="$(sqlite3 "$SRC_DB" "select count(*) from vocabulary;")"
DEFAULTS="$(sqlite3 "$SCRATCH_DB" "select count(*) from model_configs where is_default=1;")"
API_KEYS="$(sqlite3 "$SCRATCH_DB" "select count(*) from api_keys;")"
STATUS_OK=1
for s in $(sqlite3 "$SCRATCH_DB" "select status from meetings;"); do
  [ "$s" = "recorded" ] || STATUS_OK=0
done
# Guard (7.2, owner rule 2026-10-21): only the app's built-in MLX models.
# No cloud model and no own-server model (nothing may call the owner's server).
PROVIDERS="$(sqlite3 "$SCRATCH_DB" "select distinct provider from model_configs where is_default=1 order by provider;" | tr '\n' ',')"
VOICE="$(sqlite3 "$SCRATCH_DB" "select model_id from model_configs where is_default=1 and type='voice';")"
OWN_SERVERS="$(sqlite3 "$SCRATCH_DB" "select count(*) from own_servers;")"

fail=0
echo "vocabulary: scratch=$V_SCRATCH real=$V_REAL"
[ "$V_SCRATCH" = "$V_REAL" ] || fail=1
echo "model_configs is_default=1: $DEFAULTS (want 2)"
[ "$DEFAULTS" = "2" ] || fail=1
echo "api_keys: $API_KEYS (want 0)"
[ "$API_KEYS" = "0" ] || fail=1
echo "meetings all recorded: $([ "$STATUS_OK" = 1 ] && echo yes || echo NO)"
[ "$STATUS_OK" = 1 ] || fail=1
echo "default model providers: $PROVIDERS (want local-mlx,local-mlx-llm,)"
[ "$PROVIDERS" = "local-mlx,local-mlx-llm," ] || fail=1
VOICE_WANT="local-mlx/${MEETING_EVAL_ASR_MODEL:-qwen3-1.7b-8bit}"
echo "default voice row: $VOICE (want $VOICE_WANT)"
[ "$VOICE" = "$VOICE_WANT" ] || fail=1
echo "own_servers: $OWN_SERVERS (want 0)"
[ "$OWN_SERVERS" = "0" ] || fail=1

if [ "$fail" -ne 0 ]; then
  echo "phase 0a checks FAILED" >&2
  exit 1
fi
echo "phase 0a checks passed"
