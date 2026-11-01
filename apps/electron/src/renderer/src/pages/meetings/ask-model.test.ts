import type {
  ChatCite,
  ChatMessage,
  ChatThread,
  ChatTrace,
} from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import {
  answerBlocks,
  askErrorView,
  checkQuestion,
  citesForLabels,
  citeTarget,
  citeView,
  danglingQuestion,
  formatTimestamp,
  mergeMessages,
  readSelectedThread,
  rememberSelectedThread,
  summarizeTrace,
  threadTitle,
  unsavedQuestion,
} from "./ask-model";

function cite(over: Partial<ChatCite> = {}): ChatCite {
  return {
    label: "S1",
    kind: "transcript",
    meeting_id: "m1",
    title: "Weekly sync",
    started_at: null,
    start_ms: 760_000,
    item_id: null,
    text: "We ship on Friday.",
    ...over,
  };
}

function trace(steps: ChatTrace["steps"]): ChatTrace {
  return {
    intent: null,
    router: "default",
    steps,
    calls: steps.length,
    sources_dropped: [],
    history_turns_dropped: 0,
    source_tokens: 0,
  };
}

const tool = (name: string, rows: number | null) => ({
  stage: "tool" as const,
  name,
  rows,
  ms: 5,
  note: null,
});

describe("formatTimestamp", () => {
  it("writes mm:ss", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(760_000)).toBe("12:40");
    expect(formatTimestamp(65_999)).toBe("01:05");
  });
  it("lets the minutes pass 59", () => {
    expect(formatTimestamp(4_503_000)).toBe("75:03");
  });
  it("guards a bad value", () => {
    expect(formatTimestamp(-5)).toBe("00:00");
    expect(formatTimestamp(Number.NaN)).toBe("00:00");
  });
});

describe("summarizeTrace", () => {
  it("returns nothing for no trace", () => {
    expect(summarizeTrace(null)).toEqual([]);
    expect(summarizeTrace(trace([]))).toEqual([]);
  });
  it("counts rows of search and calls of read tools", () => {
    const parts = summarizeTrace(
      trace([
        { stage: "route", name: "default", rows: null, ms: 1, note: null },
        tool("search_chunks", 3),
        tool("search_chunks", 1),
        tool("get_meeting_summary", 1),
      ]),
    );
    expect(parts).toEqual([
      { key: "searched", count: 4 },
      { key: "readSummary", count: 1 },
    ]);
  });
  it("keeps a search that found 0 rows", () => {
    expect(summarizeTrace(trace([tool("search_chunks", 0)]))).toEqual([
      { key: "searched", count: 0 },
    ]);
  });
  it("sums the list tools and ignores unknown tools", () => {
    const parts = summarizeTrace(
      trace([
        tool("list_action_items", 5),
        tool("list_decisions_questions", 2),
        tool("get_transcript_window", 3),
        tool("folder_status", 1),
      ]),
    );
    expect(parts).toEqual([
      { key: "readTranscript", count: 1 },
      { key: "listed", count: 7 },
    ]);
  });
});

describe("citeView", () => {
  it("gives the time and the title", () => {
    expect(citeView(cite())).toEqual({
      label: "S1",
      time: "12:40",
      title: "Weekly sync",
    });
  });
  it("gives no time for a summary cite and no title for a blank title", () => {
    expect(citeView(cite({ start_ms: null, title: "  " }))).toEqual({
      label: "S1",
      time: null,
      title: null,
    });
  });
});

describe("citeTarget", () => {
  it("opens the transcript at start_ms for this meeting", () => {
    expect(citeTarget(cite(), "m1", null)).toEqual({
      kind: "transcript",
      startMs: 760_000,
    });
    expect(citeTarget(cite({ kind: "window" }), "m1", null)).toEqual({
      kind: "transcript",
      startMs: 760_000,
    });
  });
  it("opens the summary for a summary or item cite", () => {
    expect(
      citeTarget(cite({ kind: "summary", start_ms: null }), "m1", null),
    ).toEqual({ kind: "summary" });
    expect(
      citeTarget(cite({ kind: "item", start_ms: null }), "m1", null),
    ).toEqual({ kind: "summary" });
  });
  it("opens another meeting when it exists or when the list is unknown", () => {
    const other = cite({ meeting_id: "m2" });
    expect(citeTarget(other, "m1", null)).toEqual({
      kind: "meeting",
      meetingId: "m2",
      startMs: 760_000,
    });
    expect(citeTarget(other, "m1", new Set(["m1", "m2"])).kind).toBe("meeting");
  });
  it("marks a meeting that is not in the known list as removed", () => {
    expect(
      citeTarget(cite({ meeting_id: "gone" }), "m1", new Set(["m1"])),
    ).toEqual({ kind: "removed" });
  });
});

describe("citesForLabels", () => {
  it("keeps the label order, skips unknown labels and duplicates", () => {
    const cites = [cite({ label: "S1" }), cite({ label: "S2" })];
    expect(
      citesForLabels(["S2", "S9", "S1", "S2"], cites).map((c) => c.label),
    ).toEqual(["S2", "S1"]);
    expect(citesForLabels([], cites)).toEqual([]);
  });
});

describe("answerBlocks", () => {
  const base: ChatMessage = {
    id: 1,
    thread_id: "t",
    role: "assistant",
    content: "",
    blocks: [],
    cites: [],
    trace: null,
    model_id: null,
    provider: null,
    ms: null,
    created_at: 0,
  };
  it("returns the blocks", () => {
    const blocks = [{ kind: "read_only" as const }];
    expect(answerBlocks({ ...base, blocks })).toBe(blocks);
  });
  it("turns plain content into one text block", () => {
    expect(answerBlocks({ ...base, content: "Hello" })).toEqual([
      { kind: "text", text: "Hello", cites: [] },
    ]);
  });
  it("returns nothing for an empty answer", () => {
    expect(answerBlocks({ ...base, content: "  " })).toEqual([]);
  });
});

describe("threadTitle", () => {
  const thread = (title: string | null): ChatThread => ({
    id: "t",
    meeting_id: "m1",
    folder_id: null,
    title,
    created_at: 0,
    updated_at: 0,
  });
  it("uses the first question on one line", () => {
    expect(threadTitle(thread("What did\n we  decide?"))).toBe(
      "What did we decide?",
    );
  });
  it("cuts a long title at 60 characters", () => {
    const out = threadTitle(thread("x".repeat(200)));
    expect(out?.length).toBe(60);
    expect(out?.endsWith("…")).toBe(true);
  });
  it("gives null for no title", () => {
    expect(threadTitle(thread(null))).toBeNull();
    expect(threadTitle(thread("   "))).toBeNull();
  });
});

describe("checkQuestion", () => {
  it("trims and accepts", () => {
    expect(checkQuestion("  hi  ")).toEqual({
      text: "hi",
      ok: true,
      tooLong: false,
    });
  });
  it("refuses empty text", () => {
    expect(checkQuestion("   ").ok).toBe(false);
  });
  it("accepts 1000 characters and refuses 1001", () => {
    expect(checkQuestion("a".repeat(1000)).ok).toBe(true);
    const over = checkQuestion("a".repeat(1001));
    expect(over.ok).toBe(false);
    expect(over.tooLong).toBe(true);
  });
});

describe("askErrorView", () => {
  it("maps the 409 reasons", () => {
    expect(askErrorView(409, "off")).toEqual({
      key: "errOff",
      action: "settings",
    });
    expect(askErrorView(409, "no_model")).toEqual({
      key: "errNoModel",
      action: "models",
    });
    expect(askErrorView(409, "provider_not_ready")).toEqual({
      key: "errProviderNotReady",
      action: "models",
    });
    expect(askErrorView(409, "busy")).toEqual({
      key: "errBusy",
      action: "retry",
    });
    expect(askErrorView(409, "scope_missing")).toEqual({
      key: "errScope",
      action: "none",
    });
  });
  it("maps 502, an unknown reason and a network error to Retry", () => {
    const failed = { key: "errFailed", action: "retry" };
    expect(askErrorView(502, "failed")).toEqual(failed);
    expect(askErrorView(409, "other")).toEqual(failed);
    expect(askErrorView(500, null)).toEqual(failed);
    expect(askErrorView(null, null)).toEqual(failed);
  });
});

describe("thread that outlives the tab (P1.2)", () => {
  const msg = (id: number, role: "user" | "assistant", content: string) =>
    ({
      id,
      thread_id: "t1",
      role,
      content,
      blocks: [],
      cites: [],
      trace: null,
      model_id: null,
      provider: null,
      ms: null,
      created_at: id,
    }) as ChatMessage;

  it("merges messages once, in the order of the ids", () => {
    const u = msg(1, "user", "q");
    const a = msg(2, "assistant", "a");
    expect(mergeMessages([u], [u, a]).map((m) => m.id)).toEqual([1, 2]);
    expect(mergeMessages([a, u], []).map((m) => m.id)).toEqual([1, 2]);
  });

  it("draws the pending question only when the thread does not hold it", () => {
    const u = msg(1, "user", "Why?");
    expect(unsavedQuestion([u], "Why?")).toBeNull();
    expect(unsavedQuestion([u], " Why? ")).toBeNull();
    expect(unsavedQuestion([], "Why?")).toBe("Why?");
    expect(unsavedQuestion([u, msg(2, "assistant", "a")], "Why?")).toBe("Why?");
    expect(unsavedQuestion([u], null)).toBeNull();
  });

  it("finds a question that has no answer and no running turn", () => {
    const u = msg(1, "user", "Why?");
    expect(danglingQuestion([u], false)).toBe("Why?");
    expect(danglingQuestion([u], true)).toBeNull();
    expect(danglingQuestion([u, msg(2, "assistant", "a")], false)).toBeNull();
    expect(danglingQuestion([], false)).toBeNull();
  });

  it("remembers the thread of each meeting", () => {
    expect(readSelectedThread("m-x")).toBeNull();
    rememberSelectedThread("m-x", "t9");
    expect(readSelectedThread("m-x")).toBe("t9");
    expect(readSelectedThread("m-y")).toBeNull();
  });
});
