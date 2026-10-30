/**
 * Context builder of the live chat (issue #375, specs/live-chat.md section 3).
 * Code builds the context. The model does not choose it. The budget is about
 * 6000 tokens, counted with the same estimate as the LLM gateway.
 *
 * Sources and labels:
 *   [F]  the description of the folder
 *   [P#] a past meeting: a recent summary or a retrieved chunk
 *   [L#] a line of the live transcript (mm:ss)
 */
import type { DatabaseSync } from "node:sqlite";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import { estimatePromptTokens } from "../../llm/token-budget.js";
import {
  hitText as defaultHitText,
  retrieve as defaultRetrieve,
} from "../../search/retrieve.js";
import type { LiveLine } from "./store.js";

const log = createAppLogger("meeting-live-chat");

/** Tokens: folder block, recent summaries, retrieved chunks, live tail. */
export const FOLDER_TOKENS_MAX = 300;
export const SUMMARIES_TOKENS_MAX = 1200;
export const RETRIEVED_TOKENS_MAX = 1500;
export const LIVE_TAIL_TOKENS_MAX = 2500;
const SUMMARIES_MAX = 3;
const RETRIEVE_K = 8;
const HIT_CHARS = 320;
/** The wait for the search index never takes longer. */
export const RETRIEVE_WAIT_MS = 8000;

export interface ChatSource {
  label: string;
  kind: "live" | "past" | "folder";
  meetingId?: string;
  title?: string | null;
  /** Live line: ms from the recording start. Past chunk: its start, or null. */
  timeMs?: number | null;
  startedAt?: number;
}

export interface ChatContext {
  /** The SOURCES block. */
  sources: string;
  /** Source info for each label. */
  index: Map<string, ChatSource>;
  /** Estimated tokens of the sources. */
  tokens: number;
  /** What was left out, for the log. */
  notes: string[];
}

export interface ChatContextDeps {
  retrieve: typeof defaultRetrieve;
  hitText: typeof defaultHitText;
}

const defaultDeps: ChatContextDeps = {
  retrieve: defaultRetrieve,
  hitText: defaultHitText,
};

/** Cut text to about `tokens`. The cut keeps the start. */
function cutToTokens(text: string, tokens: number): string {
  if (estimatePromptTokens(text) <= tokens) return text;
  let end = Math.min(text.length, tokens * 3);
  while (end > 0 && estimatePromptTokens(text.slice(0, end)) > tokens) {
    end = Math.floor(end * 0.9);
  }
  return `${text.slice(0, end).trimEnd()}...`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The live tail: the newest lines that fit. Oldest of them comes first. */
export function liveTailBlock(
  lines: readonly LiveLine[],
  maxTokens: number,
): { text: string; sources: ChatSource[] } {
  const kept: LiveLine[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const cost = estimatePromptTokens(line.text) + 8;
    if (used + cost > maxTokens) break;
    used += cost;
    kept.unshift(line);
  }
  const sources: ChatSource[] = [];
  const rows = kept.map((line, i) => {
    const label = `L${i + 1}`;
    sources.push({ label, kind: "live", timeMs: line.startMs });
    const who = line.source === "mic" ? "Me" : "Them";
    return `[${label}] (${formatClock(line.startMs)}, ${who}) ${line.text}`;
  });
  return { text: rows.join("\n"), sources };
}

interface MeetingRow {
  folder_id: string | null;
}

/**
 * Build the sources of one question. `live` holds the lines of the running
 * recording, oldest first. The question is not part of the sources: the route
 * puts it last in the prompt.
 */
export async function buildChatContext(
  db: DatabaseSync,
  input: {
    meetingId: string;
    question: string;
    live: readonly LiveLine[];
    /** Token budget for the whole sources block. */
    budgetTokens?: number;
  },
  deps: ChatContextDeps = defaultDeps,
): Promise<ChatContext> {
  const budget = input.budgetTokens ?? 6000;
  const index = new Map<string, ChatSource>();
  const notes: string[] = [];
  const blocks: string[] = [];
  let used = 0;
  const add = (text: string): void => {
    blocks.push(text);
    used += estimatePromptTokens(text);
  };

  const row = db
    .prepare("SELECT folder_id FROM meetings WHERE id = ?")
    .get(input.meetingId) as MeetingRow | undefined;
  const folderId = row?.folder_id ?? null;

  // The live tail comes first in the build, because it must always fit.
  const tail = liveTailBlock(input.live, LIVE_TAIL_TOKENS_MAX);

  // [F] The folder name and description.
  if (folderId) {
    const folder = db
      .prepare("SELECT name, description FROM meeting_folders WHERE id = ?")
      .get(folderId) as
      | { name: string; description: string | null }
      | undefined;
    if (folder) {
      index.set("F", { label: "F", kind: "folder", title: folder.name });
      add(
        cutToTokens(
          `[F] Folder "${folder.name}"${folder.description ? `: ${folder.description}` : ""}`,
          FOLDER_TOKENS_MAX,
        ),
      );
    }
  }

  let pastNo = 0;
  const addPast = (
    meetingId: string,
    title: string | null,
    startedAt: number,
    startMs: number | null,
    body: string,
    kind: string,
  ): string => {
    pastNo++;
    const label = `P${pastNo}`;
    index.set(label, {
      label,
      kind: "past",
      meetingId,
      title,
      startedAt,
      timeMs: startMs,
    });
    const when = startMs === null ? "" : `, ${formatClock(startMs)}`;
    return `[${label}] (${kind}: "${title ?? "Untitled"}", ${formatDate(startedAt)}${when}) ${body}`;
  };

  // [P#] The newest summaries of the folder.
  if (folderId) {
    const rows = db
      .prepare(
        `SELECT m.id, m.title, m.started_at, s.markdown
           FROM meetings m JOIN meeting_summaries s ON s.meeting_id = m.id
          WHERE m.folder_id = ? AND m.id != ? AND COALESCE(s.markdown, '') != ''
          ORDER BY m.started_at DESC LIMIT ?`,
      )
      .all(folderId, input.meetingId, SUMMARIES_MAX) as {
      id: string;
      title: string | null;
      started_at: number;
      markdown: string;
    }[];
    const each = Math.floor(SUMMARIES_TOKENS_MAX / SUMMARIES_MAX);
    for (const r of rows) {
      add(
        addPast(
          r.id,
          r.title,
          r.started_at,
          null,
          cutToTokens(r.markdown, each),
          "summary",
        ),
      );
    }
  }

  // [P#] Retrieved chunks of the folder (or of the unfiled meetings).
  const query = input.question.trim();
  if (query) {
    const signal = AbortSignal.timeout(RETRIEVE_WAIT_MS);
    try {
      const result = await deps.retrieve({
        query: { kind: "text", text: query },
        scope: folderId ? { kind: "folder", folderId } : { kind: "unfiled" },
        k: RETRIEVE_K,
        excludeMeetingIds: [input.meetingId],
        signal,
      });
      if (result.status !== "ok") {
        notes.push(`search ${result.status}`);
      } else {
        let retrieved = 0;
        for (const hit of result.hits) {
          if (hit.kind !== "summary" && hit.kind !== "transcript") continue;
          const text = deps.hitText(hit, HIT_CHARS);
          if (!text) continue;
          const meeting = db
            .prepare("SELECT title, started_at FROM meetings WHERE id = ?")
            .get(hit.meetingId) as
            | { title: string | null; started_at: number }
            | undefined;
          if (!meeting) continue;
          const block = addPast(
            hit.meetingId,
            meeting.title,
            meeting.started_at,
            hit.startMs,
            text,
            hit.kind,
          );
          const cost = estimatePromptTokens(block);
          if (retrieved + cost > RETRIEVED_TOKENS_MAX) break;
          retrieved += cost;
          add(block);
        }
      }
    } catch (err) {
      notes.push("search failed");
      log.warn(`Chat retrieval failed: ${errorMessage(err)}`);
    }
  }

  // [L#] The live tail. A drop of past blocks is the only way to make room.
  const tailTokens = estimatePromptTokens(tail.text);
  while (used + tailTokens > budget && blocks.length > 0) {
    blocks.pop();
    notes.push("dropped a past block");
    used = blocks.reduce((n, b) => n + estimatePromptTokens(b), 0);
  }
  for (const s of tail.sources) index.set(s.label, s);
  if (tail.text) add(tail.text);
  // Labels of dropped blocks are not valid cites any more.
  for (const label of [...index.keys()]) {
    if (!blocks.some((b) => b.includes(`[${label}]`))) index.delete(label);
  }
  return { sources: blocks.join("\n\n"), index, tokens: used, notes };
}
