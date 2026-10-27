// Node `summarize` (specs/meeting-enhance-agentic.md 4.5, 10.6 row `summarize`),
// split into narrow calls: three extraction calls for each transcript part
// (`decisions`, `actionItems`, `points`), code merges the parts and checks the
// owners, then one `overview` call on the merged items.
// The real graph, the real gateway and the real saver run over a scripted model.
import { APICallError } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import type { CallProfile } from "../src/lib/llm/model-profiles.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { createLlmRecorder } from "../src/lib/llm/recorder.js";
import { buildGraph } from "../src/lib/meetings/workflow/graph.js";
import {
  __setSummaryCeilingMsForTests,
  actionTimingMaxOutput,
  SUMMARIZE_IS_STUB,
  summaryCeilingMs,
  summaryStepKey,
} from "../src/lib/meetings/workflow/nodes/summarize.js";
import {
  FOLDER_CONTEXT_LABEL,
  renderSummaryNotes,
  SUMMARY_OWNER_RULE,
} from "../src/lib/meetings/workflow/prompts.js";
import {
  type MeetingSummary,
  MeetingSummarySchema,
  SUMMARY_SIZE_LIMITS,
  summaryStageStepSchema,
} from "../src/lib/meetings/workflow/schemas.js";
import {
  closeCutJson,
  MAX_SUMMARIZE_CALLS,
  mergeSummaryAnswers,
  plannedSummaryCalls,
  quoteInLines,
  renderSummaryMarkdown,
  repairCutAnswer,
  supportedOwner,
  withoutDuringCall,
  withSupportedOwners,
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

type Stage =
  | "decisions"
  | "actionItems"
  | "actionTiming"
  | "keyPoints"
  | "openQuestions"
  | "overview";

/** The stage of a summary request, from the job line of its system prompt. */
function stageOf(r: RecordedRequest): Stage | null {
  if (r.system.startsWith("You write the overview")) return "overview";
  if (r.system.includes("numbered list of tasks")) return "actionTiming";
  if (!r.system.startsWith("You read a meeting transcript")) return null;
  if (r.system.includes("write its overview")) return "overview";
  if (r.system.includes("List the decisions")) return "decisions";
  if (r.system.includes("List the action items")) return "actionItems";
  if (r.system.includes("List the key points")) return "keyPoints";
  if (r.system.includes("List the open questions")) return "openQuestions";
  return null;
}
const isOverview = (r: RecordedRequest) => stageOf(r) === "overview";
const isExtract = (r: RecordedRequest) => stageOf(r) !== null && !isOverview(r);
/** The part index of an extraction request (0 for a one-part meeting). */
const partOf = (r: RecordedRequest) =>
  Number(/This is part (\d+) of/.exec(r.user)?.[1] ?? 1) - 1;

const STAGES = [
  "decisions",
  "actionItems",
  "keyPoints",
  "openQuestions",
] as const;
/** The step keys of `parts` parts, then the overview. */
const keysFor = (parts: number) => [
  ...Array.from({ length: parts }, (_, i) =>
    STAGES.map((s) => summaryStepKey(s, i, parts)),
  ).flat(),
  "overview",
];

/**
 * Words of fixture line 4, so they are in every fixture transcript with 4
 * lines or more. A decision or an open question needs a quote that code finds.
 */
const QUOTE = "move the vendor call to Thursday";

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
/** A summary as the model writes it: decisions and questions with a quote. */
const wire = (s: MeetingSummary, quote = QUOTE) => ({
  ...s,
  // The timing check: every task is a follow-up.
  timings: s.actionItems.map(() => "after the meeting"),
  decisions: s.decisions.map((text) => ({ quote, text })),
  openQuestions: s.openQuestions.map((text) => ({ quote, text })),
});
/** One answer for every stage: each call parses only the fields of its stage. */
const sum = (over: Partial<MeetingSummary> = {}) =>
  okReply(JSON.stringify(wire(summary(over))));
/** The answer of each stage call, from one summary object. */
const byStage =
  (s: MeetingSummary, quote = QUOTE) =>
  (r: RecordedRequest): ScriptStep => {
    const w = wire(s, quote);
    const stage = stageOf(r);
    if (stage === "decisions")
      return okReply(JSON.stringify({ decisions: w.decisions }));
    if (stage === "actionItems")
      return okReply(JSON.stringify({ actionItems: w.actionItems }));
    if (stage === "actionTiming")
      return okReply(JSON.stringify({ timings: w.timings }));
    if (stage === "keyPoints")
      return okReply(JSON.stringify({ keyPoints: w.keyPoints }));
    if (stage === "openQuestions")
      return okReply(JSON.stringify({ openQuestions: w.openQuestions }));
    return okReply(JSON.stringify({ overview: w.overview }));
  };
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

// --- one part: the stage calls, rendering, prompts ---------------------------

describe("summarize: one part", () => {
  it("a short meeting is four extraction calls and the overview; the Markdown is the render of summary_json", async () => {
    expect(SUMMARIZE_IS_STUB).toBe(false);
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    const s = summary({
      overview: "The team reviewed the rollout plan.",
      keyPoints: ["The export job takes four minutes."],
      decisions: ["Move the vendor call to Thursday."],
      actionItems: [
        { task: "Send the draft", owner: "Them 2", due: "tomorrow morning" },
        { task: "Write the notes", owner: null, due: null },
      ],
      openQuestions: ["Who owns the onboarding checklist?"],
    });
    const r = await run(f, byStage(s));
    // A part with action items gets the timing check after `actionItems`.
    const keys = [
      "decisions",
      "actionItems",
      "actionTiming",
      "keyPoints",
      "openQuestions",
      "overview",
    ];
    expect(r.requests.map(stageOf)).toEqual(keys);
    expect(keysOf(r.recorder)).toEqual(keys);
    for (const key of keys) {
      expect(stepStatus(r.recorder, key)).toBe("succeeded");
    }
    expect(r.finalState.summary?.status).toBe("ok");
    expect(statusOf(r)).toBe("succeeded");
    expect(r.finalState.summary?.callCount).toBe(6);

    const row = savedRow(f.meeting.id);
    const stored = JSON.parse(row?.summary_json as string) as unknown;
    expect(MeetingSummarySchema.parse(stored)).toEqual(s);
    expect(row?.markdown).toBe(renderSummaryMarkdown(stored as MeetingSummary));
    expect(row?.markdown).toContain(
      "- Send the draft (Owner: Them 2; Due: tomorrow morning)",
    );
    expect(row?.markdown).toContain("- Write the notes");
    const status = getDb()
      .prepare("SELECT status FROM meetings WHERE id = ?")
      .get(f.meeting.id) as { status: string };
    expect(status.status).toBe("summarized");
  });

  it("a `server` provider gets the stage schemas with size limits; the stored summary has no duplicate entry (issue #246)", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    const point = "The export job takes four minutes.";
    const s = summary({
      keyPoints: [point, "The vendor call moves.", ...Array(5).fill(point)],
    });
    const r = await run(f, byStage(s));
    expect(r.finalState.summary?.status).toBe("ok");
    const wires = r.requests.map((q) => JSON.stringify(q.responseFormat));
    expect(wires[2]).toContain('"keyPoints"');
    expect(wires[2]).not.toContain('"decisions"');
    // An own server (llama.cpp grammar) applies maxItems and maxLength.
    expect(wires[2]).toContain(`"maxItems":${SUMMARY_SIZE_LIMITS.keyPoints}`);
    expect(wires[2]).toContain(`"maxLength":${SUMMARY_SIZE_LIMITS.itemChars}`);
    const stored = JSON.parse(
      savedRow(f.meeting.id)?.summary_json as string,
    ) as MeetingSummary;
    expect(stored.keyPoints).toEqual([point, "The vendor call moves."]);
    expect(
      r.recorder.calls.map((c) => [c.schema.name, c.schema.version]),
    ).toEqual([
      ["summary_decisions", 2],
      ["summary_action_items", 2],
      ["summary_key_points", 2],
      ["summary_open_questions", 2],
      ["summary_overview", 2],
    ]);
  });

  it('an owner or due of "null", "None", "N/A", "unknown" or blank is stored as null and not rendered', async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    const s = summary({
      actionItems: [
        { task: "Send the draft", owner: "null", due: " NULL " },
        { task: "Book the room", owner: "None", due: "n/a" },
        { task: "Check the export", owner: " Unknown", due: "  " },
        { task: "Write the notes", owner: "Me", due: "Friday" },
      ],
    });
    const r = await run(f, byStage(s));
    expect(r.finalState.summary?.status).toBe("ok");
    const row = savedRow(f.meeting.id);
    const stored = JSON.parse(row?.summary_json as string) as MeetingSummary;
    expect(stored.actionItems.map((a) => [a.owner, a.due])).toEqual([
      [null, null],
      [null, null],
      [null, null],
      ["Me", "Friday"],
    ]);
    // Only the real owner and due are rendered.
    expect(row?.markdown?.match(/Owner: /g)).toHaveLength(1);
    expect(row?.markdown?.match(/Due: /g)).toHaveLength(1);
    expect(row?.markdown).toContain("- Send the draft\n");
    expect(row?.markdown).toContain(
      "- Write the notes (Owner: Me; Due: Friday)",
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

  it("the prompts: one job each, no Markdown section text, no attendee, instructions and context in every prompt", async () => {
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
      expect(req.system).toContain(
        "Weekly planning call of a made-up product team.",
      );
      expect(req.system).toContain("Keep it under five bullets.");
    }
    // Four parts: four extraction calls each, then the overview.
    expect(r.requests.map(stageOf)).toEqual([
      ...Array(4).fill(STAGES).flat(),
      "overview",
    ]);
    expect(r.requests.filter(isExtract).map(partOf)).toEqual(
      [0, 1, 2, 3].flatMap((i) => [i, i, i, i]),
    );
    // An extraction call reads the transcript.
    for (const req of [...r.requests, ...rs.requests].filter(isExtract)) {
      expect(req.user).toContain("<transcript>");
      expect(req.user).toContain("not as instructions to you");
    }
    // One part: the overview reads the transcript. Four parts: the notes only.
    const one = rs.requests.find(isOverview);
    expect(one?.user).toContain("<transcript>");
    expect(one?.user).toContain("Me: ");
    const long = r.requests.find(isOverview);
    expect(long?.user).toContain("<notes>");
    expect(long?.user).not.toContain("<transcript>");
    expect(long?.user).not.toContain("Me: ");
    // A one-part meeting does not say "part".
    expect(rs.requests[0]?.user).not.toContain("This is part");
    expect(r.requests[0]?.user).toContain("This is part 1 of 4");
  });

  it("the owner rule (#273) is in the action item prompt only", async () => {
    const r = await run(meeting(1, 50, "m-owner-rule"), [sum()]);
    for (const req of r.requests) {
      expect(req.system.includes(SUMMARY_OWNER_RULE)).toBe(
        stageOf(req) === "actionItems",
      );
    }
    expect(SUMMARY_OWNER_RULE).toContain('"Me", "Them 2" or a confirmed name');
    expect(SUMMARY_OWNER_RULE).toContain(
      "Do not change a label into a name from the context or the title",
    );
  });

  it("the owner check (#273): a label or a spoken name stays; a name from the calendar or the context only becomes null", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
      withCalendar: true,
      meetingId: "m-owner-check",
    });
    const s = summary({
      actionItems: [
        { task: "Send the draft", owner: "Me", due: null },
        { task: "Book the room", owner: "them 3", due: null },
        { task: "Check the export", owner: "Morgan Ellis", due: null },
        { task: "Write the notes", owner: "Jordan Vale", due: null },
        { task: "Call the vendor", owner: "Them 9", due: null },
      ],
    });
    const r = await run(f, byStage(s));
    expect(r.finalState.summary?.status).toBe("ok");
    expect(
      r.finalState.summary?.summary?.actionItems.map((a) => a.owner),
    ).toEqual(["Me", "them 3", "Morgan Ellis", null, null]);
  });

  it("a long meeting: the overview reads the merged items as notes, and its answer is the overview", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-notes");
    const s = summary({
      overview: "The overview from the notes.",
      keyPoints: ["The export job takes four minutes."],
      decisions: ["Move the vendor call to Thursday."],
      actionItems: [{ task: "Send the draft", owner: "Me", due: "Friday" }],
    });
    const r = await run(f, (req) =>
      isOverview(req)
        ? byStage(s)(req)
        : partOf(req) === 0
          ? byStage(s)(req)
          : sum(),
    );
    const overview = r.requests.find(isOverview);
    const notes = renderSummaryNotes({
      keyPoints: s.keyPoints,
      decisions: s.decisions,
      actionItems: s.actionItems,
      openQuestions: [],
    });
    expect(overview?.user).toContain(notes);
    expect(notes).toContain("- Send the draft (owner: Me; due: Friday)");
    expect(notes).toContain("Open questions:\n- none");
    expect(r.finalState.summary?.summary?.overview).toBe(
      "The overview from the notes.",
    );
  });
});

describe("summary-pure: merge and owner check", () => {
  it("mergeSummaryAnswers joins the stage answers in order, keeps quoted items only, and removes duplicates", () => {
    const lines = [
      "Me: ok so we ship on Friday, everyone agrees.",
      "Them 2: who pays for the new laptops?",
      "Me: and we hire a designer next month.",
    ];
    const q = (quote: string, text: string) => ({ quote, text });
    const out = mergeSummaryAnswers(
      [
        { decisions: [q("we ship on Friday", "Ship on Friday.")] },
        { actionItems: [{ task: "Send the draft", owner: null, due: null }] },
        { keyPoints: ["Kestrel latency is high."] },
        { openQuestions: [q("who pays for the new laptops", "Who pays?")] },
        {
          decisions: [
            q("WE SHIP ON FRIDAY!", "ship on friday."),
            q("hire a designer", "Hire a designer."),
            q("we agreed to move the office", "Move the office."),
          ],
        },
        {
          actionItems: [{ task: "Send the draft", owner: "Me", due: "Friday" }],
        },
        { keyPoints: ["Kestrel latency is high.", "The budget is open."] },
        { openQuestions: [q("pays", "Who pays?"), q("is it late", "Late?")] },
      ],
      lines,
    );
    expect(out.items).toEqual({
      keyPoints: ["Kestrel latency is high.", "The budget is open."],
      decisions: ["Ship on Friday.", "Hire a designer."],
      actionItems: [{ task: "Send the draft", owner: "Me", due: "Friday" }],
      openQuestions: ["Who pays?"],
    });
    // "move the office" is in no line; "pays" is too short; "is it late" is in no line.
    expect(out.droppedDecisions).toBe(1);
    expect(out.droppedQuestions).toBe(2);
  });

  it("quoteInLines: the words of the quote, in order, in one line; case and punctuation do not count", () => {
    const lines = ["Them 2: OK, so the launch moves to Friday.", "Me: fine."];
    expect(quoteInLines("the launch moves to friday", lines)).toBe(true);
    expect(quoteInLines("Them 2: OK so the launch", lines)).toBe(true);
    expect(quoteInLines("“the launch moves”", lines)).toBe(true);
    // Words of two lines, a changed word, a short quote: no.
    expect(quoteInLines("to Friday. Me: fine", lines)).toBe(false);
    expect(quoteInLines("the launch moved to Friday", lines)).toBe(false);
    expect(quoteInLines("fine", lines)).toBe(false);
    // A part of a word is not a word.
    expect(quoteInLines("launch moves to Fri", lines)).toBe(false);
  });

  it("a decision with a quote that is not in the transcript is not stored", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2, meetingId: "m-q" });
    const r = await run(f, (req) =>
      stageOf(req) === "decisions"
        ? okReply(
            JSON.stringify({
              decisions: [
                { quote: QUOTE, text: "Move the vendor call." },
                { quote: "we will buy a boat", text: "Buy a boat." },
              ],
            }),
          )
        : sum(),
    );
    expect(r.finalState.summary?.summary?.decisions).toEqual([
      "Move the vendor call.",
    ]);
  });

  it("withoutDuringCall drops a task done during the call; a missing or short timing list keeps every task", () => {
    const items = ["a", "b", "c"];
    expect(
      withoutDuringCall(items, [
        "after the meeting",
        "during this call",
        "after the meeting",
      ]),
    ).toEqual({ items: ["a", "c"], dropped: 1 });
    expect(withoutDuringCall(items, null)).toEqual({ items, dropped: 0 });
    expect(withoutDuringCall(items, ["during this call"])).toEqual({
      items,
      dropped: 0,
    });
  });

  it("the timing check drops a task that a speaker did during the call; it runs only for a part with tasks", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2, meetingId: "m-t" });
    const s = summary({
      actionItems: [
        { task: "Ping the late guest", owner: "Them 2", due: null },
        { task: "Send the draft", owner: "Me", due: "Friday" },
      ],
    });
    const r = await run(f, (req) =>
      stageOf(req) === "actionTiming"
        ? okReply(
            JSON.stringify({
              timings: ["during this call", "after the meeting"],
            }),
          )
        : byStage(s)(req),
    );
    const timing = r.requests.find((q) => stageOf(q) === "actionTiming");
    expect(timing?.user).toContain("1. Ping the late guest");
    expect(timing?.user).toContain("2. Send the draft");
    expect(timing?.user).toContain("<transcript>");
    // One label for each task: 16 + 12 x 2 tokens, not the summary 4096.
    expect(timing?.maxOutputTokens).toBe(40);
    expect(JSON.stringify(timing?.responseFormat)).toContain('"maxItems":2');
    expect(r.finalState.summary?.summary?.actionItems).toEqual([
      { task: "Send the draft", owner: "Me", due: "Friday" },
    ]);
    // No action item: no timing call.
    const g = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-t0" });
    const r0 = await run(g, [sum()]);
    expect(r0.requests.map(stageOf)).not.toContain("actionTiming");
  });

  it("actionTimingMaxOutput: 16 + 12 tokens for each task, plus a reasoning budget that uses the output limit, under the model limit", () => {
    const profile = (o: {
      cap?: number | null;
      budget?: number;
      counts?: boolean;
    }) =>
      ({
        maxOutputTokens: o.cap ?? null,
        reasoning: {
          budgetTokens: o.budget ?? 0,
          countsInMaxOutput: o.counts ?? false,
        },
      }) as CallProfile;
    expect(actionTimingMaxOutput(1, profile({}))).toBe(28);
    expect(actionTimingMaxOutput(10, profile({}))).toBe(136);
    expect(
      actionTimingMaxOutput(2, profile({ budget: 512, counts: true })),
    ).toBe(552);
    expect(
      actionTimingMaxOutput(2, profile({ budget: 512, counts: false })),
    ).toBe(40);
    expect(actionTimingMaxOutput(10, profile({ cap: 100 }))).toBe(100);
  });

  it("a failed timing check keeps every task (fail open)", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2, meetingId: "m-tf" });
    const s = summary({
      actionItems: [{ task: "Send the draft", owner: "Me", due: null }],
    });
    const r = await run(f, (req) =>
      stageOf(req) === "actionTiming"
        ? reply("content-filter", "content_filter", "")
        : byStage(s)(req),
    );
    expect(r.finalState.summary?.status).toBe("ok");
    expect(r.finalState.summary?.summary?.actionItems).toEqual([
      { task: "Send the draft", owner: "Me", due: null },
    ]);
    expect(stepStatus(r.recorder, "actionTiming")).toBe("failed");
  });

  it("supportedOwner keeps a label or a name that the transcript says, and drops the rest", () => {
    const labels = ["Me", "Them 2", "Ana Souza"];
    const transcript = "Me: Bruno will send it.\nAna Souza: ok.";
    expect(supportedOwner("Me", labels, transcript)).toBe("Me");
    expect(supportedOwner(" them 2 ", labels, transcript)).toBe(" them 2 ");
    expect(supportedOwner("Ana Souza", labels, transcript)).toBe("Ana Souza");
    expect(supportedOwner("Bruno", labels, transcript)).toBe("Bruno");
    expect(supportedOwner("Them 2 (Bruno)", labels, transcript)).toBe(
      "Them 2 (Bruno)",
    );
    expect(supportedOwner("Carla", labels, transcript)).toBeNull();
    expect(supportedOwner("Bruno Lima", labels, transcript)).toBeNull();
    expect(supportedOwner("N/A", labels, transcript)).toBeNull();
    expect(supportedOwner(null, labels, transcript)).toBeNull();
  });

  it("withSupportedOwners counts the owners it drops", () => {
    const out = withSupportedOwners(
      {
        keyPoints: [],
        decisions: [],
        actionItems: [
          { task: "a", owner: "Me", due: null },
          { task: "b", owner: "Carla", due: null },
          { task: "c", owner: null, due: "Friday" },
        ],
        openQuestions: [],
      },
      ["Me"],
      "Me: hello.",
    );
    expect(out.dropped).toBe(1);
    expect(out.items.actionItems.map((a) => a.owner)).toEqual([
      "Me",
      null,
      null,
    ]);
  });
});

describe("summarize: no folder context (#230, P8b)", () => {
  it("a filed meeting: the summary prompts have no folder block and equal the prompts of the same meeting unfiled", async () => {
    const db = getDb();
    db.exec("DELETE FROM meeting_folders");
    const now = Date.now();
    db.prepare(
      "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("fold-1", "Orchid Rollout", "Launch of a made-up app.", now, now);
    // Ids of the same length: sizeFixtureSegments pads each line by the
    // length of its segment id, which holds the meeting id.
    const filed = meeting(5, 300, "m-fold-a");
    const unfiled = meeting(5, 300, "m-fold-b");
    db.prepare("UPDATE meetings SET folder_id = ? WHERE id = ?").run(
      "fold-1",
      filed.meeting.id,
    );
    setBudget(2000);
    const rf = await run(filed, [sum()]);
    const ru = await run(unfiled, [sum()]);
    expect(rf.requests.length).toBeGreaterThan(4);
    for (const req of rf.requests) {
      expect(req.system).toContain(
        "Weekly planning call of a made-up product team.",
      );
      expect(req.system).not.toContain(FOLDER_CONTEXT_LABEL);
      expect(`${req.system}\n${req.user}`).not.toContain("Orchid");
    }
    const view = (rs: typeof rf.requests) =>
      rs.map((r) => ({ system: r.system, user: r.user }));
    expect(view(rf.requests)).toEqual(view(ru.requests));
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
    for (const req of r.requests.filter(isExtract)) {
      expect(req.user).toContain("Me: The stored correction text.");
      expect(req.user).not.toContain(a?.text as string);
      expect(req.user).toContain(`Unidentified: ${b?.text}`);
    }
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
        stageOf(req) !== null
          ? sum()
          : okReply(
              JSON.stringify({
                corrections: [{ id: a?.id, text: `${a?.text} fresh` }],
              }),
            ),
      { stages: ["enhance", "summarize"] },
    );
    const extract = r.requests.filter(isExtract);
    expect(extract).toHaveLength(4);
    for (const req of extract) {
      expect(req.user).toContain(`Me: ${a?.text} fresh`);
      expect(req.user).toContain(`Me: ${b?.text}`);
      expect(req.user).not.toContain("STALE");
    }
  });
});

// --- long meetings: parts ----------------------------------------------------

describe("summarize: parts of a long meeting (4.5.3)", () => {
  it("a long transcript is four calls for each part, then the overview; code merges the parts", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-parts"); // 20 lines of about 300 tokens
    const r = await run(f, (req) => {
      if (isOverview(req)) return sum({ overview: "Final." });
      const i = partOf(req);
      return sum({
        keyPoints: [
          `Point from part ${i + 1}.`,
          "The export job takes four minutes.",
        ],
        decisions: [`Decision of part ${i + 1}.`],
      });
    });
    expect(keysOf(r.recorder)).toEqual(keysFor(4));
    const planned = plannedSummaryCalls(5900, 2000);
    expect("calls" in planned && r.requests.length <= planned.calls).toBe(true);
    const stored = JSON.parse(
      savedRow(f.meeting.id)?.summary_json as string,
    ) as MeetingSummary;
    expect(stored.overview).toBe("Final.");
    expect(stored.keyPoints).toEqual([
      "Point from part 1.",
      "The export job takes four minutes.",
      "Point from part 2.",
      "Point from part 3.",
      "Point from part 4.",
    ]);
    expect(stored.decisions).toEqual(
      [1, 2, 3, 4].map((i) => `Decision of part ${i}.`),
    );
    // The overview reads the merged notes, once.
    const overview = r.requests.find(isOverview);
    expect(overview?.user.match(/four minutes/g)).toHaveLength(1);
    expect(r.finalState.summary?.callCount).toBe(17);
    expect(statusOf(r)).toBe("succeeded");
    // There is no row named `summarize`.
    expect(r.recorder.steps.has("summarize")).toBe(false);
  });

  it("a plan over MAX_SUMMARIZE_CALLS fails with budget_exceeded before any call", async () => {
    setBudget(2000);
    const f = meeting(40, 300, "m-big-plan"); // 160 lines: 27 parts, 82 calls
    const r = await run(f, [sum()]);
    expect(r.requests).toHaveLength(0);
    expect(r.finalState.summary?.status).toBe("failed");
    expect(r.finalState.summary?.failure?.kind).toBe("budget_exceeded");
    expect(savedRow(f.meeting.id)).toBeUndefined();
    expect(statusOf(r)).toBe("failed");
    expect(r.recorder.steps.get("decisions")?.errorKind).toBe(
      "budget_exceeded",
    );
  });

  it("GR20 (b): a persistent 503 on the overview call sends 16 + 2 requests and no extraction call again", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-gr20b");
    const r = await run(f, (req) => (isOverview(req) ? down : sum()));
    // 16 extraction calls, the overview call, and its one retry.
    expect(r.requests).toHaveLength(16 + 2);
    expect(r.requests.filter(isExtract)).toHaveLength(16);
    expect(r.finalState.summary?.status).toBe("failed");
    expect(r.finalState.summary?.failure?.kind).toBe("provider_unavailable");
    expect(r.finalState.summary?.failure?.unitKey).toBe("overview");
    expect(savedRow(f.meeting.id)).toBeUndefined();
    expect(stepStatus(r.recorder, "overview")).toBe("failed");
    expect(stepStatus(r.recorder, "openQuestions:3")).toBe("succeeded");
  });

  it("a failed extraction call stops the node: no later call, no overview, no summary", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-stop");
    const r = await run(f, (req) =>
      stageOf(req) === "actionItems" && partOf(req) === 1 ? down : sum(),
    );
    // Part 1: decisions:0..openQuestions:0, decisions:1, actionItems:1 and its retry.
    expect(r.requests).toHaveLength(4 + 1 + 2);
    expect(r.requests.filter(isOverview)).toHaveLength(0);
    expect(r.finalState.summary?.failure?.unitKey).toBe("actionItems:1");
    expect(savedRow(f.meeting.id)).toBeUndefined();
  });
});

// --- GR26 (b), the ceiling ---------------------------------------------------

describe("GR26 (b): plannedSummaryCalls and the ceiling", () => {
  it("plans at most 6 calls under budget; 5 for each part plus the overview above it; budget_exceeded over 61", () => {
    expect(plannedSummaryCalls(1500, 2000)).toEqual({ calls: 6 });
    // 6000 tokens at 2000 (fresh 1800): 4 parts.
    expect(plannedSummaryCalls(6000, 2000)).toEqual({ calls: 21 });
    expect(plannedSummaryCalls(10800, 2000)).toEqual({ calls: 31 });
    expect(plannedSummaryCalls(200000, 2000)).toEqual({
      error: "budget_exceeded",
    });
    expect(MAX_SUMMARIZE_CALLS).toBe(61);
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
    expect(stepStatus(r.recorder, "decisions")).toBe("failed");
    expect(r.recorder.steps.get("decisions")?.errorKind).toBe(
      "deadline_exceeded",
    );
  });

  it("the ceiling during the parts skips the rest: no overview, no summary", async () => {
    __setSummaryCeilingMsForTests(80);
    setBudget(2000);
    const f = meeting(5, 300, "m-dl-map");
    const r = await run(f, (req) => (partOf(req) === 1 ? HANG : sum()));
    expect(r.finalState.summary?.failure?.kind).toBe("deadline_exceeded");
    expect(r.requests.filter(isOverview)).toHaveLength(0);
    expect(r.requests.filter(isExtract).map(partOf)).toEqual([0, 0, 0, 0, 1]);
    expect(savedRow("m-dl-map")).toBeUndefined();
  });
});

// --- the length route --------------------------------------------------------

describe("the length route", () => {
  it("an extraction call that ends `length` on a big part splits it: keys decisions, decisions/0, decisions/1; both answers are merged", async () => {
    const f = meeting(4, 300, "m-lr9"); // about 4700 tokens, budget 8000: one part
    const r = await run(f, (req) => {
      if (req.n === 0) return LENGTH_CUT;
      if (stageOf(req) === "decisions") {
        return sum({ decisions: [`Half ${req.n} decision.`] });
      }
      return sum();
    });
    const keys = keysOf(r.recorder);
    expect(keys.slice(0, 3)).toEqual([
      "decisions",
      "decisions/0",
      "decisions/1",
    ]);
    expect(stepStatus(r.recorder, "decisions")).toBe("succeeded");
    expect(r.finalState.summary?.summary?.decisions).toEqual([
      "Half 1 decision.",
      "Half 2 decision.",
    ]);
    expect(statusOf(r)).toBe("succeeded");
  });

  it("an extraction call that ends `length` on a small part is raised once, then fails with kind length", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-lr9s",
    });
    const r = await run(f, [LENGTH_CUT]);
    expect(r.requests.map((q) => q.maxOutputTokens)).toEqual([4096, 8192]);
    expect(r.finalState.summary?.failure?.kind).toBe("length");
    expect(stepStatus(r.recorder, "decisions")).toBe("failed");
    expect(r.requests.filter(isOverview)).toHaveLength(0);
  });

  it("LR10: a cut answer of a part splits that part; keys decisions:2, decisions:2/0, decisions:2/1", async () => {
    setBudget(6000);
    const f = meeting(14, 400, "m-lr10"); // 56 lines of about 400 tokens: 4 parts
    let cutDone = false;
    const r = await run(f, (req) => {
      if (stageOf(req) === "decisions" && partOf(req) === 2 && !cutDone) {
        cutDone = true;
        return LENGTH_CUT;
      }
      return sum({ decisions: [`Decision ${req.n}.`] });
    });
    const keys = keysOf(r.recorder);
    expect(keys.filter((k) => k.startsWith("decisions:2"))).toEqual([
      "decisions:2",
      "decisions:2/0",
      "decisions:2/1",
    ]);
    expect(keys.at(-1)).toBe("overview");
    // Four parts, one of them in two halves: five decision answers.
    expect(r.finalState.summary?.summary?.decisions).toHaveLength(5);
    expect(r.finalState.summary?.status).toBe("ok");
  });

  it("LR11: an overview call that ends `length` is raised once: same key, attempt 2, max_tokens doubled", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-lr11",
    });
    let overviews = 0;
    const r = await run(f, (req) => {
      if (isOverview(req)) {
        overviews += 1;
        return overviews === 1 ? LENGTH_CUT : sum({ overview: "Final." });
      }
      return sum();
    });
    const overviewRequests = r.requests.filter(isOverview);
    expect(overviewRequests.map((q) => q.maxOutputTokens)).toEqual([
      4096, 8192,
    ]);
    const calls = r.recorder.calls.filter((c) => c.unitKey === "overview");
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(r.finalState.summary?.summary?.overview).toBe("Final.");
  });
});

// --- a cut answer with a valid prefix (PR #258) -----------------------------

const partialRow = (meetingId: string) =>
  (
    getDb()
      .prepare("SELECT partial FROM meeting_summaries WHERE meeting_id = ?")
      .get(meetingId) as { partial: number | null } | undefined
  )?.partial;

describe("closeCutJson and repairCutAnswer (pure, PR #258)", () => {
  it("closes at the last complete list element or top member", () => {
    expect(closeCutJson('{"a": ["x", "y')).toBe('{"a": ["x"]}');
    expect(closeCutJson('{"a": "x", "b": [1, 2')).toBe('{"a": "x", "b": [1]}');
    expect(closeCutJson('{"a": "x", "b": tru')).toBe('{"a": "x"}');
    expect(closeCutJson('{"a": [{"t": "x", "o": null}, {"t": "y"')).toBe(
      '{"a": [{"t": "x", "o": null}]}',
    );
    expect(closeCutJson('{"a": "say \\"hi\\"", "b": "c')).toBe(
      '{"a": "say \\"hi\\""}',
    );
    // A complete object followed by a whitespace loop.
    expect(closeCutJson(`{"a": []}${" \n".repeat(50)}`)).toBe('{"a": []}');
  });

  it("gives null when nothing is complete or the text is no object", () => {
    expect(closeCutJson('{"overview": "cut')).toBeNull();
    expect(closeCutJson("")).toBeNull();
    expect(closeCutJson('["a"]')).toBeNull();
    expect(closeCutJson('text {"a": 1}')).toBeNull();
  });

  it("fills the missing lists of the stage and checks the stage schema", () => {
    const points = summaryStageStepSchema("keyPoints").zod;
    expect(
      repairCutAnswer('{"keyPoints": ["K", "L', points, ["keyPoints"]),
    ).toEqual({ keyPoints: ["K"] });
    expect(repairCutAnswer("{", points, ["keyPoints"])).toBeNull();
    // A missing list becomes an empty list.
    expect(repairCutAnswer('{"x": 1}', points, ["keyPoints"])).toEqual({
      keyPoints: [],
    });
    // A wrong type fails the schema.
    expect(
      repairCutAnswer('{"keyPoints": [1, 2', points, ["keyPoints"]),
    ).toBeNull();
    // A cut overview string cannot close.
    const overview = summaryStageStepSchema("overview").zod;
    expect(repairCutAnswer('{"overview": "cut', overview, [])).toBeNull();
    expect(repairCutAnswer('{"overview": "Done."}  ', overview, [])).toEqual({
      overview: "Done.",
    });
  });
});

describe("a cut answer with a valid prefix (PR #258)", () => {
  it("an action item answer cut in its list is repaired: the cut item is dropped, the rest kept, saved as partial", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-cut1",
    });
    const cut = reply(
      "length",
      "length",
      '{\n  "actionItems": [{"task": "Ship the beta", "owner": "Me", "due": null}, {"task": "Hire a desig',
    );
    const r = await run(f, (req) =>
      stageOf(req) === "actionItems" ? cut : sum({ overview: "The plan." }),
    );
    expect(r.finalState.summary?.status).toBe("ok");
    expect(r.finalState.summary?.partial).toBe(true);
    expect(r.finalState.summary?.summary?.actionItems).toEqual([
      { task: "Ship the beta", owner: "Me", due: null },
    ]);
    expect(stepStatus(r.recorder, "actionItems")).toBe("partial");
    expect(partialRow(f.meeting.id)).toBe(1);
    expect(savedRow(f.meeting.id)?.markdown).toContain("- Ship the beta");
    expect(savedRow(f.meeting.id)?.markdown).not.toContain("Hire a desig");
    // A partial summary does not fail the run.
    expect(statusOf(r)).toBe("succeeded");
  });

  it("an overview call that loops on whitespace at 4096 and 8192 tokens is repaired from the 8192 answer", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-cut2",
    });
    const loop = (overview: string) =>
      reply(
        "length",
        "length",
        `{\n  "overview": "${overview}"\n}${"\n    ".repeat(200)}`,
      );
    let overviews = 0;
    const r = await run(f, (req) => {
      if (isOverview(req)) {
        overviews += 1;
        return loop(overviews === 1 ? "First try." : "Second try.");
      }
      return sum();
    });
    expect(r.requests.filter(isOverview).map((q) => q.maxOutputTokens)).toEqual(
      [4096, 8192],
    );
    expect(r.finalState.summary?.partial).toBe(true);
    expect(r.finalState.summary?.summary?.overview).toBe("Second try.");
    expect(stepStatus(r.recorder, "overview")).toBe("partial");
    expect(partialRow(f.meeting.id)).toBe(1);
    expect(statusOf(r)).toBe("succeeded");
  });

  it("a complete summary stores partial 0", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-cut3",
    });
    const r = await run(f, [sum()]);
    expect(r.finalState.summary?.partial).toBe(false);
    expect(partialRow(f.meeting.id)).toBe(0);
  });

  it("a cut overview with no complete text stays a failed step: no summary", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-cut4",
    });
    const r = await run(f, (req) => (isOverview(req) ? LENGTH_CUT : sum()));
    expect(r.finalState.summary?.status).toBe("failed");
    expect(r.finalState.summary?.failure?.kind).toBe("length");
    expect(stepStatus(r.recorder, "overview")).toBe("failed");
    expect(savedRow(f.meeting.id)).toBeUndefined();
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

  it("(a) a priced model: cost_usd = 5 calls x (1000 x price.input + 200 x price.output), read back; tokens and provider", async () => {
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
      5 * (1000 * price.input + 200 * price.output),
      12,
    );
    expect(row?.input_tokens).toBe(5000);
    expect(row?.output_tokens).toBe(1000);
    expect(row?.llm_provider).toBe("openai");
  });

  it("(b) a server model has no price: cost_usd NULL, provider server", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-b" });
    await run(f, [sum()]);
    const row = savedRow("m-b");
    expect(row?.cost_usd).toBeNull();
    expect(row?.llm_provider).toBe("server");
    // The scripted model reports 120 input and 30 output tokens for each call.
    expect(row?.input_tokens).toBe(5 * 120);
    expect(row?.output_tokens).toBe(5 * 30);
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

  it("(e) llm_model is the served model of the last call (the overview) when named, else the requested model", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-e1" });
    const named = await run(f, [
      okReply(JSON.stringify(summary()), { servedModel: TEST_MODEL }),
    ]);
    expect(named.recorder.calls.at(-1)?.modelServed).toBe(TEST_MODEL);
    expect(savedRow("m-e1")?.llm_model).toBe(TEST_MODEL);
    expect(savedRow("m-e1")?.llm_provider).toBe("server");

    // Four parts: the model of the last call in call order.
    setBudget(2000);
    const g = meeting(5, 300, "m-e2");
    await run(g, (req) =>
      okReply(JSON.stringify(summary()), {
        servedModel: isOverview(req) ? TEST_MODEL : "Qwen3.8-27B",
      }),
    );
    expect(savedRow("m-e2")?.llm_model).toBe(TEST_MODEL);
    // 16 extraction calls and the overview: 17 x 120 input and 17 x 30 output tokens.
    expect(savedRow("m-e2")?.input_tokens).toBe(17 * 120);
    expect(savedRow("m-e2")?.output_tokens).toBe(17 * 30);
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

  it("a kill during part 3: the resume sends 0 requests for parts 1 and 2", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-kill1");
    const r = await killAndResume(
      f,
      (req) => (isExtract(req) && partOf(req) === 2 ? "kill" : sum()),
      (req) => (isOverview(req) ? sum({ overview: "Final." }) : sum()),
    );
    expect(r.before.filter(isExtract).map(partOf)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 2,
    ]);
    expect(r.after.filter(isExtract).map(partOf)).toEqual([
      2, 2, 2, 2, 3, 3, 3, 3,
    ]);
    expect(r.after.filter(isOverview)).toHaveLength(1);
    expect(r.finalState.summary?.status).toBe("ok");
    // No unit has two finished calls.
    expect(finishedKeys(r.runId).every(([, n]) => n === 1)).toBe(true);
    expect(savedRow("m-kill1")?.summary_json).toContain('"Final."');
  });

  it("a kill at the overview call: the resume sends the overview call only, with the merged notes", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-kill2");
    const answer = (req: RecordedRequest) =>
      sum({ keyPoints: [`Point from part ${partOf(req) + 1}.`] });
    const r = await killAndResume(
      f,
      (req) => (isOverview(req) ? "kill" : answer(req)),
      (req) => (isOverview(req) ? sum({ overview: "Final." }) : answer(req)),
    );
    expect(r.before).toHaveLength(17);
    expect(r.after).toHaveLength(1);
    expect(r.after[0]?.user.match(/Point from part/g)).toHaveLength(4);
    expect(r.finalState.summary?.status).toBe("ok");
    expect(
      finishedKeys(r.runId)
        .map(([k]) => k)
        .sort(),
    ).toEqual(keysFor(4).sort());
    expect(finishedKeys(r.runId).every(([, n]) => n === 1)).toBe(true);
  });
});

// The context guard (specs/llm-runtime-tuning.md 9 item 5): a call that the
// model refuses as too long is split and sent again, never a failed summary.
const refused = () =>
  new APICallError({
    message: "HTTP 400",
    url: "http://127.0.0.1:1/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "The prompt and max_tokens do not fit the context.",
        prompt_tokens: 40_000,
        max_tokens: 4096,
        context_tokens: 32_768,
      },
    }),
    isRetryable: false,
  });

describe("summarize: the context guard", () => {
  it("CB-S1: a refused extraction call on a one-part meeting splits the part in two halves; the summary is ok", async () => {
    setBudget(8000);
    const f = meeting(5, 300, "m-cb1"); // 20 lines, about 6000 tokens: one part
    let refusedOnce = false;
    const r = await run(f, (req) => {
      if (stageOf(req) === "decisions" && !refusedOnce) {
        refusedOnce = true;
        return refused();
      }
      return sum({ overview: "Final." });
    });
    expect(keysOf(r.recorder)).toEqual([
      "decisions",
      "decisions/0",
      "decisions/1",
      "actionItems",
      "keyPoints",
      "openQuestions",
      "overview",
    ]);
    expect(r.finalState.summary?.status).toBe("ok");
    expect(savedRow(f.meeting.id)?.summary_json).toContain('"Final."');
    expect(statusOf(r)).toBe("succeeded");
  });

  it("CB-S2: a refused call of part 1 is split in two halves", async () => {
    setBudget(2000);
    const f = meeting(5, 300, "m-cb2");
    let refusedOnce = false;
    const r = await run(f, (req) => {
      if (isExtract(req) && partOf(req) === 0 && !refusedOnce) {
        refusedOnce = true;
        return refused();
      }
      return sum({ overview: "Final." });
    });
    expect(keysOf(r.recorder).slice(0, 3)).toEqual([
      "decisions:0",
      "decisions:0/0",
      "decisions:0/1",
    ]);
    expect(r.finalState.summary?.status).toBe("ok");
    expect(statusOf(r)).toBe("succeeded");
  });

  it("CB-S3: a refused overview call splits the notes; the two overviews are joined", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-cb3",
    });
    let overviews = 0;
    const r = await run(f, (req) => {
      if (!isOverview(req)) {
        return sum({ keyPoints: ["Point one.", "Point two."] });
      }
      overviews += 1;
      if (overviews === 1) return refused();
      return sum({ overview: `Half ${overviews - 1}.` });
    });
    expect(keysOf(r.recorder)).toEqual([
      ...keysFor(1),
      "overview/0",
      "overview/1",
    ]);
    expect(r.finalState.summary?.summary?.overview).toBe("Half 1. Half 2.");
    expect(statusOf(r)).toBe("succeeded");
  });
});
