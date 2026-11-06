// MCP tools for Ask threads and the dictation history. Each tool calls a
// route of routes/chat.ts or routes/history.ts.
import { z } from "zod";
import { confirmArg, defineTool, expectOk, query, seg } from "./define.js";

const dictationId = z
  .number()
  .int()
  .positive()
  .describe("The dictation id (from list_dictations).");

const threadId = z
  .string()
  .min(1)
  .describe("The thread id (from list_ask_threads).");

const listAskThreads = defineTool({
  name: "list_ask_threads",
  description:
    "List the Ask threads (questions about meetings). Give meeting_id or folder_id for the threads of that scope. Give neither for the threads about all meetings.",
  kind: "read",
  idempotent: true,
  input: z.object({
    meeting_id: z
      .string()
      .min(1)
      .optional()
      .describe("The threads about this meeting."),
    folder_id: z
      .string()
      .min(1)
      .optional()
      .describe("The threads about this folder."),
  }),
  run: async ({ meeting_id, folder_id }, { api }) => {
    const params =
      meeting_id !== undefined
        ? { meeting_id }
        : folder_id !== undefined
          ? { folder_id }
          : { all: "1" };
    return {
      data: expectOk(await api("GET", `/api/chat/threads${query(params)}`)),
    };
  },
});

const getAskThread = defineTool({
  name: "get_ask_thread",
  description: "Get one Ask thread with all its questions and answers.",
  kind: "read",
  idempotent: true,
  input: z.object({ thread_id: threadId }),
  run: async ({ thread_id }, { api }) => ({
    data: expectOk(await api("GET", `/api/chat/threads/${seg(thread_id)}`)),
  }),
});

const renameAskThread = defineTool({
  name: "rename_ask_thread",
  description: "Give an Ask thread a new title.",
  kind: "write",
  idempotent: true,
  input: z.object({
    thread_id: threadId,
    title: z.string().min(1).max(200).describe("The new title."),
  }),
  run: async ({ thread_id, title }, { api }) => {
    const data = expectOk(
      await api("PATCH", `/api/chat/threads/${seg(thread_id)}`, { title }),
    );
    return { data, change: { kind: "ask-thread", ids: [thread_id] } };
  },
});

const deleteAskThread = defineTool({
  name: "delete_ask_thread",
  description:
    "Delete an Ask thread with all its questions and answers. This cannot be undone.",
  kind: "delete",
  idempotent: true,
  input: z.object({ thread_id: threadId, confirm: confirmArg }),
  run: async ({ thread_id }, { api }) => {
    const data = expectOk(
      await api("DELETE", `/api/chat/threads/${seg(thread_id)}`),
    );
    return { data, change: { kind: "ask-thread", ids: [thread_id] } };
  },
});

const listDictations = defineTool({
  name: "list_dictations",
  description:
    "List the dictation history, newest first, one page at a time. Each item has the raw text, the cleaned text and the models.",
  kind: "read",
  idempotent: true,
  input: z.object({
    search: z
      .string()
      .optional()
      .describe("Only dictations that contain this text."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Page size, 1 to 200. The default is 50."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The first item to give. The default is 0."),
    start_date: z
      .string()
      .optional()
      .describe("Only dictations on or after this date (YYYY-MM-DD)."),
    end_date: z
      .string()
      .optional()
      .describe("Only dictations on or before this date (YYYY-MM-DD)."),
  }),
  run: async (args, { api }) => ({
    data: expectOk(
      await api(
        "GET",
        `/api/history${query({ orderBy: "-created_at", ...args })}`,
      ),
    ),
  }),
});

const getDictation = defineTool({
  name: "get_dictation",
  description: "Get one dictation of the history.",
  kind: "read",
  idempotent: true,
  input: z.object({ dictation_id: dictationId }),
  run: async ({ dictation_id }, { api }) => ({
    data: expectOk(await api("GET", `/api/history/${seg(dictation_id)}`)),
  }),
});

const deleteDictation = defineTool({
  name: "delete_dictation",
  description: "Delete one dictation of the history. This cannot be undone.",
  kind: "delete",
  idempotent: true,
  input: z.object({ dictation_id: dictationId, confirm: confirmArg }),
  run: async ({ dictation_id }, { api }) => {
    expectOk(await api("GET", `/api/history/${seg(dictation_id)}`));
    const data = expectOk(
      await api("DELETE", `/api/history/${seg(dictation_id)}`),
    );
    return { data, change: { kind: "dictation", ids: [String(dictation_id)] } };
  },
});

export const historyTools = [
  listAskThreads,
  getAskThread,
  renameAskThread,
  deleteAskThread,
  listDictations,
  getDictation,
  deleteDictation,
];
