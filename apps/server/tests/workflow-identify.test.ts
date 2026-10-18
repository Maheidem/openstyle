// Node `identifySpeakers` (specs/meeting-enhance-agentic.md 4.3, 10.6 row
// `identifySpeakers`, LR4, LR6). The real graph, gateway and saver run over a
// scripted model.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { selectCandidates } from "../src/lib/meetings/workflow/nodes/identify-speakers.js";
import {
  IDENTIFY_ANCHOR_LINES,
  IDENTIFY_MAX_INPUT_TOKENS,
  type PreparedMeeting,
  type PreparedSegment,
} from "../src/lib/meetings/workflow/types.js";
import { okReply, reply, type ScriptStep } from "./helpers/fake-model.js";
import type { MeetingFixture } from "./helpers/meeting-fixture.js";
import {
  chatReply,
  makeFakeRecorder,
  makeTestDeps,
  type RecordedRequest,
  resetWorkflowTables,
  restoreFetch,
  runScriptedGraph,
  seedFixtureMeeting,
  seedTestModel,
  sizeFixtureSegments,
  stubFetch,
  systemOf,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const NO_CORRECTIONS = okReply('{"corrections":[]}');
const isIdentify = (r: RecordedRequest) => r.system.includes("diarized labels");
const speakers = (...list: object[]) =>
  okReply(JSON.stringify({ speakers: list }));
const proposal = (
  segmentId: string,
  quote: string,
  label: string,
  name: string,
  kind: "name" | "role" = "name",
) => ({ segmentId, quote, label, kind, name });

afterEach(() => {
  vi.restoreAllMocks();
  restoreFetch();
});

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

async function run(
  f: MeetingFixture,
  onIdentify: (r: RecordedRequest) => ScriptStep,
  opts: { reasoning?: boolean } = {},
) {
  const recorder = makeFakeRecorder();
  const { deps } = makeTestDeps({
    recorder,
    ...(opts.reasoning
      ? { reasoningSteps: { identifySpeakers: "bounded" as const } }
      : {}),
  });
  const out = await runScriptedGraph({
    deps,
    meetingId: f.meeting.id,
    stages: ["enhance"],
    script: (r) => (isIdentify(r) ? onIdentify(r) : NO_CORRECTIONS),
  });
  return {
    ...out,
    recorder,
    identifyRequests: out.requests.filter(isIdentify),
  };
}

/** Segments for the candidate selection tests. Made-up text only. */
function seg(
  i: number,
  label: string | null,
  text: string,
  tokens = 100,
): PreparedSegment {
  const pad = "x".repeat(Math.max(0, tokens * 4 - text.length - 20));
  return {
    id: `s${i}`,
    speaker: label ? "Them" : "Me",
    startMs: i * 1000,
    speakerLabel: label,
    displayLabel: label ? `Them ${label}` : "Me",
    text: `${text} ${pad}`,
    enhancedText: null,
    speakerName: null,
  };
}

function preparedWith(segments: PreparedSegment[]): PreparedMeeting {
  return {
    meetingId: "m",
    language: "en",
    title: null,
    context: null,
    vocabTerms: [],
    attendeeNames: [],
    segments,
    chunks: [],
    labels: { all: ["2", "3"], confirmed: [], toIdentify: ["2", "3"] },
    chunkTokens: 1200,
    summary: { instructions: "", contextBudget: 8000 },
    inputHash: "h",
  };
}

describe("candidate lines (4.3.2)", () => {
  it("S1: a pool that fits the budget is sent whole", () => {
    const segs = [
      seg(0, "2", "Hello there."),
      seg(1, null, "Okay."),
      seg(2, "3", "Right."),
    ];
    const { lines, stats } = selectCandidates(
      preparedWith(segs),
      IDENTIFY_MAX_INPUT_TOKENS,
    );
    expect(lines.map((l) => l.id)).toEqual(["s0", "s2"]); // "Me" lines are out
    expect(stats).toMatchObject({
      poolLines: 2,
      selectedLines: 2,
      droppedByBudget: 0,
    });
  });

  it("S2: in a long meeting the self-introduction of line 1 stays (anchor rule), and cue lines come next", () => {
    const segs: PreparedSegment[] = [];
    for (let i = 0; i < 400; i++) {
      const label = i % 2 === 0 ? "2" : "3";
      const text =
        i === 0
          ? "Hi all, this is Morgan Ellis from the data team."
          : i === 300
            ? "Quick note, I am Riley Quinn and I own the pilot."
            : `Plain words about the plan, number ${i}.`;
      segs.push(seg(i, label, text));
    }
    const { lines, stats } = selectCandidates(
      preparedWith(segs),
      IDENTIFY_MAX_INPUT_TOKENS,
    );
    const ids = new Set(lines.map((l) => l.id));
    expect(ids.has("s0")).toBe(true); // the first line of label 2
    expect(stats.anchorLines).toBe(2 * IDENTIFY_ANCHOR_LINES);
    // The cue line far in the meeting stays when the budget allows it.
    expect(ids.has("s300")).toBe(true);
    expect(stats.cueLines).toBeGreaterThanOrEqual(1);
    expect(stats.poolLines).toBe(400);
    // The result is in time order and inside the budget.
    expect(lines.map((l) => l.startMs)).toEqual(
      [...lines.map((l) => l.startMs)].sort((a, b) => a - b),
    );
    const tokens = lines.reduce(
      (n, l) =>
        n + Math.ceil(`[${l.id}] ${l.displayLabel}: ${l.text}`.length / 4) + 1,
      0,
    );
    expect(tokens).toBeLessThanOrEqual(IDENTIFY_MAX_INPUT_TOKENS);
    expect(stats.droppedByBudget).toBeGreaterThanOrEqual(0);
    expect(stats.selectedLines).toBe(lines.length);
  });

  it("S2: a name token that does not start its sentence marks a candidate; 'I' does not", () => {
    const segs: PreparedSegment[] = [];
    for (let i = 0; i < 200; i++) {
      segs.push(
        seg(
          i,
          i % 2 === 0 ? "2" : "3",
          i === 150 ? "Thanks for that, Ana." : "I think we agree. I'm fine.",
        ),
      );
    }
    const { lines, stats } = selectCandidates(preparedWith(segs), 2500);
    expect(lines.some((l) => l.id === "s150")).toBe(true);
    expect(stats.nameTokenLines).toBeGreaterThanOrEqual(1);
  });
});

describe("identifySpeakers in the graph", () => {
  it("a made-up name is proposed, kept, and written as a suggestion; no attendee name is in any request", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
      withCalendar: true,
    });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const r = await run(f, () =>
      speakers(
        proposal(
          intro?.id as string,
          "I am Morgan Ellis",
          intro?.speakerLabel as string,
          "Morgan Ellis",
        ),
      ),
    );
    expect(r.identifyRequests).toHaveLength(1);
    expect(r.finalState.identify?.status).toBe("ok");
    expect(r.finalState.identify?.proposals[0]).toMatchObject({
      unitKey: "candidates",
      seq: 0,
      label: "3",
    });
    expect(r.finalState.identify?.proposals[0]?.llmCallId).toBe(
      r.recorder.calls.find((c) => c.unitKey === "candidates")?.id,
    );
    expect(r.finalState.verify?.suggestions).toHaveLength(1);
    const row = getDb()
      .prepare(
        "SELECT suggested_name, display_name, confirmed_at FROM meeting_speakers WHERE meeting_id = ? AND speaker_label = '3'",
      )
      .get(f.meeting.id) as {
      suggested_name: string;
      display_name: string | null;
      confirmed_at: number | null;
    };
    expect(row.suggested_name).toBe("Morgan Ellis");
    expect(row.display_name).toBeNull();
    expect(row.confirmed_at).toBeNull();
    // 10.5.4: no attendee name or email in any recorded request.
    for (const req of r.requests) {
      expect(`${req.system}\n${req.user}`).not.toMatch(
        /Jordan|Casey|Riley|example\.test/,
      );
    }
  });

  it("a segmentId the call did not show is dropped as unknown_segment (a Me line is never shown)", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      selfIntroduction: true,
    });
    const meLine = f.segments.find((s) => s.source === "mic");
    const r = await run(f, () =>
      speakers(proposal(meLine?.id as string, "We should look", "2", "Ana")),
    );
    expect(r.finalState.verify?.verdicts[0]).toMatchObject({
      status: "dropped",
      reason: "unknown_segment",
    });
    expect(r.finalState.verify?.suggestions).toEqual([]);
  });

  it("each proposal has the seq of its place in the speakers array", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      selfIntroduction: true,
    });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const r = await run(f, () =>
      speakers(
        proposal(intro?.id as string, "I am Morgan Ellis", "3", "Morgan Ellis"),
        proposal(
          intro?.id as string,
          "I run the data team",
          "3",
          "the data lead",
          "role",
        ),
        proposal(intro?.id as string, "nothing like this", "2", "Ana"),
      ),
    );
    expect(r.finalState.identify?.proposals.map((p) => p.seq)).toEqual([
      0, 1, 2,
    ]);
    expect(r.finalState.verify?.verdicts.map((v) => [v.seq, v.status])).toEqual(
      [
        [0, "kept"],
        [1, "dropped"], // the name wins over the role
        [2, "dropped"],
      ],
    );
  });

  it("a long meeting keeps a late self-introduction in the prompt (cue rule)", async () => {
    const f = seedFixtureMeeting({
      chunks: 30,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-long",
    });
    sizeFixtureSegments(getDb(), f, 200);
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const r = await run(f, () => speakers());
    const user = r.identifyRequests[0]?.user ?? "";
    expect(user).toContain(`[${intro?.id}]`);
    expect(r.finalState.identify?.candidates.poolLines).toBeGreaterThan(50);
    expect(
      r.finalState.identify?.candidates.droppedByBudget,
    ).toBeGreaterThanOrEqual(0);
  });

  it("no labels: the node is skipped with no call; all labels named: skipped, all_confirmed", async () => {
    const solo = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-solo",
    });
    const a = await run(solo, () => speakers());
    expect(a.identifyRequests).toHaveLength(0);
    expect(a.finalState.identify).toMatchObject({
      status: "skipped",
      skipReason: "no_labels",
    });
    expect(a.finalState.verify?.status).toBe("skipped");

    const named = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      meetingId: "m-named",
    });
    for (const label of ["2", "3"]) {
      getDb()
        .prepare(
          "INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, updated_at) VALUES (?, ?, ?, 0)",
        )
        .run(named.meeting.id, label, `Person ${label}`);
    }
    const b = await run(named, () => speakers());
    expect(b.identifyRequests).toHaveLength(0);
    expect(b.finalState.identify).toMatchObject({
      status: "skipped",
      skipReason: "all_confirmed",
    });
  });
});

describe("identifySpeakers: the length route", () => {
  /** 20 Them lines of 200 tokens: 4000 tokens, so the halves are 2000 (above 1500). */
  function splitMeeting(id: string): MeetingFixture {
    const f = seedFixtureMeeting({
      chunks: 10,
      speakers: 3,
      selfIntroduction: true,
      meetingId: id,
    });
    sizeFixtureSegments(getDb(), f, 200);
    return f;
  }

  it("a split: each half checks segmentId against its own shown lines; one failed half gives partial", async () => {
    const f = splitMeeting("m-split");
    const them = f.segments.filter((s) => s.source === "system");
    const first = them[0] as (typeof them)[number];
    const last = them[them.length - 1] as (typeof them)[number];
    let identifyCalls = 0;
    const r = await run(f, (req) => {
      identifyCalls += 1;
      if (identifyCalls === 1)
        return reply("length", "length", '{"speakers":[');
      // Half 0 holds the early lines; half 1 holds the late lines.
      return req.user.includes(`[${first.id}]`)
        ? // Half 0 cites a line that only half 1 showed: unknown_segment.
          speakers(
            proposal(
              first.id,
              "Hi everyone",
              first.speakerLabel as string,
              "Ana",
            ),
            proposal(last.id, "I am Morgan", "3", "Morgan"),
          )
        : reply("content-filter", "content_filter", "");
    });
    const id = r.finalState.identify;
    expect(identifyCalls).toBe(3);
    expect(id?.status).toBe("partial");
    expect(id?.shown.map((s) => s.unitKey)).toEqual(["candidates/0"]);
    expect(id?.failures.map((f) => f.unitKey)).toEqual(["candidates/1"]);
    expect(id?.failures[0]?.kind).toBe("content_filter");
    // The good half's proposals stay.
    expect(id?.proposals.map((p) => p.seq)).toEqual([0, 1]);
    // The step row of the top key ends partial (4.0.7).
    expect(r.recorder.steps.get("candidates")?.status).toBe("partial");
    // The cited line of half 1 is not in the shown set of half 0.
    const verdicts = r.finalState.verify?.verdicts ?? [];
    expect(verdicts.find((v) => v.segmentId === last.id)?.reason).toBe(
      "unknown_segment",
    );
  });

  it("LR4: length with reasoning on reruns with it off (2 requests); the wire bodies differ", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-lr4",
    });
    let identifyCalls = 0;
    const seen = stubFetch((req) => {
      if (!systemOf(req).includes("diarized labels")) {
        return chatReply('{"corrections":[]}');
      }
      identifyCalls += 1;
      return identifyCalls === 1
        ? chatReply('{"speakers":[', { finish: "length" })
        : chatReply('{"speakers":[]}');
    });
    const { deps } = makeTestDeps({
      reasoningSteps: { identifySpeakers: "bounded" },
    });
    const out = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
    });
    const idReqs = seen.filter((r) => systemOf(r).includes("diarized labels"));
    expect(idReqs).toHaveLength(2);
    const kwargs = (r: (typeof idReqs)[number]) =>
      r.body?.chat_template_kwargs as Record<string, unknown> | undefined;
    expect(kwargs(idReqs[0] as (typeof idReqs)[number])?.enable_thinking).toBe(
      true,
    );
    expect(kwargs(idReqs[1] as (typeof idReqs)[number])?.enable_thinking).toBe(
      false,
    );
    // The second body has no reasoning budget.
    expect(JSON.stringify(idReqs[1]?.body)).not.toContain("thinking_budget");
    expect(JSON.stringify(idReqs[0]?.body)).toContain("thinking_budget");
    // Every node request holds the strict schema (acceptance of WP5a).
    for (const r of seen) {
      expect((r.body?.response_format as { type: string }).type).toBe(
        "json_schema",
      );
    }
    expect(out.finalState.identify?.status).toBe("ok");
  });

  it("LR6: a reasoning leak with reasoning on reruns with it off; with it off the unit fails at once", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-lr6",
    });
    const on = await run(
      f,
      (req) => (req.n === 1 ? okReply("<think>hmm</think>") : speakers()),
      { reasoning: true },
    );
    expect(on.identifyRequests).toHaveLength(2);
    expect(on.finalState.identify?.status).toBe("ok");

    resetWorkflowTables();
    const g = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-lr6b",
    });
    const off = await run(g, () => okReply("<think>hmm</think>"));
    expect(off.identifyRequests).toHaveLength(1);
    expect(off.finalState.identify?.status).toBe("failed");
    expect(off.finalState.identify?.failures[0]?.kind).toBe("reasoning_leak");
  });
});
