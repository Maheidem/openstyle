#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $2 != -- ]]; then
  echo "Usage: scripts/test-runner/run.sh <cwd> -- <command> [args...]" >&2
  exit 1
fi
bundle="$HOME/Applications/Openstyle Test Runner.app"
if [[ ! -d "$bundle" ]]; then
  echo "Test Runner bundle missing. Run: node scripts/test-runner/build.mjs" >&2
  exit 1
fi
cwd=$1
shift 2
jobdir=$(mktemp -d "${TMPDIR:-/tmp}/openstyle-runner.XXXXXX")
trap 'rm -rf "$jobdir"' EXIT
python3 -I - "$jobdir" "$cwd" "$@" <<'PY'
import json
import os
import sys

jobdir, cwd, *argv = sys.argv[1:]
with open(os.path.join(jobdir, "job.json"), "w", encoding="utf-8") as file:
    file.write(json.dumps({"cwd": cwd, "argv": argv, "env": dict(os.environ)}))
PY
# Read the job result even if Launch Services reports a failure.
open -W -n -g "$HOME/Applications/Openstyle Test Runner.app" --args "$jobdir" || true
if [[ -f "$jobdir/stdout.log" ]]; then
  cat "$jobdir/stdout.log"
fi
if [[ -f "$jobdir/stderr.log" ]]; then
  cat "$jobdir/stderr.log" >&2
fi
code=1
if [[ -f "$jobdir/exit-code" ]]; then
  code=$(<"$jobdir/exit-code")
fi
rm -rf "$jobdir"
trap - EXIT
exit "$code"
