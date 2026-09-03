# Meeting Import — Implementation Spec

PROPOSED 2026-09-03. Spec for importing an existing audio recording as a full
meeting record (row + audio on disk + the standard transcribe/diarize/
summarize pipeline), extending the door the dictation-side Import screen
opened in PR #9. Grounded in `main` @ `9697fdc` (2026-09-03),
`SCHEMA_VERSION = 34`. Companion reading: [`meeting-mode.md`](meeting-mode.md),
[`meeting-diarization.md`](meeting-diarization.md), [`meeting-speaker-naming.md`](meeting-speaker-naming.md)
§3/§6, [`design-system.md`](design-system.md). Citations as read on 2026-09-03
— re-verify before implementing. This document only specifies; no code was
changed to produce it.

---

## 1. Context

Meeting Mode records two never-mixed channels — *Me* (mic), *Them* (system
audio) — into `<userData>/meetings/<id>/{mic.wav, system.wav, sync.json}`
(`main/meeting-recorder.ts:247,266,282-283`). Users have back-catalogs of old
mixed recordings (exported calls, voice memos, other apps). Today those can
only go through the dictation Import screen (`pages/import.tsx` →
`POST /api/transcribe/file`), producing a flat `transcription_history` row: no
speaker labels, summary, transcript.md export, or meeting UI.

Importing as a **meeting** gives the file the whole downstream pipeline
(segment → transcribe → merge → diarize → name → summarize/enhance) plus
retention, delete and export. The imported file is a mixed single-channel
recording, so the two-channel model degenerates — and the pipeline already
tolerates exactly that shape (§2): thin feature, no pipeline change.

## 2. What exists today (research)

- **Pipeline tolerates a missing channel.** `readWavChannel` returns null on
  any open/parse failure (`routes/meetings.ts:117-145`); `runTranscribeJob`
  throws only when *both* `mic.wav` and `system.wav` are missing
  (`routes/meetings.ts:353-358`).
- **Merge tolerates missing sync.** `loadSyncData` returns undefined when
  `sync.json` is absent (`routes/meetings.ts:155-197`); merge then runs with
  no clock-drift correction — harmless with one empty channel.
- **Diarization is system-channel-only.** `runDiarizationPass` hardcodes
  `join(audioDir, "system.wav")`, skipping (warns) when absent
  (`lib/meetings/diarize.ts:354-365`). System rows get numeral
  `speaker_label`s rendering as `Them N` until renamed.
- **`POST /api/meetings/start` does not constrain paths.** `startSchema`:
  `audio_dir: z.string().max(4096)` — length only, no absolute-path or
  basename check (`routes/meetings.ts:514-520`). The server trusts the
  Electron main process as its only client.
- **DELETE derives the meetings root from the DB path.** `meetingsRootDir()`
  = `dirname(OPENSTYLE_DB_PATH ?? FREESTYLE_DB_PATH)/meetings`
  (`routes/meetings.ts:64-70`); `DELETE /:id` only removes an `audio_dir`
  strictly under that root (`routes/meetings.ts:1244+`).
- **`GET /:id` shape** (`routes/meetings.ts:1208-1242`): full `meetings` row
  plus `job: {done,total,failed} | null`, `segment_counts: {total, failed}`,
  `summary: {markdown, llm_provider, llm_model, input_tokens, output_tokens,
  cost_usd, created_at} | null`.
- **Dictation-import precedent.** `routes/transcribe-file.ts` — mounted
  `.route("/transcribe", transcribeFile)` after its siblings
  (`routes/index.ts:40-44`); inline `bodyLimit` (1 GiB → 413, `:89-107`);
  multipart `audio` must be a `File` → 400 (`:113-118`); extension allowlist
  from the filename → **415** (`:120-133`); `needsDecode()`/
  `decodeToWav16kMono()` (`lib/audio/decode.ts`), decode failure → 422;
  duration via `wavDurationMs(parseWavHeader(wav))`; constants at `:40-49`,
  helpers at `:55,63`; a dictation-activity lease (`:76-86`) because it runs
  STT.
- **Electron import plumbing.** `main/import-audio.ts`: `openAsBlob` +
  `FormData` + `fetch` with auth headers, 1 GiB client-side check, e2e seams
  — `isE2E()` on `OPENSTYLE_E2E`/`FREESTYLE_E2E === "1"` (`:20-22`), picker
  returns `OPENSTYLE_E2E_IMPORT_FILE` when set (`:58-60`), upload bumps
  `globalThis.__openstyleE2E.importCalls` (`:79-83`). Registered at
  `main/index.ts:2386-2391`; preload at `preload/index.ts:142-146`.
- **Meetings page layouts.** Empty state = single-pane flow with a dashed
  `MeetingsEmptyState` card (`meetings.tsx:1922-1941`); non-empty =
  master-detail rail with a compact `RecordingCard` (`meetings.tsx:2070`)
  and rows whose title falls back `m.title || t("meetings.untitled")`
  (`meetings.tsx:2094`, `template.json:784`). Transcribe is
  `getClient().api.meetings[":id"].transcribe.$post` inside `runAction`
  (`meetings.tsx:1410-1421`); invalidation via `queryKeys.meetings.all`
  (`meetings.tsx:352`; `lib/query.ts:20`).
- **Retention.** The sweep deletes only `mic.wav`/`system.wav` of meetings
  older than `meeting_retention_days` and nulls `audio_dir`
  (`lib/meetings/retention.ts:39-64`) — cutoff on **`created_at`**, not
  `started_at`.

## 3. Goals / Non-goals

**Goals**: (1) import wav/mp3/m4a/aac/ogg/mp4 as a `meetings` row in
`recorded` status, audio normalized to 16 kHz mono PCM16 at
`<audio_dir>/system.wav`, immediately eligible for the existing machinery;
(2) same UX as dictation Import — picker *and* drag-drop, both layouts,
synchronous import, auto-transcribe on success; (3) speaker attribution via
the existing system-channel diarizer + naming UI (rename "Them n" → any real
name, including the user's own).

**Non-goals**: no channel splitting or automatic Me/Them separation of a
mixed recording; no background/queued import job (§4.3); no mic-channel
import (`mic.wav`/`sync.json` never written); no in-place import — bytes are
copied into the meetings tree; no new pipeline stages, migrations, settings.

## 4. Design

### 4.1 Shared limits — `apps/server/src/lib/audio/import-limits.ts`

Move `MAX_IMPORT_BYTES`, `ACCEPTED_IMPORT_EXTENSIONS`, `importFileExtension`,
`formatLimit` out of `transcribe-file.ts:40-70` into a dependency-free module
(same layer as `lib/audio/wav.ts`); both routes import it.
`transcribe-file.ts` keeps its 413/415 payloads byte-identical, so its tests
keep passing.

### 4.2 Server route — `apps/server/src/routes/meetings-import.ts`

A sibling router like `transcribe-file.ts`, mounted in `routes/index.ts`
right after the meetings router (`.route("/meetings", meetingsImport)`,
mirroring `routes/index.ts:40-44`), exposing `POST /api/meetings/import`
(internal path `/import`, as transcribe-file's is `/file`). A separate
router means no `/:id` ordering hazard; same app-wide trust boundary.

**Request** — `multipart/form-data`:

| field | type | rules |
|---|---|---|
| `audio` | File | filename ext in `ACCEPTED_IMPORT_EXTENSIONS`; ≤ 1 GiB |
| `id` | string | must parse as a UUID (v4) |
| `audio_dir` | string | absolute path; `basename(audio_dir) === id` |
| `title` | string? | trim, ≤ 512 chars (mirrors `startSchema`) |
| `started_at` | int? | ms epoch |

Middleware mirrors `transcribe-file.ts:89-107`: inline `bodyLimit`
(`MAX_IMPORT_BYTES` → 413 `PAYLOAD_TOO_LARGE`) ahead of the handler, manual
multipart reads (no zValidator for form bodies — same precedent). One
deliberate deviation from the dictation import: **no dictation-activity
lease** — import only decodes (ffmpeg) and writes one file; it contends with
nothing the lease guards.

**Validation order** (each short-circuits; `bodyLimit` fires first in line):

1. Non-multipart / `audio` not a `File` / non-UUID `id` / `audio_dir` not
   absolute or basename ≠ id → **400** `BAD_REQUEST`.
2. Extension outside the allowlist → **415** `UNSUPPORTED_MEDIA_TYPE` with
   the accepted-extensions detail, same payload as `transcribe-file.ts:120-133`.
   *(The design contract draft said 400; the codebase precedent is 415 —
   follow the code.)*
3. A `meetings` row with that `id` exists, **or** `audio_dir` exists and is
   non-empty → **409**. The dir check is the load-bearing guard (protects a
   live recording's directory); the row check is cheap UUID-collision
   hardening.

**Flow**: bytes → `needsDecode()` ? `decodeToWav16kMono()` : raw
(`AudioDecodeError` → **422**, fixed-string payload as in
`transcribe-file.ts:135-160`; never echo ffmpeg stderr or the client
filename) → `mkdirSync(audio_dir, {recursive:true})` → write
`<audio_dir>/system.wav` → `durationMs = Math.round(wavDurationMs(
parseWavHeader(wav)))` → single INSERT:

```sql
INSERT INTO meetings (id, title, started_at, ended_at, duration_ms,
                      status, audio_dir, created_at)
VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?)
```

`title ?? stem(filename)` (stem = filename minus extension; NULL only if both
empty — the list then renders `meetings.untitled`); `started_at ??
Date.now()`; `ended_at = (started_at ?? Date.now()) + durationMs`;
`created_at = Date.now()`. `'recorded'` is already a legal status
(`lib/schema.ts` CHECK); `stt_provider`/`stt_model`/`language`/`context`/
`error` stay NULL — the state a `/start`→`/stop` recording leaves behind.

**Response 201** in the exact `GET /:id` shape (§2): the row plus `job: null`,
`segment_counts: {total: 0, failed: 0}`, `summary: null` — constructed by the
route (the DB row alone doesn't carry them) so the renderer drops it into its
`MeetingDetail` type (`meetings.tsx:103-127`) with no second fetch.

Writing **`system.wav`, not `mic.wav`**, is deliberate: the diarizer only
looks at the system channel (`diarize.ts:359`), so an imported mixed
recording gets `Them 1..N` labels the user can rename (§4.7). No `mic.wav`,
no `sync.json` — both absences already tolerated (§2).

### 4.3 Failure posture

Import is a **synchronous request** like `transcribe-file` — no background
job, no progress polling; the affordance shows a busy state. Memory posture
is the accepted ~3–4× worst case from `transcribe-file.ts`'s header note.
To never strand a half-open meeting: create the dir only after decode
succeeds, and on write/INSERT failure best-effort `rmSync(audio_dir,
{recursive:true, force:true})` so a retry isn't 409-blocked. **Transcription
after import is the existing async job** (`POST /:id/transcribe` → 202,
progress via `GET /:id`) — unchanged.

### 4.4 Electron main + preload

New `main/meeting-import.ts`, `registerMeetingImportIpc()` registered beside
`registerImportIpc` (`main/index.ts:2386-2391`):

- `meeting-import:pick-file` → native dialog, same Audio filter
  (`import-audio.ts:60-68`), returns `path | null`. E2e seam: when `isE2E()`
  and `OPENSTYLE_E2E_MEETING_IMPORT_FILE` is set, return it.
- `meeting-import:transcribe` `{path}` → `id = crypto.randomUUID()`,
  `audio_dir = join(app.getPath("userData"), "meetings", id)` — the same
  root `meeting-recorder.ts:247,266` computes, which is what makes DELETE
  containment and retention treat imports identically — 1 GiB client-side
  stat check, `openAsBlob` + `FormData` POST to `${base}/api/meetings/import`
  with auth headers. E2e seam: bump
  `globalThis.__openstyleE2E.meetingImportCalls`. Returns
  `{ok:true, meeting} | {ok:false, status?, error, detail?, code?}`,
  surfacing server JSON verbatim on non-2xx (`import-audio.ts:126-145`).

Preload additions (entry file, knip-clean): `pickMeetingAudioFile()` and
`importMeetingAudio(path)`.

### 4.5 Renderer — `pages/meetings.tsx`

Both affordances support click→picker **and** drag-drop; drops resolve the
path via `window.api.getPathForFile(file)` (`preload/index.ts:142-143`;
handler pattern `pages/import.tsx:123,144-152`). Invalid or oversized drops
show an inline error, never a dialog; one import in flight at a time.

- **Empty state**: the existing dashed `MeetingsEmptyState` card
  (`meetings.tsx:1922-1941`) becomes the drop zone, plus an "Import" button.
  Neutral accent only (`specs/design-system.md`) — never `--live`
  (recording-only).
- **Master-detail rail**: a compact Import button beside the compact
  `RecordingCard` (`meetings.tsx:2070`); the button row is the drop target.

**On success**: invalidate `queryKeys.meetings.all` (`meetings.tsx:352`),
`setSelectedId(meeting.id)` (explicit selection wins over `defaultId`), then
auto-fire the existing transcribe call (`meetings.tsx:1419-1421`), treating
**409 as a noop** — a fresh import can't hit the server's 409s
(`routes/meetings.ts:670-690`). List polling takes over (2 s while anything
is `transcribing`, `meetings.tsx:1962-1966`).

**Auto-transcribe rationale**: the only reason to import a meeting is to get
its transcript; a silent `recorded` row reads as a dead end (and looks
identical to a crashed recording). Auto-firing the async job matches the
dictation Import's "upload → done" model while keeping the expensive part
the existing cancellable, re-runnable job. Its errors surface through the
detail view's existing action-error banner, not the import affordance.

### 4.6 i18n

New `meetings.import*` keys in `template.json` + all 7 locales (de,en,es,fr,
it,ja,pt), real translations, placeholders untouched per `locales/README.md`:
`importTitle` ("Import a recording"), `importDesc` (file becomes a meeting
with speaker labels + summary), `importAction` ("Import…"), `importing`,
`importFailed`, `importUnsupported` ("{{ext}} files aren't supported").

### 4.7 Speaker attribution story

An imported recording is mono-mixed on the system channel, so every segment
initially renders "Them". With diarization on (auto-run inside
`runTranscribeJob`), system rows get numeral labels → `Them 1..N`. The
existing naming UI (`GET/PATCH /:id/speakers`) renames and merges per
meeting — **including renaming a "Them n" to the user's own name**: the
diarizer claims no Me/Them channel semantics for imports; labels are just
voices, display names are user-owned. `importDesc` says exactly that. With
diarization off or the binary unavailable, the transcript stays uniformly
"Them" — degraded, not broken, same as a one-sided recorded meeting.

### 4.8 Retention and delete parity

Imported WAVs live in the standard tree, so the retention sweep deletes them
after `meeting_retention_days` and nulls `audio_dir` exactly like recorded
ones (`retention.ts:39-64` unlinks `system.wav`; a missing `mic.wav` is a
caught no-op). Nuance: the cutoff is `created_at`, so importing a years-old
file guarantees ≥ `meeting_retention_days` of retention *from import time* —
never vanishing on import; that is the intended posture. DELETE `/:id`
removes the dir because it sits under `meetingsRootDir()` (§2) — the
`basename === id` + absolute-path request validation is what keeps that
guarantee valid for this new form-fed endpoint.

## 5. Testing plan

- **`apps/server/tests/meetings-import-route.test.ts`** (mirrors
  `meetings-routes.test.ts`'s `createApp()` + temp-DB setup): happy path
  (multipart WAV → 201; row `status='recorded'`, `system.wav` on disk,
  `duration_ms` ≈ WAV length, `ended_at - started_at === duration_ms`);
  title fallback from filename; 413 over-limit; 415 bad ext; 400 non-UUID id
  / mismatched basename; 409 pre-existing row and non-empty dir; 422
  undecodable audio (fake `DecodeDeps`); dir cleanup on INSERT failure;
  response shape equals `GET /:id`'s.
- **`apps/electron/tests/meeting-import.test.ts`** mirroring
  `import-screen.test.ts`: `_electron` launch with `OPENSTYLE_E2E: "1"`,
  `app.evaluate` sets `OPENSTYLE_E2E_MEETING_IMPORT_FILE` to a synthesized
  WAV (`import-screen.test.ts:418-419`), click Import on the empty state,
  assert the meeting appears in the rail and its detail opens with a
  Transcribe button; cleanup deletes the env var (`:488`).
- Knip: no `knip.jsonc` changes — every new file is reached (`routes/index.ts`,
  `main/index.ts`, preload entry, renderer page; tests via the `tests/**`
  entries, `knip.jsonc:37-47,72-76`). `transcribe-file` tests re-run against
  the extracted limits module.

## 6. Rollout / compatibility

No DB migration (`SCHEMA_VERSION` unchanged — existing columns only).
Feature-flagged with the meetings page itself (`config.flags.meetings`,
`meetings.tsx:1949-1951`), no separate flag. Server-first deploy ordering is
safe: the route is additive; a new client against an old server gets a 404
surfaced as a generic import error. Standalone server users (Docker,
`startup.ts`) get the route with no UI — callable over HTTP with a bearer
token, same contract.

## 7. Open questions

1. **`started_at` default**: `Date.now()` (spec'd) vs the file's mtime, which
   would place old recordings at their recorded date in the timeline. Cheap
   main-side (`stat.mtimeMs` → form field); deferred.
2. **Multi-file import**: drag N files → N meetings? One-at-a-time for v1;
   the per-file IPC seam makes batch a pure renderer loop later.
3. **Containers beyond the shared allowlist** (mkv, mov): deliberately
   matches the dictation Import screen; one-line change in `import-limits.ts`.
4. **Background import queue** for very long files: rejected for v1; revisit
   only if real users hit the 1 GiB ceiling.
