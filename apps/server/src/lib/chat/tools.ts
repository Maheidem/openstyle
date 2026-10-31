import type { DatabaseSync } from "node:sqlite";
import type { ChatBlock, ChatListItem } from "@openstyle/validations";
import type { z } from "zod";
import { cutText } from "../meetings/folder-description.js";
import {
  actionItemKey,
  buildFolderOverview,
  gistOf,
  groupItems,
  type ItemGroup,
  parseSummary,
  type RawItem,
} from "../meetings/folder-overview.js";
import { readStanding } from "../meetings/folder-standing.js";
import { formatClock } from "../meetings/live/chat-context.js";
import {
  hitText,
  type RetrievalHit,
  type RetrievalScope,
  retrieve,
} from "../search/retrieve.js";
import { isoToRange } from "./dates.js";
import {
  folderStatusArgs,
  getMeetingSummaryArgs,
  getTranscriptWindowArgs,
  listActionItemsArgs,
  listDecisionsQuestionsArgs,
  listMeetingsArgs,
  listPeopleArgs,
  READ_TOOL_NAMES,
  type ReadToolName,
  searchChunksArgs,
} from "./tool-schemas.js";
import type { Source, ToolContext, ToolResult, TurnScope } from "./types.js";

// The read tools of the meeting chat agent (specs/meeting-chat-agent.md 3.2).
// Code calls them. The model never does. Every tool reads the database
// directly. Every meeting id is checked against the scope of the turn before
// a tool runs: an id outside the scope is rejected, not repaired (3.1 rules
// 2 and 3, 2.3 stage 3 rule 1).

/** Characters of a chunk hit that go to the model (spec 3.2). */
export const HIT_CHARS = 320;
/** A window of the transcript, at most (spec 3.2). */
export const WINDOW_MAX_MS = 180_000;
/** Characters of the text of a window, at most. */
export const WINDOW_MAX_CHARS = 1500;
/** Sources that a list tool adds, at most. */
export const LIST_SOURCES_MAX = 30;
/** Items in a list block, at most. */
export const LIST_BLOCK_MAX = 50;
/** Extra transcript chunks that one meeting keeps next to its best chunk. */
const EXTRA_CHUNKS = 2;
/** Candidates that go to the reranker when `ctx.rerank` is set. */
const RERANK_CANDIDATES = 30;
const SUMMARY_TEXT_CHARS = 1500;

/** A tool call that code refuses: bad arguments or an id outside the scope. */
export class ToolRejected extends Error {
  constructor(readonly reason: string) {
    super(`tool call rejected: ${reason}`);
    this.name = "ToolRejected";
  }
}

/** What a tool returns. `runTool` adds the tool name and the time. */
interface ToolOutput {
  rows: number;
  labels: string[];
  blocks: ChatBlock[];
  degraded?: ToolResult["degraded"];
}

export interface ToolDef<A = unknown> {
  name: ReadToolName;
  schema: z.ZodType<A>;
  /** The meeting ids in the arguments. `runTool` checks each against the scope. */
  meetingIds?: (args: A) => string[];
  run: (ctx: ToolContext, args: A) => ToolOutput | Promise<ToolOutput>;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

interface MeetingRow {
  id: string;
  title: string | null;
  /** started_at, else created_at. */
  at: number | null;
  folder_id: string | null;
  summary_json: string | null;
  markdown: string | null;
}

function scopeSql(scope: TurnScope): { where: string; params: string[] } {
  if (scope.kind === "meeting") {
    return { where: "m.id = ?", params: [scope.id ?? ""] };
  }
  if (scope.kind === "folder") {
    return { where: "m.folder_id = ?", params: [scope.id ?? ""] };
  }
  return { where: "1 = 1", params: [] };
}

/** True when the meeting is inside the scope of the turn. */
export function meetingInScope(
  db: DatabaseSync,
  scope: TurnScope,
  meetingId: string,
): boolean {
  const { where, params } = scopeSql(scope);
  return (
    db
      .prepare(`SELECT 1 FROM meetings m WHERE m.id = ? AND ${where}`)
      .get(meetingId, ...params) !== undefined
  );
}

/** Throws `ToolRejected` when the meeting is not in the scope. */
function assertInScope(ctx: ToolContext, meetingId: string): void {
  if (!meetingInScope(ctx.db, ctx.scope, meetingId)) {
    throw new ToolRejected(`meeting_out_of_scope:${meetingId}`);
  }
}

interface MeetingFilter {
  dateFrom?: string | null;
  dateTo?: string | null;
  meetingId?: string | null;
  tag?: string | null;
}

/** The range of two ISO dates. Throws when a date is not real or from > to. */
function checkedRange(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
): { fromMs: number; toMs: number } | null {
  if (!dateFrom && !dateTo) return null;
  const range = isoToRange(dateFrom, dateTo);
  if (!range) throw new ToolRejected("bad_date");
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new ToolRejected("bad_date_order");
  }
  return range;
}

/** Meetings in scope, oldest first, with their stored summary. */
function loadMeetings(
  db: DatabaseSync,
  scope: TurnScope,
  f: MeetingFilter = {},
): MeetingRow[] {
  const { where, params } = scopeSql(scope);
  const parts = [where];
  const args: (string | number)[] = [...params];
  const range = checkedRange(f.dateFrom, f.dateTo);
  if (range) {
    parts.push(
      "COALESCE(m.started_at, m.created_at) >= ? AND COALESCE(m.started_at, m.created_at) < ?",
    );
    args.push(range.fromMs, range.toMs);
  }
  if (f.meetingId) {
    parts.push("m.id = ?");
    args.push(f.meetingId);
  }
  if (f.tag) {
    parts.push(
      `EXISTS (SELECT 1 FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
                WHERE mt.meeting_id = m.id AND t.name = ?)`,
    );
    args.push(f.tag.trim().toLowerCase());
  }
  return db
    .prepare(
      `SELECT m.id, m.title, COALESCE(m.started_at, m.created_at) AS at,
              m.folder_id, s.summary_json, s.markdown
         FROM meetings m LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
        WHERE ${parts.join(" AND ")}
        ORDER BY COALESCE(m.started_at, m.created_at), m.id`,
    )
    .all(...args) as unknown as MeetingRow[];
}

interface MeetingInfo {
  title: string | null;
  at: number | null;
}

function meetingInfo(db: DatabaseSync, id: string): MeetingInfo {
  const row = db
    .prepare(
      "SELECT title, COALESCE(started_at, created_at) AS at FROM meetings WHERE id = ?",
    )
    .get(id) as MeetingInfo | undefined;
  return row ?? { title: null, at: null };
}

const isoDay = (ms: number | null) =>
  ms === null ? "" : new Date(ms).toISOString().slice(0, 10);

/** Adds a source and returns its label. */
function addSource(
  ctx: ToolContext,
  s: Omit<Source, "label">,
  labels: string[],
): string {
  const src = ctx.sources.add(s);
  if (!labels.includes(src.label)) labels.push(src.label);
  return src.label;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Lower case, no accents, single spaces. The key of a person. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const firstName = (key: string) => key.split(" ")[0] ?? key;
const isSingle = (key: string) => !key.includes(" ");

/**
 * The person key of an owner text. PERSON MATCH RULE: the owner text is the
 * person when (1) its folded text equals the folded display name of a
 * speaker, or (2) one of the two texts is a single word that equals the first
 * word of the other, and exactly one speaker name of the scope fits. With two
 * speakers called "Dana ...", the owner text "Dana" matches neither and keeps
 * its own key. A text that fits no speaker keeps its own folded text as key.
 */
function ownerKey(owner: string, speakerKeys: ReadonlySet<string>): string {
  const o = normalizeName(owner);
  if (speakerKeys.has(o)) return o;
  const fits = [...speakerKeys].filter(
    (p) =>
      (isSingle(o) && firstName(p) === o) ||
      (isSingle(p) && firstName(o) === p),
  );
  return fits.length === 1 ? (fits[0] as string) : o;
}

function speakerNames(
  db: DatabaseSync,
  scope: TurnScope,
): { meeting_id: string; display_name: string }[] {
  const { where, params } = scopeSql(scope);
  return db
    .prepare(
      `SELECT sp.meeting_id, sp.display_name FROM meeting_speakers sp
         JOIN meetings m ON m.id = sp.meeting_id
        WHERE ${where} AND sp.merged_into IS NULL
          AND sp.display_name IS NOT NULL AND TRIM(sp.display_name) <> ''`,
    )
    .all(...params) as unknown as {
    meeting_id: string;
    display_name: string;
  }[];
}

/**
 * The people of a scope: the distinct speaker display names and the action
 * item owners, with the number of meetings of each. `id` is the person key
 * (`normalizeName` of the full name). Owners are merged into speakers with
 * the person match rule (`ownerKey`). `choices.ts` calls this for the
 * `person` slot.
 */
export function listPeopleInScope(
  db: DatabaseSync,
  scope: TurnScope,
): { id: string; name: string; meetings: number }[] {
  const people = new Map<string, { name: string; meetings: Set<string> }>();
  const add = (key: string, name: string, meetingId: string) => {
    const e = people.get(key) ?? { name, meetings: new Set<string>() };
    e.meetings.add(meetingId);
    people.set(key, e);
  };
  const speakers = speakerNames(db, scope);
  const keys = new Set<string>();
  for (const s of speakers) {
    const key = normalizeName(s.display_name);
    keys.add(key);
    add(key, s.display_name.trim().replace(/\s+/g, " "), s.meeting_id);
  }
  for (const m of loadMeetings(db, scope)) {
    for (const a of parseSummary(m.summary_json)?.actionItems ?? []) {
      if (!a.owner) continue;
      add(ownerKey(a.owner, keys), a.owner.trim(), m.id);
    }
  }
  return [...people.entries()]
    .map(([id, e]) => ({ id, name: e.name, meetings: e.meetings.size }))
    .sort((a, b) => b.meetings - a.meetings || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Items (action items, decisions, open questions)
// ---------------------------------------------------------------------------

function doneKeysInScope(db: DatabaseSync, scope: TurnScope): Set<string> {
  let folderId: string | null | undefined;
  if (scope.kind === "folder") folderId = scope.id;
  else if (scope.kind === "meeting") {
    folderId = (
      db
        .prepare("SELECT folder_id FROM meetings WHERE id = ?")
        .get(scope.id ?? "") as { folder_id: string | null } | undefined
    )?.folder_id;
    if (!folderId) return new Set();
  }
  const rows = (
    folderId
      ? db
          .prepare(
            "SELECT item_key FROM folder_action_item_state WHERE done = 1 AND folder_id = ?",
          )
          .all(folderId)
      : db
          .prepare(
            "SELECT item_key FROM folder_action_item_state WHERE done = 1",
          )
          .all()
  ) as { item_key: string }[];
  return new Set(rows.map((r) => r.item_key));
}

type ItemKind = "actionItems" | "decisions" | "openQuestions";

function rawItems(meetings: readonly MeetingRow[], kind: ItemKind): RawItem[] {
  const out: RawItem[] = [];
  for (const m of meetings) {
    const s = parseSummary(m.summary_json);
    if (!s) continue;
    const source = { meeting_id: m.id, title: m.title, started_at: m.at };
    if (kind === "actionItems") {
      for (const a of s.actionItems) {
        out.push({ text: a.task, owner: a.owner, due: a.due, source });
      }
    } else {
      for (const text of s[kind]) {
        out.push({ text, owner: null, due: null, source });
      }
    }
  }
  return out;
}

/**
 * Action item groups in scope, like the folder overview (`groupItems`).
 * The id of a group is its first key. Every member key works as an id.
 */
function actionGroups(
  db: DatabaseSync,
  scope: TurnScope,
  f: MeetingFilter = {},
): { groups: ItemGroup[]; done: Set<string> } {
  const meetings = loadMeetings(db, scope, f);
  return {
    groups: groupItems(rawItems(meetings, "actionItems"), true),
    done: doneKeysInScope(db, scope),
  };
}

/** The action item group that has the key `itemId` in the scope, or null. */
export function findActionItem(
  db: DatabaseSync,
  scope: TurnScope,
  itemId: string,
): { group: ItemGroup; done: boolean } | null {
  const { groups, done } = actionGroups(db, scope);
  const group = groups.find((g) => g.keys.includes(itemId));
  return group ? { group, done: group.keys.some((k) => done.has(k)) } : null;
}

const oldest = <T>(xs: readonly T[]) => xs[xs.length - 1] as T;

function itemLine(g: ItemGroup, done: boolean | null): string {
  const extra = [
    g.owner && `owner: ${g.owner}`,
    g.due && `due: ${g.due}`,
    done === null ? null : done ? "done" : "open",
  ].filter(Boolean);
  return extra.length > 0 ? `${g.text} (${extra.join("; ")})` : g.text;
}

// ---------------------------------------------------------------------------
// search_chunks
// ---------------------------------------------------------------------------

const STOP = new Set(
  "the and for what did was who that this with about from have has are you our any when where which que quem qual como com uma para por dos das nos nas foi foram tivemos sobre quando onde der die das und mit von was wer wie los las del por una".split(
    " ",
  ),
);

function wordsOf(text: string): string[] {
  return normalizeName(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

interface Snippet {
  text: string;
  bestMs: number | null;
}

/**
 * The text of a transcript chunk and `best_ms` (spec 7.3 point 1): the start
 * of the segment with the most query words. A tie goes to the earlier
 * segment. The text is cut to `HIT_CHARS` and starts at the best segment, so
 * the cited line is inside the text.
 */
function transcriptSnippet(
  db: DatabaseSync,
  hit: RetrievalHit,
  query: string,
): Snippet | null {
  const chunk = db
    .prepare(
      "SELECT segment_ids, char_start, char_end FROM meeting_chunks WHERE id = ?",
    )
    .get(hit.chunkId) as
    | { segment_ids: string; char_start: number; char_end: number | null }
    | undefined;
  if (!chunk) return null;
  let ids: string[];
  try {
    ids = JSON.parse(chunk.segment_ids) as string[];
  } catch {
    return null;
  }
  const stmt = db.prepare(
    "SELECT start_ms, COALESCE(NULLIF(enhanced_text, ''), text, '') AS t FROM meeting_segments WHERE id = ?",
  );
  const q = new Set(wordsOf(query));
  const pieces: {
    start: number;
    text: string;
    offset: number;
    score: number;
  }[] = [];
  let total = 0;
  ids.forEach((id, i) => {
    const row = stmt.get(id) as
      | { start_ms: number | null; t: string }
      | undefined;
    if (!row) return;
    // The same cut as `spanText` in the chunker: first from char_start, last to char_end.
    const from = i === 0 ? chunk.char_start : 0;
    const to =
      i === ids.length - 1 && chunk.char_end !== null
        ? chunk.char_end
        : row.t.length;
    const text = row.t.slice(from, to).trim();
    if (text === "") return;
    const have = new Set(wordsOf(text));
    const score = [...q].filter((w) => have.has(w)).length;
    if (pieces.length > 0) total += 1; // the joining space
    pieces.push({
      start: row.start_ms ?? hit.startMs ?? 0,
      text,
      offset: total,
      score,
    });
    total += text.length;
  });
  if (pieces.length === 0) return null;
  let best = pieces[0] as (typeof pieces)[number];
  for (const p of pieces) if (p.score > best.score) best = p;
  const full = pieces.map((p) => p.text).join(" ");
  if (full.length <= HIT_CHARS) return { text: full, bestMs: best.start };
  // Window of HIT_CHARS - 2 characters (room for two "…"), from the best segment.
  const room = HIT_CHARS - 2;
  const start = Math.max(0, Math.min(best.offset, full.length - room));
  const end = Math.min(full.length, start + room);
  const body = full.slice(start, end).trim();
  return {
    text: `${start > 0 ? "…" : ""}${body}${end < full.length ? "…" : ""}`,
    bestMs: best.start,
  };
}

function retrievalScope(
  scope: TurnScope,
  only: string | undefined,
): RetrievalScope {
  if (only) return { kind: "meeting", meetingId: only };
  if (scope.kind === "meeting")
    return { kind: "meeting", meetingId: scope.id ?? "" };
  if (scope.kind === "folder")
    return { kind: "folder", folderId: scope.id ?? "" };
  return { kind: "all" };
}

const searchChunks: ToolDef<z.infer<typeof searchChunksArgs>> = {
  name: "search_chunks",
  schema: searchChunksArgs,
  meetingIds: (a) => a.meeting_ids ?? [],
  async run(ctx, a) {
    const k = a.k ?? ctx.k;
    const ids = [...new Set(a.meeting_ids ?? [])];
    const range = checkedRange(a.date_from, a.date_to);
    // One id goes into the retrieval scope. More ids filter after the call,
    // so ask for more hits.
    const only = ids.length === 1 ? ids[0] : undefined;
    const post = ids.length > 1 ? new Set(ids) : null;
    const labels: string[] = [];
    const empty = (degraded: ToolResult["degraded"]): ToolOutput => ({
      rows: 0,
      labels,
      blocks: [],
      degraded,
    });

    let res: Awaited<ReturnType<typeof retrieve>>;
    try {
      res = await retrieve({
        query: { kind: "text", text: a.query },
        scope: retrievalScope(ctx.scope, only),
        ...(range ? { dateRange: range } : {}),
        k: post ? Math.min(50, k * 3) : k,
        mode: "hybrid",
        ...(ctx.rerank ? { rerank: { candidates: RERANK_CANDIDATES } } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch {
      return empty("search_error");
    }
    if (res.status === "off") return empty("search_off");
    if (res.status === "error") return empty("search_error");

    const want = a.kinds ? new Set<string>(a.kinds) : null;
    // Group by meeting, in the order of the best hit of each meeting.
    const groups = new Map<string, RetrievalHit[]>();
    const metaOnly = new Map<string, RetrievalHit>();
    for (const h of res.hits) {
      if (post && !post.has(h.meetingId)) continue;
      if (h.kind === "meta") {
        if (!metaOnly.has(h.meetingId)) metaOnly.set(h.meetingId, h);
        continue;
      }
      if (want && !want.has(h.kind)) continue;
      const list = groups.get(h.meetingId) ?? [];
      list.push(h);
      groups.set(h.meetingId, list);
    }
    // Meta hits show only when nothing else is found (spec 3.2 note 2).
    const selected: RetrievalHit[] = [];
    if (groups.size > 0) {
      for (const list of groups.values()) {
        const [best, ...rest] = list as [RetrievalHit, ...RetrievalHit[]];
        selected.push(
          best,
          ...rest.filter((h) => h.kind === "transcript").slice(0, EXTRA_CHUNKS),
        );
      }
    } else if (!want || want.has("summary")) {
      selected.push(...metaOnly.values());
    }

    for (const h of selected.slice(0, Math.max(k, groups.size))) {
      const info = meetingInfo(ctx.db, h.meetingId);
      if (h.kind === "transcript") {
        const snip = transcriptSnippet(ctx.db, h, a.query);
        const text = snip?.text ?? hitText(h, HIT_CHARS);
        if (text === "") continue;
        addSource(
          ctx,
          {
            kind: "transcript",
            meetingId: h.meetingId,
            title: info.title,
            startedAt: info.at,
            startMs: snip?.bestMs ?? h.startMs,
            endMs: h.endMs,
            itemId: null,
            text,
          },
          labels,
        );
      } else {
        // A summary hit, or a meta hit that shows as a summary.
        const text = hitText(h, HIT_CHARS);
        if (text === "") continue;
        addSource(
          ctx,
          {
            kind: "summary",
            meetingId: h.meetingId,
            title: info.title,
            startedAt: info.at,
            startMs: null,
            endMs: null,
            itemId: null,
            text,
          },
          labels,
        );
      }
    }
    return { rows: labels.length, labels, blocks: [], degraded: null };
  },
};

// ---------------------------------------------------------------------------
// get_meeting_summary
// ---------------------------------------------------------------------------

const getMeetingSummary: ToolDef<z.infer<typeof getMeetingSummaryArgs>> = {
  name: "get_meeting_summary",
  schema: getMeetingSummaryArgs,
  meetingIds: (a) => [a.meeting_id],
  run(ctx, a) {
    const labels: string[] = [];
    const m = loadMeetings(ctx.db, ctx.scope, { meetingId: a.meeting_id })[0];
    if (!m || (!m.summary_json && !m.markdown)) {
      return { rows: 0, labels, blocks: [] };
    }
    const base = {
      meetingId: m.id,
      title: m.title,
      startedAt: m.at,
      startMs: null,
      endMs: null,
    };
    const s = parseSummary(m.summary_json);
    if (!s) {
      // No summary object (an older row): the markdown is one source.
      addSource(
        ctx,
        {
          ...base,
          kind: "summary",
          itemId: null,
          text: cutText(String(m.markdown), SUMMARY_TEXT_CHARS),
        },
        labels,
      );
      return { rows: labels.length, labels, blocks: [] };
    }
    const done = m.folder_id
      ? new Set(
          (
            ctx.db
              .prepare(
                "SELECT item_key FROM folder_action_item_state WHERE folder_id = ? AND done = 1",
              )
              .all(m.folder_id) as { item_key: string }[]
          ).map((r) => r.item_key),
        )
      : new Set<string>();
    const line = (kind: Source["kind"], text: string, itemId: string | null) =>
      addSource(
        ctx,
        { ...base, kind, itemId, text: cutText(text, 600) },
        labels,
      );
    if (s.overview) line("summary", `Overview: ${s.overview}`, null);
    if (s.keyPoints.length > 0) {
      line("summary", `Key points: ${s.keyPoints.join("; ")}`, null);
    }
    for (const t of s.decisions.slice(0, 8)) {
      line("item", `Decision: ${t}`, actionItemKey(m.id, t));
    }
    for (const x of s.actionItems.slice(0, 12)) {
      const key = actionItemKey(m.id, x.task);
      const extra = [
        x.owner && `owner: ${x.owner}`,
        x.due && `due: ${x.due}`,
        done.has(key) ? "done" : "open",
      ].filter(Boolean);
      line("item", `Action item: ${x.task} (${extra.join("; ")})`, key);
    }
    for (const t of s.openQuestions.slice(0, 6)) {
      line("item", `Open question: ${t}`, actionItemKey(m.id, t));
    }
    return { rows: labels.length, labels, blocks: [] };
  },
};

// ---------------------------------------------------------------------------
// list_action_items, list_decisions_questions
// ---------------------------------------------------------------------------

function listBlock(
  list: "action_items" | "decisions" | "open_questions",
  total: number,
  items: ChatListItem[],
): ChatBlock {
  return { kind: "list", list, total, items: items.slice(0, LIST_BLOCK_MAX) };
}

const listActionItems: ToolDef<z.infer<typeof listActionItemsArgs>> = {
  name: "list_action_items",
  schema: listActionItemsArgs,
  meetingIds: (a) => (a.meeting_id ? [a.meeting_id] : []),
  run(ctx, a) {
    const { groups, done } = actionGroups(ctx.db, ctx.scope, {
      dateFrom: a.date_from,
      dateTo: a.date_to,
      meetingId: a.meeting_id,
    });
    // DEFAULT: status "all" when the argument is absent.
    const status = a.status ?? "all";
    const speakers = new Set(
      speakerNames(ctx.db, ctx.scope).map((s) => normalizeName(s.display_name)),
    );
    const person = a.person_id ? normalizeName(a.person_id) : null;
    const rows = groups
      .map((g) => ({ g, isDone: g.keys.some((k) => done.has(k)) }))
      .filter(({ g, isDone }) => {
        if (status === "open" && isDone) return false;
        if (status === "done" && !isDone) return false;
        if (person)
          return g.owner !== null && ownerKey(g.owner, speakers) === person;
        return true;
      });
    const labels: string[] = [];
    const items: ChatListItem[] = rows
      .slice(0, LIST_BLOCK_MAX)
      .map(({ g, isDone }, i) => {
        // The id is the first key. Its meeting is the oldest source.
        const src = oldest(g.sources);
        let label: string | null = null;
        if (i < LIST_SOURCES_MAX) {
          label = addSource(
            ctx,
            {
              kind: "item",
              meetingId: src.meeting_id,
              title: src.title,
              startedAt: src.started_at,
              startMs: null,
              endMs: null,
              itemId: g.keys[0] as string,
              text: itemLine(g, isDone),
            },
            labels,
          );
        }
        return {
          text: g.text,
          meeting_id: src.meeting_id,
          meeting_title: src.title,
          item_id: g.keys[0] as string,
          done: isDone,
          owner: g.owner,
          due: g.due,
          label,
        };
      });
    return {
      rows: rows.length,
      labels,
      blocks:
        rows.length > 0 ? [listBlock("action_items", rows.length, items)] : [],
    };
  },
};

const listDecisionsQuestions: ToolDef<
  z.infer<typeof listDecisionsQuestionsArgs>
> = {
  name: "list_decisions_questions",
  schema: listDecisionsQuestionsArgs,
  meetingIds: (a) => (a.meeting_id ? [a.meeting_id] : []),
  run(ctx, a) {
    const meetings = loadMeetings(ctx.db, ctx.scope, {
      dateFrom: a.date_from,
      dateTo: a.date_to,
      meetingId: a.meeting_id,
    });
    const isDecision = a.kind === "decision";
    const groups = groupItems(
      rawItems(meetings, isDecision ? "decisions" : "openQuestions"),
      false,
    );
    const limit = a.limit ?? 30;
    const labels: string[] = [];
    const items: ChatListItem[] = groups.slice(0, limit).map((g, i) => {
      const src = oldest(g.sources);
      const key = g.keys[0] as string;
      let label: string | null = null;
      if (i < LIST_SOURCES_MAX) {
        label = addSource(
          ctx,
          {
            kind: "item",
            meetingId: src.meeting_id,
            title: src.title,
            startedAt: src.started_at,
            startMs: null,
            endMs: null,
            itemId: key,
            text: `${isDecision ? "Decision" : "Open question"}: ${g.text}`,
          },
          labels,
        );
      }
      return {
        text: g.text,
        meeting_id: src.meeting_id,
        meeting_title: src.title,
        item_id: key,
        done: null,
        owner: null,
        due: null,
        label,
      };
    });
    return {
      rows: groups.length,
      labels,
      blocks:
        groups.length > 0
          ? [
              listBlock(
                isDecision ? "decisions" : "open_questions",
                groups.length,
                items,
              ),
            ]
          : [],
    };
  },
};

// ---------------------------------------------------------------------------
// list_people
// ---------------------------------------------------------------------------

const listPeople: ToolDef<z.infer<typeof listPeopleArgs>> = {
  name: "list_people",
  schema: listPeopleArgs,
  run(ctx, a) {
    const q = a.query ? normalizeName(a.query) : "";
    const people = listPeopleInScope(ctx.db, ctx.scope).filter(
      (p) => q === "" || p.id.includes(q),
    );
    // The names are for the slot choices (choices.ts). No source, no block.
    return { rows: people.length, labels: [], blocks: [] };
  },
};

// ---------------------------------------------------------------------------
// get_transcript_window
// ---------------------------------------------------------------------------

/** The display name of a speaker label, following `merged_into`. */
function speakerResolver(db: DatabaseSync, meetingId: string) {
  const rows = db
    .prepare(
      "SELECT speaker_label, display_name, merged_into FROM meeting_speakers WHERE meeting_id = ?",
    )
    .all(meetingId) as {
    speaker_label: string;
    display_name: string | null;
    merged_into: string | null;
  }[];
  const byLabel = new Map(rows.map((r) => [r.speaker_label, r]));
  return (label: string): string => {
    let row = byLabel.get(label);
    for (let hop = 0; row && hop < 5; hop++) {
      if (row.merged_into && byLabel.has(row.merged_into)) {
        row = byLabel.get(row.merged_into);
      } else break;
    }
    return row?.display_name?.trim() || label;
  };
}

const getTranscriptWindow: ToolDef<z.infer<typeof getTranscriptWindowArgs>> = {
  name: "get_transcript_window",
  schema: getTranscriptWindowArgs,
  meetingIds: (a) => [a.meeting_id],
  run(ctx, a) {
    if (a.to_ms < a.from_ms) throw new ToolRejected("bad_window");
    const from = a.from_ms;
    const to = Math.min(a.to_ms, from + WINDOW_MAX_MS);
    const segs = ctx.db
      .prepare(
        `SELECT source, start_ms, end_ms, speaker_label,
                COALESCE(NULLIF(enhanced_text, ''), text) AS t
           FROM meeting_segments
          WHERE meeting_id = ? AND status = 'ok'
            AND start_ms < ? AND COALESCE(end_ms, start_ms) >= ?
          ORDER BY start_ms, idx, id`,
      )
      .all(a.meeting_id, to, from) as unknown as {
      source: "mic" | "system";
      start_ms: number;
      end_ms: number | null;
      speaker_label: string | null;
      t: string | null;
    }[];
    const nameOf = speakerResolver(ctx.db, a.meeting_id);
    const want = a.speaker ? normalizeName(a.speaker) : null;
    const lines = segs.flatMap((s) => {
      const text = s.t?.replace(/\s+/g, " ").trim();
      if (!text) return [];
      // The mic channel with no label is the account owner.
      const speaker = s.speaker_label
        ? nameOf(s.speaker_label)
        : s.source === "mic"
          ? "Me"
          : "Them";
      if (want && !normalizeName(speaker).includes(want)) return [];
      return [
        { startMs: s.start_ms, endMs: s.end_ms ?? s.start_ms, speaker, text },
      ];
    });
    if (lines.length === 0) return { rows: 0, labels: [], blocks: [] };

    // Join the lines; stop at a line boundary before WINDOW_MAX_CHARS.
    const out: string[] = [];
    let len = 0;
    let last = lines[0] as (typeof lines)[number];
    for (const l of lines) {
      const text = `[${formatClock(l.startMs)}] ${l.speaker}: ${l.text}`;
      if (out.length > 0 && len + 1 + text.length > WINDOW_MAX_CHARS) break;
      out.push(out.length === 0 ? cutText(text, WINDOW_MAX_CHARS) : text);
      len += text.length + 1;
      last = l;
    }
    const info = meetingInfo(ctx.db, a.meeting_id);
    const labels: string[] = [];
    addSource(
      ctx,
      {
        kind: "window",
        meetingId: a.meeting_id,
        title: info.title,
        startedAt: info.at,
        startMs: (lines[0] as (typeof lines)[number]).startMs,
        endMs: last.endMs,
        itemId: null,
        text: out.join("\n"),
      },
      labels,
    );
    return { rows: lines.length, labels, blocks: [] };
  },
};

// ---------------------------------------------------------------------------
// folder_status
// ---------------------------------------------------------------------------

const folderStatus: ToolDef<z.infer<typeof folderStatusArgs>> = {
  name: "folder_status",
  schema: folderStatusArgs,
  run(ctx) {
    const none: ToolOutput = { rows: 0, labels: [], blocks: [] };
    let folderId: string | null = null;
    if (ctx.scope.kind === "folder") folderId = ctx.scope.id;
    else if (ctx.scope.kind === "meeting") {
      folderId =
        (
          ctx.db
            .prepare("SELECT folder_id FROM meetings WHERE id = ?")
            .get(ctx.scope.id ?? "") as { folder_id: string | null } | undefined
        )?.folder_id ?? null;
    }
    if (!folderId) return none;
    const overview = buildFolderOverview(ctx.db, folderId);
    if (!overview) return none;
    const standing = readStanding(ctx.db, folderId).standing;
    const openActions = overview.action_items.filter((x) => !x.done);
    const bullets = standing?.bullets ?? [];
    const text = [
      standing
        ? `Where ${overview.folder.name} stands${standing.stale ? " (saved text may be out of date)" : ""}:\n${bullets.map((b) => `- ${b}`).join("\n")}`
        : `${overview.folder.name}: no saved status text.`,
      `Open action items: ${openActions.length}. Decisions: ${overview.decisions.length}. Open questions: ${overview.open_questions.length}.`,
      overview.decisions.length > 0
        ? `Latest decisions: ${overview.decisions
            .slice(0, 3)
            .map((d) => d.text)
            .join("; ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    // The cite of a folder source opens the newest meeting of the folder.
    const newest = overview.timeline[0];
    const labels: string[] = [];
    addSource(
      ctx,
      {
        kind: "folder",
        meetingId: newest?.meeting_id ?? "",
        title: overview.folder.name,
        startedAt: newest?.started_at ?? null,
        startMs: null,
        endMs: null,
        itemId: null,
        text: cutText(text, SUMMARY_TEXT_CHARS),
      },
      labels,
    );
    return {
      rows: 1,
      labels,
      blocks: [
        {
          kind: "status",
          bullets,
          open_actions: openActions.length,
          open_questions: overview.open_questions.length,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// list_meetings
// ---------------------------------------------------------------------------

const listMeetings: ToolDef<z.infer<typeof listMeetingsArgs>> = {
  name: "list_meetings",
  schema: listMeetingsArgs,
  run(ctx, a) {
    const all = loadMeetings(ctx.db, ctx.scope, {
      dateFrom: a.date_from,
      dateTo: a.date_to,
      tag: a.tag,
    }).reverse(); // newest first
    const labels: string[] = [];
    const items: ChatListItem[] = [];
    for (const m of all.slice(0, a.limit ?? 20)) {
      const overview =
        parseSummary(m.summary_json)?.overview ||
        gistOf(parseSummary(m.summary_json), m.markdown) ||
        "";
      const label = addSource(
        ctx,
        {
          kind: "summary",
          meetingId: m.id,
          title: m.title,
          startedAt: m.at,
          startMs: null,
          endMs: null,
          itemId: null,
          text: `${m.title ?? "Untitled"} (${isoDay(m.at)})${overview ? ` ${cutText(overview.replace(/\s+/g, " "), 200)}` : ""}`,
        },
        labels,
      );
      items.push({
        text: `${m.title ?? "Untitled"} (${isoDay(m.at)})`,
        meeting_id: m.id,
        meeting_title: m.title,
        item_id: null,
        done: null,
        owner: null,
        due: null,
        label,
      });
    }
    // `rows` is the full count, so the pipeline can answer "how many".
    return {
      rows: all.length,
      labels,
      blocks:
        all.length > 0
          ? [{ kind: "list", list: "meetings", total: all.length, items }]
          : [],
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const asDef = <A>(d: ToolDef<A>) => d as unknown as ToolDef;

export const TOOLS: Record<ReadToolName, ToolDef> = {
  search_chunks: asDef(searchChunks),
  get_meeting_summary: asDef(getMeetingSummary),
  list_action_items: asDef(listActionItems),
  list_decisions_questions: asDef(listDecisionsQuestions),
  list_people: asDef(listPeople),
  get_transcript_window: asDef(getTranscriptWindow),
  folder_status: asDef(folderStatus),
  list_meetings: asDef(listMeetings),
};

/**
 * Runs one read tool. Validates the arguments with zod, checks every meeting
 * id against the scope, runs the tool and returns the result. Throws
 * `ToolRejected` for an unknown tool, bad arguments or an id outside the
 * scope. A search that is off or failed does not throw: it sets `degraded`.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const def = (READ_TOOL_NAMES as readonly string[]).includes(name)
    ? TOOLS[name as ReadToolName]
    : undefined;
  if (!def) throw new ToolRejected(`unknown_tool:${name}`);
  const parsed = def.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new ToolRejected(
      `bad_args:${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  for (const id of def.meetingIds?.(parsed.data) ?? []) assertInScope(ctx, id);
  const t0 = performance.now();
  const out = await def.run(ctx, parsed.data);
  return {
    tool: name,
    rows: out.rows,
    labels: out.labels,
    blocks: out.blocks,
    degraded: out.degraded ?? null,
    ms: Math.round(performance.now() - t0),
  };
}
