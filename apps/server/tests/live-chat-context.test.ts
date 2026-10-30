// Live chat context builder and reply parser (issue #375,
// specs/live-chat.md sections 3 and 4). Fictional data. The search index is
// a stub: tests/search-index.test.ts covers the real retrieve.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChatContext,
  type ChatContextDeps,
  LIVE_TAIL_TOKENS_MAX,
  liveTailBlock,
} from "../src/lib/meetings/live/chat-context.js";
import {
  CHAT_SYSTEM_PROMPT,
  parseChatReply,
} from "../src/lib/meetings/live/chat-prompt.js";
import type { LiveLine } from "../src/lib/meetings/live/store.js";

let db: DatabaseSync;

function line(startMs: number, text: string): LiveLine {
  return { source: "mic", startMs, endMs: startMs + 1000, text, final: true };
}

function deps(over: Partial<ChatContextDeps> = {}): ChatContextDeps {
  return {
    retrieve: vi.fn(async () => ({
      status: "ok" as const,
      modelId: "m",
      hits: [
        {
          chunkId: 1,
          meetingId: "past",
          score: 0.9,
          ordinal: 0,
          kind: "transcript" as const,
          startMs: 12_000,
          endMs: 20_000,
        },
      ],
    })),
    hitText: vi.fn(() => "The budget for Larkspur is 12 thousand."),
    ...over,
  };
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE meeting_folders (id TEXT PRIMARY KEY, name TEXT, description TEXT);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, started_at INTEGER, folder_id TEXT);
    CREATE TABLE meeting_summaries (meeting_id TEXT PRIMARY KEY, markdown TEXT);
    INSERT INTO meeting_folders VALUES ('f1', 'Larkspur', 'Beta launch of the app.');
    INSERT INTO meetings VALUES ('live', 'Live', 1000, 'f1');
    INSERT INTO meetings VALUES ('past', 'Budget review', 500, 'f1');
    INSERT INTO meeting_summaries VALUES ('past', '- Budget is 12 thousand.');
  `);
});

describe("buildChatContext", () => {
  it("labels the folder, the summary, the chunk and the live lines", async () => {
    const ctx = await buildChatContext(
      db,
      {
        meetingId: "live",
        question: "budget?",
        live: [line(5000, "Dana said the beta ships on the 14th.")],
      },
      deps(),
    );
    expect(ctx.sources).toContain("[F]");
    expect(ctx.sources).toContain("[P1]");
    expect(ctx.sources).toContain("[P2]");
    expect(ctx.sources).toContain("[L1] (0:05, Me) Dana said");
    expect([...ctx.index.keys()].sort()).toEqual(["F", "L1", "P1", "P2"]);
    expect(ctx.index.get("P2")).toMatchObject({
      kind: "past",
      meetingId: "past",
      timeMs: 12_000,
    });
  });

  it("scopes the search to the folder and excludes the live meeting", async () => {
    const d = deps();
    await buildChatContext(
      db,
      { meetingId: "live", question: "x", live: [] },
      d,
    );
    expect(d.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "folder", folderId: "f1" },
        excludeMeetingIds: ["live"],
      }),
    );
  });

  it("uses the unfiled scope for an unfiled meeting", async () => {
    db.exec("INSERT INTO meetings VALUES ('loose', 'Loose', 1, NULL)");
    const d = deps();
    const ctx = await buildChatContext(
      db,
      { meetingId: "loose", question: "x", live: [] },
      d,
    );
    expect(d.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "unfiled" } }),
    );
    expect(ctx.sources).not.toContain("[F]");
  });

  it("goes on when the search is off or fails", async () => {
    const off = await buildChatContext(
      db,
      { meetingId: "live", question: "x", live: [line(0, "hello")] },
      deps({
        retrieve: vi.fn(
          async () => ({ status: "off", reason: "no_model" }) as never,
        ),
      }),
    );
    expect(off.notes).toContain("search off");
    expect(off.sources).toContain("[L1]");
    const boom = await buildChatContext(
      db,
      { meetingId: "live", question: "x", live: [line(0, "hello")] },
      deps({
        retrieve: vi.fn(async () => {
          throw new Error("worker down");
        }),
      }),
    );
    expect(boom.notes).toContain("search failed");
    expect(boom.sources).toContain("[L1]");
  });

  it("drops past blocks first when the budget is small, and keeps the live tail", async () => {
    const ctx = await buildChatContext(
      db,
      {
        meetingId: "live",
        question: "x",
        live: [line(0, "Dana said the beta ships on the 14th.")],
        budgetTokens: 40,
      },
      deps(),
    );
    expect(ctx.sources).toContain("[L1]");
    expect(ctx.sources).not.toContain("[P2]");
    expect(ctx.index.has("P2")).toBe(false);
    expect(ctx.notes).toContain("dropped a past block");
  });
});

describe("liveTailBlock", () => {
  it("keeps the newest lines inside the budget, oldest of them first", () => {
    const lines = Array.from({ length: 400 }, (_, i) =>
      line(i * 1000, `line number ${i} with some words to fill the budget`),
    );
    const tail = liveTailBlock(lines, LIVE_TAIL_TOKENS_MAX);
    expect(tail.sources.length).toBeLessThan(400);
    expect(tail.text).toContain("line number 399");
    expect(tail.text).not.toContain("line number 0 ");
    expect(tail.sources[0].label).toBe("L1");
  });
});

describe("parseChatReply", () => {
  it("reads the JSON answer and cleans the labels", () => {
    expect(
      parseChatReply('Sure {"answer": "The 14th.", "cites": ["[L2]", "P1"]}'),
    ).toEqual({ answer: "The 14th.", cites: ["L2", "P1"] });
  });

  it("turns a reply that is not JSON into a plain answer", () => {
    expect(parseChatReply("The 14th.")).toEqual({
      answer: "The 14th.",
      cites: [],
    });
  });

  it("has rules for cites and for a missing answer", () => {
    expect(CHAT_SYSTEM_PROMPT).toContain("Not found in the sources.");
  });
});
