# Update channels (Stable, Dev)

Status: BUILT on branch `feat/update-channel` (2026-10-27). Real-release proof is open (section 8).
Owner decisions applied: 2026-10-27 (section 7).
Repo state read: main at `26f133be`. Installed packages: electron-updater 6.8.3, app-builder-lib 26.8.1.

## 0. Summary

The app has an "Update channel" menu with two channels:

| UI label | Setting value | electron-updater | Version form | Gets |
|---|---|---|---|---|
| Stable (recommended), default | `stable` | `channel = "latest"`, `allowPrerelease = false` | `2.24.0` | Stable only |
| Dev: every new build, can break | `dev` | `channel = "alpha"`, `allowPrerelease = true` | `2.24.0-alpha.N` | Dev and Stable |

- In both channels, `allowDowngrade = false`. The app sets it AFTER the channel (section 2, item 6).
- Craft publishes an `-alpha.N` version as a GitHub prerelease. Stable users never see it.
- A promotion from Dev to Stable is a new CI build of the same commit with a new version (section 4.3).
- The switch from a Dev (alpha) build back to Stable installs the current Stable version at once, also when it is older (owner decision D4).

## 1. How updates work (facts)

1. **Release train.** `release.yml` runs Craft (`getsentry/craft@v2`) with input `version` (`auto`, `major`, `minor`, `patch` or an explicit semver) (`.github/workflows/release.yml:7-11,52-58`). Craft runs `scripts/bump-version.sh` (`.craft.yml:14`), pushes `release/<version>` and opens a publish issue.
2. **Build.** `Build & Test` runs on push to `release/**` (not on `main` since 2026-10-27). Job `package` ("Build (macOS)") runs on `macos-14` and signs with Developer ID when `MAC_DEVID_CERT_P12` is set. The 2.23.0 release-branch run took 19 min.
3. **Publish.** The `accepted` label starts `publish.yml`, which runs `craft publish` (`.github/workflows/publish.yml:20-27,103-108`). Craft uploads only the names that match `.craft.yml:26`: `.dmg`, `.zip`, `.blockmap`, `latest-mac.yml`, `mlx_asr_worker-*.tar.gz`.
4. **Tags** have no `v` prefix (2.23.0, 2.22.0). The repo has 0 prereleases on 2026-10-27.
5. **Check.** `updater.ts` uses electron-updater only to check, with `autoDownload = false`. It checks every 5 minutes when "Automatic updates" is on. The dev flavor ("Openstyle Dev", `pnpm dev:install`) never checks.
6. **Download and install.** On macOS, `selfUpdater` downloads and installs (`apps/electron/src/main/self-updater.ts`). Since this feature it reads `releases/download/<found version>/latest-mac.yml` and downloads the zip from the same tag (section 4.5, item 3).
7. **MLX worker.** A packaged app sets `OPENSTYLE_MLX_ASR_RELEASE_TAG` to its own version (`apps/electron/src/main/server-host.ts:219-222`). The worker URL is `releases/download/<app version>/mlx_asr_worker-darwin-arm64.tar.gz` (`apps/server/src/lib/mlx-asr/runtime.ts:206-208,232-236`). The sha256 comes from `/releases/tags/<tag>` (`runtime.ts:252-254`). After a self-update, main prefetches the worker of the new version by tag (`updater.ts`, "downloaded" handler).

## 2. How electron-updater channels work (facts from the installed source)

Source: `node_modules/.pnpm/electron-updater@6.8.3/node_modules/electron-updater/out/`.

1. **allowPrerelease.** The constructor sets `allowPrerelease = true` when the running version has a suffix (`AppUpdater.js:218`). `applyChannel` sets it again for the chosen channel.
2. **Stable path** (`allowPrerelease = false`): it reads `github.com/<repo>/releases/latest` (`GitHubProvider.js:84-92,147-164`). GitHub "latest" is the newest release that is not a prerelease and not a draft.
3. **Prerelease path** (`allowPrerelease = true`): it reads `releases.atom` and walks the entries, newest first (`GitHubProvider.js:43-82`). With channel `alpha`, it takes the first entry that is alpha, beta or stable. The feed holds only 10 entries.
4. **Channel file.** For a tag with a suffix, it asks for `<suffix>-mac.yml` first. On a 404 it falls back to `latest-mac.yml` (`GitHubProvider.js:119-134`).
5. **Version rule.** It offers an update only when the found version is greater, or when it is older and `allowDowngrade` is true (`AppUpdater.js:339-362`). semver order: `2.24.0-alpha.3 < 2.24.0`.
6. **Trap: the `channel` setter turns on downgrade** (`AppUpdater.js:33-45`). The code sets `allowDowngrade` after it.
7. **electron-builder output (corrected 2026-10-27).** The draft said that version `2.24.0-alpha.1` makes electron-builder write `alpha-mac.yml`. The code says otherwise for the `github` provider: `getResolvedPublishConfig` computes the channel from the version, but the github branch never puts it into the options (`app-builder-lib/out/publish/PublishManager.js:385-467`). The schema says the same: "This does *not* apply to github publishing" (`app-builder-lib/scheme.json:1952-1955`). So an alpha build writes `latest-mac.yml` today. `detectUpdateChannel: false` in `electron-builder.yml` keeps this if a later version changes it.

## 3. MLX worker: does a prerelease break it?

No, for packaged apps. Each packaged app downloads the worker of its own tag (section 1, item 7). An alpha app gets the worker of its alpha tag. The rules:
- Every alpha release must upload `mlx_asr_worker-darwin-arm64.tar.gz`. Craft includes it (`.craft.yml:26`). `scripts/release-verify.sh` checks it.
- `encodeURIComponent("2.24.0-alpha.1")` does not change the tag, and `GET /releases/tags/<tag>` also returns prereleases. No code change in `runtime.ts`.
- `releases/latest` (used only by `pnpm dev` and a standalone server) ignores prereleases, so it stays on Stable.
- Proof is open: the first alpha release must pass `release-verify.sh` (section 8, step 5).

## 4. Design (as built)

### 4.1 Channel logic: `apps/electron/src/main/update-channel.ts`

- `resolveChannel(saved, version)`: the saved `updateChannel` from `settings.json`, else `dev` for an alpha build and `stable` for all other builds. Current users get `stable`. No behavior change for them.
- `applyChannel(updater, channel, { allowDowngrade })`: sets `channel`, then `allowPrerelease`, then `allowDowngrade` (false unless the caller passes true).
- `isNewerVersion(candidate, current)`: semver `gt`; false for an invalid version.
- `switchNeedsDowngrade(channel, version)`: true only for the switch to Stable from an alpha build.
- E2E seams (only with `OPENSTYLE_E2E=1`): `OPENSTYLE_E2E_RELEASES_URL` (a local fake GitHub feed) and `OPENSTYLE_E2E_APP_VERSION` (the version of the unpackaged app).

### 4.2 Release pipeline changes

1. `electron-builder.yml`: `detectUpdateChannel: false` (section 2, item 7). `.craft.yml` and `release-verify.sh` stay the same.
2. Craft marks a version with `alpha` as a GitHub prerelease (`previewReleases`, default `true`, craft.sentry.dev/targets/github). A prerelease can never be "latest".
3. `release.yml` needs no change. The operator gives an explicit version, for example `-f version=2.24.0-alpha.1`. UNVERIFIED: what Craft `auto` does after a prerelease. Rule: always give an explicit version on both channels while a Dev series runs.
4. `publish.yml` parses the version with `@\K[^\s]+$` (`publish.yml:44`). This accepts `2.24.0-alpha.1`. No change.

### 4.3 Promotion (Dev to Stable)

The version is inside the signed and notarized app. An alpha app in a Stable release would turn on prereleases for Stable users. So a promotion is a rebuild:

1. Dev: run the release train with `X.Y.Z-alpha.N` from main.
2. Stable: run the release train with `X.Y.Z` from main.

Check before the Stable run: main must hold the same code as the tested alpha tag. Only the version line and the changelog can differ:

```bash
git fetch origin --tags
git diff --stat X.Y.Z-alpha.N origin/main -- . ':(exclude)apps/electron/package.json' ':(exclude)CHANGELOG.md'
# must print nothing
```

If it prints files, cut a new alpha first, or the owner accepts the newer code.

### 4.4 Release skill

`.claude/skills/release/SKILL.md`, section "Channels (Stable and Dev)": the version forms, explicit versions, the promotion check, and the verify commands for an alpha.

### 4.5 App changes (main process)

1. **`update-channel.ts`** (new), section 4.1.
2. **`updater.ts`**: sets the channel before the first check. The `update-available` handler stores the found version. IPC `settings:update-channel` (get: channel and running version) and `settings:set-update-channel` (set).
3. **`self-updater.ts` (bug fix)**: `downloadUpdate(version, { allowOlder })` reads `releases/download/<version>/latest-mac.yml`, checks that it names `<version>`, and downloads the zip and its blockmap from the same tag. It refuses a version that is not newer, unless `allowOlder` is true. Before: it always read `releases/latest/download/latest-mac.yml`, so a Dev check that found an alpha downloaded the Stable zip.
4. **`updater.ts` (`updater:check`) and `menus.ts` (Check for Updates) (bug fix)**: these compared with `!==`. After a move from Dev to Stable they reported an OLDER version as "available". Now they use `isNewerVersion`.
5. **On a channel switch** (`switchChannel` in `updater.ts`):
   1. Write `updateChannel` to `settings.json`.
   2. Wait for a check that already runs (it uses the old channel).
   3. Forget the staged download of the old channel (`selfUpdater.discardDownload()`), set the download state to `idle`, and tell the renderer (`updater:cleared`).
   4. Apply the channel. Only for the switch to Stable from an alpha build: `allowDowngrade = true`.
   5. Check at once. For the switch to Stable from an alpha build: download the Stable version also with "Automatic updates" off, then install it at once (`restartAndUpdate`).
   6. Set `allowDowngrade = false` again. Every later check keeps it off.
6. The fake feed of an E2E run has no MLX worker, so an E2E run skips the worker prefetch.
7. **A meeting records during the update** (owner decision 2026-10-27: no wait, no queue). `restartDecision(recorderStatus, stopRecording)` in `update-channel.ts` gives `install`, `ask` or `stop-then-install`.
   - "Restart & Update" (banner, tray popover, menu) calls `restartAndUpdate()` in `menus.ts`. While a meeting records, main opens the dashboard and the dashboard asks: "A meeting is recording" / "Restart and update now? This stops the recording. Openstyle saves the recording first." / Cancel / "Stop recording and update".
   - The switch to Stable from an alpha build reads `meeting:status` first. While a meeting records, the dialog says: "A meeting is recording. Switch to Stable now? This stops the recording." / Cancel / "Stop recording and switch".
   - After a confirm, main calls `meetingRecorder.stop()` before the install. That is the normal stop: WAV files, `sync.json`, and row status `recorded`. Before this change, the install quit ran only `stopSync()`: WAV headers only, no `sync.json`, and the next start marked the row `interrupted`.
   - If no meeting records, the dialogs stay the same.

### 4.6 App UI

- The "Update channel" row is in Settings > Application, directly under "Automatic updates". It shows only when Advanced mode is on (D3).
- Options: "Stable (recommended)" and "Dev: every new build, can break".
- The switch to Stable from an alpha build first shows a dialog: "Switch to Stable?" / "Openstyle installs the current Stable version now and restarts. This version can be older than the version that you use now." / "Install Stable".
- i18n keys under `settings.application`: `updateChannel`, `updateChannelDesc`, `updateChannelStable`, `updateChannelDev`, `updateChannelStableTitle`, `updateChannelStableDesc`, `updateChannelStableAction`, in all 7 locales and `template.json`.

## 5. Tests (local, done)

- Unit: `apps/electron/src/main/update-channel.test.ts` runs a real electron-updater `AppUpdater` with a fake app: channel selection, version order, the `channel` setter trap, `allowDowngrade` rules, the explicit downgrade. `apps/electron/src/main/self-updater.test.ts`: the download URL per version and tag, refusal of an older version, `allowOlder`, discard.
- E2E: `apps/electron/tests/update-channel.test.ts` runs the built app against a local fake GitHub feed (atom feed, `/api/v3/.../releases/latest`, `latest-mac.yml` per tag, zips):
  1. A Stable app (2.24.0) sees no alpha and downloads nothing.
  2. The channel menu is hidden with Advanced mode off and shown with it on (screenshots, light and dark).
  3. On Dev it finds `2.25.0-alpha.1`, downloads the zip from the alpha tag, and the sha512 matches.
  4. An alpha app on Dev with "Automatic updates" off switches to Stable: the dialog shows, it downloads `2.24.0` (older) and starts the install. A normal check after that logs "downgrade is disallowed".
  5. An alpha app saved on Stable never downloads the older Stable by itself.
- Negative control: with the `allowDowngrade` reset removed from `applyChannel`, E2E step 4 fails.

## 6. Risks

1. **The atom feed holds 10 entries.** More than 10 alphas after the last Stable do not matter for Dev users (Dev takes the newest entry).
2. **Changelog noise.** Craft writes a CHANGELOG section for each alpha (`.craft.yml:9-11`).
3. **Two "dev" things.** "Openstyle Dev" (`pnpm dev:install`, a local build with updates off) and the "Dev" channel are different.
4. **The version on main changes.** Craft merges each alpha back into main, so `apps/electron/package.json` on main shows `X.Y.Z-alpha.N`. A `pnpm dev:install` build then shows that version.
5. **Hotfix of Stable during a Dev series** (for example `2.23.1` after `2.24.0-alpha.3`). Dev users do not get it, because `2.23.1 < 2.24.0-alpha.3`. That is correct.
6. **Rebuild is not byte-identical.** Stable is a new build of the same commit.
7. **The install after the switch to Stable restarts the app at once.** The dialog asks first. While a meeting records, the dialog says that the switch stops the recording (section 4.5, item 7).

## 7. Owner decisions (2026-10-27)

- **D1.** Two channels only: Dev (`alpha`) and Stable. No release candidate or beta.
- **D3.** The menu shows only when Advanced mode is on (Settings > Application, under "Automatic updates").
- **D4.** The switch from Dev back to Stable installs the current Stable version at once, also when it is older. The switch to Dev checks at once for a newer alpha. Downgrade stays off for normal checks on both channels.
- **D5.** No test releases. The real proof uses the next real releases (section 8).
- **D7.** `detectUpdateChannel: false` (one line). `.craft.yml` and `release-verify.sh` stay the same.

## 8. Real-release proof (main session, open)

The order matters: the first alpha must find a Stable release that has this feature.

1. Merge `feat/update-channel`. Release **2.24.0** (Stable) with the normal release train and an explicit version: `-f version=2.24.0`.
2. Verify 2.24.0: `bash scripts/release-verify.sh 2.24.0` ends with `RESULT: PASS`. The owner's app updates to 2.24.0 as usual.
3. On the owner's 2.24.0 app: Settings > Application > Advanced mode on. The "Update channel" menu shows "Stable (recommended)".
4. Cut the first alpha from main: `-f version=2.25.0-alpha.1`.
5. Verify the alpha:
   - `bash scripts/release-verify.sh 2.25.0-alpha.1` ends with `RESULT: PASS` (includes the MLX worker of the alpha tag).
   - `gh api repos/Maheidem/openstyle/releases/tags/2.25.0-alpha.1 --jq .prerelease` prints `true`.
   - `gh api repos/Maheidem/openstyle/releases/latest --jq .tag_name` prints `2.24.0`.
   - The owner's app on Stable shows no update after its next 5-minute check (log: `~/Library/Logs/Openstyle/openstyle.log`, read only, has no `2.25.0-alpha.1` download).
6. Set the channel to Dev on a 2.24.0 app. The app checks at once, downloads `2.25.0-alpha.1` and shows "Version 2.25.0-alpha.1 ready to install". After "Restart & Update", Settings shows 2.25.0-alpha.1.
7. Set the channel back to Stable. The dialog shows. "Install Stable" downloads 2.24.0 and restarts. The app runs 2.24.0 again.
8. Before the next Stable (2.25.0), run the promotion check of section 4.3.
