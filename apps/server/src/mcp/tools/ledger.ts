// MCP tools for the open items of the folders (the item ledger). Each tool
// calls a route of routes/ledger.ts. Marks are append only: a change of state
// is a new mark (add_open_item_mark).
import { z } from "zod";
import {
  confirmArg,
  defineTool,
  expectOk,
  LIST_LIMIT_DEFAULT,
  pageArgs,
  pageFields,
  query,
  seg,
} from "./define.js";

const itemId = z
  .string()
  .min(1)
  .describe("The open item id (from list_open_items).");
const kind = z.enum(["action", "decision", "question"]);
const quote = z
  .string()
  .min(1)
  .max(240)
  .describe(
    "A short quote from the meeting transcript that shows this. quote_ok in the answer says if the quote was found.",
  );
const owner = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Who owns the item, if known.");

const listOpenItems = defineTool({
  name: "list_open_items",
  description:
    "List the open items (action items, decisions and questions) that the meetings raised, newest mark first, one page at a time. Each item has its marks (raised, open, done, dropped, changed) in date order. nowStatus is the last mark.",
  kind: "read",
  idempotent: true,
  input: z.object({
    folder_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Only the items of this folder. "none" gives the items of the meetings with no folder.',
      ),
    kind: kind.optional().describe("Only items of this kind."),
    status: z
      .enum(["open", "done", "all"])
      .optional()
      .describe(
        "open (the default): not done and not dropped. done: done or dropped. all: every item.",
      ),
    ...pageArgs,
  }),
  run: async ({ offset = 0, limit = LIST_LIMIT_DEFAULT, ...args }, { api }) => {
    const page = expectOk(
      await api("GET", `/api/ledger/items${query({ ...args, limit, offset })}`),
    ) as { items: unknown[]; total: number };
    return {
      data: {
        ...pageFields(page.total, offset, limit, page.items.length),
        items: page.items,
      },
    };
  },
});

const createOpenItem = defineTool({
  name: "create_open_item",
  description:
    "Add a new open item that a meeting raised. The item goes to the folder of the meeting and gets a raised mark.",
  kind: "write",
  idempotent: false,
  input: z.object({
    meeting_id: z
      .string()
      .min(1)
      .describe("The meeting that raised the item (from list_meetings)."),
    kind: kind.describe("action, decision or question."),
    text: z.string().min(1).max(1000).describe("The item, in one line."),
    quote,
    owner,
  }),
  run: async (args, { api, agent }) => {
    const data = expectOk(
      await api("POST", "/api/ledger/items", { ...args, agent }),
    ) as { id: string };
    return { data, change: { kind: "open-item", ids: [data.id] } };
  },
});

const updateOpenItem = defineTool({
  name: "update_open_item",
  description:
    "Change the text or the kind of an open item. Give at least one field. To change its state, use add_open_item_mark.",
  kind: "write",
  idempotent: true,
  input: z.object({
    item_id: itemId,
    text: z.string().min(1).max(1000).optional().describe("The new text."),
    kind: kind.optional().describe("The new kind."),
  }),
  run: async ({ item_id, ...fields }, { api }) => {
    const data = expectOk(
      await api("PATCH", `/api/ledger/items/${seg(item_id)}`, fields),
    );
    return { data, change: { kind: "open-item", ids: [item_id] } };
  },
});

const addOpenItemMark = defineTool({
  name: "add_open_item_mark",
  description:
    "Record what a meeting says about an open item: still open, done, dropped or changed. The meeting must be in the folder of the item. Marks cannot be changed or removed.",
  kind: "write",
  idempotent: false,
  input: z.object({
    item_id: itemId,
    meeting_id: z
      .string()
      .min(1)
      .describe("The meeting that says this (from list_meetings)."),
    status: z
      .enum(["open", "done", "dropped", "changed"])
      .describe("The state of the item after this meeting."),
    quote,
    owner,
    reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Why the state changed, if the meeting says it."),
  }),
  run: async ({ item_id, ...mark }, { api, agent }) => {
    const data = expectOk(
      await api("POST", `/api/ledger/items/${seg(item_id)}/marks`, {
        ...mark,
        agent,
      }),
    );
    return { data, change: { kind: "open-item", ids: [item_id] } };
  },
});

const deleteOpenItem = defineTool({
  name: "delete_open_item",
  description: "Delete an open item with all its marks. This cannot be undone.",
  kind: "delete",
  idempotent: true,
  input: z.object({ item_id: itemId, confirm: confirmArg }),
  run: async ({ item_id }, { api }) => {
    const data = expectOk(
      await api("DELETE", `/api/ledger/items/${seg(item_id)}`),
    );
    return { data, change: { kind: "open-item", ids: [item_id] } };
  },
});

export const ledgerTools = [
  listOpenItems,
  createOpenItem,
  updateOpenItem,
  addOpenItemMark,
  deleteOpenItem,
];
