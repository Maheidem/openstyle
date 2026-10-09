# Under the Hood: Seven Internal Changes

**Status:** Draft
**Date:** 2026-10-09
**Branch:** `feat/under-the-hood` (base `d004a34`, release 2.14.2)
**Owner:** coordinator session (Claude main thread)

Grounded in the tree at `d004a34`. Every `file:line` below was read on that
revision. Citations go stale fast: read the cited site again before you
change it. "Unverified" marks a claim that this spec could not prove from
code or a command.

Companion reading: `specs/lean-audit-2026-09.md` (T2-1, T2-3, T2-6, D2,
E3), `specs/app-stability/app-stability-audit.md` §3.1, and
`.claude/skills/live-testing/SKILL.md` (all proofs).

---

## 1. Goal

Make the app more robust and easier to change, with no change that a user
can see, except where an item says so:

1. Sign and notarize the app (DEFERRED, see item 1).
2. Run the Hono server outside the Electron main process, with crash restart.
3. Capture meeting mic and system audio in one native helper, on one clock.
4. Filter key events in the macOS key listener and supervise it.
5. Split `main/index.ts` and `pages/app.tsx` into modules.
6. Download updates as a delta, not the full zip.
7. Use SQLite FTS5 for history search.

## 2. Non-goals

- No Rust or Tauri rewrite.
- No feature change. Each item keeps the current behavior, unless the item
  names a difference and the owner accepts it (see Open questions).
- Mac-only. Do not change Windows or Linux paths, unless a change breaks
  their build. CI still builds Windows and Linux (`.github/workflows/build.yml:203,334`).
- No change to the server auth model (the trusted-origin fallback stays, see item 2).
- Dictation capture stays in the renderer (see item 3, "Scope decision").

## 3. Order of work

Each item lands as its own commit or commits on this one branch. The branch
stays a draft PR until all non-deferred items (2-7) are done. The
coordinator opens the draft PR (`.claude/skills/branch-lifecycle/SKILL.md`).
At 2026-10-09, `gh pr list --head feat/under-the-hood` returned no PR.

| Step | Item | Reason for this position |
|---|---|---|
| 1 | 5. Split god modules | Gives items 2, 4 and 6 a small module to change (`server-host.ts`, `hotkeys/`, `updater.ts`). Pure move, so a failure is easy to find. |
| 2 | 7. FTS5 search | Server-only, small, independent. Gives an early green commit. |
| 3 | 4. Key listener filter | Small Swift change on the hot input path. Needs a manual keystroke pass, so do it while the branch is still small. |
| 4 | 6. Delta updates | Self-contained in the updater module. The pure core can be proved with commands and two real release zips. |
| 5 | 2. Server out of process | Large structural change. Uses the `server-host.ts` seam from step 1. |
| 6 | 3. Native meeting capture | Largest risk. Needs the owner for a real-meeting check and the meeting benchmark. Last, so it cannot block the other items. |
| - | 1. Developer ID | Deferred. No work on this branch. |

---

## Item 1. Sign and notarize the app (DEFERRED)

**Status: Deferred, blocked on Apple Developer ID.** The owner will not buy
an Apple Developer Program membership now. This section keeps the plan
ready. Do not start it on this branch.

### Current state

- The installed app is ad-hoc signed. Command
  `codesign -dv /Applications/Openstyle.app` prints `Signature=adhoc`,
  `TeamIdentifier=not set`, `flags=0x10002(adhoc,runtime)`.
- CI builds without signing secrets on purpose
  (`.github/workflows/build.yml:310-316`).
- `electron-builder.yml:60` sets `notarize: true`. Unverified: how
  electron-builder 26 acts on this key with no Apple credentials. CI passes
  today, so it does not fail the build.
- The entitlements disable library validation, because ad-hoc signatures
  have no Team ID (`apps/electron/build/entitlements.mac.plist:11-18`).
- Squirrel.Mac rejects ad-hoc updates, so a custom self-updater installs
  updates (`apps/electron/src/main/self-updater-core.ts:5-12`).
- Each update changes the ad-hoc identity. macOS then asks again for 3-4
  TCC permissions (`specs/lean-audit-2026-09.md:143-144`, AGENTS.md:41).
- Helpers that ship in `resources/bin/darwin-arm64` (local `ls`): `ffmpeg`,
  `fluidaudio-diarize`, `macos-ax`, `macos-fast-paste`,
  `macos-key-listener`, `macos-media-control`, `macos-output-volume`,
  `macos-system-audio` (plus `macos-mic-listener`, which the lean audit
  says no longer ships, `specs/lean-audit-2026-09.md:277-281`).
- The MLX worker is a PyInstaller binary that the app downloads at run time
  (AGENTS.md:52). It is not inside the app bundle.

### Change (when unblocked)

1. The owner buys the membership and creates a "Developer ID Application"
   certificate and an App Store Connect API key.
2. The coordinator adds CI secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`,
   `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
3. Sign each helper in `resources/bin` with the hardened runtime, in the
   build step before electron-builder packs the app.
4. Remove `disable-library-validation` if the app and all helpers then
   load with it off. Keep it if the MLX worker needs it (Unverified).
5. Decide how the downloaded MLX worker gets a valid signature (sign it in
   the release job, or keep the current ad-hoc path).
6. Keep the self-updater (item 6 depends on it). Squirrel.Mac is then an
   option, but a change to it is out of scope.

**Risks:** the first signed update asks for TCC permissions one more time,
because the identity changes (`specs/lean-audit-2026-09.md:144`); say so
in the changelog. An unsigned helper fails under the hardened runtime
with no clear error.

**Proof and done when (when unblocked):**

- [ ] `codesign -dv --verbose=4` on the app and each helper shows the Team ID.
- [ ] `spctl -a -vv` on the app prints `source=Notarized Developer ID`.
- [ ] An update from signed N to signed N+1 shows zero TCC dialogs.

---

## Item 2. Run the server outside the main process

### Current state

- Main imports the server and runs it inside the main process
  (`apps/electron/src/main/index.ts:49-57`, started at `:1888-1937`).
- Port logic in main: try 4649, on `EADDRINUSE` fall back to port 0
  (`index.ts:1896-1901`). Reuse an Openstyle server that already answers on
  4649 (`index.ts:1919-1935`). Test runs pin a port with
  `OPENSTYLE_SERVER_PORT` (`index.ts:1908-1929`).
- Main sets `OPENSTYLE_DB_PATH` and `OPENSTYLE_MLX_ASR_RELEASE_TAG` in its
  own `process.env` before the server starts (`index.ts:1868-1873`).
- Main calls server functions in-process:
  - `reconcileUnsupportedMlxVoiceDefault()` at boot (`index.ts:1884-1886`),
  - `activateManagedMlxRuntimeForAppVersion()` (`index.ts:1939-1949`),
  - `prefetchManagedMlxRuntimeForAppRelease()` after an update download (`index.ts:2123`),
  - `stopWhisperServer()`, `stopMlxServer()`, `closeDb()` in factory reset
    (`index.ts:1160-1173`) and quit (`index.ts:3669-3670`),
  - `getLocalModelCacheDirs()` in `disk-usage.ts:15,55`. This function
    reads the DB (`listCustomMlxDefs()`,
    `apps/server/src/lib/mlx-asr/custom-models.ts:95-98`).
- An uncaught exception anywhere in the process shows a dialog and quits
  the whole app (`index.ts:244-261`). A server bug thus ends the app.
- Main and server log to one file (`index.ts:218-230`).
- Auth: the embedded server mints a token that nobody receives. It lets
  requests in on a trusted Origin or with no Origin
  (`apps/server/src/lib/auth.ts:15-25`, `apps/server/src/index.ts:195-202`).
- The renderer gets the port over IPC `server:port`
  (`apps/electron/src/main/app-settings-ipc.ts:37`) and talks HTTP and WS to it.
- The server finds bundled binaries through `process.resourcesPath`
  (`apps/server/src/lib/audio/decode.ts:100-103`,
  `lib/meetings/diarize.ts:86-89,126-129`, `lib/whisper/constants.ts:166-170`,
  `lib/mlx-asr/python.ts:235,307`).
- The server spawns children: whisper.cpp (HTTP), MLX worker (stdin/stdout),
  ffmpeg, `fluidaudio-diarize` (AGENTS.md:25,37,52).
- The import OOM case in lean-audit T2-1 is already fixed. Peak memory is
  about one decoded WAV (`specs/lean-audit-2026-09.md:270`). The main
  reason for this item is now crash isolation, not import memory.

### Change

1. Add a utility-process entry `apps/electron/src/server-host/entry.ts`.
   Build it as a second input of the `main` build in
   `electron.vite.config.ts:64-80`, so it lands in `out/main/` and
   `check-bundled-requires.mjs` covers it.
2. The entry does this, in order:
   - If `process.resourcesPath` is undefined, set it from env
     `OPENSTYLE_RESOURCES_PATH`. Main passes this value. (Unverified:
     whether Electron defines `process.resourcesPath` in a utility process.)
   - Call `enableFileLogging(OPENSTYLE_LOGS_DIR)`.
   - Run `reconcileUnsupportedMlxVoiceDefault()` and, in a packaged build,
     `activateManagedMlxRuntimeForAppVersion(version)`.
   - Call `startServer({ port, host: "127.0.0.1" })` with no token, as
     today. Keep the `EADDRINUSE` to port 0 fallback.
   - Post `{ type: "ready", port }` on `process.parentPort`.
   - Handle messages: `shutdown` (stop whisper and MLX, close the server,
     `closeDb()`, exit 0), `prefetch-mlx` (version), `model-cache-dirs`
     (reply with `getLocalModelCacheDirs()`).
3. Add `apps/electron/src/main/server-host.ts`. It owns the boot block that
   is now at `index.ts:1888-1949`:
   - Keep the 4649 probe and the pinned-port logic in main.
   - Fork with `utilityProcess.fork(path, [], { serviceName: "Openstyle Server", env, stdio: "pipe" })`.
   - On `ready`, call `setServerPort(port)`.
   - On an exit that main did not ask for, restart with backoff
     (1 s, 2 s, 4 s, 8 s, 16 s). Ask for the same port first. Stop after
     5 restarts in 60 s and log an error.
   - After a restart on a new port, call `broadcastServerChanged()`
     (`index.ts:356`), so windows read the port again.
4. Replace the in-process calls:
   - `disk-usage.ts`: ask the utility process with `model-cache-dirs`.
     Do not add an HTTP route: a configured remote server would answer
     with remote paths.
   - Factory reset (`index.ts:1159-1178`): send `shutdown`, wait for exit
     (5 s cap, then kill), then delete the DB files.
   - Quit (`index.ts:3663-3694`): send `shutdown`, wait up to 3 s, then
     kill. `before-quit` must still end in `app.exit(0)` (`index.ts:3702-3732`).
5. Remove the `@openstyle/server` runtime import from main. Keep
   `import type { AppType }` (`server-target.ts:2`, `meeting-ipc.ts:11`).

### Risks

- **Orphan children.** If the utility process dies by a crash, whisper.cpp
  may keep running. Unverified: whether the MLX worker exits on stdin EOF.
  The proof below checks `ps` after a forced kill.
- **Boot time.** A fork adds start-up cost. Baseline: `/api/health` at
  about 535 ms (`specs/lean-audit-2026-09.md:169`). The hotkey registers
  with the default key before the server is up (`index.ts:2256`), so the
  hotkey is not delayed.
- **Two DB openers.** Only the utility process may open `freestyle.db`.
  After step 4, no main-side code imports server modules that call `getDb()`.
- **Packaging.** The new entry must be self-contained (AGENTS.md:87).

### Proof

Follow `.claude/skills/live-testing/SKILL.md`. Quiet mode only
(`OPENSTYLE_E2E=1` through `launchOpenstyle`).

1. Build: `pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron build`.
2. Run `node apps/electron/scripts/check-bundled-requires.mjs`. Expect `ok:`.
3. Run `tests/app.test.ts` in quiet mode. The test "embedded server is
   running" must pass.
4. Add one e2e test, `tests/server-host-restart.test.ts`:
   - read the utility PID from main,
   - send `SIGKILL` to that PID,
   - poll `embeddedServerUrl(app)` `/api/health` until 200 (10 s cap),
   - assert the dashboard window is still alive.
5. After step 4, run `ps -o pid,ppid,args -A | grep -E "whisper-server|mlx_asr_worker"`.
   Expect no process whose parent PID is 1 and that the test started.
6. Measure boot: 5 launches, median time to the first 200 on
   `/api/health`. Report it next to the 535 ms baseline.
7. Run the full e2e suite in CI on the PR.

### Done when

- [ ] `rg -n '"@openstyle/server"' apps/electron/src/main` shows only `import type` lines.
- [ ] `check-bundled-requires.mjs` prints `ok:` and covers the new entry.
- [ ] `server-host-restart.test.ts` passes in quiet mode and in CI.
- [ ] No orphan helper process after a forced kill (step 5 output in the PR).
- [ ] Boot median within 150 ms of the baseline, or the owner accepts the number.
- [ ] Settings → Data disk line still shows sizes (quiet e2e screenshot, looked at).

---

## Item 3. Native meeting capture on one clock

### Current state

- **Mic channel:** a hidden window loads `meeting-capture.html`
  (`apps/electron/src/main/index.ts:462-497`). It runs getUserMedia, an
  AudioWorklet, and sends 16 kHz PCM16 over IPC `meeting:mic-chunk`
  (`apps/electron/src/renderer/src/meeting-capture.ts:18-34`,
  `apps/electron/src/main/meeting-ipc.ts:64`).
- **System channel:** `native/macos-system-audio.swift` creates a Core
  Audio process tap and a private aggregate device that holds only the tap
  (`macos-system-audio.swift:206-223`). It writes PCM on stdout and
  `READY`, `LEVEL`, `SYNC`, `OVERRUN`, `ERR_*` on stderr (`:9-15`).
- **Two clocks.** `meeting-recorder.ts` stamps each channel's `T0` with
  `Date.now()` when its first chunk arrives (`meeting-recorder.ts:377-382,
  399-404`). It journals `SYNC` markers and resume epochs to `sync.json`
  (`:63-83, 315-318, 360-370`). `merge.ts` uses them for drift correction
  (`apps/server/src/lib/meetings/merge.ts:65-83, 215-217`).
- **Mic device id** is a Chromium `MediaDeviceInfo.deviceId`
  (`apps/electron/src/renderer/src/pages/settings.tsx:496,552`), stored in
  `mic_device_id` (`packages/validations/src/settings-keys.ts:64`). Core
  Audio does not know this id.
- **Silent-mic gate (2.14.2, commit `ba1ceb7`).** The segmenter skips mic
  chunks with too little speech evidence before the ASR call. The gate is
  relative to an adaptive noise floor: floor + `SILENCE_GATE_DB = 6`
  (`apps/server/src/lib/meetings/segmenter.ts:999`, floor at `:17-23,
  59-60`). It was tuned on audio from the getUserMedia path.
- Build wiring for the entry: `electron.vite.config.ts:122`, `knip.jsonc:52`,
  `renderer-urls.ts:20`, preload `meetingSendMicChunk` and
  `meetingCaptureError` (`apps/electron/src/preload/index.ts:69-73`).

### Change

1. Extend `macos-system-audio.swift` into one meeting helper
   (`macos-meeting-capture.swift`, same build target 14.2,
   `scripts/compile-native.js:111-117`):
   - Add the selected mic as a sub-device of the private aggregate device,
     next to the tap. Set the mic as the clock device and keep drift
     compensation on for the tap (`kAudioSubTapDriftCompensationKey`, `:218`).
   - One IOProc receives both inputs on the aggregate's clock. Convert each
     to 16 kHz mono PCM16.
   - Write framed stdout: 1 byte channel (`M` or `S`), 4 bytes length, PCM.
   - Keep the stderr protocol. Add `LEVEL_MIC <rms>` and `DEVICE <uid> <name>`.
2. Device choice: main passes a Core Audio device UID or "default". The
   settings page keeps the Chromium id. To map it, main asks the settings
   renderer for the device label of `mic_device_id`
   (`enumerateDevices()`), and the helper picks the input with the same
   name. No match: use the default input and log a warning. See Open questions.
3. `meeting-recorder.ts`: replace the capture window with the helper.
   Both `T0` values come from the helper's first IOProc callback, so the
   journal records the same `T0` for both channels. Keep `sync.json` in
   the same shape, so `merge.ts` does not change.
4. Delete `meeting-capture.html`, `meeting-capture.ts`, the vite input,
   the knip entry, the renderer URL, and the two preload channels plus
   their `index.d.ts` twins (`tests/preload-channels.test.ts` checks this).
5. Keep `macos-system-audio` as a fallback for one release: if the new
   helper fails to start, run today's path. Remove it in a later change.

**Decision: aggregate device, not AVAudioEngine.** The brief named
AVAudioEngine. An AVAudioEngine input node runs on the mic device's own
clock, and the tap runs on the aggregate's clock, so the result is still
two clocks. One aggregate device with both inputs is the Core Audio way to
get one clock. If the aggregate approach fails in the spike (step 1 of
Proof), fall back to AVAudioEngine for the mic and keep `SYNC` markers for
both channels.

### Scope decision: dictation capture stays in the renderer

Recommendation: do not move dictation capture (`lib/recorder.ts`,
`lib/streamer.ts`) on this branch. Reasons from the code:

- Dictation has one channel, so the two-clock problem does not exist.
- The pill waveform reads the live `MediaStream` through an `AnalyserNode`
  (`pages/app.tsx:1055`). A native path needs a new level channel into
  the pill, a visible behavior risk.
- The streamer sends PCM from the renderer straight to the server WS
  (`lib/streamer.ts:140-148, 343`) and keeps the WAV for the REST fallback.
  A native path adds a hop through main on the most latency-critical path.
- `.lore.md:255` warns that the recorder and streamer generation counters
  and cleanup order in `app.tsx` are fragile.

### Risks

- **TCC.** Unverified: whether macOS attributes mic access in a child
  helper to the app (as it does for the system-audio tap). The spike must
  check this on an ad-hoc build, because that is what users run.
- **Gain change.** Native capture can have a different level and noise
  floor than getUserMedia with processing off (`lib/mic-stream.ts:1-5`).
  The silent-mic gate is relative to the floor, but it was tuned on the
  old path. A shift can drop quiet replies or let "Okay." rows back in.
- **Device mapping by name** fails for two devices with the same name.
- **Bluetooth mics** at 16 or 24 kHz in an aggregate device: drift
  compensation must hold for a 2-hour meeting (Unverified).
- **Device loss mid-meeting:** today Chromium ends the track. The helper
  must report it on stderr and the recorder must keep the system channel.

### Proof

The proof needs the owner for one step. Synthetic audio must be silent
(`say -o` only, never playback, live-testing skill "Synthetic audio is silent").

1. **Spike, helper alone** (`/tmp/uth-capture/`): run the helper for 10
   minutes with no playback. Expect `READY`, both channels present, and
   `mic_samples == system_samples` within one IOProc buffer at the end.
   This proves one clock. Silence is enough for this check.
2. **TCC check on an ad-hoc build:** build `--dir`, run the helper from the
   packaged app. The owner confirms that no new TCC dialog appears beyond
   the expected microphone one. (Owner step, not quiet: it shows a dialog.)
3. **Unit tests:** recorder tests for the framed protocol and the journal
   (`T0` equal for both channels).
4. **Real meeting (owner):** record one 30-minute meeting with the packaged
   branch build. Check: both channels, no echo of "Me" lines in "Them",
   silent-mic gate still drops noise-floor chunks, no "Okay." rows.
5. **Meeting quality:** the `meeting-benchmarks` skill reads stored WAVs,
   so it cannot replay old recordings through the new capture. Run it on
   the step-4 recording, compare its numbers with the recorded baseline
   band, and let the `council` skill judge the compare files. Release only
   on consensus (`.claude/skills/council/SKILL.md`).

### Done when

- [ ] Spike output shows equal sample counts per channel after 10 minutes.
- [ ] `rg -n "meeting-capture" apps/electron/src apps/electron/electron.vite.config.ts knip.jsonc` returns nothing.
- [ ] `pnpm --filter @openstyle/electron test` passes, including `preload-channels`.
- [ ] Council consensus on the benchmark compare files.
- [ ] Owner confirms the real-meeting check (step 4).

---

## Item 4. Key listener: filter in Swift, supervise in main

### Current state

- The hotkey reaches the helper only as a CLI argument at spawn
  (`apps/electron/src/main/key-listener.ts:168-183`). A change kills the
  process and starts a new one (`index.ts:3417-3421`, `hotkey-record:stop`
  at `index.ts:1856-1863`).
- Main spawns one helper per hotkey: dictation (`index.ts:3442`), Remix
  (`index.ts:3189`), and one per language hotkey (`index.ts:3577`). The
  hotkey recorder spawns one more, with no hotkey argument on macOS
  (`hotkey-recorder.ts:83-88`).
- The Swift helper parses the hotkey but uses it only to swallow compound
  keys (`native/macos-key-listener.swift:115-117, 431-438`).
- Each keystroke anywhere on the Mac makes each helper write about 5 lines:
  key down: `FLAGS` from the tap (`:419`), `FLAGS` and `KEY_DOWN` from the
  NSEvent monitor (`:386-388`); key up: `FLAGS` (`:419`) and `KEY_UP` (`:427`).
  This is the lean-audit T2-3(a) finding (`specs/lean-audit-2026-09.md:134`).
- `emit()` writes and flushes stdout in the event tap callback
  (`macos-key-listener.swift:135-138`). The tap is an active tap
  (`.defaultTap`, `:401`). Unverified: whether a full pipe can stall the tap.
- Main ignores `KEY_DOWN`/`KEY_UP` lines for any key that is not the
  hotkey key (`key-listener.ts:409-416`). Modifier-only and Fn hotkeys use
  only `FLAGS`, `FN_*`, `RIGHT_MOD_*`, `MODIFIER_UP` (`key-listener.ts:263-345`).
- Restart: up to 5 attempts, delay 2 s × attempt, on a non-zero exit
  (`key-listener.ts:131-133, 226-228, 484-501`). The counter resets on
  `READY` (`:248-250`). After 5 failures main falls back to a
  `globalShortcut` toggle and notifies the user (`index.ts:3453-3474`).
  This fixes part of stability-audit finding 2
  (`specs/app-stability/app-stability-audit.md:56`). Gap that remains:
  after the fallback, nothing tries the native listener again, so
  hold-to-talk stays lost until the app restarts.

### Change

1. **Swift filter** (only when a hotkey argument is present; with no
   hotkey the helper keeps today's output, for the recorder):
   - Emit `FLAGS:` only when the flag set differs from the last one sent.
   - Emit `KEY_DOWN:`/`KEY_UP:` only for the hotkey's target key, and for
     the suppressed mouse buttons.
   - Keep `FN_*`, `RIGHT_MOD_*`, `MODIFIER_UP` as they are (they fire only
     on modifier changes).
   - Main's parser does not change, so `tests/key-listener.test.ts` stays valid.
2. **Supervisor in main** (`hotkeys/` module from item 5): after a
   permanent failure, keep the toggle fallback and retry the native
   listener every 60 s. On `READY`, restore hold mode, remove the
   `globalShortcut`, and log one line. Apply the same rule to the Remix and
   language listeners.
3. No heartbeat line. A heartbeat adds output and a new failure mode; the
   exit-based restart covers a dead helper.

### Risks

- A filter bug drops the hotkey. This is the core input path
  (`specs/lean-audit-2026-09.md:285-287`: "needs manual QA on hardware").
- Solo Fn uses a 50 ms chord grace window that reads modifier state
  (`key-listener.ts:34, 380-406`). Deduplicated `FLAGS` must still arrive
  when a modifier joins the chord.
- Retrying a helper that dies at once must not loop fast: 60 s minimum.

### Proof

1. `pnpm --filter @openstyle/electron test:e2e tests/key-listener.test.ts tests/language-hotkeys.test.ts`
   in quiet mode.
2. Line count, helper alone, no app: run
   `resources/bin/darwin-arm64/macos-key-listener Fn > /tmp/uth-keys/out.txt`
   while you type 100 characters in another app. Before: about 500 lines.
   After: only lines from modifier changes. Put both counts in the PR.
3. Supervisor: in quiet e2e, start the app, `kill -9` the dictation helper
   PID 6 times, check the toggle-fallback log line, wait 60 s, check that
   hold mode is back (`hotkey:down` and `hotkey:up` through
   `e2e:trigger-hotkey-down`/`-up`, `index.ts:1820-1821`, plus the log line).
4. Manual keystroke pass by the owner on the packaged build: Fn hold,
   Right Option, Option+Space, a language hotkey, the Remix hotkey, the
   hotkey recorder in Settings.

### Done when

- [ ] Typing 100 characters gives fewer than 10 helper lines with an Fn hotkey.
- [ ] `key-listener.test.ts` and `language-hotkeys.test.ts` pass, unchanged.
- [ ] Supervisor test restores hold mode after a permanent failure.
- [ ] Owner's manual keystroke pass is done.

---

## Item 5. Split the god modules

### Current state

- `apps/electron/src/main/index.ts`: 3,733 lines (`wc -l`), 49
  `ipcMain` handlers in this file and 84 in `src/main` in total (command in
  Proof). `.lore.md:255-279` says 4,543 lines and about 84 handlers; the
  line count there is stale.
- `apps/electron/src/renderer/src/pages/app.tsx`: 3,248 lines. Some parts
  are already split: `pill-motion.ts`, `pill-styles.ts`, `pill-waveform.ts`.
- Pattern that already works here: `register*Ipc(deps)` modules with
  injected dependencies (`index.ts:1678-1717, 1797-1817`;
  `meeting-ipc.ts`, `app-settings-ipc.ts`, `permissions-ipc.ts`).

### Proposed boundaries, `main/index.ts`

| New module | Lines now | Content |
|---|---|---|
| keep in `index.ts` | 1-40, 42-183, 185-271 | env bootstrap, imports, userData override, quiet E2E, logging, crash handlers, `whenReady` wiring |
| `main-state.ts` | 361-416 | shared mutable state (windows, listeners, hotkey flags) behind getters and setters |
| `windows/pill-window.ts` | 273-360, 498-826, 928-1069 | pill expansion, hot rect, positioning, `createAppWindow`, `showPill`/`hidePill` |
| `windows/settings-window.ts` | 827-927, 1210-1225 | settings window create/reveal/show |
| `windows/meeting-capture-window.ts` | 462-497 | removed by item 3 |
| `app-protocol.ts` | 437-461 | `app://` protocol |
| `resets.ts` | 1092-1209 | onboarding reset, tone reset, factory reset |
| `permission-dialogs.ts` | 1226-1359 | permission checks, dialogs, read-only location |
| `menus.ts` | 1360-1614 | update menu item, tray, `rebuildMenus` |
| `ipc/core-ipc.ts` | 1658-1864, 2199-2255 | paste, audio, pill, settings-change, hotkey-record, system, pill-position IPC (22 handlers) |
| `server-host.ts` | 1865-1950 | server boot (item 2 changes this module) |
| `updater.ts` | 1999-2198 | update checks, self-update download, 3 updater IPC handlers |
| `remix/ipc.ts` | 2298-2645 | 21 `remix:*` handlers |
| `remix/helpers.ts` | 2646-2757 | anchor focus, key whitelist, image fetch |
| `remix/bar-window.ts` | 2758-2970 | Remix bar window |
| `remix/hotkey.ts` | 3035-3222 | Remix hotkey, stuck watchdog, route keys |
| `hotkeys/dictation.ts` | 2256-2297, 2971-3034, 3223-3311, 3369-3644 | dictation and language hotkeys, `globalShortcut` fallback, 3 hotkey IPC handlers (item 4 changes this module) |
| `notifications.ts` | 3312-3367 | `notify`, import and paste-failed notices |
| `quit.ts` | 3645-3733 | window-all-closed, activate, cleanup, before-quit |

### Proposed boundaries, `pages/app.tsx`

| New module | Lines now | Content |
|---|---|---|
| `pill/constants.ts` | 77-314 | constants, types, `deferred()` |
| `pill/use-transcription-queue.ts` | 497-721, 1083-1115 | queue drain, enqueue, REST fallback, retry |
| `pill/use-streamer.ts` | 722-809 | streamer singleton |
| `pill/use-waveform.ts` | 810-1156 | bar loop, listening, handover, stop |
| `pill/use-dictation-session.ts` | 1157-1664 | hide/dismiss, start, re-record, commit, cancel |
| `pill/use-remix-session.ts` | 1665-2105, 2290-2368 | Remix session and Remix hotkey effects |
| keep in `app.tsx` | 316-496, 2106-2289, 2369-2846 | refs, prefs, hotkey effects, unmount, derived render state |
| `pill/pill-view.tsx` | 2847-3248 | JSX only, props in, no logic |

### Change

1. Move code only. No renames of IPC channels, no logic edits, no reorder
   of statements inside a function.
2. Use `register*(deps)` for each IPC group, as the existing modules do.
3. Keep the order of `ipcMain` registration inside `whenReady`.
4. For `app.tsx`, move the constants and the JSX first (lowest risk).
   Extract hooks one per commit. Keep the hook call order in `AppPage`,
   because the refs are shared and `.lore.md:255` warns about the
   recorder/streamer generation counters and cleanup order.
5. Each new file must be imported, or `knip` fails (AGENTS.md:85).

### Risks

- Module-level state moves out of one closure. A missed setter gives a
  stale value (for example `hotkeyPressed`, `remixPressed`).
- Circular imports between window and hotkey modules. Use injected
  dependencies, not cross-imports.

### Proof

1. IPC inventory must not change. Before and after:
   `rg -U -o --no-filename 'ipcMain\.(?:handle|on)\(\s*"([^"]+)"' -r '$1' apps/electron/src/main | sort > /tmp/uth/ipc-<before|after>.txt`.
   Expect 84 lines and an empty `diff`.
2. Gates: `pnpm biome check .`, `pnpm run knip`, CI-matching typecheck
   (AGENTS.md:72), `pnpm --filter @openstyle/electron test`.
3. Quiet e2e, full suite (live-testing skill §4), then CI.
4. Quiet e2e dictation path with `e2e:trigger-hotkey-down`/`-up`: the pill
   shows and hides (screenshot, looked at).

### Done when

- [ ] `wc -l apps/electron/src/main/index.ts` is below 800.
- [ ] `wc -l apps/electron/src/renderer/src/pages/app.tsx` is below 1,200.
- [ ] IPC inventory diff is empty (84 channels).
- [ ] All gates in Proof step 2 pass. Full e2e passes in CI.

---

## Item 6. Delta updates

### Current state

- The self-updater downloads the whole arm64 zip, checks sha512, unzips
  with `ditto`, swaps the bundle (`self-updater-core.ts:142-204, 233-312`,
  `self-updater.ts:55-81`). It skips `.blockmap` entries on purpose
  (`self-updater-core.ts:110-129`).
- The release already publishes the zip blockmap. `gh release view` for
  2.14.2 lists `Openstyle-2.14.2-arm64.zip` (139,315,357 bytes) and
  `Openstyle-2.14.2-arm64.zip.blockmap` (146,790 bytes). CI uploads it
  (`.github/workflows/build.yml:331`).
- Each download is kept in `<userData>/updates/<version>/`
  (`self-updater.ts:71-72`) and nothing deletes it. On the owner's Mac,
  `du -sh ~/Library/Application\ Support/Openstyle/updates` prints `5,1G`,
  with folders from 2.0.0 to 2.14.2 (read-only `ls`).
- GitHub release assets accept one byte range per request (HTTP 206) and
  reject a multi-range request (HTTP 501). Command: `curl -L -r 0-99` and
  `curl -L -r 0-9,1000-1009` on the 2.14.2 zip.
- Measured delta size with the published blockmaps (chunk checksums of
  the new zip that do not exist in the old zip):

  | From → to | Zip size | To download | Range requests |
  |---|---|---|---|
  | 2.14.1 → 2.14.2 | 132.9 MiB | 14.0 MiB (11 %) | 81 |
  | 2.14.0 → 2.14.1 | 132.9 MiB | 13.6 MiB (10 %) | not counted |
  | 2.13.0 → 2.14.2 | 132.9 MiB | 13.5 MiB (10 %) | not counted |

  Command: a 10-line Python script over the gzip JSON blockmaps
  (`/tmp/uth/bm.py`, `/tmp/uth/runs.py`, deleted after this spec).

### Change

Use the blockmap of the old zip and the new zip. Rebuild the new zip
byte for byte. The existing sha512 check then proves the result.

1. In `self-updater-core.ts` (pure Node, testable):
   - `loadBlockmap(urlOrPath)`: gunzip, parse, return chunk list with offsets.
   - `planDelta(oldMap, newMap)`: for each new chunk, the source range in
     the old zip or a range to fetch. Merge adjacent fetch ranges.
   - `assembleZip(oldZip, plan, fetchRange, dest)`: write chunks in order,
     stream the sha512 as `downloadAndVerify` does.
2. In `self-updater.ts` `downloadUpdate()`:
   - Base zip: `<userData>/updates/<app.getVersion()>/<zip>`, if it exists.
   - Old blockmap: `releases/download/<app.getVersion()>/<zip>.blockmap`.
     New blockmap: `<new zip url>.blockmap`.
   - Any error, or more than 70 % to fetch: use today's full download.
   - Report progress over the bytes to fetch, so the banner keeps working.
3. Disk hygiene: after a successful start on a new version, delete every
   `updates/<v>` folder except the current version (the next delta base).
   Run it next to `sweepSelfUpdaterBackups()`.

### Limits (honest)

- **First delta needs a base.** A user who installed from the dmg has no
  cached zip. The first update is full. The cached zip of that update is
  the base for the next one. The owner already has cached zips.
- **The first release with this code** still downloads full, because the
  old installed version runs the old updater. Deltas start one release later.
- About 10-11 % of the zip changes per release (table above), in about
  80 range requests. Each request is a redirect plus a range GET.
- Ad-hoc signing is not a problem: the rebuilt zip is the same bytes, so
  the sha512 and the code signature inside match.

### Risks

- A wrong offset gives a bad zip. The sha512 check catches it, then the
  fallback does a full download. Cost: time, not a broken app.
- Deleting old `updates/` folders deletes data the owner may not expect.
  It is only update zips. See Open questions.

### Proof

1. Unit tests for `planDelta` and `assembleZip` with two small fixture zips.
2. Real-data command proof (no app launch): with `tsx`, rebuild
   `Openstyle-2.14.2-arm64.zip` from the 2.14.1 zip, the two blockmaps,
   and range GETs to GitHub. Expect sha512 equal to `latest-mac.yml` of
   2.14.2 and about 14 MiB fetched.
3. Packaged swap in a scratch copy (never `/Applications`): build the
   branch with version N, copy the `.app` to `/tmp/uth-update/`, serve
   N+1 zip, blockmaps and `latest-mac.yml` from a local HTTP/1.1 server
   with range support, point the updater at it with a test-only feed
   override, run the swap. Check the new bundle version with `PlistBuddy`
   (`self-updater-core.ts:250-258`). Quiet mode for the launch.
4. Check the fallback: corrupt one fetched range. Expect sha512 mismatch,
   then a full download, then success.

### Done when

- [ ] Step 2 prints the 2.14.2 sha512 from `latest-mac.yml` and a fetched size near 14 MiB.
- [ ] Packaged swap in `/tmp` succeeds with a delta, and the fallback path succeeds.
- [ ] Only the current version folder stays in `updates/` after the swap test.

---

## Item 7. FTS5 history search

### Current state

- `SCHEMA_VERSION = 37` (`apps/server/src/lib/schema.ts:14`). Migrations
  run in one transaction when the stored version is lower (`:155-176`).
  The last migration is v37 (`:933-950`).
- Table `transcription_history` (`schema.ts:292-310`), index on
  `created_at` (`:649-663`).
- Search: `(raw_text LIKE ? OR cleaned_text LIKE ? OR voice_model LIKE ?)`
  with `%term%` (`apps/server/src/routes/history.ts:52-67`). The plan is a
  scan over the `created_at` index (EXPLAIN below).
- Measured on a read-only backup of the owner's DB
  (`sqlite3 -readonly ... ".backup /tmp/uth/copy.db"`, copy deleted): 2,318 rows,
  schema version 37, `LIKE` count query 1.9 ms, plan
  `SCAN transcription_history USING INDEX idx_transcription_history_created_at`.
  The lean audit parks FTS5 because the cost appears only at about 10 k
  rows (`specs/lean-audit-2026-09.md:146`). The owner chose it anyway.
  The value today is future scale, not speed now.
- Electron's `node:sqlite` (SQLite 3.51.2, Electron 39.8.10, Node 22.22.1)
  has FTS5 and the `trigram` tokenizer. Command:
  `ELECTRON_RUN_AS_NODE=1 <electron> /tmp/uth/fts.js` (scratch script, deleted).

### Change

1. Migration v38 (`SCHEMA_VERSION = 38`):
   - `CREATE VIRTUAL TABLE transcription_history_fts USING fts5(raw_text, cleaned_text, voice_model, content='transcription_history', content_rowid='id', tokenize='trigram')`.
   - Triggers `AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE` on
     `transcription_history`, in the external-content form (delete with
     the `'delete'` command, then insert).
   - Backfill: `INSERT INTO transcription_history_fts(transcription_history_fts) VALUES('rebuild')`.
2. Query in `routes/history.ts`:
   - Term of 3 or more characters:
     `id IN (SELECT rowid FROM transcription_history_fts WHERE transcription_history_fts MATCH ?)`,
     with the term as one FTS5 phrase (wrap in `"`, double each inner `"`).
   - Term of 1-2 characters: keep the current `LIKE` clause. A trigram
     index cannot match fewer than 3 characters (measured: `"hi"` returns
     no rows).
3. Retention sweeps and deletes need no change: the triggers keep the
   index in step.

### Behavior differences (measured)

- Trigram folds case for non-ASCII letters; `LIKE` does not. `"école"`
  matches `ÉCOLE` with FTS5. `'ÉCOLE' LIKE '%école%'` returns 0. FTS5
  returns more rows, never fewer, for 3+ characters.
- Today `%` and `_` typed in the search box act as `LIKE` wildcards. With
  FTS5 they are plain characters.
- See Open questions: the owner must accept these two differences, or the
  query must add a `LIKE` re-check to keep exact results.

### Risks

- Downgrade: an older build sees version 38 and skips migrations
  (`schema.ts:168`). Its inserts still fire the triggers, and the table
  exists, so the older build keeps working (Unverified by a test).
- Index size: trigram indexes are large (about 3× the text). At 2,318 rows
  this is small. Measure the DB size before and after on the backup copy.

### Proof

1. Server tests: new `apps/server/tests/history-search-fts.test.ts` with
   insert, update, delete, retention delete, 2-character term, term with
   `"`, non-ASCII term. Run `pnpm --filter @openstyle/server test tests/history-search-fts.test.ts`.
2. Migration on real data: run v38 against a backup copy of the owner's
   DB in `/tmp`. Compare result IDs of 20 real search terms, old query vs
   new query. Expect equal sets, except rows explained by the two
   differences above.
3. Quiet e2e: isolated server, seeded history, search in the History page,
   screenshot (looked at).

### Done when

- [ ] `pnpm --filter @openstyle/server test` passes.
- [ ] Step 2 result table is in the PR.
- [ ] `EXPLAIN QUERY PLAN` of the new search shows `VIRTUAL TABLE INDEX`.

---

## 4. Done when (whole branch, PR checklist)

- [ ] Draft PR exists for `feat/under-the-hood` (coordinator).
- [ ] Items 2-7 each meet their own "Done when" list. Item 1 stays deferred.
- [ ] `pnpm biome check .` passes.
- [ ] `pnpm run knip` passes.
- [ ] `pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron typecheck:web && pnpm --filter @openstyle/electron typecheck:tests` passes.
- [ ] `pnpm --filter @openstyle/electron typecheck` passes.
- [ ] `pnpm --filter @openstyle/server test` and `pnpm --filter @openstyle/electron test` pass.
- [ ] `node apps/electron/scripts/check-bundled-requires.mjs` prints `ok:` after the build.
- [ ] Full e2e passes in CI. Local e2e ran only in quiet mode.
- [ ] Packaged `build:mac` smoke on the owner's Mac (owner): boot, dictation, meeting record start, Import, settings.
- [ ] Owner manual passes: keystroke pass (item 4), real meeting (item 3).
- [ ] Council consensus for item 3.
- [ ] `git status --short` is clean. Scratch folders under `/tmp/uth*` are deleted.
- [ ] CHANGELOG entry says that TCC dialogs after an update still appear (item 1 deferred).

## 5. Open questions

1. **Item 7 behavior differences.** Accept that FTS5 search finds
   non-ASCII case variants and treats `%`/`_` as plain text? Or add a
   `LIKE` re-check to keep today's exact results?
2. **Item 6 disk cleanup.** Delete old `updates/<version>` folders (5.1 GB
   on the owner's Mac)? This removes files that no current code reads.
3. **Item 3 device mapping.** Map the Chromium mic id to Core Audio by
   device name, or store the Core Audio UID as a new setting? A new
   setting is a settings change.
4. **Item 3 helper approach.** The spec chooses one aggregate device (one
   clock) over the AVAudioEngine approach named in the brief. Confirm.
5. **Item 2 orphan children.** If the forced-kill test shows an orphan
   whisper.cpp server, which fix is acceptable: a PID file swept at boot,
   or a process group kill from main?
6. **Item 3 TCC attribution** for a mic opened in a child helper of an
   ad-hoc app. Only the spike on the owner's Mac can settle this.
