<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

For long-term knowledge entries managed by [lore](https://github.com/BYK/loreai) (gotchas, patterns, decisions, architecture), see [`.lore.md`](.lore.md) in the project root.
<!-- End lore-managed section -->

## Architecture

Openstyle is a local-first dictation app. `apps/electron` (Electron shell) embeds the `apps/server` Hono API server **in-process** — bundled straight into `out/main/index.js`, not a child process. The renderer talks to the server over a typed Hono RPC client for app data; OS-level actions (hotkeys, paste, tray) go through `contextBridge`/`ipcRenderer`.

**Monorepo** (pnpm workspace `apps/*`, `packages/*`, `plugins/*`; Turborepo task runner, no Nx; npm scope `@openstyle/*` — `@freestyle-voice/*` is dead):
- `apps/electron` (`@openstyle/electron`) — Electron main + renderer, embeds the server.
- `apps/server` (`@openstyle/server`) — Hono transcription/API server; also independently buildable.
- `packages/sdk` — plugin contract (Plugin/hooks/registry/loader), used by both apps.
- `packages/stt` — provider-agnostic STT + cleanup utilities on the Vercel AI SDK; used only by `apps/server`.
- `packages/utils` — shared utils incl. the logger (`src/logger.ts`).
- `packages/validations` — shared Zod schemas; gives the Hono RPC client type safety with no codegen.
- `packages/create-openstyle-plugin` — scaffolding CLI for third-party plugin authors, not a dependency of either app.
- `plugins/{audio-transcription,emoji,profanity-filter}` — first-party plugins, shipped opt-in, not baked into `app.asar`.

**Dictation pipeline** (hotkey → delivered text):
1. Native per-platform binary (`apps/electron/native/{macos,windows,linux}-key-listener.*`, spawned by `apps/electron/src/main/key-listener.ts`) emits key-down/up → IPC to the pill (`apps/electron/src/renderer/src/pages/app.tsx`).
2. On WS connect to `GET /api/stream` (`apps/server/src/routes/stream.ts`), the server sends `{sessionTransport}` from `supportsSessionTransport()` (`apps/server/src/lib/streaming/registry.ts`); the renderer latches this once per recording, never re-reading it mid-recording.
3. Capture: streaming-capable providers push PCM over the WS via `apps/electron/src/renderer/src/lib/streamer.ts` (hotkey-up sends `commit`); everyone else (whisper-local) records a 16kHz WAV via `apps/electron/src/renderer/src/lib/recorder.ts`, POSTed to `POST /api/transcribe` (`apps/server/src/routes/transcribe.ts`) on hotkey-up.
4. `beforeTranscribe` hook runs, then `getProvider()` resolves a `TranscriptionProvider` (`apps/server/src/lib/streaming/{registry,types}.ts`) — cloud via `packages/stt/src/transcribe.ts`, local via `apps/server/src/lib/whisper/server.ts` / `apps/server/src/lib/mlx-asr/server.ts` (HTTP to a spawned child process) — then `afterTranscribe` runs.
5. `apps/server/src/lib/post-process.ts` fires `beforeCleanup`, calls the user's configured LLM (`createChatModel()`), then `applyFinalRewrites()` does dictionary replacement + `afterCleanup`; result saved to `transcription_history`.
6. Renderer calls `POST /api/output/deliver` (`apps/server/src/routes/output.ts`, where `beforeOutput` actually fires) then `window.api.pasteText()` (IPC) → `apps/electron/src/main/paste.ts` (sets clipboard, spawns the native `*-fast-paste` binary to simulate the keystroke).

**IPC, three tiers, not one convention**:
1. `apps/electron/src/preload/index.ts` → `window.api` (`contextBridge`): OS-level only (paste, hotkeys, tray, permissions, updater, Remix primitives), hand-written per-channel, no schema framework.
2. App data (settings/models/plugins/history/transcribe/remix/output) over HTTP via `hc<AppType>()` (`apps/electron/src/renderer/src/lib/api.ts`), `AppType` exported from `apps/server/src/index.ts` — main process uses the same pattern (`serverClient()`) to read settings before the renderer is ready.
3. `apps/electron/src/preload/plugin-bridge.ts` → narrower `window.openstyle`, injected only into plugin-UI `WebContentsView`s, confined to that plugin's `/api/plugins/:slug/*` by `apps/server/src/lib/plugin-api-guard.ts`.

**Persistence**: single SQLite file `<userData>/freestyle.db` via Node's built-in `node:sqlite` (`apps/server/src/lib/db.ts`), no ORM. `apps/server/src/lib/schema.ts`: `SCHEMA_VERSION = 28`; migrations run once inside one transaction when `currentVersion < SCHEMA_VERSION` (a fork-only migration numbered below 28 would be silently skipped for anyone arriving with an upstream-stamped DB). Settings are a flat key-value table (keys in `apps/electron/src/shared/settings-keys.ts`, Zod-validated per-key by `packages/validations`); API keys live in a separate `api_keys` table.

**Local model management**: two child-process HTTP servers on loopback ports, neither in-process. whisper.cpp — models/binaries cached at `~/.cache/freestyle/whisper-{models,bin}` (path still says "freestyle" post-rename, deliberately, to avoid re-downloading multi-GB files); managed by `apps/server/src/lib/whisper/{models,server}.ts`. MLX ASR worker (Apple Silicon only) — PyInstaller binary built from `scripts/mlx_asr_server.py`, downloaded per-release from GitHub Releases and sha256-verified, managed by `apps/server/src/lib/mlx-asr/{runtime,server}.ts`.

**Plugin system**: `packages/sdk/src/hooks.ts` defines the hook lifecycle (`event`, `config`, `beforeTranscribe`, `afterTranscribe`, `beforeCleanup`, `afterCleanup`, `beforeOutput`) — despite being modeled as split server/app, every pipeline hook actually executes server-side. `apps/server/src/lib/plugins/loader.ts` loads built-in → npm-specifier (from the `plugins` setting) → local-file (`<userData>/plugins/`) plugins; `installer.ts` installs by fetching `registry.npmjs.org` tarballs directly, no shelled-out `npm install`. `apps/electron/src/main/plugins/` only hosts a plugin's settings UI in a `WebContentsView` and relays app-side events into the server.

**Remix** (in-place rewrite agent): shares the pill window / hotkey / preload machinery but runs entirely outside the dictation pipeline (no plugin hooks, no dictionary, no history row). Two lanes behind one hotkey:
- **Transform** (`apps/server/src/routes/remix/transform.ts` + `lib/remix-transform.ts`) — one preset/instruction + selected text → single LLM call → replacement, recorded to `remix_runs` for Revert.
- **Agent** (`apps/server/src/routes/remix/agent.ts` + `lib/remix-agent.ts`) — `runRemixAgentLocally()` runs an AI-SDK `streamText` loop against the user's own configured LLM (no cloud call). Client-side tools (`REMIX_CLIENT_TOOLS`, `packages/validations/src/remix.ts`) pause the loop and execute via IPC (`window.api.remix*`) in `apps/electron/src/main/index.ts`/`paste.ts`.

## Development commands

Toolchain: pnpm 10+ (pinned `10.32.1` via root `packageManager`), Node 22+. Install with `pnpm install`.

| Purpose | Command |
|---|---|
| Run app (dev) | `pnpm dev` |
| Build all packages (generic) | `pnpm build` |
| Build macOS app (.dmg/.zip) | `pnpm --filter @openstyle/electron build:mac` |
| Build Windows app (NSIS .exe) | `pnpm --filter @openstyle/electron build:win` |
| Build Linux app (AppImage/deb) | `pnpm --filter @openstyle/electron build:linux` |
| Lint | `pnpm biome check .` |
| Format | `pnpm format` |
| Unused files/deps/exports check | `pnpm run knip` |
| Typecheck (CI-matching, safe on a fresh clone) | `pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron typecheck:web` |
| Typecheck (full: main+preload and renderer) | `pnpm --filter @openstyle/electron typecheck` |
| Run all tests | `pnpm test` |
| Run a single test file | `pnpm --filter @openstyle/server test tests/config-route.test.ts` |
| Run e2e tests | `pnpm --filter @openstyle/electron test:e2e` |

Gotchas:
- **Single-test filtering**: never add `--` before the path. `pnpm --filter @openstyle/server test -- tests/x.test.ts` silently drops the filter and runs all ~54 files instead of one — omit the `--`.
- **Typecheck build order**: `apps/electron`'s typecheck pulls in `apps/server`'s source, which imports `@openstyle/stt` via its built `dist/`. On a clean tree, build `@openstyle/server` first (as in the CI-matching command above) or you'll hit `TS2307: Cannot find module '@openstyle/stt'`.
- `pnpm build` on electron only runs `typecheck && electron-vite build` (produces `out/`, not an installable app). The platform `build:*` scripts skip typecheck by design (CI's Typecheck job is the separate gate) and need native toolchains: Xcode Command Line Tools (macOS/Swift), MSVC or MinGW (Windows), X11/XTest/GIO/uinput dev headers (Linux), and `python3.12` on `PATH` for the MLX ASR worker (macOS/Apple Silicon only).

Releases (version bump, branch, CI build, manual GitHub Release publish) are done via the release skill at `.claude/skills/release/SKILL.md` — the repo's automated "Release" workflow is currently broken (missing GitHub App secrets), so don't use it.

## Engineering specs & audits (`specs/`)

Internal design docs, technical specs, and audits written before/alongside
implementation live in [`specs/`](specs/). Consult them for the *why* behind
refactors and the investigation trail for past changes — they're high-quality
context when working on a related area. Examples:

- Technical specs: `model-experience-redesign.md`, `freestyle-transcribe-ui-refactor.md`,
  `redesign-models-page.md`, `mlx-hub-download-migration.md`.
- Audits: `openstyle-separation-audit.md` (the freshest and most relevant to
  this fork — tracks what still ties openstyle to upstream freestyle-voice/freestyle),
  `app-stability/app-stability-audit.md`, `language-setting-audit.md`, `transcription-audit.md`.

Note: `specs/` is **internal engineering documentation only** — there is no
separate user-facing docs site; it was deliberately removed in the v1.0.0
cloud cut (see `README.md`'s removed-vs-kept list) since docs describing a
since-gone cloud product were judged worse than none. Some specs predate that
cut and describe now-removed cloud features with no removal annotation (e.g.
`freestyle-cloud-auth.md`, `cloud/support-freestyle-cloud.md`) — cross-check
against `README.md` before treating one of those as current.
