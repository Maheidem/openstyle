#!/usr/bin/env bash
# Memory-tier test: does live transcript + chat fit a small Mac?
# Runs on a big Mac. A ballast process holds (RAM - tier) of memory, the GPU
# cap is lowered with `sysctl iogpu.wired_limit_mb`, and the isolated app runs
# a live-chat load. A sampler measures the whole process tree with `footprint`.
# Method and measured facts: .claude/skills/memory-tier-test/SKILL.md
#
#   scripts/memory-tier-test.sh --tier 16 --minutes 30
#   scripts/memory-tier-test.sh --no-ballast --minutes 30     # baseline
#
# Exit codes: 0 pass, 1 a check failed, 2 bad usage or missing build,
# 3 the GPU cap is not set (the script prints the sudo commands), 4 GPU lock wait
# timed out.
# Works with the macOS bash 3.2.

set -uo pipefail
export LC_ALL=C

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
HERE=$REPO/scripts/memory-tier

TIER=""
MINUTES=30
NO_BALLAST=0
USE_SUDO=0
ALLOW_GPU_MISMATCH=0
GPU_PCT=84
RESERVE_GIB=2.5
OS_USED_GIB=auto
SWAPOUT_MAX=50000
LATENCY_FACTOR=1.5
BASELINE=""
OUT=""
WORKER=""
ASK_S=120
SAMPLE_S=5
LOCK_WAIT_MIN=180
LABEL=""

usage() {
  cat <<'EOF'
Usage: scripts/memory-tier-test.sh --tier <8|16|24> [options]
       scripts/memory-tier-test.sh --no-ballast [options]      (baseline)

  --tier N               RAM tier to simulate, in GiB. Budget = N - reserve.
  --minutes M            Load time. Default 30.
  --no-ballast           No ballast and no GPU check. Use it for the baseline.
  --gpu-pct P            GPU cap as percent of tier RAM. Default 84 (measured
                         107.5 of 128 GiB). Cap = floor(N * 1024 * P / 100) MB.
  --reserve-gib G        OS reserve. Default 2.5.
  --os-used-gib auto|G   Memory the OS and other apps use now. Ballast =
                         RAM - N - max(0, this - reserve). Default auto
                         (wired + compressor + active from vm_stat). Pass 2.5
                         on a clean Mac to get ballast = RAM - N.
  --swapout-max PAGES    Pass limit for swapouts during the run. Default 50000.
  --latency-factor F     Pass limit versus baseline. Default 1.5.
  --baseline FILE        summary.json of the baseline run.
  --sudo                 Set and restore the GPU cap with `sudo -n`. Works only
                         when `sudo -n true` works. Else the script prints the
                         commands for the owner.
  --allow-gpu-mismatch   Go on with the wrong GPU cap. The result is marked as
                         NOT a valid tier result.
  --out DIR              Results folder. Default ~/Library/Application Support/Openstyle-eval/memtier/<stamp>-<label>
                         (not /tmp: macOS tmp cleanup deletes eval data).
  --worker PATH          mlx_asr_worker binary (ASR, LLM and embed modes).
                         Default: dist/mlx_asr_worker in this checkout or in
                         the main checkout.
  --ask-seconds S        Chat question every S seconds. Default 120.
  --lock-wait-min M      Wait at most M minutes for the GPU lock. Default 180.
  --label TEXT           Name in the results folder.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tier) TIER=${2:-}; shift 2 ;;
    --minutes) MINUTES=${2:-}; shift 2 ;;
    --no-ballast) NO_BALLAST=1; shift ;;
    --gpu-pct) GPU_PCT=${2:-}; shift 2 ;;
    --reserve-gib) RESERVE_GIB=${2:-}; shift 2 ;;
    --os-used-gib) OS_USED_GIB=${2:-}; shift 2 ;;
    --swapout-max) SWAPOUT_MAX=${2:-}; shift 2 ;;
    --latency-factor) LATENCY_FACTOR=${2:-}; shift 2 ;;
    --baseline) BASELINE=${2:-}; shift 2 ;;
    --sudo) USE_SUDO=1; shift ;;
    --allow-gpu-mismatch) ALLOW_GPU_MISMATCH=1; shift ;;
    --out) OUT=${2:-}; shift 2 ;;
    --worker) WORKER=${2:-}; shift 2 ;;
    --ask-seconds) ASK_S=${2:-}; shift 2 ;;
    --lock-wait-min) LOCK_WAIT_MIN=${2:-}; shift 2 ;;
    --label) LABEL=${2:-}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$NO_BALLAST" = 0 ] && [ -z "$TIER" ]; then
  echo "--tier is required unless --no-ballast is set" >&2; usage >&2; exit 2
fi
if [ -n "$TIER" ]; then
  case "$TIER" in *[!0-9]* | "") echo "--tier must be a whole number of GiB" >&2; exit 2 ;; esac
fi
case "$MINUTES" in *[!0-9]* | "") echo "--minutes must be a whole number" >&2; exit 2 ;; esac
if [ "$USE_SUDO" = 1 ] && [ "$NO_BALLAST" = 1 ]; then
  echo "--sudo needs a tier run (no --no-ballast)" >&2; exit 2
fi

# ---- Facts of this Mac ------------------------------------------------------
MEMSIZE_BYTES=$(sysctl -n hw.memsize)
MEM_GIB=$(python3 -I -c "print(round($MEMSIZE_BYTES / 2**30, 2))")
GPU_NOW=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo "")

# Boot value of the GPU cap. A LaunchDaemon can set it. It is the value to
# restore. 0 gives the system default when there is no daemon. The daemon name
# holds the owner's handle, so the script finds it at run time by pattern.
GPU_RESTORE=""
for plist in /Library/LaunchDaemons/*iogpu*wired*.plist; do
  [ -f "$plist" ] || continue
  GPU_RESTORE=$(plutil -p "$plist" 2>/dev/null | grep -oE 'iogpu\.wired_limit_mb=[0-9]+' | head -1 | cut -d= -f2)
  [ -n "$GPU_RESTORE" ] && break
done
if [ -z "$GPU_RESTORE" ]; then
  GPU_RESTORE=$GPU_NOW
fi

GPU_CAP=""
BUDGET_GIB=""
if [ -n "$TIER" ]; then
  GPU_CAP=$(python3 -I -c "print(int($TIER * 1024 * $GPU_PCT / 100))")
  BUDGET_GIB=$(python3 -I -c "print($TIER - $RESERVE_GIB)")
fi

STAMP=$(date +%Y%m%d-%H%M%S)
if [ -z "$LABEL" ]; then
  if [ "$NO_BALLAST" = 1 ]; then LABEL=baseline; else LABEL=tier${TIER}; fi
fi
[ -n "$OUT" ] || OUT="$HOME/Library/Application Support/Openstyle-eval/memtier/$STAMP-$LABEL"
SCRATCH=/tmp/openstyle-memtier-$STAMP

print_owner_commands() {
  cat <<EOF

GPU cap is not set for tier $TIER GB.
  now:      iogpu.wired_limit_mb=$GPU_NOW
  needed:   iogpu.wired_limit_mb=$GPU_CAP   ($GPU_PCT % of $TIER GB)

Owner, run these two commands:
  1. set:     sudo sysctl iogpu.wired_limit_mb=$GPU_CAP
  2. restore: sudo sysctl iogpu.wired_limit_mb=$GPU_RESTORE      (run after the test)

Then run again:
  scripts/memory-tier-test.sh --tier $TIER --minutes $MINUTES${BASELINE:+ --baseline $BASELINE}
EOF
}

# ---- GPU cap ----------------------------------------------------------------
VALID_TIER=1
SUDO_SET=0
if [ "$NO_BALLAST" = 0 ] && [ "$GPU_NOW" != "$GPU_CAP" ]; then
  if [ "$USE_SUDO" = 1 ] && sudo -n true 2>/dev/null; then
    if sudo -n sysctl "iogpu.wired_limit_mb=$GPU_CAP" >/dev/null; then
      SUDO_SET=1
      echo "GPU cap set to $GPU_CAP MB with sudo. It is restored to $GPU_RESTORE MB at the end."
    else
      echo "sudo sysctl failed" >&2; exit 3
    fi
  elif [ "$ALLOW_GPU_MISMATCH" = 1 ]; then
    VALID_TIER=0
    echo "WARNING: GPU cap is $GPU_NOW MB, tier $TIER GB needs $GPU_CAP MB. Not a valid tier result."
  else
    [ "$USE_SUDO" = 1 ] && echo "--sudo given but 'sudo -n true' fails: no passwordless sudo."
    print_owner_commands
    exit 3
  fi
fi

# ---- Preconditions ----------------------------------------------------------
if [ ! -f "$REPO/apps/electron/out/main/index.js" ] || [ ! -f "$REPO/apps/server/dist/startup.js" ]; then
  echo "Build missing. Run: pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron build" >&2
  exit 2
fi
if [ -z "$WORKER" ]; then
  common=$(cd "$REPO" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##')
  for cand in "$REPO/dist/mlx_asr_worker/mlx_asr_worker" "$common/dist/mlx_asr_worker/mlx_asr_worker"; do
    if [ -x "$cand" ]; then WORKER=$cand; break; fi
  done
fi
if [ -z "$WORKER" ] || [ ! -x "$WORKER" ]; then
  echo "No mlx_asr_worker. Build one (scripts/build_mlx_asr_worker.sh) or pass --worker." >&2
  exit 2
fi
HF_SRC=${HUGGINGFACE_HUB_CACHE:-$HOME/.cache/huggingface/hub}
MODELS="models--mlx-community--Qwen3-ASR-1.7B-8bit models--mlx-community--gemma-4-E2B-it-qat-4bit"
EMBED_MODEL=models--jayyun98--embeddinggemma-2-text-270m-mlx-bf16
for m in $MODELS; do
  if [ ! -d "$HF_SRC/$m/snapshots" ]; then echo "Model not in the Hugging Face cache: $m" >&2; exit 2; fi
done
if [ ! -d "$HOME/Applications/Openstyle Test Runner.app" ]; then
  echo "Test Runner missing. Run: node scripts/test-runner/build.mjs" >&2; exit 2
fi
if ! command -v say >/dev/null || ! command -v afconvert >/dev/null; then
  echo "say and afconvert are needed for the fake audio" >&2; exit 2
fi

mkdir -p "$OUT" "$SCRATCH"

# ---- Cleanup ----------------------------------------------------------------
LOCK=/tmp/openstyle-gpu.lock
QUEUE=/tmp/openstyle-gpu.queue
HAVE_LOCK=0
BALLAST_PID=""
SAMPLER_PID=""
# shellcheck disable=SC2329 # runs through trap
cleanup() {
  trap - EXIT INT TERM
  touch "$OUT/.stop" 2>/dev/null
  if [ -n "$SAMPLER_PID" ]; then wait "$SAMPLER_PID" 2>/dev/null; fi
  if [ -n "$BALLAST_PID" ]; then
    kill "$BALLAST_PID" 2>/dev/null
    wait "$BALLAST_PID" 2>/dev/null
  fi
  if [ "$SUDO_SET" = 1 ]; then
    sudo -n sysctl "iogpu.wired_limit_mb=$GPU_RESTORE" >/dev/null 2>&1 \
      && echo "GPU cap restored to $GPU_RESTORE MB." \
      || echo "FAILED to restore the GPU cap. Run: sudo sysctl iogpu.wired_limit_mb=$GPU_RESTORE"
  fi
  if [ "$HAVE_LOCK" = 1 ]; then rm -rf "$LOCK"; fi
  if [ -f "$QUEUE" ]; then
    grep -v " memtier-$STAMP " "$QUEUE" > "$QUEUE.$$" 2>/dev/null; cat "$QUEUE.$$" > "$QUEUE" 2>/dev/null; rm -f "$QUEUE.$$"
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT INT TERM

# ---- GPU lock (shared with the other Openstyle sessions) ---------------------
# mkdir is atomic. The queue is binding: an older line of another session goes first.
echo "claude memtier-$STAMP $((MINUTES + 15))min $(date +%H:%M)" >> "$QUEUE"
waited=0
while :; do
  head_line=$(head -1 "$QUEUE" 2>/dev/null)
  case "$head_line" in
    "" | *" memtier-$STAMP "*) my_turn=1 ;;
    *) my_turn=0 ;;
  esac
  if [ "$my_turn" = 0 ]; then
    # The head of the queue is a line of another session. It may be stale. Report, never remove.
    :
  fi
  if [ "$my_turn" = 1 ] && mkdir "$LOCK" 2>/dev/null; then
    HAVE_LOCK=1
    echo "memtier-$STAMP memory-tier $(date +%H:%M)" > "$LOCK/owner"
    break
  fi
  if [ "$waited" -ge "$((LOCK_WAIT_MIN * 60))" ]; then
    echo "GPU lock wait timed out. Holder: $(cat "$LOCK/owner" 2>/dev/null). Queue head: $head_line" >&2
    exit 4
  fi
  if [ $((waited % 300)) = 0 ]; then
    echo "$(date +%H:%M) waiting for the GPU lock. holder: $(cat "$LOCK/owner" 2>/dev/null) | queue head: $head_line"
  fi
  sleep 30; waited=$((waited + 30))
done
echo "GPU lock taken."

# ---- Isolated environment ---------------------------------------------------
# shellcheck disable=SC1091 # not followed: its `return` confuses the reachability check
. "$REPO/scripts/isolated-env.sh" "$SCRATCH" "$WORKER" > "$OUT/isolated-env.log" || exit 2
mkdir -p "$SCRATCH/cache"
export OPENSTYLE_MODEL_CACHE_DIR=$SCRATCH/cache
export OPENSTYLE_MLX_LLM_WORKER=$WORKER
for m in $MODELS; do cp -cR "$HF_SRC/$m" "$HUGGINGFACE_HUB_CACHE/" || cp -R "$HF_SRC/$m" "$HUGGINGFACE_HUB_CACHE/"; done
if [ -d "$HF_SRC/$EMBED_MODEL/snapshots" ]; then
  cp -cR "$HF_SRC/$EMBED_MODEL" "$HUGGINGFACE_HUB_CACHE/" || cp -R "$HF_SRC/$EMBED_MODEL" "$HUGGINGFACE_HUB_CACHE/"
  export OPENSTYLE_MLX_EMBED_WORKER=$WORKER
fi

# ---- Fake audio: a fictional script, looped to cover the run ----------------
AUDIO=$SCRATCH/script.wav
build_audio() {
  local i=0 line
  mkdir -p "$SCRATCH/say"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    i=$((i + 1))
    say -v Samantha -o "$SCRATCH/say/s$i.aiff" "$line" || return 1
    afconvert -f WAVE -d LEI16@16000 "$SCRATCH/say/s$i.aiff" "$SCRATCH/say/s$i.wav" || return 1
  done <<'SCRIPT'
Good morning everyone, thanks for joining the Larkspur planning call.
The first item is the schedule for the Wren Valley pilot.
Dana said the survey team will finish the site visits by the twelfth of March.
I think the budget for the pilot is still four hundred thousand dollars.
Omar is responsible for the permit paperwork, and he expects an answer next Tuesday.
We need a decision on the supplier before the end of the week.
Priya suggested we compare two quotes for the sensor kits.
The cheaper quote arrives later, so the schedule might slip by five days.
Let us write that risk down and review it again on Thursday.
Next, the training sessions for the field staff start on the second of April.
Marta will prepare the slides, and Jonas will book the meeting room.
Does anyone have a concern about the new reporting template?
The template looks fine, but the monthly cost table needs one more column.
I will add the column and send the file to the whole team tomorrow.
The last topic is the press note for the pilot launch.
We agreed to wait for the permit before we announce anything.
Thanks everyone, the next call is on Monday at ten.
SCRIPT
  python3 -I - "$SCRATCH/say" "$AUDIO" "$((MINUTES + 4))" <<'PY'
import glob, os, sys, wave
src, dst, minutes = sys.argv[1], sys.argv[2], int(sys.argv[3])
files = sorted(glob.glob(os.path.join(src, "s*.wav")), key=lambda p: int(os.path.basename(p)[1:-4]))
gap = b"\x00\x00" * int(16000 * 1.2)
body = b""
for f in files:
    with wave.open(f, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
        body += w.readframes(w.getnframes()) + gap
need = minutes * 60 * 16000 * 2
pcm = (body * (need // len(body) + 1))[:need]
with wave.open(dst, "wb") as out:
    out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
    out.writeframes(pcm)
print(f"audio: {len(pcm) / 32000:.0f} s, one loop {len(body) / 32000:.0f} s")
PY
}
build_audio || { echo "Audio build failed" >&2; exit 2; }

# ---- Ballast ----------------------------------------------------------------
vm_gib() { # <field regex> -> GiB
  vm_stat | awk -v pat="$1" '/page size of/ {ps=$8} $0 ~ pat {gsub("\\.","",$NF); s+=$NF} END {printf "%.2f", s*ps/2^30}'
}
OS_USED_MEASURED=$(python3 -I -c "print(round($(vm_gib '^Pages wired down') + $(vm_gib '^Pages occupied by compressor') + $(vm_gib '^Pages active'), 2))")
if [ "$OS_USED_GIB" = auto ]; then OS_USED_GIB=$OS_USED_MEASURED; fi
BALLAST_GIB=0
if [ "$NO_BALLAST" = 0 ]; then
  BALLAST_GIB=$(python3 -I -c "
extra = max(0.0, $OS_USED_GIB - $RESERVE_GIB)
print(max(0.0, round($MEM_GIB - $TIER - extra, 1)))")
  echo "RAM $MEM_GIB GiB, tier $TIER GiB, OS and apps use $OS_USED_GIB GiB: ballast $BALLAST_GIB GiB."
  python3 -I "$HERE/ballast.py" --gib "$BALLAST_GIB" > "$OUT/ballast.log" 2>&1 &
  BALLAST_PID=$!
  for _ in $(seq 1 600); do
    grep -q '^READY' "$OUT/ballast.log" 2>/dev/null && break
    kill -0 "$BALLAST_PID" 2>/dev/null || { echo "Ballast died:"; cat "$OUT/ballast.log"; exit 1; }
    sleep 1
  done
  grep -q '^READY' "$OUT/ballast.log" || { echo "Ballast not ready after 10 minutes" >&2; exit 1; }
  sleep 10
  echo "Ballast ready. Footprint: $(footprint "$BALLAST_PID" 2>/dev/null | awk '/Footprint:/ {print $2, $3; exit}'). Free level: $(sysctl -n kern.memorystatus_level) %."
fi

# ---- Sampler ----------------------------------------------------------------
tree_pids() {
  local c
  echo "$1"
  for c in $(pgrep -P "$1" 2>/dev/null); do tree_pids "$c"; done
}
vmval() { vm_stat | awk -v k="$1" '$0 ~ "^"k":" {gsub("\\.","",$NF); print $NF; exit}'; }

echo "t_s,app_fp_mb,n_procs,ballast_fp_mb,swap_used_mb,swapouts,swapins,pageouts,pressure,free_pct,wired_gb,compressor_gb" > "$OUT/samples.csv"
echo "t_s,pid,name,fp_mb" > "$OUT/procs.csv"
sampler() {
  local start now t root pids ball sw wired comp fp n
  start=$(date +%s)
  while [ ! -f "$OUT/.stop" ]; do
    now=$(date +%s); t=$((now - start))
    root=""; [ -f "$OUT/app.pid" ] && root=$(cat "$OUT/app.pid")
    fp=""; n=0
    if [ -n "$root" ] && kill -0 "$root" 2>/dev/null; then
      pids=$(tree_pids "$root" | tr '\n' ' ')
      # shellcheck disable=SC2086
      if footprint -j "$SCRATCH/fp.json" $pids >/dev/null 2>&1; then
        read -r fp n < <(python3 -I - "$SCRATCH/fp.json" "$OUT/procs.csv" "$t" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
with open(sys.argv[2], "a") as f:
    for p in d["processes"]:
        f.write(f'{sys.argv[3]},{p["pid"]},{p["name"].replace(",", " ")},{p["footprint"] / 2**20:.1f}\n')
print(f'{d["total footprint"] / 2**20:.1f}', len(d["processes"]))
PY
)
      fi
    fi
    ball=""
    if [ -n "$BALLAST_PID" ]; then
      ball=$(footprint -j "$SCRATCH/fb.json" "$BALLAST_PID" >/dev/null 2>&1 && python3 -I -c "import json;print(round(json.load(open('$SCRATCH/fb.json'))['total footprint']/2**20))")
    fi
    sw=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/')
    wired=$(python3 -I -c "print(round($(vmval 'Pages wired down') * 16384 / 2**30, 2))")
    comp=$(python3 -I -c "print(round($(vmval 'Pages occupied by compressor') * 16384 / 2**30, 2))")
    echo "$t,$fp,$n,$ball,$sw,$(vmval Swapouts),$(vmval Swapins),$(vmval Pageouts),$(sysctl -n kern.memorystatus_vm_pressure_level),$(sysctl -n kern.memorystatus_level),$wired,$comp" >> "$OUT/samples.csv"
    sleep "$SAMPLE_S"
  done
}
rm -f "$OUT/.stop" "$OUT/app.pid" "$OUT/spec.done"
sampler &
SAMPLER_PID=$!

# ---- Run the app ------------------------------------------------------------
cat > "$OUT/meta.json" <<EOF
{"label":"$LABEL","stamp":"$STAMP","tier_gib":"${TIER}","minutes":$MINUTES,"no_ballast":$NO_BALLAST,
 "mem_gib":$MEM_GIB,"reserve_gib":$RESERVE_GIB,"budget_gib":"${BUDGET_GIB}","gpu_pct":$GPU_PCT,
 "gpu_cap_mb":"${GPU_CAP}","gpu_limit_mb_at_start":"${GPU_NOW}","gpu_restore_mb":"${GPU_RESTORE}",
 "valid_tier":$VALID_TIER,"ballast_gib":$BALLAST_GIB,"os_used_gib":$OS_USED_GIB,"os_used_measured_gib":$OS_USED_MEASURED,
 "swapout_max_pages":$SWAPOUT_MAX,"latency_factor":$LATENCY_FACTOR,"baseline":"${BASELINE}"}
EOF
RUN_START=$(date +%s)
echo "Run start $(date +%H:%M:%S): $MINUTES minutes of live chat."
OPENSTYLE_MEMTIER_OUT=$OUT OPENSTYLE_MEMTIER_MINUTES=$MINUTES OPENSTYLE_MEMTIER_ASK_S=$ASK_S \
  OPENSTYLE_E2E_FAKE_MEETING_AUDIO=$AUDIO OPENSTYLE_E2E_OMLX_URL=http://127.0.0.1:1 \
  OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false \
  "$REPO/scripts/test-runner/run.sh" "$REPO/apps/electron" -- \
  env HOME="$OPENSTYLE_ISOLATED_HOME" timeout "$(((MINUTES + 15) * 60))" \
  ./node_modules/.bin/playwright test tests/memory-tier.test.ts > "$OUT/playwright.log" 2>&1
TEST_RC=$?
RUN_END=$(date +%s)
echo "Run end $(date +%H:%M:%S), test exit code $TEST_RC."

touch "$OUT/.stop"
wait "$SAMPLER_PID" 2>/dev/null; SAMPLER_PID=""
echo "$TEST_RC" > "$OUT/test-exit-code"

# Kernel memory-pressure kills in the run window (empty = none).
/usr/bin/log show --start "$(date -r "$RUN_START" '+%Y-%m-%d %H:%M:%S')" --end "$(date -r "$RUN_END" '+%Y-%m-%d %H:%M:%S')" \
  --predicate 'process == "kernel" AND eventMessage CONTAINS "memorystatus"' --style compact 2>/dev/null \
  | grep -v '^Timestamp' > "$OUT/kernel-memorystatus.log" || true

# ---- Summary ----------------------------------------------------------------
python3 -I - "$OUT" <<'PY'
import csv, glob, json, os, re, statistics, sys

out = sys.argv[1]
meta = json.load(open(f"{out}/meta.json"))
WARMUP_S = 120


def rows(name):
    path = f"{out}/{name}"
    return list(csv.DictReader(open(path))) if os.path.exists(path) else []


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pct(values, p):
    values = sorted(values)
    if not values:
        return None
    k = (len(values) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


samples = rows("samples.csv")
procs = rows("procs.csv")
lat = rows("latency.csv")
chat = rows("chat.csv")
live = rows("live.csv")

fp = [num(s["app_fp_mb"]) for s in samples if num(s["app_fp_mb"]) is not None]
peak_mb = max(fp) if fp else None

# Peak per process group (sum of the processes with the same name in one sample).
groups = {}
for r in procs:
    groups.setdefault((r["t_s"], r["name"]), 0.0)
    groups[(r["t_s"], r["name"])] += num(r["fp_mb"]) or 0
peak_group = {}
for (t, name), v in groups.items():
    peak_group[name] = max(peak_group.get(name, 0), v)

so = [num(s["swapouts"]) for s in samples if num(s["swapouts"]) is not None]
swapouts = (so[-1] - so[0]) if len(so) > 1 else None
sw_used = [num(s["swap_used_mb"]) for s in samples if num(s["swap_used_mb"]) is not None]
press = [int(num(s["pressure"])) for s in samples if num(s["pressure"]) is not None]
free = [num(s["free_pct"]) for s in samples if num(s["free_pct"]) is not None]
ball = [num(s["ballast_fp_mb"]) for s in samples if num(s["ballast_fp_mb"]) is not None]


def lag(kind):
    return [num(r["lag_ms"]) for r in lat if r["kind"] == kind and num(r["t_s"]) >= WARMUP_S]


ready = [r for r in live if r["status"] == "ready"]
chat_ok = [r for r in chat if r["http"] == "200"]
chat_wall = [num(r["wall_ms"]) for r in chat_ok]
chat_warm = chat_wall[1:] if len(chat_wall) > 1 else chat_wall

# Errors in logs.
patterns = re.compile(
    r"OutOfMemory|kIOGPUCommandBufferCallbackError|worker exited unexpectedly|jetsam|SIGKILL|MlxLlmPoolNoRoom|no room for|Cannot allocate memory|std::bad_alloc|MemoryError",
    re.I,
)
hits = []
for path in glob.glob(f"{out}/app-logs/**/*.log", recursive=True) + [f"{out}/playwright.log"]:
    try:
        for line in open(path, errors="replace"):
            if patterns.search(line):
                hits.append(f"{os.path.basename(path)}: {line.strip()[:160]}")
    except OSError:
        pass
kernel = []
if os.path.exists(f"{out}/kernel-memorystatus.log"):
    kernel = [l.strip() for l in open(f"{out}/kernel-memorystatus.log") if re.search(r"kill|jetsam|exceed", l, re.I)]
test_rc = int(open(f"{out}/test-exit-code").read().strip()) if os.path.exists(f"{out}/test-exit-code") else None

stats = {
    "live_partial_p50_ms": pct(lag("partial"), 50),
    "live_partial_p95_ms": pct(lag("partial"), 95),
    "live_final_p50_ms": pct(lag("final"), 50),
    "live_final_p95_ms": pct(lag("final"), 95),
    "live_http_p95_ms": pct([num(r["http_ms"]) for r in live if num(r["http_ms"]) is not None], 95),
    "chat_p50_ms": pct(chat_warm, 50),
    "chat_max_ms": max(chat_wall) if chat_wall else None,
    "chat_first_ms": chat_wall[0] if chat_wall else None,
    "chat_answers": len(chat_ok),
    "chat_asked": len(chat),
    "partial_events": len(lag("partial")),
    "final_events": len(lag("final")),
    "live_polls": len(live),
    "live_ready_polls": len(ready),
}

checks = []


def check(name, ok, detail):
    checks.append({"name": name, "result": "PASS" if ok else ("SKIP" if ok is None else "FAIL"), "detail": detail})


budget_mb = float(meta["budget_gib"]) * 1024 if meta["budget_gib"] else None
if budget_mb is not None and peak_mb is not None:
    check("peak footprint <= budget", peak_mb <= budget_mb, f"peak {peak_mb:.0f} MB, budget {budget_mb:.0f} MB")
else:
    check("peak footprint <= budget", None, f"peak {peak_mb} MB, no tier budget (baseline)")
check("live ran", bool(ready) and (stats["final_events"] > 0),
      f"{len(ready)} ready polls of {len(live)}, {stats['final_events']} final lines after warm-up")
if meta["no_ballast"]:
    check("swapouts below limit", None, f"{swapouts} pages (no ballast: informational)")
else:
    check("swapouts below limit", swapouts is not None and swapouts < meta["swapout_max_pages"],
          f"{swapouts} pages, limit {meta['swapout_max_pages']}")
check("pressure not critical", bool(press) and max(press) < 4,
      f"levels seen {sorted(set(press))} (1 normal, 2 warn, 4 critical); level>1 in {sum(1 for p in press if p > 1)} of {len(press)} samples")
check("no OOM or worker kill", test_rc == 0 and not hits and not kernel,
      f"test exit {test_rc}, {len(hits)} log hits, {len(kernel)} kernel kill lines" + (f"; first: {hits[0]}" if hits else ""))

base_path = meta.get("baseline")
if base_path and os.path.exists(base_path):
    base = json.load(open(base_path))["stats"]
    f = meta["latency_factor"]
    worst = []
    for key in ("live_partial_p95_ms", "live_final_p95_ms", "chat_p50_ms"):
        a, b = stats.get(key), base.get(key)
        if a is not None and b:
            worst.append((key, a, b, a <= f * b))
    check("latency <= factor x baseline", all(w[3] for w in worst) if worst else None,
          "; ".join(f"{k} {a:.0f} vs {b:.0f} ms" for k, a, b, _ in worst) or "no comparable values")
else:
    check("latency <= factor x baseline", None, "no --baseline file")

fails = [c for c in checks if c["result"] == "FAIL"]
verdict = "FAIL" if fails else "PASS"
if meta["no_ballast"]:
    verdict = "BASELINE (reference values, no tier)"
elif not meta["valid_tier"]:
    verdict = f"INVALID TIER RESULT: GPU cap was {meta['gpu_limit_mb_at_start']} MB, needs {meta['gpu_cap_mb']} MB. Checks: {'FAIL' if fails else 'pass'}"

summary = {
    "meta": meta,
    "verdict": verdict,
    "checks": checks,
    "stats": stats,
    "peak_footprint_mb": peak_mb,
    "peak_footprint_by_process_mb": dict(sorted(peak_group.items(), key=lambda kv: -kv[1])),
    "swapouts_pages": swapouts,
    "swap_used_mb_max": max(sw_used) if sw_used else None,
    "free_level_pct_min": min(free) if free else None,
    "ballast_footprint_mb_min_max": [min(ball), max(ball)] if ball else None,
    "log_hits": hits[:20],
}
json.dump(summary, open(f"{out}/summary.json", "w"), indent=2)

lines = [f"Memory-tier result: {verdict}", f"Run: {meta['label']}, {meta['minutes']} min, RAM {meta['mem_gib']} GiB, tier {meta['tier_gib'] or '-'} GiB, ballast {meta['ballast_gib']} GiB, GPU cap at start {meta['gpu_limit_mb_at_start']} MB"]
for c in checks:
    lines.append(f"  [{c['result']}] {c['name']}: {c['detail']}")
lines.append(f"Peak footprint of the app tree: {peak_mb:.0f} MB" if peak_mb else "Peak footprint: no data")
for name, v in list(summary["peak_footprint_by_process_mb"].items())[:8]:
    lines.append(f"    {name}: {v:.0f} MB")
lines.append("Latency (after %d s warm-up): " % WARMUP_S + ", ".join(f"{k}={v:.0f}" for k, v in stats.items() if k.endswith("_ms") and v is not None))
lines.append(f"Swap used max {summary['swap_used_mb_max']} MB, free level min {summary['free_level_pct_min']} %")
if summary["ballast_footprint_mb_min_max"]:
    lines.append("Ballast footprint min/max MB (must stay near its size): %s" % summary["ballast_footprint_mb_min_max"])
open(f"{out}/summary.txt", "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
sys.exit(1 if fails and not meta["no_ballast"] else 0)
PY
SUMMARY_RC=$?
echo "Results: $OUT"
exit "$SUMMARY_RC"
