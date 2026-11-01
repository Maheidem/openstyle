/**
 * Types of the Ask bubble (specs/meeting-chat-agent.md 11.6). The Meetings
 * page tells the main process what is selected. The main process hands the
 * scope to the bubble when the global hotkey opens it.
 */

/** What the bubble asks about. Scope A has no id. */
export type ChatBubbleScope =
  | { kind: "meeting"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "all" };

/** The message that opens (or re-opens) the bubble. */
export interface ChatBubbleShown {
  scope: ChatBubbleScope;
  /** Counts up on each open, so the page can tell a new open from a re-render. */
  openCount: number;
}

const ID = /^[\w-]{1,128}$/;

/** A scope from an IPC message, or null when it is not a valid scope. */
export function parseBubbleScope(value: unknown): ChatBubbleScope | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { kind?: unknown; id?: unknown };
  if (v.kind === "all") return { kind: "all" };
  if (
    (v.kind === "meeting" || v.kind === "folder") &&
    typeof v.id === "string" &&
    ID.test(v.id)
  ) {
    return { kind: v.kind, id: v.id };
  }
  return null;
}

/** A thread id or meeting id from an IPC message, or null. */
export function parseBubbleId(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}
