<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

For long-term knowledge entries managed by [lore](https://github.com/BYK/loreai) (gotchas, patterns, decisions, architecture), see [`.lore.md`](.lore.md) in the project root.
<!-- End lore-managed section -->

## Architecture

Openstyle is a local-first dictation **and meeting-notes** app — a fork of `freestyle-voice/freestyle` at tag `0.7.1`, developed and tested on macOS/Apple Silicon. `apps/electron` (Electron shell) embeds the `apps/server` Hono API server **in-process** — bundled straight into `out/main/index.js`, not a child process (`startServer()` imported from `@openstyle/server`; loopback port 4649 with a `startServer(0)` ephemeral-port fallback, `apps/electron/src/main/index.ts`). The renderer talks to the server over a typed Hono RPC client for app data; OS-level actions (hotkeys, paste, tray, capture) go through `contextBridge`/`ipcRenderer`. There is no account, no hosted service and no telemetry — the only outbound network calls are to the STT/LLM providers the user configured with their own keys.

**Monorepo** (pnpm workspace `apps/*`, `packages/*`, `plugins/*`; Turborepo task runner, no Nx; npm scope `@openstyle/*` — `@freestyle-voice/*` is dead):
- `apps/electron` (`@openstyle/electron`) — Electron main + renderer, embeds the server.
- `apps/server` (`@openstyle/server`) — Hono API server (dictation, meetings, remix, models, settings); also independently buildable and shipped as its own container image (`ghcr.io/maheidem/openstyle-server`).
- `packages/stt` — provider-agnostic STT + text/cleanup utilities on the Vercel AI SDK; used only by `apps/server`.
- `packages/utils` — shared utils incl. the logger (`src/logger.ts`).
- `packages/validations` — shared Zod schemas; gives the Hono RPC client type safety with no codegen.
- `packages/sdk` — **half vestigial**: the plugin contract (`Plugin`/hooks/registry/loader, see "Plugin system: removed" below) is dead code nothing loads any more, but both apps still import small shared bits from it — `OutputMode` (`apps/electron/src/main/index.ts`) and `parseAppContext`/`AppContextPayload` (`apps/server/src/lib/streaming/transcribe-bias.ts`, `lib/editor/app-context.ts`). Do not delete it without relocating those.
- `packages/create-openstyle-plugin`, `templates/{basic,with-ui}`, `plugins/{audio-transcription,emoji,profanity-filter}` — plugin scaffolding + first-party plugins. Still built by CI's `build-plugins` job, still inert at runtime. Same caveat.

**Dictation pipeline** (hotkey → delivered text):
1. Native per-platform binary (`apps/electron/native/{macos,windows,linux}-key-listener.*`, spawned by `apps/electron/src/main/key-listener.ts`) emits key-down/up → IPC to the pill (`apps/electron/src/renderer/src/pages/app.tsx`, its own `pill.html` renderer entry).
2. **Optional per-language hotkeys** (`specs/dictation-language-hotkeys.md`, `language_hotkeys` setting): each configured language can bind a second hotkey that runs the identical flow but pins that one language for the whole recording — via the WS `start` message's `language` field (`languageOverride` in `apps/server/src/routes/stream.ts`) or the `x-dictation-language` header on the batch path (`routes/transcribe.ts`), both funnelled through `resolveLanguageOverride()` (`apps/server/src/lib/language.ts`) so the membership guard can't be bypassed. Pinning also fixes the cleanup prompt's language block, killing the `languages[0]` translate-drift bug class. The default hotkey's behaviour is untouched.
3. On WS connect to `GET /api/stream` (`apps/server/src/routes/stream.ts`), the server sends `{sessionTransport}` from `supportsSessionTransport()` (`apps/server/src/lib/streaming/registry.ts`); the renderer latches this once per recording, never re-reading it mid-recording.
4. Capture: streaming-capable providers (`apps/server/src/lib/streaming/providers/*`) push PCM over the WS via `apps/electron/src/renderer/src/lib/streamer.ts` (hotkey-up sends `commit`); everyone else (whisper-local) records a 16kHz WAV via `apps/electron/src/renderer/src/lib/recorder.ts`, POSTed to `POST /api/transcribe` on hotkey-up.
5. `getProvider()` resolves a `TranscriptionProvider` (`apps/server/src/lib/streaming/{registry,types}.ts`) — cloud via `packages/stt/src/transcribe.ts`, local via `apps/server/src/lib/whisper/server.ts` / `apps/server/src/lib/mlx-asr/server.ts` (HTTP to a spawned child process) — with the vocabulary-bias prompt from `apps/server/src/lib/vocabulary-bias.ts`.
6. `apps/server/src/lib/post-process.ts` calls the user's configured LLM (task-resolved, see "LLM task profiles"), then `applyFinalRewrites()` does dictionary replacement; the result is saved to `transcription_history`. `stripVocabLeak()` (`packages/stt/src/text.ts`) runs on the raw text on **both** the batch and streaming paths: the vocabulary-bias prompt is sent as the ASR `prompt`/`context` on every chunk and weak audio makes models recite it back as fake speech.
7. Delivery: the renderer calls `window.api.pasteText()` (IPC) → `apps/electron/src/main/paste.ts` (sets clipboard, spawns the native `*-fast-paste` binary to simulate the keystroke). **There is no `POST /api/output/deliver` any more** — `apps/server/src/routes/output.ts` was deleted with the plugin system; delivery is renderer → IPC, nothing server-side.

**Meeting Mode** (`specs/meeting-mode.md` → `-diarization.md` → `-transcription-quality.md` → `-speaker-naming.md`; read in that order). Records a meeting as **two channels that are never mixed**: *Me* = the microphone, captured by a hidden `BrowserWindow` running `apps/electron/src/renderer/meeting-capture.html` / `src/renderer/src/meeting-capture.ts` (getUserMedia → AudioWorklet → 16 kHz mono PCM16 over IPC `meeting:mic-chunk`); *Them* = system audio, captured by the native `native/macos-system-audio.swift` Core Audio process tap, spawned and supervised by `src/main/system-audio-capture.ts` (raw PCM on stdout, JSON handshake on stderr). `src/main/meeting-recorder.ts` owns the session and writes `<userData>/meetings/<id>/{mic.wav,system.wav,sync.json}`, enforces the `meeting_max_duration_hours` ceiling, and marks a crash-leftover `recording` row `interrupted` on relaunch. Channel separation *is* the attribution strategy — model-based speaker ID is an optional later pass.

The processing pipeline is server-side, in `apps/server/src/lib/meetings/` (HTTP surface: `apps/server/src/routes/meetings.ts`): `segmenter.ts` (energy-gate split of each channel into bounded chunks so one bad chunk can't lose the meeting) → `transcriber.ts` (same provider resolution and vocabulary bias as dictation; yields the single local whisper server to in-flight dictations via `lib/dictation-activity.ts`) → `merge.ts` (pure: clock-drift correction, whisper silence-hallucination + stuck-loop filters, mic/system echo dedup, timestamp interleave) → `diarize.ts` (optional FluidAudio pass, **system channel only**, writes `speaker_label`) → `speaker-names.ts` (post-merge pass resolving per-meeting names/merges; `meeting_speakers`) → `summarize.ts` (markdown summary, single call or sentence-boundary map/reduce over the context budget) and `enhance.ts` (LLM cleanup pass, writes `enhanced_text` — a separate column, so raw ASR text is never destroyed). `language.ts` resolves the transcription language **once per meeting** and persists it to `meetings.language` (a multi-language `languages[0]` pin otherwise silently translates secondary languages). `retention.ts` deletes only the WAVs after `meeting_retention_days` and nulls `audio_dir` as the "audio is gone" marker; DB rows persist. Failure posture across all of this is fail-closed: any stage error degrades silently to the previous behaviour, never a dead meeting.

Diarization runs the `fluidaudio-diarize` helper — a SwiftPM package at `apps/electron/native/fluidaudio-diarize/`, built by `scripts/compile-native.js` to `resources/bin/darwin-arm64/`, with its ~22 MB `.mlmodelc` set **pre-bundled** under `resources/models/speaker-diarization` (macOS `extraResources`), not downloaded. Both binary and model lookups are deliberate *candidate lists* (`resourcesPath` then `cwd/resources`), not a `resourcesPath ? packaged : dev` branch — that shape is what made dev-mode diarization silently take the packaged branch (fixed in `de9928e`). Don't "simplify" it back.

**LLM task profiles & parameter presets** (`specs/llm-task-profiles.md`): every LLM call site declares one of four task ids (`LLM_TASK_IDS` in `packages/validations/src/llm-task-profiles.ts`) — `cleanup`, `remix`, `meetingSummarize`, `meetingEnhance` — and gets that task's code-defined defaults (reasoning on/off, temperature, output budget as a number or `"auto"` to keep the call site's own heuristic, timeout) from `apps/server/src/lib/llm/task-profiles.ts`. User-defined parameter presets are named raw-JSON blobs in settings, assignable per task, passed **verbatim** to OpenAI-compatible endpoints (`local-llm`) and as a mapped safe subset (minus `LLM_PRESET_DENYLIST_KEYS`) to cloud/native-SDK providers. Resolution runs fresh on every call via `resolveTaskCall()`; the old global `cleanup_sampling` blob still exists but only as a read-time fallback for legacy rows.

**Auto-update**: macOS builds are ad-hoc signed, so Squirrel.Mac rejects its own updates *after* downloading them. `apps/electron/src/main/index.ts` therefore keeps `electron-updater` only to *check* the feed (`autoDownload` is always false) and installs through `src/main/self-updater.ts` / `self-updater-core.ts` (download → sha verify → unzip → bundle swap → relaunch, manifest at `github.com/Maheidem/openstyle/releases/latest/download/latest-mac.yml`). Other platforms keep the stock electron-updater install path. Consequence for users: TCC permissions re-prompt after every update until Developer ID signing + notarization exist — not a regression.

**IPC, two tiers, not one convention**:
1. `apps/electron/src/preload/index.ts` → `window.api` (`contextBridge`): OS-level only (paste, hotkeys, tray, permissions, updater, meeting capture/recorder, Remix primitives), hand-written per-channel, no schema framework.
2. App data (settings/models/history/vocabulary/meetings/transcribe/remix) over HTTP via `hc<AppType>()` (`apps/electron/src/renderer/src/lib/api.ts`), `AppType` exported from `apps/server/src/index.ts` — the main process uses the same pattern (`serverClient()` in `src/main/index.ts`) to read server-owned data before the renderer exists. `apiFetch()` is documented as reserved for what the typed client can't express (binary WAV bodies, fire-and-forget beacons) and merges auth headers additively — never clobber a caller-set header; `remix-chat.tsx` uses it off-convention, so prefer `getClient()` in new code.
3. A third tier (`window.openstyle`, `apps/electron/src/preload/plugin-bridge.ts`) existed for plugin UI; it was deleted with the plugin system. Nothing injects a narrowed bridge into a `WebContentsView` any more.

Both tiers sit behind the same trust boundary server-side: `trustedOriginMiddleware` + a CORS allowlist (`apps/server/src/lib/trusted-origin.ts`, `app://` or loopback dev origins only) and always-on bearer auth (`apps/server/src/lib/auth.ts`).

**Persistence**: single SQLite file `<userData>/freestyle.db` via Node's built-in `node:sqlite` (`apps/server/src/lib/db.ts`), no ORM. `apps/server/src/lib/schema.ts`: `SCHEMA_VERSION = 34`; migrations run once inside one transaction when `currentVersion < SCHEMA_VERSION` — upstream's 0.8.x line stamped 26, so a fork-only migration numbered below that would be silently skipped for anyone arriving with an upstream-stamped DB; keep `SCHEMA_VERSION` above the highest upstream stamp. Meeting tables (`meetings`, `meeting_segments`, `meeting_summaries`, `meeting_speakers`) plus `transcription_history`, `dictionary`, `vocabulary`, `remix_threads/messages/runs`, `settings`, `api_keys`. Settings are a flat key-value table (keys in `apps/electron/src/shared/settings-keys.ts`, Zod-validated per-key by `packages/validations`); API keys live in a separate `api_keys` table and are redacted on read.

**Local model management**: two child-process HTTP servers on loopback ports, neither in-process. whisper.cpp — models/binaries cached at `~/.cache/freestyle/whisper-{models,bin}` (`MODEL_CACHE_DIR_NAME = "freestyle"` in `apps/server/src/lib/model-cache.ts`; the path still says "freestyle" post-rename, deliberately, to avoid re-downloading multi-GB files); managed by `apps/server/src/lib/whisper/{models,server}.ts`. MLX ASR worker (Apple Silicon only) — PyInstaller binary built from `scripts/mlx_asr_server.py`, downloaded per-release from GitHub Releases and sha256-verified, managed by `apps/server/src/lib/mlx-asr/{runtime,server}.ts`.

**Plugin system: removed** — commit `6211514` (`refactor(electron)!`, v2.0.0) deleted it end to end: main-process plugin host, `plugin-bridge`, renderer plugin pages/API, server plugin routes, and the plugin stage of the pipeline. There are **no `beforeTranscribe`/`afterTranscribe`/`beforeCleanup`/`afterCleanup`/`beforeOutput` hooks anywhere** — that logic now lives inline in `routes/transcribe.ts`, `routes/stream.ts`, and `lib/post-process.ts`. `packages/sdk`, `plugins/*` and `templates/*` survive as scaffolding that still builds but is never loaded (see the monorepo list). `README.md` still advertises "Plugins — extend the dictation pipeline. See `packages/sdk`"; treat that line as stale.

## Development commands

Toolchain: pnpm 10+ (pinned `10.32.1` via root `packageManager`), Node 22+. Install with `pnpm install`.

| Purpose | Command |
|---|---|
| Run app (dev) | `pnpm dev` |
| Build all packages (generic) | `pnpm build` |
| Build macOS app (.dmg/.zip) | `pnpm --filter @openstyle/electron build:mac` |
| Build Windows app (NSIS .exe) | `pnpm --filter @openstyle/electron build:win` |
| Build Linux app (AppImage/deb) | `pnpm --filter @openstyle/electron build:linux` |
| Compile native helper binaries only | `pnpm --filter @openstyle/electron compile:native` |
| Fetch/build the bundled ffmpeg (run once for local dev; Import needs it, `build:*` runs it automatically) | `pnpm --filter @openstyle/electron download:ffmpeg` |
| Lint | `pnpm biome check .` |
| Format | `pnpm format` |
| Unused files/deps/exports check | `pnpm run knip` |
| Typecheck (CI-matching, safe on a fresh clone) | `pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron typecheck:web` |
| Typecheck (full: main+preload and renderer) | `pnpm --filter @openstyle/electron typecheck` |
| Run all tests | `pnpm test` |
| Run server tests | `pnpm --filter @openstyle/server test` |
| Run a single test file | `pnpm --filter @openstyle/server test tests/config-route.test.ts` |
| Run Electron vitest (non-e2e) | `pnpm --filter @openstyle/electron test` |
| Run e2e tests | `pnpm --filter @openstyle/electron test:e2e` |

Gotchas:
- **Single-test filtering**: never add `--` before the path. `pnpm --filter @openstyle/server test -- tests/x.test.ts` silently drops the filter and runs all ~59 files instead of one — omit the `--`.
- **Typecheck build order**: `apps/electron`'s typecheck pulls in `apps/server`'s source, which imports `@openstyle/stt` via its built `dist/`. On a clean tree, build `@openstyle/server` first (as in the CI-matching command above) or you'll hit `TS2307: Cannot find module '@openstyle/stt'`.
- `pnpm build` on electron only runs `typecheck && electron-vite build` (produces `out/`, not an installable app). The platform `build:*` scripts skip typecheck by design (CI's Typecheck job is the separate gate) and need native toolchains: Xcode Command Line Tools (macOS/Swift), MSVC or MinGW (Windows), X11/XTest/GIO/uinput dev headers (Linux), and `python3.12` on `PATH` for the MLX ASR worker (macOS/Apple Silicon only).
- **`compile:native` warn-and-continues locally** when a helper can't build, but CI fails if `fluidaudio-diarize` is missing — always `ls apps/electron/resources/bin/darwin-arm64/` before trusting a local build. Swift helpers need an explicit macOS deployment target (`-target`) or they break in CI.
- **knip is a CI gate** (`pnpm run knip`, separate job, runs on every push): any new file must be imported, or listed in `knip.jsonc` (`ignoreFiles` / workspace `entry`), or the Build & Test workflow fails. Renderer entries are enumerated explicitly in `knip.jsonc` — a new `.html` entry point needs an `entry` addition.
- **Biome ignores `specs/design/*.html`** and all `*.css` (`biome.json` `files.includes`); design mockups in `specs/design/` are verbatim source-of-truth artifacts — do not reformat or edit them.
- e2e runs under `xvfb-run` in CI after a full electron build; locally it needs the app built first.

Releases: use the release skill at `.claude/skills/release/SKILL.md`. The automated Craft release train (`gh workflow run release.yml -f version=auto` → Build & Test on `release/<version>` → label the publish-request issue `accepted` → `publish.yml` publishes and merges) is the primary path and is proven end-to-end since v1.1.1; the manual `gh release create` procedure at the bottom of that skill is the fallback for when the GitHub App secrets break. Releases ship 4 assets (dmg, arm64 zip, `latest-mac.yml`, the mlx_asr_worker tarball) with a bare semver tag, no `v` prefix — auto-update reads `latest-mac.yml`, so a filename mismatch silently breaks it. Version + changelog live in `apps/electron/package.json` and `CHANGELOG.md`.

## UI conventions

- Design tokens and the accent discipline live in `specs/design-system.md` and `apps/electron/src/renderer/src/globals.css`. The accent is deliberately **neutral grey**; `--accent-passive-tint`/`--accent-passive-ink` (blue) are the only sanctioned blue fills (selection, speaker/diarization chips), `--live` (coral) is **recording/live only**, and `--destructive` is kept distinct from both. Check that file before styling, and `specs/design/reskin-mockups.html` for pixel-level truth.
- i18n: 7 locales (`de,en,es,fr,it,ja,pt`) plus `template.json`; follow `apps/electron/src/renderer/src/locales/README.md` — copy the template, never translate `{{placeholders}}`. New user-facing strings go through `t()`, not hardcoded.

## Engineering specs & audits (`specs/`)

Internal design docs, technical specs, and audits written before/alongside
implementation live in [`specs/`](specs/). Consult them for the *why* behind
refactors and the investigation trail for past changes — they're high-quality
context when working on a related area. Current areas:

- Meeting Mode chain (read in order): `meeting-mode.md`, `meeting-diarization.md`,
  `meeting-transcription-quality.md`, `meeting-speaker-naming.md`.
- Other technical specs: `llm-task-profiles.md`, `dictation-language-hotkeys.md`,
  `design-system.md`, `voice-pill-motion.md`, `model-experience-redesign.md`,
  `redesign-models-page.md`, `redesign-model-selection-modal.md`,
  `mlx-hub-download-migration.md`, `hf-hub-download-adoption.md`, `remix.md`,
  `freestyle-transcribe-ui-refactor.md`.
- Audits: `openstyle-separation-audit.md` (what still ties openstyle to upstream
  freestyle-voice/freestyle), `app-stability/app-stability-audit.md`,
  `language-setting-audit.md`, `transcription-audit.md`.
- Forward-looking: `roadmap-2026-08.md` (post-2.3.0 research; note its own
  methodology warning that `README.md`/`AGENTS.md` baselines lag the code).

House convention: non-trivial features land a spec in `specs/` first, written
against `file:line` citations of the tree at that moment, then the implementation
follows it. Those citations go stale fast — re-verify against the code before
implementing from one. Some specs also predate the v1.0.0 cloud cut and describe
since-removed cloud features with no removal annotation (e.g.
`freestyle-cloud-auth.md`, `cloud/support-freestyle-cloud.md`); cross-check
against `README.md` before treating one as current. `specs/` is **internal
engineering documentation only** — there is no user-facing docs site; it was
removed outright in that cut (see `README.md`'s removed-vs-kept list), since
docs describing a gone cloud product were judged worse than none.
