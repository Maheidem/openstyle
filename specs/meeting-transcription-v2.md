# Technical Spec: Meeting Transcription v2 (use the after-recording design fully)

**Status:** In progress. Spec approved 2026-10-06. Phases 0a and 0b done (`08c93a0`). Next: phase 1. Phase 5 dropped (see 5.0).
**Author:** _TBD_
**Date:** 2026-10-06
**Scope:** `apps/server/src/lib/meetings` (`segmenter.ts`, `transcriber.ts`, `diarize.ts`, `enhance.ts`, `summarize.ts`), `lib/meetings/merge.ts`, `lib/meetings/job-registry.ts`, `lib/vocabulary-bias.ts`, `routes/meetings.ts`, `packages/validations` (settings), and small UI changes on the Models page (`pages/models`) and the Meetings page (`pages/meetings`).
**Baseline:** `main` at `f320740` (release 2.12.0 plus 14 commits). Every `file:line` below was read on that tree. Re-verify before you implement.

Writing rules: Simplified Technical English. One instruction per sentence. No em-dashes.

---

## 1. Problem and goals

Openstyle records a meeting as two 16 kHz tracks and transcribes them after the meeting stops. The owner asked: "Are we REALLY using the AFTER recording transcription to the best of its ability?"

An audit says no. The pipeline has the whole recording on disk, yet each chunk is transcribed alone, with the dictation model, with no context, and the best post-processing steps are off by default.

### Decisions (owner, 2026-10-06)

1. Build all five improvements, in phases. This document is the spec. No code is written yet.
2. The proof is a before/after run on one real recorded meeting of the owner. It runs only on the owner's Mac.
3. The five improvements:
   - I1. Pass the previous chunk text of the same channel to the ASR as context.
   - I2. Make Enhance easy to turn on. The summary reads the enhanced text.
   - I3. Add a "Meeting transcription model" setting.
   - I4. When diarization is on, run it before transcription and cut the system track at speaker changes.
   - I5. Overlap chunk edges and remove duplicate words at the joins.
4. Enhance stays OFF by default. New users choose it in an onboarding step. Existing users see a one-time prompt after their first finished meeting (recorded or imported) that offers to turn on auto Enhance. The prompt says that the text goes to the default LLM and names it as local or cloud. The summary reads `enhancedText` when present, else `text`. Auto Enhance runs after the status flips to `transcribed`, as its own claimed `enhance` job with progress and cancel (3.2).
5. The proof term list comes from the owner's Vocabulary entries. The script reads them read-only and counts each spelling in both transcripts, locally. It reports counts only.
6. Diarization becomes default-on only if its wall time is at most 10 percent of the audio length on the real meeting and 3 runs have no failure. A synthetic measurement gave about 0.22 percent of the audio length. The real baseline (5.0) gave 0.22 and 0.12 percent with 3 of 3 runs OK, so the condition is met. Owner decision 2026-10-06: diarization is on by default in phase 4.
7. Context never crosses a silence longer than 30 s. There is no context when the meeting language is not declared (`config.language` undefined) or when the language changes.
8. Retry-failed runs without context and without overlap. It resolves the model from the row's `stt_provider` and `stt_model` when they are set.
9. The overlap phase ships only if the baseline real meeting has `contiguousCuts > 0` and the phase shows a measurable gain. Otherwise the phase is dropped.
10. Proof models: the owner's default voice model is Qwen3-ASR on his own server (oMLX). His default LLM is Qwen3.8-27B on the same server. No cloud LLM is allowed in the proof.

### Goals

- G1. A chunk gets the context that a human reader would have: the words that came just before it.
- G2. A user can pick a meeting model that is not the dictation model.
- G3. A user can turn on auto Enhance from one clear prompt, and the summary then uses the enhanced text.
- G4. On the system track, one chunk holds one speaker.
- G5. No existing meeting, setting or model breaks (section 4).
- G6. Each improvement is measured on a real meeting before it is kept (section 7).

### Non-goals

- Streaming transcription during the meeting.
- Word timestamps and word-level speaker alignment (follow-up, section 3.5).
- A new VAD. The energy gate stays as it is.
- Changes to the mic channel speaker model. Mic stays "Me".
- New STT providers or changes to the worker build.
- Per-meeting model choice. The setting is global.

---

## 2. Current behavior

**Chunking.** `segmentPcm` finds speech with an energy gate (`segmenter.ts:279-318`, defaults at `:42-54`). `forceSplit` cuts a segment longer than 30 s at the lowest-energy frame in the middle half (`:234-271`). `mergeSegmentsToward` joins neighbors toward 22.5 s, never over a gap above 4 s and never above 30 s (`:65-69`, `:80-103`). Chunks do not overlap. `segmentWavFile` runs both steps on one file (`:321-325`): `segmentPcm`, then `mergeSegmentsToward`. Gaps between chunks are at least 2 s, except at a forced split (`coalesceGapMs: 2000`, `:52`).

**Transcription.** `MeetingTranscriber.run` builds one task list, mic chunks first, then system chunks (`transcriber.ts:181-201`). Workers take tasks from one shared cursor (`:208-232`). The pool size is 2, or 1 for `local-whisper` (`:171`, `:234-238`). So two chunks of the same channel can run at once and no chunk can know its neighbor. Each chunk is one `provider.transcribe` call with the audio, the model, the language and the vocabulary bias (`:273-283`). The bias is withheld for chunks shorter than 3 s (`MIN_BIAS_DURATION_MS`, `:54`, check at `:276`). The text of the previous chunk is never passed.

**Why the guard exists.** A short clip plus a long prompt makes the model echo the prompt as fake speech (`specs/meeting-transcription-quality.md:15-28`). The spec lists context carry-over as future work (`:952-957`).

**Persist-time leak check.** A chunk whose words come from the vocabulary list is stored as `filtered` with no text (`routes/meetings.ts:273-282`, used by `persistChunk` at `:284-306` and by retry-failed at `:907`).

**Model.** `createDefaultTranscriberDeps` reads the default `voice` model, the same one that dictation uses (`transcriber.ts:347-368`). There is no meeting setting. The factory has one production caller, `buildTranscriberDeps` (`routes/meetings.ts:308-317`). It serves `runTranscribeJob` (`:320-492`, started by `POST /:id/transcribe` at `:801-831`) and `POST /:id/retry-failed` (`:858-935`). Meeting import writes `system.wav` and the app then calls the same `POST /:id/transcribe` (`routes/meetings-import.ts:1-22`), so import and re-transcribe use the same path.

**Providers and prompts.**

| Provider | How it takes the prompt | Code |
|---|---|---|
| `local-whisper` | form field `prompt`. No word timestamps (`no_timestamps`). | `streaming/providers/whisper-local.ts:68-76` |
| `local-mlx` | `context` goes to the worker. The worker picks the first alias that `generate` accepts: `system_prompt`, `initial_prompt`, `prompt`, `context`. It drops the field if none fits and logs `dropping '<alias>': not supported by <model>`. It retries without prompt kwargs on `TypeError`. | `providers/mlx-local.ts:43-48`, `scripts/mlx_asr_server.py:29-35`, `:183-191`, `:280-303` (repo root `scripts/`) |
| `server` (own server) | form field `prompt`. `response_format=json`. | `providers/server.ts:65-77` |
| `openai`, `groq` | AI SDK `providerOptions.<id>.prompt`. | `streaming/transcribe-bias.ts:4-13`, `streaming/utils.ts:22-35` |
| `deepgram`, `elevenlabs`, `soniox` | Bias is a term list, not a prompt. | `vocabulary-bias.ts:110-149` |

The bias text is `Technical terms: a, b, c` cut to 900 characters for `local-mlx` and `server` (`vocabulary-bias.ts:16`, `:150-159`). It is `Terms: ...` for the whisper-style providers (`:103-109`). No provider asks for word timestamps. The `TranscribeResult` type has an optional `segments` field that no meeting provider fills (`streaming/types.ts:40-48`).

**Merge.** `mergeTranscript` runs: drift correction, hallucination filter, vocabulary-leak filter, repeat filter, echo dedup (mic copy dropped when it overlaps a system segment within 1 s and the text similarity is above 0.7), then sort (`merge.ts:266-304`).

**Diarization.** It is off by default: only the value `"true"` turns it on (`diarize.ts:50-57`). It runs after transcription (`routes/meetings.ts:420-428`). It runs the `fluidaudio-diarize` binary on the whole `system.wav` (`diarize.ts:355-485`, timeout is the meeting duration with a 120 s floor, `:337-338`, `:432`). It then gives each finished chunk the speaker with the largest overlap (`assignSpeakerLabels`, `:265-301`). A chunk that holds two speakers gets one label. Imported meetings have only `system.wav`, so they depend on this label (`meetings-import.ts:11-15`).

**Enhance and summary.** Auto-run Enhance is off by default: only `"true"` turns it on (`enhance.ts:50-57`). The job runs it after diarization and before the status flips (`routes/meetings.ts:430-465`). The job registry already has an `enhance` kind, but it is not cancellable (`job-registry.ts:24-37`). `enhanceMeetingTranscript` has a `shouldStop` option (`enhance.ts:79`, `:435`) and no progress callback. There is no UI switch for the setting. The key has no renderer caller (`settings-keys.ts:32`). The Enhance button exists in `pages/meetings/detail.tsx:320-322`. The summary renders `segment.text` only (`summarize.ts:298-309`) and drops segments whose `text` is blank (`:387`). Enhanced text is stored in `meeting_segments.enhanced_text` (`schema.ts:837`) and loaded as `enhancedText` (`routes/meetings.ts:194`).

**Dictation yield.** `waitForDictationIdle` runs only when the provider is `local-whisper` (`transcriber.ts:264-271`, `language.ts:196-201`). A `local-mlx` meeting model that differs from the dictation model would compete with dictation for the same worker and reload.

**Language.** It is decided once per meeting and is sticky (`language.ts:162-224`).

---

## 3. Design

### 3.1 I1: previous-chunk context, per channel

Phase 3a builds the lanes and the flag. Its output is identical to `main`. Phase 3b adds the context.

**Lanes (3a).** The transcriber builds one lane per channel (mic, system). A lane runs its chunks in order, one at a time. The two lanes run in parallel. For `local-whisper` the pool stays at 1: the mic lane runs first, then the system lane (same order as today). `shouldStop` is still polled between chunks. `MeetingChannels` gets a flag `lanes: boolean` (default true). When it is false, the transcriber keeps the old shared cursor and pool.

**What is the context (3b).** The context of chunk N is the tail of the cleaned text of chunk N-1 in the same lane.
- "Cleaned" means: status `ok`, not `isHallucination` (`merge.ts:131-143`), and not a vocabulary leak (`isVocabLeak`, `packages/stt/src/text.ts:131`, with the terms from `vocabularyBiasTerms(config.bias)`, `vocabulary-bias.ts:193`).
- If chunk N-1 is empty, filtered or failed, chunk N gets no context. The lane never reaches back further.
- Tail length: the last 200 characters, starting at the first whole word. That is about 30 to 40 English words.
- No context for chunks shorter than 3 s. The same constant guards both: `MIN_BIAS_DURATION_MS` (`transcriber.ts:54`).
- No context when `startMs(N) - endMs(N-1)` is above 30 000 ms.
- No context when `config.language` is undefined (the meeting language is not declared).
- No context when the language changes: `tinyld` (as `language.ts` uses it) detects the language of the context tail. If it is not `config.language`, the context is dropped.

**How it joins the bias.** `buildAsrBiasPrompt({ terms, context })` (`packages/stt/src/asr-bias.ts:64-117`) puts the context first and the `Terms:` list last. Its budget keeps room for the terms. The model gives the most weight to the end of a prompt, so the context must be last. The order of `buildAsrBiasPrompt` is not acceptable. So:
- A new helper `combinePrompt(biasText, context)` in `vocabulary-bias.ts` puts terms first and context last.
- It reuses `truncateAtWordBoundary` from `asr-bias.ts:50` (export it).
- Total length: at most 900 characters (`PROMPT_CHAR_BUDGET`, `:16`). The context gets up to 200. The terms get up to 700, cut at the last `, ` that fits.
- Assumption to verify in phase 3b: whisper-style models keep the tail of a prompt that is too long. The comment at `vocabulary-bias.ts:105` names a 224-token budget.

**Per provider.**

| Provider | Context sent | Note |
|---|---|---|
| `local-whisper`, `server`, `openai`, `groq` | In the prompt field, after the terms. | If the user has no vocabulary, the prompt is the context only. The owner proof model is `server` (oMLX). |
| `local-mlx` | In `context`, after the terms. | The worker maps it to `system_prompt` for Qwen3-ASR. Parakeet and SenseVoice can drop the prompt: the worker logs `dropping`. A system prompt that holds speech text may echo more. |
| `deepgram`, `elevenlabs`, `soniox` | Not sent. | Their bias is a term list. A new helper `providerTakesPrompt(providerId)` lists the five prompt providers. `soniox` has a `context.text` field that could take context. It is out of scope. |

**Echo guard.** The persist-time vocabulary leak check stays as it is. The transcriber adds `isContextEcho(text, context)` in `packages/stt/src/text.ts`. It is true when the normalized result has at least 3 words and any of these holds:
- it is a contiguous run of the normalized context;
- it starts with 4 or more of the last words of the context;
- `textSimilarity(result, context)` is at least 0.8 (`text.ts:106-114`).
On an echo, the transcriber calls the provider once more for the same chunk with no context and uses that result. This retry does not count against `maxAttempts`. If the text is empty after the dedupe or the echo retry, the chunk status is `empty`.

**Retry-failed.** It runs with `lanes: false`, without context and without overlap. It has no neighbor in memory. It resolves the model from the row (3.3).

**Wall time.** Today the pool of 2 pulls from one list of all chunks: time is about (Nmic + Nsys) x t / 2, with t the mean time of one call. With lanes it is about max(Nmic, Nsys) x t.

| Split of chunks mic/system | Time now | Time with lanes | Ratio |
|---|---|---|---|
| 50/50 | 0.50 N t | 0.50 N t | 1.0 |
| 30/70 | 0.50 N t | 0.70 N t | 1.4 |
| 0/100 (import, one track) | 0.50 N t | 1.00 N t | 2.0 |

`local-whisper` has a pool of 1 and the MLX worker reads one line at a time from stdin (`mlx_asr_server.py:_serve`). For these two the ratio is 1.0. Only cloud and own-server providers can get slower, up to 2x. The owner proof model runs on an own server, so the ratio applies. The proof run measures it (section 7).

### 3.2 I2: Enhance stays off, one-time prompt, summary reads enhanced text

**Setting rule.** `getMeetingEnhanceAutoRunSetting()` does not change (`enhance.ts:50-57`): only `"true"` turns it on. A missing row means off.

**Validator.** Add a check in `lib/setting-validators.ts` for `meeting_enhance_auto_run`. It accepts only `"true"` and `"false"`. Any other value returns 400. The new flag `meeting_enhance_prompt_seen` (below) gets the same check.

**New users: onboarding step.** Onboarding gets a step that asks the auto Enhance question, with the same text and the same two choices as the dialog below. The step writes `meeting_enhance_auto_run` (`"true"` or `"false"`) and sets `meeting_enhance_prompt_seen` = `"true"`. Keep the step short and skippable. Skip writes only the seen flag (off stays the default).

**Existing users: one-time prompt.** Users who finished onboarding before this version never see the onboarding step. Condition: the user has at least one meeting (recorded or imported) in status `transcribed` or `summarized`, there is no `meeting_enhance_auto_run` row, and `meeting_enhance_prompt_seen` is not `"true"`. The Meetings page then shows a dialog once:
- It offers to turn on auto Enhance.
- It says that the meeting text goes to the default LLM, and names that model as "local" (provider `local-mlx`), "your own server" (provider `server`) or "cloud" (any other provider).
- Two buttons: turn on (writes `meeting_enhance_auto_run` = `"true"`) and not now (writes only `meeting_enhance_prompt_seen` = `"true"`).
The dialog sets the seen flag in both cases. The renderer has only `putSetting` (`lib/settings.ts:10`).
The same switch lives in a new `EnhanceSettingsPopover` in `pages/meetings/settings-popovers.tsx`, next to `DiarizationSettingsPopover` at `pages/meetings/index.tsx:121` and `:172`. It writes `"true"` or `"false"` like the diarization switch (`settings-popovers.tsx:130-141`). Locale keys go in `apps/electron/src/renderer/src/locales/` (`en.json` and `template.json`).

**Auto-run as its own job.** Today the auto-run sits before the status flip (`routes/meetings.ts:430-465`) and holds the transcribe job open. New order:
1. `runTranscribeJob` flips the status to `transcribed` and writes the markdown.
2. If the setting is on, it releases the slot and, in the same tick with no await in between, calls `claimJob(id, "enhance")`. It then runs Enhance in the background.
3. Progress: `enhanceMeetingTranscript` gets an optional `onProgress(done, total)`. The job writes it with `setProgress`.
4. Cancel: add `"enhance"` to `CANCELLABLE_KINDS` (`job-registry.ts:30-34`). The job passes `shouldStop: () => isCancelRequested(id)` (`enhance.ts:79`). `POST /:id/cancel-transcribe` then stops it. A cancelled Enhance keeps the chunks it finished and leaves the status `transcribed`.
5. At the end, the job rewrites `transcript-enhanced.md` and releases the slot in a `finally`.
A failure is logged and never changes the meeting status. This keeps the fail-closed rule of today (`routes/meetings.ts:462-464`). The reason for the change: a 10 minute Enhance no longer hides a finished transcript, and the user can stop it.

**Summary.** `formatSegment` renders `segment.enhancedText ?? segment.text` (`summarize.ts:307-309`). `renderTranscript` filters on the rendered text, not on `text` (`:298-305`). The `withText` filter in `summarizeMeeting` (`:387`) changes the same way, so a segment with only enhanced text counts. `chunkTranscript` uses `formatSegment`, so it follows.
- Enhance can change only some chunks, so one summary can mix enhanced and raw lines.
- A summary is not refreshed after a later Enhance. The user must run Summarize again. The Summarize button stays as it is.

### 3.3 I3: Meeting transcription model

**Storage.** One new setting `meeting_stt_model`. The value is JSON: `{"provider":"...","model_id":"...","model_name":"..."}`. An empty string means missing. No new table and no schema bump. The setting is not a `model_configs` row. Reason: `POST /api/models/configured` with `is_default = 0` would clear the dictation default through its `ON CONFLICT ... SET is_default = excluded.is_default` (`routes/models.ts:264-293`).

**Resolution.** In `createDefaultTranscriberDeps.resolveConfig` (`transcriber.ts:347-368`):
1. Read `meeting_stt_model`. If it is missing, empty or does not parse, use the default `voice` model (today's behavior).
2. Otherwise use its provider and model id.
3. Resolve the API key and the vocabulary bias for that provider and model (`getApiKey`, `resolveAsrVocabularyBias`, as now).
4. Return a flag `differsFromDictation`: true when the provider or model id is not the default `voice` pair.
`buildTranscriberDeps` also takes an optional `{ provider, modelId }` override. Retry-failed passes the row's `stt_provider` and `stt_model` when both are set (`routes/meetings.ts:858-935`, add both columns to its SELECT). If the override provider or model is gone, retry fails with the provider's own message.
`runTranscribeJob` stamps the chosen provider and model on the meeting row (`routes/meetings.ts:348-351`). The language probe uses the same config (`language.ts:195-206`).

**Dictation yield.** `waitForDictationIdle` runs for `local-whisper` today. Extend the condition in `transcriber.ts:264` and `language.ts:196` to: provider is `local-whisper`, or provider is `local-mlx` and `differsFromDictation` is true. Then a different local MLX model does not load in the middle of a dictation. The UI note on the Models row says: "A different local model reloads when you dictate."

**Validation.** Add `meetingSttModelSettingSchema` in `packages/validations/src/settings.ts` and a check in `lib/setting-validators.ts`, in the style of `meetingEnhanceTimeoutSecondsSettingSchema` (`setting-validators.ts:189`). The check accepts the empty string. A bad value returns 400.

**A stored model that is gone.** If a local model is deleted, the provider call fails with its own message. The job fails like it does for a bad dictation default. The UI shows a note when the stored model is not in the configured list.

**UI (Models page).** Add one row under the voice and LLM pair card (`pages/models/index.tsx:229`): "Meeting transcription". It holds a `Select` with the first item "Same as dictation" and one item per configured voice model (`m.configured` where `type === "voice"`, `use-models.ts:199`). Copy the pattern of the per-task override select (`task-profiles-section.tsx:599-630`, sentinel `USE_DEFAULT_MODEL_VALUE` at `:68`). "Same as dictation" calls `putSetting("meeting_stt_model", "")`. To add a model to the list, the user uses the normal flow of the 2.12 picker groups. This row does not add a second picker.

### 3.4 I4: diarize first, cut at speaker changes

Active only when `meeting_diarization_enabled` is on and `system.wav` exists.

**Order.** Today: segment, transcribe, diarize, label. New order in `runTranscribeJob`:
1. `deps.resolveConfig()` first, so a missing model or key fails before the diarizer runs.
2. `setProgress` with `phase: "diarizing"` (new optional field in `MeetingJobProgress`), so the UI does not show 0 of 0.
3. `runDiarizer`.
4. `isCancelRequested(id)` right after `runDiarizer`. If true, take the same cancel exit as today (`routes/meetings.ts:392-415`).
5. Segment with speaker cuts, transcribe, then label.

**Code split.** `runDiarizationPass` (`diarize.ts:355-485`) has three parts: the checks and the probe (`:360-412`), the DB reads that set the timeout (`:414-432`), and the binary run and parse (`:434-457`). The label write is at `:459-483`. Split it into `runDiarizer(audioDir, durationMs, deps): DiarizerSegment[] | null` (no DB; the caller gives the duration) and `applyDiarization(meetingId, diarSegments)` (DB: reads the system rows, calls `assignSpeakerLabels`, writes labels). `runDiarizationPass` calls both, so `POST /:id/diarize` (`routes/meetings.ts:973`) keeps its behavior.

**Segment type.** `Segment` (`segmenter.ts:37-40`) gets an optional `speaker?: string`. `segmentPcm` and `segmentWavFile(path, turns?)` take an optional `turns` argument (`DiarizerSegment[]`).

**Cut rule.** New pure function `cutAtSpeakerChanges(segments, turns, rmsDb)` in `segmenter.ts`. `segmentPcm` calls it after `forceSplit` (`:316`), where `rmsDb` is in scope. `mergeSegmentsToward` runs after it (in `segmentWavFile`). Steps for each segment:
1. Take the diarizer turns that overlap the segment. Clip them to the segment.
2. Join neighbor turns of the same speaker.
3. A turn shorter than 1000 ms joins the previous turn. The first turn, if shorter than 1000 ms, joins the next turn. This removes flicker.
4. Join same-speaker neighbors again, because step 3 can make them touch.
5. For each cut, snap it to the lowest-energy frame within +/- 300 ms of the turn start. Keep the cut inside the segment.
6. If more than one part is left, cut there. Each part gets `speaker` set.
7. A part with no overlapping turn gets no `speaker`.
8. A part shorter than about 1500 ms merges into a neighbor. It takes the speaker of the longer of the two.

**Merge rule.** `mergeSegmentsToward` does not merge two segments when both have a `speaker` and the values differ (`segmenter.ts:92-96`). Parts of the same speaker still merge toward 22.5 s.

**Merge filters (`merge.ts`).** Cuts make short chunks, and short chunks trigger two filters that were made for whole utterances.
- `filterConsecutiveRepeats` (`merge.ts:150`) takes the `speakerLabel` into account. It collapses a run only when all segments in the run have the same label.
- `isHallucination` skips the `HALLUCINATION_EXACT` rule (`:138`) for a chunk that has a `speakerLabel` or a duration above 1 s. The prefix rule stays.
Without these two changes, two speakers who each say "yes" would collapse, and a real "thank you" from a labeled speaker would be dropped.

**Labels.** After transcription the job calls `applyDiarization` with the turns it already has. It does not run the binary a second time. `assignSpeakerLabels` gives each chunk the label of its one speaker. Numbering stays first-appearance (`diarize.ts:280-292`).

**Failure.** If the binary or the models are missing, `runDiarizer` returns null and logs a warning. The job then segments with no speaker cuts and skips labels. It never fails the job.

**Mic.** The mic channel is not cut.

**Cost.** One more serial step before the first chunk. The proof phase measures `D` (diarizer seconds) on the 3580 s meeting. See 4.3 for the default.

**Short chunks.** A cut can make short single-speaker chunks. The 3 s guard then drops the bias and the context for them (`transcriber.ts:276`). Phase 4 reports how many chunks are shorter than 3 s before and after.

### 3.5 I5: overlap and text join (conditional phase)

**Honest scope.** Chunk edges sit in a pause of at least 2 s, except at a forced split of speech longer than 30 s and at a new speaker cut (section 2). So overlap helps only at those cuts. The phase ships only if the baseline real meeting has `contiguousCuts > 0` and the phase shows a measurable gain (7.6). Otherwise it is dropped. A synthetic clip alone does not make it ship.

**Overlap.** The transcriber reads audio from `startMs - OVERLAP_MS` (1000 ms) when all of these are true:
- the previous chunk of the lane exists and `startMs - prev.endMs < 1000` (a contiguous cut);
- the previous chunk is not a speaker cut: if both chunks have `speaker`, the values are equal.
The stored `start_ms` and `end_ms` do not change. Only the audio slice grows (`sliceWav`, `audio/wav.ts:201-206`). A speaker cut gets no overlap: the extra second would hold the other speaker and break G4.

**Junk check.** An overlap slice that starts in mid-word can produce a junk word at its start. The proof samples the first word of overlap chunks by index and counts the ones that are not in the previous chunk tail. It reports the count.

**Text join (no word timestamps).** Function `dedupeJoin(prevText, newText, maxWords = 6)` in a new file `lib/meetings/join.ts`. It is pure.
1. Split both texts on spaces. Compare words after `normalizeText` (`packages/stt/src/text.ts:97-103`): lower case, no punctuation.
2. Find the largest k, from `maxWords` down to 2, where the last k words of `prevText` equal the first k words of `newText`.
3. If found, remove those k words from the start of `newText`. Keep the punctuation of the words that remain.
4. If not found, return `newText` unchanged.
It runs only when overlap audio was used for this boundary. 1 s holds about 3 to 4 spoken words, so `maxWords = 6` is a safe ceiling.

**Limits.**
- It needs an exact match after normalization. If the two calls spell an overlap word in two ways, the duplicate stays. That is the safe error.
- A real repeat across a cut ("no no no") is touched only when overlap audio exists. A repeat of 1 word is never removed (k is at least 2).
- It cannot fix a word that the model heard in only one of the two chunks.

**Follow-up (not in this spec).** Ask providers for word timestamps (whisper.cpp `response_format=verbose_json`, OpenAI `timestamp_granularities`). Then cut the overlap by time. It needs provider work (section 2 shows no provider asks today).

---

## 4. Settings and migration rules

### 4.1 Table

| Key | Meaning | Missing row | `"true"` | `"false"` | Who writes it |
|---|---|---|---|---|---|
| `meeting_stt_model` (new) | JSON model for meetings | Use the dictation model | n/a | n/a | Models page row (empty string = missing) |
| `meeting_enhance_auto_run` (validator only) | Auto Enhance after transcription | Off | On | Off | Popover switch, one-time prompt |
| `meeting_enhance_prompt_seen` (new) | The one-time prompt was shown | Not shown yet | Shown | Shown | One-time prompt |
| `meeting_diarization_enabled` (rule change only if 4.3 passes) | Diarize before transcription | Off (On if 4.3 passes) | On | Off | Existing popover switch |

### 4.2 Migration

- No schema bump. `SCHEMA_VERSION` stays 36 (`schema.ts:14`).
- No migration writes any key. Existing explicit values are kept.
- `getMeetingEnhanceAutoRunSetting` stays the one place of the Enhance rule.

### 4.3 Is diarization on by default?

It becomes default-on (the `!== "false"` rule) only if the proof phase shows both:
- diarizer time `D` is at most 10 percent of the audio length on the owner's real meeting (360 s for the 3580 s meeting);
- no failure in 3 runs.
A synthetic measurement gave about 0.22 percent of the audio length. It is not the real meeting, so it does not decide. Otherwise diarization stays opt-in and phase 4 ships with the switch as it is. A privacy note: diarization runs on device (`diarize.ts:384-388`).

---

## 5. Phases

Each phase is one pull request. Each is small enough for one coding session. Run from `apps/server` unless a path says otherwise. The commands are `pnpm vitest run <file>` and `pnpm typecheck:tests`, plus `pnpm biome check` at the repo root.

Every proof server starts with `cd apps/electron && node ../server/dist/startup.js`. The diarizer binary and models resolve from the current directory and `resources`. Every run writes a fresh `server.log` (`rm -f "$SCRATCH/server.log"` first).

### 5.0 Status and baseline (2026-10-06)

| Phase | Status |
|---|---|
| 0a scratch profile | Done (`08c93a0`, `scripts/meeting-v2/setup-scratch.sh`, `seed-scratch-db.mjs`) |
| 0b metrics and baseline | Done (`08c93a0`, `metrics.mjs`, `run-baseline.mjs`, `measure-diarizer.mjs`) |
| 1 meeting model | Done (`bdf99f5` + `dce5e7e`). |
| 2 Enhance (onboarding step + one-time prompt) | To do |
| 3a lanes | To do |
| 3b context | To do |
| 4 diarize first, default on | To do. Owner approved default-on. |
| 5 overlap and join | Dropped: `contiguousCuts` is 0 on both proof meetings (Q8 rule). |

Baseline on the owner's real meetings (scratch copies, Qwen3-ASR and Qwen3.8-27B on the owner's oMLX, `main` at `f320740`):

| Meeting | Run | wallSeconds | chunks (mic/system) | labeled (speakers) | failed | under 3 s | termHits | contiguousCuts | langMismatch |
|---|---|---|---|---|---|---|---|---|---|
| short 2943c36a (425 s) | R0 | 12.03 | 17/20 | 0 | 0 | 5 | 3 | 0 | 9 |
| short | R0d | 14.03 | 17/20 | 14 (1) | 0 | 5 | 3 | 0 | 9 |
| long 9243bea0 (3580 s) | R0 | 96.19 | 168/79 | 0 | 0 | 22 | 30 | 0 | 31 |
| long | R0d | 100.20 | 168/79 | 59 (5) | 0 | 22 | 30 | 0 | 31 |

Diarizer wall time (standalone, median of 3 runs, all OK): short 0.92 s (0.22 percent), long 4.39 s (0.12 percent). R0d text hash equals R0 on both meetings: diarization changes only the labels. The installed app was open during the runs; ASR ran on the separate oMLX process. Metric files: `/tmp/meeting-v2/baseline/<run>-<meetingId>/metrics.json` (scratch, not committed). The procedure is in `.claude/skills/meeting-benchmarks/SKILL.md`.

### Phase 0a: scratch profile and DB rows

No product code. Files: only the scratch directory (section 7).
Do: build the scratch profile, copy one meeting, insert the meeting row, copy the model rows (7.2).
Done when:
- `sqlite3 "$SCRATCH/test.db" "select count(*) from vocabulary"` equals the count in the real DB (read from a copy).
- `sqlite3 "$SCRATCH/test.db" "select count(*) from model_configs where is_default=1"` prints 2 (voice and llm) and `select count(*) from api_keys` prints 0.
- `sqlite3 "$SCRATCH/test.db" "select status from meetings"` prints `recorded`.
- Diarization-on proof runs only: `grep -c "diarization skipped" "$SCRATCH/server.log"` prints 0.

### Phase 0b: metrics script and baseline

No product code. Do: write the metrics script, run R0 and R0d on `main`, save the metrics files.
Done when: `jq -e 'has("wallSeconds") and has("chunks") and has("labeled") and has("termHits") and has("dupJoins") and has("contiguousCuts") and has("filtered") and has("empty") and has("failed") and has("langMismatch")' "$SCRATCH/baseline/metrics.json"` exits 0.

### Phase 1: meeting model setting (I3)

Files: `packages/validations/src/settings-keys.ts`, `packages/validations/src/settings.ts`, `apps/server/src/lib/setting-validators.ts`, `apps/server/src/lib/meetings/transcriber.ts` (`resolveConfig`, the dictation wait), `apps/server/src/lib/meetings/language.ts` (the wait), `apps/server/src/routes/meetings.ts` (retry override), `apps/electron/src/renderer/src/pages/models/index.tsx`, a new `pages/models/meeting-model-row.tsx`, `locales/en.json` and `locales/template.json`.
Tests: extend `tests/meeting-transcriber.test.ts`: stored model used; missing or empty row uses the default; bad JSON uses the default; key is resolved for the stored provider; with a fake `local-mlx` provider and `differsFromDictation` true, the call waits while dictation is active, and with it false, it does not wait. Extend `tests/meetings-routes.test.ts`: retry-failed resolves the model from the row's `stt_provider` and `stt_model`. Add a settings validator test.
Done when:
- `pnpm vitest run tests/meeting-transcriber.test.ts tests/meetings-routes.test.ts tests/settings-validators.test.ts` passes.
- On the isolated server: `curl -s -X PUT .../api/settings/meeting_stt_model -d '{"value":"{...}"}'` returns 200, then `POST /api/meetings/<id>/transcribe` leaves `stt_model` equal to the chosen model: `sqlite3 "$DB" "select stt_provider, stt_model from meetings"`.
- Command check: `curl -s .../api/settings/meeting_stt_model | jq -e '.value | fromjson | .model_id'` prints the chosen id.
- Owner check: a screenshot of the Models page shows the row with the chosen model and the reload note.

### Phase 2: Enhance prompt, validator, enhance job, summary (I2)

Files: `lib/meetings/enhance.ts` (`onProgress`), `lib/meetings/summarize.ts` (`:298-309`, `:387`), `lib/meetings/job-registry.ts` (`CANCELLABLE_KINDS`), `lib/setting-validators.ts`, `packages/validations/src/settings-keys.ts` (`meeting_enhance_prompt_seen`), `routes/meetings.ts` (the auto-run moves after the status flip), `pages/meetings/settings-popovers.tsx`, `pages/meetings/index.tsx`, a new one-time prompt dialog, a new onboarding step under `pages/onboarding/`, locales.
Tests: `meeting-enhance.test.ts` (missing row off, `"true"` on); `meeting-summarize.test.ts` (input uses `enhancedText` when present, else `text`; a segment with blank `text` and an `enhancedText` counts); `meetings-routes.test.ts` (the status is `transcribed` before Enhance starts; the `enhance` job reports progress; cancel stops it; an Enhance failure leaves the status); validator test for `"true"`, `"false"` and a bad value.
Done when:
- `pnpm vitest run tests/meeting-enhance.test.ts tests/meeting-summarize.test.ts tests/meetings-routes.test.ts tests/settings-validators.test.ts` passes.
- On the isolated server with no `meeting_enhance_auto_run` row: after transcribe, `sqlite3 "$DB" "select count(*) from meeting_segments where enhanced_text is not null"` prints 0.
- With the row set to `"true"`: `GET /api/meetings/<id>` shows `status` `transcribed` while `kind` is `enhance`, then the count above is greater than 0 and `transcript-enhanced.md` exists in the copied meeting folder.
- `curl -s -X PUT .../api/settings/meeting_enhance_auto_run -d '{"value":"yes"}'` returns 400.
- Owner check: a screenshot shows the one-time prompt after the first finished meeting, with the LLM named. Command check: after "not now", `curl -s .../api/settings/meeting_enhance_prompt_seen | jq -e '.value == "true"'` exits 0.

### Phase 3a: lanes and flag (I1, no context)

Files: `lib/meetings/transcriber.ts` (lanes, `lanes` flag), `routes/meetings.ts` (retry passes `lanes: false`).
Tests: lane order per channel; two lanes run in parallel (a fake provider with delays); `lanes: false` keeps the old pool; `shouldStop` stops a lane.
Done when:
- `pnpm vitest run tests/meeting-transcriber.test.ts tests/meetings-routes.test.ts` passes.
- Isolated run: the metrics file shows `chunks`, `filtered`, `empty`, `failed` and the segment texts hash equal to the baseline (same output as `main`). Command: `jq -e '.textHash == $b' --argjson b "$(jq .textHash "$SCRATCH/baseline/metrics.json")" "$SCRATCH/R3a/metrics.json"`. The script computes `textHash` over the segment texts and prints only the hash.
- Wall time: `jq -e '.wallSeconds <= 1.1 * ($base * $ratio)' --argjson base "$BASE" --argjson ratio "$RATIO" "$SCRATCH/R3a/metrics.json"` exits 0, with `BASE` the baseline `wallSeconds` and `RATIO` from the 3.1 table for the measured mic/system split.

### Phase 3b: context, echo guard, per-provider rules (I1)

Files: `lib/meetings/transcriber.ts` (context), `lib/vocabulary-bias.ts` (`combinePrompt`, `providerTakesPrompt`), `packages/stt/src/asr-bias.ts` (export `truncateAtWordBoundary`), `packages/stt/src/text.ts` (`isContextEcho`).
Tests: context is the last 200 characters from a word boundary; no context under 3 s, after an empty or failed chunk, after a gap above 30 s, with `config.language` undefined, when `tinyld` finds another language, or for `deepgram`; combined prompt is at most 900 characters, terms first, context last; `isContextEcho` (contiguous run, 4+ tail words, similarity); echo gives one retry without context; empty text after dedupe or echo retry gives `empty`.
Done when:
- `pnpm vitest run tests/meeting-transcriber.test.ts tests/vocabulary-bias.test.ts` and `pnpm --filter @openstyle/stt test` pass.
- Isolated run on the copy: `jq -e '.chunks == $b.chunks and .termHits >= $b.termHits and .filtered <= $b.filtered + 2 and .langMismatch <= $b.langMismatch' --argjson b "$(cat "$SCRATCH/R3a/metrics.json")" "$SCRATCH/R3b/metrics.json"` exits 0. `langMismatch` counts chunks whose `tinyld` language is not the meeting language.
- Prompt check for `local-mlx` runs only: `grep -c "dropping" "$SCRATCH/mlx.log"` prints 0. If it prints more than 0, the model ignores the prompt and the phase has no effect for that model. The owner proof model is `server` (oMLX), which has no such log. For it the check is the `termHits` and `filtered` rule above.

### Phase 4: diarize first and speaker cuts (I4)

Files: `lib/meetings/diarize.ts` (`runDiarizer`, `applyDiarization`), `lib/meetings/segmenter.ts` (`speaker`, `turns` argument, `cutAtSpeakerChanges`, merge rule), `lib/meetings/merge.ts` (repeat and hallucination rules), `lib/meetings/job-registry.ts` (`phase`), `routes/meetings.ts` (`runTranscribeJob` order).
Tests: `segmenter.test.ts` (two turns in one segment give two parts; flicker under 1 s is absorbed; first turn under 1 s joins the next; same-speaker neighbors re-join; a cut snaps to the lowest-energy frame within 300 ms; a part under 1.5 s merges into a neighbor; no merge across speakers; a part with no turn has no speaker); `meeting-merge.test.ts` (repeat collapse only within one label; `HALLUCINATION_EXACT` skipped for a labeled chunk and for a chunk above 1 s); `meeting-diarize-pipeline.test.ts` (labels from the stored turns, binary runs once; missing binary leaves the old behavior; cancel right after `runDiarizer`; `resolveConfig` runs before the diarizer).
Done when:
- `pnpm vitest run tests/segmenter.test.ts tests/meeting-merge.test.ts tests/meeting-diarize.test.ts tests/meeting-diarize-pipeline.test.ts` passes.
- Isolated run with diarization on, compared with R0d (diarization on, old order): `jq -e '.labeled >= $b.labeled and .multiTurnChunks == 0 and .failed == $b.failed' --argjson b "$(cat "$SCRATCH/R0d/metrics.json")" "$SCRATCH/R4/metrics.json"` exits 0. `multiTurnChunks` counts chunks that overlap more than one diarizer turn. The script also reports the count of chunks under 3 s.
- `grep -c "diarization skipped" "$SCRATCH/server.log"` prints 0.
- `grep -c "diarization labeled" "$SCRATCH/server.log"` prints 1.
- `D` is recorded for the default decision (4.3).
- Synthetic clips (generated with `ffmpeg -f lavfi`, fake diarizer turns in test): a 10 s clip with turns at 0-4 s and 4-10 s must give exactly 2 chunks, cut within 300 ms of 4 s.

### Phase 5: overlap and join (I5, conditional)

Starts only if the baseline `contiguousCuts` is above 0. If it is 0, drop this phase and say so in the report.
Files: new `lib/meetings/join.ts`, `lib/meetings/transcriber.ts` (overlap slice and join call). Retry passes `lanes: false` (phase 3a), which also turns overlap off.
Tests: `dedupeJoin` table (match at 2, 3, 6 words; no match; case and punctuation; single-word repeat kept; k above 6 ignored); the transcriber slices with overlap only for contiguous cuts; no overlap across a speaker cut; stored `start_ms` and `end_ms` are unchanged.
Done when:
- `pnpm vitest run tests/meeting-join.test.ts tests/meeting-transcriber.test.ts` passes.
- Isolated run: `jq -e '.dupJoins < $b.dupJoins' --argjson b "$(cat "$SCRATCH/R4/metrics.json")" "$SCRATCH/R5/metrics.json"` exits 0 (a measurable gain). The report also gives `contiguousCuts` and the junk-word count (3.5).
- A synthetic 70 s clip (fake provider in test) proves the join at a forced split. It does not make the phase ship.

---

## 6. Risks

| Risk | Why | Control |
|---|---|---|
| Prompt echo | A prompt that holds speech can come back as output, mostly on short or quiet clips (`meeting-transcription-quality.md:15-28`). | 3 s guard for context; vocabulary leak check; `isContextEcho` plus one retry with no context; phase 3b counts `filtered` and echoes. |
| Context steers wrong | A wrong word in chunk N-1 can repeat in chunk N. A context in another language can pull the model off. | Cleaned text only; 200 characters only; no context across a gap above 30 s or a language change; the proof compares term hits and `langMismatch`. |
| Longer wall time | Lanes run one chunk at a time per channel. | Section 3.1 table: up to 2x for cloud and own-server providers on one-track meetings, 1.0 for local providers. The wall-time check of phase 3a bounds it. Diarize-first adds `D`. Enhance now runs after the status flip, so it adds no wait before `transcribed`. |
| Meeting model differs from dictation model | A local MLX meeting model that differs from the dictation model reloads in the worker and can stall a live dictation. | `waitForDictationIdle` also runs for `local-mlx` when the models differ (3.3); a test with a fake provider; a UI note on the Models row. |
| Wrong speaker cuts | The diarizer can split one voice, or merge two. | 1 s flicker rule; cuts snap to quiet frames; 1.5 s minimum chunk; fallback to no cut; labels stay editable; the owner reads the diff. |
| More short chunks | Speaker cuts make short chunks that lose bias and context. | Phase 4 reports chunks under 3 s before and after. |
| Short chunks hit merge filters | A "yes" from two speakers looks like a repeat; a real "thank you" looks like a hallucination. | Label-aware repeat filter; `HALLUCINATION_EXACT` skipped for labeled chunks and chunks above 1 s (3.4). |
| Duplicate removal deletes a real repeat | "No no no" across a cut. | Join runs only with overlap audio; k at least 2; k at most 6; exact normalized match only. |
| Enhance sends text to an LLM | Auto Enhance sends meeting text to the default LLM. | Off by default. The one-time prompt names the LLM as local, own server or cloud before the user turns it on. The popover switch gives a one-click off. |
| Mixed or stale summary | Enhance can change some chunks only. A later Enhance does not refresh a summary. | Documented in 3.2. The user runs Summarize again. |
| Transcript text in logs | Context contains transcript text. The server trace logs request fields and responses (`trace.ts:148-159`, `providers/server.ts:25-39`). | No new info-level log of text. The proof leaves `OPENSTYLE_LOG_DIR` unset, so trace output stays off the disk. Phase 0a checks where trace output goes. |

---

## 7. Evaluation

**Rules.** The proof uses one real meeting. It runs only on the owner's Mac. The agent never writes to the real profile. The agent never reads or prints any real meeting transcript or audio into the repo, this spec, a log or a commit. Only the local scripts read the scratch copies. The agent reports only numbers and short anonymized notes. The owner reads the side-by-side diff himself.

### 7.1 Meeting choice

Read-only list of `~/Library/Application Support/Openstyle/meetings` (sizes only, 16 kHz mono PCM16 = 32,000 bytes per second):

| Meeting id | Audio per channel | Use |
|---|---|---|
| `2943c36a-532e-4db9-af09-b5e66f0bdf2d` | 425 s | Fast loop for phases 1 to 5. |
| `9243bea0-567f-443b-bf3b-9980f69993fd` | 3580 s | Final run, and the diarizer cost `D` on a 1 h meeting. |

The owner can swap either id. The choice is by length only. No transcript was read to choose.

### 7.2 Isolated profile

```
SCRATCH=/private/tmp/claude-501/-Users-maheidem-Documents-dev-openstyle/<session>/scratchpad/mt-v2
mkdir -p "$SCRATCH/meetings"
cp -R "$HOME/Library/Application Support/Openstyle/meetings/<id>" "$SCRATCH/meetings/<id>"   # copy, read only on the source
rm -f "$SCRATCH/meetings/<id>/transcript"*.md                                               # drop old transcripts from the copy
```

- Fresh database: `OPENSTYLE_DB_PATH="$SCRATCH/test.db"`. Never the real `freestyle.db`.
- Own port and token: `PORT=47xx` (a free port that is not 4649) and `OPENSTYLE_AUTH_TOKEN=$(uuidgen)` (`startup.ts:7-28`). Bind `HOST=127.0.0.1`.
- Start: `cd apps/electron && node ../server/dist/startup.js` after `pnpm build`, for each of the baseline commit and each phase branch (use `git worktree`, one per commit). The cwd matters: the diarizer binary and models resolve from it.
- Insert one `meetings` row by SQL into the scratch DB with `status='recorded'` and `audio_dir` set to the copy (columns at `apps/server/src/lib/schema.ts:760-777`, `language` at `:828`). Set `created_at` to the current time, so the retention sweep (`retention.ts`) ignores the scratch row. Leave `OPENSTYLE_LOG_DIR` unset.
- Same models for every run. Make a copy of the real DB file and its `-wal` and `-shm` files first. Copy these rows from the copy into the scratch DB: the `vocabulary` rows, the `languages` setting, the `own_servers` row or rows, and the default `voice` and `llm` rows of `model_configs`. Never copy a row that holds an API key, and never copy `api_keys`.
- The proof models: voice is Qwen3-ASR on the owner's server (oMLX, provider `server`). LLM is Qwen3.8-27B on the same server. If a copied default is a cloud model, stop. Cloud LLMs are not allowed for the proof.
- Close the real Openstyle app during timed runs, so that it does not compete for the Neural Engine.
- Local models are shared files. The isolated server reads them. It does not write to them.

### 7.3 Runs

| Run | Code | Settings |
|---|---|---|
| R0 | `main` at `f320740` | Enhance off, diarization off. |
| R0d | `main` | Enhance off, diarization on. |
| R1 | phase 1 | Meeting model set to the same model (proves the path). |
| R2 | phase 2 | Enhance row `"true"`. |
| R3a | phase 3a | Same settings as R1. Output must equal R0. |
| R3b | phase 3b | R3a plus context. |
| R4 | phase 4 | R3b plus diarization on. |
| R5 | phase 5 (if it ships) | R4 plus overlap. |

Run each twice on the short meeting. Run R0, R0d and R4 once on the long meeting. Run diarization 3 times for the 4.3 decision. Report the median.

### 7.4 Metrics (computed by a local script, saved as `metrics.json`)

| Metric | How |
|---|---|
| `wallSeconds` | From the `POST /transcribe` reply to `status = transcribed` (poll `GET /api/meetings/<id>`). Also `D` and enhance seconds from the server log. |
| `chunks` | `select source, count(*) from meeting_segments group by source`. Also count chunks under 3 s. |
| `labeled` | Number of system rows with a non-null `speaker_label`, and the number of distinct labels. |
| `multiTurnChunks` | Number of system chunks that overlap more than one diarizer turn. |
| `termHits` | The script reads the owner's Vocabulary entries (read-only, from the copied DB). For each spelling it counts the occurrences in the raw text and in `enhanced_text` of both transcripts. It reports counts only, never a term next to its context. |
| `textHash` | A hash over the segment texts, in order. It tells if two runs have equal output without showing text. |
| `dupJoins` | Count of neighbor pairs in one channel where the last k words of A equal the first k words of B (k at least 1; also k at least 2). |
| `langMismatch` | Count of chunks where `tinyld` finds a language other than the meeting language (as `language.ts` does). |
| `filtered`, `empty`, `failed` | Counts by `status`. |
| `contiguousCuts` | Count of neighbor pairs in one channel with a gap under 1000 ms. This tells if phase 5 has any work to do. |

### 7.5 Reports

- The agent reports a table of the metrics per run. No text.
- Anonymized notes are allowed, in this form: "3 of 12 sampled diffs: a vocabulary term fixed". The agent samples diffs by index, not by content.
- The script writes `$SCRATCH/diff-R0-vs-R4.html` (side by side, by segment index). The owner opens it on his Mac. The agent does not open it.
- Delete `$SCRATCH` after the owner confirms. Ask first.

### 7.6 Pass rules

- R3a: `textHash` equal to R0, and `wallSeconds` at most 1.1 x (baseline x ratio from 3.1).
- R3b: `termHits` not lower than R3a, `filtered` up by at most 2, `langMismatch` not higher.
- R4: `labeled` at least R0d, `multiTurnChunks` equal to 0, `failed` equal to R0d. `D` and 3 clean runs decide 4.3.
- R5: `dupJoins` lower than R4 and `contiguousCuts` above 0 on R0. Otherwise the phase is dropped.
- A run that fails its rule stops the phase. The agent does not merge it. The agent asks the owner.

---

## 8. Open questions

None. Answered by the owner on 2026-10-06:
- The prompt names provider `server` as "your own server".
- New users get the Enhance choice in onboarding. Existing users get the one-time prompt after their first finished meeting, recorded or imported.
