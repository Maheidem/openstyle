// Node `correctChunk` (specs/meeting-enhance-agentic.md 4.2, 10.6 row
// `correctChunk`) with the length route (GR6, LR1 to LR3, LR5, LR7, LR8) and
// GR20 (a). The real graph, the real gateway and the real saver run over a
// scripted model. Meetings have one speaker, so `identifySpeakers` is skipped
// and every request is a `correctChunk` request.
import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import {
  estimateTokens,
  formatEnhanceLine,
} from "../src/lib/meetings/workflow/chunking.js";
import { checkCorrections } from "../src/lib/meetings/workflow/nodes/correct-chunk.js";
import type {
  CorrectUnitResult,
  PreparedSegment,
} from "../src/lib/meetings/workflow/types.js";
import { okReply, reply, type ScriptStep } from "./helpers/fake-model.js";
import type { MeetingFixture } from "./helpers/meeting-fixture.js";
import {
  type FakeRecorder,
  makeFakeRecorder,
  makeTestDeps,
  type RecordedRequest,
  resetWorkflowTables,
  runScriptedGraph,
  seedFixtureMeeting,
  seedTestModel,
  sizeFixtureSegments,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const LENGTH_CUT = reply("length", "length", '{"corrections":[');
const corr = (...pairs: [string, string][]) =>
  okReply(
    JSON.stringify({ corrections: pairs.map(([id, text]) => ({ id, text })) }),
  );
const NONE = okReply('{"corrections":[]}');

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

/** A one-chunk meeting of 4 segments of 300 tokens each: a 1200-token chunk. */
function bigChunkMeeting(meetingId = "m-big"): MeetingFixture {
  const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId });
  sizeFixtureSegments(getDb(), f, 300);
  return f;
}

async function run(
  f: MeetingFixture,
  script: ((r: RecordedRequest) => ScriptStep) | ScriptStep[],
  recorder: FakeRecorder = makeFakeRecorder(),
) {
  const { deps } = makeTestDeps({ recorder });
  const out = await runScriptedGraph({
    deps,
    meetingId: f.meeting.id,
    stages: ["enhance"],
    script,
  });
  return { ...out, recorder };
}

const units = (r: {
  finalState: { corrections: { units: CorrectUnitResult[] }[] };
}) => r.finalState.corrections.flatMap((c) => c.units);
const enhanced = (id: string) =>
  (
    getDb()
      .prepare("SELECT enhanced_text FROM meeting_segments WHERE id = ?")
      .get(id) as { enhanced_text: string | null }
  ).enhanced_text;

/** The segment text plus one word: a fix that keeps the 4.2.3 overlap guard quiet. */
const fx = (_f: MeetingFixture, id: string) =>
  `${
    (
      getDb()
        .prepare("SELECT text FROM meeting_segments WHERE id = ?")
        .get(id) as { text: string }
    ).text
  } about`;

describe("correctChunk: answer checks (4.2.3)", () => {
  it("a normal chunk is 1 request; the correction is saved and linked", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1 });
    const id = f.segments[1]?.id as string;
    const r = await run(f, [corr([id, fx(f, id)])]);
    expect(r.requests).toHaveLength(1);
    expect(r.finalState.corrections[0]?.status).toBe("ok");
    expect(enhanced(id)).toBe(fx(f, id));
    expect(r.finalState.saved?.correctedCount).toBe(1);
    // The prompt asks for corrections only. It has no speaker field and no JSON text (D1).
    const system = r.requests[0]?.system ?? "";
    expect(system).not.toMatch(/speakers?\b.*object/i);
    expect(system).not.toContain('{"');
    expect(system).not.toContain("Return ONLY a single JSON");
    expect(r.requests[0]?.user).toContain("<transcript>");
  });

  it("one test for each drop reason, with the call id and seq (A, B, A gives seq 0, 1, 2)", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1 });
    const [a, b, c, d] = f.segments.map((s) => s.id) as [
      string,
      string,
      string,
      string,
    ];
    const original = f.segments[3]?.text as string;
    const r = await run(f, [
      corr(
        [a, fx(f, a)],
        [b, fx(f, b)],
        [a, `${fx(f, a)} again`], // duplicate_id: the first wins
        ["not-a-segment", "x"], // unknown_id
        [c, "   "], // empty_text
        [d, original], // unchanged
      ),
    ]);
    const unit = units(r)[0] as CorrectUnitResult;
    expect(unit.corrections.map((x) => [x.id, x.seq])).toEqual([
      [a, 0],
      [b, 1],
    ]);
    expect(unit.corrections.every((x) => x.callId === 1)).toBe(true);
    expect(unit.dropped.map((x) => [x.reason, x.seq])).toEqual([
      ["duplicate_id", 2],
      ["unknown_id", 3],
      ["empty_text", 4],
      ["unchanged", 5],
    ]);
    expect(unit.dropped.every((x) => x.callId === 1)).toBe(true);
    expect(enhanced(a)).toBe(fx(f, a));
  });

  it("an echoed Speaker prefix is removed", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1 });
    const id = f.segments[0]?.id as string;
    const r = await run(f, [corr([id, `Me: ${fx(f, id)}`])]);
    expect(units(r)[0]?.corrections[0]?.text).toBe(fx(f, id));
  });
});

describe("correctChunk: the length route (4.0.6)", () => {
  it("LR1: length on a 1200-token chunk splits it; both halves succeed (3 requests)", async () => {
    const f = bigChunkMeeting();
    const [s0, , s2] = f.segments.map((s) => s.id) as string[];
    const r = await run(f, (req) => {
      if (req.n === 0) return LENGTH_CUT;
      return req.user.includes(`[${s0}]`)
        ? corr([s0 as string, fx(f, s0 as string)])
        : corr([s2 as string, fx(f, s2 as string)]);
    });
    expect(r.requests).toHaveLength(3);
    const chunk = r.finalState.corrections[0];
    expect(chunk?.status).toBe("ok");
    expect(chunk?.units.map((u) => u.unitKey)).toEqual([
      "chunk:0/0",
      "chunk:0/1",
    ]);
    expect(chunk?.units.map((u) => u.segmentIds)).toEqual([
      f.segmentIdsByChunk[0]?.slice(0, 2),
      f.segmentIdsByChunk[0]?.slice(2),
    ]);
    expect(enhanced(s0 as string)).toBe(fx(f, s0 as string));
    expect(enhanced(s2 as string)).toBe(fx(f, s2 as string));
    // The halves share the step row of their top key (4.0.7 item 5).
    expect([...r.recorder.steps.keys()]).toEqual([
      "prepare",
      "chunk:0",
      "candidates",
      "verify",
      "save",
    ]);
    expect(r.recorder.steps.get("chunk:0")?.status).toBe("succeeded");
  });

  it("LR2: every call length gives 11 requests and fails the unit with length; other chunks are fine", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 1,
      meetingId: "m-two",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const chunk0 = new Set(f.segmentIdsByChunk[0]);
    const r = await run(f, (req) => {
      const first = /\[([^\]]+)\]/.exec(req.user)?.[1] ?? "";
      return chunk0.has(first) ? LENGTH_CUT : NONE;
    });
    const sent0 = r.recorder.calls.filter((c) =>
      c.unitKey.startsWith("chunk:0"),
    );
    // 1 call, 2 halves, 4 quarters, 4 raises.
    expect(sent0).toHaveLength(11);
    expect(sent0.map((c) => c.unitKey)).toEqual([
      "chunk:0",
      "chunk:0/0",
      "chunk:0/0/0",
      "chunk:0/0/0",
      "chunk:0/0/1",
      "chunk:0/0/1",
      "chunk:0/1",
      "chunk:0/1/0",
      "chunk:0/1/0",
      "chunk:0/1/1",
      "chunk:0/1/1",
    ]);
    const [c0, c1] = r.finalState.corrections;
    expect(c0?.status).toBe("failed");
    expect(c0?.units.every((u) => u.failure?.kind === "length")).toBe(true);
    expect(c1?.status).toBe("ok");
    expect(r.finalState.saved?.wroteAny).toBe(true);
  });

  it("LR3: a one-segment chunk raises once; a second length fails the unit (2 requests)", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      segmentsPerChunk: 1,
      meetingId: "m-one",
    });
    sizeFixtureSegments(getDb(), f, 400);
    const r = await run(f, [LENGTH_CUT]);
    expect(r.requests).toHaveLength(2);
    expect(r.finalState.corrections[0]?.status).toBe("failed");
    expect(units(r)[0]?.failure?.kind).toBe("length");
    // The second call is a new attempt of the same key.
    expect(r.recorder.calls.map((c) => [c.unitKey, c.attempt])).toEqual([
      ["chunk:0", 1],
      ["chunk:0", 2],
    ]);
  });

  it("LR5: the raise sends max_tokens = min(maxOutputTokens, 2 x maxOutput)", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      segmentsPerChunk: 1,
      meetingId: "m-raise",
    });
    sizeFixtureSegments(getDb(), f, 400);
    const r = await run(f, [LENGTH_CUT, NONE]);
    expect(r.requests).toHaveLength(2);
    const seg = f.segments[0];
    const line = formatEnhanceLine(
      seg?.id as string,
      "Me",
      (
        getDb()
          .prepare("SELECT text FROM meeting_segments WHERE id = ?")
          .get(seg?.id) as { text: string }
      ).text,
    );
    const chunkTokens = estimateTokens(line) + 1;
    const maxOutput = Math.ceil(chunkTokens * 2) + 200;
    expect(r.requests[0]?.maxOutputTokens).toBe(maxOutput);
    expect(r.requests[1]?.maxOutputTokens).toBe(2 * maxOutput);
    expect(r.finalState.corrections[0]?.status).toBe("ok");
  });

  it("LR7: one half succeeds and one is filtered: the chunk is partial; save writes the good half", async () => {
    const f = bigChunkMeeting("m-lr7");
    const ids = f.segmentIdsByChunk[0] as string[];
    getDb()
      .prepare(
        "UPDATE meeting_segments SET enhanced_text = 'OLD' WHERE id IN (?, ?)",
      )
      .run(ids[0], ids[2]);
    const r = await run(f, (req) => {
      if (req.n === 0) return LENGTH_CUT;
      return req.user.includes(`[${ids[0]}]`)
        ? corr([ids[0] as string, fx(f, ids[0] as string)])
        : reply("content-filter", "content_filter", "");
    });
    expect(r.requests).toHaveLength(3);
    const chunk = r.finalState.corrections[0];
    expect(chunk?.status).toBe("partial");
    expect(chunk?.units.map((u) => u.status)).toEqual(["ok", "failed"]);
    expect(chunk?.units[1]?.failure?.kind).toBe("content_filter");
    // The good half is saved. The segments of the failed half keep their old text.
    expect(enhanced(ids[0] as string)).toBe(fx(f, ids[0] as string));
    expect(enhanced(ids[1] as string)).toBeNull(); // ok unit, no correction: reset to NULL (N6)
    expect(enhanced(ids[2] as string)).toBe("OLD");
    expect(r.recorder.steps.get("chunk:0")?.status).toBe("partial");
    expect(r.finalState.saved?.wroteAny).toBe(true);
  });

  it("LR8: HTTP 413 splits only; there is no raise (3 requests)", async () => {
    const f = bigChunkMeeting("m-lr8");
    const tooLong = new APICallError({
      message: "HTTP 413",
      url: "http://127.0.0.1:1/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 413,
      isRetryable: false,
    });
    const r = await run(f, [tooLong, NONE, NONE]);
    expect(r.requests).toHaveLength(3);
    expect(r.finalState.corrections[0]?.status).toBe("ok");
    expect(r.finalState.corrections[0]?.units).toHaveLength(2);
  });

  it("GR20 (a): a split chunk whose second half has a persistent 503 sends 4 requests", async () => {
    const f = bigChunkMeeting("m-gr20");
    const ids = f.segmentIdsByChunk[0] as string[];
    const down = new APICallError({
      message: "HTTP 503",
      url: "http://127.0.0.1:1/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });
    const r = await run(f, (req) => {
      if (req.n === 0) return LENGTH_CUT;
      return req.user.includes(`[${ids[0]}]`) ? NONE : down;
    });
    // Original, first half, second half twice.
    expect(r.requests).toHaveLength(4);
    expect(r.recorder.calls.map((c) => c.unitKey)).toEqual([
      "chunk:0",
      "chunk:0/0",
      "chunk:0/1",
      "chunk:0/1",
    ]);
    expect(r.finalState.corrections[0]?.status).toBe("partial");
    expect(units(r)[1]?.failure?.kind).toBe("provider_unavailable");
  });
});

// The 4.2.3 word guard (checks 6 to 9): pure, so it runs on plain segments.
describe("checkCorrections word guard", () => {
  const seg = (text: string) =>
    ({ id: "s1", displayLabel: "Me", text }) as PreparedSegment;
  const check = (oldText: string, newText: string) => {
    const r = checkCorrections(
      [{ id: "s1", text: newText }],
      [seg(oldText)],
      7,
    );
    return {
      kept: r.corrections.map((c) => c.text),
      reasons: r.dropped.map((d) => d.reason),
    };
  };

  it("keeps a case or punctuation change", () => {
    expect(check("we ship it on friday", "We ship it on Friday.")).toEqual({
      kept: ["We ship it on Friday."],
      reasons: [],
    });
  });

  it("drops a filler removal as deletes_words", () => {
    expect(check("so um we ship it", "so we ship it").reasons).toEqual([
      "deletes_words",
    ]);
  });

  it("keeps the removal of an exact repeated word", () => {
    expect(check("we ship the the build", "we ship the build")).toEqual({
      kept: ["we ship the build"],
      reasons: [],
    });
    expect(check("I I think to to go", "I think to go").reasons).toEqual([]);
  });

  it("drops a false-start removal as deletes_words", () => {
    expect(
      check("we ship the, we release the build", "we release the build")
        .reasons,
    ).toEqual(["deletes_words"]);
    expect(check("yeah yeah we ship it", "yeah we ship it").reasons).toEqual(
      [],
    );
    expect(check("we go to the we go home", "we go home").reasons).toEqual([
      "deletes_words",
    ]);
  });

  it("drops a correction that fixes a word and also deletes one", () => {
    expect(
      check("we use string lit today um", "we use Streamlit today").reasons,
    ).toEqual(["deletes_words"]);
  });

  it("keeps a two-to-one replacement (a split word joined)", () => {
    expect(check("we use string lit today", "we use Streamlit today")).toEqual({
      kept: ["we use Streamlit today"],
      reasons: [],
    });
  });

  it("keeps a one-to-one fix and an added short word", () => {
    expect(check("be said and sent", "be saved and sent").reasons).toEqual([]);
    expect(
      check("we look and understand", "we look at and understand").kept,
    ).toEqual(["we look at and understand"]);
  });

  it("drops text copied from a neighbour as too_different (net words added)", () => {
    expect(
      check("we ship it", "we ship it on friday after the review").reasons,
    ).toEqual(["too_different"]);
  });

  it("drops a rewrite with low word overlap as too_different", () => {
    expect(
      check("the plan is fine today", "a budget was agreed").reasons,
    ).toEqual(["too_different"]);
  });

  it("keeps a small replacement with high overlap", () => {
    expect(
      check("we use stream lit for it", "we use Streamlit for it").kept,
    ).toEqual(["we use Streamlit for it"]);
  });

  it("drops a changed negation count as meaning_flip", () => {
    expect(
      check("we do not ship it today", "we do ship it today").reasons,
    ).toEqual(["deletes_words"]);
    expect(
      check("we can ship it today", "we can't ship it today").reasons,
    ).toEqual(["meaning_flip"]);
  });

  it("keeps a correction with the same negation count", () => {
    expect(
      check("we dont ship the bild", "we dont ship the build").kept,
    ).toEqual(["we dont ship the build"]);
  });

  it.each([
    ["knows", "know"],
    ["represents", "represent"],
    ["is", "are"],
    ["leads", "lead"],
    ["delivered", "deliver"],
    ["scene", "scenes"],
    ["result", "results"],
  ])("drops %s to %s as inflection_only", (from, to) => {
    expect(check(`so the team ${from} it`, `so the team ${to} it`)).toEqual({
      kept: [],
      reasons: ["inflection_only"],
    });
  });

  it.each([
    ["Datedog", "Datadog"],
    ["Kias", "Kiosks"],
    ["rug", "RAG"],
    ["string lit", "Streamlit"],
    ["time", "team"],
  ])("keeps the real fix %s to %s", (from, to) => {
    const r = check(`we use ${from} here`, `we use ${to} here`);
    expect(r.reasons).toEqual([]);
    expect(r.kept).toHaveLength(1);
  });

  it("keeps a correction that mixes an inflection with a real fix", () => {
    const r = check("it knows Datedog well", "it know Datadog well");
    expect(r.reasons).toEqual([]);
    expect(r.kept).toEqual(["it know Datadog well"]);
  });

  it("does not treat it and itself as one word", () => {
    expect(check("we fix it now", "we fix itself now").reasons).toEqual([]);
  });

  it.each([
    ["we look at it", "we look at the it"],
    ["we need tool", "we need a tool"],
    ["we need a tool", "we need an tool"],
    ["so we ship", "so we ship it"],
  ])("drops %s to %s as function_word_only", (from, to) => {
    expect(check(from, to)).toEqual({
      kept: [],
      reasons: ["function_word_only"],
    });
  });

  it("keeps a lost preposition (look to look at)", () => {
    expect(check("we look the plan", "we look at the plan").kept).toEqual([
      "we look at the plan",
    ]);
  });

  it("keeps a function-word change that comes with another real change", () => {
    expect(
      check("we need tool datedog", "we need a tool Datadog").kept,
    ).toEqual(["we need a tool Datadog"]);
  });

  it("drops a pure insertion of a content word as invented_words", () => {
    expect(check("we ship it", "we ship it tomorrow")).toEqual({
      kept: [],
      reasons: ["invented_words"],
    });
    expect(check("so talking", "so talking about it today").reasons).toEqual([
      "invented_words",
    ]);
  });

  it("keeps a replacement that adds content words", () => {
    expect(check("we find to models", "we fine-tune models").reasons).toEqual(
      [],
    );
    expect(check("ours the tool", "use to the tool").reasons).toEqual([]);
    expect(check("a cloud code demo", "a Claude Code demo").reasons).toEqual(
      [],
    );
  });

  it("keeps an insertion made only of prepositions", () => {
    expect(check("we talk", "we talk about").reasons).toEqual([]);
    expect(check("we talk", "we talk about it").reasons).toEqual([]);
  });

  it("records the call id and seq of a guard drop", () => {
    const r = checkCorrections(
      [{ id: "s1", text: "same words" }],
      [seg("same words")],
      7,
    );
    expect(r.dropped).toEqual([
      { id: "s1", reason: "unchanged", seq: 0, callId: 7 },
    ]);
  });
});
