# Folder batch runs, multi-select re-run, kept speaker names, summary history

Issue #372. Owner decisions of 2026-10-29. This spec records the rules that the code uses. The citations are for the tree of this branch.

## 1. Scope

- A folder page shows what its meetings still need: "to transcribe", "to summarize", "to enhance". It also shows apart the meetings that cannot run a stage.
- "Run on N" runs one stage on all the meetings of the folder that need it.
- A selection mode in the folder's meeting list runs one stage on the selected meetings (a re-run).
- A re-transcribe keeps the confirmed speaker names when the match is clear. It never moves a name to another speaker on a guess.
- A new summary keeps the old summary as a previous version. The meeting page shows the versions, read only. There is no restore.

## 2. The "needs stage" rules

One module defines the rules: `apps/server/src/lib/meetings/stage-needs.ts`. The folder counts, the folder batch and the stage checks of the queue use it. Each rule is one SQL expression over `meetings m`, so the folder list counts all stages in its one query.

| Stage | Needs it when | Cannot run when |
|---|---|---|
| Transcribe | `status` is `recorded`, `interrupted` or `failed`; or `status` is `transcribed`/`summarized` and a segment has `status = 'failed'` | `audio_dir` is NULL (the retention sweep deleted the audio) |
| Summarize | the meeting has transcript text and `status = 'transcribed'`; or `status = 'summarized'` and the summary is partial (PR #258) | no default AI model |
| Enhance | `status` is `transcribed`/`summarized`, the meeting has transcript text, and no segment has `enhanced_text` | no default AI model |

Notes:
- The save sets `summarized` only when it writes a summary. A transcript with no summary for it stays `transcribed`, also after a re-transcribe. So `status = 'transcribed'` means "the current transcript has no summary".
- "Transcript text" = a segment with non-empty `text`. The route can still refuse a meeting (an empty merged transcript). The queue then counts it as skipped ("could not start").
- `recording` and `transcribing` meetings never need a stage. A meeting whose job runs is "busy".
- A failed chunk counts as "needs transcribe". The batch runs a full transcription for it, not the retry of the failed chunks.

The folder response (`GET /api/meetings/folders`) adds `stage_counts: { transcribe, summarize, enhance }`, each `{ ready, blocked }`. `ready` = needs it and can run it. `blocked` = needs it and cannot run it.

## 3. The batch queue

`apps/server/src/lib/meetings/batch-queue.ts`, one instance per process (`routes/meetings.ts`).

- One FIFO list of (meeting, stage) items. It runs ONE item at a time. So the queue never runs two transcriptions at once: the local ASR worker serves one request at a time.
- Before a Transcribe item starts, the queue waits for a transcription that the user started on a meeting page.
- An item starts with the same function as its route (`startTranscribe`, `startLlmStage`), so the guards are the same. The queue waits for the job slot to be released (`waitForRelease` in `job-registry.ts`). A transcription hands its slot to the auto-run Enhance in the same tick: the wait ends with the transcription, and the next transcription can start while the LLM lane runs that Enhance.
- At its turn, an item is skipped with a reason: `gone`, `not_needed` (folder batches only), `busy`, `no_audio`, `no_transcript`, `no_llm`, `refused` (the route refused it). The state counts each reason.
- A selection batch (explicit ids) is a re-run: it does not apply the "needs" rule. It applies only the "cannot run" rules.
- Cancel drops the waiting items and asks the running job to stop with the normal cancel (`requestCancel`). The running item then counts as cancelled.
- The queue lives in memory. When the app quits, the waiting items are lost. The folder counts then show those meetings as still needed. The UI says this in the confirmation and in the progress card.
- An item that is already waiting or running is not added again.

Routes: `GET /api/meetings/batch` (state), `POST /api/meetings/batch` (`{stage, folder_id}` or `{stage, meeting_ids}`, 202 with the state; 400 bad body; 404 unknown folder), `POST /api/meetings/batch/cancel`.

## 4. Speaker names over a re-transcribe

Problem: a re-transcribe writes new segments, and the diarizer numbers the speakers again. Label "2" of the new run has no fixed relationship to label "2" of the old run (`specs/meeting-speaker-naming.md` 6.3). Before this change, the route deleted all names.

Investigation of the preferred way (reuse the old diarizer turns): `meeting_diarizer_turns` holds only the long turns (1 s or more) and no quality score (`applyDiarization` in `lib/meetings/diarize.ts`). The labels of the short turns (issue #259) need both. A re-transcribe from the stored turns would lose those labels. So the code does not reuse the turns. It uses the fallback rule, which works with any diarizer output.

Rule (`apps/server/src/lib/meetings/speaker-carry.ts`):
1. Before the delete, the route reads the old labeled system segments and the old `meeting_speakers` rows.
2. After the new run writes its labels, and before the status flip, the job computes `overlap(N, O)`: the time that the system segments of new label N and old label O share.
3. N takes the row of O (name, merge, suggestions) only when O has the largest overlap with N, and that overlap is at least 80% of all the overlap of N, and at least 80% of all the overlap of O. With 80% in both directions, the map is one to one.
4. Every other new label stays unnamed. A merge moves only when its target also has a match.
5. The confirmed names that have no match go in `meetings.speaker_names_lost` (JSON array). The meeting page shows them in a note. A speaker PATCH (the user names a speaker) clears the note.
6. The route writes all confirmed names into `speaker_names_lost` when the run starts. A crash, a cancel or a failure leaves that value, so the page never hides a lost name.

The re-transcribe confirmation lists the confirmed names and says the rule in short. The batch confirmation for Transcribe says it too.

## 5. Summary history

Schema 48 (`apps/server/src/lib/schema.ts`) adds:
- `meeting_summary_versions`: the columns of `meeting_summaries`, plus `id` (autoincrement) and `replaced_at`. It cascades with its meeting.
- `meetings.speaker_names_lost TEXT`.

The save (`workflow/nodes/save.ts`, SW3) copies the current summary row into `meeting_summary_versions` in the same transaction as the replace. `GET /api/meetings/:id/summary-versions` returns the versions, newest first. The Summary tab shows "Previous versions" under the summary. A click shows one version, read only.

The search index keeps only the current summary.

## 6. UI

- Folder page (`pages/meetings/folder-panel.tsx`, `batch.tsx`): the "Stages to run" card with one row per stage: "Need it: N", the blocked count with its reason, and "Run on N". A confirmation says what the stage does, that it runs one meeting at a time, and that the queue lives in memory.
- Selection mode: "Select" above the meeting list. Rows get check boxes. Shift-click selects a range. The bulk bar has the count, Select all / Clear, the stage picker, Run and Done.
- Progress: a card in the left rail, visible on every meetings view: stage, "n of N", the meeting in work, waiting/done/skipped/cancelled counts, the skip reasons, and "Cancel the rest". A finished batch stays until the user closes it.
- Meeting page: the re-transcribe confirmation, the "names not kept" note, and "Previous versions".
