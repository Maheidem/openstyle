# Folder description: suggest from the folder's meetings (issue #373)

Status: built in PR #377 (2026-10-29). Owner decision: the owner reviews the text. The app never saves it alone.

## 1. Goal

The folder description goes into the Enhance and Summarize prompts (`apps/server/src/lib/meetings/workflow/nodes/prepare.ts`, `prompts.ts` `promptContextWithFolder`). Many users leave it empty. A "Suggest" button writes a first draft from the stored summaries of the folder's meetings. The user edits the draft and saves it.

## 2. User flow

1. The user opens a folder and clicks "Add a description" or "Edit".
2. The user clicks "Suggest". The button shows a spinner and "Writing…". The text field and Save are disabled.
3. The server answers. The text field shows the suggestion. Nothing is saved.
4. The user edits the text and clicks Save (`PATCH /api/meetings/folders/:id`, as before). Cancel drops the text.

Error messages (under the buttons, `role="alert"`):

| Server code | Message |
|---|---|
| `no_summaries` (409) | No meeting in this folder has a summary. Summarize a meeting first. |
| `no_llm` (409) | No AI model is set up. Add one in Settings > Models. |
| `llm_failed` (502) | Could not write a description. Try again. |
| `folder_not_found` (404) | This folder no longer exists. |

Closing the editor aborts the request. The server passes the request signal to the gateway, so the model call stops too.

## 3. Server

Route: `POST /api/meetings/folders/:id/suggest-description` in `apps/server/src/routes/meeting-folder-suggest.ts`, mounted next to the folder routes in `routes/meetings.ts`. It is a separate file, so the folder routes stay small. The answer is synchronous: `{ description, meeting_count }`. Schemas: `packages/validations/src/folder-description.ts`.

Logic: `apps/server/src/lib/meetings/folder-description.ts`.

### 3.1 Code does the rule-like work

- Input: the stored summaries of the newest 40 summarized meetings of the folder (`FOLDER_DESCRIPTION_MAX_MEETINGS`), newest first. No transcript.
- One note per meeting: `- <title>: <overview>; <key points>; <decisions>`, cut at a word end to 600 characters. Action items and open questions stay out: they are tasks, not the project. A row with only `markdown` (older summaries) uses its plain text lines.
- Language: the most common `meetings.language` of the notes. A tie goes to the newer meeting. The prompt names the ISO code. No language: "Write in the language of the notes."
- Budget: at most 1500 input tokens of notes per call (`FOLDER_DESCRIPTION_MAX_INPUT_TOKENS`), less when the context window is small. Output budget 300 tokens.
- Clean-up of the answer: one line, no wrapping quotes, at most 3 sentences, at most 600 characters (`FOLDER_DESCRIPTION_SUGGEST_MAX_CHARS`).

### 3.2 One narrow LLM job

The job: "write a short description of one project from these notes" (1 to 3 sentences, at most 60 words, goal, subject and main topics, keep names and terms, no single meetings, dates, tasks or decisions). Structured output `{ "description": string }` (schema `folder_description` v1). The gateway rules apply: strict structured output, a non-stop finish reason is a typed error, one retry in `callUnit`.

### 3.3 Map-reduce

When all notes fit one call's budget: one call. Otherwise code packs the notes into groups in order (each group fits the budget). The SAME job runs on each group (map, step keys `map/<pass>/<n>`). Then the same job runs on the group answers (reduce, step key `reduce`). The job is the same in both stages, so the app has one prompt and one set of tests. At most 3 map passes; 40 notes need one.

### 3.4 Model and task id

The call uses the task `meetingSummarize` and the step profile of `summarize` (reasoning off). Why: the job is the same kind of work as Summarize (prose from meeting notes), and the user already chose a model and a preset for it. A new task id would add a settings row, a preset assignment and strings for one small button. If the bench later shows that this job needs other parameters, a new task id is a small follow-up.

### 3.5 Call record

Every call is in `llm_calls`, under a run with scope `folder`, `scope_id` = the folder id, kind `folderDescription`, node `folderDescription`. Only the newest 50 folder runs stay (`FOLDER_RUNS_KEPT`), as dictation keeps its newest 200. A crash leaves a `running` run without a checkpoint. The boot sweep marks it `failed`, so it never resumes. The meeting LLM inspector does not show folder runs.

Type changes for this: `LlmScope` gets `"folder"`; the gateway step type is `GatewayStepId = LlmStepId | FolderStepId`. `LlmStepId` itself does not change, so the meeting workflow (`resolveModels`, `STEP_TASK`) does not change.

## 4. Renderer

`apps/electron/src/renderer/src/pages/meetings/folder-description-suggest.tsx`: the button, the request, the error mapping. `folder-panel.tsx` gets one import, one state (`suggesting`) and the button in the editor row. Strings: `meetings.folderSuggest.*` in the 7 locales and `template.json`.

## 5. Tests

- `apps/server/tests/folder-description.test.ts`: note building (summary JSON, markdown fallback, empty, cut), language pick, grouping, budget, answer clean-up, prompt; route 404, 409 `no_summaries` (empty folder and folder with no summary), 409 `no_llm`, small folder (one call, newest first, other folders out, action items out, nothing saved, run and call recorded), large folder (45 meetings: only 40 used, several map calls, one reduce over the map answers, each map input within the cap), 502 `llm_failed` after a cut answer twice.
- `apps/electron/src/renderer/src/pages/meetings/folder-description-suggest.test.ts`: error code to message key.
- E2E proof in the isolated app with Gemma 4 E2B: see section 6.

## 6. Bench note (2026-10-29)

Setup: the real app in quiet mode through the Test Runner, isolated profile, scratch HF cache, the installed MLX worker, the shared GPU lock. Model: Gemma 4 E2B (`local-mlx-llm/gemma-4-e2b-qat-4bit`, served as `mlx-community/gemma-4-E2B-it-qat-4bit`), the default local model. All meeting data is fictional.

| Folder | Meetings | Calls | Input tokens per call | Output tokens | Model time per call | Click to text |
|---|---|---|---|---|---|---|
| Harbor app (small) | 4 | 1 (`reduce`) | 372 | 67 | 519-535 ms | 0.8-1.9 s |
| Orchard logistics (large) | 40 | 4 map + 1 reduce | 1367-1400 (map), 449 (reduce) | 59-79 | 456-669 ms | 2.9 s |
| Garden club (empty) | 0 | 0 | - | - | - | 409 `no_summaries` message |

Every call ended with finish `stop` and no error. The same input gave the same text in two runs.

Output, small folder:

> Harbor is a mobile app designed to send tide and storm alerts to small boat owners. The project involves planning a closed beta for 50 boat owners, developing push alert texts, and reviewing tide sensor data from buoys. The app will be built using React Native and targets the spring sailing season.

Output, large folder (map-reduce):

> This project manages Orchard logistics, focusing on fruit handling and distribution. Key topics include export paperwork for cherry shipments to the port of Westhaven, tracking crate counts per orchard block, and monitoring cold storage temperature logs for the apple warehouse in Valley Ridge. The project also involves managing contracts with supermarket chains and tracking pear harvest forecasts.

Quality (judged by Claude against the seeded notes, not blind, not by the owner): both texts are correct and stay on the project. Both have 3 sentences and keep the names (Harbor, React Native, Westhaven, Valley Ridge). The small text repeats one decision ("built using React Native") against the "no decisions" rule. That is acceptable for a draft that the user edits. The large text names 5 of the 8 seeded topics. The owner is the final judge: the text is a draft and is never saved without the user.
