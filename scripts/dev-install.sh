#!/usr/bin/env bash
# One-command local build of "Openstyle Dev" (arm64, unpacked .app), installed
# to ~/Applications/Openstyle Dev.app next to the installed Openstyle.
# Docs: .claude/skills/live-testing/SKILL.md, section "Openstyle Dev build".
#
#   pnpm dev:install                 build origin/main (after a fetch)
#   pnpm dev:install --ref <rev>     build another rev (local branch, origin/<b>, sha)
#   pnpm dev:install --dry-run       print each step, change nothing
#   pnpm dev:install --adhoc         no Developer ID: ad-hoc signature (agents, tests)
#   pnpm dev:install --build-only    stop after the build: no quit, install or open
#
# OPENSTYLE_DEVBUILD_DIR moves the build worktree (default ../openstyle-devbuild
# next to the main checkout). The worktree belongs to this script: it is
# detached and holds no work.
set -euo pipefail

BUNDLE_ID="com.openstyle.app.dev"
PRODUCT="Openstyle Dev"
DEST_DIR="$HOME/Applications"
DEST="$DEST_DIR/$PRODUCT.app"

REF="origin/main"
DRY=0
ADHOC=0
BUILD_ONLY=0
usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || { echo "error: --ref needs a value" >&2; exit 2; }; REF="$2"; shift ;;
    --ref=*) REF="${1#--ref=}" ;;
    --dry-run) DRY=1 ;;
    --adhoc) ADHOC=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

step() { echo; echo "== $* =="; }
# run <cmd...>: print the command, then run it (only print it with --dry-run).
run() {
  printf '+'; printf ' %q' "$@"; echo
  [ "$DRY" -eq 1 ] || "$@"
}
# run_in <dir> <cmd...>: the same, with <dir> as the working folder.
run_in() {
  local dir="$1"; shift
  printf '+ (cd %q)' "$dir"; printf ' %q' "$@"; echo
  [ "$DRY" -eq 1 ] || (cd "$dir" && "$@")
}
die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "Openstyle Dev builds only on macOS."
[ "$(uname -m)" = arm64 ] || die "Openstyle Dev builds only on Apple Silicon (arm64)."

# The main checkout: the parent of the shared .git folder (also from a worktree).
COMMON_GIT="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(dirname "$COMMON_GIT")"
WT="${OPENSTYLE_DEVBUILD_DIR:-$(dirname "$MAIN_ROOT")/openstyle-devbuild}"
APP_SRC="$WT/apps/electron/dist/mac-arm64/$PRODUCT.app"

step "1. Signing identity"
SIGN_ENV=()
if [ "$ADHOC" -eq 1 ]; then
  echo "ad-hoc signature (--adhoc): no keychain access"
  SIGN_ENV=(OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false)
elif [ "$DRY" -eq 1 ]; then
  echo "+ security find-identity -v -p codesigning   (first \"Developer ID Application\" line)"
  SIGN_ENV=(OPENSTYLE_DEV_SIGN_IDENTITY="<sha-1 of the Developer ID Application identity>")
else
  line="$(security find-identity -v -p codesigning | grep '"Developer ID Application:' | head -n 1 || true)"
  [ -n "$line" ] || die 'no "Developer ID Application" identity in the keychain.
  Check: security find-identity -v -p codesigning
  Install the Developer ID certificate with its private key in the login keychain,
  or build without it: pnpm dev:install --adhoc'
  HASH="$(echo "$line" | awk '{print $2}')"
  NAME="$(echo "$line" | sed -E 's/^[^"]*"(.*)"[^"]*$/\1/')"
  echo "identity: $NAME ($HASH)"
  # dev-sign.mjs accepts a SHA-1 hash. electron-builder refuses a name that
  # starts with "Developer ID Application:".
  SIGN_ENV=(OPENSTYLE_DEV_SIGN_IDENTITY="$HASH")
fi

step "2. Worktree $WT at $REF"
run git -C "$MAIN_ROOT" fetch --prune origin
SHA="$(git -C "$MAIN_ROOT" rev-parse --verify --quiet "$REF^{commit}" || true)"
[ -n "$SHA" ] || die "unknown rev: $REF (use a local branch, origin/<branch> or a sha)"
echo "rev: $REF = $SHA$([ "$DRY" -eq 1 ] && echo ' (before the fetch)')"
if [ -e "$WT/.git" ]; then
  # The worktree holds no work. Stop rather than drop an edit.
  dirty="$(git -C "$WT" status --porcelain --untracked-files=no)"
  [ -z "$dirty" ] || die "the build worktree $WT has changed tracked files:
$dirty
  It belongs to dev:install. Move the changes away, then: git -C \"$WT\" checkout -- ."
  run git -C "$WT" checkout --quiet --detach "$SHA"
else
  run git -C "$MAIN_ROOT" worktree add --detach "$WT" "$SHA"
fi

step "3. Dependencies"
run pnpm -C "$WT" install --frozen-lockfile

step "4. Build $PRODUCT (arm64, unpacked)"
E="$WT/apps/electron"
run pnpm -C "$WT" turbo build --filter=@openstyle/server
run env "${SIGN_ENV[@]}" pnpm -C "$E" run compile:native
run pnpm -C "$E" run copy:sqlite-vec
run env "${SIGN_ENV[@]}" pnpm -C "$E" run download:ffmpeg
if [ -n "$(ls -A "$E/resources/whisper/darwin-arm64" 2>/dev/null)" ]; then
  echo "whisper.cpp binaries present, skip"
else
  run_in "$E" node scripts/download-whisper-cpp.mjs --resources
fi
run pnpm -C "$E" exec electron-vite build
# dev-sign.mjs adds -c.mac.identity=<hash> -c.mac.notarize=false when the
# identity is set (else ad-hoc). extraMetadata goes into the packaged
# package.json: the product name gives the own userData and log folders, the
# flavor flag turns on the rest (apps/electron/src/main/flavor.ts).
run_in "$E" env "${SIGN_ENV[@]}" node scripts/dev-sign.mjs builder --mac dir --arm64 --publish never \
  -c.appId="$BUNDLE_ID" \
  -c.productName="$PRODUCT" \
  -c.extraMetadata.productName="$PRODUCT" \
  -c.extraMetadata.openstyleFlavor=dev \
  -c.mac.hardenedRuntime=true
[ "$DRY" -eq 1 ] || [ -d "$APP_SRC" ] || die "build finished but $APP_SRC is missing"

if [ "$BUILD_ONLY" -eq 1 ]; then
  echo
  echo "built (--build-only): $APP_SRC"
  exit 0
fi

step "5. Quit a running $PRODUCT (bundle id $BUNDLE_ID only)"
# "is running" never launches the app. The installed Openstyle has another id.
if [ "$DRY" -eq 1 ]; then
  echo "+ osascript -e 'application id \"$BUNDLE_ID\" is running'  -> quit it, wait up to 20 s"
elif [ "$(osascript -e "application id \"$BUNDLE_ID\" is running")" = true ]; then
  osascript -e "tell application id \"$BUNDLE_ID\" to quit"
  for _ in $(seq 1 40); do
    [ "$(osascript -e "application id \"$BUNDLE_ID\" is running")" = true ] || break
    sleep 0.5
  done
  [ "$(osascript -e "application id \"$BUNDLE_ID\" is running")" = true ] \
    && die "$PRODUCT did not quit in 20 s. Quit it, then run again."
  echo "quit"
else
  echo "not running"
fi

step "6. Install $DEST"
run mkdir -p "$DEST_DIR"
run rm -rf "$DEST"
run ditto "$APP_SRC" "$DEST"

step "7. Open"
run open "$DEST"

step "Result"
if [ "$DRY" -eq 1 ]; then
  echo "+ plutil CFBundleShortVersionString, git sha, codesign -dv \"$DEST\""
  exit 0
fi
echo "app:     $DEST"
echo "version: $(plutil -extract CFBundleShortVersionString raw "$DEST/Contents/Info.plist")"
echo "bundle:  $(plutil -extract CFBundleIdentifier raw "$DEST/Contents/Info.plist")"
echo "git:     $SHA ($REF)"
if [ "$ADHOC" -eq 1 ]; then
  echo "signing: ad-hoc (--adhoc)"
else
  codesign -dv "$DEST" 2>&1 | grep -E '^(Authority|TeamIdentifier|CodeDirectory)' | sed 's/^/signing: /'
fi
