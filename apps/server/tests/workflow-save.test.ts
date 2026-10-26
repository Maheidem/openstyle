// Node `save` (specs/meeting-enhance-agentic.md 4.6, 10.6 row `save`), GR16,
// GR21 (a) the `save` case, GR23 (status tables) and GR26 (pure summary
// functions). Real database and real recorder. The state of `save` comes from
// a scripted graph run, or is built by hand where the test needs a state that
// the graph cannot make (a summary, before WP6).
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import type { CallRecord } from "../src/lib/llm/call-record.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { createLlmRecorder } from "../src/lib/llm/recorder.js";
import {
  findSegmentCallId,
  findSpeakerRunId,
  findSummaryRunId,
} from "../src/lib/meetings/llm-record-read.js";
import { makeSaveNode } from "../src/lib/meetings/workflow/nodes/save.js";
import {
  type MeetingSummary,
  MeetingSummarySchema,
} from "../src/lib/meetings/workflow/schemas.js";
import type { WorkflowStateType } from "../src/lib/meetings/workflow/state.js";
import {
  MAX_SUMMARIZE_CALLS,
  oneLine,
  paragraphs,
  plannedSummaryCalls,
  renderSummaryMarkdown,
} from "../src/lib/meetings/workflow/summary-pure.js";
import {
  deriveRunStatus,
  type FinalState,
  foldStatus,
  type NodeStatus,
  type SaveResult,
  type SummarizeResult,
} from "../src/lib/meetings/workflow/types.js";
import { takePendingMeetings } from "../src/lib/search/notify.js";
import { okReply, type ScriptStep } from "./helpers/fake-model.js";
import type { MeetingFixture } from "./helpers/meeting-fixture.js";
import {
  makeTestDeps,
  makeTestRunContext,
  type RecordedRequest,
  resetWorkflowTables,
  runScriptedGraph,
  seedFixtureMeeting,
  seedTestModel,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

// --- helpers -----------------------------------------------------------------

const isIdentify = (r: RecordedRequest) => r.system.includes("diarized labels");
const corr = (...pairs: [string, string][]) =>
  okReply(
    JSON.stringify({ corrections: pairs.map(([id, text]) => ({ id, text })) }),
  );

function makeRealDeps(over: Parameters<typeof makeTestDeps>[0] = {}) {
  return makeTestDeps({ recorder: createLlmRecorder(getDb()), ...over });
}

/** A graph run with the real recorder. `ctx` is dropped afterwards, so tests register a new one. */
async function graphRun(
  f: MeetingFixture,
  script: (r: RecordedRequest) => ScriptStep,
  over: Parameters<typeof makeTestDeps>[0] = {},
) {
  const { deps, contexts } = makeRealDeps(over);
  const out = await runScriptedGraph({
    deps,
    meetingId: f.meeting.id,
    stages: ["enhance"],
    script,
    contexts,
  });
  return { ...out, deps, contexts };
}

function rows(db: DatabaseSync, sql: string, ...args: (string | number)[]) {
  return db.prepare(sql).all(...args) as Record<string, unknown>[];
}

function snapshot(meetingId: string): string {
  const db = getDb();
  return JSON.stringify({
    segments: rows(
      db,
      "SELECT id, enhanced_text FROM meeting_segments WHERE meeting_id = ? ORDER BY id",
      meetingId,
    ),
    speakers: rows(
      db,
      "SELECT speaker_label, display_name, suggested_name, suggested_kind, confirmed_at FROM meeting_speakers WHERE meeting_id = ? ORDER BY speaker_label",
      meetingId,
    ),
    summaries: rows(
      db,
      "SELECT markdown, summary_json FROM meeting_summaries WHERE meeting_id = ?",
      meetingId,
    ),
    links: rows(
      db,
      "SELECT call_id, target_type, target_id, seq, outcome, reason, applied_text FROM llm_call_links WHERE scope_id = ? ORDER BY call_id, target_type, target_id, seq",
      meetingId,
    ),
  });
}

const enhanced = (id: string) =>
  (
    getDb()
      .prepare("SELECT enhanced_text FROM meeting_segments WHERE id = ?")
      .get(id) as { enhanced_text: string | null }
  ).enhanced_text;

// --- save: SW1, SW2 -------------------------------------------------------------

/** The segment text plus one word: a fix that keeps the 4.2.3 overlap guard quiet. */
const fx = (f: MeetingFixture, id: string) =>
  `${f.segments.find((s) => s.id === id)?.text} fixed`;

describe("save: corrections (SW1) and speakers (SW2)", () => {
  it("writes the corrections and the suggestion, and the links", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
    });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const target = f.segments[1]?.id as string;
    const r = await graphRun(f, (req) =>
      isIdentify(req)
        ? okReply(
            JSON.stringify({
              speakers: [
                {
                  segmentId: intro?.id,
                  quote: "I am Morgan Ellis",
                  label: intro?.speakerLabel,
                  kind: "name",
                  name: "Morgan Ellis",
                },
              ],
            }),
          )
        : corr([target, fx(f, target)]),
    );
    expect(r.finalState.saved).toMatchObject({
      sw1: "ok",
      sw2: "ok",
      sw3: "none",
      wroteAny: true,
      failures: [],
      meetingGone: false,
    });
    expect(r.finalState.saved?.correctedCount).toBe(1);
    expect(r.finalState.saved?.droppedCount).toBe(0);
    expect(r.finalState.saved?.suggestionCount).toBe(1);
    expect(enhanced(target)).toBe(fx(f, target));
    // Read back with separate queries (the call record is the proof of the link).
    expect(findSegmentCallId(getDb(), f.meeting.id, target)).not.toBeNull();
    expect(
      findSpeakerRunId(getDb(), f.meeting.id, intro?.speakerLabel as string),
    ).toBe(r.ctx.runId);
    // The save step row is closed (SW4).
    const step = getDb()
      .prepare(
        "SELECT status FROM llm_run_steps WHERE run_id = ? AND step_key = 'save'",
      )
      .get(r.ctx.runId) as { status: string };
    expect(step.status).toBe("succeeded");
  });

  it("GR16: save twice gives the same database, with one link row for each (call, target, seq)", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
    });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const target = f.segments[1]?.id as string;
    const r = await graphRun(f, (req) =>
      isIdentify(req)
        ? okReply(
            JSON.stringify({
              speakers: [
                {
                  segmentId: intro?.id,
                  quote: "I am Morgan Ellis",
                  label: intro?.speakerLabel,
                  kind: "name",
                  name: "Morgan Ellis",
                },
              ],
            }),
          )
        : corr([target, fx(f, target)]),
    );
    const before = snapshot(f.meeting.id);
    const linkCount = (
      getDb()
        .prepare("SELECT count(*) AS n FROM llm_call_links WHERE scope_id = ?")
        .get(f.meeting.id) as { n: number }
    ).n;
    expect(linkCount).toBeGreaterThan(0);
    r.contexts.register(
      makeTestRunContext({ runId: r.ctx.runId, meetingId: f.meeting.id }),
    );
    const again = await makeSaveNode(r.deps)(r.finalState);
    expect(again.saved.wroteAny).toBe(true);
    expect(snapshot(f.meeting.id)).toBe(before);
  });

  it("a chunk that is ok with no correction resets enhanced_text to NULL; a failed chunk keeps its old one", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 1,
      meetingId: "m-reset",
    });
    const [c0, c1] = f.segmentIdsByChunk as [string[], string[]];
    // Make each chunk its own: 2 chunks of 4 segments of 300 tokens.
    getDb()
      .prepare(
        "UPDATE meeting_segments SET enhanced_text = 'OLD' WHERE meeting_id = ?",
      )
      .run(f.meeting.id);
    const { sizeFixtureSegments } = await import(
      "./helpers/workflow-harness.js"
    );
    sizeFixtureSegments(getDb(), f, 300);
    const r = await graphRun(f, (req) => {
      const first = /\[([^\]]+)\]/.exec(req.user)?.[1] ?? "";
      // Chunk 0: ok, no correction. Chunk 1: content filter.
      return c0.includes(first)
        ? okReply('{"corrections":[]}')
        : { unified: "content-filter", raw: "content_filter", text: "" };
    });
    expect(r.finalState.corrections.map((c) => c.status)).toEqual([
      "ok",
      "failed",
    ]);
    for (const id of c0) expect(enhanced(id)).toBeNull();
    for (const id of c1) expect(enhanced(id)).toBe("OLD");
  });

  it("WP7: entries with only the changed words are all dropped; droppedCount counts them, unchanged echoes do not count", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1 });
    const [a, b, c] = f.segments.map((s) => s.id) as [string, string, string];
    const text = (id: string) =>
      f.segments.find((s) => s.id === id)?.text as string;
    const r = await graphRun(f, (req) =>
      isIdentify(req)
        ? okReply('{"speakers":[]}')
        : corr([a, "cooper netties"], [b, "post grass"], [c, text(c)]),
    );
    expect(r.finalState.saved?.correctedCount).toBe(0);
    expect(r.finalState.saved?.droppedCount).toBe(2);
    for (const id of [a, b, c]) expect(enhanced(id)).toBeNull();
  });

  it("SW2 never changes display_name or confirmed_at", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      selfIntroduction: true,
    });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    getDb()
      .prepare(
        "INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, confirmed_at, updated_at) VALUES (?, ?, 'Kept Name', 123, 0)",
      )
      .run(f.meeting.id, intro?.speakerLabel as string);
    // The label is confirmed, so it leaves the label list. A suggestion for the other label still writes.
    const other = intro?.speakerLabel === "3" ? "2" : "3";
    const line = f.segments.find((s) => s.speakerLabel === other);
    const r = await graphRun(f, (req) =>
      isIdentify(req)
        ? okReply(
            JSON.stringify({
              speakers: [
                {
                  segmentId: line?.id,
                  quote: line?.text.slice(0, 30),
                  label: other,
                  kind: "role",
                  name: "the guest",
                },
              ],
            }),
          )
        : okReply('{"corrections":[]}'),
    );
    expect(r.finalState.saved?.sw2).toBe("ok");
    const kept = getDb()
      .prepare(
        "SELECT display_name, confirmed_at FROM meeting_speakers WHERE meeting_id = ? AND speaker_label = ?",
      )
      .get(f.meeting.id, intro?.speakerLabel as string) as {
      display_name: string;
      confirmed_at: number;
    };
    expect(kept).toEqual({ display_name: "Kept Name", confirmed_at: 123 });
    const written = getDb()
      .prepare(
        "SELECT suggested_name, display_name, confirmed_at FROM meeting_speakers WHERE meeting_id = ? AND speaker_label = ?",
      )
      .get(f.meeting.id, other) as {
      suggested_name: string;
      display_name: string | null;
      confirmed_at: number | null;
    };
    expect(written).toEqual({
      suggested_name: "the guest",
      display_name: null,
      confirmed_at: null,
    });
  });

  it("link keys: the same segment id twice leaves two link rows with different seq; the 7.8 query returns the applied one, also after a second save", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-links",
    });
    const a = f.segments[0]?.id as string;
    const b = f.segments[1]?.id as string;
    const r = await graphRun(f, () =>
      corr([a, fx(f, a)], [b, fx(f, b)], [a, `${fx(f, a)} again`]),
    );
    const links = rows(
      getDb(),
      "SELECT target_id, seq, outcome, reason FROM llm_call_links WHERE scope_id = ? AND target_type = 'segment' ORDER BY seq",
      f.meeting.id,
    );
    expect(links).toEqual([
      { target_id: a, seq: 0, outcome: "applied", reason: null },
      { target_id: b, seq: 1, outcome: "applied", reason: null },
      { target_id: a, seq: 2, outcome: "dropped", reason: "duplicate_id" },
    ]);
    const callId = findSegmentCallId(getDb(), f.meeting.id, a);
    expect(callId).not.toBeNull();
    r.contexts.register(
      makeTestRunContext({ runId: r.ctx.runId, meetingId: f.meeting.id }),
    );
    await makeSaveNode(r.deps)(r.finalState);
    expect(findSegmentCallId(getDb(), f.meeting.id, a)).toBe(callId);
  });

  it("two proposals for one label in one call (kept and conflict_lost) leave two link rows; the 7.8 speaker query returns the run", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-speaker-links",
    });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const r = await graphRun(f, (req) =>
      isIdentify(req)
        ? okReply(
            JSON.stringify({
              speakers: [
                {
                  segmentId: intro?.id,
                  quote: "I am Morgan Ellis",
                  label: intro?.speakerLabel,
                  kind: "name",
                  name: "Morgan Ellis",
                },
                {
                  segmentId: intro?.id,
                  quote: "I run the data team",
                  label: intro?.speakerLabel,
                  kind: "role",
                  name: "the data lead",
                },
              ],
            }),
          )
        : okReply('{"corrections":[]}'),
    );
    const links = rows(
      getDb(),
      "SELECT seq, outcome, reason FROM llm_call_links WHERE scope_id = ? AND target_type = 'speaker' ORDER BY seq",
      f.meeting.id,
    );
    expect(links).toEqual([
      { seq: 0, outcome: "applied", reason: null },
      { seq: 1, outcome: "dropped", reason: "conflict_lost" },
    ]);
    expect(
      findSpeakerRunId(getDb(), f.meeting.id, intro?.speakerLabel as string),
    ).toBe(r.ctx.runId);
  });
});

describe("save: the #163 replay", () => {
  it("chunk 0 ends length: the speaker suggestion of the other chunks is written, with its link", async () => {
    const f = seedFixtureMeeting({
      chunks: 3,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-163-save",
    });
    const { sizeFixtureSegments } = await import(
      "./helpers/workflow-harness.js"
    );
    sizeFixtureSegments(getDb(), f, 300);
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const chunk0 = new Set(f.segmentIdsByChunk[0]);
    const r = await graphRun(f, (req) => {
      if (isIdentify(req)) {
        return okReply(
          JSON.stringify({
            speakers: [
              {
                segmentId: intro?.id,
                quote: "I am Morgan Ellis",
                label: intro?.speakerLabel,
                kind: "name",
                name: "Morgan Ellis",
              },
            ],
          }),
        );
      }
      const first = /\[([^\]]+)\]/.exec(req.user)?.[1] ?? "";
      return chunk0.has(first)
        ? { unified: "length", raw: "length", text: '{"corrections":[' }
        : okReply('{"corrections":[]}');
    });
    expect(r.finalState.saved).toMatchObject({
      sw1: "ok",
      sw2: "ok",
      wroteAny: true,
    });
    expect(r.finalState.corrections[0]?.status).toBe("failed");
    const row = getDb()
      .prepare(
        "SELECT suggested_name, suggested_evidence FROM meeting_speakers WHERE meeting_id = ? AND speaker_label = ?",
      )
      .get(f.meeting.id, intro?.speakerLabel as string) as {
      suggested_name: string;
      suggested_evidence: string;
    };
    expect(row).toEqual({
      suggested_name: "Morgan Ellis",
      suggested_evidence: "I am Morgan Ellis",
    });
    expect(
      findSpeakerRunId(getDb(), f.meeting.id, intro?.speakerLabel as string),
    ).toBe(r.ctx.runId);
  });
});

// --- save: faults ----------------------------------------------------------------

/** A database whose `UPDATE meeting_segments` statement fails. */
function flakyDb(
  real: DatabaseSync,
  failsFrom: number,
  failCount: number,
): DatabaseSync {
  let runs = 0;
  let failed = 0;
  return new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("UPDATE meeting_segments")) return stmt;
          return new Proxy(stmt, {
            get(st, p) {
              if (p === "run") {
                return (...args: never[]) => {
                  runs += 1;
                  if (runs >= failsFrom && failed < failCount) {
                    failed += 1;
                    throw new Error("database is locked (SQLITE_BUSY)");
                  }
                  return st.run(...args);
                };
              }
              const v = Reflect.get(st, p);
              return typeof v === "function" ? v.bind(st) : v;
            },
          });
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
}

describe("save: faults (GR21 a)", () => {
  async function stateWithCorrections(f: MeetingFixture) {
    const a = f.segments[0]?.id as string;
    const b = f.segments[1]?.id as string;
    const r = await graphRun(f, () => corr([a, fx(f, a)], [b, fx(f, b)]));
    // Roll back to the old text, so a second save can write again.
    getDb()
      .prepare(
        "UPDATE meeting_segments SET enhanced_text = 'OLD' WHERE meeting_id = ?",
      )
      .run(f.meeting.id);
    getDb().exec("DELETE FROM llm_call_links");
    return { a, b, r };
  }

  it("a write that throws once succeeds on the retry", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-busy1",
    });
    const { a, r } = await stateWithCorrections(f);
    const { deps, contexts } = makeRealDeps({ db: flakyDb(getDb(), 1, 1) });
    contexts.register(
      makeTestRunContext({ runId: r.ctx.runId, meetingId: f.meeting.id }),
    );
    const out = await makeSaveNode(deps)(r.finalState);
    expect(out.saved.sw1).toBe("ok");
    expect(out.saved.failures).toEqual([]);
    expect(enhanced(a)).toBe(fx(f, a));
  });

  it("a write that throws twice is save_failed; a rolled-back SW1 leaves no link; the other writes stay", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-busy2",
    });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const target = f.segments[1]?.id as string;
    const r = await graphRun(f, (req) =>
      isIdentify(req)
        ? okReply(
            JSON.stringify({
              speakers: [
                {
                  segmentId: intro?.id,
                  quote: "I am Morgan Ellis",
                  label: intro?.speakerLabel,
                  kind: "name",
                  name: "Morgan Ellis",
                },
              ],
            }),
          )
        : corr([target, fx(f, target)]),
    );
    getDb()
      .prepare(
        "UPDATE meeting_segments SET enhanced_text = 'OLD' WHERE meeting_id = ?",
      )
      .run(f.meeting.id);
    getDb().exec("DELETE FROM llm_call_links");
    getDb().prepare("DELETE FROM meeting_speakers").run();
    // The second UPDATE of every attempt fails: SW1 rolls back after one row.
    const { deps, contexts } = makeRealDeps({ db: flakyDb(getDb(), 2, 99) });
    contexts.register(
      makeTestRunContext({ runId: r.ctx.runId, meetingId: f.meeting.id }),
    );
    const out = await makeSaveNode(deps)(r.finalState);
    expect(out.saved.sw1).toBe("failed");
    expect(out.saved.failures[0]).toMatchObject({
      node: "save",
      kind: "save_failed",
    });
    expect(out.saved.failures[0]?.message).toContain("SW1 failed twice");
    // SW1 rolled back as a whole: no segment changed, no segment link.
    expect(
      rows(
        getDb(),
        "SELECT enhanced_text FROM meeting_segments WHERE meeting_id = ? AND enhanced_text <> 'OLD'",
        f.meeting.id,
      ),
    ).toEqual([]);
    expect(
      rows(
        getDb(),
        "SELECT 1 FROM llm_call_links WHERE target_type = 'segment'",
      ),
    ).toEqual([]);
    // SW2 still ran.
    expect(out.saved.sw2).toBe("ok");
    expect(out.saved.wroteAny).toBe(true);
    // The step row of save is partial: failures and a write that committed.
    const step = getDb()
      .prepare(
        "SELECT status, error_kind FROM llm_run_steps WHERE run_id = ? AND step_key = 'save'",
      )
      .get(r.ctx.runId) as { status: string; error_kind: string };
    expect(step).toEqual({ status: "partial", error_kind: "save_failed" });
  });

  it("GR21 a: SW1 and SW2 both failing twice gives failed; deriveRunStatus reads partial or failed from the result", () => {
    const base: SaveResult = {
      sw1: "failed",
      sw2: "failed",
      sw3: "none",
      wroteAny: false,
      correctedCount: 0,
      droppedCount: 0,
      suggestionCount: 0,
      failures: [
        {
          node: "save",
          unitKey: null,
          kind: "save_failed",
          finishReason: null,
          rawFinishReason: null,
          attempt: null,
          llmCallIds: [],
          message: "SW1 failed twice",
        },
      ],
      meetingGone: false,
    };
    const state = finalState({ saved: base });
    expect(deriveRunStatus(state, noEnd)).toBe("failed");
    expect(
      deriveRunStatus(
        finalState({ saved: { ...base, wroteAny: true } }),
        noEnd,
      ),
    ).toBe("partial");
  });

  it("a delete between SW1 and SW2 ends the run without an error", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-gone",
    });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const target = f.segments[1]?.id as string;
    let nowCalls = 0;
    // `startRun` reads the clock once; SW2 reads it second, after SW1 committed.
    const r = await graphRun(
      f,
      (req) =>
        isIdentify(req)
          ? okReply(
              JSON.stringify({
                speakers: [
                  {
                    segmentId: intro?.id,
                    quote: "I am Morgan Ellis",
                    label: intro?.speakerLabel,
                    kind: "name",
                    name: "Morgan Ellis",
                  },
                ],
              }),
            )
          : corr([target, fx(f, target)]),
      {
        now: () => {
          nowCalls += 1;
          if (nowCalls === 2)
            getDb()
              .prepare("DELETE FROM meetings WHERE id = ?")
              .run(f.meeting.id);
          return 1_760_000_000_000 + nowCalls;
        },
      },
    );
    expect(r.finalState.saved).toMatchObject({
      meetingGone: true,
      sw1: "ok",
      sw2: "none",
      failures: [],
    });
    expect(deriveRunStatus(r.finalState as unknown as FinalState, noEnd)).toBe(
      "meeting_deleted",
    );
    expect(
      rows(getDb(), "SELECT 1 FROM meetings WHERE id = ?", f.meeting.id),
    ).toEqual([]);
  });
});

// --- save: SW3, the summary -------------------------------------------------------

const SUMMARY: MeetingSummary = {
  overview: "The team reviewed the rollout.\nA second line.",
  keyPoints: ["The load test passed.", "Export takes four minutes."],
  decisions: ["Ship on Friday."],
  actionItems: [
    { task: "Write the notes", owner: "Jordan", due: "next Friday" },
    { task: "Book the call", owner: null, due: null },
  ],
  openQuestions: [],
};

function summaryResult(over: Partial<SummarizeResult> = {}): SummarizeResult {
  return {
    status: "ok",
    summary: SUMMARY,
    markdown: renderSummaryMarkdown(SUMMARY),
    llmProvider: "server",
    llmModel: "Qwen3.8-27B",
    inputTokens: 100,
    outputTokens: 40,
    costUsd: null,
    callCount: 1,
    failure: null,
    llmCallIds: [],
    partial: false,
    ...over,
  };
}

function recordCall(runId: string, unitKey: string): number {
  const rec = createLlmRecorder(getDb());
  const call: CallRecord = {
    runId,
    unitKey,
    node: "summarize",
    retryReason: null,
    provider: "server",
    modelRequested: "Qwen3.8-27B",
    modelServed: "Qwen3.8-27B",
    instructions: "x",
    messages: [{ role: "user", content: "y" }],
    schema: { name: "meeting_summary", version: 1, json: {} },
    params: {
      topLevel: {},
      extraBody: {},
      dropped: [],
      source: { mode: "auto" },
      capturedFrom: "sdk_request",
      warnings: [],
      structuredMode: "json_schema_strict",
    },
    rawText: "{}",
    parsed: SUMMARY,
    reasoningChars: null,
    finishUnified: "stop",
    finishRaw: "stop",
    usage: { input: 100, output: 40, reasoning: null, cached: null },
    queuedMs: 0,
    latencyMs: 5,
    errorKind: null,
    errorDetail: null,
    startedAt: 1,
    finishedAt: 2,
  };
  const recorded = rec.recordCall(call);
  if (!recorded) throw new Error("call record failed");
  return recorded.id;
}

describe("save: the summary (SW3)", () => {
  function summaryState(
    f: MeetingFixture,
    runId: string,
    summary: SummarizeResult,
  ): WorkflowStateType {
    return {
      runId,
      meetingId: f.meeting.id,
      stages: ["summarize"],
      prepared: null,
      models: null,
      corrections: [],
      identify: null,
      verify: null,
      summary,
      saved: null,
      tags: null,
    };
  }

  it("writes the Markdown and the object in one transaction; the stored Markdown equals the real render", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-sw3",
    });
    const { deps, contexts } = makeRealDeps();
    createLlmRecorder(getDb()).startRun({
      id: "run-sw3",
      scope: "meeting",
      scopeId: f.meeting.id,
      kind: "summarize",
      startedBy: "button",
      graphVersion: 1,
      startedAt: 1,
    });
    const callId = recordCall("run-sw3", "single");
    contexts.register(
      makeTestRunContext({ runId: "run-sw3", meetingId: f.meeting.id }),
    );
    takePendingMeetings();
    const out = await makeSaveNode(deps)(
      summaryState(f, "run-sw3", summaryResult({ llmCallIds: [callId, null] })),
    );
    expect(out.saved).toMatchObject({
      sw1: "none",
      sw2: "none",
      sw3: "ok",
      wroteAny: true,
      failures: [],
    });
    // The new summary is a hint for the search index (no audio_dir here, so
    // no transcript.md write sends it).
    expect(takePendingMeetings()).toContain(f.meeting.id);
    const row = getDb()
      .prepare(
        "SELECT markdown, summary_json, llm_provider, llm_model, input_tokens, output_tokens, cost_usd, created_at FROM meeting_summaries WHERE meeting_id = ?",
      )
      .get(f.meeting.id) as Record<string, unknown>;
    const parsed = JSON.parse(row.summary_json as string) as unknown;
    expect(MeetingSummarySchema.safeParse(parsed).success).toBe(true);
    expect(row.markdown).toBe(renderSummaryMarkdown(parsed as MeetingSummary));
    expect(row).toMatchObject({
      llm_provider: "server",
      llm_model: "Qwen3.8-27B",
      input_tokens: 100,
      output_tokens: 40,
      cost_usd: null,
    });
    // The same decisions and action items stand in the Markdown.
    expect(row.markdown).toContain("- Ship on Friday.");
    expect(row.markdown).toContain(
      "- Write the notes (Owner: Jordan; Due: next Friday)",
    );
    // The meeting is summarized, and the link names the new row (null call id: no link).
    expect(
      (
        getDb()
          .prepare("SELECT status FROM meetings WHERE id = ?")
          .get(f.meeting.id) as { status: string }
      ).status,
    ).toBe("summarized");
    expect(findSummaryRunId(getDb(), f.meeting.id)).toBe("run-sw3");
    expect(
      rows(
        getDb(),
        "SELECT count(*) AS n FROM llm_call_links WHERE target_type = 'summary'",
      )[0]?.n,
    ).toBe(1);
    // save twice leaves the same value.
    contexts.drop("run-sw3");
    contexts.register(
      makeTestRunContext({ runId: "run-sw3", meetingId: f.meeting.id }),
    );
    const before = snapshot(f.meeting.id);
    await makeSaveNode(deps)(
      summaryState(f, "run-sw3", summaryResult({ llmCallIds: [callId] })),
    );
    const after = JSON.parse(snapshot(f.meeting.id)) as {
      summaries: { markdown: string; summary_json: string }[];
    };
    expect(after.summaries).toEqual(
      (JSON.parse(before) as typeof after).summaries,
    );
  });

  it("a failed Summarize run leaves the old summary_json and Markdown", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-sw3-fail",
    });
    getDb()
      .prepare(
        "INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at) VALUES (?, 'OLD MD', '{\"old\":1}', 5)",
      )
      .run(f.meeting.id);
    const { deps, contexts } = makeRealDeps();
    createLlmRecorder(getDb()).startRun({
      id: "run-sw3b",
      scope: "meeting",
      scopeId: f.meeting.id,
      kind: "summarize",
      startedBy: "button",
      graphVersion: 1,
      startedAt: 1,
    });
    contexts.register(
      makeTestRunContext({ runId: "run-sw3b", meetingId: f.meeting.id }),
    );
    const failed = summaryResult({
      status: "failed",
      summary: null,
      markdown: "",
    });
    const out = await makeSaveNode(deps)(summaryState(f, "run-sw3b", failed));
    expect(out.saved).toMatchObject({ sw3: "none", wroteAny: false });
    expect(
      rows(
        getDb(),
        "SELECT markdown, summary_json FROM meeting_summaries WHERE meeting_id = ?",
        f.meeting.id,
      ),
    ).toEqual([{ markdown: "OLD MD", summary_json: '{"old":1}' }]);
    expect(
      (
        getDb()
          .prepare("SELECT status FROM meetings WHERE id = ?")
          .get(f.meeting.id) as { status: string }
      ).status,
    ).toBe("transcribed");
  });
});

// --- GR23 -------------------------------------------------------------------------

const noEnd = {
  cancelled: false,
  fault: "none" as const,
  hasCheckpoint: false,
};

function finalState(over: Partial<FinalState>): FinalState {
  return {
    stages: ["enhance"],
    corrections: [],
    identify: null,
    verify: null,
    summary: null,
    saved: null,
    ...over,
  };
}

function saved(over: Partial<SaveResult> = {}): SaveResult {
  return {
    sw1: "ok",
    sw2: "none",
    sw3: "none",
    wroteAny: true,
    correctedCount: 0,
    droppedCount: 0,
    suggestionCount: 0,
    failures: [],
    meetingGone: false,
    ...over,
  };
}

const chunk = (status: NodeStatus, chunkIndex = 0) => ({
  chunkIndex,
  status,
  units: [],
});
const identify = (status: NodeStatus) => ({
  status,
  proposals: [],
  shown: [],
  candidates: {
    poolLines: 0,
    selectedLines: 0,
    anchorLines: 0,
    cueLines: 0,
    nameTokenLines: 0,
    droppedByBudget: 0,
  },
  failures: [],
});
const verify = (status: NodeStatus) => ({
  status,
  failure: null,
  verdicts: [],
  suggestions: [],
});
const failure = (kind: "save_failed" | "internal" = "save_failed") => ({
  node: "save" as const,
  unitKey: null,
  kind,
  finishReason: null,
  rawFinishReason: null,
  attempt: null,
  llmCallIds: [],
  message: "m",
});

describe("GR23 (a): foldStatus", () => {
  it.each([
    [["ok", "failed"], "partial"],
    [["partial"], "partial"], // a partial entry counts as one ok and one failed
    [["failed", "failed"], "failed"],
    [["cancelled", "ok"], "cancelled"],
    [["skipped", "skipped"], "skipped"],
    [[], "skipped"],
    [["ok", "skipped"], "skipped"],
    [["ok", "ok"], "ok"],
    [["partial", "ok", "failed"], "partial"],
    [["failed", "cancelled"], "failed"],
  ] as [NodeStatus[], NodeStatus][])("%j gives %s", (list, expected) => {
    expect(foldStatus(list)).toBe(expected);
  });
});

describe("GR23 (b): deriveRunStatus, one case for each rule and example (3.4.3)", () => {
  const ok = [chunk("ok")];
  it("rule 1: a deleted meeting", () => {
    expect(
      deriveRunStatus(
        finalState({ saved: saved({ meetingGone: true }) }),
        noEnd,
      ),
    ).toBe("meeting_deleted");
  });
  it("rule 2: cancelled", () => {
    expect(
      deriveRunStatus(finalState({ corrections: ok, saved: saved() }), {
        ...noEnd,
        cancelled: true,
      }),
    ).toBe("cancelled");
  });
  it("rule 3: a prepare fault", () => {
    expect(
      deriveRunStatus(finalState({}), { ...noEnd, fault: "prepare" }),
    ).toBe("failed");
  });
  it("rule 4: a graph error is interrupted with a checkpoint, else failed", () => {
    expect(
      deriveRunStatus(finalState({}), {
        cancelled: false,
        fault: "graph",
        hasCheckpoint: true,
      }),
    ).toBe("interrupted");
    expect(
      deriveRunStatus(finalState({}), {
        cancelled: false,
        fault: "graph",
        hasCheckpoint: false,
      }),
    ).toBe("failed");
  });
  it("rule 5: every node ok or skipped, saved, no failures", () => {
    expect(
      deriveRunStatus(
        finalState({
          corrections: ok,
          identify: identify("ok"),
          verify: verify("ok"),
          saved: saved(),
        }),
        noEnd,
      ),
    ).toBe("succeeded");
    // Three chunks ok, no correction; identify skipped; SW1 ok.
    expect(
      deriveRunStatus(
        finalState({
          corrections: [chunk("ok", 0), chunk("ok", 1), chunk("ok", 2)],
          identify: identify("skipped"),
          verify: verify("skipped"),
          saved: saved(),
        }),
        noEnd,
      ),
    ).toBe("succeeded");
    // Chained run, every node and SW1 to SW3 ok.
    expect(
      deriveRunStatus(
        finalState({
          stages: ["enhance", "summarize"],
          corrections: ok,
          identify: identify("ok"),
          verify: verify("ok"),
          summary: summaryResult(),
          saved: saved({ sw3: "ok" }),
        }),
        noEnd,
      ),
    ).toBe("succeeded");
  });
  it("rule 6: partial", () => {
    // Chunk 2 ends content_filter, the rest and SW1, SW2 ok (GR5).
    expect(
      deriveRunStatus(
        finalState({
          corrections: [chunk("ok", 0), chunk("failed", 2)],
          identify: identify("ok"),
          verify: verify("ok"),
          saved: saved({ sw2: "ok" }),
        }),
        noEnd,
      ),
    ).toBe("partial");
    // verifyEvidence throws a plain Error (internal); SW1 ok.
    expect(
      deriveRunStatus(
        finalState({
          corrections: ok,
          identify: identify("ok"),
          verify: { ...verify("failed"), failure: failure("internal") },
          saved: saved(),
        }),
        noEnd,
      ),
    ).toBe("partial");
    // SW2 fails twice, SW1 ok.
    expect(
      deriveRunStatus(
        finalState({
          corrections: ok,
          identify: identify("ok"),
          verify: verify("ok"),
          saved: saved({ sw2: "failed", failures: [failure()] }),
        }),
        noEnd,
      ),
    ).toBe("partial");
    // Chained run; corrections and SW1 ok; the summary failed, SW3 none: partial, Enhance stays saved.
    expect(
      deriveRunStatus(
        finalState({
          stages: ["enhance", "summarize"],
          corrections: ok,
          identify: identify("ok"),
          verify: verify("ok"),
          summary: summaryResult({ status: "failed" }),
          saved: saved(),
        }),
        noEnd,
      ),
    ).toBe("partial");
  });
  it("rule 7: failed", () => {
    // HTTP 401: chunk 0 failed, the later nodes skipped, SW1 and SW2 none (GR18).
    expect(
      deriveRunStatus(
        finalState({
          corrections: [chunk("failed")],
          identify: identify("skipped"),
          verify: verify("skipped"),
          saved: saved({ sw1: "none", wroteAny: false }),
        }),
        noEnd,
      ),
    ).toBe("failed");
    // No API key at the first call.
    expect(
      deriveRunStatus(
        finalState({
          corrections: [chunk("failed")],
          saved: saved({ sw1: "none", wroteAny: false }),
        }),
        noEnd,
      ),
    ).toBe("failed");
    // SW1 and SW2 both fail twice.
    expect(
      deriveRunStatus(
        finalState({
          corrections: ok,
          identify: identify("ok"),
          verify: verify("ok"),
          saved: saved({
            sw1: "failed",
            sw2: "failed",
            wroteAny: false,
            failures: [failure(), failure()],
          }),
        }),
        noEnd,
      ),
    ).toBe("failed");
    // A Summarize-only run whose summary failed is failed, not partial (4.6.3). The deadline case (GR22) reads the same.
    expect(
      deriveRunStatus(
        finalState({
          stages: ["summarize"],
          summary: summaryResult({ status: "failed" }),
          saved: saved({ sw1: "none", wroteAny: false }),
        }),
        noEnd,
      ),
    ).toBe("failed");
    // Nothing saved at all.
    expect(deriveRunStatus(finalState({ saved: null }), noEnd)).toBe("failed");
  });
});

// --- GR26 -------------------------------------------------------------------------

describe("GR26 (a): renderSummaryMarkdown (4.5.6)", () => {
  const EMPTY: MeetingSummary = {
    overview: "",
    keyPoints: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
  };
  it("an empty summary gives five headings and None. under four lists", () => {
    const md = renderSummaryMarkdown(EMPTY);
    expect(md.match(/^## /gm)).toHaveLength(5);
    expect(md.match(/^None\.$/gm)).toHaveLength(4);
    expect(md.match(/^## .*$/gm)).toEqual([
      "## Overview",
      "## Key Points",
      "## Decisions",
      "## Action Items",
      "## Open Questions",
    ]);
  });
  it("a line that starts with # makes no heading", () => {
    const md = renderSummaryMarkdown({
      ...EMPTY,
      overview: "Real text.\n## Fake\nMore text.",
      keyPoints: ["a\n## Fake"],
    });
    expect(md.match(/^## /gm)).toHaveLength(5);
    expect(md).not.toContain("Fake\nMore");
    expect(paragraphs("  # x\nok")).toBe("ok");
  });
  it("an action item with owner and due prints (Owner: ...; Due: ...)", () => {
    const md = renderSummaryMarkdown({
      ...EMPTY,
      actionItems: [
        { task: "Send it", owner: "Ana", due: "Friday" },
        { task: "Plan", owner: "Ben", due: null },
        { task: "Plain", owner: null, due: null },
      ],
    });
    expect(md).toContain("- Send it (Owner: Ana; Due: Friday)");
    expect(md).toContain("- Plan (Owner: Ben)");
    expect(md).toContain("- Plain\n");
  });
  it("line breaks inside an item become spaces", () => {
    expect(oneLine("a\nb\r\n  c")).toBe("a b c");
    expect(
      renderSummaryMarkdown({ ...EMPTY, decisions: ["one\ntwo"] }),
    ).toContain("- one two");
  });
});

describe("GR26 (b): plannedSummaryCalls (4.5.3)", () => {
  it("under the budget plans one part: three extraction calls and the overview", () => {
    expect(plannedSummaryCalls(900, 1000)).toEqual({ calls: 3 + 1 });
  });
  it("above the budget plans three calls for each part, then the overview", () => {
    // Budget 2000: overlap 200, fresh 1800; 10 800 tokens give 6 parts.
    expect(plannedSummaryCalls(10_800, 2000)).toEqual({ calls: 6 * 3 + 1 });
    // Budget 8000: overlap 400 (the cap), fresh 7600; 40 000 tokens give 6 parts.
    expect(plannedSummaryCalls(8000 * 5, 8000)).toEqual({ calls: 6 * 3 + 1 });
  });
  it("a plan over MAX_SUMMARIZE_CALLS gives budget_exceeded", () => {
    expect(MAX_SUMMARIZE_CALLS).toBe(40);
    // 13 parts: 40 calls, the limit.
    expect(plannedSummaryCalls(13 * 7600, 8000)).toEqual({ calls: 40 });
    expect(plannedSummaryCalls(13 * 7600 + 1, 8000)).toEqual({
      error: "budget_exceeded",
    });
    expect(plannedSummaryCalls(2_000_000, 8000)).toEqual({
      error: "budget_exceeded",
    });
  });
});
