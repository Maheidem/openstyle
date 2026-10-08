#!/usr/bin/env bash
# Verify a published Openstyle release from the outside, like the updater does.
#   bash scripts/release-verify.sh <version>
# Checks: the release is published (not a draft) and has every asset; the
# latest-mac.yml feed names <version>; the zip and dmg match the feed sha512
# and size; the MLX worker from the release runs one forced alignment.
# Prints PASS/FAIL/SKIPPED per check and exits 1 on any FAIL.
# The worker check uses the aligner model already on disk
# (ALIGNER_HF_HOME, default /tmp/meeting-p4b-hf/hf) and never downloads it.
set -euo pipefail

REPO=Maheidem/openstyle
ALIGNER_MODEL=mlx-community/Qwen3-ForcedAligner-0.6B-8bit
ALIGNER_HF_HOME=${ALIGNER_HF_HOME:-/tmp/meeting-p4b-hf/hf}

version=${1:-}
if [ -z "$version" ]; then
  echo "usage: bash scripts/release-verify.sh <version>" >&2
  exit 2
fi

zip="Openstyle-$version-arm64.zip"
dmg="Openstyle-$version.dmg"
worker_tar="mlx_asr_worker-darwin-arm64.tar.gz"
required=(
  "$zip" "$dmg" latest-mac.yml "$worker_tar"
  "$zip.blockmap" "$dmg.blockmap"
  "Openstyle-$version-setup.exe" "Openstyle-$version-setup.exe.blockmap"
  "Openstyle-$version.AppImage" "Openstyle-$version.deb"
  latest.yml latest-linux.yml
)

failures=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"
  failures=$((failures + 1))
}
skip() { echo "SKIPPED  $1"; }

tmp=$(mktemp -d /tmp/release-verify.XXXXXX)
worker_pid=""
# shellcheck disable=SC2329 # the EXIT trap calls it
cleanup() {
  if [ -n "$worker_pid" ]; then kill "$worker_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

finish() {
  echo "---"
  if [ "$failures" -gt 0 ]; then
    echo "RESULT: FAIL ($failures check(s) failed) for $version"
    exit 1
  fi
  echo "RESULT: PASS for $version"
  exit 0
}

# 1. Release state and assets.
if ! info=$(timeout 30 gh release view "$version" --repo "$REPO" \
  --json isDraft,assets 2>"$tmp/gh.err"); then
  fail "release $version exists ($(head -1 "$tmp/gh.err"))"
  finish
fi
if [ "$(jq -r .isDraft <<<"$info")" = "false" ]; then
  pass "release $version is published (isDraft=false)"
else
  fail "release $version is a draft"
fi
assets=$(jq -r '.assets[].name' <<<"$info")
missing=()
for name in "${required[@]}"; do
  grep -qxF "$name" <<<"$assets" || missing+=("$name")
done
if [ "${#missing[@]}" -eq 0 ]; then
  pass "all ${#required[@]} required assets present"
else
  fail "missing assets: ${missing[*]}"
fi

# 2. Feed and binaries.
download() {
  timeout 900 gh release download "$version" --repo "$REPO" \
    -p "$1" -D "$tmp" --clobber 2>>"$tmp/gh.err"
}
if ! download latest-mac.yml; then
  fail "download latest-mac.yml"
  finish
fi
feed="$tmp/latest-mac.yml"
feed_version=$(awk '/^version:/ {print $2}' "$feed")
if [ "$feed_version" = "$version" ]; then
  pass "latest-mac.yml version is $version"
else
  fail "latest-mac.yml version is '$feed_version', expected $version"
fi

# Prints "<sha512> <size>" of the feed entry whose url is $1.
feed_entry() {
  awk -v want="$1" '
    $1 == "-" && $2 == "url:" { url = $3; next }
    url == want && $1 == "sha512:" { sha = $2 }
    url == want && $1 == "size:" { print sha, $2; exit }
  ' "$feed"
}

for file in "$zip" "$dmg"; do
  read -r want_sha want_size <<<"$(feed_entry "$file")" || true
  if [ -z "${want_sha:-}" ]; then
    fail "$file is listed in latest-mac.yml"
    continue
  fi
  if ! download "$file"; then
    fail "download $file"
    continue
  fi
  got_sha=$(openssl dgst -sha512 -binary "$tmp/$file" | base64 | tr -d '\n')
  got_size=$(stat -f %z "$tmp/$file")
  if [ "$got_sha" = "$want_sha" ]; then
    pass "$file sha512 matches the feed"
  else
    fail "$file sha512 $got_sha, feed has $want_sha"
  fi
  if [ "$got_size" = "$want_size" ]; then
    pass "$file size $got_size matches the feed"
  else
    fail "$file size $got_size, feed has $want_size"
  fi
  rm -f "${tmp:?}/$file"
done

# 3. Worker: one forced alignment with the released worker.
if [ "$(uname -sm)" != "Darwin arm64" ]; then
  skip "worker align check (needs macOS arm64)"
  finish
fi
if ! ls -d "$ALIGNER_HF_HOME/hub/models--${ALIGNER_MODEL//\//--}/snapshots/"* >/dev/null 2>&1; then
  skip "worker align check ($ALIGNER_MODEL not in $ALIGNER_HF_HOME; not downloaded on purpose)"
  finish
fi
if ! download "$worker_tar"; then
  fail "download $worker_tar"
  finish
fi
mkdir -p "$tmp/worker"
tar -xzf "$tmp/$worker_tar" -C "$tmp/worker"
worker=$(find "$tmp/worker" -type f -name mlx_asr_worker -perm -u+x | head -1)
if [ -z "$worker" ]; then
  fail "worker tarball holds an executable mlx_asr_worker"
  finish
fi

say -v Samantha -o "$tmp/align.aiff" "The quick brown fox jumps over the lazy dog."
afconvert -f WAVE -d LEI16@16000 "$tmp/align.aiff" "$tmp/align.wav"
request=$(jq -cn --arg path "$tmp/align.wav" '{
  id: "verify-1", type: "align", audio_path: $path, audio_format: "wav",
  sample_rate: 16000, language: "English",
  text: "The quick brown fox jumps over the lazy dog."
}')

# The worker loads the model, answers each stdin line, and exits on shutdown.
printf '%s\n%s\n' "$request" '{"type":"shutdown"}' >"$tmp/requests.jsonl"
HF_HOME=$ALIGNER_HF_HOME HF_HUB_OFFLINE=1 \
  timeout 300 "$worker" --model "$ALIGNER_MODEL" \
  <"$tmp/requests.jsonl" >"$tmp/worker.out" 2>"$tmp/worker.err" &
worker_pid=$!
worker_rc=0
wait "$worker_pid" || worker_rc=$?
worker_pid=""

reply=$(grep -F '"verify-1"' "$tmp/worker.out" | head -1 || true)
words=$(jq -r 'select(.type == "aligned") | .words | length' <<<"$reply" 2>/dev/null || true)
if [ -n "$words" ] && [ "$words" -gt 0 ]; then
  first=$(jq -c '.words[0]' <<<"$reply")
  pass "worker aligned $words words (first: $first)"
else
  fail "worker align reply (exit $worker_rc): ${reply:-<none>}; stderr: $(tail -3 "$tmp/worker.err" | tr '\n' ' ')"
fi
if [ "$worker_rc" -eq 0 ]; then
  pass "worker exited cleanly after shutdown"
else
  fail "worker exit code $worker_rc after shutdown"
fi

finish
