---
name: release
description: Ship a new Openstyle desktop release via the automated Craft release train (preflight, gh workflow dispatch, accept issue to publish); manual GitHub Release publish kept as a fallback. Use when asked to cut/ship/publish a release or version bump the electron app.
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

## 3. Watch the Build & Test workflow

Runs automatically on push to the `release/<version>` branch, takes ~7 min.

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
creates the GitHub release with all platform assets, merges the release
branch into `main`, deletes the branch, and closes the issue. This runs
unattended — no manual asset upload or merge needed.

## 5. Verify

```bash
bash scripts/release-verify.sh <version>   # must end with "RESULT: PASS"
git log main -1   # release commit should be present
```

`scripts/release-verify.sh` downloads the release like the updater does and
prints PASS/FAIL per check (exit 1 on any FAIL). It checks: not a draft; all
assets present (the 4 mac assets plus blockmaps, Windows and Linux files);
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
- **Ad-hoc-signed builds re-prompt TCC permissions after every update.**
  Expected until CI has Developer ID signing + notarization creds — not a
  regression to chase.

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

Before `gh workflow run release.yml`: push the merged code to a throwaway branch (for example `ci/pre-release-<version>`), wait for Build & Test (all jobs, including Electron E2E), and only then dispatch. The Electron E2E suite also runs locally next to the installed app, in quiet mode only (see the live-testing skill). Delete the throwaway branch after. Also run `./node_modules/.bin/biome` and `pnpm run knip` directly (an output-filter wrapper once reported a false knip exit code).

## main is protected (since 2026-10-08)

No direct push to main. The hand-written changelog and any pre-release merge go through a PR (`docs/changelog-<version>`) with green `CI Status`, squash-merged (auto-merge). That PR's CI run is also the pre-release CI check above. Craft's release merge into main still works: the release bot (app 4715859) is the only bypass actor of the ruleset. A fix needed on `release/<version>` is pushed there (not protected) and must also reach main through a PR.
