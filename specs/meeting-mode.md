# Meeting Mode v1 — Implementation Log

Implementation log for Meeting Mode v1, written at feature completion
(2026-08-25, all code landed on the working tree, pre-commit). Companion to the
Meeting Mode plan; this records what was built, where it lives, and what was
verified.

---

## 1. Architecture summary

Meeting Mode records a meeting as **two channels that are never mixed**:

- **Me** — the microphone, captured in a hidden renderer window
  (`meeting-capture.html` / `meeting-capture.ts`) via getUserMedia, streamed
  as PCM to the main process.
- **Them** — system audio (what the speakers/headphones play), captured by a
  standalone Swift helper (`native/macos-system-audio.swift`) using a Core
  Audio process tap, spawned and supervised by
  `src/main/system-audio-capture.ts`. Raw PCM on stdout, JSON handshake on
  stderr.

Keeping the channels separate is the diarization strategy: attribution is
physical (which device the audio came from), not model-based. The merge step
interleaves the two transcripts by timestamp into a Me/Them dialogue; no
speaker-ID model is involved.

`src/main/meeting-recorder.ts` orchestrates a recording session: starts both
captures, writes `mic.wav` + `system.wav` (plus `sync.json` with the capture
start offsets) under `userData/meetings/<id>/`, enforces the auto-stop
ceiling, and marks the meeting `interrupted` on relaunch if the app died
mid-recording (`POST /api/meetings/:id/interrupted`).

The processing pipeline lives in `apps/server/src/lib/meetings/`:

- `segmenter.ts` — silence-based segmentation of each PCM channel
  (`segmentPcm`), so transcription works in bounded chunks and a single bad
  chunk can fail without losing the meeting.
- `transcriber.ts` — runs the existing local ASR over each segment, persists
  per-segment rows (`meeting_segments`, with `status` so failed segments are
  retryable via `POST /:id/retry-failed`).
- `merge.ts` — rebuilds the merged Me/Them transcript from persisted segments
  plus `sync.json` timestamp alignment.
- `summarize.ts` + `summary-prompt.ts` — summary via the configured LLM
  (local-llm URL supported), with `meeting_summary_context_budget` guarding
  the context size.
- `retention.ts` — sweep that deletes recorded audio older than
  `meeting_retention_days` (transcripts stay; only audio is swept).

**Persistence — migration 29** (`apps/server/src/lib/schema.ts`,
`SCHEMA_VERSION = 29`): tables `meetings`, `meeting_segments` (FK cascade,
indexed by `meeting_id`), `meeting_summaries` (one per meeting), plus the
`created_at` index for the list view. Audio lives on disk under `audio_dir`;
the DB holds only metadata and text.

**Routes** (`apps/server/src/routes/meetings.ts`, mounted at `/api/meetings`
behind the server-owned `meetings` config flag): list, `GET /orphans`,
`POST /start`, `POST /:id/stop`, `POST /:id/interrupted`,
`POST /:id/transcribe` (202 + async job, poll `GET /:id`),
`POST /:id/retry-failed`, `POST /:id/summarize`, `GET /:id/transcript`,
`GET /:id`, `DELETE /:id`.

**UI** — `src/renderer/src/pages/meetings.tsx` (list, detail, Me/Them
transcript, summary, record controls); nav entry in `shell.tsx` shown only
when `config.flags.meetings === true`; all locales updated.

**TCC** — `src/main/system-audio-probe.ts` probes System Audio Recording
permission by briefly running the helper, so the UI can show a real
grant/denied state instead of failing at record time.
`NSAudioCaptureUsageDescription` is added via `extendInfo` in
`electron-builder.yml`; the helper ships in app resources
(`resources/bin/darwin-arm64/macos-system-audio`, built by
`scripts/compile-native.js`).

## 2. File inventory

New files:

- `apps/electron/native/macos-system-audio.swift` (427 loc)
- `apps/electron/src/main/meeting-recorder.ts` (601)
- `apps/electron/src/main/system-audio-capture.ts`
- `apps/electron/src/main/system-audio-probe.ts`
- `apps/electron/src/renderer/meeting-capture.html`
- `apps/electron/src/renderer/src/meeting-capture.ts`
- `apps/electron/src/renderer/src/pages/meetings.tsx` (870)
- `apps/server/src/lib/dictation-activity.ts`
- `apps/server/src/lib/meetings/` — `segmenter.ts`, `transcriber.ts`,
  `merge.ts`, `summarize.ts`, `summary-prompt.ts`, `retention.ts`
- `apps/server/src/routes/meetings.ts` (575)
- `apps/server/tests/` — `meeting-merge.test.ts`, `meeting-summarize.test.ts`,
  `meeting-transcriber.test.ts`, `meetings-routes.test.ts`,
  `schema-meetings.test.ts`, `segmenter.test.ts`

Modified files:

- `apps/electron/electron-builder.yml` (NSAudioCaptureUsageDescription,
  helper packaging)
- `apps/electron/electron.vite.config.ts` (meeting-capture entry)
- `apps/electron/scripts/compile-native.js` (build the Swift helper)
- `apps/electron/src/main/index.ts`, `src/preload/index.ts` + `.d.ts`
  (IPC surface)
- `apps/electron/src/renderer/src/dashboard.tsx`, `shell.tsx`,
  `lib/query.ts` (routing, flag gate, queries)
- `apps/electron/src/renderer/src/locales/*.json` (7 locales + template)
- `apps/electron/src/shared/settings-keys.ts`
- `apps/server/src/index.ts`, `src/routes/index.ts` (mount),
  `src/routes/transcribe.ts`, `src/lib/schema.ts` (migration 29)
- `packages/validations/src/settings.ts` (`meeting_retention_days`,
  `meeting_max_duration_hours`, `meeting_summary_context_budget`)

## 3. Verification evidence (2026-08-25)

**Server suite** — `pnpm --filter @openstyle/server test`:

```
Test Files  60 passed (60)
     Tests  520 passed (520)
  Duration  1.32s
```

**Electron typecheck + build** — `pnpm --filter @openstyle/electron build`
(runs `typecheck:node` + `typecheck:web` first): passed, `✓ built in 2.05s`.

**Electron e2e (dictation regression gate)** —
`pnpm --filter @openstyle/electron test:e2e`:

```
1 skipped
62 passed (28.0s)
```

(First run failed with `spawn .../Electron ENOENT` in every launch-based
test — a local environment issue: the pnpm `electron` package's binary was
never downloaded on this machine. Restoring `dist/` from the electron zip
cache and writing `path.txt` fixed it; no product code changed.)

**Packaged build** — `pnpm --filter @openstyle/electron build:mac`:
succeeded with ad-hoc signature; notarization auto-skipped (no credentials in
env: "skipped macOS notarization — `notarize` options were unable to be
generated"). Produced `dist/Openstyle-1.0.1.dmg` and
`dist/Openstyle-1.0.1-arm64.zip`.

```
$ plutil -p Openstyle.app/Contents/Info.plist | grep -i NSAudioCapture
"NSAudioCaptureUsageDescription" => "Openstyle records system audio during meetings you choose to record."

$ find Openstyle.app -name macos-system-audio
.../Openstyle.app/Contents/Resources/bin/macos-system-audio
```

`apps/electron/resources/bin/darwin-arm64/macos-system-audio` also present
(94,688 bytes, built by `compile-native.js`).

## 3a. Pause and resume of a recording

Added with PR "feat(meetings): pause and resume a recording". A user can pause
a running recording and resume it. This section states how it works.

### Rules

- A pause is a flag in the recorder, not a status. The status stays
  `recording`. The `meetings` row stays `recording` and its CHECK constraint
  does not change. Every guard that reads `recording` (pill, update menu,
  quit, orphan sweep) works as before.
- A pause closes the capture. The recorder stops the native helper and waits
  for its process to exit. The macOS mic indicator goes off. The fallback path
  (hidden mic window and `macos-system-audio`) closes too. The E2E fake capture
  stops its timer.
- A resume starts the capture again, in the same order as at the start: the
  native helper with the same mic request first, then the fallback path.
- The tracks hold recorded time only. The paused time is not in `mic.wav` or
  `system.wav`. So the transcript times stay correct for the audio file, and
  `merge.ts` needs no change.
- The meeting length is the recorded time. `duration_ms` is
  `endedAt - startedAt - pausedTotalMs`.
- The clock counts recorded time. The recorder sends `startedAt + pausedTotalMs`
  and `pausedAt` (null while running). Every window shows
  `(pausedAt ?? now) - startedAt`. The hook `useElapsedClock(startedAt, pausedAt)`
  does this.
- The maximum recording length counts recorded time. A pause clears the timer.
  A resume sets it again with the time that is left.
- The live loop reads no audio while paused. The recorder sends
  `PUT /api/meetings/:id/paused` (`{ paused: boolean }`). The server keeps the
  flag in memory (`lib/meetings/live/pause.ts`). `stopLive` clears it. The final
  tick at stop still runs.
- A stop during a pause ends the pause and saves the meeting the normal way.

### How the tracks stay aligned

`sync.json` has a new epoch reason `pause`. The epochs of a paused recording
are `start`, `pause`, `resume` (a sleep adds `resume` too). The native helper
records both channels on one clock (`sharedClock`). So the merge uses no drift
markers and reads only `micT0` and `systemT0`. These do not change.

At a pause, the two captures stop at slightly different samples. The recorder
adds silence to the shorter track, so both tracks hold the same number of
samples (`equalizeTracks`). The `pause` epoch records these equal counts. The
resume adds no silence for the gap. So at every moment of the audio, the
mic sample and the system sample have the same index, and the
`systemSamples / micSamples` check of `packages/validations/src/meeting-files.ts`
(`trackRatioWarning`) stays at 1.

The fallback path has its own T0 for each channel, so its track lengths differ
by design. The recorder does not equalize them. A resume in the fallback path
adds no silence. The error is the difference of the two start delays of the
resumed channels (not measured; usually under one second).

`planTrackRepair` (issue #170) plans no repair when a `pause` epoch exists. A
new helper counts its SYNC markers from zero, so the markers of one recording
no longer form one line.

A late failure of the native helper after a pause uses `failOverToFallback`.
Its padding subtracts `pausedTotalMs`, so it never fills the paused time.

### Resume errors

`resume()` starts the native helper. When it fails, the fallback path starts.
When no capture starts, `resume()` throws a clear message, and the recording
stays paused. The user can select Resume again or stop the recording. The
audio from before the pause is on disk and is saved at the stop. The pill, the
tray popover and the Meetings page show the message (`meetings.resumeFailed`).

### User interface

| Surface | Pause | Paused state |
|:---|:---|:---|
| Pill | Pause button next to Stop | Amber "Paused" word, dimmed frozen clock, Resume button |
| Tray popover | Pause button next to Stop | "Paused" under the clock, gray card, "Paused" chip, Resume button |
| Meetings page | Pause button next to Stop | "Paused" title, gray dot, text "The microphone is off", "Paused" badge in the list and the header |
| Tray menu | "Pause meeting recording" | "Resume meeting recording" |
| Tray icon | | The normal logo (not the red icon), tooltip "meeting paused" |

IPC: `meeting:pause`, `meeting:resume` (both return `{ ok, error? }`). The
`meeting:status` reply and the `meeting:status-changed` event carry `pausedAt`.

### Tests

- `apps/electron/src/main/meeting-recorder.test.ts`: epochs, alignment, equal
  track sizes, duration, max duration, sleep during a pause, fallback, failed
  resume, stop while paused, fake capture.
- `apps/server/tests/live-routes.test.ts`: the paused flag and the live loop.
- `apps/server/tests/meeting-track-repair.test.ts`: no repair after a pause.
- `apps/electron/tests/meeting-pause.test.ts`: E2E with the fake capture. It
  pauses in the pill, checks the Paused state in the pill, the Meetings page
  and the tray popover, resumes, stops, and checks the saved duration, the
  WAV lengths, `sync.json` and the queued full pass.
- Not covered by automatic tests: a real mic and system capture across a pause
  (CI only, by the quiet-test rule).

## 4. Remaining human-run acceptance checklist

Cannot be automated; run before shipping:

- [ ] Enable the `meetings` flag in `config.freestyle.json`
      (`"flags": { "meetings": true }`).
- [ ] `pnpm dev` → record a ≥30 min real meeting, once on speakers and once
      on headphones while dictating (dictation and meeting capture must
      coexist).
- [ ] Spot-check the merged transcript: Me/Them attribution matches who
      actually spoke.
- [ ] Summarize via the configured local-llm URL; summary renders on the
      meeting page.
- [ ] `kill -9` the app mid-meeting → relaunch shows the meeting as
      `interrupted` and it transcribes from the audio written so far.
- [ ] First-run TCC prompt from the **packaged** app: System Audio Recording
      permission dialog appears, grant persists, probe reports granted.
- [ ] Pause and resume on a real Mac: record, pause (the macOS mic
      indicator must go off), wait, resume, stop. Check that `mic.wav` and
      `system.wav` have the same length and that the saved length excludes
      the pause.
- [ ] Retention sweep: set `meeting_retention_days` low, confirm audio dirs
      are deleted while transcripts remain.
