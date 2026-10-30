# Folder project page: the Overview (issue #374)

Status: Step A in PR for #374 (2026-10-29). Step B ("Where things stand") is in section 6.

Owner decisions: one page per folder. The page is "a curated, maintained and updated view of all important things going on in that project". The owner was away. The builder decided the open points. Each one is marked "Decision".

## 1. Goal

A folder is a project. The folder page gets an Overview tab. It shows what matters across all meetings of the folder: open action items, decisions, a timeline, people and tags. Code computes it from stored data on every read. No LLM call. The page is always current after a new meeting, a re-summarize or a move.

## 2. Server

Route: `GET /api/meetings/folders/:id/overview` in `apps/server/src/routes/meeting-folder-overview.ts`. Logic: `apps/server/src/lib/meetings/folder-overview.ts`. Schemas: `packages/validations/src/folder-overview.ts`.

The answer has: `folder` (id, name, description, color), `counts` (meetings, summarized, total duration, first and last date, stage counts from `stage-needs.ts`), `timeline`, `decisions`, `action_items`, `open_questions`, `people`, `tags`, `last_activity`.

### 2.1 Sources

- Decisions, action items and open questions: `meeting_summaries.summary_json`. A row with only `markdown` (older summaries) adds nothing to these lists. Its meeting still shows in the timeline.
- People: confirmed speaker names (`meeting_speakers.display_name`, not merged away) and calendar attendees (`meetings.calendar_attendees`). One person counts once for each meeting.
- Tags: `meeting_tags`.
- Timeline: the newest 100 meetings of the folder, newest first. `counts.meetings` holds the full number.

### 2.2 De-duplication (Decision)

Rule: the existing `sameItem` of `workflow/schemas.ts`. The same rule removes duplicates inside one summary. Two entries are the same when the text is equal (case and spaces aside), or when the share of the content words of the shorter entry that the other entry holds is at least 0.8 (0.7 when the shorter entry has 5 words or more). An entry with fewer than 3 content words only equals the same text.

Why not token Jaccard: the app already measured `sameItem` on real summaries (comment in `schemas.ts`). A second rule would give a different answer on the same text.

Grouping: code walks the meetings from oldest to newest. An entry joins the first group whose first (oldest) text it matches. Otherwise it starts a group. The group shows the oldest wording. Action items also need an owner and a due that agree (absent, or equal). The group takes the newest owner and due that exist.

Each group lists its source meetings (id, title, date), newest first. Groups are sorted by their newest source, newest first.

### 2.3 Done state of action items (Decision)

Table `folder_action_item_state` (schema version 49): `folder_id`, `item_key`, `done`, `updated_at`. Primary key (`folder_id`, `item_key`). Cascade on folder delete.

`item_key` = first 16 hex characters of SHA-256 over `<meeting id>\n<normalized task>`. The normalized task is lower case with single spaces. Each action item of each summary has one key.

A group has the key of its oldest member (`key`). Its other keys are `member_keys`. A group is done when any key of its members is marked done. Result:

- A later meeting that repeats the item joins the group. The key does not change. The done mark stays.
- A re-summarize of a meeting that writes the same task text keeps the key.
- A re-summarize that writes new text gives a new key. The item is open again. This is by design: the app cannot know that the new text means the same task.
- A move of the meeting out of the folder removes its items from the page. The mark stays in the table and applies again if the meeting returns.

Route: `PUT /api/meetings/folders/:id/action-items/:key` with `{ done: boolean }`. It answers `{ key, done }`. 404 `folder_not_found`. 404 `item_not_found` when no item of the folder has the key. 400 `invalid_request`. The mark is written for the group key and for every member key, so a later split of the group cannot reopen a marked item.

## 3. Renderer

`folder-panel.tsx` gets two tabs under the facts and stage card: Overview (default) and Meetings (the list that exists today). The component is `folder-overview.tsx`. Sections: Open action items (check box, owner, due, source links, a toggle "Show done"), Open questions, Decisions, Timeline, People, Tags. Every empty section has a short empty state. A source link opens the meeting. The stage needs and the Run buttons stay in the shared header (`FolderStageCard`).

The page loads the Overview when the tab opens, and again when the meeting list of the folder changes (a new meeting, a move, a re-summarize changes the list or its `updated` state). Strings: `meetings.folderOverview.*` in the 7 locales and `template.json`.

Small fix in the same PR: in selection mode, rows set `user-select: none`, so a shift-click does not highlight the row text.

## 4. Tests

- `apps/server/tests/folder-overview.test.ts`: the de-dup rule, grouping, owner and due merge, key stability, counts, timeline gist, people, tags, route 404, the PUT route, the mark that stays after a second read, the migration.
- `apps/electron/.../folder-overview-model.test.ts`: the split into open and done, the section helpers.

## 5. Not in scope

- A done flag that the LLM guesses from later meetings (the issue lists it as an option). Decision: only the user marks items done. A guess can be wrong, and a wrong "done" hides work.
- "Ask your history" (issue Step B, second item). It needs its own spec.

## 6. Step B: Where things stand

See section 6 of the final version of this file.
