#!/usr/bin/env bash
# Build, sign, notarize and publish an Openstyle macOS release on this Mac.
# GitHub only stores the release. Docs: .claude/skills/release/SKILL.md,
# section "Local release".
#
#   pnpm release:local <version>                 full release (owner only)
#   pnpm release:local <version> --dry-run       steps 1-5, no push, no tag, no upload
#   pnpm release:local <version> --dry-run --no-notarize
#                                                the same without notarization
#   pnpm release:local <version> --publish-only  resume at step 7 after the
#                                                push of step 6
#
# <version> is X.Y.Z (Stable) or X.Y.Z-alpha.N / -beta.N / -rc.N (Dev, prerelease).
#
# Steps:
#   1. Preflight: clean tree, HEAD = origin/main, version not released,
#      Developer ID identity, notary profile, Test Runner app.
#   2. Version bump + changelog: craft prepare --no-push (local commit on
#      release/<version>). Steps 3-5 run on this commit, as CI does on the
#      release branch.
#   3. Checks: the commands of the CI "Checks" and "Test (macOS app + E2E)" jobs.
#   4. Electron E2E in quiet mode through the Test Runner app, without the
#      specs in E2E_EXCLUDE (they open the mic or system audio).
#   5. MLX worker + signed, notarized app (the CI "Build (macOS)" job), the
#      shared signature check, and the assets in dist/release-<version>/.
#   6. Push the release commit to main (fast-forward only). The owner is a
#      bypass actor of the main ruleset (2026-10-27). The push sets
#      OPENSTYLE_RELEASE_LOCAL=1 (guard hook rule h).
#   7. GitHub release at the release commit, with the assets of step 5
#      (prerelease for a Dev version; "latest" only for the newest Stable).
#   8. scripts/release-verify.sh <version>.
#
# Environment:
#   OPENSTYLE_NOTARY_PROFILE  notarytool keychain profile (default openstyle-notary)
#   PYTHON_BIN                Python 3.12 for the worker (default /opt/homebrew/bin/python3.12)
#   CRAFT_VERSION             @sentry/craft version for step 2 (default 3.1.0)
set -euo pipefail
# Bash reads a script while it runs. The brace group makes bash parse the
# whole file first, so a git checkout during a run cannot change it.
{
# codesign matches the identity name as UTF-8 text ("é" in the owner's name).
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

REPO=Maheidem/openstyle
NOTARY_PROFILE=${OPENSTYLE_NOTARY_PROFILE:-openstyle-notary}
export PYTHON_BIN=${PYTHON_BIN:-/opt/homebrew/bin/python3.12}
CRAFT_VERSION=${CRAFT_VERSION:-3.1.0}
GPU_LOCK=/tmp/openstyle-gpu.lock
# Specs that can open a macOS Privacy dialog. They stay CI-only.
# permission-flow calls the real getUserMedia (Microphone dialog, 2026-10-18).
# hotkey-supervisor starts the native key listener (Input Monitoring dialog).
E2E_EXCLUDE=(meeting-cancel-transcribe meeting-import permission-flow hotkey-supervisor)

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

VERSION=""
DRY=0
NOTARIZE=1
PUBLISH_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-notarize) NOTARIZE=0 ;;
    --publish-only) PUBLISH_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$VERSION" ] || { echo "error: one version only" >&2; exit 2; }; VERSION="$1" ;;
  esac
  shift
done

step() { echo; echo "== $(date +%H:%M:%S) $* =="; }
die() { echo "error: $*" >&2; exit 1; }
# run <cmd...>: print the command, then run it.
run() { printf '+'; printf ' %q' "$@"; echo; "$@"; }
# run_in <dir> <cmd...>: the same, with <dir> as the working folder.
run_in() {
  local dir="$1"; shift
  printf '+ (cd %q)' "$dir"; printf ' %q' "$@"; echo
  (cd "$dir" && "$@")
}

[ -n "$VERSION" ] || { usage >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]] ||
  die "version must be X.Y.Z or X.Y.Z-alpha.N (or -beta.N, -rc.N), got: $VERSION"
[ "$NOTARIZE" -eq 1 ] || [ "$DRY" -eq 1 ] || die "--no-notarize is allowed only with --dry-run."
[ "$PUBLISH_ONLY" -eq 0 ] || [ "$DRY" -eq 0 ] || die "--publish-only and --dry-run do not go together."
PRERELEASE=0
[[ "$VERSION" == *-* ]] && PRERELEASE=1

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
E="$ROOT/apps/electron"
OUT="$ROOT/dist/release-$VERSION"
RELEASE_BRANCH="release/$VERSION"
# The subject of the commit that craft prepare makes.
RELEASE_SUBJECT="release: $VERSION"

# Every gh and Craft call runs as the Maheidem account.
GH_TOKEN="$(gh auth token -u Maheidem 2>/dev/null)" || die "no gh token for the Maheidem account (gh auth login)"
export GH_TOKEN GITHUB_TOKEN="$GH_TOKEN"

# Prints -1, 0 or 1 for the semver order of $1 and $2 (forms X.Y.Z[-pre.N]).
# shellcheck disable=SC2016 # JavaScript, not shell
vercmp() {
  node -e '
    const p = (v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(v);
      if (!m) { console.error(`not a version: ${v}`); process.exit(2); }
      return m;
    };
    const [a, b] = [p(process.argv[1]), p(process.argv[2])];
    let r = 0;
    for (let i = 1; i <= 3 && !r; i++) r = Math.sign(a[i] - b[i]);
    if (!r && (a[4] || b[4])) {
      if (!a[4]) r = 1;
      else if (!b[4]) r = -1;
      else if (a[4] !== b[4]) r = a[4] < b[4] ? -1 : 1;
      else r = Math.sign(a[5] - b[5]);
    }
    console.log(r);
  ' "$1" "$2"
}

LOCKED=0
lock_take() {
  local waited=0
  while ! mkdir "$GPU_LOCK" 2>/dev/null; do
    [ "$waited" -lt 3600 ] || die "the GPU lock is busy for 60 min: $(cat "$GPU_LOCK/owner" 2>/dev/null)"
    echo "GPU lock busy ($(cat "$GPU_LOCK/owner" 2>/dev/null || echo unknown)). Wait 60 s."
    sleep 60
    waited=$((waited + 60))
  done
  LOCKED=1
  echo "release-local $1 $(date +%H:%M)" > "$GPU_LOCK/owner"
  echo "GPU lock taken: $1"
}
lock_release() {
  if [ "$LOCKED" -eq 1 ]; then
    rm -rf "$GPU_LOCK"
    LOCKED=0
    echo "GPU lock released"
  fi
}

START_REF=""
PUSHED=0
# shellcheck disable=SC2329 # the EXIT trap calls it
on_exit() {
  local rc=$?
  lock_release
  [ -n "$START_REF" ] || exit "$rc"
  # Before the push, the release branch is local only: remove it, so that a
  # new run starts clean. After the push, keep it for --publish-only.
  if [ "$PUSHED" -eq 0 ] && [ "$(git branch --show-current)" = "$RELEASE_BRANCH" ]; then
    git checkout --quiet --force "$START_REF" && git branch -D "$RELEASE_BRANCH" >/dev/null &&
      echo "cleanup: back on $START_REF, local branch $RELEASE_BRANCH deleted"
  fi
  exit "$rc"
}
trap on_exit EXIT

# Prints "<sha512> <size>" of the latest-mac.yml entry whose url is $2.
feed_entry() {
  awk -v want="$2" '
    $1 == "-" && $2 == "url:" { url = $3; next }
    url == want && $1 == "sha512:" { sha = $2 }
    url == want && $1 == "size:" { print sha, $2; exit }
  ' "$1"
}

# Steps 7 and 8: release at the release commit on main.
publish() {
  step "7. GitHub release $VERSION"
  [ -f "$OUT/tree" ] || die "no build stamp $OUT/tree. Build first (run without --publish-only)."
  run git fetch --quiet --prune origin
  local merge want_tree
  # awk reads all of the log: an early exit gives git log SIGPIPE (141),
  # and pipefail then stops the script (2.25.0-alpha.2, 2026-10-29).
  merge="$(git log origin/main --format='%H%x09%s' | awk -F'\t' -v s="$RELEASE_SUBJECT" '$2 == s && !found { print $1; found = 1 }')"
  [ -n "$merge" ] || die "no commit '$RELEASE_SUBJECT' on origin/main. Did step 6 push it?"
  want_tree="$(cat "$OUT/tree")"
  [ "$(git rev-parse "$merge^{tree}")" = "$want_tree" ] ||
    die "the release commit $merge has another tree than the build.
  The assets do not match it. Start a new version from main."
  echo "release commit: $merge (same tree as the build)"

  if gh release view "$VERSION" --repo "$REPO" > /dev/null 2>&1; then
    die "release $VERSION exists already. Check it: bash scripts/release-verify.sh $VERSION"
  fi
  # The release notes are the CHANGELOG.md section of this version (as Craft does).
  # No early exit in awk: see the SIGPIPE note above.
  git show "$merge:CHANGELOG.md" | awk -v v="## $VERSION" '
    $0 == v { on = 1; next }
    on && /^## / { on = 0; done = 1 }
    on && !done { print }
  ' > "$OUT.notes.md"
  [ -s "$OUT.notes.md" ] || die "CHANGELOG.md at $merge has no section '## $VERSION'"

  local latest="false" current
  if [ "$PRERELEASE" -eq 0 ]; then
    current="$(gh api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null || true)"
    if [ -z "$current" ] || [ "$(vercmp "$VERSION" "$current")" = 1 ]; then latest="true"; fi
  fi
  local flags=(--repo "$REPO" --target "$merge" --title "$VERSION" --notes-file "$OUT.notes.md" --draft)
  [ "$PRERELEASE" -eq 0 ] || flags+=(--prerelease)
  # Draft first, publish after all uploads: users never see a half release.
  run gh release create "$VERSION" "${flags[@]}" "${ASSETS[@]}"
  run gh release edit "$VERSION" --repo "$REPO" --draft=false --latest="$latest"
  echo "prerelease: $(gh api "repos/$REPO/releases/tags/$VERSION" --jq .prerelease)"
  echo "releases/latest: $(gh api "repos/$REPO/releases/latest" --jq .tag_name)"
  rm -f "$OUT.notes.md"

  step "8. Verify the release"
  run bash scripts/release-verify.sh "$VERSION"

  run git checkout --quiet main
  run git pull --quiet --ff-only
  git branch -D "$RELEASE_BRANCH" > /dev/null 2>&1 || true
  echo
  echo "DONE: $VERSION is published. Local assets: $OUT"
}

if [ "$PUBLISH_ONLY" -eq 1 ]; then
  ASSETS=()
  for f in "$OUT"/*; do [ "$(basename "$f")" = tree ] || ASSETS+=("$f"); done
  publish
  exit 0
fi

step "1. Preflight"
[ "$(uname -sm)" = "Darwin arm64" ] || die "a release builds only on macOS arm64."
for tool in gh jq node pnpm xcrun codesign "$PYTHON_BIN"; do
  command -v "$tool" > /dev/null || die "missing tool: $tool"
done
want_node="$(cat .node-version)"
[ "$(node -p 'process.versions.node.split(".")[0]')" = "${want_node%%.*}" ] ||
  echo "WARN: node $(node --version), CI uses node $want_node (.node-version)."
run git fetch --quiet --prune --tags origin
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean:
$(git status --short)"
BASE="$(git rev-parse HEAD)"
if [ "$DRY" -eq 1 ]; then
  git merge-base --is-ancestor origin/main HEAD || die "HEAD does not contain origin/main. Rebase first."
  [ "$BASE" = "$(git rev-parse origin/main)" ] ||
    echo "WARN (dry run): HEAD $BASE is not origin/main. A real release needs main = origin/main."
else
  [ "$(git branch --show-current)" = main ] || die "check out main first (now on '$(git branch --show-current)')."
  [ "$BASE" = "$(git rev-parse origin/main)" ] || die "main is not origin/main. Run: git pull --ff-only"
fi
current_version="$(jq -r .version apps/electron/package.json)"
[ "$(vercmp "$VERSION" "$current_version")" = 1 ] || die "$VERSION is not greater than the current version $current_version."
! git rev-parse --quiet --verify "refs/tags/$VERSION" > /dev/null || die "tag $VERSION exists."
[ -z "$(git ls-remote --tags origin "refs/tags/$VERSION")" ] || die "tag $VERSION exists on origin."
! gh release view "$VERSION" --repo "$REPO" > /dev/null 2>&1 || die "release $VERSION exists on GitHub."
! git rev-parse --quiet --verify "refs/heads/$RELEASE_BRANCH" > /dev/null || die "local branch $RELEASE_BRANCH exists. Delete it first."
[ -z "$(git ls-remote --heads origin "$RELEASE_BRANCH")" ] || die "branch $RELEASE_BRANCH exists on origin."
echo "version: $current_version -> $VERSION ($([ "$PRERELEASE" -eq 1 ] && echo "prerelease, Dev channel" || echo "Stable"))"

line="$(security find-identity -v -p codesigning | grep '"Developer ID Application:' | head -n 1 || true)"
[ -n "$line" ] || die 'no valid "Developer ID Application" identity in the keychain.
  Check: security find-identity -v -p codesigning
  Install the Developer ID certificate with its private key in the login keychain.
  If it shows without -v only, add the G2 intermediate:
  curl -sfo ~/Downloads/DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer && open ~/Downloads/DeveloperIDG2CA.cer'
IDENTITY="$(awk '{print $2}' <<<"$line")"
echo "identity: $(sed -E 's/^[^"]*"(.*)"[^"]*$/\1/' <<<"$line") ($IDENTITY)"
if [ "$NOTARIZE" -eq 1 ]; then
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" > /dev/null 2>&1 ||
    die "the notarytool keychain profile '$NOTARY_PROFILE' does not work.
  Create it once with the App Store Connect API key (the same key as the CI secret APPLE_API_KEY_P8):
    xcrun notarytool store-credentials $NOTARY_PROFILE --key /path/to/AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-UUID>
  Then delete the .p8 file or keep it in a safe place. Check: xcrun notarytool history --keychain-profile $NOTARY_PROFILE"
  echo "notary profile: $NOTARY_PROFILE (works)"
else
  echo "WARN: --no-notarize. The app is signed but not notarized. Gatekeeper rejects it."
fi
[ -d "$HOME/Applications/Openstyle Test Runner.app" ] ||
  die "the Test Runner app is missing. Build it: node scripts/test-runner/build.mjs"

step "2. Version bump and changelog (craft prepare, local commit only)"
START_REF="$(git branch --show-current)"
[ -n "$START_REF" ] || START_REF="$BASE"
# --rev: Craft makes the branch from this commit and asks nothing.
# --no-git-checks: step 1 did the checks (Craft would refuse a non-main branch).
run npx --yes "@sentry/craft@$CRAFT_VERSION" prepare "$VERSION" --no-push --no-input --no-git-checks --rev "$BASE"
[ "$(git branch --show-current)" = "$RELEASE_BRANCH" ] || die "craft did not check out $RELEASE_BRANCH"
[ "$(jq -r .version apps/electron/package.json)" = "$VERSION" ] || die "craft did not bump apps/electron/package.json"
git --no-pager log --oneline -1
git --no-pager show --stat --format= HEAD

step "3. Checks (CI jobs Checks and Test macOS app)"
run pnpm install --frozen-lockfile
# pnpm can leave Electron with only LICENSES.chromium.html in dist (new worktree trap).
electron_dir="$(cd "$E" && node -p 'require("path").dirname(require.resolve("electron/package.json"))')"
if [ ! -f "$electron_dir/path.txt" ]; then
  zip="$HOME/Library/Caches/electron/electron-v$(jq -r .version "$electron_dir/package.json")-darwin-arm64.zip"
  [ -f "$zip" ] || die "Electron is not installed and $zip is missing."
  echo "repair: Electron from $zip"
  ditto -x -k "$zip" "$electron_dir/dist"
  printf 'Electron.app/Contents/MacOS/Electron' > "$electron_dir/path.txt"
fi
# Local builds must not pick up the "Openstyle Dev" identity (as in CI).
export OPENSTYLE_DEV_SIGN=0
run ./node_modules/.bin/biome check .
run pnpm run knip
run bash scripts/guard-hook.test.sh
run pnpm turbo build --filter=@openstyle/server
run pnpm meeting:eval:test
run_in apps/server pnpm run typecheck:tests
NODE_OPTIONS=--expose-gc run pnpm --filter @openstyle/server run test
run pnpm --filter @openstyle/stt run test
run pnpm --filter @openstyle/validations run test
run pnpm --filter @openstyle/electron run test
run_in "$E" pnpm run compile:native
run_in "$E" "resources/bin/darwin-arm64/macos-meeting-capture" --self-test
run_in "$E" pnpm run build
run_in "$E" node scripts/check-bundled-requires.mjs
run_in "$E" node scripts/check-renderer-asset-urls.mjs

step "4. Electron E2E (quiet mode, Test Runner app)"
specs=()
for f in "$E"/tests/*.test.ts; do
  name="$(basename "$f" .test.ts)"
  [ "$name" = preload-channels ] && continue # a vitest suite (playwright.config.ts)
  skip=0
  for x in "${E2E_EXCLUDE[@]}"; do [ "$name" = "$x" ] && skip=1; done
  [ "$skip" -eq 1 ] || specs+=("tests/$name.test.ts")
done
echo "specs: ${#specs[@]} (excluded, CI only: ${E2E_EXCLUDE[*]})"
# A first run of a spec builds ffmpeg for the import suites.
run_in "$E" pnpm run download:ffmpeg
SCRATCH="/private/tmp/openstyle-release-e2e-$$"
# shellcheck source=scripts/isolated-env.sh disable=SC1091
source scripts/isolated-env.sh "$SCRATCH" > /dev/null
tcc_start="$(date '+%Y-%m-%d %H:%M:%S')"
lock_take e2e
e2e_rc=0
# The Test Runner app owns the Privacy grants (live-testing skill). HOME goes
# after "--": a HOME in front of run.sh breaks its bundle lookup.
# --retries=1 as in CI (playwright.config.ts retries once when CI is set): the
# timed tray-popover specs flaked once in a full local run (2026-10-27).
run scripts/test-runner/run.sh "$E" -- env HOME="$OPENSTYLE_ISOLATED_HOME" \
  OPENSTYLE_E2E_OMLX_URL=http://127.0.0.1:1 CSC_IDENTITY_AUTO_DISCOVERY=false \
  timeout 2400 ./node_modules/.bin/playwright test --retries=1 "${specs[@]}" || e2e_rc=$?
lock_release
# Only AUTHREQ_PROMPTING means that macOS showed a Privacy dialog.
tcc_prompts="$(/usr/bin/log show --start "$tcc_start" --predicate 'subsystem == "com.apple.TCC"' --style compact 2>/dev/null |
  grep -c AUTHREQ_PROMPTING || true)"
rm -rf "$SCRATCH"
unset OPENSTYLE_ISOLATED_HOME OPENSTYLE_USER_DATA OPENSTYLE_DB_PATH HF_HOME HUGGINGFACE_HUB_CACHE
echo "Privacy dialogs during E2E (TCC AUTHREQ_PROMPTING since $tcc_start): $tcc_prompts"
[ "$tcc_prompts" -eq 0 ] || die "macOS showed a Privacy dialog during E2E. Do not click it. Stop and check."
[ "$e2e_rc" -eq 0 ] || die "E2E failed (exit $e2e_rc). Traces: $E/test-results"

step "5. Build: MLX worker, signed $([ "$NOTARIZE" -eq 1 ] && echo "and notarized ")app"
lock_take mlx-worker-build
run ./scripts/build_mlx_asr_worker.sh
lock_release
test -f dist/mlx_asr_worker-darwin-arm64.tar.gz || die "no dist/mlx_asr_worker-darwin-arm64.tar.gz"
run_in "$E" node scripts/download-whisper-cpp.mjs --resources
run rm -rf "$E/dist"
# The steps of "pnpm run build:mac". Its last step (dev-sign.mjs builder)
# forces notarize=false, so electron-builder runs here directly.
run_in "$E" pnpm run compile:native
run_in "$E" pnpm run copy:sqlite-vec
run_in "$E" pnpm run download:ffmpeg
run_in "$E" pnpm exec electron-vite build
# mac.identity takes the SHA-1 hash; mac-sign-by-hash.cjs makes codesign sign
# by hash (the name has "é"). electron-builder notarizes with
# APPLE_KEYCHAIN_PROFILE and staples the .app before it makes the dmg and zip.
builder_env=(CSC_FOR_PULL_REQUEST=true)
[ "$NOTARIZE" -eq 0 ] || builder_env+=(APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE" "DEBUG=electron-notarize*,@electron/notarize*")
run_in "$E" env "${builder_env[@]}" pnpm exec electron-builder --mac --publish never \
  -c.mac.identity="$IDENTITY" -c.mac.sign=./scripts/mac-sign-by-hash.cjs \
  -c.mac.hardenedRuntime=true -c.mac.notarize="$([ "$NOTARIZE" -eq 1 ] && echo true || echo false)"

APP="$E/dist/mac-arm64/Openstyle.app"
[ -d "$APP" ] || die "no $APP after the build"
run_in "$E" "resources/bin/darwin-arm64/macos-meeting-capture" --self-test
run_in "$E" node scripts/verify-native-binaries.mjs
DMG="$E/dist/Openstyle-$VERSION.dmg"
if [ "$NOTARIZE" -eq 1 ]; then
  # electron-builder notarizes the .app only. Notarize and staple the dmg too,
  # so that Gatekeeper accepts a downloaded dmg offline. (CI does not do this.)
  run xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  run xcrun stapler staple "$DMG"
  # The ticket changes the dmg: write its blockmap again, and its sha512 and
  # size in latest-mac.yml (the tool prints {"size":..,"sha512":..}).
  app_builder="$(cd "$E" && node -p 'require(require.resolve("app-builder-bin", { paths: [require.resolve("electron-builder")] })).appBuilderPath')"
  dmg_info="$("$app_builder" blockmap -i "$DMG" -o "$DMG.blockmap")"
  dmg_sha="$(jq -r .sha512 <<<"$dmg_info")"
  dmg_size="$(jq -r .size <<<"$dmg_info")"
  awk -v want="$(basename "$DMG")" -v sha="$dmg_sha" -v size="$dmg_size" '
    $1 == "-" && $2 == "url:" { url = $3 }
    url == want && $1 == "sha512:" { sub(/sha512: .*/, "sha512: " sha) }
    url == want && $1 == "size:" { sub(/size: .*/, "size: " size); url = "" }
    { print }
  ' "$E/dist/latest-mac.yml" > "$E/dist/latest-mac.yml.new"
  mv "$E/dist/latest-mac.yml.new" "$E/dist/latest-mac.yml"
  echo "dmg stapled; latest-mac.yml dmg entry: size $dmg_size"
fi
NOTARIZED="$NOTARIZE" run bash scripts/verify-mac-signature.sh devid "$APP" "$DMG"

# The asset set of .craft.yml (includeNames) and of release-verify.sh.
rm -rf "$OUT"
mkdir -p "$OUT"
for f in "dist/mlx_asr_worker-darwin-arm64.tar.gz" \
  "$E/dist/Openstyle-$VERSION.dmg" "$E/dist/Openstyle-$VERSION.dmg.blockmap" \
  "$E/dist/Openstyle-$VERSION-arm64.zip" "$E/dist/Openstyle-$VERSION-arm64.zip.blockmap" \
  "$E/dist/latest-mac.yml"; do
  [ -f "$f" ] || die "missing build output: $f"
  cp "$f" "$OUT/"
done
feed="$OUT/latest-mac.yml"
[ "$(awk '/^version:/ {print $2}' "$feed")" = "$VERSION" ] || die "latest-mac.yml does not name $VERSION"
for name in "Openstyle-$VERSION-arm64.zip" "Openstyle-$VERSION.dmg"; do
  read -r want_sha want_size <<<"$(feed_entry "$feed" "$name")" || true
  [ -n "${want_sha:-}" ] || die "latest-mac.yml does not list $name"
  [ "$(openssl dgst -sha512 -binary "$OUT/$name" | base64 | tr -d '\n')" = "$want_sha" ] || die "$name sha512 differs from latest-mac.yml"
  [ "$(stat -f %z "$OUT/$name")" = "$want_size" ] || die "$name size differs from latest-mac.yml"
done
echo "latest-mac.yml: version $VERSION, zip and dmg sha512 and size match"
git rev-parse "HEAD^{tree}" > "$OUT/tree"
ASSETS=()
for f in "$OUT"/*; do [ "$(basename "$f")" = tree ] || ASSETS+=("$f"); done
ls -l "${ASSETS[@]}"

if [ "$DRY" -eq 1 ]; then
  echo
  echo "DRY RUN DONE: no push, no tag, no upload. Assets: $OUT"
  echo "The app: $APP"
  exit 0
fi

step "6. Push the release commit to main"
# The commit of step 2 sits on the base commit of step 1. When origin/main
# moved since then, the push is not a fast-forward and git refuses it.
[ "$(git rev-parse HEAD^)" = "$BASE" ] || die "the release commit is not on the base commit $BASE"
[ "$(git rev-parse "HEAD^{tree}")" = "$(cat "$OUT/tree")" ] || die "HEAD has another tree than the build"
PUSHED=1
# Guard hook rule h allows a push to main only with this variable.
run env OPENSTYLE_RELEASE_LOCAL=1 git push origin "HEAD:refs/heads/main" ||
  die "the push to main failed (origin/main moved, or no bypass). Nothing is published.
  Delete the local branch $RELEASE_BRANCH and start again from main."

publish
exit 0
}
