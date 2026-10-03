# Meeting LLM Queue — Resource-Aware Lane Spec

**PROPOSED 2026-09-27 — not approved, not implemented.** Spec for making
meeting summarization (and every other LLM call) *resource-aware* when the
user's inference engine is a single-worker server hosted **outside** openstyle.

Grounded in `main` @ `f2a0b7b` **plus the uncommitted working tree** at the
moment of writing — that working tree already carries the configurable
summarization timeout (`meeting_summary_timeout_seconds`, default 600 s, bounds
30–3600 s; §2.7), which supersedes the 60 s figure earlier design passes cited.
`SCHEMA_VERSION = 34` (`apps/server/src/lib/schema.ts:13`).

Companion reading: [`llm-task-profiles.md`](llm-task-profiles.md) (the four
call sites and the resolver this spec wraps),
[`meeting-mode.md`](meeting-mode.md) (the job/progress pattern this spec
reuses), [`meeting-transcription-quality.md`](meeting-transcription-quality.md)
§6 (Enhance) and [`meeting-diarization.md`](meeting-diarization.md) §11 (the
dictation lease this spec sits alongside, never replaces).

**Citations as read on 2026-09-27 against that tree — re-verify before
implementing.** Claims this document could not confirm in-repo are marked
**UNVERIFIED** and stay marked; they are not softened into fact anywhere in
here. Appendix A lists every line number this spec corrected relative to the
design pass it came out of.

This document only specifies. **No code was changed to produce it.**

---

## 1. Goal

The user runs **one** local inference engine, hosted outside openstyle, behind
`local_llm_url` (`apps/server/src/lib/llm/registry.ts:250`, base URL assembled
`:261`/`:271`). One engine with one worker slot serves every LLM feature in
this app:

- dictation cleanup — interactive, on the app's core loop, 20 s budget
  (`llm/task-profiles.ts:78`)
- Remix quick edit and the Remix agent loop — interactive, 30 s
  (`task-profiles.ts:85`, `lib/remix-agent.ts:89`)
- meeting Summarize — background, 600 s default per call, N calls
  (`task-profiles.ts:100`, `meetings/summarize.ts:309-327`)
- meeting Enhance — background, 60 s per call, N calls
  (`task-profiles.ts:107`, `meetings/enhance.ts:357`)

Nothing in the repo arbitrates between them. A background Summarize can occupy
the engine for its whole 600-second window while a dictation cleanup waits
behind it, and the user experiences that as *the app getting slow* — which is
the one regression this app must never ship (§6).

This spec adds the missing layer: **a per-endpoint lane**, acquired per LLM
call, with strict `interactive > background` precedence, so background meeting
work queues instead of contending.

### 1.1 Non-goals

- **No durable queue.** Queue state lives in the existing in-memory job blob.
  A restart drops the queue; the meeting survives (§4).
- **No mid-call preemption.** Once a background call is on the wire it
  finishes. §8 states that residual worst case numerically; it is accepted,
  not hidden.
- **No new inference engine, no in-process model, no local proxy.** openstyle
  stays a client of whatever endpoint the user configured.
- **No change to STT arbitration.** whisper-local / MLX ASR are separate child
  processes (`apps/server/src/lib/whisper/server.ts`,
  `apps/server/src/lib/mlx-asr/server.ts`) and stay governed by
  `lib/dictation-activity.ts` (§2.5), untouched in shape.
- **No per-task model routing.** All four tasks still resolve the single
  app-wide default LLM (`lib/providers.ts:34-56`).

---

## 2. Current state — what arbitrates today, grounded

### 2.1 `activeJobs` is per-meeting, in-memory, per-process, uncapped

Three module-level maps in `apps/server/src/routes/meetings.ts`:

| Symbol | Line | Keyed by |
|---|---|---|
| `activeJobs` | `:85` | meeting id |
| `MeetingJobKind` (type) | `:92` | — |
| `activeJobKinds` | `:95` | meeting id |
| `activeJobCancellations` | `:101` | meeting id |

Every key is a **meeting id**. There is no process-wide counter, no endpoint
key, and no cap anywhere in the file. Consequences, all verified:

1. Two *different* meetings can run jobs simultaneously — the map never
   consults anything but the id.
2. A transcribe job, a diarize pass, a Summarize, an Enhance, a Remix and a
   dictation cleanup can therefore all be in flight at once, and every one of
   them that needs an LLM hits the same external `local_llm_url`.
3. Being module-level `Map`/`Set` instances, they are **per-process**. The
   packaged app enforces `app.requestSingleInstanceLock()`
   (`apps/electron/src/main/index.ts:2308`), so one desktop process is the
   normal case. But `@openstyle/server` is also published as its own container
   image, and `OPENSTYLE_E2E_SERVER_URL` exists precisely to point a client at
   a second, standalone server — under either, these maps arbitrate nothing
   across processes. **UNVERIFIED:** whether anyone actually runs the server
   image with more than one replica; the limitation is structural regardless.

### 2.2 Who checks, who claims, who releases

The pattern a correct job follows — *check the slot, claim it before the first
`await`, release it in `finally*` — is established in-file and commented at
`:963-971`:

| Route | Route line | `activeJobs.has()` guard | `activeJobs.set()` claim | Release (`finally`) |
|---|---|---|---|---|
| `POST /:id/transcribe` | `:758` | `:768` | `:785` (+ kind `:786`) | `:532` (in `runTranscribeJob`, `:372`) |
| `POST /:id/retry-failed` | `:814` | `:821` | `:850` (+ kind `:851`; rationale comment `:845`) | `:918` |
| `POST /:id/diarize` | `:930` | `:949` | `:972` (+ kind `:973`) | `:1046` |
| `POST /:id/summarize` | `:1250-1293` | **none** | **none** | **none** |
| `POST /:id/enhance` | `:1299-1340` | `:1312` | **none** | **none** |

Read-only consumers, for completeness: `/orphans` filters on the map at `:645`
(comment `:644`), and `GET /:id` returns `job: activeJobs.get(id) ?? null` at
`:1382`.

### 2.3 Defect A — `/enhance` checks the slot but never claims it

`POST /:id/enhance` (`meetings.ts:1299`) guards with

```
:1309  // Same shared concurrency map /transcribe, /retry-failed and /diarize
:1310  // already check — an enhance pass reading meeting_segments mid-write
:1311  // from a running transcribe job would see a half-written transcript.
:1312  if (activeJobs.has(id)) {
:1313    return c.json({ error: "Transcription already running" }, 409);
```

— and then `await`s `enhance(...)` at `:1319-1326` **without ever calling
`activeJobs.set()`**. A check-only guard is not a lock: two concurrent
`/enhance` requests for the *same* meeting both read `has(id) === false` and
both proceed. That is a distinct, independently-fixable defect from §2.4, and
it is live today.

Why it is not cosmetic — `meetings/enhance.ts:494-509` writes corrections in
an explicit `BEGIN` … `COMMIT` block on the **shared** `getDb()` connection,
with `ROLLBACK` on failure (`:507`), and a second `BEGIN`/`COMMIT` block for
speaker proposals shortly after (`:512` onward). That is byte-for-byte the same
shape the diarize comment at `meetings.ts:966-971` names as the reason to
claim *before* the first await: pass B's `ROLLBACK` discards rows pass A had
already written inside A's still-open transaction. Two overlapping Enhance
passes on one meeting can therefore silently lose corrections — and can also
interleave LLM calls, doubling load on the single engine.

Reachable via: direct API calls (`/enhance` is a plain loopback HTTP route
behind the standard bearer auth; the e2e suites already drive the API
directly), and via automation/scripts. **UNVERIFIED:** whether a second
meetings-capable renderer window can exist — `index.ts` spawns
pill/main/settings/remix-bar windows (`:500`, `:881`, `:1049`, `:3960`) and
nothing proves a second detail pane, so multi-window is named as a plausible
vector, not a confirmed one. Within one window the client's `busy` flag
disables the button (`renderer/src/pages/meetings.tsx:1657`), so a
single-window double-click is not the trigger.

**Fix (this spec, §5.6):** claim the slot at the same point, kind `"enhance"`,
release in `finally`.

### 2.4 Defect B — `/summarize` neither checks nor claims

`POST /:id/summarize` (`meetings.ts:1250-1293`) checks nothing but the row's
status (`:1257-1259`) and transcript emptiness (`:1261-1263`), then `await`s
`summarizeMeeting` in-request (`:1265-1268`), `INSERT OR REPLACE`s the summary
(`:1269-1283`) and flips status at `:1284-1286`. It never touches
`activeJobs`.

So Summarize is **invisible to every other meeting feature**: a user who hits
Summarize and then Diarize (or a second Summarize) runs both at once on one
engine, and neither sees the other. The status check is not a substitute —
`/diarize`'s own comment at `:944-948` explains why the map check is the
load-bearing guard and status is not.

### 2.5 The only arbitration primitive in the repo, and what it covers

`apps/server/src/lib/dictation-activity.ts` is the entire cross-feature
arbitration surface:

| Primitive | Line |
|---|---|
| `beginDictation()` | `:12` |
| `endDictation()` | `:16` |
| `isDictationActive()` | `:21` |
| shared module-level `lastActiveAt` | `:43` |
| `waitForDictationIdle()` | `:71-93` |

Two consumers, both meeting-side:

- `meetings/transcriber.ts:271-279` — **whisper-local only**
  (`if (config.providerId === WHISPER_PROVIDER_ID)` at `:271`).
- `meetings/diarize.ts:387` — unconditional (rationale at `:383-386`: the
  diarizer runs CoreML/ANE, the same physical resource whisper-local targets).

Two things to notice about the primitive itself:

- It **fail-opens**: `:74-75` `const isActive = opts.isDictationActive;
  if (!isActive) return;` — omit the seam and the wait is a no-op. The lane
  must not inherit that default for background LLM calls (§5.3).
- `lastActiveAt` is **shared module state** (`:43`, rationale `:26-39`), which
  is what makes the two consumers cooperate. Do not make it per-caller (§6).

### 2.6 Defect C — streaming dictation never raises the lease

`beginDictation()` has exactly two callers in the repo:

| Caller | Lines |
|---|---|
| `routes/transcribe.ts` (batch dictation) | `:29-36` — `beginDictation()` `:30`, `endDictation()` `:34` |
| `routes/transcribe-file.ts` (Import) | `:98-105` — `beginDictation()` `:99`, `endDictation()` `:103` |

`routes/stream.ts` — the WebSocket dictation path, `GET /api/stream`
(`:40-42`) — **never imports and never calls either function** (verified: zero
matches for `dictation-activity` in the file). Its finalize+cleanup handler is
`onFinal` at `:278-388`, and the LLM cleanup happens *inside* it at
`:319-327` (`postProcess(...)` → `lib/post-process.ts:233` `createChatModel`).

This is the root reason meeting jobs collide with live dictation, and it is
worse than "the cloud path doesn't matter":

- **MLX ASR is served over that socket.**
  `streaming/providers/mlx-local.ts:60-62` returns `true` from
  `supportsSessionTransport()` while `supportsStreaming()` returns `false`
  (`:56-58`) — `registry.ts:38-48` honours the session-transport override, so
  a local, on-device dictation runs for the whole recording inside a path that
  never raises the lease. (whisper-local, by contrast, has no
  `openStreamingSession` — `streaming/providers/whisper-local.ts:26-28` plus
  `registry.ts:44` — so it still goes batch, and *is* covered.)
- **Interactive cleanup is invisible.** The `cleanup` LLM call made at
  `stream.ts:319` is the most latency-sensitive LLM traffic in the app, and it
  is precisely the traffic the lease cannot see.
- **Diarize's yield is defeated.** `diarize.ts:387` polls
  `isDictationActive()`; during a live MLX-over-WS dictation that reads
  `false`, so speaker identification can start mid-dictation on the same
  Apple Silicon package. **UNVERIFIED:** whether MLX ASR and CoreML/ANE
  diarization measurably contend — the co-location claim is well-founded (both
  are on-device accelerators in the same process tree), the measurement is not
  in this repo.

**Scoping hazard — do not "fix" this by wrapping the connection.** The WS
session lives for the entire recording (`stream.ts:42-58`, reconnect logic
`:412-420`). `waitForDictationIdle` refreshes `lastActiveAt` on *every* poll
that sees activity (`dictation-activity.ts:82-85`) and only resumes after
`sustained` idle (`:89-91`, default 15 s at `:76`). Hold the flag for a whole
session and meeting transcription/diarization starve for the duration of that
recording — a worse bug than the one being fixed. The lease must wrap
`onFinal` (`stream.ts:278-388`), whose own comment at `:299-300` already
frames that window as "finalization + cleanup latency, not the entire recording
session". Concretely: `beginDictation()` as the first statement of `onFinal`,
`endDictation()` in a `finally` around the body — a small change, but a
`try/finally`, not literally two adjacent lines.

### 2.7 What the landed timeout change fixed, and what it did not

Already in the tree (uncommitted at citation time):

| Piece | Line |
|---|---|
| Settings key `meeting_summary_timeout_seconds` | `packages/validations/src/settings.ts:287-288` |
| Bounds 30 / 3600 / default 600 | `settings.ts:327-329` |
| Seconds→ms, single conversion site | `settings.ts:361-365` |
| Route accepts, rejects nonsense with 400 | `apps/server/src/routes/settings.ts:303-319` |
| Profile default behind the setting | `apps/server/src/lib/llm/task-profiles.ts:100` |
| `taskTimeoutMs()` reads the row fresh per call | `task-profiles.ts:130-135`, used `:395` |
| Reaches the wire | `meetings/llm-call.ts:94` (`AbortSignal.timeout`) |
| Pinned by tests | `apps/server/tests/meeting-llm-timeouts.test.ts` (new) |

It fixed *one call being too short*. It did not add arbitration: with 600 s
now permissive, a map/reduce run happily occupies the single worker for
`calls × 600 s` (§5.8) while dictation queues. **Widening a per-call window
without queueing makes the collision longer, not safer.** That is the gap this
spec exists to close. `meetingEnhance` still sits at a code-defined 60 s
(`task-profiles.ts:107`) — a known asymmetry, recorded in the code comment at
`:108`, out of scope here.

---

## 3. Every LLM call site — the wrap surface

Exactly **four** call sites build a chat model. Verified by exhaustive search
for `createChatModel(` across `apps/` and `packages/`:

| # | `createChatModel` site | Task | Transport | Signal today |
|---|---|---|---|---|
| 1 | `lib/meetings/llm-call.ts:70` | `meetingSummarize` **and** `meetingEnhance` (shared helper, `:56`) | non-streaming `postProcess` (`:80`) | `AbortSignal.timeout` `:94` |
| 2 | `lib/post-process.ts:233` | `cleanup` (dictation) | non-streaming `postProcess` (`:243`) | `AbortSignal.timeout` `:256` |
| 3 | `lib/remix-agent.ts:90` | `remix` (agent, tool loop) | `streamText` `:89`, `stopWhen: stepCountIs(16)` (`:24`, `:97`) | `AbortSignal.any([client, timeout])` `:83-87`, applied `:100` |
| 4 | `lib/remix-transform.ts:106` | `remix` (quick edit) | `generateText` `:105` | `AbortSignal.timeout` `:115` |

Those four are the complete LLM traffic of the product, so wrapping them is
sufficient — no fifth site hides elsewhere. Callers worth naming so nobody
re-derives them: `postProcess` (site 2) is reached from
`routes/transcribe.ts`, `routes/stream.ts:319`, `routes/post-process-route.ts`
and `lib/transcription-pipeline.ts:231`; site 1 is reached from
`summarize.ts:205-206` and `enhance.ts:270`.

Two structural notes:

- **`createChatModel` itself (`lib/providers.ts:58-76`) is not the choke
  point.** It returns a model object; the request happens later. A lane
  acquired there would be released before the call, or held across an unknown
  number of calls. Wrap at the four *call* sites (§5.2).
- **`maxRetries` is set nowhere on the LLM path.** Verified: the only
  `maxRetries` in `apps/` is `routes/transcribe-file.ts:236` and
  `routes/meetings-import.ts:364`, both STT uploads. So all four LLM sites run
  on the AI SDK's default retry behaviour. **UNVERIFIED:** that default's exact
  value from outside this repo — hence open question 3 (§12), because an
  invisible retry doubles the time a background call holds the lane.

---

## 4. Why there is no durable queue (and why cut 1 doesn't need one)

- **No `queued` state exists anywhere in the codebase.** Verified: the only
  occurrences of the string are an unrelated local variable
  (`lib/streaming/pending-audio.ts:38-40`) and a comment
  (`pages/app.tsx:2442`).
- **`meetings.status` is CHECK-constrained** (`schema.ts:765-768`:
  `'recording','interrupted','recorded','transcribing','transcribed',
  'summarized','failed'`). SQLite cannot `ALTER` a CHECK, so adding `queued`
  there means a table rebuild — new table, copy, drop, rename, plus its index.
- **`meeting_summaries` has no `status` column at all**
  (`schema.ts:789-798`) — **this corrects the design pass, which attributed the
  CHECK constraint to this table (§A).** The rebuild pressure is real but lives
  on `meetings`, not on `meeting_summaries`.
- Any new migration must keep `SCHEMA_VERSION` **above upstream's 26**
  (`schema.ts:13`, reasoning at `:9-12`).
- **Nothing survives quit today.** `before-quit` runs `cleanupBeforeQuit()`
  (`apps/electron/src/main/index.ts:4892-4907`: stops recorder, whisper, mlx,
  key listener, closes the HTTP server) and then `app.exit(0)` in a `finally`
  (`:4941`; also `:1869` on factory reset). An in-flight Summarize dies with
  the process, and `meeting_summaries` is only ever written after the calls
  succeed (`meetings.ts:1269-1283`) — so there is nothing to resume *from*.
- Renderer polling is gated on `transcribing` only
  (`pages/meetings.tsx:1337-1338`; list polling `:2360-2365`;
  `LIVE_STATUSES = new Set(["recording","transcribing"])` `:286`). A `queued`
  status would render as a dead button today.

Verdict: **queue in memory, in the existing job blob.** It is the same
ephemerality the app already has, costs zero migrations, and is honest about
quit behaviour. Durability is a later decision, not a prerequisite (§9).

---

## 5. Proposed design

### 5.1 `apps/server/src/lib/llm/lane.ts` — the lane key is the ENDPOINT

```ts
export type LlmLaneClass = "interactive" | "background";

export interface AcquireLlmLaneArgs {
  /** Normalized `host:port` of the endpoint this call will hit. */
  lane: string;
  cls: LlmLaneClass;
  taskId: LlmTaskId;
  /** Polled between queue ticks — the existing cancel seam. */
  shouldStop?: () => boolean;
  /** Fired when the call had to wait, so the job blob can surface it. */
  onQueued?: (info: { waitedMs: number; ahead: number }) => void;
  signal?: AbortSignal;
}

export function acquireLlmLane(a: AcquireLlmLaneArgs): Promise<LaneLease>;
// lease.release() — idempotent, always in a finally.
```

**Lane key = normalized `host:port`, not the config key.** This is the whole
point of the type. If `local_llm_url` and an oMLX base URL both resolve to
`127.0.0.1:8123`, they are **one physical box** and must collapse into
**one** lane; keying on a setting name or a provider id would silently create
two lanes and one GPU. Two further normalizations the key must do, because
`new URL().host` alone is not enough:

- `localhost` and `127.0.0.1` are the same socket — fold loopback names.
  **UNVERIFIED:** that both spellings actually appear in user configs; the
  normalization is cheap insurance either way.
- Trailing path and `/v1` suffix are not part of lane identity. There is an
  existing precedent to copy rather than invent: `normalizeOmlxRoot()`
  (`packages/validations/src/omlx.ts:40-44`) already collapses
  `…/v1/audio/transcriptions` to a server root, and the local-llm provider
  already strips `/v1` at `llm/registry.ts:261` before re-adding it at
  `:271`. Extract a host-port normalizer alongside them and use it in both
  places rather than writing a third regex.

**Concurrency per lane: local 1, cloud 2** — reusing the numbers already
proven for STT at `meetings/transcriber.ts:175-178` ("parallel requests just
queue (or thrash), so keep it serial. Cloud providers take 2 in flight"),
applied via the worker fan-out at `:241-245`. Local-vs-cloud classification
already exists: `providers.ts:8` `LOCAL_PROVIDERS = new Set(["local-llm"])`,
consulted at `:66`, with `local: true` declared on the provider entry at
`llm/registry.ts:245`.

### 5.2 Acquired and released **per call**, never per job

Non-negotiable in this design: the lease wraps **one** `generateText` /
`streamText` / `postProcess` invocation, not the feature around it.

A Summarize run is 1 call, or N map calls plus 1 reduce, executed sequentially
in `summarizeMeeting` (`summarize.ts:296-327`). If the lane were held for the
job, a 19-chunk meeting would block an interactive cleanup for the entire run.
Held per call, the queue drains between chunks: 600 s of work becomes N
separately-yielding slots.

**Honest cost:** for site 3 the SDK owns the tool loop
(`stopWhen: stepCountIs(REMIX_MAX_STEPS)`, `remix-agent.ts:24`, `:97`), so
"per call" there means one lease across up to 16 model round-trips. That is
coarser than the meetings path. Mitigation: Remix is `interactive`, so it is
the class that *wins* the queue — the coarseness costs background work
latency, not typing latency. Documented, not glossed.

### 5.3 Precedence: strict `interactive > background` FIFO

- Two queues per lane, strict priority: any waiting `interactive` call takes
  the next free slot ahead of every `background` call. No aging, no
  probabilistic boost — strict, because it is explainable in one sentence in
  the UI.
- Within a class: FIFO.
- A background call's **start** is additionally gated on dictation: it must
  pass `isDictationActive() === false` *and* `waitForDictationIdle()` before
  it may take a slot — reusing `dictation-activity.ts:71-93` verbatim, same
  15 s resume window (`:76`), so the ANE/whisper precedent is unchanged.
- **Do not reuse the fail-open default.** `waitForDictationIdle` returns
  immediately when the seam is omitted (`:74-75`). For STT that is right; for
  a background LLM call a missing seam would silently mean "no gate". The lane
  passes the seam explicitly and fails *closed* — a lane that cannot tell
  whether dictation is live does not start background work; it waits and logs
  at `warn` once.
- **No mid-call preemption** (§1.1, §8).

### 5.4 Where each site sits

| Site | File:line | Class | Notes |
|---|---|---|---|
| Meeting Summarize | `meetings/llm-call.ts:70` via `summarize.ts:205-206` | `background` | per call, map and reduce each take their own lease |
| Meeting Enhance | `meetings/llm-call.ts:70` via `enhance.ts:270` | `background` | per chunk (`enhance.ts:357-372`) |
| Enhance auto-run | `routes/meetings.ts:492-507` | `background` | already fail-closed (`.catch` `:504-506`) — keep |
| Dictation cleanup | `post-process.ts:233` | `interactive` | 20 s budget (`task-profiles.ts:78`); this is the latency that matters |
| Remix quick edit | `remix-transform.ts:106` | `interactive` | |
| Remix agent | `remix-agent.ts:90` | `interactive` | coarse lease (§5.2) |

Both classes share the **same lane key** — otherwise the queue is decorative.

### 5.5 Queue state stays in memory

Extend the existing job blob rather than adding tables (§4):

- `activeJobs` (`meetings.ts:85`) gains queue fields — e.g.
  `{ done, total, failed, queued?: { cls, ahead, sinceMs } }` — surfaced free
  of charge by `GET /:id` (`:1382`), whose `job` field the renderer already
  reads.
- `MeetingJobKind` (`meetings.ts:92`) extends with `"summarize" | "enhance"`,
  so `activeJobKinds` (`:95`) can answer "what holds this slot" for the
  cancel gate (§5.7) exactly as it does for `"diarize"` today (`:807-810`).

### 5.6 `/summarize` becomes 202 + `runSummarizeJob`

Copy `POST /:id/transcribe` (`meetings.ts:758-789`) — that route is the
house pattern; do not invent a second job framework:

1. guard: status/emptiness (keep `:1257-1263`), **plus**
   `if (activeJobs.has(id)) 409` (closes §2.4 and, with §2.3, both).
2. `activeJobs.set(id, { done: 0, total: 0, failed: 0 })` +
   `activeJobKinds.set(id, "summarize")` **before the first `await`** — the
   claim-before-await discipline already documented at `:963-971`.
3. `void runSummarizeJob(id, …)`; return `202`.
4. `runSummarizeJob` never throws; its `finally` deletes the slot and the kind
   (mirror `:531-535`).

`/enhance` gets the same claim/`finally` treatment at `:1312` (fixing §2.3).
Whether it also becomes 202 is a follow-up; the claim is the fix, the 202 is
polish (§9).

Renderer: `runAction` (`meetings.tsx:1392-1424`) and the Summarize button
(`:1667-1679`) currently await in-request and show a bare spinner
(`:1674-1678`). A 202 needs polling widened past `transcribing`
(`:1337-1338`, `:2360-2365`, `LIVE_STATUSES` `:286`) — and per
`llm-task-profiles.md`'s and `meeting-mode.md`'s precedent, new user-facing
strings go through `t()` in all 7 locales + `template.json`. **What the user
sees while queued is open question 4 (§12).**

### 5.7 Cancellation

Reuse `activeJobCancellations` (`meetings.ts:101`) and its existing gate: the
cancel route (`:799-812`) admits only kinds `"transcribe" | "retry-failed"`
(`:807-810`) and 409s a `"diarize"` holder with the reason spelled out
(`:805-806`). Add `"summarize"` (and `"enhance"` if it moves to 202) to that
allowlist, and poll `shouldStop()` between map chunks — the same seam already
threaded at `:400`, `:855`, and honoured between chunk tasks at `:455`,
`:896`. A queued call that is cancelled never starts: it releases its lease
unacquired and the row lands unchanged.

### 5.8 Job-level ceiling — derived, not asserted

A queued job must be **bounded**. Per-call timeouts (`task-profiles.ts:100`,
`llm-call.ts:94`) bound one call; nothing today bounds the run. The
validations docblock already says so: *"map-reduce makes one call per chunk
plus a reduce, so total wall clock is calls × this value"*
(`packages/validations/src/settings.ts:324-325`).

```
MAX_SUMMARIZE_CALLS = 24
plannedCalls = min(N + 1, MAX_SUMMARIZE_CALLS)   // N map chunks + 1 reduce; 1 for single-pass
jobDeadlineMs = clamp(perCallMs × plannedCalls × slack,
                      2 × perCallMs,
                      4 * 60 * 60 * 1000)          // slack ∈ [1,2], recommend 1
```

**Where 24 comes from.** Inputs, all verified: chunk budget default 8,000
tokens (`summarize.ts:33`, `validations/settings.ts:189`), max 200,000
(`settings.ts:190`); overlap ≤ min(400, 10 %) (`summarize.ts:67-68`);
`meeting_max_duration_hours` default 4, max 24 (`settings.ts:185-186`).

- Fresh transcript per chunk ≤ `budget − overlap` = 8,000 − 400 = **7,600
  tokens**.
- Transcript tokens per hour of speech ≈ **12,000** — an **estimate**, ~200
  tokens/min; the repo measures no such figure, and its only nearby measurement
  is 300–400 hidden reasoning tokens per call (`settings.ts:300-301`,
  `summarize.ts:40-43`). **UNVERIFIED.**
- Default 4 h meeting → 48,000 tokens → ⌈48,000 ÷ 7,600⌉ = **7 map chunks →
  8 calls**.
- Max 24 h meeting → 144,000 tokens → ⌈144,000 ÷ 7,600⌉ = **19 map chunks →
  20 calls**.
- `24` = 20 rounded up with headroom. It is a **bound, not a target** — the
  typical run is 1 call, occasionally 8. Because the arithmetic rests on an
  unverified token/hour rate, the constant must be enforced as a *guard that
  fires loudly* (`warn`, "transcript exceeds the bounded summarize budget")
  rather than silently truncating, until a real measurement replaces the
  estimate (§12 Q2).

**Resulting ceilings** (`slack = 1`):

| Case | plannedCalls | perCall | deadline |
|---|---|---|---|
| single pass, default | 1 | 600 s | **1,200 s (20 min)** — floor wins |
| 4 h meeting, default budget | 8 | 600 s | 4,800 s (80 min) |
| worst legal, default budget | 24 | 600 s | 14,400 s = **4 h — the clamp** |
| worst legal, min timeout | 24 | 30 s | 720 s (12 min) |

Notes: the `2 × perCall` floor exists so a single call that merely *hits* its
own timeout doesn't kill the job on first attempt — same posture as
`transcriber.ts:267` (`maxAttempts ?? 3`). At `slack = 2` the worst legal case
wants 8 h and is clamped to 4 h. **Yes, 4 h numerically coincides with
`DEFAULT_MEETING_MAX_DURATION_HOURS = 4` (`settings.ts:185`). That is a
coincidence; do not read a derivation link into it, and do not couple them.**

---

## 6. Non-negotiable constraints

1. **Do not "simplify" diarize's claim-before-await.** `meetings.ts:963-971`
   is load-bearing prose about a real transaction hazard (`:966-969`). The lane
   sits *alongside* it. Any refactor that moves `:972-973` after
   `probeDiarizationModels` (`:975`) reopens a known race.
2. **Do not make `lastActiveAt` per-caller.** It is shared module state on
   purpose (`dictation-activity.ts:26-43`); two callers cooperating on one
   lease is the behaviour.
3. **Summarize/Enhance failures use `job.error`, never `meetings.error`.**
   `meetings.error` is the *chunk-failure* banner: `"N of M chunks failed"`
   (`meetings.ts:510-513`), `"Cancelled by user"` (`:457-461`), fatal
   transcription text (`:523-527`), retry residue (`:908-911`). The renderer
   renders `actionError ?? meeting.error` (`meetings.tsx:1774-1777`) and
   special-cases the cancel string (`:1547`). A summarize failure written there
   destroys a transcript-integrity warning the user needs.
4. **Fail closed.** A saturated or dead engine must never destroy a transcript
   or write a partial/echo summary. Preserve `result.model === null → throw`
   (`llm-call.ts:99-103`) and the vocab-leak guard
   (`stream.ts:286-297`). Queue, wait, fail with a clear error — never deliver
   a degraded summary as if it succeeded.
5. **Dictation latency is the regression that matters most.** `cleanup` is
   `interactive` (§5.4) and must never queue behind meeting work. If the lane
   ever adds measurable time to the commit→delivered-text path measured at
   `stream.ts:336-345`, the lane is wrong and gets reverted.
6. **Revert the naive lease.** `beginDictation` wraps `onFinal`
   (`stream.ts:278-388`), never the connection — see §2.6's starvation hazard.

---

## 7. Failure / degradation matrix

| Failure point | Behaviour |
|---|---|
| Engine down / unreachable when a background call acquires | Call fails through the existing `result.model === null → throw` (`llm-call.ts:99-103`). `runSummarizeJob` records `job.error`; `meetings.error` untouched (constraint 3). No partial summary written — the `INSERT OR REPLACE` at `:1269-1283` stays after the calls succeed. |
| Interactive cleanup arrives while a background call is mid-generation | **No preemption** (§8). Cleanup queues behind the in-flight call, then takes the slot ahead of all other background work. |
| Job cancelled while queued | Lease released unacquired; call never fires; row unchanged (§5.7). |
| Process quit mid-call | `app.exit(0)` in `finally` (`index.ts:4941`) — the queue dies with it, no durable state to corrupt (§4). Meeting transcript survives (segments already persisted). |
| Queue state never surfaces (renderer never polls `queued`) | `GET /:id` still returns `job` (`meetings.ts:1382`); the blob is invisible, not wrong. Polling must widen past `transcribing` (`meetings.tsx:1337-1338`) — open question 4. |
| Lane unmeasurable (no dictation seam wired) | Fail **closed**: background work waits and warns once. Never inherit `waitForDictationIdle`'s fail-open `:74-75`. |
| Transcript exceeds `MAX_SUMMARIZE_CALLS` | `warn` loudly + bounded failure. **Never** silent truncation (§5.8 — the constant rests on an unverified token/hour rate). |
| `/summarize` double-submit | `409` on the claimed slot (§5.6) — closes §2.4 and §2.3. |
| SDK retries a saturated engine invisibly | Known open exposure (§12 Q3): `maxRetries` unset at all four sites. Until decided, a background call can double its lane hold. |

---

## 8. What this deliberately does not solve

- **Residual worst case, stated numerically:** one in-flight background call
  can still precede an interactive cleanup. With the default 600 s per-call
  timeout (`task-profiles.ts:100`), dictation cleanup
  (`cleanup` budget 20 s, `task-profiles.ts:78`) waits up to **~600 s** for a
  meeting map call that started one moment earlier. That is a terrible-feeling
  number, and this spec does not eliminate it — it bounds the *queue* and makes
  the wait explainable. Eliminating it needs either true preemption (a
  background call aborted mid-generation — costs a wasted 600 s of compute,
  and open question 1 decides whether aborting even frees the GPU) or a lower
  background timeout.
- **Cross-process arbitration** on multi-replica server deployments: not
  solved (§2.1, **UNVERIFIED** that anyone does this).
- **`meetingEnhance`'s 60 s timeout** stays as-is (`task-profiles.ts:107`,
  asymmetry noted in-code at `:108`).
- **Durable queue / resume after quit**: not solved by design (§4).

---

## 9. First cut — the recommended minimum

Three changes, in this order, each independently shippable:

1. **`beginDictation()` / `endDictation()` around `onFinal`**
   (`stream.ts:278-388`, `try/finally`, per §2.6). Smallest diff, immediate
   correctness win: MLX-over-WS dictation and streaming cleanup stop being
   invisible to `transcriber.ts:271-279` and `diarize.ts:387`.
2. **`lib/llm/lane.ts` + wrap the four sites** (§3, §5.1–§5.4). In-memory
   queue, no migration.
3. **`/summarize` 202 + `runSummarizeJob`, `/enhance` claims its slot**
   (§5.6–§5.7) — this is where defects A and B actually die.

Ship 1 and 3 without 2 if the lane needs to be split further; 1 and 3 are
correctness fixes that the lane then builds on. Do **not** ship the lane
without the four call sites wrapped — a half-wrapped lane makes throughput
*look* worse while changing nothing.

---

## 10. Test plan

- **Server, lane unit** — `apps/server/tests/llm-lane.test.ts` (new): strict
  priority under contention (background enqueued first, interactive overtakes);
  FIFO within class; `lane` key folds `localhost` ↔ `127.0.0.1` and
  `…/v1`; local 1 / cloud 2; lease released exactly once on throw;
  `shouldStop()` while queued → never acquires; missing seam → waits + warns
  (fail closed).
- **Defect regressions** — `apps/server/tests/meetings-routes.test.ts`:
  second `/enhance` → 409 (today 200, the §2.3 bug); second `/summarize` →
  409 (§2.4); `/summarize` and `/diarize` mutually excluded; slot released on
  every early return; `job.error` populated and **`meetings.error` asserted
  unchanged** after a summarize failure (constraint 3).
- **Lease** — `stream.ts` `onFinal` raises and lowers the counter on both the
  success and `.catch` paths (`:329-387`); `dictation-activity` tests extended
  that the connection lifetime does *not* hold it (§2.6).
- **Ceiling** — `plannedCalls` / `clamp` arithmetic pinned at the §5.8 table's
  four rows, in the style of
  `apps/server/tests/meeting-llm-timeouts.test.ts` (capture at the
  `postProcess` boundary, no real LLM).
- **e2e** — extend `apps/electron/tests/meeting-import.test.ts`'s sibling
  coverage for the 202 + poll contract; runs against an isolated
  `OPENSTYLE_E2E_SERVER_URL` started with `cwd=apps/electron` so bundled
  ffmpeg/diarize assets resolve.
- **Manual eyeball** — start a Summarize on a long meeting, dictate twice
  during it: cleanup must land while summarize still shows queued; then
  `kill -9` mid-summarize → transcript intact, no partial summary row, meeting
  selectable and resummarizable.

---

## 11. File inventory (proposed)

New: `apps/server/src/lib/llm/lane.ts`;
`apps/server/tests/llm-lane.test.ts`.

Modified: `apps/server/src/routes/stream.ts` (`onFinal` lease);
`apps/server/src/routes/meetings.ts` (`MeetingJobKind` `:92`, `/summarize`
`:1250-1293`, `/enhance` claim `:1312`, cancel allowlist `:807-810`);
`apps/server/src/lib/meetings/llm-call.ts` (`:70`),
`apps/server/src/lib/post-process.ts` (`:233`),
`apps/server/src/lib/remix-agent.ts` (`:90`),
`apps/server/src/lib/remix-transform.ts` (`:106`) — lane acquire/release per
call; `apps/server/src/lib/meetings/transcriber.ts` (reuse the
`:175-178` concurrency constants as shared lane numbers, optional);
`packages/validations/src/settings.ts` (only if a lane concurrency knob is
exposed — prefer not to, cut 1);
`apps/electron/src/renderer/src/pages/meetings.tsx` + 7 locales +
`template.json` (queued UI, open question 4).

No migration if §5.5 holds. **`SCHEMA_VERSION` stays 34**
(`schema.ts:13`) — and if a future cut does add `queued` to `meetings.status`
(`:765-768`), it stays above upstream's 26 (`schema.ts:9-12`).

knip note: `lane.ts` is imported by four call sites, so no `knip.jsonc`
`entry` change is needed.

---

## 12. Open questions (for the user, not blocking implementation of §9 item 1)

1. **Does llama.cpp / oMLX actually stop generating when the client closes the
   socket?** No, maybe, depends on version and `--parallel`. If it does **not**,
   then aborting a background call mid-generation frees the *lane* but not the
   *GPU* — preemption becomes a bookkeeping lie, and §8's residual worst case
   is permanent. This answer decides whether mid-call preemption is ever worth
   building.
2. **Do `local_llm_url` (`llm/registry.ts:250`) and the oMLX base URL
   (`omlx_base_url`, consumed for STT at
   `apps/server/src/lib/streaming/providers/omlx.ts:53`, `:60`;
   `routes/models.ts:115`; `routes/settings.ts:444-445`) point at the same
   physical box in your setup?** If yes — likely, since oMLX serves
   `/v1/chat/completions` and `/v1/audio/transcriptions` from one process —
   then the LLM lane and the STT path contend on the same engine today, and
   §5.1's host:port folding plus the §9 item 1 lease are the same problem
   being fixed from two ends. Fold STT into the lane too?
3. **Should lane calls pass `maxRetries: 0`?** Nothing sets it at any of the
   four LLM sites (§3) so the SDK's default retries apply (**UNVERIFIED** —
   that default's value isn't in this repo). On a saturated engine a retry is
   silent double-work: it doubles the lane hold *and* the user's wait, with no
   signal in `job.error`. Recommending `maxRetries: 0` for lane-held calls —
   queueing is the retry — pending your call.
4. **What do you want to see while queued?** Nothing (silent spinner), a
   "Waiting for the model…" pill slot, or position + estimated wait
   (`onQueued` gives `{ waitedMs, ahead }`)? Decides how far polling widens
   past `transcribing` (`meetings.tsx:1337-1338`) and how many new i18n keys
   land.
5. **Is `MAX_SUMMARIZE_CALLS = 24` acceptable as a provisional bound**, given
   the token/hour figure behind it is an estimate (§5.8), and that the guard
   must fail loudly rather than truncate until you measure?

---

## Appendix A — line numbers corrected versus the design pass

Every delta between the numbers this spec was handed and the numbers verified
against `main` @ `f2a0b7b` + the working tree on 2026-09-27. Line numbers that
are **not** listed here were confirmed exact.

| # | Claim as handed | In the tree | Status |
|---|---|---|---|
| 1 | guards `~:645/:768/:821/:949/:1312` | `:645/:768/:821/:949/:1312` | ✅ exact |
| 2 | claims `~:785/:850/:972` | `:785` (+kind `:786`), `:850` (+kind `:851`), `:972` (+kind `:973`) | ✅ exact; kind-map writes added |
| 3 | releases `~:532/:918/:1046` | `:532` (+`:533-534`), `:918` (+`:919-920`), `:1046` (+`:1047`) | ✅ exact; the `activeJobKinds`/`activeJobCancellations` deletes beside them were missing |
| 4 | summarize `~:1250` does neither | `:1250-1293` | ✅ number exact; range added |
| 5 | `/enhance` `~:1299`, checks `~:1312`, never claims | `:1299`, `:1312`, no claim | ✅ exact — **Defect A confirmed live** |
| 6 | `activeJobs` maps `~:85/:95/:101` | `:85`, `:95` (type `MeetingJobKind` at `:92`, not `:87`), `:101` | ✅ exact; **`:87` is the comment, the type is `:92`** |
| 7 | `stream.ts` never calls `beginDictation()`; only `transcribe.ts ~:30`, `transcribe-file.ts ~:99` | `transcribe.ts:29-36` (`begin` `:30`, `end` `:34`); `transcribe-file.ts:98-105` (`begin` `:99`, `end` `:103`); `stream.ts` zero refs | ✅ exact |
| 8 | `waitForDictationIdle` `~:71-96` | `:71-93` (function body ends `:93`; `:94-96` are blank/next block) | **✗ corrected: `:71-93`** |
| 9 | used by `transcriber.ts ~:271` | call at `:272-278`; `:271` is the whisper-only `if` | **✗ corrected: call `:272`** (`:271` = the gate, so "~271" was defensible but imprecise) |
| 10 | used by `diarize.ts ~:387` | `:387` | ✅ exact |
| 11 | exactly four `createChatModel` sites: `meetings/llm-call.ts`, `post-process.ts`, `remix-agent.ts`, `remix-transform.ts` | `llm-call.ts:70`, `post-process.ts:233`, `remix-agent.ts:90`, `remix-transform.ts:106` | ✅ four, files correct; exact lines added |
| 12 | **"`meeting_summaries` status CHECK constraint in `schema.ts` (~:765) forces a table rebuild** | `:765-768` is **`meetings.status`**; `meeting_summaries` (`:789-798`) has **no `status` column at all** | **✗ CORRECTED — the material error in the pass.** Right mechanism, wrong table. See §4. |
| 13 | `SCHEMA_VERSION` 34, must stay above upstream 26 | `schema.ts:13`, reasoning `:9-12` | ✅ exact |
| 14 | "no `queued` state anywhere" | only unrelated hits (`pending-audio.ts:38-40`, `app.tsx:2442`) | ✅ confirmed |
| 15 | "only `remix/agent.ts` plumbs client disconnect" | `routes/remix/agent.ts:39` → `remix-agent.ts:83-87`, `:100` | ✅ exact |
| 16 | "`app.exit(0)` on quit" | `:4941` (`before-quit` `finally`), `:1869` (factory reset), `cleanupBeforeQuit` `:4892-4907` | ✅ exact; cite the two sites, not one |
| 17 | "renderer polls only while status is `transcribing`" | `meetings.tsx:1337-1338`; list `:2360-2365`; `LIVE_STATUSES` `:286` | ✅ exact |
| 18 | diarize claim-before-await `~:962-971` | comment `:963-971`, claims `:972-973` | **✗ corrected: `:963-973`** |
| 19 | configurable summarization timeout, default 600, bounds 30–3600 | bounds/default `validations/settings.ts:327-329`, key `:287-288`, `meetingSummaryTimeoutMs` `:361-365`, profile `task-profiles.ts:100`, `taskTimeoutMs` `:130-135`/`:395`, wire `llm-call.ts:94`, route `routes/settings.ts:303-319` | ✅ confirmed; numbers exact, and **note it is still uncommitted** |
| 20 | "one worker slot at `local_llm_url`" | `llm/registry.ts:250`, `:261`, `:271` | ⚠️ **UNVERIFIED** — endpoint-side worker count is outside this repo. The lane design does not depend on it being exactly 1 (§5.1 makes it configurable per class). |
| 21 | "`beginDictation()` in `stream.ts`, 2 lines" | must wrap `onFinal` `:278-388` in `try/finally`, scoped to finalize+cleanup (its own comment `:299-300`) | **✗ corrected in shape:** 2 adjacent lines around the connection would starve meeting jobs (§2.6) |
| 22 | cloud 2 / local 1 lane concurrency | precedent already in-tree: `transcriber.ts:175-178` | not a correction — an upgrade: the numbers are already proven here, cite them instead of proposing them |
| 23 | "`MAX_SUMMARIZE_CALLS = 24`, deadline `perCall × (N+1) × 1..2` clamped `[2×call, 4h]`" | derived against `summarize.ts:33/61/67-68/309-327` and `settings.ts:185-186/189-190`; 4 h clamp binds at `plannedCalls = 24` with default 600 s; typical single-pass lands on the 2× floor | arithmetic shown in §5.8; **the token/hour input is an UNVERIFIED estimate**, so 24 ships as a loud guard, not a silent truncation |
