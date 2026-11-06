// MCP tools for the vocabulary (the names and terms that transcription and
// cleanup must spell right). Each tool calls an existing route of
// routes/vocabulary.ts.
import { z } from "zod";
import {
  confirmArg,
  defineTool,
  expectOk,
  query,
  seg,
  ToolError,
} from "./define.js";

const vocabularyId = z
  .number()
  .int()
  .positive()
  .describe("The entry id (from list_vocabulary).");

const listVocabulary = defineTool({
  name: "list_vocabulary",
  description:
    "List the vocabulary entries (terms and notes), one page at a time.",
  kind: "read",
  idempotent: true,
  input: z.object({
    search: z
      .string()
      .optional()
      .describe("Only entries whose term or notes contain this text."),
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
      .describe("The first entry to give. The default is 0."),
  }),
  run: async (args, { api }) => ({
    data: expectOk(await api("GET", `/api/vocabulary${query(args)}`)),
  }),
});

const addVocabulary = defineTool({
  name: "add_vocabulary",
  description:
    "Add vocabulary entries. A term that exists already is skipped. The answer gives the counts of imported and skipped entries.",
  kind: "write",
  idempotent: true,
  input: z.object({
    entries: z
      .array(
        z.object({
          term: z
            .string()
            .min(1)
            .describe("The term, for example a name or a product."),
          notes: z
            .string()
            .nullable()
            .optional()
            .describe("How to say or use the term."),
        }),
      )
      .min(1)
      .describe("The entries to add."),
  }),
  run: async ({ entries }, { api }) => {
    const data = expectOk(await api("POST", "/api/vocabulary/import", entries));
    return { data, change: { kind: "vocabulary" } };
  },
});

const updateVocabulary = defineTool({
  name: "update_vocabulary",
  description: "Change the term or the notes of a vocabulary entry.",
  kind: "write",
  idempotent: true,
  input: z.object({
    vocabulary_id: vocabularyId,
    term: z.string().min(1).optional().describe("The new term."),
    notes: z
      .string()
      .optional()
      .describe("The new notes. An empty text clears them."),
  }),
  run: async ({ vocabulary_id, ...fields }, { api }) => {
    const data = expectOk(
      await api("PUT", `/api/vocabulary/${seg(vocabulary_id)}`, fields),
    );
    return {
      data,
      change: { kind: "vocabulary", ids: [String(vocabulary_id)] },
    };
  },
});

const deleteVocabulary = defineTool({
  name: "delete_vocabulary",
  description: "Delete a vocabulary entry. This cannot be undone.",
  kind: "delete",
  idempotent: true,
  input: z.object({ vocabulary_id: vocabularyId, confirm: confirmArg }),
  run: async ({ vocabulary_id }, { api }) => {
    const data = expectOk(
      await api("POST", "/api/vocabulary/actions", {
        action: "bulk-delete",
        ids: [vocabulary_id],
      }),
    ) as { deleted: number };
    if (data.deleted === 0) {
      throw new ToolError("Not found (404): No vocabulary entry has this id");
    }
    return {
      data,
      change: { kind: "vocabulary", ids: [String(vocabulary_id)] },
    };
  },
});

export const vocabularyTools = [
  listVocabulary,
  addVocabulary,
  updateVocabulary,
  deleteVocabulary,
];
