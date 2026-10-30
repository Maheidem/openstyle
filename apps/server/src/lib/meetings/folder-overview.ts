import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  FolderOverview,
  OverviewActionItem,
  OverviewSource,
} from "@openstyle/validations";
import { cutText, markdownParts } from "./folder-description.js";
import { stageCountColumns, stageCountsOf } from "./stage-needs.js";
import { sameItem } from "./workflow/schemas.js";

// The Overview of a folder (issue #374, specs/folder-project-page.md). Code
// computes it from stored data on every read. No LLM call.

/** Timeline entries, at most. `counts.meetings` holds the full number. */
export const OVERVIEW_TIMELINE_LIMIT = 100;
/** People in the answer, at most. */
export const OVERVIEW_PEOPLE_LIMIT = 30;
/** Characters of the gist of one meeting, at most. */
export const OVERVIEW_GIST_CHARS = 160;

// ---------------------------------------------------------------------------
// Items (code)
// ---------------------------------------------------------------------------

/** One list entry of one summary, before grouping. */
export interface RawItem {
  text: string;
  owner: string | null;
  due: string | null;
  source: OverviewSource;
}

/** Lower case, single spaces. The key and the same-text test use it. */
export function normalizeItemText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The key of one action item: 16 hex characters of SHA-256 over the meeting
 * id and the normalized task. A changed task text gives a new key.
 */
export function actionItemKey(meetingId: string, task: string): string {
  return createHash("sha256")
    .update(`${meetingId}\n${normalizeItemText(task)}`)
    .digest("hex")
    .slice(0, 16);
}

/** The numbers of a text, sorted. `sameItem` drops short words, so "force 6"
 * and "force 7" look the same to it. */
function numbersOf(text: string): string {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).sort().join(" ");
}

/** `sameItem`, and the two texts hold the same numbers. */
export function sameOverviewItem(a: string, b: string): boolean {
  return sameItem(a, b) && numbersOf(a) === numbersOf(b);
}

/** Two owners or two dues agree when one is absent or both are the same text. */
const agree = (a: string | null, b: string | null) =>
  a === null || b === null || normalizeItemText(a) === normalizeItemText(b);

export interface ItemGroup {
  /** The oldest wording. */
  text: string;
  /** The owner and due of the newest member that has one. */
  owner: string | null;
  due: string | null;
  /** Newest first. */
  sources: OverviewSource[];
  /** The keys of the members, oldest first. */
  keys: string[];
}

const startOf = (s: OverviewSource) => s.started_at ?? 0;

/**
 * Group the entries that say the same thing (`sameItem`). `items` must be
 * ordered from the oldest meeting to the newest. An entry joins the first
 * group whose oldest text it matches. With `byOwner`, the owner and the due
 * must also agree. Groups come back newest first, by their newest source (a tie: the group that started later).
 */
export function groupItems(
  items: readonly RawItem[],
  byOwner: boolean,
): ItemGroup[] {
  const groups: ItemGroup[] = [];
  for (const item of items) {
    const key = actionItemKey(item.source.meeting_id, item.text);
    const group = groups.find(
      (g) =>
        sameOverviewItem(g.text, item.text) &&
        (!byOwner || (agree(g.owner, item.owner) && agree(g.due, item.due))),
    );
    if (!group) {
      groups.push({
        text: item.text,
        owner: item.owner,
        due: item.due,
        sources: [item.source],
        keys: [key],
      });
      continue;
    }
    // Later items are newer, so their owner and due win.
    group.owner = item.owner ?? group.owner;
    group.due = item.due ?? group.due;
    if (!group.sources.some((s) => s.meeting_id === item.source.meeting_id)) {
      group.sources.push(item.source);
    }
    if (!group.keys.includes(key)) group.keys.push(key);
  }
  for (const g of groups) g.sources.sort((a, b) => startOf(b) - startOf(a));
  // A tie goes to the group that started later.
  return groups
    .reverse()
    .sort(
      (a, b) =>
        startOf(b.sources[0] as OverviewSource) -
        startOf(a.sources[0] as OverviewSource),
    );
}

// ---------------------------------------------------------------------------
// Reading the stored summaries
// ---------------------------------------------------------------------------

interface MeetingRow {
  id: string;
  title: string | null;
  started_at: number | null;
  duration_ms: number | null;
  calendar_attendees: string | null;
  summary_json: string | null;
  markdown: string | null;
  summary_created_at: number | null;
}

interface ParsedSummary {
  overview: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: { task: string; owner: string | null; due: string | null }[];
  openQuestions: string[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];

const textOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/** The lists of a stored summary object, or null when the JSON is not one. */
export function parseSummary(json: string | null): ParsedSummary | null {
  if (!json) return null;
  try {
    const s: unknown = JSON.parse(json);
    if (typeof s !== "object" || s === null) return null;
    const o = s as Record<string, unknown>;
    const items = Array.isArray(o.actionItems) ? o.actionItems : [];
    return {
      overview: typeof o.overview === "string" ? o.overview.trim() : "",
      keyPoints: strings(o.keyPoints),
      decisions: strings(o.decisions),
      actionItems: items.flatMap((a) => {
        const r = (a ?? {}) as Record<string, unknown>;
        const task = textOrNull(r.task);
        return task
          ? [{ task, owner: textOrNull(r.owner), due: textOrNull(r.due) }]
          : [];
      }),
      openQuestions: strings(o.openQuestions),
    };
  } catch {
    return null;
  }
}

/** The first sentence of a text. */
function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?。](?=\s|$)/su);
  return (m ? m[0] : text).trim();
}

/**
 * One line for the timeline: the first sentence of the overview, else the
 * first key point, else the first text line of a markdown-only summary.
 */
export function gistOf(
  summary: ParsedSummary | null,
  markdown: string | null,
): string | null {
  const fromMarkdown = !summary && markdown ? markdownParts(markdown)[0] : "";
  const text =
    (summary?.overview ? firstSentence(summary.overview) : "") ||
    summary?.keyPoints[0] ||
    fromMarkdown ||
    "";
  const line = text.replace(/\s+/g, " ").trim();
  return line ? cutText(line, OVERVIEW_GIST_CHARS) : null;
}

const attendeeNames = (json: string | null): string[] => {
  if (!json) return [];
  try {
    const list: unknown = JSON.parse(json);
    if (!Array.isArray(list)) return [];
    return list.flatMap((a) => {
      const r = (a ?? {}) as Record<string, unknown>;
      const name = textOrNull(r.name) ?? textOrNull(r.email);
      return name ? [name] : [];
    });
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// The Overview
// ---------------------------------------------------------------------------

interface FolderRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  meeting_count: number;
  first_meeting_at: number | null;
  last_meeting_at: number | null;
  total_duration_ms: number;
  need_transcribe: number;
  need_transcribe_no_audio: number;
  need_summarize: number;
  need_enhance: number;
}

/** The marked-done keys of a folder. */
function doneKeys(db: DatabaseSync, folderId: string): Set<string> {
  const rows = db
    .prepare(
      "SELECT item_key FROM folder_action_item_state WHERE folder_id = ? AND done = 1",
    )
    .all(folderId) as { item_key: string }[];
  return new Set(rows.map((r) => r.item_key));
}

/** The action item groups of a folder with their keys (the done route reads them). */
export function folderActionGroups(
  db: DatabaseSync,
  folderId: string,
): ItemGroup[] {
  return groupItems(collect(loadMeetings(db, folderId)).actions, true);
}

function loadMeetings(db: DatabaseSync, folderId: string): MeetingRow[] {
  return db
    .prepare(
      `SELECT m.id, m.title, m.started_at, m.duration_ms, m.calendar_attendees,
              s.summary_json, s.markdown, s.created_at AS summary_created_at
         FROM meetings m LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
        WHERE m.folder_id = ?
        ORDER BY COALESCE(m.started_at, m.created_at), m.id`,
    )
    .all(folderId) as unknown as MeetingRow[];
}

function collect(meetings: readonly MeetingRow[]) {
  const decisions: RawItem[] = [];
  const actions: RawItem[] = [];
  const questions: RawItem[] = [];
  for (const m of meetings) {
    const summary = parseSummary(m.summary_json);
    if (!summary) continue;
    const source: OverviewSource = {
      meeting_id: m.id,
      title: m.title,
      started_at: m.started_at,
    };
    for (const text of summary.decisions) {
      decisions.push({ text, owner: null, due: null, source });
    }
    for (const a of summary.actionItems) {
      actions.push({ text: a.task, owner: a.owner, due: a.due, source });
    }
    for (const text of summary.openQuestions) {
      questions.push({ text, owner: null, due: null, source });
    }
  }
  return { decisions, actions, questions };
}

/** Count the names per meeting. Names compare in lower case. */
function countPeople(
  db: DatabaseSync,
  folderId: string,
  meetings: readonly MeetingRow[],
): { name: string; meeting_count: number }[] {
  const perMeeting = new Map<string, Map<string, string>>();
  const add = (meetingId: string, name: string) => {
    const set = perMeeting.get(meetingId) ?? new Map<string, string>();
    const key = name.trim().toLowerCase();
    if (key && !set.has(key)) set.set(key, name.trim());
    perMeeting.set(meetingId, set);
  };
  const speakers = db
    .prepare(
      `SELECT sp.meeting_id, sp.display_name FROM meeting_speakers sp
         JOIN meetings m ON m.id = sp.meeting_id
        WHERE m.folder_id = ? AND sp.merged_into IS NULL
          AND sp.display_name IS NOT NULL AND sp.display_name <> ''`,
    )
    .all(folderId) as {
    meeting_id: string;
    display_name: string;
  }[];
  for (const s of speakers) add(s.meeting_id, s.display_name);
  for (const m of meetings) {
    for (const name of attendeeNames(m.calendar_attendees)) add(m.id, name);
  }
  const counts = new Map<string, { name: string; meeting_count: number }>();
  for (const names of perMeeting.values()) {
    for (const [key, name] of names) {
      const entry = counts.get(key) ?? { name, meeting_count: 0 };
      entry.meeting_count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .sort(
      (a, b) =>
        b.meeting_count - a.meeting_count || a.name.localeCompare(b.name),
    )
    .slice(0, OVERVIEW_PEOPLE_LIMIT);
}

/** The Overview of one folder, or null when the folder does not exist. */
export function buildFolderOverview(
  db: DatabaseSync,
  folderId: string,
): FolderOverview | null {
  const folder = db
    .prepare(
      `SELECT f.id, f.name, f.description, f.color, COUNT(m.id) AS meeting_count,
              MIN(m.started_at) AS first_meeting_at,
              MAX(m.started_at) AS last_meeting_at,
              COALESCE(SUM(m.duration_ms), 0) AS total_duration_ms,
              ${stageCountColumns}
         FROM meeting_folders f LEFT JOIN meetings m ON m.folder_id = f.id
        WHERE f.id = ? GROUP BY f.id`,
    )
    .get(folderId) as unknown as FolderRow | undefined;
  if (!folder) return null;

  const meetings = loadMeetings(db, folderId);
  const { decisions, actions, questions } = collect(meetings);
  const done = doneKeys(db, folderId);

  const tags = db
    .prepare(
      `SELECT t.name, COUNT(DISTINCT mt.meeting_id) AS meeting_count
         FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
         JOIN meetings m ON m.id = mt.meeting_id
        WHERE m.folder_id = ? GROUP BY t.id ORDER BY meeting_count DESC, t.name`,
    )
    .all(folderId) as { name: string; meeting_count: number }[];

  const newestFirst = [...meetings].reverse();
  const lastActivity = meetings.reduce<number | null>((best, m) => {
    const t = Math.max(m.started_at ?? 0, m.summary_created_at ?? 0);
    return t > (best ?? 0) ? t : best;
  }, null);

  return {
    folder: {
      id: folder.id,
      name: folder.name,
      description: folder.description,
      color: folder.color as FolderOverview["folder"]["color"],
    },
    counts: {
      meetings: folder.meeting_count,
      summarized: meetings.filter((m) => m.summary_json || m.markdown).length,
      total_duration_ms: folder.total_duration_ms,
      first_meeting_at: folder.first_meeting_at,
      last_meeting_at: folder.last_meeting_at,
      stage_counts: stageCountsOf(folder),
    },
    timeline: newestFirst.slice(0, OVERVIEW_TIMELINE_LIMIT).map((m) => ({
      meeting_id: m.id,
      title: m.title,
      started_at: m.started_at,
      duration_ms: m.duration_ms,
      gist: gistOf(parseSummary(m.summary_json), m.markdown),
    })),
    decisions: groupItems(decisions, false).map((g) => ({
      text: g.text,
      sources: g.sources,
    })),
    action_items: groupItems(actions, true).map(
      (g): OverviewActionItem => ({
        key: g.keys[0] as string,
        text: g.text,
        owner: g.owner,
        due: g.due,
        done: g.keys.some((k) => done.has(k)),
        sources: g.sources,
      }),
    ),
    open_questions: groupItems(questions, false).map((g) => ({
      text: g.text,
      sources: g.sources,
    })),
    people: countPeople(db, folderId, meetings),
    tags,
    last_activity: lastActivity,
  };
}

/**
 * Mark the action item with `key` done or open. The mark goes to the key of
 * the group and to every member key, so a later split of the group keeps it.
 * Returns false when no item of the folder has the key.
 */
export function setActionItemDone(
  db: DatabaseSync,
  folderId: string,
  key: string,
  isDone: boolean,
  now: number,
): boolean {
  const group = folderActionGroups(db, folderId).find((g) =>
    g.keys.includes(key),
  );
  if (!group) return false;
  const upsert = db.prepare(
    `INSERT INTO folder_action_item_state (folder_id, item_key, done, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(folder_id, item_key) DO UPDATE SET done = excluded.done,
       updated_at = excluded.updated_at`,
  );
  for (const k of group.keys) upsert.run(folderId, k, isDone ? 1 : 0, now);
  return true;
}
