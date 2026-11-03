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

/**
 * What a turn searches (spec 3.1 rule 3): one meeting (M), one folder (F), or
 * every meeting (A). Scope A has no id. A thread of scope A has no meeting
 * and no folder (spec 4.2, 11.6).
 */
export const chatScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("meeting"), id: z.string().min(1) }),
  z.object({ kind: z.literal("folder"), id: z.string().min(1) }),
  z.object({ kind: z.literal("all") }),
]);
export type ChatScope = z.infer<typeof chatScopeSchema>;

/**
 * The next wider scope that a `not_found` block offers (spec 6.3, 11.6.4):
 * the folder of a meeting, or every meeting. `name` is the folder name.
 */
export const chatWiderSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("folder"),
    id: z.string().min(1),
    name: z.string(),
  }),
  z.object({ kind: z.literal("all") }),
]);
export type ChatWider = z.infer<typeof chatWiderSchema>;

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
  /** In how many meetings the item was raised (research mode lists), else absent. */
  raised: z.number().int().nullable().optional(),
});
export type ChatListItem = z.infer<typeof chatListItemSchema>;

/** An answer block. The renderer writes the fixed words with `t()`. */
export const chatBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    /** Labels (S1..) of the cites of this paragraph. They match `message.cites`. */
    cites: z.array(z.string()),
    /** A bullet of a lead-plus-bullets answer. Absent for a plain paragraph. */
    bullet: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("list"),
    /** What the list holds. */
    list: z.enum(["action_items", "decisions", "open_questions", "meetings"]),
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
  /**
   * The question asks for a change. P1 is read only: no change is applied
   * (spec 9.1). The renderer says so with `t()`.
   */
  z.object({ kind: z.literal("read_only") }),
  /**
   * One short question before the answer (spec 11.8, D20). Code finds the
   * ambiguity; the renderer writes the question with `t()` from `why` and
   * `subject`. A chip sends `option.ask` as the next question of the thread.
   * "Answer anyway" sends the first question again with `no_clarify`.
   */
  z.object({
    kind: z.literal("clarify"),
    why: z.enum(["scope", "intent", "person"]),
    /** The name the question has in common with the options (a folder word or a first name). */
    subject: z.string().nullable(),
    options: z
      .array(
        z.object({
          /** The chip text. For an intent chip it is the English fallback of `key`. */
          label: z.string(),
          /** summary, decisions, next_steps or open_questions (intent chips), else null. */
          key: z.string().nullable(),
          /** The full question that the chip sends. */
          ask: z.string().min(1).max(CHAT_QUESTION_MAX_CHARS),
        }),
      )
      .min(2)
      .max(6),
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
      /** A broad question asked again: the sources hold no fact that the thread did not tell. */
      "nothing_new",
    ]),
    /** The nearest sources, shown as links. */
    nearest: z.array(chatCiteSchema),
    /** How many meetings the search covered ("Searched N meetings"). Absent in old messages. */
    searched: z.number().int().optional(),
    /**
     * The one wider scope that the user may ask for (spec 6.3, D16). Code sets
     * it. It is absent when the scope is A or the setting turns the offer off.
     */
    wider: chatWiderSchema.nullable().optional(),
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
    "research",
  ]),
  /** Tool name, router arm ("native", "structured", "default"), or detail. */
  name: z.string(),
  rows: z.number().int().nullable(),
  ms: z.number().int(),
  note: z.string().nullable(),
});
export type ChatTraceStep = z.infer<typeof chatTraceStepSchema>;

/**
 * What the research loop did (spec 11.9.7 point 7). The renderer writes the
 * trail line from these fields with `t()`. No model text is in it.
 */
export const chatResearchSchema = z.object({
  /** Loop turns that ran, and the most that were allowed. */
  iterations: z.number().int(),
  max_iter: z.number().int(),
  /** Meetings that the evidence comes from. */
  meetings: z.number().int(),
  /** Tool calls of the loop. */
  searches: z.number().int(),
  /** Why the loop ended. */
  done: z.enum([
    "enough",
    "max_iter",
    "stalled",
    "call_cap",
    "deadline",
    "no_leads",
    "error",
  ]),
  /** The leads that stayed open: what was not found. */
  open_leads: z.array(z.string()),
});
export type ChatResearch = z.infer<typeof chatResearchSchema>;

export const chatTraceSchema = z.object({
  /** Set when the research mode ran (D21). */
  research: chatResearchSchema.optional(),
  /** The scope this turn searched (P2). Absent in a message of P1. */
  scope: chatScopeSchema.optional(),
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
/**
 * One turn: a new question, or `widen: true` (spec 11.6.4). A widen turn asks
 * the last question of the thread again, at the wider scope that the last
 * `not_found` block offered. It saves no second user message.
 */
export const chatAskSchema = z
  .object({
    question: z.string().trim().min(1).max(CHAT_QUESTION_MAX_CHARS).optional(),
    widen: z.literal(true).optional(),
    /** "Answer anyway": the turn does not ask a clarifying question (D20). */
    no_clarify: z.literal(true).optional(),
    /** "Show all": the open-items list is not capped for this turn (11.9.16). */
    show_all: z.literal(true).optional(),
  })
  .refine((v) => (v.question === undefined) !== (v.widen === undefined), {
    message: "Pass exactly one of question and widen",
  });

/** Why the gate refused a turn (spec 2.5a). The HTTP status is 409. */
export const CHAT_GATE_REASONS = [
  "off",
  "no_model",
  "provider_not_ready",
  "scope_missing",
  "widen_not_offered",
  "busy",
  "failed",
  "cancelled",
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

/**
 * What a running turn does now (D20, spec 11.8). The client polls it while a
 * turn runs. `count` is the meetings that the stage covers, or null.
 */
export const chatProgressSchema = z.object({
  stage: z.enum(["searching", "reading", "answering", "researching"]),
  count: z.number().int().nullable(),
  /** Research mode (D21): the loop turn, the most loop turns, the lead and the leads. */
  iteration: z.number().int().optional(),
  max_iter: z.number().int().optional(),
  lead_index: z.number().int().optional(),
  leads: z.number().int().optional(),
});
export type ChatProgress = z.infer<typeof chatProgressSchema>;

/** The reply of `GET /api/chat/threads/:id`. */
export const chatThreadDetailSchema = z.object({
  thread: chatThreadSchema,
  messages: z.array(chatMessageSchema),
  /** True while a turn of this thread runs on the server (P1.2). */
  pending: z.boolean(),
  /** The stage of the running turn, else null. */
  progress: chatProgressSchema.nullable().optional(),
  /** The last turn failed and saved no answer (the client was gone). */
  failure: z.object({ reason: z.string() }).nullable(),
});
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
