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

Filters: `isHallucination` (known silence phrases) and, for the mic channel, `voicedMs < MIN_MIC_VOICED_MS`. There is no vocabulary prompt in this slice. The language is the first language of the language setting.

Rules for the single ASR worker:

- A tick is skipped while a dictation runs (`isDictationActive()`). The loop counts skipped ticks (`skippedTicks` in the live response).
- One tick runs at a time. If a tick takes longer than 2 s, the next tick reads the newest audio ("latest wins").

The live store (`live/store.ts`) is in memory only. It holds final lines and one partial for each channel. The entry is dropped when the recording stops. The final transcript of the meeting then replaces it. The live text is never merged into the final transcript. So there are no duplicate lines.

## 2. Model

Live ASR uses the **same model as the meeting setting** (`meeting_stt_model`, else the dictation voice model). The reason: the MLX ASR worker holds one model. A second model would stop and reload the worker at each tick.

Live transcript works only with the provider `local-mlx`, with the model downloaded and the worker present. In all other cases the live state is `unavailable` and the panel says so. The reason is in `reason`: `provider_not_local`, `worker_missing`, `model_missing` or the error text.

No new model is added to the catalog. The catalog has `qwen3-0.6b-8bit` (Apache-2.0) as the fast option.

The second pass with the strong model is the normal final pass after the stop. It does not change.

## 3. Chat LLM and memory

The chat is a new LLM task id: `liveChat` (`LLM_TASK_IDS`). Profile: temperature 0, no reasoning, 300 output tokens, 30 s timeout (120 s for the first call, which loads the model). The default assignment is the app default LLM. That is the dictation cleanup model by default, so both share one worker. The user can assign another model on the Models page. "Keep ready" for this task is off by default.

The chat answers only from a local model (the audio text stays on the Mac). A non-local model gives HTTP 409 with `reason: "not_local"`, and the panel shows "unavailable".

The chat call follows the light pattern of dictation cleanup: `resolveTaskCall`, `createChatModel`, `withLlmLane` (class `interactive`). The reply is one JSON object `{ "answer", "cites" }`. There is no token streaming. A reply that is not JSON becomes a plain answer with no cites.

The chat has no stored history. The panel sends the last 4 turns with each question. Closing the recording view drops the chat.

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
- If the sources do not hold the answer, the model must say "Not found in the sources." and cite nothing.

## 5. API and UI

| Route | Result |
|---|---|
| `GET /api/meetings/:id/live` | `{ status, reason?, lines[], skippedTicks }`. `status` is `off`, `starting`, `warming`, `ready` or `unavailable`. `off` means the setting is off, the meeting is not recording, or the id is unknown. Poll it every second. |
| `POST /api/meetings/:id/chat` | Body `{ question, history? }` (at most 4 turns). Result `{ answer, cites[], ms, cold, sourceTokens }`. Each cite has `label`, `kind` (`live`, `past`, `folder`), and `title`, `meetingId`, `timeMs` when known. Errors: 404 unknown meeting, 409 setting off or model not local, 413 question too long, 502 failure. |

UI (inside the recording card, hidden while the setting is off):

- `LiveTranscriptPanel`: final lines, one grey partial for each channel, a time and a source label (Me / Them). States: warming, unavailable.
- `LiveChatPanel`: input, messages, cite chips (live time, or past meeting title and time). A first answer that takes more than 3 s shows the "warming" text. A non-local model shows "unavailable".
- Settings, Meetings section: a switch "Live transcript and chat (experimental)".
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
- Live text is less exact than the final pass. It is not saved.
- No token streaming. No chat storage. No second ASR worker. No live diarization. No chat in the meeting detail view.
- The claim "30 minutes on a 16 GB Mac without memory pressure" is **not verified**. The test Mac has 128 GB. Section 6 gives the memory of a 10-minute run on this Mac only. The peak of 9.0 GB with the 1.7B ASR model and the chat model loaded together is a warning for a 16 GB Mac. A test on a 16 GB Mac is still open. Only English and one voice for each channel were tested.
