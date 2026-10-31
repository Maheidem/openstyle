# Live transcript and chat during a recording

**Experimental. Default off.** Issue #375. Setting `live_chat_enabled`: only the value `"true"` turns it on. A missing row means off.

The owner was away when this was built (2026-10-29). The owner decisions of the issue are the input. The design decisions below were taken without the owner. Each one has a reason. The owner can reverse any of them.

## Contents

1. [Sources and window](#1-sources-and-window)
2. [Model](#2-model)
3. [Chat LLM and memory](#3-chat-llm-and-memory)
4. [Context builder](#4-context-builder)
5. [API and UI](#5-api-and-ui)
6. [Test plan](#6-test-plan)
7. [Limits](#7-limits)

## 1. Sources and window

The recorder writes two WAV files: `mic.wav` and `system.wav`. They grow while the recording runs. The WAV header says "0 bytes of data" until the recording stops (`buildWavHeader(0)`, patched at finalize). So the live reader does not use the header size. It reads the PCM from byte 44 (`WAV_HEADER_BYTES`) to the end of the file (`live/tail.ts`).

The recorder flushes PCM to disk every 5 s. With `live_chat_enabled` on, it flushes every 1 s (`LIVE_FLUSH_INTERVAL_MS`). The recorder reads the setting once, at the start of a recording.

The server starts one live loop in `POST /api/meetings/start` and stops it in `POST /api/meetings/:id/stop` and `POST /api/meetings/:id/interrupted`. The stop handler waits for the loop (at most 20 s) before it answers. The reason: there is one ASR worker, and the final pass must find it free.

Every 2 s, for each channel, the loop:

1. Reads the new PCM from the cursor (`committedMs`) to the end of the file.
2. Runs `segmentPcm` (default options) and the speech evidence (`annotateSpeechEvidence`).
3. Treats a segment that ended at least 800 ms before the end of the PCM as **closed**. The ASR model reads it once. The text is a **final** line. The cursor moves to the end of the segment.
4. Reads the **open tail** (the last, still growing segment) again at each tick. The text is the **partial** line of the channel. A new partial replaces the old one. The cursor does not move.
5. Cuts an open tail that is longer than 20 s at the quietest 20 ms frame between 12 s and 20 s.

Filters before the ASR model reads a segment (the same two gates as the full pass, `transcriber.ts` `transcribeChunk`):

- The Silero speech spans (`vad.ts`, `fluidaudio-diarize --vad`). The loop writes the new window of a channel to a temp WAV and runs the helper once for each tick (about 70 ms). A segment with no speech span is silence or noise. It is not read. This holds for both channels. When the helper or its model is missing, the loop uses only the next gate, as the full pass does.
- For the mic channel, `voicedMs < MIN_MIC_VOICED_MS`.

After the read, `isHallucination` (known silence phrases) drops the text. A window with no segment at all is not read, and the cursor moves to 2 s before the end of the window, so the window does not grow in a long silence.

There is no vocabulary prompt and no context prompt in the live loop. So a prompt echo on a quiet chunk cannot happen here.

**Language lock (owner decision 2026-10-30).** A short chunk with auto language can switch the language of the model (Portuguese speech came out in English). The loop locks the language:

1. The loop uses `meetings.language` when it is set, else the only language of the language setting.
2. Else (auto, or more than one language) the loop reads the first speech with auto language. After 20 s of speech it detects the language from the text of the lines (`tinyld`): one of the declared languages (`pickDeclaredLanguage`, the same choice as the full pass, `meetings/language.ts`), or, for auto, the best language that the model supports. With more than one declared language and no clear text, the first declared language wins, like the full pass.
3. From then on every read gets that language. The lines read before the lock are read again once with the locked language.
4. For more than one declared language, the locked language is saved to `meetings.language`. So the full pass reuses it. For auto it is not saved: the full pass keeps its own per-chunk auto choice.

A meeting with less than 20 s of speech stays on auto language.

Rules for the single ASR worker:

- A tick is skipped while a dictation runs (`isDictationActive()`). The loop counts skipped ticks (`skippedTicks` in the live response).
- One tick runs at a time. If a tick takes longer than 2 s, the next tick reads the newest audio ("latest wins").

The live store (`live/store.ts`) is in memory only. It holds final lines and one partial for each channel. At Stop the loop first reads the rest of the audio (the open tail too, at most 15 s). The route then saves the final lines as the transcript of the meeting and drops the entry (section 8). A full transcription replaces the live segments. Live lines and full segments are never merged. So there are no duplicate lines.

## 2. Model

Live ASR uses the **same model as the meeting setting** (`meeting_stt_model`, else the dictation voice model) when that model is local MLX. The reason: the MLX ASR worker holds one model. A second model would stop and reload the worker at each tick.

When the meeting model is not local MLX (Whisper, an own server, a cloud model), the final pass does not use the MLX worker. Then the live loop uses the dictation model, if that one is local MLX (`pickLiveAsrModel`). The worker keeps the dictation model, and nothing reloads.

Live transcript works only with the provider `local-mlx`, with the model downloaded and the worker present. In all other cases the live state is `unavailable` and the live view says why. The reason is in `reason`: `provider_not_local` (neither the meeting model nor the dictation model is local MLX), `worker_missing`, `model_missing` or the error text.

No new model is added to the catalog. The catalog has `qwen3-0.6b-8bit` (Apache-2.0) as the fast option.

The second pass with the strong model is the normal final pass after the stop. It does not change.

## 3. Chat LLM and memory

The chat is a new LLM task id: `liveChat` (`LLM_TASK_IDS`). Profile: temperature 0, no reasoning, 300 output tokens, 30 s timeout (120 s for the first call, which loads the model). The default assignment is the app default LLM. That is the dictation cleanup model by default, so both share one worker. The user can assign another model on the Models page. "Keep ready" for this task is off by default.

The chat answers only from a local model (the audio text stays on the Mac). A non-local model gives HTTP 409 with `reason: "not_local"`, and the panel shows "unavailable".

The chat call follows the light pattern of dictation cleanup: `resolveTaskCall`, `createChatModel`, `withLlmLane` (class `interactive`). The reply is one JSON object `{ "answer", "cites" }`. There is no token streaming. A reply that is not JSON becomes a plain answer with no cites.

The server saves the chat with the meeting (table `meeting_chat_messages`, schema 52, rows go with the meeting). Each answered question is saved as two rows, the question and the answer with its cites. The model sees the last 4 saved messages. The panel does not send a history. The chat so survives a click on another meeting, a page change and a restart of the page, and it can be read after Stop (a "Live chat" tab in the meeting detail).

Cause of the old loss: the messages were `useState` in `LiveChatPanel`, and the panel is mounted only while the right pane shows the live view (`pages/meetings/index.tsx`, `showLive`). Any click on another meeting or folder, and any page change, unmounted it. The restore of the selection (#383) brought the live view back, with an empty chat.

Memory numbers: see `specs/llm-runtime-tuning.md` for the LLM worker. Measured values for this feature are in section 6.

## 4. Context builder

Code builds the context. The model does not choose it. The budget is about 6000 tokens (`estimatePromptTokens`), cut to the context window of the model when it is known (`fitsWindow`).

| Block | Label | Size | Source |
|---|---|---|---|
| Rules | none | about 300 | `CHAT_SYSTEM_PROMPT` |
| Folder name and description | `[F]` | 300 | `meeting_folders` |
| 3 newest summaries of the folder | `[P#]` | 1200 | `meeting_summaries.markdown`, cut |
| Retrieved chunks | `[P#]` | 1500 | `retrieve` (summary and transcript kinds), `hitText` 320 chars |
| Live tail | `[L#]` | 2500 | the live store, newest lines kept, `mm:ss` |
| Question | none | rest | last in the prompt |

- Retrieval scope is the folder of the meeting, or `unfiled` for an unfiled meeting. The live meeting is excluded. The wait is at most 8 s. A search that is off or fails is skipped.
- When the whole context is too big, code drops past blocks first (retrieved chunks, then summaries). The live tail and the question stay.
- The reply must cite labels. Code drops every cite that is not in the source list. So an invented label never reaches the panel.
- If the sources do not hold the answer, the model must say "Not found in the sources." in the language of the question (for example "Não encontrei nas fontes.") and cite nothing. The call keeps the thinking mode of the model off, as before (`resolveTaskCall("liveChat")`: no reasoning).

## 5. API and UI

| Route | Result |
|---|---|
| `GET /api/meetings/:id/live` | `{ status, reason?, lines[], skippedTicks }`. `status` is `off`, `starting`, `warming`, `ready` or `unavailable`. `off` means the setting is off, the meeting is not recording, or the id is unknown. Poll it every second. |
| `GET /api/meetings/:id/chat` | `{ messages[] }`, oldest first. Each message has `id`, `role`, `content`, `cites[]`, `ms`, `createdAt`. It works also when the setting is off. 404 for an unknown meeting. |
| `POST /api/meetings/:id/chat` | Body `{ question }`. Result `{ answer, cites[], ms, cold, sourceTokens }`. The route saves the pair. Each cite has `label`, `kind` (`live`, `past`, `folder`), and `title`, `meetingId`, `timeMs` when known. Errors: 404 unknown meeting, 409 setting off or model not local, 413 question too long, 502 failure. |

UI (hidden while the setting is off). The live view fills the right pane (the meeting detail column). It is not in the small recording card:

- Auto-open: when a recording starts and the setting is on, the right pane shows the live view of that meeting. The user can click away. A click on the RECORDING row (list or folder tree), or on the "Open live view" link of the card, opens it again. The view shows only while the meeting records. After Stop the pane shows the normal meeting detail.
- Layout: header with the meeting title, the RECORDING badge and the timer. Two columns: the live transcript on the left, the chat on the right with the input at the bottom. When the pane is narrower than 32 rem, the columns stack (transcript on top).
- `LiveTranscriptPanel`: final lines, one grey partial for each channel, a time and a source label (Me / Them). It scrolls to the end. States: warming, unavailable (with the reason: `provider_not_local`, `model_missing`, `worker_missing`).
- `LiveChatPanel`: input, messages, cite chips (live time, or past meeting title and time). A first answer that takes more than 3 s shows the "warming" text. A non-local model shows "unavailable".
- The recording card keeps the timer, the mic and system levels and Stop. With the setting on it also has the "Open live view" link.
- Settings, Meetings section: a switch "Live transcript and chat (experimental)".
- After Stop: the meeting detail shows the status "Transcribed" and the mark "From live" next to it, and a "Live chat" tab when the meeting has chat messages.
- Strings: `meetings.liveChat.*` and `settings.meetings.liveChat*` in the 7 locales and the template. Models page row: `models.taskProfiles.liveChat`.

E2E seam: `OPENSTYLE_E2E_FAKE_MEETING_AUDIO=<16 kHz mono s16 WAV>`, with `OPENSTYLE_E2E=1` and `OPENSTYLE_E2E_FAKE_MEETING_CAPTURE=1`, streams the file in real time into the mic track. The system track stays silent.

## 6. Test plan

Unit tests:

- `apps/server/tests/live-transcript.test.ts`: the growing-WAV reader, tail planning, the store and the loop (cursor, partial replace, dictation skip, hallucination, unavailable, stop waits).
- `apps/server/tests/live-chat-context.test.ts`: labels, scope, budget drop, search off, reply parser.
- `apps/electron/src/main/meeting-recorder.test.ts`: 1 s flush with the setting on, the audio seam.

Real end-to-end proof (isolated app, fictional audio from the macOS speech tool, GPU lock, Mac with 128 GB, ASR `qwen3-1.7b-8bit`, chat model `gemma-4-e2b-qat-4bit`). Measured on 2026-10-30:

- Latency of 12 sentences, from the end of the speech to the text in `GET /live`: partial p50 1.2 s, p95 2.5 s; final p50 2.9 s, p95 4.0 s (targets: 5 s and 6 s). The panel polls once a second, so add up to 1 s on screen.
- Chat from the live tail: 246 ms with a warm model. The first call loads the model (4.2 s in the memory run).
- 10-minute run (fake audio, one chat): the app process stays at 231 to 247 MB. All processes together peak at 9.0 GB (ASR 2.5 GB, chat model 4.4 GB, search model 0.9 GB, renderers 0.9 GB) and fall to 6.3 GB when the models unload. No growth over the 10 minutes.

The proofs are:

1. Latency of 12 sentences: time from the end of the speech to the text in `GET /live` (partial and final), p50 and p95.
2. Chat from the live tail, with a live cite.
3. Chat from a past meeting of the folder, with a past cite.
4. A question with no answer gives "not found" and no cite.
5. Stop drops the live entry. The final pass writes `meeting_segments`. No duplicate live lines.
6. A dictation during live completes. Live ticks are skipped.
7. Setting off: no panel, no live loop, chat answers 409.
8. Screenshots in light and dark: off, partial, answer with chips, warming, unavailable.
9. A 10-minute run with the RSS of all processes every 5 s.

## 7. Limits

- Experimental. Off by default. The owner decides if it stays.
- One ASR worker. While a dictation runs, live text pauses.
- If the dictation model differs from the meeting model, a dictation reloads the worker. Live text then pauses until the meeting model loads again.
- Live text can differ from the full pass (section 8 has the measured word error). with the option on, Stop saves it as the transcript. "Re-transcribe" replaces it with the full pass.
- The language lock needs 10 s of speech. The first lines have auto language until then, and are read again once. A meeting that mixes two languages gets the language of its first 10 s for every later read, like the full pass does for a meeting with more than one declared language.
- The speech gate uses the Silero model of the app. A breath or a click that Silero marks as speech can still give a short word. The full pass has the same gap.
- No token streaming. No second ASR worker. No live diarization during the recording (the speaker pass runs after Stop).
- The claim "30 minutes on a 16 GB Mac without memory pressure" is **not verified**. The test Mac has 128 GB. Section 6 gives the memory of a 10-minute run on this Mac only. The peak of 9.0 GB with the 1.7B ASR model and the chat model loaded together is a warning for a 16 GB Mac. A test on a 16 GB Mac is still open. Only English and one voice for each channel were tested.

## 8. Keep the live transcript at Stop (option, default off)

Owner decision 2026-10-30: the live text can be kept at Stop. It is an option, **off by default**: setting `live_keep_transcript_at_stop` (only the value `"true"` turns it on), a switch in Settings, Meetings, next to the live chat switch. It has an effect only while `live_chat_enabled` is on. With the option off, Stop does what it did before: the meeting is `recorded`, with 0 segments, and the live text is dropped.

With the option on:

1. `POST /api/meetings/:id/stop` with `status: "recorded"` first stops the loop with `flush`: the loop reads the rest of the audio (the open tail too), for at most 15 s. Then the route saves the final lines as `meeting_segments` (`live/finish.ts`, one row for each line, `idx` for each channel in time order, `status` `ok`) and sets the meeting to `transcribed` with `transcript_source = 'live'` (schema 52). A stop with `status: "failed"`, or a meeting with no live line, saves nothing. The meeting stays `recorded`.
2. The meeting detail shows the status "Transcribed" and the mark "From live". The mark goes away when a full transcription replaces the segments (`startTranscribe` clears `transcript_source`).
3. "Re-transcribe" stays available. It runs the full pass and replaces the live segments, as for any transcript.
4. The steps that the live loop does not do run next, as a job of kind `diarize` that holds the job slot (`runLiveFinishJob`, `routes/meetings.ts`): the speaker pass on the system channel (`runDiarizer`, when the setting is on and `system.wav` exists), then the word-timing split of mixed chunks (`decideAlignPlan`, `runAlignPass`, the same code as the full pass) when the meeting has a declared language, else the speaker labels from the overlap (`applyDiarization`). Then the markdown export, and the auto-run Enhance and Summarize when that setting is on (`startAutoRun`, shared with the full pass). A failure keeps the live transcript as it is.

Why an option: see the measurement below. The live text is as good as the full pass on single-language audio, but worse on mixed-language audio.

### Measured, live text against the full pass (2026-10-30)

Fictional scripts (macOS voices Luciana and Samantha), 8 audio files of 82 to 183 s, with 15 to 45 s silences that hold room noise, clicks, breaths and typing. Real ASR model (`qwen3-1.7b-8bit`), language setting auto. Word error against the script, after Stop (`live`: the saved segments, `full`: after "Re-transcribe"):

| Audio | live | full |
|---|---|---|
| Portuguese, natural gaps (183 s) | 0.9 % | 1.8 % |
| Portuguese, 1 s gaps (155 s) | 0.5 % | 1.4 % |
| Portuguese, typing noise (179 s) | 1.4 % | 1.4 % |
| Portuguese, loud noise (119 s) | 1.4 % | 1.4 % |
| Portuguese, short phrases (82 s) | 5.3 % | 2.6 % |
| Portuguese, English terms (99 s) | 17.4 % | 14.5 % |
| Portuguese, far field with reverb (97 s) | 68.8 % | 64.5 % |
| Portuguese, far field, milder (102 s) | 42.0 % | 43.5 % |
| Mixed Portuguese and English (148 s) | 15.1 % (5.4 % in the app run) | 6.3 % |

Live is as good as the full pass, or better, on single-language audio, and worse by 3 points or less on the other single-language files. It is clearly worse only on the mixed file in one of the two runs: with the language locked to Portuguese, an English sentence that sits in the same segment as Portuguese is translated or dropped. The owner chose an option, default off. An idea for a later change if a mixed-language user needs it: for an auto-language meeting, read a segment again with auto language when the locked read has far fewer words than the speech time allows.

The language lock, before and after, on the same audio (lines in the wrong language; `x/y` is lines that the check could judge):

| Audio | final lines before | after | partial lines before | after |
|---|---|---|---|---|
| far field with reverb | 1/8 (Chinese) | 0/10 | 5/25 (Chinese) | 0/23 |
| far field, milder | 0/12 | 0/10 | 2/25 (Chinese) | 0/26 |
| the 6 other Portuguese files | 0 | 0 | 0 | 0 |
| mixed Portuguese and English | 1/15 | 0/14 | 2/39 | 4/37 (English translated) |

The silence gate. The old gate (voiced time of the mic only) sent noise segments to the model. A stub model that answers "x" to every segment that passes the gate shows it, with the real segmenter and the real Silero model on 5 of the files (`noise lines` are lines that touch no spoken sentence):

| Audio | noise lines before | after | model reads before | after |
|---|---|---|---|---|
| typing noise | 2 | 0 | 93 | 51 |
| loud noise | 3 | 0 | 64 | 18 |
| far field | 1 | 0 | 48 | 26 |
| far field, milder | 0 | 0 | 52 | 31 |
| natural gaps | 2 | 0 | 74 | 52 |

All spoken sentences were still covered after the change. With the real model, silences gave no final line before or after on these files. The invented words of the field test did not appear on synthetic noise. Two transient one-word partial lines ("sim") from a breath that Silero marks as speech showed in the after runs.

## 9. Live captions in the recording pill (option, default off)

Owner idea 2026-10-30: the small recording pill can show the live text like subtitles. Setting `live_captions_pill` (only the value `"true"` turns it on), a switch in Settings, Meetings, under the live transcript switch. It has an effect only while `live_chat_enabled` is on. With the option off, the pill is unchanged in size and behaviour.

- The pill is the window `pill.html` (`pages/app.tsx`, `pages/pill/meeting-capsule.tsx`). The tray popover does not show captions.
- Data path: the pill reads `GET /api/meetings/:id/live` once each second, the route of the live view. There is no second ASR pass and no new IPC for the text. The pill reads the two settings once, when the capsule mounts.
- Text: the newest final line (normal style) and the newest partial line (muted), at most one line height each. A line that is too long loses its start ("...").
- Hide: the captions hide when the text does not change for 8 s. A silence gives no new line, so the captions go away. The silence gate and the language lock are in the loop and need no special code.
- Window: the pill window is 160 x 60. While a caption is visible, main grows it to 360 x 96 around the anchored edge of the capsule (`pill:set-captions`, `setPillCaptions`), so the timer and Stop do not move. It shrinks 300 ms after the captions fade out. The failure card wins when both want room.
- Theme: the pill has one dark surface in both themes (`SURFACE`, `INK`), so the captions read on light and dark desktops.
