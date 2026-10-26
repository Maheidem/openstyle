#!/usr/bin/env bash
# Copies the audio of gold meetings out of the app folder into the eval audio
# dir, so the app's 30-day retention sweep cannot delete it. The app folder is
# read only (cp -p). Each copy is checked with sha256. Prints ids and hashes only.
#
# Usage:
#   scripts/meeting-v2/eval-audio-copy.sh <meeting-id> [<meeting-id> ...]
#
# Environment:
#   MEETING_EVAL_AUDIO_DIR  target (default ~/Library/Application Support/Openstyle-eval/audio)

set -euo pipefail

SRC_ROOT="$HOME/Library/Application Support/Openstyle/meetings"
DST_ROOT="${MEETING_EVAL_AUDIO_DIR:-$HOME/Library/Application Support/Openstyle-eval/audio}"

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <meeting-id> [<meeting-id> ...]" >&2
  exit 2
fi

for id in "$@"; do
  src="$SRC_ROOT/$id"
  dst="$DST_ROOT/$id"
  if [ ! -f "$src/mic.wav" ] || [ ! -f "$src/system.wav" ]; then
    echo "audio missing in the app folder: $id (already purged?)" >&2
    exit 1
  fi
  mkdir -p "$dst"
  for f in mic.wav system.wav sync.json; do
    [ -f "$src/$f" ] || continue
    cp -p "$src/$f" "$dst/$f"
    a="$(shasum -a 256 "$src/$f" | cut -d' ' -f1)"
    b="$(shasum -a 256 "$dst/$f" | cut -d' ' -f1)"
    if [ "$a" != "$b" ]; then
      echo "HASH MISMATCH $id/$f" >&2
      exit 1
    fi
    echo "ok $id/$f $a"
  done
done
