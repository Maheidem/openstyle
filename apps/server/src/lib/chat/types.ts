import type { DatabaseSync } from "node:sqlite";
import type {
  ChatBlock,
  ChatCite,
  ChatScope,
  ChatTrace,
} from "@openstyle/validations";

// Internal types of the meeting chat agent (specs/meeting-chat-agent.md).
// The wire types are in packages/validations/src/chat.ts.

export const INTENTS = [
  "lookup",
  "who_said",
  "aggregate",
  "temporal",
  "review",
  "status",
  "write",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];

/** One source of a turn (spec 6.1). The model sees label, title, date and text. */
export interface Source {
  /** S1..Sn. */
  label: string;
  kind: ChatCite["kind"];
  meetingId: string;
  title: string | null;
  startedAt: number | null;
  startMs: number | null;
  endMs: number | null;
  itemId: string | null;
  /** The text shown to the model. Chunk hits are cut to 320 characters. */
  text: string;
}

/** The per-turn source map. Labels are S1..Sn in the order of `add`. */
export class SourceMap {
  private readonly byLabel = new Map<string, Source>();

  /** Adds a source and gives it the next label. An equal source returns the first one. */
  add(s: Omit<Source, "label">): Source {
    for (const e of this.byLabel.values()) {
      if (
        e.kind === s.kind &&
        e.meetingId === s.meetingId &&
        e.startMs === s.startMs &&
        e.itemId === s.itemId &&
        e.text === s.text
      ) {
        return e;
      }
    }
    const label = `S${this.byLabel.size + 1}`;
    const src: Source = { ...s, label };
    this.byLabel.set(label, src);
    return src;
  }

  get(label: string): Source | undefined {
    return this.byLabel.get(label);
  }

  all(): Source[] {
    return [...this.byLabel.values()];
  }

  get size(): number {
    return this.byLabel.size;
  }

  toCite(label: string): ChatCite | null {
    const s = this.byLabel.get(label);
    if (!s) return null;
    return {
      label: s.label,
      kind: s.kind,
      meeting_id: s.meetingId,
      title: s.title,
      started_at: s.startedAt,
      start_ms: s.startMs,
      item_id: s.itemId,
      text: s.text.slice(0, 320),
    };
  }
}

/** The fixed scope of a turn. Code sets it; a tool cannot widen it (spec 3.1 rule 2). */
export interface TurnScope {
  /** "all" is used by the eval harness only. The routes accept meeting and folder. */
  kind: "meeting" | "folder" | "all";
  id: string | null;
}

export interface ToolContext {
  db: DatabaseSync;
  scope: TurnScope;
  sources: SourceMap;
  /** Start of today (local day) in ms. Dates in answers are relative to it. */
  todayMs: number;
  /** Retrieval k (setting, default 8). */
  k: number;
  /** Rerank the fused candidates (the reranker worker may be absent: then no rerank). */
  rerank: boolean;
  signal?: AbortSignal;
}

/** A tool result. `blocks` is set by tools whose answer is a block and not text. */
export interface ToolResult {
  tool: string;
  /** Rows found. 0 means the tool found nothing (spec 2.5a). */
  rows: number;
  /** Labels of the sources that this call added. */
  labels: string[];
  blocks: ChatBlock[];
  /** Set when retrieval was off or failed; structured tools still ran (spec 2.5a). */
  degraded: "search_off" | "search_error" | null;
  ms: number;
}

/** What the model sends for a tool (labels of closed choices), validated by code. */
export type ModelArgs = Record<string, unknown>;

/** The result of the code validation of a model tool call (spec 2.3 stage 3 rule 1). */
export type Validated<T> =
  | { ok: true; args: T }
  | { ok: false; reason: string };

/** What the pipeline returns to the route and to the eval harness. */
export interface TurnResult {
  blocks: ChatBlock[];
  /** Plain text of the answer (text block), "" when the answer is blocks only. */
  content: string;
  cites: ChatCite[];
  trace: ChatTrace;
  /** Eval only: a write question gives a proposal. Production never applies it. */
  proposal: {
    kind: "action_item" | "retag" | "move" | "merge_people";
    ids: string[];
    arg: string | boolean | string[] | null;
  } | null;
  modelId: string | null;
  provider: string | null;
  runId: string | null;
  ms: number;
}

export type { ChatScope };
