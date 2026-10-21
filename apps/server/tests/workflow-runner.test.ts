// The runner (specs/meeting-enhance-agentic.md 3.4, 10.8): GR4, GR8, GR9, GR13,
// GR15, GR17, GR21 (b), GR24 (a). The real runner, graph, saver and recorder on
// the SQLite file of the test, with a scripted model below the gateway. The
// summarize node is the WP5a stub here, so a chained run ends with the step
// `summarize` skipped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { callStructured } from "../src/lib/llm/gateway.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { createLlmRecorder } from "../src/lib/llm/recorder.js";
import {
  getJob,
  getJobKind,
  hasJob,
  requestCancel,
} from "../src/lib/meetings/job-registry.js";
import {
  runContexts,
  WORKFLOW_FANOUT_CAP,
} from "../src/lib/meetings/workflow/context.js";
import { SUMMARIZE_IS_STUB } from "../src/lib/meetings/workflow/nodes/summarize.js";
import {
  getMeetingEnhanceAutoRunSetting,
  HARD_STOP_GRACE_MS,
  startRun,
} from "../src/lib/meetings/workflow/runner.js";
import { WORKFLOW_GRAPH_VERSION } from "../src/lib/meetings/workflow/types.js";
import { HANG, reply } from "./helpers/fake-model.js";
import {
  checkpointCount,
  defaultAnswer,
  firstIdOf,
  isSummaryRequest,
  LLM_TABLES,
  runnerHarness,
  runRow,
  runsOf,
  stepsOf,
  trackLiveRequests,
  waitForNoJob,
  waitUntil,
} from "./helpers/runner-helpers.js";
import {
  resetWorkflowTables,
  seedFixtureMeeting,
  seedTestModel,
  sizeFixtureSegments,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

// GR15: the config that `invoke` gets.
const invokeConfigs: Record<string, unknown>[] = [];
vi.mock(
  "../src/lib/meetings/workflow/load-graph.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/lib/meetings/workflow/load-graph.js")
      >();
    return {
      ...actual,
      loadGraph: async (deps: Parameters<typeof actual.loadGraph>[0]) => {
        const graph = await actual.loadGraph(deps);
        const invoke = graph.invoke.bind(graph) as (
          i: unknown,
          c: Record<string, unknown>,
        ) => Promise<unknown>;
        (graph as { invoke: unknown }).invoke = (
          i: unknown,
          c: Record<string, unknown>,
        ) => {
          invokeConfigs.push(c);
          return invoke(i, c);
        };
        return graph;
      },
    };
  },
);

const BOTH = ["enhance", "summarize"] as ("enhance" | "summarize")[];

function seedMeeting(chunks: number, id = "m-run", speakers = 1) {
  const f = seedFixtureMeeting({ chunks, speakers, meetingId: id });
  sizeFixtureSegments(getDb(), f, 300);
  return f;
}

function enhancedCount(meetingId: string): number {
  return (
    getDb()
      .prepare(
        "SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = ? AND enhanced_text IS NOT NULL",
      )
      .get(meetingId) as { n: number }
  ).n;
}

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
  invokeConfigs.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  deleteSetting("meeting_enhance_auto_run");
});

describe("startRun: the chained Enhance run (GR24 a)", () => {
  it("claims the slot before the first await, runs one run through every node and releases the slot", async () => {
    const f = seedMeeting(3);
    const h = runnerHarness();
    const started = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Synchronous part: the slot is held and the row exists.
    expect(hasJob(f.meeting.id)).toBe(true);
    expect(getJobKind(f.meeting.id)).toBe("enhance");
    expect(runRow(started.runId).status).toBe("running");
    // A second start finds the slot taken and starts nothing.
    const second = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    expect(second).toEqual({ ok: false, reason: "job_running" });

    await waitForNoJob(f.meeting.id);

    const run = runRow(started.runId);
    expect(run.status).toBe("succeeded");
    expect(run.kind).toBe("enhance");
    expect(run.started_by).toBe("button");
    expect(run.graph_version).toBe(WORKFLOW_GRAPH_VERSION);
    expect(run.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.resume_count).toBe(0);
    expect(run.error_kind).toBeNull();
    expect(JSON.parse(run.result_json ?? "null")).toEqual({
      correctedCount: 3,
      droppedCount: 0,
      suggestionCount: 0,
    });
    expect(runsOf(f.meeting.id)).toHaveLength(1);
    // One call row for each chunk.
    const calls = getDb()
      .prepare(
        "SELECT step_key FROM llm_calls WHERE run_id = ? AND node = 'correctChunk' ORDER BY step_key",
      )
      .all(started.runId) as { step_key: string }[];
    expect(calls.map((c) => c.step_key)).toEqual([
      "chunk:0",
      "chunk:1",
      "chunk:2",
    ]);
    expect(enhancedCount(f.meeting.id)).toBe(3);
    // Node order follows `seq`: prepare, the chunks, save, then the tag
    // step of issue #231 last.
    const steps = stepsOf(started.runId);
    expect(steps[0]?.step_key).toBe("prepare");
    expect(steps.slice(-2).map((s) => s.step_key)).toEqual(["save", "tags"]);
    expect(
      steps.some((s) => s.status === "running" || s.status === "failed"),
    ).toBe(false);
    // The context and the checkpoints are gone.
    expect(runContexts.size()).toBe(0);
    expect(checkpointCount(started.runId)).toBe(0);
    expect(getJob(f.meeting.id)).toBeNull();
  });

  it("changes the job kind to summarize when the Summarize stage starts", async () => {
    const f = seedMeeting(2);
    const base = createLlmRecorder(getDb());
    const kinds: Record<string, string | null> = {};
    const h = runnerHarness({
      deps: {
        recorder: {
          ...base,
          startStep(runId, step) {
            kinds[step.key] = getJobKind(f.meeting.id);
            base.startStep(runId, step);
          },
        },
      },
    });
    const started = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "auto" },
      h.deps,
    );
    expect(started.ok).toBe(true);
    await waitForNoJob(f.meeting.id);
    // The Enhance steps ran under kind enhance. `save` starts after the
    // Summarize stage began.
    expect(kinds["chunk:0"]).toBe("enhance");
    expect(kinds.verify).toBe("enhance");
    expect(kinds.save).toBe("summarize");
    if (started.ok) expect(runRow(started.runId).started_by).toBe("auto");
  });

  it("answers no_meeting for a missing meeting and leaves no slot and no row", () => {
    const h = runnerHarness();
    const started = startRun(
      { meetingId: "no-such-meeting", stages: BOTH, trigger: "button" },
      h.deps,
    );
    expect(started).toEqual({ ok: false, reason: "no_meeting" });
    expect(hasJob("no-such-meeting")).toBe(false);
    expect(runsOf("no-such-meeting")).toHaveLength(0);
  });

  it("a Summarize start runs the summarize stage only", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const started = startRun(
      { meetingId: f.meeting.id, stages: ["summarize"], trigger: "button" },
      h.deps,
    );
    if (!started.ok) throw new Error("start failed");
    expect(getJobKind(f.meeting.id)).toBe("summarize");
    await waitForNoJob(f.meeting.id);
    const run = runRow(started.runId);
    expect(run.kind).toBe("summarize");
    expect(run.status).toBe("succeeded");
    // The stub sends no call. The real node sends one `single` call.
    expect(h.requests).toHaveLength(SUMMARIZE_IS_STUB ? 0 : 1);
    expect(stepsOf(started.runId).map((s) => s.step_key)).toEqual(
      SUMMARIZE_IS_STUB ? ["prepare", "save"] : ["prepare", "single", "save"],
    );
    expect(JSON.parse(run.result_json ?? "null")).toBeNull();
  });

  it("publishes phases and a fixed step total while the run goes on", async () => {
    const f = seedMeeting(3);
    const seen: NonNullable<ReturnType<typeof getJob>>[] = [];
    const h = runnerHarness({
      answer: (r) => {
        const job = getJob(f.meeting.id);
        if (job) seen.push(job);
        return defaultAnswer(r);
      },
    });
    startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    await waitForNoJob(f.meeting.id);
    const reading = seen.filter((j) => j.phase === "reading");
    expect(reading).toHaveLength(3);
    for (const j of reading) {
      expect(j.steps).toBe(3);
      expect(j.step).toBeGreaterThanOrEqual(1);
      expect(j.step).toBeLessThanOrEqual(3);
      expect(j.detail?.length).toBeGreaterThan(0);
      expect(j.detail?.length).toBeLessThanOrEqual(80);
    }
    // Three chunks, then speakers, summarize, save and tags: the total does
    // not grow, and `done` never goes back.
    expect(seen.every((j) => j.total === 7)).toBe(true);
    for (const [i, j] of seen.entries()) {
      expect(j.done).toBeGreaterThanOrEqual(seen[i - 1]?.done ?? 0);
    }
  });
});

describe("GR4: fan-out", () => {
  it("runs at most 3 chunk tasks at once, one request at a time on a local server, and keeps chunk order", async () => {
    const f = seedMeeting(6);
    let alive = 0;
    let maxAlive = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const h = runnerHarness({
      answer: defaultAnswer,
      deps: {
        callStructured: async (input) => {
          alive += 1;
          maxAlive = Math.max(maxAlive, alive);
          try {
            return await callStructured(input);
          } finally {
            alive -= 1;
          }
        },
      },
    });
    // The scripted model counts the requests that are in flight.
    const generate = h.model.doGenerate;
    h.model.doGenerate = async (o) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      try {
        return await (generate as (x: typeof o) => ReturnType<typeof generate>)(
          o,
        );
      } finally {
        inFlight -= 1;
      }
    };
    const started = startRun(
      { meetingId: f.meeting.id, stages: ["enhance"], trigger: "button" },
      h.deps,
    );
    if (!started.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    expect(WORKFLOW_FANOUT_CAP).toBe(3);
    expect(maxAlive).toBeLessThanOrEqual(WORKFLOW_FANOUT_CAP);
    expect(maxAlive).toBeGreaterThan(1);
    expect(maxInFlight).toBe(1);
    expect(runRow(started.runId).status).toBe("succeeded");
    const keys = stepsOf(started.runId)
      .map((s) => s.step_key)
      .filter((k) => k.startsWith("chunk:"));
    expect(keys.sort()).toEqual([
      "chunk:0",
      "chunk:1",
      "chunk:2",
      "chunk:3",
      "chunk:4",
      "chunk:5",
    ]);
    expect(enhancedCount(f.meeting.id)).toBe(6);
  });
});

describe("GR8: soft cancel", () => {
  it("stops queued calls, aborts the call in flight, saves the finished chunk and ends cancelled", async () => {
    const f = seedMeeting(4);
    // Request 0 finishes. Request 1 never answers until it is aborted.
    const h = runnerHarness({
      answer: (r) => (r.n === 0 ? defaultAnswer(r) : HANG),
    });
    const live = trackLiveRequests(h.model);
    const started = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!started.ok) throw new Error("start failed");
    await waitUntil(() => h.requests.length >= 2);
    // Chunk 0 ended, chunk 1 is on the wire, chunks 2 and 3 wait in the lane.
    expect(requestCancel(f.meeting.id)).toBe(true);
    await waitForNoJob(f.meeting.id);
    const run = runRow(started.runId);
    expect(run.status).toBe("cancelled");
    // Only two requests reached the wire. The queued calls got the lease with
    // an aborted signal, so a real `fetch` would not send them.
    expect(live.live).toBe(2);
    // The finished chunk is saved, the rest keeps the raw text.
    expect(enhancedCount(f.meeting.id)).toBe(1);
    expect(checkpointCount(started.runId)).toBe(0);
    expect(stepsOf(started.runId).some((s) => s.status === "running")).toBe(
      false,
    );
    expect(runContexts.size()).toBe(0);
  });
});

describe("GR9: hard stop", () => {
  it("ends cancelled after the grace time when a node ignores its signal, and save does not run", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness({
      deps: {
        // A call that never looks at its signal.
        callStructured: () => new Promise(() => undefined),
      },
    });
    const started = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!started.ok) throw new Error("start failed");
    await vi.advanceTimersByTimeAsync(10);
    expect(requestCancel(f.meeting.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(HARD_STOP_GRACE_MS - 1000);
    expect(hasJob(f.meeting.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await waitForNoJob(f.meeting.id);
    expect(runRow(started.runId).status).toBe("cancelled");
    expect(enhancedCount(f.meeting.id)).toBe(0);
    const steps = stepsOf(started.runId);
    expect(steps.some((s) => s.step_key === "save")).toBe(false);
    expect(steps.some((s) => s.status === "running")).toBe(false);
    expect(checkpointCount(started.runId)).toBe(0);
  });
});

describe("GR13: the meeting is deleted during a run", () => {
  it("ends with no error and leaves no row in the six tables", async () => {
    const f = seedMeeting(3);
    const h = runnerHarness({
      answer: (r) => {
        if (h.requests.length === 2) {
          // What DELETE /api/meetings/:id does: ask the job to stop, drop the row.
          requestCancel(f.meeting.id);
          getDb()
            .prepare("DELETE FROM meetings WHERE id = ?")
            .run(f.meeting.id);
        }
        return defaultAnswer(r);
      },
    });
    const started = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!started.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    for (const table of LLM_TABLES) {
      const column =
        table === "llm_runs"
          ? "scope_id"
          : table === "llm_call_links"
            ? "scope_id"
            : table.includes("checkpoint")
              ? "thread_id"
              : "run_id";
      const value =
        column === "run_id" || column === "thread_id"
          ? started.runId
          : f.meeting.id;
      const n = getDb()
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
        .get(value) as { n: number };
      expect(n.n, table).toBe(0);
    }
    expect(runContexts.size()).toBe(0);
  });
});

describe("GR15: durability", () => {
  it("passes durability sync, the fan-out cap and a signal to every invoke", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    await waitForNoJob(f.meeting.id);
    expect(invokeConfigs).toHaveLength(1);
    const config = invokeConfigs[0] as {
      durability: string;
      maxConcurrency: number;
      signal: AbortSignal;
      configurable: { thread_id: string };
    };
    expect(config.durability).toBe("sync");
    expect(config.maxConcurrency).toBe(WORKFLOW_FANOUT_CAP);
    expect(config.signal).toBeInstanceOf(AbortSignal);
    expect(config.configurable.thread_id).toBe(runsOf(f.meeting.id)[0]?.id);
  });
});

describe("GR17: checkpoint deletion", () => {
  it("a succeeded run keeps no checkpoint", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const s = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    expect(runRow(s.runId).status).toBe("succeeded");
    expect(checkpointCount(s.runId)).toBe(0);
  });

  it("a partial run keeps no checkpoint", async () => {
    const f = seedMeeting(3);
    const h = runnerHarness({
      answer: (r) =>
        firstIdOf(r) === f.segmentIdsByChunk[1]?.[0]
          ? reply("content-filter", "content_filter", "")
          : defaultAnswer(r),
    });
    const s = startRun(
      { meetingId: f.meeting.id, stages: ["enhance"], trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    expect(runRow(s.runId).status).toBe("partial");
    expect(enhancedCount(f.meeting.id)).toBe(2);
    expect(checkpointCount(s.runId)).toBe(0);
  });

  it("a failed run keeps no checkpoint", async () => {
    const f = seedMeeting(3);
    const h = runnerHarness({
      answer: () => reply("content-filter", "content_filter", ""),
    });
    const s = startRun(
      { meetingId: f.meeting.id, stages: ["enhance"], trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    expect(runRow(s.runId).status).toBe("failed");
    expect(checkpointCount(s.runId)).toBe(0);
  });

  it("a cancelled run keeps no checkpoint", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness({
      answer: (r) => {
        requestCancel(f.meeting.id);
        return defaultAnswer(r);
      },
    });
    const s = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    expect(runRow(s.runId).status).toBe("cancelled");
    expect(checkpointCount(s.runId)).toBe(0);
  });

  it("an interrupted run keeps its checkpoint (GR21 b: a graph error with a checkpoint)", async () => {
    const f = seedMeeting(2);
    // A saver fault after the Enhance nodes: the write of the summary channel fails.
    getDb().exec(
      `CREATE TRIGGER fail_summary_write BEFORE INSERT ON llm_checkpoint_writes
       WHEN NEW.channel = 'summary'
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    try {
      const h = runnerHarness();
      const s = startRun(
        { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
        h.deps,
      );
      if (!s.ok) throw new Error("start failed");
      await waitForNoJob(f.meeting.id);
      const run = runRow(s.runId);
      expect(run.status).toBe("interrupted");
      expect(run.error_kind).toBe("internal");
      expect(run.error_detail).toContain("disk full");
      expect(checkpointCount(s.runId)).toBeGreaterThan(0);
      expect(stepsOf(s.runId).some((st) => st.status === "running")).toBe(
        false,
      );
      // Enhance units finished before the fault.
      expect(h.requests.filter((r) => !isSummaryRequest(r))).toHaveLength(2);
    } finally {
      getDb().exec("DROP TRIGGER fail_summary_write");
    }
  });

  it("a prepare fault ends failed with its typed code", async () => {
    const f = seedMeeting(2);
    // No default model: prepare cannot resolve one.
    getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
    const h = runnerHarness();
    const s = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    const run = runRow(s.runId);
    expect(run.status).toBe("failed");
    expect(run.error_kind).toBe("model_unavailable");
    expect(h.requests).toHaveLength(0);
    expect(checkpointCount(s.runId)).toBe(0);
    expect(stepsOf(s.runId).map((st) => [st.step_key, st.status])).toEqual([
      ["prepare", "failed"],
    ]);
  });
});

describe("getMeetingEnhanceAutoRunSetting", () => {
  it("is off when the row is missing", () => {
    deleteSetting("meeting_enhance_auto_run");
    expect(getMeetingEnhanceAutoRunSetting()).toBe(false);
  });

  it('is on only for the exact value "true"', () => {
    writeSetting("meeting_enhance_auto_run", "true");
    expect(getMeetingEnhanceAutoRunSetting()).toBe(true);
    for (const v of ["false", "1", "TRUE", ""]) {
      writeSetting("meeting_enhance_auto_run", v);
      expect(getMeetingEnhanceAutoRunSetting(), v).toBe(false);
    }
  });
});
