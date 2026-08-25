---
name: release
description: Ship a new Openstyle desktop release (version bump, branch, CI build, manual GitHub Release publish, main fast-forward). Use when asked to cut/ship/publish a release or version bump the electron app.
---

# Openstyle release

All commands are foreground, one-shot, no watchers/daemons. Poll CI status by
re-running the `gh run view` command, don't background it.

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

## 2. Bump version, branch, push

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

## 3. Watch the Build & Test workflow

Runs automatically on push to a `release/*` branch, takes ~7 min.

```bash
gh run list --repo Maheidem/openstyle --branch release/<version>
gh run view <runId> --repo Maheidem/openstyle
```

Re-run `gh run view <runId>` until it shows a conclusion. Do not proceed
until it's green.

## 4. KNOWN TRAP — do not use the "Release" workflow

The repo's separate "Release" GitHub Actions workflow is BROKEN: it fails at
"Generate GitHub App token" with `[@octokit/auth-app] appId option is
required` because the GitHub App secrets aren't configured. Do not trigger
it. Publish manually (step 5) until those secrets exist.

## 5. Publish manually from the green run's artifacts

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

## 6. Fast-forward merge into main

House pattern: the release commit lands on `main`, the release branch is
then deletable.

```bash
git checkout main
git pull
git merge --ff-only release/<version>
git push origin main
git push origin --delete release/<version>   # optional cleanup
```

## 7. Clean up downloaded artifacts

```bash
rm -rf /tmp/release-<version>
```

## Other known traps

- **knip (dead-code lint) is a CI gate.** Any new file must be imported/used
  or explicitly knip-ignored, or the Build & Test workflow fails.
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
- [ ] Exactly 4 assets attached: dmg, arm64 zip, `latest-mac.yml`, mlx_asr_worker tarball
- [ ] `isDraft: false`
- [ ] `main` fast-forwarded to include the `release: <version>` commit
- [ ] `git status --porcelain` clean, `/tmp/release-<version>` removed
