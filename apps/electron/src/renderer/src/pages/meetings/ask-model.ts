/**
 * Pure logic of the Ask tab (specs/meeting-chat-agent.md section 11).
 * No React and no network here, so node vitest can test every rule.
 */
import {
  CHAT_QUESTION_MAX_CHARS,
  type ChatBlock,
  type ChatCite,
  type ChatMessage,
  type ChatScope,
  type ChatThread,
  type ChatTrace,
  type ChatWider,
} from "@openstyle/validations";

/** The first answer that takes longer than this shows the "warming" text. */
export const ASK_WARMING_AFTER_MS = 3000;

/** The longest thread title in the list, in characters. */
const THREAD_TITLE_MAX = 60;

/** Time as `mm:ss`. Minutes can pass 59 (`75:03`). A bad value gives `00:00`. */
export function formatTimestamp(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Step trail
// ---------------------------------------------------------------------------

/** One part of the trail sentence. The UI writes the words with `t()`. */
export interface TraceSummaryPart {
  key: "searched" | "readSummary" | "readTranscript" | "listed" | "meetings";
  count: number;
}

const TRACE_ORDER: TraceSummaryPart["key"][] = [
  "searched",
  "readSummary",
  "readTranscript",
  "listed",
  "meetings",
];

/**
 * Count what the tools did in one turn. Search and list tools count the rows
 * they returned. Read tools count the calls. A part with no tool step is not
 * in the result.
 */
export function summarizeTrace(trace: ChatTrace | null): TraceSummaryPart[] {
  if (!trace) return [];
  const counts = new Map<TraceSummaryPart["key"], number>();
  const add = (key: TraceSummaryPart["key"], n: number): void => {
    counts.set(key, (counts.get(key) ?? 0) + n);
  };
  for (const step of trace.steps) {
    if (step.stage !== "tool") continue;
    switch (step.name) {
      case "search_chunks":
        add("searched", step.rows ?? 0);
        break;
      case "get_meeting_summary":
        add("readSummary", 1);
        break;
      case "get_transcript_window":
        add("readTranscript", 1);
        break;
      case "list_action_items":
      case "list_decisions_questions":
      case "list_people":
        add("listed", step.rows ?? 0);
        break;
      case "list_meetings":
        add("meetings", step.rows ?? 0);
        break;
      default:
        break;
    }
  }
  return TRACE_ORDER.filter((key) => counts.has(key)).map((key) => ({
    key,
    count: counts.get(key) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Cite chips
// ---------------------------------------------------------------------------

/** What a cite chip shows and says. */
export interface CiteView {
  label: string;
  /** `mm:ss`, or null for a summary or an item. */
  time: string | null;
  title: string | null;
}

export function citeView(cite: ChatCite): CiteView {
  const title = cite.title?.trim();
  return {
    label: cite.label,
    time: cite.start_ms === null ? null : formatTimestamp(cite.start_ms),
    title: title ? title : null,
  };
}

// ---------------------------------------------------------------------------
// Scope (spec 11.6)
// ---------------------------------------------------------------------------

/** A key for a scope: the query key of its thread list and its remembered thread. */
export function scopeKey(scope: ChatScope): string {
  return scope.kind === "all" ? "all" : `${scope.kind}:${scope.id}`;
}

/** The scope of a thread. A thread with no meeting and no folder is scope A. */
export function scopeOfThread(thread: ChatThread): ChatScope {
  if (thread.meeting_id) return { kind: "meeting", id: thread.meeting_id };
  if (thread.folder_id) return { kind: "folder", id: thread.folder_id };
  return { kind: "all" };
}

/** The scopes are the same scope. */
export function sameScope(a: ChatScope, b: ChatScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

/**
 * The wider scope that the last answer offers (spec 11.6.4): the not_found
 * block of the message, when it has `wider`. Only the last answer of a thread
 * can be widened, so the caller passes the last message.
 */
export function widerOffer(message: ChatMessage): ChatWider | null {
  for (const block of message.blocks) {
    if (block.kind === "not_found" && block.wider) return block.wider;
  }
  return null;
}

/**
 * The scope an answer searched, when it is not the scope of its thread (an
 * answer after a "search wider" click). null when the scope is the same, or
 * the message has no scope (a message of P1).
 */
export function widenedScope(
  message: ChatMessage,
  threadScope: ChatScope,
): ChatScope | null {
  const used = message.trace?.scope;
  if (!used || sameScope(used, threadScope)) return null;
  return used;
}

/** Where a click on a cite chip goes. */
export type CiteTarget =
  | { kind: "transcript"; startMs: number | null }
  | { kind: "summary" }
  | { kind: "meeting"; meetingId: string; startMs: number | null }
  | { kind: "removed" };

/**
 * Decide the target of a cite.
 * - A cite of another meeting opens that meeting. If the list of meetings is
 *   known and lacks it, the meeting is removed. A folder, an Ask page or a
 *   bubble has no "this meeting" (null): every cite opens its meeting.
 * - A summary or item cite of this meeting opens the Summary tab.
 * - Any other cite of this meeting opens the Transcript tab at `start_ms`.
 */
export function citeTarget(
  cite: ChatCite,
  thisMeetingId: string | null,
  knownMeetingIds: ReadonlySet<string> | null,
): CiteTarget {
  if (cite.meeting_id !== thisMeetingId) {
    if (knownMeetingIds && !knownMeetingIds.has(cite.meeting_id)) {
      return { kind: "removed" };
    }
    return {
      kind: "meeting",
      meetingId: cite.meeting_id,
      startMs: cite.start_ms,
    };
  }
  if (cite.kind === "summary" || cite.kind === "item") {
    return { kind: "summary" };
  }
  return { kind: "transcript", startMs: cite.start_ms };
}

/** The cites of a block, in the order of the labels. A label with no cite is skipped. */
export function citesForLabels(
  labels: readonly string[],
  cites: readonly ChatCite[],
): ChatCite[] {
  const byLabel = new Map(cites.map((c) => [c.label, c]));
  const out: ChatCite[] = [];
  for (const label of labels) {
    const cite = byLabel.get(label);
    if (cite && !out.includes(cite)) out.push(cite);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Messages, threads, question
// ---------------------------------------------------------------------------

/**
 * The blocks to draw for an answer. An answer with no block but with text
 * shows the text as one text block.
 */
export function answerBlocks(message: ChatMessage): ChatBlock[] {
  if (message.blocks.length > 0) return message.blocks;
  if (message.content.trim() === "") return [];
  return [{ kind: "text", text: message.content, cites: [] }];
}

/**
 * The title of a thread in the list: the first question, on one line, cut at
 * 60 characters. An empty title gives null and the UI writes a fallback.
 */
export function threadTitle(thread: ChatThread): string | null {
  const flat = (thread.title ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length > THREAD_TITLE_MAX
    ? `${flat.slice(0, THREAD_TITLE_MAX - 1).trimEnd()}…`
    : flat;
}

/**
 * Add messages to a thread, once each. The reply of a question and a reload of
 * the thread can bring the same message (the tab may have left and come back
 * while the turn ran), so the merge is by id and keeps the order of the ids.
 */
export function mergeMessages(
  prev: readonly ChatMessage[],
  add: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map<number, ChatMessage>();
  for (const m of [...prev, ...add]) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * A question to draw as its own bubble because the thread does not hold it
 * yet. The server saves the question at once, so a reload can already have it
 * as the last message. Then the bubble would show twice.
 */
export function unsavedQuestion(
  messages: readonly ChatMessage[],
  text: string | null,
): string | null {
  if (text === null) return null;
  const last = messages.at(-1);
  return last?.role === "user" && last.content.trim() === text.trim()
    ? null
    : text;
}

/**
 * The question of a turn that ended with no answer while no turn runs: the
 * turn failed while the tab was away, or the app closed during the turn.
 */
export function danglingQuestion(
  messages: readonly ChatMessage[],
  running: boolean,
): string | null {
  if (running) return null;
  const last = messages.at(-1);
  return last?.role === "user" ? last.content : null;
}

/**
 * The thread that each meeting showed last. The Ask tab unmounts when the user
 * leaves the meeting. This memory outlives the tab, so the same thread opens
 * again ("new" is an empty chat, null is the newest thread).
 */
const rememberedThread = new Map<string, string | null>();

/** `key` is `scopeKey(scope)`. */
export function readSelectedThread(key: string): string | null {
  return rememberedThread.get(key) ?? null;
}

export function rememberSelectedThread(
  key: string,
  selected: string | null,
): void {
  rememberedThread.set(key, selected);
}

export interface QuestionCheck {
  /** The text to send: trimmed. */
  text: string;
  ok: boolean;
  tooLong: boolean;
}

/** A question is valid when it has text and at most 1000 characters. */
export function checkQuestion(raw: string): QuestionCheck {
  const text = raw.trim();
  const tooLong = text.length > CHAT_QUESTION_MAX_CHARS;
  return { text, ok: text.length > 0 && !tooLong, tooLong };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface AskErrorView {
  /** Key under `meetings.ask.` */
  key:
    | "errOff"
    | "errNoModel"
    | "errProviderNotReady"
    | "errBusy"
    | "errScope"
    | "errWiden"
    | "errFailed";
  /** The button under the message. */
  action: "settings" | "models" | "retry" | "none";
}

/**
 * Map the HTTP status and the `reason` of the server to a message. A status
 * of null means the request did not reach the server.
 */
export function askErrorView(
  status: number | null,
  reason: string | null,
): AskErrorView {
  if (status === 409) {
    switch (reason) {
      case "off":
        return { key: "errOff", action: "settings" };
      case "no_model":
        return { key: "errNoModel", action: "models" };
      case "provider_not_ready":
        return { key: "errProviderNotReady", action: "models" };
      case "busy":
        return { key: "errBusy", action: "retry" };
      case "scope_missing":
        return { key: "errScope", action: "none" };
      case "widen_not_offered":
        return { key: "errWiden", action: "none" };
      default:
        break;
    }
  }
  return { key: "errFailed", action: "retry" };
}
