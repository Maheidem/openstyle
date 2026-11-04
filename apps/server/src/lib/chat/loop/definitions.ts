// The four tools of the Ask tool loop (specs/meeting-chat-agent.md 11.10.4).
// The descriptions are the tool contract. They are written once. A change after
// a read of failing eval rows needs a general reason (spec 11.10.8, isolation
// rules). No description holds a question, a key or a word of a blind set.

export const TOOL_NAMES = [
  "list_meetings",
  "search",
  "read",
  "list_items",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_meetings",
      description:
        "List all meetings of this project, oldest first, with label, date, title and a short gist. Use it for questions about order, time, first or last meeting, or the whole project.",
      parameters: {
        type: "object",
        properties: {
          date_from: { type: "string", description: "YYYY-MM-DD" },
          date_to: { type: "string", description: "YYYY-MM-DD" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Find passages of the transcripts and summaries by meaning and words. Use a full topic phrase with names, not pronouns. Returns passages with a source label.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A self-contained phrase." },
          meeting_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Up to 10 meeting labels such as M3. Leave it out for all meetings.",
          },
          date_from: { type: "string", description: "YYYY-MM-DD" },
          date_to: { type: "string", description: "YYYY-MM-DD" },
          kind: { type: "string", enum: ["transcript", "summary"] },
          k: { type: "integer", description: "Passages, 1 to 20. Default 10." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read more of one source. id is a meeting label (M3) or a passage label (S5). part is summary or transcript. A transcript span is at most 3 minutes: when the result says there is more, call again with from_ms.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          part: { type: "string", enum: ["summary", "transcript"] },
          from_ms: { type: "integer" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_items",
      description:
        "List action items, decisions and open questions with their status and history. Use it for what is open, who owns what, what blocked it, and what changed.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "done", "all"] },
          kind: { type: "string", enum: ["action", "decision", "question"] },
          owner: { type: "string" },
          meeting_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Up to 10 meeting labels. Leave it out for all meetings.",
          },
          date_from: { type: "string", description: "YYYY-MM-DD" },
          limit: { type: "integer", description: "At most 50. Default 25." },
        },
        required: [],
      },
    },
  },
] as const;

/** One line for each tool, for the system prompt of a step. */
export const TOOL_LINE: Record<ToolName, string> = {
  list_meetings: "list_meetings (all meetings)",
  search: "search (passages by meaning and words)",
  read: "read (a summary or a transcript span)",
  list_items:
    "list_items (action items, decisions and open questions with their history)",
};
