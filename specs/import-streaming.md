# Import Streaming — Implementation Spec

**Status: Accepted — 2026-09-04.** Implements D6 / T2-1 from
[`lean-audit-2026-09.md`](lean-audit-2026-09.md) §3: stream file-import
uploads to disk instead of buffering them in RSS. Grounded in
`feat/lean-wins` @ `bcd7fdd` (15 commits ahead of `main`, 2026-09-04),
which already carries the Tier-1 abort seam this work was sequenced after
(T1-2/UX-04: `main/abortable-jobs.ts`, import cancel card, `b6f3a06`).
Citations as read on that revision — re-verify before implementing.
Companion reading: [`meeting-import.md`](meeting-import.md) (route contracts
this spec must not change),
[`lean-audit-2026-09.md`](lean-audit-2026-09.md) §3 T2-1.
Follow-up card: `19fcec19`.

---

## 1. Context

Both file-import routes hold the *entire* upload in memory — in the
**Electron main process**, because `startServer()` embeds the Hono app
in-process (`apps/electron/src/main/index.ts`). An OOM does not kill a
request; it kills the whole app.

Current shape (all citations at `bcd7fdd`):

- **`routes/transcribe-file.ts`** (dictation Import):
  `bodyLimit({maxSize: MAX_IMPORT_BYTES})` middleware (`:75-87`) →
  `c.req.formData()` buffers the body (`:96`) → `audioFile.arrayBuffer()`
  copies it (`:118`) → `decodeToWav16kMono(bytes)` may collect ffmpeg
  stdout — capped at 1 GiB (`lib/audio/decode.ts:57`, `:319`, `:359`) —
  while `bytes` (the upload) is still live.
- **`routes/meetings-import.ts`**: same pattern at `:77-89`, `:96`,
  `:180`, `:193`.
- `MAX_IMPORT_BYTES` = 1 GiB (`lib/audio/import-limits.ts:10`), so the
  worst case is upload (1×) + `arrayBuffer` copy (1×) + collected stdout
  (up to 1 GiB) ≈ **2–3× upload in RSS**.
- **Hidden multiplier:** Hono's `bodyLimit` middleware itself buffers the
  whole body in memory for requests *without* `content-length` — it
  accumulates every chunk in a `chunks[]` array and re-emits them via a new
  `ReadableStream` (`node_modules/hono/dist/middleware/body-limit/index.js`,
  the `size += value.length` loop). The `content-length`-present path is a
  header-only check. So "keep bodyLimit as a coarse ceiling" does *not*
  remove the buffering for chunked clients.
- The only producers of these routes are Electron main
  (`main/import-audio.ts`, `main/meeting-import.ts`) and the test suites;
  both build `FormData` with a file-backed blob. Undici computes
  `content-length` when every part has a known size (file-backed blobs do),
  so real traffic today takes bodyLimit's header path — but nothing
  *guarantees* that, and hand-built streaming bodies (memory tests, future
  callers) are chunked.
- Client-side abort already exists (UX-04, landed): the renderer cancels
  via `job:abort` → `AbortController` severs the main-process fetch
  (`main/abortable-jobs.ts`). Aborting does **not** cancel server-side
  work; when the client drops the connection the server keeps whatever it
  already buffered. That asymmetry is *why* server-side buffering is worth
  removing: after this change an aborted upload has cost at most a bounded
  chunk, not the bytes already shipped.

**Why now:** Tier-3 audit ordering (U10) landed UX-04 first so the user
can *tolerate* the wait; this spec removes the *failure* mode. Both were
required.

## 2. Goals / Non-goals

**Goals**

1. Peak steady allocation for an import request ≈ **one decoded WAV** on
   the dictation route (the pipeline needs the audio bytes once:
   `runTranscriptionPipeline({audio})`) and ≈ **ε (bounded chunks)** on
   the meetings route (no full hold anywhere on the happy path).
2. `MAX_IMPORT_BYTES` semantics unchanged: same 1 GiB bound, same 413
   envelope, enforced **while streaming** so an over-limit chunked upload
   is cut off mid-body, not after being fully received.
3. Every error envelope **byte-identical** to today: 400 (content-type,
   missing audio part, malformed body, empty data, field validation),
   415 (extension), 409 (meetings id/dir), 413 (size),
   422 (`binary_missing|decode_failed|empty_output|timeout`), 500s.
4. Decode runs **file → file**: ffmpeg writes its output to a temp path;
   nothing collects stdout. Same 10-minute timeout, same 1 GiB decoded
   cap, same taxonomy.
5. Temp hygiene: every temp artifact under a dedicated per-request tmp
   dir, removed on success, failure, and timeout — provably no orphans.
6. One shared implementation, two thin route integrations: limits from
   `lib/audio/import-limits.ts`, multipart streaming in a new
   `lib/audio/multipart-stream.ts`, file decode in `lib/audio/decode.ts`.

**Non-goals**

- **Server-side cancellation.** Client abort (landed) severs the fetch;
   the in-process pipeline may still run to completion. A server-side
   abort seam is future work (documented in `abortable-jobs.ts`) and is
   *not* attempted here.
- Provider-side streaming STT for imports (batch `provider.transcribe`
   keeps taking full audio bytes).
- Changing `MAX_IMPORT_BYTES` semantics, the extension allowlist, or any
   producer contract (`main/import-audio.ts`, `main/meeting-import.ts`
   unchanged).
- New dependencies. The multipart parser is hand-rolled (~150 lines);
   both routes control producer *and* consumer, so the accepted subset can
   stay small (see §4.1).
- Touching `POST /api/transcribe` (the dictation batch route) — it
   receives at most ~60 s of live dictation audio, not files.

## 3. Design

### 3.1 `lib/audio/multipart-stream.ts` — streaming form parser

Zero-dependency incremental parser over `c.req.raw.body`
(`ReadableStream<Uint8Array>`; `@hono/node-server` v2 hands the handler
`Readable.toWeb(incoming)` — a true stream, no buffering:
`dist/index.mjs` `newRequestFromIncoming`).

Accepted grammar (RFC 2046 subset; the producers are undici `FormData`
serializers, so this stays tight):

```
body      := preamble? dashBOUNDARY (padding? CRLF part)* padding? "--" epilogue
part      := headers CRLF data
headers   := (header-line CRLF)*          ; ends at the blank line
data      := (*OCTET minus delimiter)     ; delimited by CRLF dashBOUNDARY
dashBOUNDARY := "--" boundary
```

- Strict **CRLF** framing (what undici emits; bare-LF bodies are
  malformed → 400 — same verdict undici's own `formData()` reaches).
  A preamble and epilogue are tolerated and discarded.
- Transport padding (SP/HTAB) between boundary and CRLF/`--` is skipped.
- Part headers: `Name: value` lines; only `Content-Disposition` is
  parsed. `name="…"` selects the field; the **presence** of a
  `filename="…"` parameter (even empty) makes it a *file* part — the same
  distinction `FormData.get()` makes between `File` and `string`.
  Quoted-string backslash escapes are decoded. `filename*=` (RFC 5987) is
  not decoded: no producer emits it, and a non-ASCII filename cannot match
  the ASCII extension allowlist anyway.
- **File parts stream to disk** under a per-request temp dir
  (`mkdtemp(tmpdir()/openstyle-import-)`); field parts accumulate as
  UTF-8 text with a 64 KiB cap (a hardening bound; today's only outcome
  for an oversized text field is also a 400, just with the field-specific
  message). The header block is capped at 16 KiB. First occurrence of a
  name wins, matching `FormData.get()` — later duplicates are dropped
  (their temp files deleted).
- Byte accounting: **every byte read from the body** counts against
  `maxTotalBytes` (= `MAX_IMPORT_BYTES`, i.e. multipart framing included —
  `bodyLimit`'s semantics). Crossing it aborts the parse immediately
  (`too_large`) so a lying or absent `content-length` cannot smuggle a
  larger body in.
- Failure model: a single `MultipartStreamError` carrying
  `{kind: "malformed" | "too_large"}`. The parser cleans up its temp dir
  on its own failure paths; on success the *caller* owns cleanup.
  On any early exit the body stream is simply left unread (exactly what
  Hono's `bodyLimit` does on error; Node then discards the remainder and
  closes the connection).

Boundary handling, chunk-boundary straddling, and the delimiter-scan
retain rule are unit-tested (§5.1).

### 3.2 Replacing `bodyLimit` — and why

`bodyLimit` is **removed** from both routes and replaced by:

1. a **pre-check** — when `content-length` is present (and
   `transfer-encoding` absent) and exceeds the limit, answer 413 *before
   anything else*, exactly as the middleware does today; and
2. the **streaming bound** of §3.1, which applies to every request
   regardless of headers (the chunked path today is precisely the path
   where `bodyLimit` buffers the full body — keeping it would keep the
   OOM).

The 413 response stays byte-identical (`File too large` /
`Maximum upload size is …` / `PAYLOAD_TOO_LARGE`, built from the same
`formatLimit(maxBytes)`), and `createTranscribeFileRoute({maxBytes})` /
`createMeetingsImportRoute({maxBytes})` keep their factory shape for
tests.

One **documented micro-deviation**: today `bodyLimit` is middleware, so a
request that is simultaneously non-multipart *and* over-limit gets 413
before the content-type check; with streaming, the content-type check
runs first for **chunked** bodies (the 413 then arrives mid-parse
instead). For `content-length` requests the pre-check preserves today's
exact order. Neither real producer can construct the divergent case (all
Electron uploads are multipart with computable `content-length`), and no
existing test asserts it. Everything else keeps today's order: 400
content-type → 400 malformed/missing part → 400 field validation → 415 →
409s → 400 empty → 422 decode.

### 3.3 `lib/audio/decode.ts` — file → file

`decodeToWav16kMono(bytes)` is replaced by:

```ts
decodeFileToWav16kMono(inputPath, outputPath, deps?): Promise<{bytes: number}>
```

- Same argv family, two deltas: the output is a **temp file path**, not
  `pipe:1`, and `-fflags +bitexact` suppresses the muxer's `LIST INFO
  ISFT` chunk. With a seekable output ffmpeg writes *real* chunk sizes,
  so the common case is already canonical — no in-memory rewrite. A
  defensive streaming canonicalizer (pump the `data` chunk through a
  1 MiB buffer into a sibling file, prepend `wavHeader()`, rename over)
  covers non-canonical output (odd builds): verified against the bundled
  ffmpeg — without `+bitexact` the output carries `LIST` and data starts
  at offset 56; with it, offset 44.
- `needsDecode(buffer)` keeps its role; a `needsDecodeFile(path)` twin
  answers it for an on-disk upload (open fd → `parseWavHeader(fd)` →
  canonical-form + declared-size-vs-`fstat` check, identical semantics).
- The 1 GiB cap moves from stdout-counting to **file size**: a 1 s poll
  kills a runaway decode mid-write (same `decode_failed`, same
  "decoded audio exceeds N bytes" log line), and a final size check
  catches the exact boundary.
- Timeout stays `DECODE_TIMEOUT_MS` (10 min) with SIGKILL; the temp-input
  write goes away (the input is already on disk); stderr tailing,
  temp-dir redaction, `binary_missing` ENOENT mapping and the
  Windows-safe cleanup retries are unchanged.
- Taxonomy and envelopes are untouched: `binary_missing|decode_failed|
  empty_output|timeout` → same 422 bodies (`reason` field included).

### 3.4 Route integration — dictation (`routes/transcribe-file.ts`)

```
content-length pre-check (413)
content-type multipart? (400)
stream form via multipart-stream   → 413 / 400 (same envelopes)
audio = files.get("audio")          → 400 "audio field missing or not a file"
extension from audio.filename      → 415
audio.bytes === 0                   → 400 "Empty audio data"
needsDecodeFile(upload) ?
  yes → decodeFileToWav16kMono(upload, <tmp>/decoded.wav)  → 422 on failure
  no  → wavPath = upload path
duration: parseWavHeader(fd) on wavPath          (post-transcode rule `fr_f86c5c0f`)
audioBytes = readFile(wavPath)      ← the ONE bounded copy the pipeline needs
runTranscriptionPipeline(...)       (unchanged contract)
finally: rm -rf the request temp dir
```

Peak allocation for a 1 GiB canonical WAV upload: the final `readFile`
(≈1 GiB, the pipeline's single copy) plus bounded chunks — versus 2–3×
today. The dictation lease still spans the whole handler (unchanged).

### 3.5 Route integration — meetings (`routes/meetings/import`)

Same prologue (413 pre-check, 400 content-type, stream, 400 missing
part), then **today's validation order verbatim**: `id` → `audio_dir` →
`title` → `started_at` → extension 415 → 409 row → 409 non-empty dir →
400 empty → decode 422. Two shape notes:

- A part named `title`/`started_at` that arrives as a *file* part must
  still produce today's "must be a string"/"must be an integer" 400s, so
  the route checks `files.has(name)` before reading `fields.get(name)`.
- `duration_ms` is re-derived from the WAV **file header** (fd-based
  `parseWavHeader`) after decode/streaming but **before** any disk write
  or row insert — preserving today's "an unparseable WAV never leaves a
  half-open meeting" rule; the unparseable case keeps its 422
  `AUDIO_DECODE_FAILED`/`decode_failed` envelope.

Then: `mkdir -p audioDir`; `system.wav` = **rename** of the temp WAV
into place (EXDEV → bounded pump copy fallback — decode output lives in
`os.tmpdir()`, `audioDir` under `userData`; same volume on macOS, not
guaranteed elsewhere); INSERT (same statement); on INSERT failure remove
the dir exactly as today. The happy path never holds the audio in memory
at all: upload streamed to tmp, ffmpeg tmp→tmp, rename into
`audioDir/system.wav`.

### 3.6 Temp hygiene

One `mkdtemp("openstyle-import-")` dir per request, owned by the route,
removed in a `finally` (recursive, `maxRetries` for Windows EBUSY).
`multipart-stream` and `decode` write only inside paths the route hands
them (or their own short-lived dirs, self-cleaned). Tests assert the
tmpdir has no `openstyle-import-*` / `openstyle-decode-*` /
`openstyle-upload-*` leftovers after every failure path.

### 3.7 Memory shape (the point of the exercise)

| Path | Today (1 GiB worst case) | After |
| --- | --- | --- |
| upload buffering | formData 1× + arrayBuffer 1× (RSS) | ~0 (bounded chunks → disk) |
| decode | stdout collected ≤1 GiB (RSS, while upload live) | ~0 (file → file) |
| pipeline input | the decoded buffer (already counted) | 1× readFile (dictation only) |
| meetings write | `writeFileSync(system.wav, wav)` holds 1× | rename (0) |

Worst-case peak: dictation ≈ 1 GiB + ε (vs 2–3 GiB); meetings ≈ ε.

## 4. Testing

1. **Parser unit tests** (`tests/multipart-stream.test.ts`): single and
   multiple parts; field vs file classification; filename extraction
   incl. empty/escaped names; CRLF edges (preamble, epilogue, missing
   final CRLF, padding, delimiter split across 1-byte chunks, data
   containing partial-delimiter lookalikes); malformed bodies →
   `malformed`; over-limit (with and without content-length) →
   `too_large`; caps (header block, field size); first-wins duplicates;
   temp-dir cleanup on every failure.
2. **Route tests** (extend `transcribe-file-route.test.ts` +
   `meetings-import-route.test.ts`): existing assertions unchanged
   (mocks move from `decodeToWav16kMono` to `decodeFileToWav16kMono`);
   new cases: 413 mid-stream for chunked over-limit bodies; 400 "Empty
   audio data"; tmpdir empty after each failure path; meetings file-part
   `title`/`started_at` → today's 400s.
3. **Decode tests** (`audio-decode.test.ts`, `audio-decode-ffmpeg.test.ts`)
   rewritten against the file API: same taxonomy incl. timeout SIGKILL,
   cap kill, ENOENT, redaction; the real-ffmpeg suite (opt-in via
   `OPENSTYLE_FFMPEG_PATH`) asserts a canonical 44-byte output directly.
4. **Memory tests** (`tests/import-streaming-memory.test.ts`, opt-out via
   `OPENSTYLE_SKIP_MEMORY_TESTS=1` if CI-flaky): a real
   `@hono/node-server` listener on an ephemeral port, ~160 MB synthetic
   WAV generated to a temp file, uploaded via `fetch` with a
   disk-streamed chunked body (and once with a file-backed blob so
   `content-length` is present). Assert:
   - meetings import: `process.memoryUsage().arrayBuffers` delta across
     the request **< 40 MB** (nothing full-size is ever allocated);
   - dictation import: delta sampled **inside the (mocked) provider
     call**, where the single read-back copy is live but nothing else
     may be — **< 1.3× upload** (today's shape holds ≥2× live at that
     instant, so the bound separates the designs without depending on
     GC timing);
   - decoded-to-small cases (`.m4a` with a decode mock writing a small
     WAV): delta < 40 MB on both routes.

## 5. Rollout / compatibility

- Producer-compatible by construction: `main/import-audio.ts` and
  `main/meeting-import.ts` are unchanged (both verified by Electron
  typecheck/tests); their `FormData` uploads pass through the new parser
  untouched. e2e `import-screen` + `meeting-import` (isolated-server
  mode, foreign-4649 guard) gate the release.
- HTTP behavior is byte-identical except the one documented §3.2
  micro-deviation (unreachable by the real clients).
- Disk-for-memory trade: an import now writes ≤2× the upload to tmp
  (upload + decoded) instead of holding it in RSS; both are removed in
  `finally`. Disk headroom for a 1 GiB import is bounded and transient.
- No schema, settings, provider, or IPC changes.

## 6. Follow-ups

- Server-side cancellation of an aborted import (extend the
  `abortable-jobs` seam across the HTTP boundary) — still open, unchanged.
- Streaming the pipeline input straight from the fd in chunks (removing
  the last 1× on the dictation route) if a provider ever accepts
  chunked audio; not warranted while `transcribe()` takes one buffer.
