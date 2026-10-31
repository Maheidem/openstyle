import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { actionItemKey, parseSummary } from "../meetings/folder-overview.js";
import { normalizeText } from "./cites.js";
import { parseDates } from "./dates.js";
import {
  folderStatusArgs,
  getMeetingSummaryArgs,
  getTranscriptWindowArgs,
  listActionItemsArgs,
  listDecisionsQuestionsArgs,
  listMeetingsArgs,
  listPeopleArgs,
  proposeActionItemChangeArgs,
  proposeMergePeopleArgs,
  proposeMoveArgs,
  proposeRetagArgs,
  READ_TOOL_NAMES,
  type ReadToolName,
  searchChunksArgs,
  WRITE_TOOL_NAMES,
  type WriteToolName,
} from "./tool-schemas.js";
import { listPeopleInScope } from "./tools.js";
import type { TurnScope, Validated } from "./types.js";

// The closed choices of a turn and the native tool calls (specs/
// meeting-chat-agent.md 2.3 stage 2b and 3.1). Code builds the lists. The
// model picks a label or an id from a list. Code validates the pick. A date is
// never a model value: it comes from `parseDates` on the question.

export type ToolName = ReadToolName | WriteToolName;

/** A tool call at the id level: the shape that `runTool` reads. */
export interface ToolCall {
  tool: ToolName;
  args: unknown;
}

export interface PersonChoice {
  /** The normalized full display name (`listPeopleInScope`). */
  id: string;
  name: string;
}
export interface ItemChoice {
  /** A1..A8. */
  label: string;
  /** `actionItemKey(meetingId, task)`. */
  id: string;
  text: string;
}
export interface MeetingChoice {
  /** M1..M12. */
  label: string;
  id: string;
  /** `title (yyyy-mm-dd)`. */
  text: string;
}
export interface FolderChoice {
  id: string;
  name: string;
}

export interface ChoiceLists {
  people: PersonChoice[];
  items: ItemChoice[];
  meetings: MeetingChoice[];
  folders: FolderChoice[];
}

/** The lists plus the ids of all meetings of the scope (for the scope check). */
export interface Choices extends ChoiceLists {
  scopeMeetingIds: ReadonlySet<string>;
}

export const PEOPLE_MAX = 30;
export const ITEMS_MAX = 8;
export const MEETINGS_MAX = 12;
export const FOLDERS_MAX = 30;
/** At most 8 tools are visible per turn (spec 3.1 rule 4). */
export const TOOLS_VISIBLE = 8;
export const QUERY_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

interface ScopeMeetingRow {
  id: string;
  title: string | null;
  started_at: number | null;
  folder_id: string | null;
  summary_json: string | null;
}

function scopeRows(db: DatabaseSync, scope: TurnScope): ScopeMeetingRow[] {
  const select = `SELECT m.id, m.title, m.started_at, m.folder_id, s.summary_json
                    FROM meetings m LEFT JOIN meeting_summaries s ON s.meeting_id = m.id`;
  const order = "ORDER BY COALESCE(m.started_at, m.created_at) DESC, m.id";
  if (scope.kind === "meeting") {
    return db
      .prepare(`${select} WHERE m.id = ? ${order}`)
      .all(scope.id) as unknown as ScopeMeetingRow[];
  }
  if (scope.kind === "folder") {
    return db
      .prepare(`${select} WHERE m.folder_id = ? ${order}`)
      .all(scope.id) as unknown as ScopeMeetingRow[];
  }
  return db.prepare(`${select} ${order}`).all() as unknown as ScopeMeetingRow[];
}

/** The calendar day of a start time, UTC (like `parseDates`). */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Build the lists
// ---------------------------------------------------------------------------

function wordSet(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter((w) => w.length > 2),
  );
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

const MONTH_LOCALES = ["en", "pt", "es", "de", "fr", "it"];
/** Month names of one month in six languages, folded. */
function monthWords(ms: number): string {
  const d = new Date(ms);
  const names = MONTH_LOCALES.map((l) =>
    d.toLocaleString(l, { month: "long", timeZone: "UTC" }),
  );
  return `${d.getUTCDate()} ${names.join(" ")}`;
}

/** Open action items of the meetings, ranked by word overlap with the question. */
function openItems(
  db: DatabaseSync,
  rows: readonly ScopeMeetingRow[],
  qw: Set<string>,
): ItemChoice[] {
  const done = new Set(
    (
      db
        .prepare(
          "SELECT folder_id, item_key FROM folder_action_item_state WHERE done = 1",
        )
        .all() as { folder_id: string; item_key: string }[]
    ).map((r) => `${r.folder_id}\n${r.item_key}`),
  );
  const found: { id: string; text: string; score: number }[] = [];
  for (const m of rows) {
    const summary = parseSummary(m.summary_json);
    if (!summary) continue;
    for (const a of summary.actionItems) {
      const id = actionItemKey(m.id, a.task);
      if (m.folder_id && done.has(`${m.folder_id}\n${id}`)) continue;
      found.push({ id, text: a.task, score: overlap(qw, wordSet(a.task)) });
    }
  }
  return found
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, ITEMS_MAX)
    .map((x, i) => ({ label: `A${i + 1}`, id: x.id, text: x.text }));
}

/**
 * The closed choices of a turn (spec 2.3, slot table). The question and the
 * earlier questions of the thread rank the lists. A meeting inside the date
 * range of the question ranks first.
 */
export function buildChoices(
  db: DatabaseSync,
  scope: TurnScope,
  text: string,
  priorQuestions: string[],
  todayMs: number,
): Choices {
  const qw = wordSet(`${text} ${priorQuestions.join(" ")}`);
  const rows = scopeRows(db, scope);
  const range = parseDates(text, todayMs);

  const people = listPeopleInScope(db, scope)
    .map((p) => ({ p, score: overlap(qw, wordSet(p.name)) }))
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, PEOPLE_MAX)
    .map((x) => ({ id: x.p.id, name: x.p.name }));

  const meetings = rows
    .map((m) => {
      const day = m.started_at === null ? null : dayOf(m.started_at);
      const inRange =
        day !== null &&
        range.dateFrom !== null &&
        range.dateTo !== null &&
        day >= range.dateFrom &&
        day <= range.dateTo;
      const dateWords = m.started_at === null ? "" : monthWords(m.started_at);
      const score =
        overlap(qw, wordSet(`${m.title ?? ""} ${dateWords}`)) +
        (inRange ? 3 : 0);
      return { m, day, score };
    })
    .sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id))
    .slice(0, MEETINGS_MAX)
    .map((x, i) => ({
      label: `M${i + 1}`,
      id: x.m.id,
      text: `${x.m.title ?? "Untitled"}${x.day ? ` (${x.day})` : ""}`,
    }));

  const folders = (
    db
      .prepare("SELECT id, name FROM meeting_folders ORDER BY name")
      .all() as unknown as FolderChoice[]
  )
    .map((f) => ({ f, score: overlap(qw, wordSet(f.name)) }))
    .sort((a, b) => b.score - a.score || a.f.name.localeCompare(b.f.name))
    .slice(0, FOLDERS_MAX)
    .map((x) => ({ id: x.f.id, name: x.f.name }));

  return {
    people,
    items: openItems(db, rows, qw),
    meetings,
    folders,
    scopeMeetingIds: new Set(rows.map((r) => r.id)),
  };
}

// ---------------------------------------------------------------------------
// Dates and query by code
// ---------------------------------------------------------------------------

/** The date range of the question, from code. The model never gives a date. */
export function datesFromQuestion(
  question: string,
  todayMs: number,
): { date_from: string | null; date_to: string | null } {
  const r = parseDates(question, todayMs);
  return { date_from: r.dateFrom, date_to: r.dateTo };
}

const cut = (s: string, n: number) => s.slice(0, n).trim();

/**
 * The search query. Empty or longer than 200 characters: the question text,
 * cut to 200 characters (spec 2.3, slot `query`).
 */
export function queryFor(
  candidate: string | null | undefined,
  question: string,
): string {
  const q = (candidate ?? "").trim();
  if (q && q.length <= QUERY_MAX_CHARS) return q;
  return cut(question.trim(), QUERY_MAX_CHARS) || "meeting";
}

// ---------------------------------------------------------------------------
// Id-level argument schemas
// ---------------------------------------------------------------------------

const ID_SCHEMAS: Record<ToolName, z.ZodType> = {
  search_chunks: searchChunksArgs,
  get_meeting_summary: getMeetingSummaryArgs,
  list_action_items: listActionItemsArgs,
  list_decisions_questions: listDecisionsQuestionsArgs,
  list_people: listPeopleArgs,
  get_transcript_window: getTranscriptWindowArgs,
  folder_status: folderStatusArgs,
  list_meetings: listMeetingsArgs,
  propose_action_item_change: proposeActionItemChangeArgs,
  propose_retag: proposeRetagArgs,
  propose_move: proposeMoveArgs,
  propose_merge_people: proposeMergePeopleArgs,
};

/** Tools whose args have `date_from` and `date_to`. */
const DATE_TOOLS = new Set<ToolName>([
  "search_chunks",
  "list_action_items",
  "list_decisions_questions",
  "list_meetings",
]);
export const hasDateArgs = (tool: ToolName): boolean => DATE_TOOLS.has(tool);

export const isToolName = (name: string): name is ToolName =>
  (READ_TOOL_NAMES as readonly string[]).includes(name) ||
  (WRITE_TOOL_NAMES as readonly string[]).includes(name);

/** Parse id-level args with the zod schema of the tool. */
export function parseToolArgs(
  tool: ToolName,
  args: unknown,
): Validated<Record<string, unknown>> {
  const r = ID_SCHEMAS[tool].safeParse(args);
  if (!r.success) {
    const i = r.error.issues[0];
    return {
      ok: false,
      reason:
        `bad_args: ${i?.path.join(".") || "args"} ${i?.message ?? ""}`.trim(),
    };
  }
  return { ok: true, args: r.data as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Native tool definitions
// ---------------------------------------------------------------------------

export interface NativeTool {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

const labelsOf = (xs: readonly { label: string }[]) => xs.map((x) => x.label);

function def(
  name: ToolName,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): NativeTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

/** The tools that a native turn shows (coordinator decision). */
export function visibleToolNames(
  scopeKind: "meeting" | "folder" | "all",
  write: boolean,
): (ReadToolName | WriteToolName)[] {
  if (write) return [...WRITE_TOOL_NAMES];
  const base: ReadToolName[] = [
    "search_chunks",
    "get_meeting_summary",
    "list_action_items",
    "list_decisions_questions",
  ];
  if (scopeKind === "meeting") return [...base, "get_transcript_window"];
  return [
    ...base,
    "list_people",
    "get_transcript_window",
    ...(scopeKind === "folder" ? (["folder_status"] as const) : []),
    "list_meetings",
  ];
}

/** All definitions that the choices allow. A tool with an empty closed list is left out. */
function allDefs(ch: Choices): Partial<Record<ToolName, NativeTool>> {
  const meeting = ch.meetings.length
    ? { type: "string", enum: labelsOf(ch.meetings) }
    : null;
  const person = ch.people.length
    ? { type: "string", enum: ch.people.map((p) => p.id) }
    : null;
  const out: Partial<Record<ToolName, NativeTool>> = {
    search_chunks: def(
      "search_chunks",
      "Search the meeting text by meaning",
      {
        query: { type: "string", description: "short standalone search text" },
        ...(meeting ? { meeting } : {}),
      },
      ["query"],
    ),
    list_action_items: def("list_action_items", "List action items", {
      ...(person ? { person } : {}),
      status: { type: "string", enum: ["open", "done", "all"] },
      ...(meeting ? { meeting } : {}),
    }),
    list_decisions_questions: def(
      "list_decisions_questions",
      "List decisions or open questions",
      {
        kind: { type: "string", enum: ["decision", "open_question"] },
        ...(meeting ? { meeting } : {}),
      },
      ["kind"],
    ),
    list_people: def("list_people", "List the people", {
      query: { type: "string" },
    }),
    folder_status: def("folder_status", "Show where the project stands"),
    list_meetings: def("list_meetings", "List the meetings", {
      tag: { type: "string" },
    }),
  };
  if (meeting) {
    out.get_meeting_summary = def(
      "get_meeting_summary",
      "Read the summary of one meeting",
      { meeting },
      ["meeting"],
    );
    out.get_transcript_window = def(
      "get_transcript_window",
      "Read the transcript lines of one meeting",
      { meeting },
      ["meeting"],
    );
    out.propose_move = def(
      "propose_move",
      "Propose to move one meeting to a folder",
      {
        meeting,
        ...(ch.folders.length
          ? { folder: { type: "string", enum: ch.folders.map((f) => f.id) } }
          : {}),
      },
      ch.folders.length ? ["meeting", "folder"] : ["meeting"],
    );
  }
  if (ch.items.length) {
    out.propose_action_item_change = def(
      "propose_action_item_change",
      "Propose to close or reopen one action item",
      {
        item: { type: "string", enum: labelsOf(ch.items) },
        done: { type: "boolean" },
      },
      ["item", "done"],
    );
  }
  out.propose_retag = def(
    "propose_retag",
    "Propose to add a tag to meetings",
    {
      tag: { type: "string" },
      ...(meeting
        ? { meetings: { type: "array", items: meeting, maxItems: 20 } }
        : {}),
    },
    ["tag"],
  );
  if (person) {
    out.propose_merge_people = def(
      "propose_merge_people",
      "Propose to merge the name variants of one person",
      { person },
      ["person"],
    );
  }
  return out;
}

/**
 * The native tools of a turn, for the tool names given. At most 8 are shown
 * (spec 3.1 rule 4). The 5-tool cap for read-only turns is not used: the
 * coordinator chose the lists of `visibleToolNames`. Dates are not a
 * parameter: code sets them.
 */
export function nativeToolDefs(
  choices: Choices,
  names: (ReadToolName | WriteToolName)[],
): NativeTool[] {
  const defs = allDefs(choices);
  const wanted = [...new Set(names)]
    .map((n) => defs[n])
    .filter((d): d is NativeTool => d !== undefined);
  return wanted.slice(0, TOOLS_VISIBLE);
}

// ---------------------------------------------------------------------------
// Validate a native call
// ---------------------------------------------------------------------------

export interface NativeEnv {
  choices: Choices;
  scope: TurnScope;
  /** Tool names that the plan allows. */
  allowed: string[];
  question: string;
  todayMs: number;
}

const NONE_VALUES = new Set(["", "none", "null"]);

/** Drop null, empty and "none" values: the model says "no value" in these ways. */
function withoutNone(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && NONE_VALUES.has(v.trim().toLowerCase()))
      continue;
    out[k] = v;
  }
  return out;
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** The model args at the label level, per tool. Unknown keys (dates) are dropped. */
function labelSchema(tool: ToolName, ch: Choices): z.ZodType | null {
  const pick = (labels: string[], what: string) =>
    z.string().refine((v) => labels.includes(v), `unknown ${what}`);
  const meeting = pick(labelsOf(ch.meetings), "meeting label");
  const person = pick(
    ch.people.map((p) => p.id),
    "person id",
  );
  switch (tool) {
    case "search_chunks":
      return z.object({
        query: z.string().optional(),
        meeting: meeting.optional(),
      });
    case "get_meeting_summary":
    case "get_transcript_window":
      return z.object({ meeting });
    case "list_action_items":
      return z.object({
        person: person.optional(),
        status: z.enum(["open", "done", "all"]).optional(),
        meeting: meeting.optional(),
      });
    case "list_decisions_questions":
      return z.object({
        kind: z.enum(["decision", "open_question"]),
        meeting: meeting.optional(),
      });
    case "list_people":
      return z.object({ query: z.string().optional() });
    case "folder_status":
      return z.object({});
    case "list_meetings":
      return z.object({ tag: z.string().optional() });
    case "propose_action_item_change":
      return z.object({
        item: pick(labelsOf(ch.items), "item label"),
        done: z.boolean(),
      });
    case "propose_retag":
      return z.object({
        tag: z.string(),
        meetings: z.array(meeting).max(20).optional(),
      });
    case "propose_move":
      return z.object({
        meeting,
        folder: pick(
          ch.folders.map((f) => f.id),
          "folder id",
        ),
      });
    case "propose_merge_people":
      return z.object({ person });
    default:
      return null;
  }
}

const idOfMeeting = (ch: Choices, label: string | undefined) =>
  ch.meetings.find((m) => m.label === label)?.id;

/** Turn parsed label values into id-level args. Dates and query come later. */
function toIdArgs(
  tool: ToolName,
  a: Record<string, unknown>,
  ch: Choices,
  env: NativeEnv,
): Record<string, unknown> {
  const meetingId = idOfMeeting(ch, text(a.meeting));
  switch (tool) {
    case "search_chunks":
      return {
        query: text(a.query),
        meeting_ids: meetingId ? [meetingId] : undefined,
      };
    case "get_meeting_summary":
      return { meeting_id: meetingId };
    case "get_transcript_window":
      // Code sets the window. The pipeline narrows it to the best hit.
      return { meeting_id: meetingId, from_ms: 0, to_ms: 180_000 };
    case "list_action_items":
      return { status: a.status, person_id: a.person, meeting_id: meetingId };
    case "list_decisions_questions":
      return { kind: a.kind, meeting_id: meetingId };
    case "list_people":
      return { query: text(a.query) };
    case "folder_status":
      return {};
    case "list_meetings":
      return { tag: text(a.tag) };
    case "propose_action_item_change":
      return {
        item_id: ch.items.find((i) => i.label === a.item)?.id,
        done: a.done,
      };
    case "propose_retag": {
      const labels = (a.meetings as string[] | undefined) ?? [];
      let ids = labels.flatMap((l) => idOfMeeting(ch, l) ?? []);
      if (ids.length === 0) {
        // No meeting named: the meetings of the choices inside the date range
        // of the question (dates come from code).
        const r = datesFromQuestion(env.question, env.todayMs);
        if (r.date_from && r.date_to) {
          ids = ch.meetings
            .filter((m) => {
              const day = /\((\d{4}-\d{2}-\d{2})\)$/.exec(m.text)?.[1];
              return (
                day !== undefined &&
                day >= (r.date_from as string) &&
                day <= (r.date_to as string)
              );
            })
            .map((m) => m.id);
        }
      }
      return { meeting_ids: ids, tag: text(a.tag) };
    }
    case "propose_move":
      return { meeting_id: meetingId, folder_id: a.folder };
    case "propose_merge_people":
      return { person_ids: [a.person] };
    default:
      return {};
  }
}

/** Every meeting id in the args. Used by the scope check. */
function meetingIdsOf(args: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (typeof args.meeting_id === "string") ids.push(args.meeting_id);
  if (Array.isArray(args.meeting_ids))
    for (const x of args.meeting_ids) if (typeof x === "string") ids.push(x);
  return ids;
}

function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  );
}

/**
 * Code validation of one native call (P0 report, decision 2). An unknown
 * label, an unknown id or an id outside the scope is an error and is never
 * repaired. Dates are set by code. The query is the question when it is empty
 * or too long.
 */
export function validateNativeCall(
  call: { name: string; args: Record<string, unknown> },
  env: NativeEnv,
): Validated<ToolCall> {
  const { choices } = env;
  if (!isToolName(call.name))
    return { ok: false, reason: `unknown_tool: ${call.name}` };
  const tool = call.name;
  if (!env.allowed.includes(tool))
    return { ok: false, reason: `tool_not_allowed: ${tool}` };

  const schema = labelSchema(tool, choices);
  if (!schema) return { ok: false, reason: `unknown_tool: ${tool}` };
  const parsed = schema.safeParse(withoutNone(call.args ?? {}));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return {
      ok: false,
      reason:
        `bad_label: ${i?.path.join(".") || "args"} ${i?.message ?? ""}`.trim(),
    };
  }

  const idArgs = dropUndefined(
    toIdArgs(tool, parsed.data as Record<string, unknown>, choices, env),
  );

  // Dates: code only. Any model date was dropped with the unknown keys.
  if (hasDateArgs(tool)) {
    const d = datesFromQuestion(env.question, env.todayMs);
    if (d.date_from) idArgs.date_from = d.date_from;
    if (d.date_to) idArgs.date_to = d.date_to;
  }
  if (tool === "search_chunks") {
    idArgs.query = queryFor(text(idArgs.query), env.question);
  }

  // Ids exist and are in the scope.
  for (const id of meetingIdsOf(idArgs)) {
    if (!choices.scopeMeetingIds.has(id))
      return { ok: false, reason: `out_of_scope: meeting ${id}` };
  }
  if (tool === "propose_retag" && (idArgs.meeting_ids as string[]).length === 0)
    return { ok: false, reason: "bad_args: no meeting for the tag" };

  const checked = parseToolArgs(tool, idArgs);
  if (!checked.ok) return checked;
  return { ok: true, args: { tool, args: checked.args } };
}
