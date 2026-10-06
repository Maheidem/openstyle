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

Leave `OPENSTYLE_LOG_DIR` unset, so the request trace does not go to disk.

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

Use `launchOpenstyle` from `apps/electron/tests/helpers/e2e-app.ts`. It sets `OPENSTYLE_USER_DATA`, `OPENSTYLE_DB_PATH` and `OPENSTYLE_E2E=1`, so the run never uses the real profile.

To point the app at your server, do one of these:
- Write `{"serverUrl":"http://127.0.0.1:<PORT>","serverToken":"<TOKEN>"}` into `<userDataDir>/settings.json` before launch (`server-target.ts:36-45`).
- Or use a suite that reads `OPENSTYLE_E2E_SERVER_URL` and `OPENSTYLE_E2E_SERVER_TOKEN` (`tests/model-picker-groups.test.ts`, `tests/meeting-cancel-transcribe.test.ts`, `tests/preset-crud-evidence.test.ts`). Many suites take `OPENSTYLE_EVIDENCE_DIR` for screenshots.

Run a suite:

```bash
OPENSTYLE_E2E_SERVER_URL=http://127.0.0.1:$PORT OPENSTYLE_E2E_SERVER_TOKEN=$TOKEN \
OPENSTYLE_EVIDENCE_DIR="$S/screens" \
pnpm --filter @openstyle/electron test:e2e tests/<suite>.test.ts
```

The first window can be the pill (`pill.html`) or the remix bar (`bar.html`). Use `waitForDashboardWindow` from the same helper to get the main window.

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

## For pi children

pi children start without skills or context files (`--no-skills --no-context-files`). The coordinating agent must write this line in every pi brief that runs the app or the server: "Read `.claude/skills/live-testing/SKILL.md` first and follow it."
