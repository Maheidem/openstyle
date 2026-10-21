// Node `summarize` (specs/meeting-enhance-agentic.md 4.5, 10.6 row `summarize`).
// LR9 to LR11, GR10 (c), GR20 (b), GR22, GR26 (b), and the cost and token cases.
// The real graph, the real gateway and the real saver run over a scripted model.
import { APICallError } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { createLlmRecorder } from "../src/lib/llm/recorder.js";
import { buildGraph } from "../src/lib/meetings/workflow/graph.js";
import {
  __setSummaryCeilingMsForTests,
  SUMMARIZE_IS_STUB,
  summaryCeilingMs,
} from "../src/lib/meetings/workflow/nodes/summarize.js";
import { FOLDER_CONTEXT_LABEL } from "../src/lib/meetings/workflow/prompts.js";
import {
  type MeetingSummary,
  MeetingSummarySchema,
} from "../src/lib/meetings/workflow/schemas.js";
import {
  MAX_SUMMARIZE_CALLS,
  plannedSummaryCalls,
  renderSummaryMarkdown,
} from "../src/lib/meetings/workflow/summary-pure.js";
import {
  deriveRunStatus,
  type FinalState,
  WORKFLOW_GRAPH_VERSION,
} from "../src/lib/meetings/workflow/types.js";
import {
  HANG,
  okReply,
  reply,
  type ScriptStep,
  scriptedModel,
  seamFor,
} from "./helpers/fake-model.js";
import type { MeetingFixture } from "./helpers/meeting-fixture.js";
import {
  type FakeRecorder,
  makeFakeRecorder,
  makeTestDeps,
  makeTestRunContext,
  type RecordedRequest,
  resetWorkflowTables,
  responderModel,
  runScriptedGraph,
  seedFixtureMeeting,
  seedTestModel,
  sizeFixtureSegments,
  TEST_MODEL,
} from "./helpers/workflow-harness.js";

const noEnd = {
  cancelled: false,
  fault: "none",
  hasCheckpoint: false,
} as const;
const MIN = 60 * 60 * 1000;

// --- helpers -----------------------------------------------------------------

const isSingle = (r: RecordedRequest) =>
  r.system.includes("You summarize meeting transcripts");
const isMap = (r: RecordedRequest) =>
  r.system.includes("You summarize one part");
const isReduce = (r: RecordedRequest) =>
  r.system.includes("You combine partial summaries");
const partOf = (r: RecordedRequest) =>
  Number(/This is part (\d+) of/.exec(r.user)?.[1] ?? Number.NaN) - 1;

function summary(over: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    overview: "A planning call.",
    keyPoints: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    ...over,
  };
}
const sum = (over: Partial<MeetingSummary> = {}) =>
  okReply(JSON.stringify(summary(over)));
const LENGTH_CUT = reply("length", "length", '{"overview":"cut');
const down = new APICallError({
  message: "HTTP 503",
  url: "http://127.0.0.1:1/v1/chat/completions",
  requestBodyValues: {},
  statusCode: 503,
  isRetryable: true,
});

function setSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(key, value);
}
const setBudget = (n: number) =>
  setSetting("meeting_summary_context_budget", String(n));

/** A meeting of one speaker. Every segment line has about `lineTokens` tokens. */
function meeting(
  chunks: number,
  lineTokens: number,
  meetingId: string,
): MeetingFixture {
  const f = seedFixtureMeeting({ chunks, speakers: 1, meetingId });
  sizeFixtureSegments(getDb(), f, lineTokens);
  return f;
}

const savedRow = (meetingId: string) =>
  getDb()
    .prepare(
      "SELECT markdown, summary_json, llm_provider, llm_model, input_tokens, output_tokens, cost_usd FROM meeting_summaries WHERE meeting_id = ?",
    )
    .get(meetingId) as
    | {
        markdown: string;
        summary_json: string;
        llm_provider: string | null;
        llm_model: string | null;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number | null;
      }
    | undefined;

const keysOf = (rec: FakeRecorder) => rec.calls.map((c) => c.unitKey);
const stepStatus = (rec: FakeRecorder, key: string) =>
  rec.steps.get(key)?.status;
const statusOf = (r: { finalState: unknown }) =>
  deriveRunStatus(r.finalState as FinalState, noEnd);

async function run(
  f: MeetingFixture,
  script: ((r: RecordedRequest) => ScriptStep) | ScriptStep[],
  o: {
    stages?: ("enhance" | "summarize")[];
    recorder?: FakeRecorder;
    ctx?: ReturnType<typeof makeTestRunContext>;
  } = {},
) {
  const recorder = o.recorder ?? makeFakeRecorder();
  const { deps } = makeTestDeps({ recorder });
  const out = await runScriptedGraph({
    deps,
    meetingId: f.meeting.id,
    stages: o.stages ?? ["summarize"],
    script,
    ...(o.ctx ? { ctx: o.ctx } : {}),
  });
  return { ...out, recorder };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  __setSummaryCeilingMsForTests(null);
  seedTestModel();
  getDb().exec("DELETE FROM settings WHERE key LIKE 'meeting_summary%'");
  // The models.dev cache lives 6 hours: move the clock so each test starts cold.
  vi.setSystemTime(new Date(Date.now() + 7 * MIN));
  stubRegistry("reject");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  __setSummaryCeilingMsForTests(null);
});

/** Answer the models.dev read with a price, or with a network fault. */
function stubRegistry(mode: "price" | "reject"): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("models.dev")) throw new TypeError("fetch failed");
    if (mode === "reject") throw new TypeError("fetch failed");
    return new Response(
      JSON.stringify({
        openai: {
          models: { "gpt-4o-mini": { cost: { input: 0.15, output: 0.6 } } },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

// --- the five-field summary, rendering, prompts ------------------------------

describe("summarize: one call (single)", () => {
  it("a short meeting is one request with key `single`; the Markdown is the render of summary_json", async () => {
    expect(SUMMARIZE_IS_STUB).toBe(false);
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    const s = summary({
      overview: "The team reviewed the rollout plan.",
      keyPoints: ["The export job takes four minutes."],
      decisions: ["Move the vendor call to Thursday."],
      actionItems: [
        { task: "Send the draft", owner: "Casey", due: "tomorrow morning" },
        { task: "Write the notes", owner: null, due: null },
      ],
      openQuestions: ["Who owns the onboarding checklist?"],
    });
    const r = await run(f, [okReply(JSON.stringify(s))]);
    expect(r.requests).toHaveLength(1);
    expect(keysOf(r.recorder)).toEqual(["single"]);
    expect(stepStatus(r.recorder, "single")).toBe("succeeded");
    expect(r.finalState.summary?.status).toBe("ok");
    expect(statusOf(r)).toBe("succeeded");
    expect(r.finalState.summary?.callCount).toBe(1);

    const row = savedRow(f.meeting.id);
    const stored = JSON.parse(row?.summary_json as string) as unknown;
    expect(MeetingSummarySchema.parse(stored)).toEqual(s);
    expect(row?.markdown).toBe(renderSummaryMarkdown(stored as MeetingSummary));
    expect(row?.markdown).toContain(
      "- Send the draft (Owner: Casey; Due: tomorrow morning)",
    );
    expect(row?.markdown).toContain("- Write the notes");
    const status = getDb()
      .prepare("SELECT status FROM meetings WHERE id = ?")
      .get(f.meeting.id) as { status: string };
    expect(status.status).toBe("summarized");
  });

  it('an owner or due of "null", "None", "N/A", "unknown" or blank is stored as null and not rendered', async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    const s = summary({
      actionItems: [
        { task: "Send the draft", owner: "null", due: " NULL " },
        { task: "Book the room", owner: "None", due: "n/a" },
        { task: "Check the export", owner: " Unknown", due: "  " },
        { task: "Write the notes", owner: "Casey", due: "Friday" },
      ],
    });
    const r = await run(f, [okReply(JSON.stringify(s))]);
    expect(r.finalState.summary?.status).toBe("ok");
    const row = savedRow(f.meeting.id);
    const stored = JSON.parse(row?.summary_json as string) as MeetingSummary;
    expect(stored.actionItems.map((a) => [a.owner, a.due])).toEqual([
      [null, null],
      [null, null],
      [null, null],
      ["Casey", "Friday"],
    ]);
    // Only the real owner and due are rendered.
    expect(row?.markdown?.match(/Owner: /g)).toHaveLength(1);
    expect(row?.markdown?.match(/Due: /g)).toHaveLength(1);
    expect(row?.markdown).toContain("- Send the draft\n");
    expect(row?.markdown).toContain(
      "- Write the notes (Owner: Casey; Due: Friday)",
    );
  });

  it("the render skips a placeholder owner or due also in an object that did not pass the parse", () => {
    const md = renderSummaryMarkdown(
      summary({
        actionItems: [
          { task: "Send the draft", owner: "null", due: "None" },
          { task: "Book the room", owner: "N/A", due: "tomorrow" },
        ],
      }),
    );
    expect(md).toContain("- Send the draft\n");
    expect(md).toContain("- Book the room (Due: tomorrow)");
    expect(md).not.toContain("Owner:");
  });

  it("an empty summary has the five headings and `None.` under four; `\\n## Fake` makes no heading", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1 });
    await run(f, [sum()]);
    const md = savedRow(f.meeting.id)?.markdown as string;
    expect(md.match(/^## /gm)).toHaveLength(5);
    expect(md.match(/^None\.$/gm)).toHaveLength(4);

    resetWorkflowTables();
    const g = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-fake",
    });
    await run(g, [
      sum({
        overview: "Real start.\n## Fake\nMore text.",
        keyPoints: ["Point\n## Fake"],
      }),
    ]);
    const md2 = savedRow("m-fake")?.markdown as string;
    expect(md2.split("\n").filter((l) => l.startsWith("#"))).toEqual([
      "## Overview",
      "## Key Points",
      "## Decisions",
      "## Action Items",
      "## Open Questions",
    ]);
  });

  it("the prompts: no Markdown section text, no attendee, instructions and context in the right prompts", async () => {
    setSetting("meeting_summary_instructions", "Keep it under five bullets.");
    const f = seedFixtureMeeting({
      chunks: 5,
      speakers: 1,
      meetingId: "m-prompts",
      withCalendar: true,
    });
    sizeFixtureSegments(getDb(), f, 300);
    setBudget(2000);
    const r = await run(f, [sum()]);
    const single = meeting(1, 50, "m-single-p");
    const rs = await run(single, [sum()]);
    for (const req of [...r.requests, ...rs.requests]) {
      expect(req.system).not.toContain("markdown summary");
      expect(req.system).not.toContain("## Overview");
      expect(req.system).not.toContain('{"');
      expect(req.system + req.user).not.toMatch(/Jordan Vale|Casey Marlow/);
      expect(req.system + req.user).not.toContain("example.test");
    }
    const kinds = r.requests.map((x) =>
      isSingle(x) ? "single" : isMap(x) ? "map" : isReduce(x) ? "reduce" : "?",
    );
    expect(kinds).toEqual(["map", "map", "map", "map", "reduce"]);
    const context = "Weekly planning call of a made-up product team.";
    for (const req of r.requests) expect(req.system).toContain(context);
    // Map prompts have no user instructions. Single and reduce have them.
    for (const req of r.requests) {
      expect(req.system.includes("Keep it under five bullets.")).toBe(
        !isMap(req),
      );
    }
    expect(rs.requests[0]?.user).toContain("<transcript>");
    expect(rs.requests[0]?.user).toContain("Treat the tagged text");
  });
});

describe("summarize: folder context (#230)", () => {
  it("a filed meeting: every summary prompt has the meeting context, then the folder block. An unfiled one has no block", async () => {
    const db = getDb();
    db.exec("DELETE FROM meeting_folders");
    const now = Date.now();
    db.prepare(
      "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("fold-1", "Orchid Rollout", "Launch of a made-up app.", now, now);
    const filed = seedFixtureMeeting({
      chunks: 5,
      speakers: 1,
      meetingId: "m-filed",
    });
    sizeFixtureSegments(db, filed, 300);
    db.prepare("UPDATE meetings SET folder_id = ? WHERE id = ?").run(
      "fold-1",
      filed.meeting.id,
    );
    setBudget(2000);
    const r = await run(filed, [sum()]);
    const context = "Weekly planning call of a made-up product team.";
    const block = `${FOLDER_CONTEXT_LABEL} Orchid Rollout - Launch of a made-up app.`;
    expect(r.requests.length).toBeGreaterThan(1);
    for (const req of r.requests) {
      expect(req.system).toContain(`${context}\n\n${block}`);
    }
    const unfiled = meeting(1, 50, "m-unfiled");
    const ru = await run(unfiled, [sum()]);
    for (const req of ru.requests) {
      expect(req.system).toContain(context);
      expect(req.system).not.toContain(FOLDER_CONTEXT_LABEL);
    }
    db.exec("DELETE FROM meetings");
    db.exec("DELETE FROM meeting_folders");
  });
});

// --- the text of each line ---------------------------------------------------

describe("summarize: the text of the lines (4.5 Inputs)", () => {
  it("a summarize-only run uses enhanced_text, else raw, and labels an undiarized speaker `Unidentified`", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1 });
    const [a, b] = f.segments;
    getDb()
      .prepare("UPDATE meeting_segments SET enhanced_text = ? WHERE id = ?")
      .run("The stored correction text.", a?.id as string);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET source = 'system', speaker_label = NULL WHERE id = ?",
      )
      .run(b?.id as string);
    const r = await run(f, [sum()]);
    const user = r.requests[0]?.user ?? "";
    expect(user).toContain("Me: The stored correction text.");
    expect(user).not.toContain(a?.text as string);
    expect(user).toContain(`Unidentified: ${b?.text}`);
  });

  it("a chained run uses this run's correction; an ok unit with no correction gives the raw text, not a stale value", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1 });
    const [a, b] = f.segments;
    getDb()
      .prepare("UPDATE meeting_segments SET enhanced_text = ? WHERE id = ?")
      .run("STALE earlier correction.", b?.id as string);
    const r = await run(
      f,
      (req) =>
        isSingle(req)
          ? sum()
          : okReply(
              JSON.stringify({
                corrections: [{ id: a?.id, text: `${a?.text} fresh` }],
              }),
            ),
      { stages: ["enhance", "summarize"] },
    );
    const summaryReq = r.requests.find(isSingle);
    expect(summaryReq?.user).toContain(`Me: ${a?.text} fresh`);
    expect(summaryReq?.user).toContain(`Me: ${b?.text}`);
    expect(summaryReq?.user).not.toContain("STALE");
  });
});

// --- map and reduce ----------------------------------------------------------

describe("summarize: map and reduce (4.5.3)", () => {
  it("a long transcript is N map calls and one reduce; keys map:0 to map:N-1 then reduce:1:0", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-mr"); // 20 lines of about 300 tokens
    const r = await run(f, (req) =>
      isReduce(req) ? sum({ overview: "Final." }) : sum(),
    );
    const planned = plannedSummaryCalls(5900, 2000);
    expect("calls" in planned && r.requests.length <= planned.calls).toBe(true);
    expect(r.requests.length).toBeLessThanOrEqual(MAX_SUMMARIZE_CALLS);
    expect(keysOf(r.recorder)).toEqual([
      "map:0",
      "map:1",
      "map:2",
      "map:3",
      "reduce:1:0",
    ]);
    expect(r.requests.filter(isMap).map(partOf)).toEqual([0, 1, 2, 3]);
    // The reduce prompt holds the four partials as tagged JSON.
    const reduceReq = r.requests.find(isReduce);
    expect(reduceReq?.user.match(/<partial index="\d">/g)).toHaveLength(4);
    expect(reduceReq?.user).toContain('"overview":"A planning call."');
    expect(savedRow(f.meeting.id)?.summary_json).toContain('"Final."');
    expect(r.finalState.summary?.callCount).toBe(5);
    expect(statusOf(r)).toBe("succeeded");
    // There is no row named `summarize`.
    expect(r.recorder.steps.has("summarize")).toBe(false);
  });

  it("two reduce levels use the keys reduce:1:0, reduce:1:1 and reduce:2:0; level 2 reads the level-1 results", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-2lvl");
    const big = "w".repeat(3600); // about 900 tokens: two fit one group, three do not
    const r = await run(f, (req) => {
      if (isMap(req)) return sum({ overview: big });
      if (req.user.includes(big)) {
        return sum({ overview: `Level one result ${partialCount(req)}.` });
      }
      return sum({ overview: "Final." });
    });
    expect(keysOf(r.recorder)).toEqual([
      "map:0",
      "map:1",
      "map:2",
      "map:3",
      "reduce:1:0",
      "reduce:1:1",
      "reduce:2:0",
    ]);
    const last = r.requests.at(-1);
    expect(last?.user).toContain("Level one result 2.");
    expect(last?.user.match(/Level one result/g)).toHaveLength(2);
    expect(last?.user).not.toContain(big);
    expect(r.requests.length).toBeLessThanOrEqual(MAX_SUMMARIZE_CALLS);
    expect(statusOf(r)).toBe("succeeded");
  });

  it("a context budget that cannot hold two partials fails with budget_exceeded, no call, no summary", async () => {
    setBudget(300);
    const f = meeting(2, 300, "m-300");
    const r = await run(f, [sum()]);
    expect(r.requests).toHaveLength(0);
    expect(r.finalState.summary?.status).toBe("failed");
    expect(r.finalState.summary?.failure?.kind).toBe("budget_exceeded");
    expect(savedRow(f.meeting.id)).toBeUndefined();
    expect(statusOf(r)).toBe("failed");
    expect(r.recorder.steps.get("map:0")?.errorKind).toBe("budget_exceeded");
  });

  it("a plan over 24 calls fails with budget_exceeded before any call", async () => {
    setBudget(2000);
    const f = meeting(40, 300, "m-big-plan"); // 160 lines: more than 24 chunks
    const r = await run(f, [sum()]);
    expect(r.requests).toHaveLength(0);
    expect(r.finalState.summary?.failure?.kind).toBe("budget_exceeded");
    expect(savedRow(f.meeting.id)).toBeUndefined();
  });

  it("GR20 (b): a persistent 503 on the reduce call sends N + 2 requests and no map call again", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-gr20b");
    const r = await run(f, (req) => (isReduce(req) ? down : sum()));
    // 4 map calls, the reduce call, and its one retry.
    expect(r.requests).toHaveLength(4 + 2);
    expect(r.requests.filter(isMap)).toHaveLength(4);
    expect(r.finalState.summary?.status).toBe("failed");
    expect(r.finalState.summary?.failure?.kind).toBe("provider_unavailable");
    expect(r.finalState.summary?.failure?.unitKey).toBe("reduce:1:0");
    expect(savedRow(f.meeting.id)).toBeUndefined();
    expect(stepStatus(r.recorder, "reduce:1:0")).toBe("failed");
    expect(stepStatus(r.recorder, "map:3")).toBe("succeeded");
  });
});

function partialCount(req: RecordedRequest): number {
  return req.user.match(/<partial index="\d+">/g)?.length ?? 0;
}

// --- GR26 (b), the ceiling ---------------------------------------------------

describe("GR26 (b): plannedSummaryCalls and the ceiling", () => {
  it("plans one call under budget; map plus grouped reduces above it; budget_exceeded over 24 or under two partials", () => {
    expect(plannedSummaryCalls(1500, 2000)).toEqual({ calls: 1 });
    // 6000 tokens at 2000: 4 map, 2 level-1 reduces, 1 final reduce.
    expect(plannedSummaryCalls(6000, 2000)).toEqual({ calls: 7 });
    // Six map chunks that do not fit one reduce: 6 map, 3 + 2 grouped reduces, 1 final.
    expect(plannedSummaryCalls(10800, 2000)).toEqual({ calls: 12 });
    expect(plannedSummaryCalls(200000, 2000)).toEqual({
      error: "budget_exceeded",
    });
    expect(plannedSummaryCalls(6000, 1599)).toEqual({
      error: "budget_exceeded",
    });
    expect(plannedSummaryCalls(6000, 300)).toEqual({
      error: "budget_exceeded",
    });
  });

  it("the ceiling is clamp(2 x perCallMs x plannedCalls, 2 x perCallMs, 4 h)", () => {
    const s = 1000;
    expect(summaryCeilingMs(600 * s, 1)).toBe(1200 * s);
    expect(summaryCeilingMs(600 * s, 8)).toBe(9600 * s);
    expect(summaryCeilingMs(600 * s, 24)).toBe(4 * 3600 * s);
    expect(summaryCeilingMs(30 * s, 24)).toBe(1440 * s);
    expect(summaryCeilingMs(30 * s, 0)).toBe(60 * s);
  });
});

describe("GR22: the deadline", () => {
  it("a small ceiling ends deadline_exceeded: run failed, no summary, no step marked cancelled", async () => {
    __setSummaryCeilingMsForTests(40);
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-dl" });
    const r = await run(f, [HANG]);
    expect(r.finalState.summary?.status).toBe("failed");
    expect(r.finalState.summary?.failure?.kind).toBe("deadline_exceeded");
    expect(statusOf(r)).toBe("failed");
    expect(savedRow("m-dl")).toBeUndefined();
    expect(
      [...r.recorder.steps.values()].some((s) => s.status === "cancelled"),
    ).toBe(false);
    expect(stepStatus(r.recorder, "single")).toBe("failed");
    expect(r.recorder.steps.get("single")?.errorKind).toBe("deadline_exceeded");
  });

  it("the ceiling during the map phase skips the rest: no reduce, no summary", async () => {
    __setSummaryCeilingMsForTests(80);
    setBudget(2000);
    const f = meeting(5, 300, "m-dl-map");
    const r = await run(f, (req) => (partOf(req) === 1 ? HANG : sum()));
    expect(r.finalState.summary?.failure?.kind).toBe("deadline_exceeded");
    expect(r.requests.filter(isReduce)).toHaveLength(0);
    expect(r.requests.filter(isMap)).toHaveLength(2);
    expect(savedRow("m-dl-map")).toBeUndefined();
  });
});

// --- the length route (LR9 to LR11) ------------------------------------------

describe("the length route", () => {
  it("LR9: a single call that ends `length` replans into map and reduce; step `single` ends succeeded", async () => {
    const f = meeting(4, 300, "m-lr9"); // about 4700 tokens, budget 8000: single
    const r = await run(f, (req) => {
      if (req.n === 0) return LENGTH_CUT;
      return isReduce(req) ? sum({ overview: "Merged." }) : sum();
    });
    const keys = keysOf(r.recorder);
    expect(keys[0]).toBe("single");
    expect(
      keys.slice(1).filter((k) => k.startsWith("map:")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(keys.at(-1)).toMatch(/^reduce:\d+:0$/);
    expect(r.requests.length).toBeLessThanOrEqual(MAX_SUMMARIZE_CALLS);
    expect(stepStatus(r.recorder, "single")).toBe("succeeded");
    expect(r.finalState.summary?.status).toBe("ok");
    expect(savedRow(f.meeting.id)?.summary_json).toContain('"Merged."');
    expect(statusOf(r)).toBe("succeeded");
  });

  it("LR9: a single call that ends `length` on a transcript too small to replan fails with kind length", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-lr9s",
    });
    const r = await run(f, [LENGTH_CUT]);
    expect(r.requests).toHaveLength(1);
    expect(r.finalState.summary?.failure?.kind).toBe("length");
    expect(stepStatus(r.recorder, "single")).toBe("failed");
  });

  it("LR10: a map call that ends `length` splits; keys map:2, map:2/0, map:2/1; the reduce reads both halves", async () => {
    setBudget(6000);
    const f = meeting(14, 400, "m-lr10"); // 56 lines of about 400 tokens: 4 chunks
    let mapCalls = 0;
    const r = await run(f, (req) => {
      if (isMap(req)) {
        mapCalls += 1;
        if (partOf(req) === 2 && mapCalls === 3) return LENGTH_CUT;
        return sum({ overview: `Part ${partOf(req) + 1} result.` });
      }
      return sum({ overview: "Final." });
    });
    const keys = keysOf(r.recorder);
    expect(keys.filter((k) => k.startsWith("map:2"))).toEqual([
      "map:2",
      "map:2/0",
      "map:2/1",
    ]);
    expect(keys.at(-1)).toBe("reduce:1:0");
    const reduceReq = r.requests.find(isReduce);
    // Four chunks, one of them in two halves: five partials, in order.
    expect(partialCount(reduceReq as RecordedRequest)).toBe(5);
    expect(r.finalState.summary?.status).toBe("ok");
  });

  it("LR11: a reduce call that ends `length` is raised once: same key, attempt 2, max_tokens doubled", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-lr11");
    let reduces = 0;
    const r = await run(f, (req) => {
      if (isReduce(req)) {
        reduces += 1;
        return reduces === 1 ? LENGTH_CUT : sum({ overview: "Final." });
      }
      return sum();
    });
    const reduceRequests = r.requests.filter(isReduce);
    expect(reduceRequests).toHaveLength(2);
    expect(reduceRequests[0]?.maxOutputTokens).toBe(4096);
    expect(reduceRequests[1]?.maxOutputTokens).toBe(8192);
    const reduceCalls = r.recorder.calls.filter(
      (c) => c.unitKey === "reduce:1:0",
    );
    expect(reduceCalls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(r.finalState.summary?.status).toBe("ok");
  });
});

// --- cancel and stop ---------------------------------------------------------

describe("cancel and stop", () => {
  it("a cancelled run sends no call and writes no summary", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-cx" });
    const ctx = makeTestRunContext({ meetingId: "m-cx" });
    ctx.cancel();
    const r = await run(f, [sum()], { ctx });
    expect(r.requests).toHaveLength(0);
    expect(savedRow("m-cx")).toBeUndefined();
  });

  it("a stopped run goes from prepare to save: no summary call", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-st" });
    const ctx = makeTestRunContext({ meetingId: "m-st" });
    ctx.stop("provider_auth");
    const r = await run(f, [sum()], { ctx });
    expect(r.requests).toHaveLength(0);
    expect(r.finalState.summary).toBeNull();
  });
});

// --- tokens, model and cost (10.6, cases a to e) -----------------------------

/** A scripted model that reports 1000 input and 200 output tokens for each call. */
function usageModel(modelId: string, steps: ScriptStep[]): MockLanguageModelV4 {
  const base = scriptedModel(modelId, steps);
  const original = base.model.doGenerate as unknown as (
    o: unknown,
  ) => PromiseLike<Record<string, unknown>>;
  base.model.doGenerate = (async (o: unknown) => ({
    ...(await original(o)),
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 200, text: 200, reasoning: 0 },
    },
  })) as unknown as typeof base.model.doGenerate;
  return base.model;
}

function useOpenAi(): void {
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.exec("DELETE FROM api_keys");
  db.prepare(
    "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES ('openai', 'gpt-4o-mini', 'gpt-4o-mini', 'llm', 1)",
  ).run();
  db.prepare(
    "INSERT INTO api_keys (provider, key) VALUES ('openai', 'test-key')",
  ).run();
}

async function runWithModel(
  f: MeetingFixture,
  model: MockLanguageModelV4,
  runId = "run-cost",
) {
  const recorder = createLlmRecorder(getDb());
  const { deps } = makeTestDeps({ recorder, createModel: seamFor(model) });
  const ctx = makeTestRunContext({ runId, meetingId: f.meeting.id });
  return runScriptedGraph({
    deps,
    meetingId: f.meeting.id,
    stages: ["summarize"],
    ctx,
  });
}

describe("tokens, model and cost (4.5 rules 1 to 4)", () => {
  const price = { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 };

  it("(a) a priced model: cost_usd = 1000 x price.input + 200 x price.output, read back; tokens and provider", async () => {
    useOpenAi();
    stubRegistry("price");
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-a" });
    const r = await runWithModel(
      f,
      usageModel("gpt-4o-mini", [sum()]),
      "run-a",
    );
    expect(r.finalState.summary?.status).toBe("ok");
    const row = savedRow("m-a");
    expect(row?.cost_usd).not.toBeNull();
    expect(row?.cost_usd).toBeCloseTo(
      1000 * price.input + 200 * price.output,
      12,
    );
    expect(row?.input_tokens).toBe(1000);
    expect(row?.output_tokens).toBe(200);
    expect(row?.llm_provider).toBe("openai");
  });

  it("(b) a server model has no price: cost_usd NULL, provider server", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-b" });
    await run(f, [sum()]);
    const row = savedRow("m-b");
    expect(row?.cost_usd).toBeNull();
    expect(row?.llm_provider).toBe("server");
    // The scripted model reports 120 input and 30 output tokens for each call.
    expect(row?.input_tokens).toBe(120);
    expect(row?.output_tokens).toBe(30);
  });

  it("(c) a models.dev read that fails: cost_usd NULL and the node does not fail", async () => {
    useOpenAi();
    stubRegistry("reject");
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-c" });
    const r = await runWithModel(
      f,
      usageModel("gpt-4o-mini", [sum()]),
      "run-c",
    );
    expect(r.finalState.summary?.status).toBe("ok");
    expect(savedRow("m-c")?.cost_usd).toBeNull();
  });

  it("(d) a resume with a cold cache and a working stub: cost_usd not NULL", async () => {
    useOpenAi();
    stubRegistry("price");
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-d" });
    await runWithModel(f, usageModel("gpt-4o-mini", [sum()]), "run-d1");
    // The cache expires: a new process starts cold.
    vi.setSystemTime(new Date(Date.now() + 7 * MIN));
    getDb().exec("DELETE FROM meeting_summaries");
    await runWithModel(f, usageModel("gpt-4o-mini", [sum()]), "run-d2");
    expect(savedRow("m-d")?.cost_usd).not.toBeNull();
  });

  it("(e) llm_model is the served model of the last call when named, else the requested model", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-e1" });
    const named = await run(f, [
      okReply(JSON.stringify(summary()), { servedModel: TEST_MODEL }),
    ]);
    expect(named.recorder.calls.at(-1)?.modelServed).toBe(TEST_MODEL);
    expect(savedRow("m-e1")?.llm_model).toBe(TEST_MODEL);
    expect(savedRow("m-e1")?.llm_provider).toBe("server");

    // Map and reduce: the model of the last call in call order.
    setBudget(2000);
    const g = meeting(5, 300, "m-e2");
    await run(g, (req) =>
      okReply(JSON.stringify(summary()), {
        servedModel: isReduce(req) ? TEST_MODEL : "Qwen3.8-27B",
      }),
    );
    expect(savedRow("m-e2")?.llm_model).toBe(TEST_MODEL);
    // 4 map calls and a reduce: 5 x 120 input and 5 x 30 output tokens.
    expect(savedRow("m-e2")?.input_tokens).toBe(600);
    expect(savedRow("m-e2")?.output_tokens).toBe(150);
  });

  it("the requested model is used when the served model is absent", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-e3" });
    const r = await run(f, [
      okReply(JSON.stringify(summary()), { servedModel: null }),
    ]);
    if (r.finalState.summary?.status === "ok") {
      expect(savedRow("m-e3")?.llm_model).toBe(
        r.recorder.calls.at(-1)?.modelRequested,
      );
    } else {
      // The gateway may reject an answer with no served model for this provider.
      expect(r.finalState.summary?.failure).not.toBeNull();
    }
  });
});

// --- GR10 (c): resume after a kill -------------------------------------------

describe("GR10 (c): resume sends no finished call again", () => {
  /**
   * Run until the responder says kill. The kill aborts the `invoke` signal, as
   * a hard stop does, and cancels the first context, so the orphan node ends.
   * Then a new graph and a new context resume on the same database.
   */
  async function killAndResume(
    f: MeetingFixture,
    first: (req: RecordedRequest) => ScriptStep | "kill",
    second: (req: RecordedRequest) => ScriptStep,
  ) {
    const runId = "run-kill";
    const recorder = createLlmRecorder(getDb());
    recorder.startRun({
      id: runId,
      scope: "meeting",
      scopeId: f.meeting.id,
      kind: "summarize",
      startedBy: "button",
      graphVersion: WORKFLOW_GRAPH_VERSION,
      startedAt: 1_760_000_000_000,
    });
    const abort = new AbortController();
    const ctx1 = makeTestRunContext({ runId, meetingId: f.meeting.id });
    const one = responderModel(TEST_MODEL, (req) => {
      const step = first(req);
      if (step !== "kill") return step;
      abort.abort();
      ctx1.cancel();
      return HANG;
    });
    const deps1 = {
      ...makeTestDeps({ recorder }).deps,
      createModel: seamFor(one.model),
      getRunContext: () => ctx1,
    };
    const config = {
      configurable: { thread_id: runId },
      durability: "sync" as const,
      maxConcurrency: 3,
    };
    await expect(
      buildGraph(deps1).invoke(
        { runId, meetingId: f.meeting.id, stages: ["summarize"] },
        { ...config, signal: abort.signal },
      ),
    ).rejects.toThrow();
    // The orphan node sees the cancel and ends.
    for (let i = 0; i < 50; i++) await Promise.resolve();

    const ctx2 = makeTestRunContext({ runId, meetingId: f.meeting.id });
    const two = responderModel(TEST_MODEL, second);
    const deps2 = {
      ...makeTestDeps({ recorder }).deps,
      createModel: seamFor(two.model),
      getRunContext: () => ctx2,
    };
    const finalState = await buildGraph(deps2).invoke(null, config);
    return { before: one.requests, after: two.requests, finalState, runId };
  }

  const finishedKeys = (runId: string) =>
    (
      getDb()
        .prepare(
          "SELECT step_key, count(*) AS n FROM llm_calls WHERE run_id = ? AND node = 'summarize' AND error_kind IS NULL GROUP BY step_key",
        )
        .all(runId) as { step_key: string; n: number }[]
    ).map((r) => [r.step_key, r.n]);

  it("a kill during map 2: the resume sends 0 requests for maps 0 and 1", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-kill1");
    const r = await killAndResume(
      f,
      (req) => (isMap(req) && partOf(req) === 2 ? "kill" : sum()),
      (req) => (isReduce(req) ? sum({ overview: "Final." }) : sum()),
    );
    expect(r.before.filter(isMap).map(partOf)).toEqual([0, 1, 2]);
    expect(r.after.filter(isMap).map(partOf)).toEqual([2, 3]);
    expect(r.after.filter(isReduce)).toHaveLength(1);
    expect(r.finalState.summary?.status).toBe("ok");
    // No unit has two finished calls.
    expect(finishedKeys(r.runId).every(([, n]) => n === 1)).toBe(true);
    expect(savedRow("m-kill1")?.summary_json).toContain('"Final."');
  });

  it("a kill between the level-1 and level-2 calls: 0 requests for level 1; level 2 gets the level-1 results", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-kill2");
    const big = "w".repeat(3600);
    const levelOne = (req: RecordedRequest) =>
      sum({ overview: `Level one result ${partialCount(req)}.` });
    const r = await killAndResume(
      f,
      (req) => {
        if (isMap(req)) return sum({ overview: big });
        if (req.user.includes(big)) return levelOne(req);
        return "kill"; // the level-2 call
      },
      (req) => {
        if (isMap(req)) return sum({ overview: big });
        if (req.user.includes(big)) return levelOne(req);
        return sum({ overview: "Final." });
      },
    );
    expect(r.before).toHaveLength(7);
    // The resume sends the level-2 call only.
    expect(r.after).toHaveLength(1);
    expect(r.after[0]?.user.match(/Level one result/g)).toHaveLength(2);
    expect(r.after[0]?.user).not.toContain(big);
    expect(r.finalState.summary?.status).toBe("ok");
    const keys = finishedKeys(r.runId).map(([k]) => k);
    expect(keys.sort()).toEqual([
      "map:0",
      "map:1",
      "map:2",
      "map:3",
      "reduce:1:0",
      "reduce:1:1",
      "reduce:2:0",
    ]);
    expect(finishedKeys(r.runId).every(([, n]) => n === 1)).toBe(true);
  });
});
