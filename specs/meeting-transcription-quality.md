# Meeting Transcription Quality — Implementation Spec

Implementation spec for three phases of transcription-quality fixes in Meeting
Mode, grounded in a real-audio investigation of meeting
`9df09e73-07c1-4e66-8d05-531e7eb27a10` (a WhatsApp PT call, provider
`omlx`/Qwen3-ASR) on 2026-08-27. Companion to
[`meeting-mode.md`](meeting-mode.md) and
[`meeting-diarization.md`](meeting-diarization.md) — read those first, this
spec assumes their architecture (mic/system channel split, `meeting_segments`,
`merge.ts`, `SCHEMA_VERSION = 30` with `speaker_label` already landed) as
given and only describes the delta. File:line citations below are as read on
2026-08-27; the codebase moves fast, re-verify before implementing.

---

## 1. What the investigation found

Six independent defects, all reproduced against the real meeting above:

1. **Vocab leak.** The vocabulary-bias prompt (`vocabulary-bias.ts`:
   `PROMPT_CHAR_BUDGET = 900` at line 15, `buildAsrVocabularyBias` builds it
   per-request, capped at 900 chars) is sent as the ASR `prompt`/`context`
   field on **every** chunk, including 1-3 second ones, and the model echoes
   it back as fake speech on low-signal audio: 14 occurrences in this one
   meeting, including all 80 vocabulary terms "spoken" in a 1.7s system-
   channel segment (idx 37) and three consecutive full leaks on the mic
   channel (idx 53-55).

   The investigation's original finding cited `whisper-local.ts:76-78` as the
   send site. That line is real and has the identical bug (the
   `local-whisper`/whisper.cpp provider), but it is not what meeting
   `9df09e73` actually used. The verified send site for this meeting's
   provider is `apps/server/src/lib/streaming/providers/omlx.ts:70-72`:

   ```ts
   if (opts.bias?.kind === "prompt") {
     form.append("prompt", opts.bias.text);
   }
   ```

   A third site carries the same prompt under a different field name —
   `mlx-local.ts:48` and `:70` pass it as `context` instead of `prompt`. Three
   send sites, one bug family, because `vocabulary-bias.ts` builds one
   `{ kind: "prompt", text }` value for every local/on-device provider
   (`local-whisper`, `local-mlx`, `omlx` all hit the same `buildPromptText`/
   `omlx` branch at lines 127-133 and 178-185) and each provider file just
   forwards it under its own field name. This is exactly why §3's fix sits at
   the shared **persist** layer instead of patching three call sites
   individually — see §3.

2. **Language pinned wrong for a multi-language user.**
   `createDefaultTranscriberDeps().resolveConfig()`
   (`apps/server/src/lib/meetings/transcriber.ts:459`):

   ```ts
   const language = getLanguagesSetting()[0];
   ```

   The user's `languages` setting was `["en", "pt"]`. `resolveConfig` takes
   index `[0]` unconditionally, so `language: "en"` was pinned on every chunk
   of a Portuguese call — every secondary declared language is silently
   discarded. Pinning the wrong language doesn't fail loudly: the model
   **translates** instead of transcribing, producing fluent-looking English
   with Portuguese sentence structure leaking through ("the sandbox of him"
   for "a caixinha dele") — a translation defect that reads as a
   transcription defect until you already know to suspect it. An **empty**
   `languages` setting is not part of this bug: `getLanguagesSetting()`
   returns `[]`, `[0]` is `undefined`, `resolveConfig` omits `language`
   entirely (`...(language ? { language } : {})`), and every chunk gets
   independent per-chunk auto-detection — correct, existing behavior, left
   alone by this spec.

3. **Empty results are indistinguishable from real "ok" transcriptions.**
   `transcribeChunk` (`transcriber.ts:388-395`) always returns
   `status: "ok"`, even when `result.text` is empty. A silent chunk and a
   successfully-transcribed chunk look identical in `meeting_segments`.

4. **Chunking produces many tiny, anchorless segments.**
   `DEFAULT_SEGMENTER_OPTIONS` (`segmenter.ts:39-51`): 20ms analysis frames,
   +9dB open / +6dB close hysteresis, 700ms hangover, segments under 250ms
   discarded, gaps under 2000ms coalesced, hard 30s force-split. This is a
   pure energy-gate VAD with **no upward merging** — WhisperX-style best
   practice is VAD-then-merge-toward-~25s (ablation-proven lower WER; short
   isolated chunks starve the model of context and are exactly the chunks
   most prone to finding #1's leak, since a 900-char prompt dominates a 1-3s
   clip's effective context).

5. **No cross-chunk context, no LLM cleanup on meetings.** Dictation has an
   LLM cleanup pass (`routes/transcribe.ts:199-205`, `postProcess(rawText,
   appContext, { languages: effectiveLanguages, source: "batch" })`); meeting
   transcription has nothing equivalent. `merge.ts`'s hallucination/repeat
   filters (§ below) are rule-based and read-time only — `loadMergedTranscript`
   (`routes/meetings.ts:194-216`) re-runs them on every read; they never
   correct or persist a cleaned segment.

6. **Meetily's "Enhance" is not a quality bar worth copying.** Its enhance is
   plain re-transcription with a different model/language, no LLM pass — this
   codebase already has that (re-transcribe / retry-failed). What meetings
   are actually missing is the LLM cleanup pass dictation already has (#5).
   Phase C below is that pass, not a re-implementation of Meetily's.

7. **Interleaving defect (documented, not fixed here).** Mic and system are
   segmented independently; a long mic chunk can wedge between two halves of
   one system-channel sentence in the merged, interleaved view. Non-goal —
   see §7.

---

## 2. Where these land in the pipeline

```
segmentPcm(mic.wav)  ──┐                                    ┌──▶ meeting_segments
                        │                                    │      (source='mic')
                        ├─▶ Phase B: post-VAD merge ─▶ MeetingTranscriber.run()
                        │      (§5, new)                     │      persistChunk()
segmentPcm(system.wav)─┘                                    └──▶ meeting_segments
                                                                     (source='system')
                              ▲                    ▲
                    Phase A2: resolveMeetingLanguage()   Phase A3/A4: per-chunk bias-skip +
                    (§4, wraps resolveConfig            empty-status (transcriber.ts)
                     once per job, §4.3)

meeting_segments ──▶ persistChunk(): Phase A1 leak filter (§3.1, new data)
                          │
                          ▼
              status='transcribed' ──▶ Phase C: /:id/enhance (§6, new, on-demand
                          │                        or auto behind a setting)
                          ▼                        writes meeting_segments.enhanced_text
              loadMergedTranscript() ──▶ mergeTranscript()
                          │              Phase A1 leak filter (§3.2, backstop for
                          │              pre-Phase-A rows still status='ok')
                          ▼
                  renderer: raw/enhanced toggle (§6)
```

---

## 3. Phase A — stop the bleeding

### 3.1 A1 — vocab-leak filter, persist time

New export from `apps/server/src/lib/meetings/merge.ts` (the existing home
for text-quality filters — `isHallucination`, `filterConsecutiveRepeats`,
`normalizeText` all already live there; a leak filter is the same kind of
function and reuses `normalizeText` directly with no new cross-module
import):

```ts
/** Fraction of the segment's distinct words that are vocabulary words. */
export const VOCAB_LEAK_OVERLAP_THRESHOLD = 0.6;

/**
 * True when a transcript segment looks like the model echoed the
 * vocabulary-bias prompt back as fake speech, instead of transcribing real
 * audio. Provider-agnostic by design: the same 900-char prompt is sent as
 * `prompt` (omlx.ts:70-72, whisper-local.ts:76-78) or `context`
 * (mlx-local.ts:48,70) depending on provider, but the leak always shows up
 * the same way on the *output* side — a segment whose words are
 * overwhelmingly drawn from the vocabulary list, which real speech is not.
 * Strips the "Terms: " / "Technical terms: " prompt-boilerplate prefixes
 * (vocabulary-bias.ts:55,180) before comparing, so a leak that echoes the
 * label too still matches on content, not the label.
 */
export function isVocabLeak(text: string, vocabTerms: string[]): boolean {
  if (vocabTerms.length === 0) return false;
  const norm = normalizeText(text).replace(/^(technical )?terms\s*/, "");
  const textTokens = new Set(norm.split(" ").filter(Boolean));
  if (textTokens.size === 0) return false;
  const termTokens = new Set(
    vocabTerms.flatMap((t) => normalizeText(t).split(" ")).filter(Boolean),
  );
  if (termTokens.size === 0) return false;
  let matched = 0;
  for (const tok of textTokens) if (termTokens.has(tok)) matched++;
  return matched / textTokens.size >= VOCAB_LEAK_OVERLAP_THRESHOLD;
}
```

**Persist time** (new data): `persistChunk` (`routes/meetings.ts:238-255`)
gains a `vocabTerms: string[]` parameter, loaded once per job (not per
chunk — vocabulary rarely changes mid-meeting and `loadVocabularyTerms()`
hits the DB):

```ts
function persistChunk(
  meetingId: string,
  chunk: ChunkResult,
  vocabTerms: string[],
): void {
  const leaked =
    chunk.status === "ok" && chunk.text && isVocabLeak(chunk.text, vocabTerms);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO meeting_segments
         (id, meeting_id, source, idx, start_ms, end_ms, text, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${meetingId}:${chunk.source}:${chunk.idx}`,
      meetingId,
      chunk.source,
      chunk.idx,
      chunk.startMs,
      chunk.endMs,
      leaked ? null : chunk.text,
      leaked ? "filtered" : chunk.status,
    );
}
```

Call sites, both loading `loadVocabularyTerms()` (`lib/vocabulary.ts`, already
exists) once and threading it through:

- `runTranscribeJob` (`routes/meetings.ts:283`): `onChunk: (chunk) =>
  persistChunk(id, chunk, vocabTerms)`.
- `POST /:id/retry-failed` (`routes/meetings.ts:525-533`): the `update.run(...)`
  call gains the same leak check before writing `chunk.text`/`chunk.status`.

`'filtered'` is a new value for `meeting_segments.status`. No migration
needed — the column is a bare `status TEXT` with **no `CHECK` constraint**
(`schema.ts:785`), unlike `meetings.status`, which does have one
(`schema.ts:765-768`) and which this spec does not touch.

**Read time** (backstop for rows persisted before this ships, still
`status='ok'` with leaked text baked in): `mergeTranscript` gains a fourth,
optional parameter, **appended** so the existing three-positional-argument
call sites in `meeting-merge.test.ts` keep working unchanged:

```ts
export function mergeTranscript(
  micSegments: TranscriptSegment[],
  systemSegments: TranscriptSegment[],
  syncData?: SyncData,
  vocabTerms?: string[],
): MergedSegment[] {
  const { mic, system } = applyDrift(micSegments, systemSegments, syncData);

  const clean = (segs: TranscriptSegment[]) =>
    filterConsecutiveRepeats(
      segs.filter(
        (s) => !isHallucination(s) && !isVocabLeak(s.text, vocabTerms ?? []),
      ),
    );
  // ... unchanged below
```

Order matters and is deliberate: the leak filter runs **inside the same
`.filter()`** as the hallucination filter, both *before*
`filterConsecutiveRepeats`. It must not run after — three of the
investigation's leaks were consecutive near-identical segments (mic idx
53-55), and `filterConsecutiveRepeats`'s `REPEAT_MIN_RUN = 3`
(`merge.ts:71`) would otherwise collapse that run to a single surviving
leaked segment instead of dropping all three. Filtering leaks first removes
them before the repeat-collapse ever sees them.

`loadMergedTranscript` (`routes/meetings.ts:194-216`) passes
`loadVocabularyTerms()` for the new fourth argument. This is a best-effort
backstop, not a permanent record: it checks a segment's text against the
**current** vocabulary list, not whatever the vocabulary was at transcription
time (that value was never persisted per-chunk before this spec, and isn't
retroactively recoverable). A user who has since deleted the leaked term from
their vocabulary would stop being protected by this backstop for that old
segment — acceptable, since Phase A1's persist-time fix (which does capture
the vocabulary as it was) is what protects every meeting transcribed after
this ships.

**`loadMergedTranscript`'s existing filter needs no change.** It already
does `r.status === "ok" && r.text` (`routes/meetings.ts:207`) — a `'filtered'`
row has `status='filtered'` and `text=NULL`, so it fails both conditions
without any new code; the same is true of A4's `'empty'` status below (§3.4).

**False positives, accepted and documented.** A user who reads several
vocabulary terms aloud in a row in a short segment will trip
`isVocabLeak` — token overlap can't distinguish "genuinely said the words"
from "the model made the words up." This is a deliberate false-positive/
false-negative tradeoff: the threshold (0.6) is a low bar chosen from this
investigation's actual leak evidence (the observed leaks were near-100%
vocabulary-word segments); a real leak fires reliably, a real sentence that
merely *mentions* one or two vocab terms among normal words does not. Ship
with 0.6, revisit if real-world false positives show up in practice.

### 3.2 A2 — meeting-level language resolution

New file `apps/server/src/lib/meetings/language.ts`, importing
`waitForDictationIdle` (`dictation-activity.ts`) and `WHISPER_PROVIDER_ID`
(`whisper/constants.ts`) — the same two imports `transcriber.ts` already
uses for the identical yield check (line 370-378 below).

**Decision.** Resolution runs **once per meeting**, not once per job run:
once `meetings.language` is set (by this resolver, or by the user editing
the chip, §3.2.4), every later job — including re-transcribe — reuses it
without re-probing. This is the same "sticky once decided" contract
`speaker_label` doesn't have (diarization re-runs per explicit request) but
language *should* have, because unlike diarization, language rarely changes
meeting-to-meeting for the same user and a wrong guess is directly fixable
by hand.

```ts
export async function resolveMeetingLanguage(input: {
  meetingId: string;
  audioDir: string;
  provider: TranscriptionProvider;
  config: Pick<SttConfig, "providerId" | "modelId" | "apiKey">;
  micSegments: Segment[];
  systemSegments: Segment[];
  /** Same dictation-yield lease `MeetingTranscriber` uses (transcriber.ts:370-378). */
  isDictationActive?: () => boolean;
}): Promise<string | undefined> {
  const existing = readMeetingLanguage(input.meetingId);
  if (existing) return existing;

  const declared = getLanguagesSetting();
  if (declared.length === 0) return undefined; // unchanged: per-chunk auto
  if (declared.length === 1) {
    persistMeetingLanguage(input.meetingId, declared[0]);
    return declared[0];
  }

  const probe = pickProbeSegment(input.micSegments, input.systemSegments);
  const fallback = declared[0]; // first-declared wins when detection can't decide
  if (!probe) {
    log.warn(`meeting ${input.meetingId}: no probe segment available, defaulting to ${fallback}`);
    persistMeetingLanguage(input.meetingId, fallback);
    return fallback;
  }

  let text = "";
  try {
    if (input.config.providerId === WHISPER_PROVIDER_ID) {
      // Same shared-ANE-resource yield contract as every other whisper-local
      // call in this pipeline (meeting-diarization.md §11) — the probe is
      // one more transcription call and must not fire mid-dictation.
      await waitForDictationIdle({ isDictationActive: input.isDictationActive });
    }
    const audio = sliceProbeAudio(input.audioDir, probe);
    const result = await input.provider.transcribe({
      audio,
      model: input.config.modelId,
      apiKey: input.config.apiKey,
      language: undefined, // auto — the whole point is to observe what the model does unpinned
      bias: null,           // never bias the probe: vocabulary words would skew language ID
    });
    text = result.text.trim();
  } catch (err) {
    log.warn(`meeting ${input.meetingId}: language probe failed, defaulting to ${fallback}: ${String(err)}`);
  }

  const resolved = text ? pickDeclaredLanguage(text, declared) ?? fallback : fallback;
  persistMeetingLanguage(input.meetingId, resolved);
  return resolved;
}
```

#### 3.2.1 Provider confidence doesn't exist — use text-based LID instead

`TranscribeResult` (`streaming/types.ts:40-48`) has no `language` or
`confidence` field — omlx and every other batch provider in this codebase
return `{ text, segments?, durationInSeconds? }` only. The two alternatives
the task brief offered ("run each declared language over one probe segment
and pick higher avg confidence" vs. "fall back to text-based language ID")
collapse to one option for an OpenAI-compatible endpoint that returns no
confidence at all: **text-based LID on a single auto-language probe
transcription**, not N per-language probes. One extra STT call per meeting
(not one per declared language) — cheaper, and simpler.

Library: **`tinyld`** (`npm view tinyld`: pure JS, zero dependencies,
~12MB unpacked, 62 languages, outputs ISO-639-1 directly — matching this
codebase's language codes with no mapping layer, unlike `franc`'s ISO-639-3
output which would need one). `detectAll(text)` returns ranked candidates:

```js
detectAll('ceci est un text en francais.')
// [ { lang: 'fr', accuracy: 0.5238 }, { lang: 'ro', accuracy: 0.3802 }, ... ]
```

No confirmed way to *constrain* `detectAll` to a candidate list in the
published API — so `pickDeclaredLanguage` ranks over the **full** result and
picks the highest-ranked entry that's in the user's declared set, rather than
assuming an `only`-style option exists:

```ts
function pickDeclaredLanguage(text: string, declared: string[]): string | null {
  const ranked = detectAll(text);
  const hit = ranked.find((r) => declared.includes(r.lang));
  return hit?.lang ?? null;
}
```

**Before merging**: verify `tinyld`'s 62-language set actually covers every
code in `ISO_LANGUAGE_NAMES` (`lib/language.ts:4-35`, ~30 codes) — this spec
assumes coverage based on the library's stated language count but that's not
the same as confirming every specific code (e.g. `mk` Macedonian is a less
common target for LID libraries); add a one-time coverage check as an
implementation task, not assumed here.

#### 3.2.2 Probe segment selection

```ts
function pickProbeSegment(
  mic: Segment[],
  system: Segment[],
): { source: "mic" | "system"; startMs: number; endMs: number } | null {
  const EARLY_COUNT = 10;
  const MIN_PROBE_MS = 1000;
  const candidates = [
    ...mic.slice(0, EARLY_COUNT).map((s) => ({ source: "mic" as const, ...s })),
    ...system.slice(0, EARLY_COUNT).map((s) => ({ source: "system" as const, ...s })),
  ];
  if (candidates.length === 0) return null;
  const long = candidates.filter((c) => c.endMs - c.startMs >= MIN_PROBE_MS);
  const pool = long.length > 0 ? long : candidates; // permissive: use whatever exists
  return pool.reduce((best, c) =>
    c.endMs - c.startMs > best.endMs - best.startMs ? c : best,
  );
}
```

`sliceProbeAudio` opens the relevant `mic.wav`/`system.wav` under `audioDir`
and reuses `parseWavHeader`/`sliceWav`, already exported from
`transcriber.ts` — no new WAV-parsing code.

#### 3.2.3 Storage: `meetings.language`

Migration 31 (next after diarization's 30):

```ts
if (currentVersion < 31) {
  // Meeting transcription quality Phase A2: resolved (or user-set)
  // transcription language for the meeting, pinned once and reused by every
  // later job for the same meeting (including re-transcribe) until the user
  // edits it. NULL means "not yet resolved" (falls back to per-chunk auto,
  // or triggers resolution on the next transcribe run).
  db.exec(`ALTER TABLE meetings ADD COLUMN language TEXT`);
}
```

#### 3.2.4 Pipeline wiring — wrap `resolveConfig`, don't widen it

`TranscriberDeps.resolveConfig` (`transcriber.ts:61`) is synchronous:
`() => SttConfig`. `resolveMeetingLanguage` needs to await a probe
transcription and a DB round-trip, and it needs the already-segmented audio,
which only exists inside `runTranscribeJob` after `segmentPcm`. Two ways to
thread the result in: make `resolveConfig` return a `Promise<SttConfig>` (a
signature change touching `MeetingTranscriber.run()` at `transcriber.ts:270`
and every test in `meeting-transcriber.test.ts` that constructs a
`TranscriberDeps`), or resolve the language once in `runTranscribeJob` and
hand `MeetingTranscriber` a **wrapped** `resolveConfig` that already knows
the answer. The wrap is the smaller, lower-risk change — same "extend, don't
widen" reasoning `meeting-diarization.md` §6 applies to `Speaker`:

```ts
// routes/meetings.ts, inside runTranscribeJob, replacing the current
// `const config = deps.resolveConfig();` block (line 288):
const config = deps.resolveConfig();
db.prepare(
  "UPDATE meetings SET stt_provider = ?, stt_model = ? WHERE id = ?",
).run(config.providerId, config.modelId, id);

const provider = deps.getProvider(config.providerId);
const resolvedLanguage = provider
  ? await resolveMeetingLanguage({
      meetingId: id,
      audioDir,
      provider,
      config,
      micSegments,
      systemSegments,
      isDictationActive,
    }).catch((err) => {
      log.warn(`meeting ${id}: language resolution failed, using unpinned default: ${String(err)}`);
      return config.language;
    })
  : config.language;

// The object passed to `new MeetingTranscriber(...)` below is what
// `MeetingTranscriber.run()` calls `this.deps.resolveConfig()` on
// (transcriber.ts:270) — replacing the property on this object, not on a
// copy made afterward, is what makes the wrap take effect.
const effectiveDeps: TranscriberDeps = {
  ...deps,
  resolveConfig: () => ({ ...config, language: resolvedLanguage }),
};

const results = await new MeetingTranscriber(effectiveDeps).run({
  meetingDir: audioDir,
  micSegments,
  systemSegments,
});
```

`resolveConfig`'s own body (`transcriber.ts:459`,
`getLanguagesSetting()[0]`) is **left as-is** — it's still what dictation and
every non-meeting caller use unmodified, and it's still what
`resolveMeetingLanguage` falls back to when `provider` can't be resolved
(same "unsupported provider" error already surfaces normally once
`effectiveDeps.resolveConfig()` is called with the untouched `config.language`).
`POST /:id/retry-failed` (`routes/meetings.ts:490-551`) gets the lighter
version of the same wrap — it reuses the already-resolved `meetings.language`
(from the `MeetingRow` it already `SELECT *`s) with **no re-probe** (retrying
a handful of failed chunks doesn't warrant a fresh language decision):

```ts
const deps = row.language
  ? { ...baseDeps, resolveConfig: () => ({ ...baseDeps.resolveConfig(), language: row.language! }) }
  : baseDeps;
```

#### 3.2.5 UI: editable language chip

`PATCH /api/meetings/:id` (`routes/meetings.ts:415-424`) currently renames
only. Extend `renameSchema` with an optional `language`:

```ts
const renameSchema = z.object({
  title: z.string().trim().min(1).max(512).optional(),
  language: z.string().trim().min(2).max(8).nullable().optional(),
});
```

and the handler runs whichever `UPDATE`s the body actually supplied (title,
language, or both) — the chip in `meetings.tsx` calls this with `{ language:
code }` when the user edits it, and re-transcribe/retry-failed always read
whatever is currently stored (§3.2.4), so an edit takes effect on the next
run with no other wiring. `MeetingRow` (`routes/meetings.ts:343-355`) also
gains `language: string | null;` — it's a `SELECT *` result, so the column
is already present at runtime once migration 31 lands; the interface needs
the field too or §3.2.4's `row.language` access doesn't compile.

### 3.3 A3 — skip the vocabulary prompt on short chunks

`transcriber.ts`, private `transcribeChunk` (lines 357-415), the
`provider.transcribe(...)` call at line 380-387:

```ts
const MIN_BIAS_DURATION_MS = 3000;
// ...
const audio = sliceWav(fd, info, seg.startMs, seg.endMs);
const durationMs = seg.endMs - seg.startMs;
const bias = durationMs < MIN_BIAS_DURATION_MS ? null : config.bias;
const result: TranscribeResult = await provider.transcribe({
  audio,
  model: config.modelId,
  apiKey: config.apiKey,
  ...(config.language ? { language: config.language } : {}),
  bias,
});
```

Single touchpoint: `MeetingTranscriber.transcribeChunk` is the only place a
per-chunk `Segment` (with real duration) and the resolved bias both exist
together, and it's shared by both `runTranscribeJob` and
`POST /:id/retry-failed` (both go through `MeetingTranscriber.run()`), so
this fixes both call paths with one change. Directly addresses finding #1's
worst case (the 1.7s, 80-term, 900-char-prompt segment): a 1.7s clip never
gets a bias prompt at all under this threshold.

### 3.4 A4 — empty results get their own status

Same function, the success-return path (lines 388-395):

```ts
const text = result.text.trim();
return {
  source,
  idx,
  startMs: seg.startMs,
  endMs: seg.endMs,
  text,
  status: text.length === 0 ? "empty" : "ok",
};
```

`ChunkResult.status` (`transcriber.ts:39`) widens from `"ok" | "failed"` to
`"ok" | "failed" | "empty"` — `"filtered"` is **not** added here; it's only
ever assigned by `persistChunk`/the retry-failed update (§3.1), never by the
transcriber itself, since leak detection needs the vocabulary list the
transcriber doesn't have. `'empty'` rows are correctly excluded from
`retry-failed`'s `WHERE status = 'failed'` (`routes/meetings.ts:506`) — an
empty chunk is legitimate silence, not a failure, and must not be
auto-retried.

---

## 4. Phase A — failure modes

| Condition | Behavior |
|---|---|
| Leak filter false-positives on real speech that happens to name several vocab terms | Segment's text is dropped/nulled; accepted, documented (§3.1). |
| Language probe transcription throws (provider error) | Caught, falls back to `declared[0]`, logged, never fails the job. |
| Language probe produces empty text | Same fallback. |
| No segment available to probe (silent recording, `declared.length > 1`) | Same fallback, logged. |
| `tinyld` returns no candidate from the declared set at all | Same fallback (`pickDeclaredLanguage` returns `null` → `?? fallback`). |
| `declared.length === 0` (no languages configured) | Unchanged existing behavior: no pin, full per-chunk auto-detect; nothing written to `meetings.language`. |
| `meetings.language` already set | Short-circuit, no probe, no re-detection — sticky until the user edits the chip. |
| `deps.getProvider(config.providerId)` returns `null` | Language resolution skipped entirely; the existing "Unsupported transcription provider" error still fires normally downstream. |
| Segment shorter than 3s | No bias sent, regardless of provider. |
| Transcription result is empty text | `status: 'empty'`, not `'ok'`; never auto-retried. |

None of Phase A's failure paths throw past `runTranscribeJob`'s existing
top-level `try`/`catch` (`routes/meetings.ts:266-341`) or leave a meeting
stuck in a non-terminal status.

---

## 5. Phase B — post-VAD segment merging

**Problem restated**: `segmentPcm` (`segmenter.ts:227-262`) is a pure
energy-gate VAD with a 30s **force-split ceiling** but no **target-size
merge** — a burst of short utterances separated by >2000ms gaps (the
`coalesceGapMs` threshold) never gets coalesced further, producing many
sub-5s segments that starve the model of context and round-trip the oMLX
server once per fragment.

**Fix**: a new merge pass, run **after** `segmentPcm` returns, **not** a
change to the VAD gate parameters themselves (`openThresholdDb`,
`closeThresholdDb`, `hangoverMs`, etc. are untouched — this is purely a
post-processing step over already-detected segment boundaries):

```ts
// segmenter.ts, new export
export interface MergeTowardOptions {
  /** Target segment length (ms) — merging stops once a segment reaches this. */
  targetMs: number;
  /** Never bridge a gap wider than this (ms) — a real pause stays a pause. */
  maxGapMs: number;
  /** Hard cap — matches segmentPcm's existing maxSegmentMs default. */
  maxSegmentMs: number;
}

export const DEFAULT_MERGE_TOWARD_OPTIONS: MergeTowardOptions = {
  targetMs: 22_500, // midpoint of the ~20-25s WhisperX-style target
  maxGapMs: 4000,
  maxSegmentMs: DEFAULT_SEGMENTER_OPTIONS.maxSegmentMs, // 30_000, single source of truth
};

/**
 * Greedily merge adjacent same-channel segments toward `targetMs`, never
 * crossing a gap wider than `maxGapMs` and never exceeding `maxSegmentMs`.
 * Input must already be time-ordered (segmentPcm's output is).
 */
export function mergeSegmentsToward(
  segments: Segment[],
  opts: Partial<MergeTowardOptions> = {},
): Segment[] {
  const o = { ...DEFAULT_MERGE_TOWARD_OPTIONS, ...opts };
  if (segments.length === 0) return [];
  const out: Segment[] = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    const last = out[out.length - 1];
    const next = segments[i];
    const gap = next.startMs - last.endMs;
    const merged = next.endMs - last.startMs;
    if (
      gap <= o.maxGapMs &&
      merged <= o.maxSegmentMs &&
      last.endMs - last.startMs < o.targetMs
    ) {
      last.endMs = next.endMs;
    } else {
      out.push({ ...next });
    }
  }
  return out;
}
```

Call site: `runTranscribeJob` (`routes/meetings.ts:274-277`):

```ts
const micSegments = mic
  ? mergeSegmentsToward(segmentPcm(mic.pcm, mic.sampleRate))
  : [];
const systemSegments = system
  ? mergeSegmentsToward(segmentPcm(system.pcm, system.sampleRate))
  : [];
```

Per-channel only (mic never merges with system) — matches every other stage
of this pipeline (segmentation, transcription, drift correction all operate
per channel before `mergeTranscript` interleaves).

**Interaction with A3.** Merging *reduces* the number of chunks that fall
under A3's 3-second bias-skip threshold — a good thing (more chunks get
vocabulary bias where it actually helps, since they're no longer starved of
context), and is the expected mechanism behind "fewer tiny anchorless
chunks, fewer oMLX round-trips" the acceptance test checks for (§8).

**Interaction with drift correction.** `applyDrift` (`merge.ts:212-243`)
operates on whatever segments arrive with whatever timestamps — merging
before transcription only changes *which* timestamps exist, not how drift
correction treats them; no change needed there.

---

## 6. Phase C — Enhance (LLM transcript cleanup)

**Not** Meetily's "enhance" (finding #6) — that's re-transcription with a
different model, which this codebase already has via re-transcribe and
retry-failed. This Enhance is the LLM cleanup pass meetings are missing
relative to dictation (`routes/transcribe.ts:199-205`).

### 6.1 Storage

Migration 32 (separate from 31 — Phase A and Phase C ship independently):

```ts
if (currentVersion < 32) {
  // Meeting transcription quality Phase C: LLM-corrected segment text,
  // separate from `text` so the raw ASR output is never destroyed. NULL
  // means "not enhanced" (or Enhance ran and left this segment unchanged —
  // the LLM's JSON response omits unchanged segments, §6.3).
  db.exec(`ALTER TABLE meeting_segments ADD COLUMN enhanced_text TEXT`);
}
```

`merge.ts`'s `TranscriptSegment`/`MergedSegment` get the same
extend-don't-widen treatment `speakerLabel` already got
(`meeting-diarization.md` §6) — **and** a stable `id`, which Enhance needs to
map LLM corrections back to rows and which `speakerLabel` never needed:

```ts
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;
  id?: string;            // NEW — meeting_segments.id, e.g. "<meetingId>:system:12"
  enhancedText?: string;  // NEW — meeting_segments.enhanced_text
}

export interface MergedSegment {
  speaker: Speaker;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;
  id?: string;            // NEW — passed through unchanged, field copy only
  enhancedText?: string;  // NEW — passed through unchanged, field copy only
}
```

`loadMergedTranscript`'s `SELECT` (`routes/meetings.ts:200-202`) adds `id,
enhanced_text`; both are optional field copies through `mergeTranscript`,
same as `speakerLabel` — no new logic in the merge/sort/dedup pipeline.

### 6.2 Input

Speaker-labeled merged transcript (`Me`/`Them N`/`Them`, same formatting
`formatTranscriptMarkdown` already uses) + the meeting's resolved language
(`meetings.language`, §3.2) + the vocabulary list **as reference, not as a
biasing prompt** (`loadVocabularyEntries()`, same source as ASR bias, but
here it's telling the LLM "these are the correct spellings/terms if you see
something close," not being echoed into a low-signal ASR pass — no leak risk
symmetric to §3.1, since this pass runs over a full completed transcript with
real content, not a 1-3s silence-adjacent clip).

**Meeting context — not available.** The task brief asks for "meeting
context if present." No such field exists: `meetings` has no `context`/
`app_context` column (verified against `schema.ts:759-775`) — the recorder
never captured one. Phase C's prompt therefore takes exactly three inputs:
transcript, language, vocabulary. Adding meeting context is future work
requiring its own migration and its own capture point (likely the same
`app_context` mechanism dictation already uses,
`sonioxGeneralFromAppContext` in `transcribe-bias.ts:164-182`, applied to
meetings) — out of scope here, not silently dropped.

### 6.3 LLM call

New file `apps/server/src/lib/meetings/enhance.ts`, modeled directly on
`summarize.ts`'s `defaultLlmCall` (lines 162-217): same `createChatModel`/
`getLlmProvider().providerOptions`/`postProcess` wrapper, same pricing
lookup. Rather than duplicate that ~55-line wiring a second time, **extract**
it: `summarize.ts`'s `defaultLlmCall` becomes a thin wrapper around a new
shared `resolveDefaultChatCall(system, prompt, maxOutputTokens):
Promise<SummaryLlmResponse>`-shaped helper (new `apps/server/src/lib/
meetings/llm-call.ts`), reused by both `summarize.ts` and `enhance.ts` — a
refactor of existing code, not a new redundant copy.

Output contract: **strict JSON**, corrected segments only, unchanged
segments omitted (keeps output size proportional to what actually needs
fixing, not to transcript length):

```
{ "<segment id>": "<corrected text>", ... }
```

Long transcripts **map, don't map-reduce**: reuse `chunkTranscript`-style
token-budget chunking (`summarize.ts:115-154`) to split into whole-segment
chunks, run the enhance prompt once per chunk independently, and union the
resulting id→text maps — no reduce step, because unlike summarization,
per-chunk corrections don't need combining (each chunk's segment ids are
disjoint by construction). A parse failure on one chunk is logged and
skipped, not fatal to the rest — raw `text` stays authoritative for every
segment the pass couldn't safely correct.

```ts
export async function enhanceMeetingTranscript(
  meetingId: string,
  segments: MergedSegment[], // must carry `id`
  language: string | undefined,
  vocabTerms: string[],
): Promise<{ correctedCount: number }> {
  const withIds = segments.filter((s) => s.id && s.text.trim());
  if (withIds.length === 0) return { correctedCount: 0 };

  const chunks = chunkForEnhance(withIds, CONTEXT_BUDGET_TOKENS);
  const corrections = new Map<string, string>();
  for (const chunk of chunks) {
    const raw = await callEnhance(chunk, language, vocabTerms); // JSON text
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(`meeting ${meetingId}: enhance chunk parse failed, skipping: ${String(err)}`);
      continue;
    }
    const validIds = new Set(chunk.map((s) => s.id));
    for (const [id, text] of Object.entries(parsed)) {
      if (validIds.has(id) && typeof text === "string") corrections.set(id, text);
    }
  }

  const update = getDb().prepare(
    "UPDATE meeting_segments SET enhanced_text = ? WHERE id = ?",
  );
  const tx = getDb().transaction((entries: [string, string][]) => {
    for (const [id, text] of entries) update.run(text, id);
  });
  tx([...corrections.entries()]);
  return { correctedCount: corrections.size };
}
```

### 6.4 Route: `POST /api/meetings/:id/enhance`

Same shape as `/:id/diarize` and `/:id/summarize` — in-request, not a
background job:

1. 404 if the meeting doesn't exist.
2. 409 (`"Meeting has no transcript to enhance"`) unless `status` is
   `'transcribed'` or `'summarized'` — same precondition as `/summarize` and
   `/diarize`.
3. 409 if `activeJobs.has(id)` — same shared concurrency map.
4. 409 (`"Transcript is empty"`) if the merged transcript has zero segments
   with text — same check `/summarize` already does.
5. Runs `enhanceMeetingTranscript(id, merged, meeting.language ?? undefined,
   loadVocabularyTerms())`.
6. Response: `{ ok: true, correctedCount }`.
7. Failure: caught, 500, logged — `enhanceMeetingTranscript` only ever
   `UPDATE`s `enhanced_text` on existing rows (never `DELETE`s/`INSERT`s), so
   a failure mid-pass can't corrupt `text` or a previous Enhance run's
   corrections, same non-destructive contract `/:id/diarize` has for
   `speaker_label`.
8. **Superseded by §6.8 (amended 2026-08-27) — see there.** On success,
   calls `writeTranscriptMarkdown(id, audioDir)`, but the original text
   below (which had `formatTranscriptMarkdown` render
   `s.enhancedText ?? s.text` into `transcript.md` itself) is reversed by
   the amendment: `transcript.md` stays the untouched raw ASR file, and
   the enhanced rendering goes to a second file, `transcript-enhanced.md`,
   instead. Original text, kept for context only, no longer the design:
   ~~`transcript.md` always reflects the meeting's best current text, not
   a stale pre-Enhance snapshot. `formatTranscriptMarkdown`
   (`merge.ts:309-323`) renders `s.enhancedText ?? s.text` instead of the
   bare `s.text` it renders today — the export doesn't distinguish
   enhanced from raw per line (no visual marker), matching how it already
   doesn't distinguish diarized from undiarized beyond the label itself.~~
   `/:id/diarize` does **not** gain a markdown-rewrite call — diarization
   only ever changes the speaker label, which markdown already renders
   correctly from `speaker_label` without a re-write; this is
   Enhance-specific because `text` itself is what's changing.

### 6.5 Auto-run setting

`settings-keys.ts`: `meetingEnhanceAutoRun: "meeting_enhance_auto_run"`,
alphabetically among the other `meeting*` keys. Server helper
`getMeetingEnhanceAutoRunSetting()` mirrors
`getMeetingDiarizationEnabledSetting()` exactly (`diarize.ts`'s pattern):
default **off**. Call site: `runTranscribeJob`, right after the diarization
step and before the `status = 'transcribed'` UPDATE (same placement
rationale as diarization — the UI never observes an intermediate
un-enhanced state when the setting is on), same fail-closed
`.catch((err) => log.warn(...))` wrapper that never fails the job.

### 6.6 UI

`meetings.tsx`: an "Enhance" action button next to "Identify speakers" and
"Re-transcribe" (same `hasTranscript` gate, same `runAction`/`invalidate`
pattern `identifySpeakers` already uses at lines 856-872). A raw/enhanced
toggle (local `useState`, not persisted — a per-session viewing preference,
not meeting state) switches the rendered `seg.text` for
`seg.enhancedText ?? seg.text` per segment, so a segment Enhance left
unchanged (omitted from its JSON response) still renders correctly in either
mode.

### 6.7 Non-goals of Phase C

- **No re-enhance on `retry-failed`.** A retried chunk's `enhanced_text`
  stays whatever it was (usually NULL, since it just got a fresh `text` from
  the retry) — same accepted-gap shape as diarization's retry-failed
  interaction (`meeting-diarization.md` §9's `/:id/retry-failed` note); the
  user re-runs Enhance manually afterward if they want it backfilled.
- **No meeting-context input** (§6.2) — no field exists to feed it.
- **Auto-run defaults off**, per the task brief, until real usage shows the
  cost (one more LLM call per meeting) is worth defaulting on.

### 6.8 On-disk artifacts (amended 2026-08-27)

> **USER DECISION — 2026-08-27 09:07.** Amends §6.4 point 8 above, which
> had Enhance rewrite enhanced text directly into `transcript.md`. That is
> reversed: the meeting folder instead carries **two** markdown artifacts,
> and `transcript.md` is never touched by Enhance.

1. **`transcript.md`** — the RAW ASR transcript, exactly as produced
   today. `writeTranscriptMarkdown` (`routes/meetings.ts`) must **never**
   write enhanced content into this file, regardless of which route
   triggers the write (Enhance included).
2. **`transcript-enhanced.md`** (naming per existing on-disk conventions)
   — same format as `transcript.md`, but rendered with
   `s.enhancedText ?? s.text` per segment (falling back to raw text for
   any segment Enhance left uncorrected). Written/rewritten every time an
   Enhance pass completes; does not exist until the first successful
   Enhance run.

`writeTranscriptMarkdown` is the natural place to extend for this: it
already owns the raw `transcript.md` write, and gains a sibling write path
for `transcript-enhanced.md` gated on enhanced content being present,
rather than either file's writer overloading the other's output.

Lifecycle: re-running Enhance overwrites only `transcript-enhanced.md`
(`transcript.md` is never touched by any Enhance run, matching the
`enhance.ts`/route contract in §6.3–6.4 of only ever `UPDATE`ing
`enhanced_text` — never `text` — in the DB). Deleting a meeting removes
both files, same as any other meeting-folder artifact.

Rationale: the raw transcript is immutable ground truth and must stay
recoverable/auditable independent of any LLM pass; the enhanced transcript
is a derived, regenerable artifact and is kept separate rather than
overwriting the source it was derived from.

---

## 7. Non-goals (all phases)

- **Cross-chunk context carry-over.** Each chunk is still transcribed
  independently; Phase C's cleanup pass sees the whole transcript after the
  fact, but nothing feeds forward *during* transcription. Future work.
- **Overlap-dedup of the interleaving defect** (finding #7) — a long mic
  chunk can still wedge between two halves of one system-channel sentence in
  the merged view. Documented, not fixed; Phase B's merge pass (§5) makes
  this somewhat less likely simply by producing fewer, longer chunks, but
  does not target it directly.
- **`/:id/transcribe`'s wholesale-replace semantics are unchanged.** It still
  deletes and re-inserts `meeting_segments` on every re-run (same as
  `meeting-diarization.md` §14's documented gap for `speaker_label`) — a
  re-transcribe loses `enhanced_text` and any leak-filter history for the
  segments it replaces, same as it already loses `speaker_label`.
- **Phase B does not retune the VAD gate.** `openThresholdDb`,
  `closeThresholdDb`, `hangoverMs`, `minSpeechMs` and the rest of
  `DEFAULT_SEGMENTER_OPTIONS` are untouched; Phase B is a merge pass appended
  after segmentation, not a re-tuning of segmentation itself.
- **No automatic vocabulary editing.** A1 filters leaked output; it never
  changes what's in the vocabulary list itself.

---

## 8. Test plan

**Unit — `isVocabLeak` (extend `vocabulary-bias.test.ts` or new
`meeting-vocab-leak.test.ts`):**

- Full echo of the "Terms: ..." prompt → leak.
- Full echo of the "Technical terms: ..." prompt (omlx/local-mlx variant) →
  leak, boilerplate-prefix stripped correctly.
- Partial leak (3+ consecutive vocab terms dominating a short segment) →
  leak.
- Real sentence naming one vocab term among ordinary words → not a leak
  (overlap ratio stays under 0.6).
- Empty `vocabTerms` → never a leak, regardless of text.

**Unit — `mergeTranscript` leak backstop (extend `meeting-merge.test.ts`):**

- A `TranscriptSegment` whose text matches the leak pattern is dropped from
  `mergeTranscript`'s output when `vocabTerms` is passed.
- Existing three-argument call sites (no `vocabTerms`) behave exactly as
  before — regression check that the new fourth parameter is additive.
- Filter-order regression: a synthetic run of 3 consecutive leak segments
  produces **zero** survivors (not one) — proves the leak filter runs before
  `filterConsecutiveRepeats`, not after.

**Unit — `resolveMeetingLanguage` (new `meeting-language.test.ts`, injected
provider/DB, no real network):**

- One declared language → pinned immediately, no probe call.
- Zero declared languages → `undefined`, `meetings.language` untouched.
- `meetings.language` already set → short-circuits, provider never called.
- Two declared languages, probe transcription returns text whose top
  `detectAll` match is in the declared set → that language wins.
- Probe transcription's top LID match is *not* in the declared set, but a
  lower-ranked candidate is → the declared candidate wins (proves
  `pickDeclaredLanguage` scans past the top match, not just index 0).
- Probe throws → falls back to `declared[0]`, logged, no throw escapes.
- No segments in either channel → falls back to `declared[0]`, no probe
  attempted.

**Unit — `mergeSegmentsToward` (new `meeting-segmenter-merge.test.ts` or
extend `segmenter.test.ts`):**

- A run of five 1s segments each 500ms apart merges into one ~7s segment
  (under target, gaps under `maxGapMs`).
- A gap wider than `maxGapMs` is never bridged, even if merging would stay
  under `targetMs`.
- A merge that would exceed `maxSegmentMs` stops instead — never produces a
  segment over the hard cap.
- Single-segment and empty-input edge cases return input unchanged.

**Unit — `enhanceMeetingTranscript` (new `meeting-enhance.test.ts`, injected
LLM call, matching `summarize.ts`'s `llmCall` injection pattern):**

- Well-formed JSON response with a subset of ids → only those rows'
  `enhanced_text` are written; omitted ids stay NULL.
- Malformed JSON on one chunk → that chunk's corrections are dropped, other
  chunks still commit (no `.catch` escapes past the chunk loop).
- A returned id not present in the chunk's input segments → discarded
  (guards against a hallucinated id corrupting an unrelated row).
- Zero segments with text → `{ correctedCount: 0 }`, no LLM call made.

**Integration — pipeline wiring (extend `meeting-transcriber.test.ts` /
`meetings-routes.test.ts`):**

- `persistChunk`'s leak check fires end-to-end with a fake provider that
  echoes the bias prompt on one chunk: that row lands `status='filtered'`,
  `text=NULL`; a normal chunk in the same run lands `status='ok'`.
- A chunk under 3s never receives `bias` in the fake provider's captured
  call args, regardless of `config.bias`.
- A chunk returning empty text lands `status='empty'`; `retry-failed`'s
  `WHERE status='failed'` selection does not include it.
- `runTranscribeJob` with two declared languages resolves and persists
  `meetings.language` once, and a second `runTranscribeJob` call (simulating
  re-transcribe) does not re-invoke the probe (spy assertion on the fake
  provider's call count).
- `POST /api/meetings/:id/enhance`: 404, 409 (no transcript), 409 (busy),
  409 (empty transcript), happy path (`enhanced_text` persisted, response
  shape).

**Integration — schema migrations (extend `schema-meetings.test.ts`):**

- Fresh DB at version 32 has `meetings.language` (nullable TEXT) and
  `meeting_segments.enhanced_text` (nullable TEXT).
- DB pre-seeded at version 30 migrates through 31 and 32 cleanly, no data
  loss on existing rows.

**Real-audio acceptance test (manual, reuses meeting `9df09e73`):**

Copy the production DB to a temp file (never mutate the original). On the
copy:

0. Before touching anything: from the **existing** (pre-fix) rows, record
   the `start_ms`/`end_ms` of the 14 known leak segments — system idx 37
   (the 1.7s, 80-term leak) and mic idx 53-55 (three consecutive) among
   them — by **timestamp range**, not by `idx`. Indices don't survive this
   test: Phase B re-segments (`mergeSegmentsToward` runs before
   transcription, so post-fix row indices don't line up with today's), and
   Phase A3 changes which chunks even reach the leak-prone path at all (see
   step 3 below) — timestamps on the underlying audio are the only stable
   reference across old and new rows.
1. Set `meetings.language = 'pt'` for `9df09e73` directly (bypassing the
   probe, since the point here is verifying the *pinning* fix, not the
   detector — the detector has its own unit tests above).
2. Run `POST /:id/transcribe` against the temp DB.
3. **Leak filter** — query the **new** `meeting_segments` rows for this
   meeting. Expect near-zero `status = 'filtered'` rows, and that is the
   correct outcome, not a test failure: idx 37 was a 1.7s segment, and
   under A3 a segment that short never receives a bias prompt at all, so
   there is nothing to echo and no leak to filter — prevention doing the
   job filtration used to have to do. Assert instead:
   - Zero rows anywhere in the meeting where `status = 'ok'` and
     `isVocabLeak(text, currentVocabTerms)` returns true — the leak filter
     (§3.1) still fires as a backstop on whatever chunk boundaries Phase B
     produces, even though A3 is expected to have already prevented most of
     them.
   - No new row whose time range overlaps any of step 0's recorded leak
     timestamp ranges contains vocabulary-echo text, `filtered` or not —
     confirms the *audio* that used to leak no longer produces leaked
     output under either mechanism.
   - The "A1 actually fires when a leak does happen" proof lives in the
     integration test with a fake echoing provider (§8), not here — this
     real-audio pass is about the end state on real audio, not about
     forcing the filter path specifically.
4. **Language fix** — read `transcript.md` (or the merged transcript via
   `GET /:id/transcript`): the segment(s) that previously rendered as "the
   sandbox of him" now read as Portuguese, not English. Spot-check: no
   segment in the transcript is English prose (the calque pattern
   specifically was fluent English with Portuguese word order — that pattern
   should be entirely absent, not just less frequent).
5. **Chunking** — compare `meeting_segments` row counts for `9df09e73`
   before (existing data) vs. after (`Phase B` merge active): total segment
   count for this meeting should drop measurably (record the actual before/
   after counts in this file once run, per the diarization spec's pattern of
   recording real measurements after the fact).

**Measured, 2026-08-27** (temp-DB copy of production, `9df09e73`; measured
two independent ways — a standalone `segmentPcm`/`mergeSegmentsToward` script
over the real WAVs, and the live pipeline's persisted rows after a real
transcribe run — both agree to the decimal):

| channel | count before | count after | mean dur before | mean dur after | max dur | sub-3s before → after |
|---|---|---|---|---|---|---|
| mic | 99 | 89 | 18462ms | 20559.0ms | 29920ms | 0 → 0 |
| system | 105 | 87 | 12889ms | 15959.0ms | 29720ms | 30 → 18 |
| **total** | **204** | **176** | ~15593ms | ~18285ms | — | — |

Total segment count dropped 13.7% (204→176), mean duration moved closer to
the ~20-25s target, no segment exceeded the 30s cap on real audio. Don't
oversell this: mic already had zero sub-3s segments before Phase B — the
existing 2000ms `coalesceGapMs` was already doing most of the coalescing
work on this particular meeting, so the "many tiny anchorless segments"
problem statement is only partly borne out here; the gain is real but
modest, concentrated on the system channel. Step 5 is fully verified.

Steps 3 and 4 remain **unverified, not failed**, for an infrastructure
reason unrelated to this code: the local oMLX/Qwen3-ASR server was
unreachable for the transcribe leg of that same run (confirmed via log —
`chunk mic[0] attempt 1/3 failed: fetch failed` as the very first
transcriber line, meaning the server was already down before any audio was
sent, and all chunks failed identically from chunk 0 — this rules out
Phase B's larger merged payloads as the cause, since an OOM from oversized
chunks would show some successes before a crash partway through). A later
Phase C E2E pass ran against this same meeting with the ASR server reachable
again, but it enhanced the meeting's existing (pre-Phase-A/B, legacy) text
via the LLM — it did not re-run `POST /:id/transcribe`, so it exercises
neither the leak filter's persist-time path nor the language-resolution
probe, and isn't a substitute for steps 3-4. Re-running steps 3-4 verbatim
(probe path included) against a fresh temp-DB copy is the one acceptance
step this package ships without a direct, first-hand confirmation on real
audio — the mechanisms it depends on (the leak filter, the language
pinning, the probe) are each covered by passing unit/integration tests, just
not this specific end-to-end real-audio composition of them.

---

## 9. File inventory

New files:
- `apps/server/src/lib/meetings/language.ts`
- `apps/server/tests/meeting-language.test.ts`
- `apps/server/src/lib/meetings/enhance.ts`
- `apps/server/src/lib/meetings/enhance-prompt.ts` (system/user prompt
  builders, strict-JSON output contract, modeled on `summary-prompt.ts`)
- `apps/server/src/lib/meetings/llm-call.ts` (extracted shared helper, §6.3)
- `apps/server/tests/meeting-enhance.test.ts`

Modified files:
- `apps/server/src/lib/meetings/merge.ts` — `isVocabLeak`,
  `VOCAB_LEAK_OVERLAP_THRESHOLD`; `mergeTranscript`'s new optional fourth
  parameter and its use inside `clean()`; `id`/`enhancedText` on
  `TranscriptSegment`/`MergedSegment`; `formatTranscriptMarkdown` renders
  `s.enhancedText ?? s.text` (§6.4).
- `apps/server/src/lib/meetings/segmenter.ts` — `mergeSegmentsToward`,
  `MergeTowardOptions`, `DEFAULT_MERGE_TOWARD_OPTIONS`.
- `apps/server/tests/segmenter.test.ts` — 12 new `mergeSegmentsToward` cases
  (folded in here rather than a separate `meeting-segmenter-merge.test.ts`):
  empty input, single-segment passthrough, no-mutation-of-input, the §5
  five-burst example, gap-boundary inclusive/exclusive at `maxGapMs`, the
  `maxSegmentMs` boundary, a 20-burst alternating-burst train, partial-options
  override, and interaction with `segmentPcm`'s own 30s force-split output.
- `apps/server/src/lib/meetings/transcriber.ts` — `MIN_BIAS_DURATION_MS`;
  `transcribeChunk`'s bias-skip and `'empty'` status; `ChunkResult.status`
  widened.
- `apps/server/src/lib/meetings/summarize.ts` — `defaultLlmCall` refactored
  to call the new shared `llm-call.ts` helper (no behavior change).
- `apps/server/src/routes/meetings.ts` — `persistChunk`'s `vocabTerms`
  parameter and leak check; `runTranscribeJob`'s `mergeSegmentsToward` calls,
  `resolveMeetingLanguage` call and `effectiveDeps` wrap, Enhance auto-run
  call site; `retry-failed`'s leak check and language-override wrap;
  `renameSchema`'s `language` field and the PATCH handler; new
  `POST /:id/enhance` route; `loadMergedTranscript`'s `SELECT` gains `id,
  enhanced_text` and the `vocabTerms` argument to `mergeTranscript`;
  `MeetingRow` gains `language: string | null`.
- `apps/server/src/lib/schema.ts` — migration 31 (`meetings.language`),
  migration 32 (`meeting_segments.enhanced_text`).
- `apps/electron/src/shared/settings-keys.ts` — `meetingEnhanceAutoRun`.
- `apps/electron/src/renderer/src/pages/meetings.tsx` — `TranscriptSegment`
  gains `id`/`enhancedText`; "Enhance" action button; raw/enhanced toggle;
  editable language chip calling the extended `PATCH /:id`.
- `apps/electron/src/renderer/src/components/language-combobox.tsx` —
  `LanguageList` exported so the meetings language chip (§3.2.5) reuses the
  same searchable body instead of duplicating it.
- `apps/electron/src/renderer/src/locales/*.json` (7 locales + template) —
  `meetings.*` keys for the language chip, Enhance action, and raw/enhanced
  toggle (72 `meetings.*` keys total post-change, verified key-identical
  across all 8 files).
- `apps/server/tests/meeting-merge.test.ts` — leak-backstop and
  filter-order regression cases.
- `apps/server/tests/meeting-transcriber.test.ts` — bias-skip and
  `'empty'`-status cases.
- `apps/server/tests/meetings-routes.test.ts` — `/:id/enhance` cases,
  `PATCH /:id` language cases.
- `apps/server/tests/schema-meetings.test.ts` — migration 31/32 coverage.
- `package.json` (server workspace) — new dependency: `tinyld`.
