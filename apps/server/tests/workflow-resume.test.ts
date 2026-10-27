// Resume, guards and the boot sweep (specs/meeting-enhance-agentic.md 3.4.7,
// 10.8): GR10 (a) (b), GR11, GR12, GR24 (a) (kill between the stages). The
// real runner, graph, saver and recorder on the SQLite file of the test. A
// crash is a saver fault: a trigger makes the write of one channel fail, so the
// run ends `interrupted` with its checkpoint, as after a process death.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { createLlmRecorder } from "../src/lib/llm/recorder.js";
import {
  claimJob,
  hasJob,
  releaseJob,
} from "../src/lib/meetings/job-registry.js";
import { SUMMARIZE_IS_STUB } from "../src/lib/meetings/workflow/nodes/summarize.js";
import {
  BOOT_PROBE_TRIES,
  type RunnerDeps,
  resumeInterruptedRuns,
  resumeRun,
  startRun,
  sweepOrphanRuns,
} from "../src/lib/meetings/workflow/runner.js";
import { WORKFLOW_GRAPH_VERSION } from "../src/lib/meetings/workflow/types.js";
import { insertOwnServer } from "../src/lib/own-servers.js";
import { okReply } from "./helpers/fake-model.js";
import { insertSpeaker } from "./helpers/meetings-db.js";
import {
  checkpointCount,
  defaultAnswer,
  isIdentify,
  type RunnerHarness,
  runnerHarness,
  runRow,
  runsOf,
  stepsOf,
  waitForNoJob,
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

type Stages = ("enhance" | "summarize")[];
const BOTH: Stages = ["enhance", "summarize"];

function seedMeeting(
  chunks: number,
  o: { speakers?: number; selfIntroduction?: boolean; id?: string } = {},
) {
  const f = seedFixtureMeeting({
    chunks,
    speakers: o.speakers ?? 1,
    meetingId: o.id ?? "m-res",
    ...(o.selfIntroduction ? { selfIntroduction: true } : {}),
  });
  sizeFixtureSegments(getDb(), f, 300);
  return f;
}

let triggerN = 0;

/**
 * Make the write of a channel fail while `body` runs. The graph then ends
 * with a saver fault and the checkpoint of the finished steps stays. `after`
 * is how many writes of the channel may succeed first.
 */
async function withSaverFault<T>(
  channel: string,
  after: number,
  body: () => Promise<T>,
): Promise<T> {
  const name = `fail_write_${triggerN++}`;
  getDb().exec(
    `CREATE TRIGGER ${name} BEFORE INSERT ON llm_checkpoint_writes
     WHEN NEW.channel = '${channel}'
       AND (SELECT count(*) FROM llm_checkpoint_writes
             WHERE thread_id = NEW.thread_id AND channel = '${channel}') >= ${after}
     BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
  );
  try {
    return await body();
  } finally {
    getDb().exec(`DROP TRIGGER ${name}`);
  }
}

/** Start a run that ends `interrupted` with a checkpoint. */
async function interrupt(
  meetingId: string,
  h: RunnerHarness,
  o: { stages?: Stages; channel?: string; after?: number } = {},
): Promise<string> {
  const stages = o.stages ?? BOTH;
  return withSaverFault(o.channel ?? "summary", o.after ?? 0, async () => {
    const s = startRun({ meetingId, stages, trigger: "button" }, h.deps);
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(meetingId);
    expect(runRow(s.runId).status).toBe("interrupted");
    return s.runId;
  });
}

function requestsFor(h: RunnerHarness, ids: readonly string[]): number {
  return h.requests.filter((r) => ids.some((id) => r.user.includes(`[${id}]`)))
    .length;
}

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

afterEach(() => {
  vi.restoreAllMocks();
  releaseJob("m-res");
});

describe("GR10: resume in process", () => {
  it("(a) correctChunk: a resume sends 0 new requests for the chunks that finished", async () => {
    const f = seedMeeting(6);
    const h = runnerHarness();
    // The write of the third chunk result fails: chunks 0 and 1 are saved.
    const runId = await interrupt(f.meeting.id, h, {
      stages: ["enhance"],
      channel: "corrections",
      after: 2,
    });
    const before = h.requests.length;
    expect(before).toBeGreaterThanOrEqual(3);
    expect(checkpointCount(runId)).toBeGreaterThan(0);

    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toEqual({ ok: true, runId });
    await waitForNoJob(f.meeting.id);

    const run = runRow(runId);
    expect(run.status).toBe("succeeded");
    expect(run.resume_count).toBe(1);
    expect(run.error_kind).toBeNull();
    // Chunks 0, 1 and 2 finished their call before the fault: 1 request each.
    for (const i of [0, 1, 2]) {
      expect(requestsFor(h, f.segmentIdsByChunk[i] ?? []), `chunk ${i}`).toBe(
        1,
      );
    }
    // The reducer keeps one entry for each chunk: every chunk is saved.
    const enhanced = getDb()
      .prepare(
        "SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = ? AND enhanced_text IS NOT NULL",
      )
      .get(f.meeting.id) as { n: number };
    expect(enhanced.n).toBe(6);
    expect(checkpointCount(runId)).toBe(0);
    const unitCalls = getDb()
      .prepare(
        `SELECT step_key, count(*) AS n FROM llm_calls
          WHERE run_id = ? AND node = 'correctChunk' AND error_kind IS NULL
          GROUP BY step_key HAVING count(*) > 1`,
      )
      .all(runId);
    expect(unitCalls).toEqual([]);
  });

  it("(b) identifySpeakers: a resume sends 0 new requests for a call that finished", async () => {
    const f = seedMeeting(3, { speakers: 3, selfIntroduction: true });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const h = runnerHarness({
      answer: (r) =>
        isIdentify(r)
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
          : defaultAnswer(r),
    });
    // The write of the identify result fails after the call finished.
    const runId = await interrupt(f.meeting.id, h, {
      stages: ["enhance"],
      channel: "identify",
      after: 0,
    });
    const identifyBefore = h.requests.filter(isIdentify).length;
    expect(identifyBefore).toBe(1);
    const total = h.requests.length;

    await resumeRun(f.meeting.id, runId, h.deps);
    await waitForNoJob(f.meeting.id);

    expect(h.requests).toHaveLength(total);
    expect(runRow(runId).status).toBe("succeeded");
    const row = getDb()
      .prepare(
        "SELECT suggested_name FROM meeting_speakers WHERE meeting_id = ? AND speaker_label = ?",
      )
      .get(f.meeting.id, intro?.speakerLabel as string) as {
      suggested_name: string;
    };
    expect(row.suggested_name).toBe("Morgan Ellis");
  });
});

describe("GR24: a kill between the stages resumes at summarize", () => {
  it("sends 0 new requests for the Enhance units, in the same run", async () => {
    const f = seedMeeting(3);
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h, { channel: "summary" });
    const sent = h.requests.length;
    // Three chunks, and the five summary calls when the real summarize node
    // runs (four extraction calls and the overview).
    expect(sent).toBe(SUMMARIZE_IS_STUB ? 3 : 8);
    // Enhance results are in the checkpoint, not yet saved.
    const row = getDb()
      .prepare(
        "SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = ? AND enhanced_text IS NOT NULL",
      )
      .get(f.meeting.id) as { n: number };
    expect(row.n).toBe(0);

    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res.ok).toBe(true);
    await waitForNoJob(f.meeting.id);

    expect(h.requests).toHaveLength(sent);
    expect(runsOf(f.meeting.id)).toHaveLength(1);
    expect(runRow(runId).status).toBe("succeeded");
    const after = getDb()
      .prepare(
        "SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = ? AND enhanced_text IS NOT NULL",
      )
      .get(f.meeting.id) as { n: number };
    expect(after.n).toBe(3);
  });
});

describe("a new run replaces an interrupted run of the same kind", () => {
  it("marks the older run cancelled and deletes its checkpoint", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const oldRun = await interrupt(f.meeting.id, h);
    expect(checkpointCount(oldRun)).toBeGreaterThan(0);

    const s = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    // The same transaction as the insert of the new row.
    expect(runRow(oldRun).status).toBe("cancelled");
    expect(checkpointCount(oldRun)).toBe(0);
    await waitForNoJob(f.meeting.id);
    expect(runRow(s.runId).status).toBe("succeeded");
  });
});

describe("GR11: one test for each resume guard", () => {
  it("unknown meeting and unknown run answer 404", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h);
    expect(await resumeRun("nope", runId, h.deps)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await resumeRun(f.meeting.id, "nope", h.deps)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("1: the meeting status is not transcribed or summarized", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h);
    getDb()
      .prepare("UPDATE meetings SET status = 'transcribing' WHERE id = ?")
      .run(f.meeting.id);
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: "meeting_status" },
    });
    expect(runRow(runId).status).toBe("interrupted");
    expect(checkpointCount(runId)).toBeGreaterThan(0);
  });

  it("2: a job holds the slot", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h);
    claimJob(f.meeting.id, "diarize", { done: 0, total: 0, failed: 0 });
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: "job_running" },
    });
    expect(runRow(runId).status).toBe("interrupted");
  });

  it("3: the run is not interrupted", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const s = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    const res = await resumeRun(f.meeting.id, s.runId, h.deps);
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: "not_interrupted" },
    });
    expect(runRow(s.runId).status).toBe("succeeded");
  });

  it("4: another graph version ends the run failed with graph_changed and deletes its checkpoint", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h);
    getDb()
      .prepare("UPDATE llm_runs SET graph_version = ? WHERE id = ?")
      .run(WORKFLOW_GRAPH_VERSION + 1, runId);
    const sent = h.requests.length;
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: "graph_changed" },
    });
    const run = runRow(runId);
    expect(run.status).toBe("failed");
    expect(run.error_kind).toBe("graph_changed");
    expect(checkpointCount(runId)).toBe(0);
    expect(h.requests).toHaveLength(sent);
  });

  it("5: no checkpoint leaves the run as it was", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h);
    getDb()
      .prepare("DELETE FROM llm_checkpoint_writes WHERE thread_id = ?")
      .run(runId);
    getDb()
      .prepare("DELETE FROM llm_checkpoints WHERE thread_id = ?")
      .run(runId);
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: "no_checkpoint" },
    });
    expect(runRow(runId).status).toBe("interrupted");
  });

  it("a fault while it loads the graph answers 500 and frees the slot", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h);
    const graphModule = await import("../src/lib/meetings/workflow/graph.js");
    vi.spyOn(graphModule, "buildGraph").mockImplementation(() => {
      throw new Error("graph load fault");
    });
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toMatchObject({
      ok: false,
      status: 500,
      error: "The run could not be resumed",
    });
    expect(hasJob(f.meeting.id)).toBe(false);
    expect(runRow(runId).status).toBe("interrupted");
  });

  it("6: a re-transcribe between kill and resume ends failed with transcript_changed and sends no request", async () => {
    const f = seedMeeting(3);
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h);
    const sent = h.requests.length;
    getDb()
      .prepare(
        "UPDATE meeting_segments SET text = text || ' again' WHERE id = ?",
      )
      .run(f.segmentIdsByChunk[0]?.[0] as string);
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: "transcript_changed" },
    });
    const run = runRow(runId);
    expect(run.status).toBe("failed");
    expect(run.error_kind).toBe("transcript_changed");
    expect(checkpointCount(runId)).toBe(0);
    expect(h.requests).toHaveLength(sent);
    // The job is free again.
    await expect(
      Promise.resolve(
        claimJob(f.meeting.id, "diarize", { done: 0, total: 0, failed: 0 }),
      ),
    ).resolves.toBe(true);
  });

  function confirmName(meetingId: string, label: string): void {
    insertSpeaker(meetingId, label, {
      displayName: "Morgan Ellis",
      confirmedAt: 1,
    });
  }

  it("a name confirmed while a Summarize run is stopped ends it with transcript_changed", async () => {
    const f = seedMeeting(2, { speakers: 2 });
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h, { stages: ["summarize"] });
    confirmName(f.meeting.id, "2");
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: "transcript_changed" },
    });
    expect(runRow(runId).status).toBe("failed");
  });

  it("a name confirmed while a chained run is stopped ends it with transcript_changed", async () => {
    const f = seedMeeting(2, { speakers: 2 });
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h, { stages: BOTH });
    confirmName(f.meeting.id, "2");
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      conflict: { reason: "transcript_changed" },
    });
  });

  it("a name confirmed while an Enhance-only run is stopped does not fail it", async () => {
    const f = seedMeeting(2, { speakers: 2 });
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h, {
      stages: ["enhance"],
      channel: "saved",
    });
    confirmName(f.meeting.id, "2");
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res).toEqual({ ok: true, runId });
    await waitForNoJob(f.meeting.id);
    expect(runRow(runId).status).toBe("succeeded");
  });
});

// --- GR12: boot sweep and boot resume -----------------------------------------

function insertCheckpoint(runId: string): void {
  getDb()
    .prepare(
      "INSERT INTO llm_checkpoints (thread_id, checkpoint_ns, checkpoint_id) VALUES (?, '', 'c1')",
    )
    .run(runId);
}

function newRunningRow(meetingId: string, id: string): void {
  const rec = createLlmRecorder(getDb());
  expect(
    rec.startRun({
      id,
      scope: "meeting",
      scopeId: meetingId,
      kind: "enhance",
      startedBy: "button",
      graphVersion: WORKFLOW_GRAPH_VERSION,
      startedAt: 1_760_000_000_000,
    }),
  ).toBe("ok");
  rec.startStep(id, { key: "chunk:0", node: "correctChunk" });
}

/** The state after a process death: the run was `running` with a checkpoint. */
function asKilled(runId: string, resumeCount = 0): void {
  getDb()
    .prepare(
      `UPDATE llm_runs SET status = 'running', error_kind = NULL, error_detail = NULL,
         finished_at = NULL, resume_count = ? WHERE id = ?`,
    )
    .run(resumeCount, runId);
}

describe("GR12: boot sweep", () => {
  it("a running run with a checkpoint becomes interrupted, one without becomes failed", () => {
    const f = seedMeeting(1);
    newRunningRow(f.meeting.id, "run-with");
    insertCheckpoint("run-with");
    newRunningRow(f.meeting.id, "run-without");
    const out = sweepOrphanRuns();
    // Synchronous: a plain object, not a promise.
    expect(out).toEqual({ interrupted: 1, failed: 1 });
    expect(runRow("run-with").status).toBe("interrupted");
    expect(runRow("run-with").error_kind).toBeNull();
    expect(stepsOf("run-with")[0]?.status).toBe("interrupted");
    const failed = runRow("run-without");
    expect(failed.status).toBe("failed");
    expect(failed.error_kind).toBe("interrupted_before_checkpoint");
    expect(stepsOf("run-without")[0]?.status).toBe("failed");
  });
});

describe("GR12: boot resume", () => {
  /** A run killed with a checkpoint, swept to interrupted with no failure. */
  async function killedRun(
    meetingId: string,
    h: RunnerHarness,
    resumeCount = 0,
  ): Promise<string> {
    const runId = await interrupt(meetingId, h);
    asKilled(runId, resumeCount);
    expect(sweepOrphanRuns().interrupted).toBe(1);
    expect(runRow(runId).error_kind).toBeNull();
    return runId;
  }

  it("resumes the run once, when the endpoint answers", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await killedRun(f.meeting.id, h);
    const sent = h.requests.length;
    const probe = vi.fn(async () => true);
    await resumeInterruptedRuns({ ...h.deps, probeEndpoint: probe });
    expect(probe).toHaveBeenCalledTimes(1);
    await waitForNoJob(f.meeting.id);
    const run = runRow(runId);
    expect(run.status).toBe("succeeded");
    expect(run.resume_count).toBe(1);
    expect(h.requests).toHaveLength(sent);
  });

  it("does not resume a run that already resumed once (a second crash)", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await killedRun(f.meeting.id, h, 1);
    const probe = vi.fn(async () => true);
    await resumeInterruptedRuns({ ...h.deps, probeEndpoint: probe });
    expect(probe).not.toHaveBeenCalled();
    expect(runRow(runId).status).toBe("interrupted");
    expect(runRow(runId).resume_count).toBe(1);
  });

  it("skips an interrupted run that has a failure (a graph error)", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await interrupt(f.meeting.id, h);
    expect(runRow(runId).error_kind).toBe("internal");
    const probe = vi.fn(async () => true);
    await resumeInterruptedRuns({ ...h.deps, probeEndpoint: probe });
    expect(probe).not.toHaveBeenCalled();
    expect(runRow(runId).status).toBe("interrupted");
  });

  it("with a server endpoint down it waits, does not count and leaves the run interrupted", async () => {
    const f = seedMeeting(2);
    // A server entry on a port where nothing listens: connections are refused.
    getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
    getDb().exec("DELETE FROM own_servers");
    const server = insertOwnServer({
      baseUrl: "http://127.0.0.1:4819",
      apiKey: null,
      flavor: "omlx",
    });
    const modelId = `server/${server.id}/Qwen3.8-27B`;
    getDb()
      .prepare(
        `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
         VALUES ('server', ?, ?, 'llm', 1)`,
      )
      .run(modelId, modelId);
    const h = runnerHarness();
    const runId = await killedRun(f.meeting.id, h);
    const sleeps: number[] = [];
    const deps: RunnerDeps = {
      ...h.deps,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
    // The real probe: GET http://127.0.0.1:4819/v1/models is refused 10 times.
    await resumeInterruptedRuns(deps);
    expect(sleeps).toHaveLength(BOOT_PROBE_TRIES - 1);
    expect(sleeps.every((ms) => ms === 15_000)).toBe(true);
    const run = runRow(runId);
    expect(run.status).toBe("interrupted");
    expect(run.resume_count).toBe(0);
  });

  it("with a cloud endpoint down it sends HEAD with no key and no body, then resumes when it answers", async () => {
    const f = seedMeeting(2);
    getDb()
      .prepare("INSERT OR REPLACE INTO api_keys (provider, key) VALUES (?, ?)")
      .run("openai", "test-key");
    getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
    getDb()
      .prepare(
        `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
         VALUES ('openai', 'openai/gpt-5-mini', 'openai/gpt-5-mini', 'llm', 1)`,
      )
      .run();
    const h = runnerHarness();
    const runId = await killedRun(f.meeting.id, h);
    const sent = h.requests.length;

    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let up = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), init });
        if (!up) throw new TypeError("fetch failed");
        return new Response("{}", { status: 404 });
      },
    );
    await resumeInterruptedRuns(h.deps);
    expect(calls).toHaveLength(BOOT_PROBE_TRIES);
    expect(runRow(runId).status).toBe("interrupted");
    expect(runRow(runId).resume_count).toBe(0);

    // An HTTP 404 means the endpoint is up: the probe passes and the run resumes.
    up = true;
    calls.length = 0;
    await resumeInterruptedRuns(h.deps);
    expect(calls).toHaveLength(1);
    await waitForNoJob(f.meeting.id);
    expect(runRow(runId).status).toBe("succeeded");
    expect(runRow(runId).resume_count).toBe(1);
    expect(h.requests).toHaveLength(sent);

    for (const c of calls) {
      expect(c.url).toBe("https://api.openai.com/v1");
      expect(c.init?.method).toBe("HEAD");
      expect(c.init?.body).toBeUndefined();
      const headers = new Headers(c.init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect([...headers.keys()]).toEqual([]);
    }
  });
});
