---
name: live-testing
description: Run the real Openstyle app and server in isolation for end-to-end proofs, screenshots and videos, without touching the owner's installed app or data. Use for any e2e check, real-app verification, UI screenshot, seeded demo data, or model/transcription test against a running server.
---

# Isolated live testing

The owner runs the installed Openstyle app every day. Every live test must run next to it and never touch it.

## Hard rules

1. Do not call port 4649. The installed app owns it. Exception: the built app sends one read-only `GET /api/health` to 4649 at boot (`apps/electron/src/main/server-target.ts:150-160`). That probe is accepted.
2. Do not quit, kill or launch `/Applications/Openstyle.app`.
3. Do not write to the real profile `~/Library/Application Support/Openstyle` or its DB. To read the DB, use `sqlite3 -readonly "<db>" ".backup <scratch>/copy.db"`. The DB uses WAL, so a plain file copy can miss data.
4. Do not write to `~/.cache/huggingface`. Set `HUGGINGFACE_HUB_CACHE=<scratch>/hf` for any download test.
5. Kill only the PIDs that you started. Do not use `pkill -f mlx_asr_worker` or any kill by name. A kill by name also kills the worker of the installed app.
6. Put every temporary file in one scratch folder (`/tmp/<task-name>/`). Delete it at the end. Keep only the evidence the task asks for.
7. Give every `curl` a timeout (`timeout 30 curl ...`). A hook blocks a `curl` with no timeout.
8. Do not push, merge or change GitHub settings. The coordinating agent does outward actions.
9. Launch a local app or E2E run only in quiet mode (`OPENSTYLE_E2E=1`, section 4). Prefer CI for the full E2E suite.

## Logs of a packaged build

A packaged build (`build:unpack`) writes its logs to `~/Library/Logs/Openstyle`, the installed app's folder, even with an isolated `OPENSTYLE_USER_DATA`; `HOME` and `OPENSTYLE_LOG_DIR` do not redirect it (found 2026-10-19, issue #218). Use only fictional text in a packaged run, and record the log sizes before the run. Never run the full E2E suite locally: `tests/permission-flow.test.ts` raises a Microphone dialog; run only named spec files (2026-10-18).

## Privacy dialogs and the dev identity

Every dev binary is ad-hoc signed: the native helpers, the fluidaudio-diarize helper, ffmpeg, `Electron.app` in `node_modules` and `dist/mac-arm64/Openstyle.app`. macOS can only identify an ad-hoc binary by its code hash or its path. Each rebuild or new copy gets a new identity, so macOS asks for the Privacy permissions again. The responsible app for these requests is the parent that started them (Claude Code), so the dialogs also appear on the owner's screen.

The fix is a stable local identity named "Openstyle Dev". The owner creates it once. macOS asks for the login password once:

```bash
! bash scripts/dev-signing-setup.sh
```

Never run this script from an agent. Do not run `security`, `codesign`, `tccutil` or any Keychain command by hand. The project scripts (`compile:native`, `download:ffmpeg`, `sign:dev`, `build:mac`, `build:unpack`) run `security find-identity` and `codesign` after the setup. Only the owner runs `sign:dev` after the setup.

After the setup:
- `compile:native`, `download:ffmpeg`, `build:mac` and `build:unpack` sign local builds with the identity. `pnpm --filter @openstyle/electron sign:dev` signs `Electron.app` (also done by `dev` and `test:e2e`). Run `sign:dev` outside `isolated_run`: the scratch `HOME` has no keychain, and `sign:dev` exits with an error there. The documented direct `playwright` command skips `sign:dev`: run `sign:dev` first. `turbo` can restore cached ad-hoc binaries: the signing variables are part of the cache key; use `turbo --force` if in doubt.
- The step does nothing when `CI` is set, when `OPENSTYLE_DEV_SIGN=0`, or when the identity does not exist. `OPENSTYLE_DEV_SIGN_IDENTITY` selects another identity.
- Local builds without the identity (`OPENSTYLE_DEV_SIGN=0`) set `CSC_IDENTITY_AUTO_DISCOVERY=false`. Export it yourself too. Without it, electron-builder finds "Openstyle Dev" in the login keychain and signs with it.
- Run a binary that is ad-hoc signed again, and the old grants do not apply. Grant the permissions once in System Settings.

Proven 2026-10-09 (TCC log, `/usr/bin/log show --predicate 'subsystem == "com.apple.TCC"'`; bare `log` is a zsh builtin; only `AUTHREQ_PROMPTING` means a dialog was shown):
- Every process that Claude Code starts (dev Electron, Playwright, native helpers) asks macOS as Claude Code. Subject and responsible app are `com.anthropic.claude-code`, path `/Users/maheidem/.local/share/claude/versions/<version>`.
- Signing a helper with "Openstyle Dev" did NOT change this. Accessibility, ListenEvent and PostEvent stayed at authValue=0.
- The owner granted Claude Code (that versions path) Accessibility and Input Monitoring in Privacy & Security. Then the helper printed only `READY`, the log showed authValue=2, and no dialog appeared.
- Microphone and Screen & System Audio Recording are NOT granted to Claude Code.
- On this macOS (Darwin 27) the Accessibility list is not labelled "Accessibility" in Privacy & Security.
- Not proven: a Claude Code update changes the versions path, so the grant may need to be added again.
- The Way 2 code (`dev-sign.mjs`, `scripts/dev-signing-setup.sh`) stays. It has no effect for runs that Claude Code starts. It may matter only if the app starts through its own launcher (untested).

Rules for a local real-app run (launch, e2e, site capture):
1. Before the run, check that the current Claude Code path has the grant.
2. Use quiet mode only (`OPENSTYLE_E2E=1`).
3. Tests that touch the microphone or system audio are CI-only, unless the owner says go.
4. Stop at once at any Privacy dialog and report it.

## Enforced by the guard hook

A PreToolUse hook (`scripts/guard-hook.sh`, registered in `.claude/settings.json`) blocks these Bash commands and file writes. It prints one line with the rule letter and exits 2.

| Rule | Blocks | Allowed look-alikes |
|---|---|---|
| a | A network client (curl, wget, node, fetch, python...) to `127.0.0.1:4649` or `localhost:4649` | `grep "localhost:4649"`, `lsof -iTCP:4649`, other ports |
| b | Write, delete or move under `~/.cache/freestyle`, `~/.cache/huggingface`, `~/Library/Application Support/Openstyle`, `/Applications/Openstyle.app` (rm, mv, touch, `>`, `sed -i`, `find -delete`, `cp`/`rsync` into them, `sqlite3` without `-readonly`, Write/Edit tools) | `ls`, `cat`, `du`, `stat`, `sqlite3 -readonly`, `cp` out of them, the same paths under `/tmp` |
| c | `say` without `-o`/`--output-file`, any `afplay` | `say -v <voice> -o <file> "text"` |
| d | `pkill`, `killall`, `kill $(pgrep ... Openstyle)` | `kill <pid>` |
| e | A network client (curl, wget, node, fetch, python...) to `127.0.0.1:8123` or `localhost:8123`: any path, any model, also a health check (owner rule 2026-10-21) | `grep "127.0.0.1:8123"`, other ports |
| f | `osascript` that names Openstyle, `open -a Openstyle`, `open /Applications/Openstyle.app` | other `open` and `osascript` calls |

The hook does not parse quotes. A separator inside a quoted string can make an extra check, so a rare false block is possible. Rewrite the command; do not disable the hook. Test the table with `bash scripts/guard-hook.test.sh` (CI runs it in the Lint job).

To start a test server or app, use `scripts/isolated-env.sh`:

```bash
source scripts/isolated-env.sh /tmp/<task-name> [<dev-mlx-worker-path>]
cd apps/electron && PORT=4651 HOST=127.0.0.1 OPENSTYLE_AUTH_TOKEN=$TOKEN \
  isolated_run nohup node ../server/dist/startup.js > /tmp/<task-name>/server.log 2>&1 &
```

It exports `OPENSTYLE_USER_DATA`, `OPENSTYLE_DB_PATH`, `HF_HOME`, `HUGGINGFACE_HUB_CACHE` and (with the 2nd argument) `OPENSTYLE_MLX_ASR_WORKER`, all in the scratch folder. `isolated_run` sets `HOME` to a scratch home for one command, because the server refreshes the managed worker under `homedir()` before each worker start, also when `OPENSTYLE_MLX_ASR_WORKER` is set (`apps/server/src/lib/mlx-asr/server.ts:401`). It refuses a scratch folder outside `/tmp` or `/private/tmp`.

## 1. Build

```bash
pnpm turbo build --filter=@openstyle/server     # apps/server/dist
pnpm --filter @openstyle/electron build         # apps/electron/out
```

## 2. Start an isolated server

Start the server from `apps/electron`, not from `apps/server`. The diarizer binary, its models and the whisper resources resolve from `<cwd>/resources` (`apps/server/src/lib/meetings/diarize.ts:81-138`). From another folder, diarization is skipped without an error.

```bash
S=/tmp/<task-name>; mkdir -p "$S"
TOKEN=$(openssl rand -hex 16); PORT=4651
cd apps/electron && \
  OPENSTYLE_DB_PATH="$S/db.sqlite" PORT=$PORT HOST=127.0.0.1 \
  OPENSTYLE_AUTH_TOKEN=$TOKEN HUGGINGFACE_HUB_CACHE="$S/hf" \
  nohup node ../server/dist/startup.js > "$S/server.log" 2>&1 &
echo $! > "$S/server.pid"
timeout 30 curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/api/health
```

Leave `OPENSTYLE_LOG_DIR` unset, so the request trace does not go to disk. Exception (Enhance proof, `specs/meeting-enhance-agentic.md` 10.12 step 1): set `OPENSTYLE_LOG_DIR` to the scratch folder (`$S`) only when every transcript and prompt of the run is fictional text. The log `openstyle-trace.log` then holds full request bodies, and the proof compares them with the LLM inspector. Never set it for a real meeting. Delete the scratch folder at the end.

Order matters: `source scripts/isolated-env.sh` runs `unset OPENSTYLE_LOG_DIR` (`scripts/isolated-env.sh:68`). Set the variable after the `source` line and before the server starts, or put it on the same command line as the server start (`OPENSTYLE_LOG_DIR="$S" ... node ../server/dist/startup.js`). After the first request, check that the file exists: `ls "$S/openstyle-trace.log"`. The file holds the full text of the run, so it is fictional data only.

### The MLX worker trap

The server looks for the MLX worker in this order (`apps/server/src/lib/mlx-asr/python.ts:231-250`):
1. The `OPENSTYLE_MLX_ASR_WORKER` override.
2. The managed runtime under `$HOME/.cache/freestyle/mlx-asr/runtime`.
3. The app bundle resources (only inside Electron).
4. A `dist/mlx_asr_worker` in any parent folder.

A repo build leaves `dist/mlx_asr_worker` at the repo root, and a worktree inside the repo has the repo root as a parent. So the server can run a stale local build without any message. Use one of these:
- To test the shipped worker: set `HOME=$S/home` and copy `~/.cache/freestyle/mlx-asr/runtime` into `$S/home/.cache/freestyle/mlx-asr/`.
- To test a new worker build: set `OPENSTYLE_MLX_ASR_WORKER=<path>`. This skips the sha256 check.
- To test the managed download from a local archive: set `OPENSTYLE_MLX_ASR_WORKER_URL=http://127.0.0.1:<port>/<archive>`. This also skips the sha256 check. Serve the archive over HTTP/1.1. `python3 -m http.server` is HTTP/1.0, and it crashed the server's download once (undici `assert(!this.paused)`).

To check which worker runs, read `ps -o args= -p <worker pid>` and the line `started via bundled worker` in `server.log`.

## 3. Seed data

Use the server API first. Send every call with `-H "Authorization: Bearer $TOKEN"`.

| Need | Call |
|---|---|
| Own server | `POST /api/servers {"url":"http://127.0.0.1:<p>"}`. A local fake that answers `GET /v1/models` (and `/v1/models/status` for oMLX kinds) is enough. |
| Default model | `POST /api/models/configured {"provider","model_id","model_name","type":"voice"\|"llm","is_default":true}`. `model_name` is required. |
| Custom MLX model | `POST /api/mlx-asr/custom-models/validate`, then `POST /api/mlx-asr/custom-models {"model":"org/name"}`. Poll `GET /api/mlx-asr/status`. |
| A transcription | `POST /api/transcribe` with the raw WAV body, `content-type: audio/wav`, `x-skip-post-process: true`. For multipart, the field name is `audio`. |

When no route exists (for example history rows with fixed dates, or a meeting with a summary), insert rows with `sqlite3` into the isolated DB before the app starts. Read the columns in `apps/server/src/lib/schema.ts`.

Make a test audio clip:

```bash
say -v Samantha -o "$S/en.aiff" "The quick brown fox jumps over the lazy dog."
afconvert -f WAVE -d LEI16@16000 "$S/en.aiff" "$S/en.wav"     # 16 kHz mono PCM16
# Portuguese: say -v Luciana
```

## 4. Launch the real app against the isolated server

Use `launchOpenstyle` from `apps/electron/tests/helpers/e2e-app.ts`. It sets `OPENSTYLE_USER_DATA`, `OPENSTYLE_DB_PATH`, `OPENSTYLE_SERVER_PORT` (a free port) and `OPENSTYLE_E2E=1`, so the run never uses the real profile or port 4649.

To point the app at your server, do one of these:
- Write `{"serverUrl":"http://127.0.0.1:<PORT>","serverToken":"<TOKEN>"}` into `<userDataDir>/settings.json` before launch (`server-target.ts:36-45`).
- Or use a suite that reads `OPENSTYLE_E2E_SERVER_URL` and `OPENSTYLE_E2E_SERVER_TOKEN` (`tests/model-picker-groups.test.ts`, `tests/meeting-cancel-transcribe.test.ts`, `tests/preset-crud-evidence.test.ts`). Many suites take `OPENSTYLE_EVIDENCE_DIR` for screenshots.

Run a suite:

```bash
OPENSTYLE_E2E_SERVER_URL=http://127.0.0.1:$PORT OPENSTYLE_E2E_SERVER_TOKEN=$TOKEN \
OPENSTYLE_EVIDENCE_DIR="$S/screens" \
pnpm --filter @openstyle/electron test:e2e tests/<suite>.test.ts
```

The first window can be the pill (`pill.html`). Use `waitForDashboardWindow` from the same helper to get the main window.

### Run Electron E2E on this Mac (quiet mode only)

Launch the app or an E2E suite locally only in quiet mode. Prefer CI for the full suite. Quiet mode is on when `OPENSTYLE_E2E=1` on macOS (`launchOpenstyle` sets it). In quiet mode the app has no dock icon, no tray icon, no notification, never takes focus, never sets always-on-top, and every window has opacity 0, ignores the real mouse and is hidden in Mission Control (`quietE2E` in `apps/electron/src/main/index.ts`). Playwright still clicks and takes screenshots over CDP. Never start the app without `OPENSTYLE_E2E=1`: windows then open on the owner's screen.

The suite runs next to the installed app. `launchOpenstyle` sets `OPENSTYLE_SERVER_PORT` to a free port, so the app does not probe or reuse 4649. Main honors that variable only together with `OPENSTYLE_USER_DATA`. Build first (section 1), then run one suite (or omit the file for the full suite):

```bash
S=/tmp/e2e-local; source scripts/isolated-env.sh $S >/dev/null && \
  (cd apps/electron && isolated_run timeout 1500 ./node_modules/.bin/playwright test tests/app.test.ts) 2>&1 | tail -40
rm -rf $S
```

- Use the playwright binary, not `pnpm`, under `isolated_run` (scratch `HOME`).
- To prove a run is quiet: `screencapture -x -m` before and during the run, and count changed pixels. On 2026-10-08 the main display changed by 0.01-0.03% (clock and menu bar stats only). Without `setHiddenInMissionControl` a shown window, even at opacity 0 or off-screen, changed the menu bar tint (5.3%).
- `import-screen` sends one request to port 8123 when a server answers there. Always set `OPENSTYLE_E2E_OMLX_URL=http://127.0.0.1:1` to skip that branch (see "The owner's model server" below).
- New worktree trap: `pnpm install` can leave `node_modules/.pnpm/electron@*/node_modules/electron/dist` with only `LICENSES.chromium.html` (extract-zip quits without an error). Fix: `ditto -x -k ~/Library/Caches/electron/electron-v<ver>-darwin-arm64.zip dist` in that folder and `printf 'Electron.app/Contents/MacOS/Electron' > path.txt`.
- A test must reach the embedded server with `embeddedServerUrl(app)`, never with a hard-coded 4649.
- A new worktree has no `apps/electron/resources/bin`. Run `pnpm --filter @openstyle/electron download:ffmpeg` first, or the import suites fail with "ffmpeg could not decode the file".

## 5. Screenshots and video

- Look at every screenshot yourself before you report it. Look for empty states, spinners, error toasts and cut-off UI. Take a bad one again.
- Use `deviceScaleFactor: 2` for images for the website.
- Mobile web pages: use `isMobile: true, hasTouch: true`. A full-page screenshot in that context resets `pointer: coarse` to false. Take the viewport shot first.
- Video: Playwright `recordVideo` on the context gives a `.webm` of one window.

## 6. Clean up

```bash
kill $(cat "$S/server.pid")          # and every other PID you recorded
rm -rf "$S"                          # keep only the evidence the task asks for
git status --short                   # no stray files
```

## Test Runner app (stable Privacy identity)

**Proven 2026-10-15 (PR #175).** This small app, signed with "Openstyle Dev", starts local test commands. macOS then checks the runner (`com.openstyle.test-runner`), not Claude Code. Claude Code's own grant breaks on every Claude Code update, because it is bound to the versions path.

Proof (TCC log, `AUTHREQ_PROMPTING` count): `tests/app.test.ts` through the runner passed 10/10 three times. Run 1 showed 1 prompt (Documents folder, subject `com.openstyle.test-runner`; the owner allowed it). Run 2: 0 prompts. Run 3, after a rebuild and re-sign of the runner: 0 prompts (designated requirement unchanged: `certificate leaf = H"0671…"`).

Build from the repo root: `node scripts/test-runner/build.mjs`.

Grants: macOS asks the owner once per service for "Openstyle Test Runner". Granted so far: Documents folder. A spec that starts the native key or paste helpers may ask once for Input Monitoring or Accessibility; tell the owner before such a run. Microphone and system-audio tests stay CI-only.

Every local app run, E2E spec or UI proof must run through `scripts/test-runner/run.sh <cwd> -- <command> [args...]`, never directly from the agent shell. This overrides direct run commands above. Keep quiet mode and isolation.

Before and after each run, count `AUTHREQ_PROMPTING` in the TCC log (UI proof step 9). Stop at the first unexpected prompt.

## UI proof of a meetings screen (proven 2026-10-15, PR #172)

A throwaway Playwright spec proved the Speakers dialog with fictional data in 18 s and showed no privacy dialog. Use this recipe; do not discover it again.

1. Name the spec `apps/electron/tests/zz-proof-<topic>.test.ts`. Playwright only finds `*.test.ts`. Delete it at the end. Never commit it.
2. Build first: `cd apps/electron && OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build`.
3. Launch only with `launchOpenstyle()` from `tests/helpers/e2e-app.ts`. It sets `OPENSTYLE_E2E=1` and an isolated profile. Never start the app another way.
4. Before launch, write `config.freestyle.json` with `{"version":1,"flags":{"meetings":true}}` into the isolated profile, as `tests/meeting-import.test.ts` does. Without it the Meetings page is hidden.
5. Set `meeting_enhance_prompt_seen` to `"true"` with `PUT /api/settings/...` on the isolated server. Otherwise a one-time dialog covers the meeting list.
6. Seed with `POST /api/meetings/start` (it accepts a `calendar` object), then sqlite3 on the ISOLATED DB for status and segments. Use fictional names only.
7. Open `app://renderer/meetings` with `page.goto` and click the meeting title. The detail view has no route of its own.
8. Run from the repo root: `OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false scripts/test-runner/run.sh "$PWD/apps/electron" -- timeout 600 pnpm exec playwright test tests/zz-proof-<topic>.test.ts`.
9. Dialog check before and after the run. It must print 0 new lines:
   `/usr/bin/log show --last 10m --predicate 'subsystem == "com.apple.TCC"' --style compact | grep -c AUTHREQ_PROMPTING`
   If a privacy dialog appears, stop at once. Do not click it. Report the service name.
10. Never start a recording, the mic or system audio in a proof.
11. Never stub `permissions:check-mic` (or any permission check) to return "granted". With "granted", the Settings Transcription section calls `getUserMedia` (`settings.tsx:515-529`), and macOS shows a microphone dialog for the Test Runner. This happened on 2026-10-22 (PR #303). If a shot needs a "granted" state, restore the real handler in the same step, before any navigation.
12. Open `/settings` only with a visible section hash, for example `#data`. A hidden hash such as `#network` falls back to the Transcription section, which can probe the mic.

## For pi children

pi children start without skills or context files (`--no-skills --no-context-files`). The coordinating agent must write this line in every pi brief that runs the app, the server or an E2E spec: "Read `.claude/skills/live-testing/SKILL.md` first and follow it." On 2026-10-15 a brief left the line out. The pi child launched the app without the recipe, failed twice, and the owner saw privacy pop-ups. For a UI proof, also paste the recipe steps above into the brief.

## The owner's model server (127.0.0.1:8123): never call it

Owner rule 2026-10-21: nothing may call `127.0.0.1:8123`. No LLM, no ASR, no health check. It is live infrastructure for the owner's dictation and AI cleanup. Use only the app's built-in MLX models in tests and benchmarks. Guard rule e blocks a network client call to that port.

## Synthetic audio is silent

Make synthetic speech only with `say -v <voice> -o <file> "text"`. A `say` call without `-o` plays through the owner's speakers (it happened on 2026-10-07). Never use `afplay` or any other audio playback.

## The MLX worker folder is shared

The server keeps the managed MLX worker in `~/.cache/freestyle/mlx-asr/runtime` (paths from `homedir()`). An isolated test server uses the SAME folder as the installed app and can re-download it (it happened on 2026-10-07 at 15:48). For tests that touch local MLX: set `OPENSTYLE_MLX_ASR_WORKER` to the dev worker you built, or start the server with `HOME` set to a scratch folder. Never let a test write the real worker folder.
