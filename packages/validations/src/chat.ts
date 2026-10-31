import { z } from "zod";

// The meeting chat agent (specs/meeting-chat-agent.md). P1: the Ask tab of one
// meeting, read only. This file is the contract between the server routes and
// the renderer. Fixed words in blocks are localized by the renderer (spec 6.3).

/** Characters of a question, at most. */
export const CHAT_QUESTION_MAX_CHARS = 1000;

/** The Ask page settings (spec 2.9). Defaults are the values that the eval measured. */
export const CHAT_SETTING_LIMITS = {
  rounds: { min: 1, max: 5, default: 3 },
  sourceBudget: { min: 2000, max: 30000, default: 6000 },
  k: { min: 3, max: 20, default: 8 },
  deadlineSeconds: { min: 20, max: 180, default: 60 },
} as const;

export const chatScopeSchema = z.object({
  kind: z.enum(["meeting", "folder"]),
  id: z.string().min(1),
});
export type ChatScope = z.infer<typeof chatScopeSchema>;

/** What a source holds (spec 6.1). */
export const CHAT_CITE_KINDS = [
  "transcript",
  "summary",
  "item",
  "window",
  "live",
  "folder",
] as const;

/** The cite that goes to the UI and to the database (spec 6.1). */
export const chatCiteSchema = z.object({
  label: z.string(),
  kind: z.enum(CHAT_CITE_KINDS),
  meeting_id: z.string(),
  title: z.string().nullable(),
  started_at: z.number().int().nullable(),
  /** Where the chip opens the meeting. null for a summary or an item. */
  start_ms: z.number().int().nullable(),
  item_id: z.string().nullable(),
  /** The cited text (at most 320 characters). */
  text: z.string(),
});
export type ChatCite = z.infer<typeof chatCiteSchema>;

export const chatListItemSchema = z.object({
  text: z.string(),
  meeting_id: z.string().nullable(),
  meeting_title: z.string().nullable(),
  item_id: z.string().nullable(),
  /** Action items only. */
  done: z.boolean().nullable(),
  owner: z.string().nullable(),
  due: z.string().nullable(),
  label: z.string().nullable(),
});
export type ChatListItem = z.infer<typeof chatListItemSchema>;

/** An answer block. The renderer writes the fixed words with `t()`. */
export const chatBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("list"),
    /** "action_items" | "decisions" | "open_questions" */
    list: z.enum(["action_items", "decisions", "open_questions"]),
    total: z.number().int(),
    items: z.array(chatListItemSchema),
  }),
  z.object({
    kind: z.literal("count"),
    n: z.number().int(),
    what: z.enum(["action_items", "decisions", "open_questions", "meetings"]),
  }),
  z.object({
    kind: z.literal("status"),
    bullets: z.array(z.string()),
    open_actions: z.number().int(),
    open_questions: z.number().int(),
  }),
  z.object({
    kind: z.literal("not_found"),
    scope: chatScopeSchema,
    /** Why: no source, cite check failed twice, deadline, cap, search off. */
    reason: z.enum([
      "no_sources",
      "cite_check",
      "deadline",
      "call_cap",
      "model_error",
    ]),
    /** The nearest sources, shown as links. */
    nearest: z.array(chatCiteSchema),
  }),
]);
export type ChatBlock = z.infer<typeof chatBlockSchema>;

/** One step of the trail (spec 11.2 point 6). */
export const chatTraceStepSchema = z.object({
  stage: z.enum([
    "gate",
    "route",
    "plan",
    "slots",
    "tool",
    "rerank",
    "answer",
    "cite_check",
  ]),
  /** Tool name, router arm ("native", "structured", "default"), or detail. */
  name: z.string(),
  rows: z.number().int().nullable(),
  ms: z.number().int(),
  note: z.string().nullable(),
});
export type ChatTraceStep = z.infer<typeof chatTraceStepSchema>;

export const chatTraceSchema = z.object({
  intent: z.string().nullable(),
  router: z.enum(["native", "structured", "default", "skipped"]),
  steps: z.array(chatTraceStepSchema),
  calls: z.number().int(),
  /** Sources left out by the context rules (spec 2.8 point 6). */
  sources_dropped: z.array(z.string()),
  history_turns_dropped: z.number().int(),
  source_tokens: z.number().int(),
});
export type ChatTrace = z.infer<typeof chatTraceSchema>;

export const chatMessageSchema = z.object({
  id: z.number().int(),
  thread_id: z.string(),
  role: z.enum(["user", "assistant"]),
  /** Plain text of the question, or of the answer (empty for a block-only answer). */
  content: z.string(),
  blocks: z.array(chatBlockSchema),
  cites: z.array(chatCiteSchema),
  trace: chatTraceSchema.nullable(),
  model_id: z.string().nullable(),
  provider: z.string().nullable(),
  ms: z.number().int().nullable(),
  created_at: z.number().int(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatThreadSchema = z.object({
  id: z.string(),
  meeting_id: z.string().nullable(),
  folder_id: z.string().nullable(),
  title: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type ChatThread = z.infer<typeof chatThreadSchema>;

export const chatCreateThreadSchema = z.object({ scope: chatScopeSchema });
export const chatAskSchema = z.object({
  question: z.string().trim().min(1).max(CHAT_QUESTION_MAX_CHARS),
});

/** Why the gate refused a turn (spec 2.5a). The HTTP status is 409. */
export const CHAT_GATE_REASONS = [
  "off",
  "no_model",
  "provider_not_ready",
  "scope_missing",
] as const;
export const chatGateErrorSchema = z.object({
  error: z.string(),
  reason: z.enum(CHAT_GATE_REASONS),
});

/** The reply of `POST /api/chat/threads/:id/messages`. */
export const chatAskReplySchema = z.object({
  user: chatMessageSchema,
  assistant: chatMessageSchema,
});
export type ChatAskReply = z.infer<typeof chatAskReplySchema>;

/** The reply of `GET /api/chat/threads/:id`. */
export const chatThreadDetailSchema = z.object({
  thread: chatThreadSchema,
  messages: z.array(chatMessageSchema),
});
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
