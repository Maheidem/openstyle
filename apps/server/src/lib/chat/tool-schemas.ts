import { z } from "zod";

// Arguments of the chat tools at the id level (specs/meeting-chat-agent.md 3.2
// and 3.3). The model never sends these directly. It sends labels from closed
// choices; code maps the labels to these ids (choices.ts) and validates them.

const iso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish();

export const searchChunksArgs = z.object({
  query: z.string().trim().min(1).max(200),
  /** Intersected with the scope; empty or absent means the whole scope. */
  meeting_ids: z.array(z.string()).max(500).optional(),
  date_from: iso,
  date_to: iso,
  kinds: z.array(z.enum(["transcript", "summary"])).optional(),
  k: z.number().int().min(1).max(50).optional(),
});
export type SearchChunksArgs = z.infer<typeof searchChunksArgs>;

export const getMeetingSummaryArgs = z.object({ meeting_id: z.string() });
export type GetMeetingSummaryArgs = z.infer<typeof getMeetingSummaryArgs>;

export const listActionItemsArgs = z.object({
  status: z.enum(["open", "done", "all"]).optional(),
  /** A person key from list_people: the normalized display name. */
  person_id: z.string().nullish(),
  date_from: iso,
  date_to: iso,
  meeting_id: z.string().nullish(),
});
export type ListActionItemsArgs = z.infer<typeof listActionItemsArgs>;

export const listDecisionsQuestionsArgs = z.object({
  kind: z.enum(["decision", "open_question"]),
  date_from: iso,
  date_to: iso,
  meeting_id: z.string().nullish(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ListDecisionsQuestionsArgs = z.infer<
  typeof listDecisionsQuestionsArgs
>;

export const listPeopleArgs = z.object({
  query: z.string().max(100).nullish(),
});
export type ListPeopleArgs = z.infer<typeof listPeopleArgs>;

export const getTranscriptWindowArgs = z.object({
  meeting_id: z.string(),
  from_ms: z.number().int().min(0),
  to_ms: z.number().int().min(0),
  speaker: z.string().nullish(),
});
export type GetTranscriptWindowArgs = z.infer<typeof getTranscriptWindowArgs>;

export const folderStatusArgs = z.object({});
export type FolderStatusArgs = z.infer<typeof folderStatusArgs>;

export const listMeetingsArgs = z.object({
  date_from: iso,
  date_to: iso,
  tag: z.string().nullish(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ListMeetingsArgs = z.infer<typeof listMeetingsArgs>;

/** Write proposals. P1 builds them for the eval only; nothing is applied. */
export const proposeActionItemChangeArgs = z.object({
  item_id: z.string(),
  done: z.boolean(),
});
export const proposeRetagArgs = z.object({
  meeting_ids: z.array(z.string()).min(1),
  tag: z.string().trim().min(1).max(40),
});
export const proposeMoveArgs = z.object({
  meeting_id: z.string(),
  folder_id: z.string(),
});
export const proposeMergePeopleArgs = z.object({
  person_ids: z.array(z.string()).min(1),
});

export const READ_TOOL_NAMES = [
  "search_chunks",
  "get_meeting_summary",
  "list_action_items",
  "list_decisions_questions",
  "list_people",
  "get_transcript_window",
  "folder_status",
  "list_meetings",
] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

export const WRITE_TOOL_NAMES = [
  "propose_action_item_change",
  "propose_retag",
  "propose_move",
  "propose_merge_people",
] as const;
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];
