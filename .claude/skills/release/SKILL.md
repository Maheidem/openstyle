---
name: release
description: Ship a new Openstyle desktop release. Default since 2026-10-27 is the local release on the owner's Mac (pnpm release:local <version>, section "Local release"); the Craft release train on GitHub and a manual publish stay as fallbacks. Use when asked to cut/ship/publish a release or version bump the electron app.
---

# Openstyle release

All commands are foreground, one-shot, no watchers/daemons. Poll status by
re-running the `gh run list`/`gh run view` command, don't background it.

Replace `<version>` below with the bare semver, e.g. `1.1.1` (no `v` prefix).

## 1. Preflight

```bash
pnpm --filter @openstyle/server test
pnpm --filter @openstyle/electron typecheck && pnpm --filter @openstyle/electron build
ls apps/electron/resources/bin/darwin-arm64/
git status --porcelain   # must be empty
```

- `compile-native.js` warn-and-continues if native helper binaries are missing
  locally. That's fine on a dev machine — CI only fails on this when
  `process.env.CI` is set. Don't skip the `ls` check anyway; confirm the
  binaries are actually there before cutting a release.
- Working tree must be clean before you touch the version.

## 2. Trigger the automated release train

Proven end-to-end for v1.1.1 (2026-08-25). Requires `vars.APP_ID` +
`secrets.APP_PRIVATE_KEY` (GitHub App "openstyle-release-bot") and Issues
enabled on the repo — both are configured.

```bash
gh workflow run release.yml --repo Maheidem/openstyle -f version=auto
# or an explicit bump: -f version=<version>
```

`auto` derives the version bump from conventional commits since the last
release. This dispatches Craft, which bumps the version, pushes
`release/<version>`, and opens a publish-request issue.

Since the update channels (2.24.0), give an explicit version on BOTH channels
while a Dev series runs. What `auto` does after a prerelease is unverified.
See "Channels (Stable and Dev)" below.

## 3. Watch the Build & Test workflow

Runs automatically on push to the `release/<version>` branch. It runs every
job. The longest path is "Build MLX worker" (~3 min) then "Build (macOS)" with
notarization (~10 min), so plan ~14 min. A wait for a free macOS runner can
add ~10 min (measured on manual run 40525439109, 2026-10-27).

```bash
gh run list --repo Maheidem/openstyle --branch release/<version>
gh run view <runId> --repo Maheidem/openstyle
```

Re-run `gh run list`/`gh run view` until it shows a conclusion. Do not
proceed until it's green.

## 4. Accept the publish-request issue

Find the issue Craft opened for this release (title references
`<version>`), then label it `accepted`:

```bash
gh issue list --repo Maheidem/openstyle --state open
gh issue edit <n> --repo Maheidem/openstyle --add-label accepted
```

The `accepted` label triggers `publish.yml` → `craft publish`, which
creates the GitHub release with the macOS assets, merges the release
branch into `main`, deletes the branch, and closes the issue. This runs
unattended — no manual asset upload or merge needed.

## 5. Verify

```bash
bash scripts/release-verify.sh <version>   # must end with "RESULT: PASS"
git log main -1   # release commit should be present
```

`scripts/release-verify.sh` downloads the release like the updater does and
prints PASS/FAIL per check (exit 1 on any FAIL). It checks: not a draft; all
assets present (the 4 mac assets plus the 2 blockmaps; since 2026-10-21 CI
builds no Windows or Linux app);
`latest-mac.yml` version; the zip and dmg sha512 and size against the feed;
and one forced alignment with the released MLX worker. The worker check uses
the aligner model in `ALIGNER_HF_HOME` (default `/tmp/meeting-p4b-hf/hf`) and
prints SKIPPED when the model is not there. It never downloads the model.
It needs `gh`, `jq` and about 300 MB in `/tmp`; a full run takes about
2.5 minutes (proved 2026-10-08: 2.14.1 gives 9 PASS, exit 0; 9.9.9 gives
`FAIL release 9.9.9 exists`, exit 1).

- `isDraft: false`
- `latest-mac.yml` inside the release: `version:` matches `<version>`, and
  the filenames listed inside it match the actual `.dmg`/`.zip` filenames
  exactly — auto-update reads this file, a mismatch silently breaks it
- `main` contains the release commit (Craft merges it as part of publish)
- release branch `release/<version>` no longer exists (Craft deletes it)

## Channels (Stable and Dev)

Spec: `specs/update-channels.md`. The app has two update channels (Settings >
Application, Advanced mode on).

| Channel | Version form | GitHub release | Who gets it |
|---|---|---|---|
| Stable | `X.Y.Z` | normal release, "latest" | all users |
| Dev | `X.Y.Z-alpha.N` | prerelease (Craft does this for `-alpha`) | Dev users only |

Rules:
1. Always give an explicit version: `-f version=2.25.0-alpha.1` or
   `-f version=2.25.0`. Do not use `auto` while a Dev series runs.
2. A Dev version is the NEXT Stable version plus `-alpha.N`, N from 1. Dev
   users get a Stable release only when it is greater (`2.25.0` >
   `2.25.0-alpha.3` > `2.24.0`).
3. Cut every release (Dev and Stable) from main. Do not run the train from an
   older tag (unverified: Craft merges the release branch back into main).
4. A promotion is a rebuild. Never move or copy assets of an alpha release
   into a Stable release: the version is inside the signed app.
5. electron-builder writes `latest-mac.yml` also for an alpha version
   (`detectUpdateChannel: false`), so `.craft.yml` and `release-verify.sh`
   need no change.

Cut a Dev release:

```bash
gh workflow run release.yml --repo Maheidem/openstyle -f version=X.Y.Z-alpha.N
```

Then steps 3 to 5 as usual, plus:

```bash
gh api repos/Maheidem/openstyle/releases/tags/X.Y.Z-alpha.N --jq .prerelease   # true
gh api repos/Maheidem/openstyle/releases/latest --jq .tag_name                  # still the last Stable
```

Promote to Stable. First check that main holds the code that Dev users
tested. Only the version line and the changelog can differ:

```bash
git fetch origin --tags
git diff --stat X.Y.Z-alpha.N origin/main -- . ':(exclude)apps/electron/package.json' ':(exclude)CHANGELOG.md'
# must print nothing; else cut a new alpha first, or the owner accepts the newer code
gh workflow run release.yml --repo Maheidem/openstyle -f version=X.Y.Z
```

`release-verify.sh X.Y.Z` must PASS, and
`gh api repos/Maheidem/openstyle/releases/latest --jq .tag_name` must print
`X.Y.Z`.

## Known requirements/traps

- **`vars.APP_ID` + `secrets.APP_PRIVATE_KEY` must be configured** on the
  repo (GitHub App "openstyle-release-bot") or `release.yml` fails at
  "Generate GitHub App token" with `[@octokit/auth-app] appId option is
  required`.
- **Issues must stay enabled** on the repo — Craft opens the
  publish-request issue there.
- **The `accepted` label must exist** on the repo for step 4 to work.
- **knip (dead-code lint) is a CI gate.** Any new file must be
  imported/used or explicitly knip-ignored, or the Build & Test workflow
  fails.
- **Swift native helpers need an explicit macOS deployment target.** The
  `macos-system-audio` helper needed a `-target`/deployment-target fix to
  build in CI; if you add/change a Swift helper, set the target explicitly.
- **gh auth account split.** The active `gh` account must be the personal
  one with push/release rights on `Maheidem/openstyle`, not the work
  account. Check with `gh auth status` if pushes/releases get rejected.
- **CI signing has three paths, in this order: Developer ID, self-signed
  "Openstyle Release", ad-hoc.** The first secret that is set wins (see
  "Release signing (Developer ID)" below). Updates with the same identity keep
  the TCC grants (proven 2026-10-13, 2.15.1 to 2.15.2, self-signed). The first
  update that changes the identity prompts once.

## Release signing (Developer ID)

Issues #53 and #54. The macOS job in `.github/workflows/build.yml` signs with
the owner's "Developer ID Application" certificate, with the hardened runtime.
electron-builder then notarizes the app with the App Store Connect API key and
staples the ticket to the app, before it makes the dmg and the zip.

- **Secrets** (repository Actions secrets, stored by the owner; an agent never
  reads or writes them):
  - `MAC_DEVID_CERT_P12`: base64 of the PKCS#12 export of the "Developer ID
    Application" certificate with its private key.
  - `MAC_DEVID_CERT_PASSWORD`: the password of that p12.
  - `APPLE_API_KEY_P8`: the raw content of the `.p8` API key file.
  - `APPLE_API_KEY_ID`: the key ID.
  - `APPLE_API_ISSUER`: the issuer ID.
- **Fallback order** (step "Prepare release signing identity", output `mode`):
  1. `devid`: `MAC_DEVID_CERT_P12` is set. All four other Developer ID secrets
     must also be set, or the step fails with the names of the empty ones.
  2. `self`: `MAC_DEVID_CERT_P12` is empty and `MAC_RELEASE_CERT_P12` is set.
     See "Release signing (self-signed)" below.
  3. `adhoc`: both are empty. One notice line, no signing.
- **How the devid path works:** the step imports the p12 into a temporary
  keychain, adds the Apple intermediate `DeveloperIDG2CA.cer`, writes the `.p8`
  to `$RUNNER_TEMP/release-signing/AuthKey.p8` and passes the SHA-1 hash of the
  identity to `-c.mac.identity`. electron-builder refuses a name that starts
  with `Developer ID Application:`. The build step exports `APPLE_API_KEY`
  (the file path), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` only in the devid
  path: one of them set alone makes electron-builder fail. The step "Remove
  release signing material" (always) deletes the keychain and the key file.
- **Nested binaries:** `@electron/osx-sign` walks the whole bundle and signs
  every binary file with the identity, the hardened runtime and
  `build/entitlements.mac.plist` (`mac.entitlementsInherit`). This covers
  `Contents/Resources/bin/*` (the Swift helpers, `ffmpeg`,
  `fluidaudio-diarize`, `vec0.dylib`) and `Contents/Resources/whisper/*`.
  No extra sign step is needed. The MLX worker is not in the bundle: the app
  downloads it at run time, so notarization does not see it.
- **Verify step** (devid): the step "Verify release signature" fails unless the
  app and every Mach-O file under `Contents/Resources` show
  `Authority=Developer ID Application: ...`, the same TeamIdentifier and the
  hardened runtime flag; every helper executable has the entitlements
  audio-input, apple-events and calendars; `spctl -a -vv -t exec` prints
  `accepted` and `source=Notarized Developer ID`; and
  `xcrun stapler validate` passes on the app. The dmg has no ticket
  (electron-builder notarizes the app only); the step prints a notice for it.
- **After the release:** `bash scripts/release-verify.sh <version>` runs
  spctl and stapler on the app from the zip when the app is Developer ID
  signed. For self-signed and ad-hoc releases it prints SKIPPED for these
  checks and can still PASS.
- **First Developer ID update:** the identity changes from "Openstyle Release"
  to the Developer ID, so macOS asks for the Privacy permissions once more.
  Later updates keep them. Say this in the changelog of that release.
- **Cost:** notarization adds some minutes to each signed macOS build. Only
  `release/**` pushes and manual runs with `package=true` build the package
  (sign and notarize). A PR never builds it.
- **Rollback:** delete the `MAC_DEVID_CERT_P12` secret. The next build uses the
  self-signed path again (or ad-hoc if `MAC_RELEASE_CERT_P12` is also empty).
  Users who updated to a Developer ID build then get one more Privacy prompt.

## Release signing (self-signed)

When `MAC_DEVID_CERT_P12` is empty, the macOS job in
`.github/workflows/build.yml` signs the app with the self-signed certificate
"Openstyle Release". Craft publishes the assets of the
release-branch Build & Test run, so this job signs the published files.

- **Secrets** (repository Actions secrets): `MAC_RELEASE_CERT_P12` (base64 of
  the PKCS#12 file) and `MAC_RELEASE_CERT_PASSWORD` (its password).
- **One-time setup, by the owner:** `bash scripts/release-cert-setup.sh`. It
  creates the certificate, saves the identity in the owner's login keychain as
  a backup (no trust), and stores both secrets. It refuses to replace
  existing secrets without `--force`. An agent never runs it.
- **Secret empty** (forks, or before the setup): the job keeps the ad-hoc build
  and prints one notice line. The job log of "Prepare release signing identity"
  and "Build electron (macOS)" shows which path ran.
- **Secret set:** the job imports the key into a temporary keychain, trusts the
  certificate for code signing on the runner, and builds with
  `-c.mac.identity="Openstyle Release" -c.mac.notarize=false`. The step
  "Verify release signature" fails the job unless the app and every Mach-O
  file under `Contents/Resources` show `Authority=Openstyle Release` and the
  designated requirement of each contains `certificate leaf`. Do not remove this check: with an identity that it cannot
  find, electron-builder falls back to ad-hoc on arm64 and does not fail.
- **First signed update:** the identity changes from ad-hoc to the certificate,
  so macOS asks for the Privacy permissions once more. Later updates keep
  them. Say this in the changelog of that release. The self-updater does not
  compare signatures (`apps/electron/src/main/self-updater.ts:192-238`).
- **Key loss:** the secrets cannot be read back from GitHub. If the key is lost,
  nobody can sign with the same identity. Users must then grant the permissions
  once more. Keep the export of the keychain backup in a password manager (the
  setup script prints the export command).
- **Rollback:** deleting the `MAC_RELEASE_CERT_P12` secret returns builds to
  ad-hoc at once.
- **Developer ID** takes priority when `MAC_DEVID_CERT_P12` is set. See
  "Release signing (Developer ID)" above.

## Local release (default since 2026-10-27)

Owner decision 2026-10-27: release builds run on the owner's Mac with one
command. GitHub macOS runners queue for a long time. GitHub only stores the
release. PR CI does not change. The Craft train above stays as the fallback.

```bash
pnpm release:local <version> --dry-run      # steps 1-5: no push, no tag, no upload
pnpm release:local <version>                # full release (owner only)
pnpm release:local <version> --publish-only # resume at step 7 after the push of step 6
```

The script is `scripts/release-local.sh`. An agent runs only `--dry-run`.
A real run pushes to main and publishes a release: only the owner or the main
session starts it.

What it does, in this order:
1. Preflight: macOS arm64, clean tree, `main` = `origin/main` (a dry run
   accepts a branch that contains origin/main), the version is greater than
   `apps/electron/package.json`, no tag, release or branch for it exists, the
   Developer ID identity is valid, the notary profile works, the Test Runner
   app exists.
2. `craft prepare <version> --no-push` (`@sentry/craft@3.1.0` through npx):
   a local commit `release: <version>` on `release/<version>` with the
   changelog and the version bump. Steps 3-5 run on this commit, as CI does on
   the release branch. A dry run or a failure before step 6 goes back to the
   start branch and deletes the local `release/<version>`.
3. Checks: the commands of the CI jobs "Checks" and "Test (macOS app + E2E)"
   (biome, knip, guard hook tests, server build, meeting eval checks, server
   typecheck and tests, stt, validations, electron unit tests,
   compile:native, the meeting capture self-test, the electron build, the two
   bundle guards).
4. Electron E2E in quiet mode through the Test Runner app, with a scratch HOME
   (`scripts/isolated-env.sh`). It runs every spec except `E2E_EXCLUDE`:
   `meeting-cancel-transcribe`, `meeting-import` and `permission-flow` (real
   `getUserMedia`; it raised a Microphone dialog on 2026-10-18). Those stay
   CI-only. The step fails when the TCC log shows any `AUTHREQ_PROMPTING`
   during the run.
5. Build: the MLX worker (`PYTHON_BIN`, default
   `/opt/homebrew/bin/python3.12`), whisper.cpp, then the steps of
   `build:mac` with electron-builder called directly:
   `-c.mac.identity=<sha-1> -c.mac.sign=./scripts/mac-sign-by-hash.cjs
   -c.mac.hardenedRuntime=true -c.mac.notarize=true` and
   `APPLE_KEYCHAIN_PROFILE`. Then the meeting capture self-test,
   `verify-native-binaries.mjs` and `scripts/verify-mac-signature.sh devid`
   (the same check as the CI step "Verify release signature"). The 6 assets go
   to `dist/release-<version>/` with a tree stamp; latest-mac.yml must name the
   version and match the zip and dmg sha512 and size.
6. Push the release commit to main:
   `env OPENSTYLE_RELEASE_LOCAL=1 git push origin HEAD:refs/heads/main`.
   It is a fast-forward only. When origin/main moved since step 1, git
   refuses the push and nothing is published: delete the local
   `release/<version>` and start again from main. No branch `release/**` is
   pushed, so the CI package build does not start.
7. GitHub release at the commit `release: <version>` on origin/main, only
   when its tree equals the tree of the build. Notes = the
   CHANGELOG.md section. Draft, upload the 6 assets, publish.
   `--prerelease` for `-alpha`/`-beta`/`-rc`. `--latest=true` only for a
   Stable version greater than the current latest (Craft does the same).
8. `scripts/release-verify.sh <version>`, then back to main.

Open problem (found 2026-10-27, blocks step 4 on this Mac): after
`page.reload()` the renderer of a test app sends its API calls to
`127.0.0.1:4649` (`resolvedPort` starts at `DEFAULT_SERVER_PORT` in
`apps/electron/src/renderer/src/lib/api.ts`). On the owner's Mac the
installed app answers there. A throwaway spec logged GET `/api/settings`,
`/api/history`, `/api/models/configured` and more to that port. The spec
`meeting-llm-inspector` then saw the owner's `advanced_mode=true` and failed
("gate off", 3 runs of 3). CI has no server on that port, so CI passes.
Until the renderer waits for its own port, do not run step 4 next to the
installed app. It is not known whether a test also WROTE to the owner's
server.

Credentials (owner, once):
- Developer ID: the identity "Developer ID Application: Marcos André
  Heidemann Francisco (XQV5VD8YW3)" in the login keychain. Present on
  2026-10-27 (`security find-identity -v -p codesigning`).
- Notary: a notarytool keychain profile `openstyle-notary`
  (`OPENSTYLE_NOTARY_PROFILE` selects another name). Missing on 2026-10-27.
  Create it with the App Store Connect API key (the key of the CI secret
  `APPLE_API_KEY_P8`):
  ```bash
  xcrun notarytool store-credentials openstyle-notary \
    --key /path/to/AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-UUID>
  xcrun notarytool history --keychain-profile openstyle-notary   # must list, not fail
  ```
  electron-builder skips notarization SILENTLY when it finds no credentials.
  The script checks the profile in step 1 and the signature check in step 5
  fails on a non-notarized app.
- `--no-notarize` is allowed only with `--dry-run`. Such an app is signed but
  Gatekeeper rejects it.

Traps:
- Since 2026-10-27 the owner (RepositoryRole admin) is a bypass actor of the
  main ruleset 24718487, next to the release bot. The tag goes on the release
  commit on main, so that `git describe --tags` (Craft uses it for the next
  changelog) finds it.
- Guard hook rule h blocks an agent command that pushes to main
  (`git push origin main`, `HEAD:main`, `refs/heads/main`, `+main`,
  `--delete main`). It allows the push only with `OPENSTYLE_RELEASE_LOCAL=1`
  as an inline prefix or in the env of Claude Code. The hook sees only the
  command text: the push inside `scripts/release-local.sh` is not parsed, so
  an agent must never start a real run.
- Craft publish cannot upload a local build: its artifact provider downloads
  the "mac-builds" artifact of a GitHub run. The script uses `gh release`
  with the same rules as Craft's github target.
- `pnpm run build:mac` cannot notarize: `dev-sign.mjs builder` appends
  `-c.mac.notarize=false`. The script runs electron-builder directly.
- The identity name has "é": the script exports `LANG`/`LC_ALL=en_US.UTF-8`
  and signs by hash (`mac-sign-by-hash.cjs`).
- A new worktree can have a partial Electron install. The script repairs it
  from `~/Library/Caches/electron`.
- The first codesign with the login keychain can ask "codesign wants to access
  key". The owner enters the password and clicks "Always Allow".
- The script takes `/tmp/openstyle-gpu.lock` only around E2E and the worker
  build, and releases it on exit.
- Node: CI uses `.node-version` (22). The script warns when the local major
  differs.

Measured 2026-10-27 (`2.25.0-alpha.2 --dry-run --no-notarize`, branch
chore/local-release): steps 1-3 and 5 pass in about 9 min with warm caches
(craft prepare 8 s, checks 66 s). The app has `Authority=Developer ID
Application`, the hardened runtime and `valid on disk`; `spctl` says
`rejected, source=Unnotarized Developer ID` (no notary profile). Step 4 ran
24 specs: 126 passed, 1 failed (the 4649 problem above), 0 Privacy dialogs.

Verify by hand (dry run or real):

```bash
APP=apps/electron/dist/mac-arm64/Openstyle.app
codesign --verify --deep --strict --verbose=2 "$APP"   # "valid on disk", "satisfies its Designated Requirement"
spctl -a -vvv -t exec "$APP"                            # "accepted", "source=Notarized Developer ID"
xcrun stapler validate "$APP"                           # "The validate action worked!"
ls -l dist/release-<version>/                           # 6 assets + tree
```

After a real run: `bash scripts/release-verify.sh <version>` must end with
`RESULT: PASS` (the script runs it), and
`gh api repos/Maheidem/openstyle/releases/latest --jq .tag_name` must print
the newest Stable.

## Final verification checklist

- [ ] `gh release view <version> --repo Maheidem/openstyle --web` loads and
      shows the release
- [ ] `isDraft: false`
- [ ] `latest-mac.yml` version + filenames match the actual assets
- [ ] `main` contains the release commit; `release/<version>` branch is gone
- [ ] `git status --porcelain` clean

---

## Fallback: manual publish (when the automation is down)

Use only if `release.yml` or `publish.yml` fails (e.g. the GitHub App
secrets are missing/broken). This procedure shipped v1.1.0/v1.1.1 assets
manually and is kept as a proven escape hatch.

### F1. Bump version, branch, push by hand

Version and changelog live in `apps/electron/package.json` and
`CHANGELOG.md` (confirm with `git show <last-release-sha> --stat` if unsure
where the last bump touched).

```bash
# edit apps/electron/package.json "version" and prepend a CHANGELOG.md entry
git add apps/electron/package.json CHANGELOG.md
git commit -m "release: <version>"
git checkout -b release/<version>
git push -u origin release/<version>
```

Then watch Build & Test the same way as step 3 above.

### F2. Publish manually from the green run's artifacts

Never upload a local `build:mac` output. A local build can carry the "Openstyle Dev" signature, which differs from the CI signature, and the update check can fail.

```bash
mkdir -p /tmp/release-<version>
gh run download <runId> --repo Maheidem/openstyle -D /tmp/release-<version>
ls -R /tmp/release-<version>
```

Verify `latest-mac.yml` before publishing:
- `version:` matches `<version>`
- filenames listed inside it match the actual `.dmg`/`.zip` filenames
  exactly — auto-update reads this file, a mismatch silently breaks it

```bash
gh release create <version> \
  --repo Maheidem/openstyle \
  --target release/<version> \
  --draft \
  --title "<version>" \
  --notes "<changelog for this version>" \
  /tmp/release-<version>/**/*.dmg \
  /tmp/release-<version>/**/*-arm64-mac.zip \
  /tmp/release-<version>/**/latest-mac.yml \
  /tmp/release-<version>/**/*mlx_asr_worker*
```

Exactly these 4 assets: the dmg, the arm64 zip, `latest-mac.yml`, and the
mlx_asr_worker tarball. Tag is the bare version (`1.1.1`), no `v` prefix.

```bash
gh release view <version> --repo Maheidem/openstyle   # confirm 4 assets
gh release edit <version> --repo Maheidem/openstyle --draft=false
gh release view <version> --repo Maheidem/openstyle   # confirm isDraft: false
```

### F3. Fast-forward merge into main

House pattern: the release commit lands on `main`, the release branch is
then deletable.

```bash
git checkout main
git pull
git merge --ff-only release/<version>
git push origin main
git push origin --delete release/<version>   # optional cleanup
```

### F4. Clean up downloaded artifacts

```bash
rm -rf /tmp/release-<version>
```

## Let CI run on the merged code before the release train (lesson 2026-10-06/07)

Releases 2.13.0 and 2.14.0 both failed on the release branch for Linux-only reasons: tests that assumed Apple silicon (`getDefaultModels()` swaps an MLX default on Linux; the aligner gate is off), a test that spawned `ffmpeg` (not on the runner), and an E2E test with an old concurrency assumption. Each failure cost a fix-and-push cycle on the release branch.

Before `gh workflow run release.yml`, start a manual full run of Build & Test on main and wait until it is green:

```bash
gh workflow run build.yml --repo Maheidem/openstyle --ref main -f package=true
gh run list --repo Maheidem/openstyle --workflow build.yml --branch main --limit 1
gh run watch <runId> --repo Maheidem/openstyle --exit-status
```

`package=true` also builds the worker and the signed, notarized package (the same path as the release branch). A PR never builds the package, so use `package=true` when a packaging, native or signing file changed since the last release. Use `package=false` when no packaging, native or worker file changed since the last release: it runs Checks and the macOS app + E2E only. A push to main runs no CI (since 2026-10-27), so this manual run is the only CI on the merged code. The Electron E2E suite also runs locally next to the installed app, in quiet mode only (see the live-testing skill). Also run `./node_modules/.bin/biome` and `pnpm run knip` directly (an output-filter wrapper once reported a false knip exit code).

## main is protected (since 2026-10-08)

No direct push to main. The hand-written changelog and any pre-release merge go through a PR (`docs/changelog-<version>`) with green `CI Status`, squash-merged (auto-merge). That PR changes only `*.md`, so its CI skips the heavy jobs. It is not the pre-release check: use the manual full run above. Craft's release merge into main still works: the release bot (app 4715859) is a bypass actor of the ruleset. Since 2026-10-27 the owner is one too, for the push of the local release (guard hook rule h blocks other pushes to main). A fix needed on `release/<version>` is pushed there (not protected) and must also reach main through a PR.
