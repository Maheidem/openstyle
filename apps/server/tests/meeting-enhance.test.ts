// What is left of the old Enhance tests after WP5b deleted `enhance.ts`,
// `enhance-prompt.ts` and `llm-call.ts` (specs/meeting-enhance-agentic.md
// 11.5). It keeps the behavior that still has code: the chunker, the chunk
// budget, the correction token budget, the context and title in the speaker
// prompt, and the attendee spelling fix. The rest moved to the workflow tests.
// The list of each deleted test and its successor is in the PR body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import {
  chunkForEnhance,
  estimateTokens,
  formatEnhanceLine,
} from "../src/lib/meetings/workflow/chunking.js";
import { buildIdentifySystemPrompt } from "../src/lib/meetings/workflow/prompts.js";
import {
  CHUNK_TOKENS_MAX,
  CORRECT_ANSWER_FACTOR,
  CORRECT_ANSWER_FIXED,
} from "../src/lib/meetings/workflow/types.js";
import { okReply } from "./helpers/fake-model.js";
import {
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

const isIdentify = (r: RecordedRequest) => r.system.includes("diarized labels");

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chunkForEnhance", () => {
  it("keeps ids disjoint across chunks and covers every input segment", () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      speaker: "Me",
      text: "word ".repeat(20),
    }));
    const chunks = chunkForEnhance(segs, 50);
    expect(chunks.length).toBeGreaterThan(1);
    const allIds = chunks.flat().map((s) => s.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect([...allIds].sort()).toEqual(segs.map((s) => s.id).sort());
  });

  it("puts a single oversized segment in its own chunk instead of stalling", () => {
    const segs = [{ id: "s0", speaker: "Me", text: "x".repeat(2000) }];
    const chunks = chunkForEnhance(segs, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });

  it("returns no chunks for empty input", () => {
    expect(chunkForEnhance([], 100)).toEqual([]);
  });
});

describe("enhance chunk budget and per-chunk output formula", () => {
  it("uses a 1200-token context budget (small enough that a 7-minute meeting is several chunks)", () => {
    expect(CHUNK_TOKENS_MAX).toBe(1200);
  });

  it("splits a 7-minute-length transcript (well over the old 6000 budget) into more than one chunk", () => {
    // About 7 minutes of speech is about 6000 tokens of transcript. Under a
    // 6000-token budget that was one chunk (the failure); under 1200 it is
    // several, so one truncated call cannot drop the whole meeting.
    const segs = Array.from({ length: 300 }, (_, i) => ({
      id: `m1:mic:${i}`,
      speaker: i % 2 ? "Them" : "Me",
      text: "word ".repeat(8).trim(),
    }));
    expect(chunkForEnhance(segs, CHUNK_TOKENS_MAX).length).toBeGreaterThan(1);
  });

  it("sizes the correction answer budget as ceil(chunkTokens x 2) + 200, with no term for the speaker labels", async () => {
    // One chunk with a Them label: the old formula added 150 tokens for it.
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 2,
      meetingId: "m-budget",
    });
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: () => okReply('{"corrections":[]}'),
    });
    const prepared = r.finalState.prepared;
    const lines = (prepared?.segments ?? []).map((s) =>
      formatEnhanceLine(s.id, s.displayLabel, s.text),
    );
    const chunkTokens = lines
      .map((l) => estimateTokens(l) + 1)
      .reduce((a, b) => a + b, 0);
    const expected =
      Math.ceil(chunkTokens * CORRECT_ANSWER_FACTOR) + CORRECT_ANSWER_FIXED;
    const request = r.requests.find((q) => !isIdentify(q));
    expect(CORRECT_ANSWER_FACTOR).toBe(2);
    expect(CORRECT_ANSWER_FIXED).toBe(200);
    expect(request?.maxOutputTokens).toBe(expected);
  });
});

describe("the speaker prompt: title and context (specs/meeting-speaker-naming.md 5.2)", () => {
  const base = { labels: ["2"], title: null };

  it("includes the context sentence when the context is not blank", () => {
    const prompt = buildIdentifySystemPrompt({
      ...base,
      context: "Call with Ana from Acme",
    });
    expect(prompt).toContain(
      'Additional context for this meeting, provided by the user: "Call with Ana from Acme"',
    );
  });

  it("omits the context sentence when the context is blank", () => {
    const none = buildIdentifySystemPrompt({ ...base, context: null });
    const blank = buildIdentifySystemPrompt({ ...base, context: "   " });
    expect(none).not.toContain("Additional context for this meeting");
    expect(blank).toBe(none);
  });

  it("threads the meeting title and context into the identify request unchanged", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-prompt",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: (req) =>
        isIdentify(req)
          ? okReply('{"speakers":[]}')
          : okReply('{"corrections":[]}'),
    });
    const identify = r.requests.find(isIdentify);
    const prepared = r.finalState.prepared;
    expect(identify?.system).toBe(
      buildIdentifySystemPrompt({
        labels: prepared?.labels.toIdentify ?? [],
        title: f.meeting.title,
        context: f.meeting.context,
      }),
    );
    expect(identify?.system).toContain(f.meeting.context);
  });
});

describe("attendee names fix the spelling in code, never in the prompt (specs/calendar-eventkit.md)", () => {
  /** A meeting whose Them 3 says "I am Morgen Ellis"; the calendar names Morgan Ellis. */
  function seedTypoMeeting() {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-attendee",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    if (!intro) throw new Error("no intro line");
    getDb()
      .prepare("UPDATE meeting_segments SET text = ? WHERE id = ?")
      .run("Hi everyone, I am Morgen Ellis and I run the data team.", intro.id);
    getDb()
      .prepare("UPDATE meetings SET calendar_attendees = ? WHERE id = ?")
      .run(
        JSON.stringify([
          {
            name: "Morgan Ellis",
            email: "morgan@example.test",
            isOrganizer: false,
          },
          {
            name: "Casey Marlow",
            email: "casey@example.test",
            isOrganizer: true,
          },
        ]),
        f.meeting.id,
      );
    return { f, intro };
  }

  async function run(
    f: ReturnType<typeof seedTypoMeeting>["f"],
    intro: ReturnType<typeof seedTypoMeeting>["intro"],
    kind: "name" | "role",
  ) {
    const { deps } = makeTestDeps();
    return runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: (req) =>
        isIdentify(req)
          ? okReply(
              JSON.stringify({
                speakers: [
                  {
                    segmentId: intro.id,
                    quote: "I am Morgen Ellis",
                    label: intro.speakerLabel,
                    kind,
                    name: "Morgen Ellis",
                  },
                ],
              }),
            )
          : okReply('{"corrections":[]}'),
    });
  }

  const row = (meetingId: string, label: string) =>
    getDb()
      .prepare(
        "SELECT suggested_name, suggested_evidence, suggested_kind FROM meeting_speakers WHERE meeting_id = ? AND speaker_label = ?",
      )
      .get(meetingId, label) as
      | {
          suggested_name: string;
          suggested_evidence: string;
          suggested_kind: string;
        }
      | undefined;

  it("replaces a typo with the attendee's full name and keeps evidence and kind; no request holds an attendee", async () => {
    const { f, intro } = seedTypoMeeting();
    const r = await run(f, intro, "name");
    const saved = row(f.meeting.id, intro.speakerLabel as string);
    expect(saved?.suggested_name).toBe("Morgan Ellis");
    expect(saved?.suggested_evidence).toBe("I am Morgen Ellis");
    expect(saved?.suggested_kind).toBe("name");
    // The prompts are the same with or without a calendar link: no attendee in any request.
    for (const req of r.requests) {
      expect(`${req.system}\n${req.user}`).not.toContain("@example.test");
      expect(`${req.system}\n${req.user}`).not.toContain("Casey Marlow");
    }
  });

  it("does not respell a role", async () => {
    const { f, intro } = seedTypoMeeting();
    await run(f, intro, "role");
    const saved = row(f.meeting.id, intro.speakerLabel as string);
    expect(saved?.suggested_name).toBe("Morgen Ellis");
    expect(saved?.suggested_kind).toBe("role");
  });

  it("adds no name to a label without a suggestion", async () => {
    const { f } = seedTypoMeeting();
    const { deps } = makeTestDeps();
    await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: (req) =>
        isIdentify(req)
          ? okReply('{"speakers":[]}')
          : okReply('{"corrections":[]}'),
    });
    expect(
      getDb().prepare("SELECT count(*) AS n FROM meeting_speakers").get(),
    ).toEqual({ n: 0 });
  });
});
