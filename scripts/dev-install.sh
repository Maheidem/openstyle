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
#   pnpm dev:install --main-app      build the NORMAL Openstyle and replace
#                                    /Applications/Openstyle.app (real profile and data;
#                                    backup: ~/Applications/Openstyle.prev.app)
#
# OPENSTYLE_DEVBUILD_DIR moves the build worktree (default ../openstyle-devbuild
# next to the main checkout). The worktree belongs to this script: it is
# detached and holds no work.
set -euo pipefail

REF="origin/main"
DRY=0
ADHOC=0
BUILD_ONLY=0
MAIN_APP=0
usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || { echo "error: --ref needs a value" >&2; exit 2; }; REF="$2"; shift ;;
    --ref=*) REF="${1#--ref=}" ;;
    --dry-run) DRY=1 ;;
    --adhoc) ADHOC=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --main-app) MAIN_APP=1 ;;
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

if [ "$MAIN_APP" -eq 1 ]; then
  # The normal flavor (electron-builder.yml): the real profile, port and caches.
  BUNDLE_ID="com.openstyle.app"
  PRODUCT="Openstyle"
  DEST_DIR="/Applications"
  BACKUP="$HOME/Applications/Openstyle.prev.app"
  FLAVOR_ARGS=()
  # An ad-hoc signature would reset the Privacy grants of the real app.
  [ "$ADHOC" -eq 0 ] || die "--main-app needs the Developer ID. Remove --adhoc."
else
  BUNDLE_ID="com.openstyle.app.dev"
  PRODUCT="Openstyle Dev"
  DEST_DIR="$HOME/Applications"
  BACKUP=""
  FLAVOR_ARGS=(
    -c.appId="$BUNDLE_ID"
    -c.productName="$PRODUCT"
    -c.extraMetadata.productName="$PRODUCT"
    -c.extraMetadata.openstyleFlavor=dev
  )
fi
DEST="$DEST_DIR/$PRODUCT.app"

[ "$(uname -s)" = Darwin ] || die "Openstyle Dev builds only on macOS."
[ "$(uname -m)" = arm64 ] || die "Openstyle Dev builds only on Apple Silicon (arm64)."

# The main checkout: the parent of the shared .git folder (also from a worktree).
COMMON_GIT="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(dirname "$COMMON_GIT")"
WT="${OPENSTYLE_DEVBUILD_DIR:-$(dirname "$MAIN_ROOT")/openstyle-devbuild}"
APP_SRC="$WT/apps/electron/dist/mac-arm64/$PRODUCT.app"

if [ "$MAIN_APP" -eq 1 ]; then
  echo "== --main-app: target $DEST (bundle id $BUNDLE_ID) =="
  echo "   It uses your real profile and data. Backup of the old app: $BACKUP"
  WARNED="$WT/.dev-install-main-app-warned"
  if [ ! -e "$WARNED" ]; then
    cat <<'WARN'

!! WARNING (first --main-app run) !!
   - A build of main can run database migrations on your real profile.
     Going back to an older release (or to the backup) may then not work.
   - The first Developer ID build asks for the Privacy permissions
     (Microphone, Accessibility, ...) once more. Later builds keep them.
   - The normal flavor keeps its updater: a newer release replaces this build.
   Press Ctrl-C now to stop.

WARN
    [ "$DRY" -eq 1 ] || { sleep 5; WARN_PENDING=1; }
  fi
fi

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
  Install the Developer ID certificate with its private key in the login keychain.
  If it shows without -v only, add the G2 intermediate:
  curl -sfo ~/Downloads/DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer && open ~/Downloads/DeveloperIDG2CA.cer
  Otherwise,
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
# Show the first-run warning only once (the marker lives in the worktree).
[ -z "${WARN_PENDING:-}" ] || touch "$WARNED"

step "3. Dependencies"
run_in "$WT" pnpm install --frozen-lockfile

step "4. Build $PRODUCT (arm64, unpacked)"
E="$WT/apps/electron"
run_in "$WT" pnpm turbo build --filter=@openstyle/server
run_in "$E" env "${SIGN_ENV[@]}" pnpm run compile:native
run_in "$E" pnpm run copy:sqlite-vec
run_in "$E" env "${SIGN_ENV[@]}" pnpm run download:ffmpeg
if [ -n "$(ls -A "$E/resources/whisper/darwin-arm64" 2>/dev/null)" ]; then
  echo "whisper.cpp binaries present, skip"
else
  run_in "$E" node scripts/download-whisper-cpp.mjs --resources
fi
run_in "$E" pnpm exec electron-vite build
# pnpm exec puts electron-builder on PATH. dev-sign.mjs adds -c.mac.identity=<hash> -c.mac.notarize=false when the
# identity is set (else ad-hoc). For the dev flavor, extraMetadata goes into
# the packaged package.json: the product name gives the own userData and log
# folders, the flavor flag turns on the rest (apps/electron/src/main/flavor.ts).
run_in "$E" env "${SIGN_ENV[@]}" pnpm exec node scripts/dev-sign.mjs builder --mac dir --arm64 --publish never \
  ${FLAVOR_ARGS[@]+"${FLAVOR_ARGS[@]}"} -c.mac.hardenedRuntime=true
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
OLD_VERSION="none"
if [ -d "$DEST" ]; then
  OLD_VERSION="$(plutil -extract CFBundleShortVersionString raw "$DEST/Contents/Info.plist" 2>/dev/null || echo unknown)"
fi
echo "old version: $OLD_VERSION"
if [ -n "$BACKUP" ] && [ -d "$DEST" ]; then
  # One backup only: the app that this run replaces.
  run mkdir -p "$(dirname "$BACKUP")"
  run rm -rf "$BACKUP"
  run mv "$DEST" "$BACKUP"
else
  run mkdir -p "$DEST_DIR"
  run rm -rf "$DEST"
fi
run ditto "$APP_SRC" "$DEST"

step "7. Open"
run open "$DEST"

step "Result"
if [ "$DRY" -eq 1 ]; then
  echo "+ plutil CFBundleShortVersionString (old -> new), git sha, codesign -dv \"$DEST\""
  [ -z "$BACKUP" ] || echo "backup:  $BACKUP"
  exit 0
fi
echo "app:     $DEST"
echo "version: $OLD_VERSION -> $(plutil -extract CFBundleShortVersionString raw "$DEST/Contents/Info.plist")"
[ -z "$BACKUP" ] || [ "$OLD_VERSION" = none ] || echo "backup:  $BACKUP"
echo "bundle:  $(plutil -extract CFBundleIdentifier raw "$DEST/Contents/Info.plist")"
echo "git:     $SHA ($REF)"
if [ "$ADHOC" -eq 1 ]; then
  echo "signing: ad-hoc (--adhoc)"
else
  codesign -dv "$DEST" 2>&1 | grep -E '^(Authority|TeamIdentifier|CodeDirectory)' | sed 's/^/signing: /'
fi
