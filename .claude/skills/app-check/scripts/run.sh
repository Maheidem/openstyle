#!/usr/bin/env bash
# App check of one built-in MLX LLM: real app, isolated profile, fictional data.
# Usage: .claude/skills/app-check/scripts/run.sh <catalog-model-id>
# Env: APP_CHECK_OUT (evidence dir), APP_CHECK_SKIP_BUILD=1, APP_CHECK_KEEP_SCRATCH=1,
#      APP_CHECK_WORKER (path of the mlx_asr_worker binary).
# Read .claude/skills/app-check/SKILL.md first.
set -euo pipefail

MODEL_ID=${1:?usage: run.sh <catalog-model-id>   (for example gemma-4-e4b-qat-4bit)}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
STAMP=$(date +%Y%m%d-%H%M%S)
OUT=${APP_CHECK_OUT:-/tmp/app-check/$MODEL_ID-$STAMP}
LOCK=/tmp/openstyle-gpu.lock
SPEC_DST="$REPO/apps/electron/tests/zz-proof-appcheck.test.ts"
BACK_ID=gemma-4-e2b-qat-4bit
BACK_HF=mlx-community/gemma-4-E2B-it-qat-4bit
REAL_HF="$HOME/.cache/huggingface/hub"
WORKER=${APP_CHECK_WORKER:-$HOME/.cache/freestyle/mlx-asr/runtime/darwin-arm64/mlx_asr_worker/mlx_asr_worker}
SAMPLER_PID=""
HAVE_LOCK=0

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

cleanup() {
  [[ -n $SAMPLER_PID ]] && kill "$SAMPLER_PID" 2>/dev/null || true
  rm -f "$SPEC_DST"
  if [[ $HAVE_LOCK == 1 ]]; then rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null || true; fi
  if [[ ${APP_CHECK_KEEP_SCRATCH:-0} != 1 ]]; then rm -rf "$OUT/scratch"; fi
}
trap cleanup EXIT

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

# 4. Spec copy, GPU lock, sampler.
cp "$HERE/app-check.spec.ts.txt" "$SPEC_DST"
until mkdir "$LOCK" 2>/dev/null; do
  echo "$(date +%T) GPU lock busy: $(cat "$LOCK/owner" 2>/dev/null)" | tee -a "$OUT/lock-wait.log"
  sleep 60
done
HAVE_LOCK=1
echo "app-check $MODEL_ID $(date -u +%H:%M:%SZ)" > "$LOCK/owner"

LOGS=~/Library/Logs/Openstyle
stat -f '%N %z %Sm' "$LOGS"/* > "$OUT/logs-before.txt" 2>&1 || true
START=$(date '+%Y-%m-%d %H:%M:%S')
df -h / | tail -1 > "$OUT/df-before.txt"
python3 -I "$HERE/sample-rss.py" "$OUT/app.pid" "$OUT/rss.csv" &
SAMPLER_PID=$!

# 5. Run through the Test Runner app (stable Privacy identity).
export APP_CHECK_OUT="$OUT" APP_CHECK_MODEL_ID="$MODEL_ID" APP_CHECK_MODEL_NAME="$MODEL_NAME" \
  APP_CHECK_HF_ID="$HF_ID" APP_CHECK_WORKER="$WORKER" \
  OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false
set +e
scripts/test-runner/run.sh "$REPO/apps/electron" -- timeout 5400 pnpm exec playwright test tests/zz-proof-appcheck.test.ts > "$OUT/run.log" 2>&1
CODE=$?
set -e

# 6. Evidence.
stat -f '%N %z %Sm' "$LOGS"/* > "$OUT/logs-after.txt" 2>&1 || true
df -h / | tail -1 > "$OUT/df-after.txt"
/usr/bin/log show --start "$START" --predicate 'subsystem == "com.apple.TCC"' --style compact 2>/dev/null | grep -c AUTHREQ_PROMPTING > "$OUT/tcc-prompts.txt" || true
UD=$(cat "$OUT/userdata.path" 2>/dev/null || true)
if [[ -n $UD && -f $UD/freestyle.db ]]; then
  sqlite3 -readonly "$UD/freestyle.db" ".backup $OUT/scratch/copy.db"
  sqlite3 -readonly -header "$OUT/scratch/copy.db" \
    "select step_key, provider, finish_unified, count(*) calls, round(avg(latency_ms)) avg_ms, max(latency_ms) max_ms from llm_calls group by 1,2,3" > "$OUT/llm-calls.txt" || true
fi
if [[ $(cmp -s "$OUT/logs-before.txt" "$OUT/logs-after.txt" && echo same) == same ]]; then LOGSTAT="logs unchanged"; else LOGSTAT="LOGS CHANGED (see logs-before/after.txt)"; fi

echo "=== run.log tail ==="; tail -12 "$OUT/run.log"
echo "=== results.json ==="; cat "$OUT/results.json" 2>/dev/null || echo "(none)"
echo "=== peak RSS (GiB) per worker kind ==="
python3 -I - "$OUT/rss.csv" <<'PY'
import csv, sys
peak = {}
for r in csv.DictReader(open(sys.argv[1])):
    peak[r["kind"]] = max(peak.get(r["kind"], 0), int(r["rss_kb"]))
for k, v in sorted(peak.items()):
    print(f"{k}: {v/1024/1024:.2f}")
PY
echo "=== llm_calls ==="; cat "$OUT/llm-calls.txt" 2>/dev/null || echo "(none)"
echo "=== TCC prompts since start (expect 0) ==="; cat "$OUT/tcc-prompts.txt"
echo "=== $LOGSTAT ==="
echo "=== artifacts in $OUT ==="; ls -1 "$OUT"/*.png 2>/dev/null
echo "playwright exit code: $CODE"
exit "$CODE"
