// The on-device engine is not ready (owner brief 2026-10-26, part D): a meeting
// run whose local model cannot start because the MLX worker update is not
// installed (`MlxRuntimeUpdatePendingError`, #341) ends with the typed state
// `engine_not_ready`, not `internal`, and starts again by itself when the
// engine is ready. Also: a full model pool maps to `model_unavailable`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine state is a switch of the test. The error class stays the real one.
const engine = { pending: true, downloads: 0 };
vi.mock("../src/lib/mlx-asr/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/runtime.js")>()),
  needsManagedMlxRuntimeUpdate: () => engine.pending,
  updateManagedMlxRuntimeIfNeeded: async () => {
    engine.downloads += 1;
    return engine.pending;
  },
}));
vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

import { getDb } from "../src/lib/db.js";
import {
  blankFacts,
  EngineNotReadyError,
  ModelUnavailableError,
  modelUnavailableFrom,
} from "../src/lib/llm/gateway-errors.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import {
  cancelEngineRetry,
  engineRetryWaiting,
  runEngineRetryTickForTest,
} from "../src/lib/meetings/workflow/engine-retry.js";
import { startRun } from "../src/lib/meetings/workflow/runner.js";
import { MlxWorkerStartError } from "../src/lib/mlx-asr/http-worker.js";
import { MlxRuntimeUpdatePendingError } from "../src/lib/mlx-asr/runtime.js";
import { MlxLlmPoolNoRoomError } from "../src/lib/mlx-llm/pool.js";
import {
  runnerHarness,
  runsOf,
  stepsOf,
  waitForNoJob,
  waitUntil,
} from "./helpers/runner-helpers.js";
import {
  resetWorkflowTables,
  seedFixtureMeeting,
  seedTestModel,
  sizeFixtureSegments,
} from "./helpers/workflow-harness.js";

const FACTS = blankFacts({
  step: "correctChunk",
  unitKey: "chunk:0",
  modelRequested: "local-mlx-llm/gemma-4-e2b-qat-4bit",
});

describe("modelUnavailableFrom: typed start errors of the local MLX LLM", () => {
  it("a pending runtime update is EngineNotReadyError, run-wide, with no retry advice", () => {
    const err = modelUnavailableFrom(
      new MlxRuntimeUpdatePendingError(
        "The MLX worker update is not installed (offline).",
      ),
      FACTS,
    );
    expect(err).toBeInstanceOf(EngineNotReadyError);
    const e = err as EngineNotReadyError;
    expect(e.kind).toBe("engine_not_ready");
    expect(e.runWide).toBe(true);
    expect(e.retry).toBeNull();
    expect(e.detail).toContain("not installed");
  });

  it("a full model pool is model_unavailable with reason not_enough_memory", () => {
    const err = modelUnavailableFrom(
      new MlxLlmPoolNoRoomError({
        modelId: "gemma-4-e4b-qat-4bit",
        neededBytes: 1,
        limitBytes: 0,
        blockers: ["gemma-4-e2b-qat-4bit"],
      }),
      FACTS,
    );
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).reason).toBe("not_enough_memory");
  });

  it("an unknown error stays unchanged (a bug, not a setup fault)", () => {
    const raw = new Error("boom");
    expect(modelUnavailableFrom(raw, FACTS)).toBe(raw);
  });
});

describe("a meeting run waits for the on-device engine and starts again", () => {
  const BOTH = ["enhance", "summarize"] as ("enhance" | "summarize")[];

  beforeEach(() => {
    resetWorkflowTables();
    __resetLlmLanesForTests();
    __clearModeCacheForTests();
    seedTestModel();
    engine.pending = true;
    engine.downloads = 0;
  });

  afterEach(() => {
    cancelEngineRetry("m-engine");
    vi.restoreAllMocks();
  });

  it("ends as engine_not_ready (0 requests), keeps waiting while the update fails, then runs", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 1,
      meetingId: "m-engine",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const ready = runnerHarness();
    // The local model start throws until the engine is ready.
    const h = runnerHarness({
      deps: {
        createModel: async (...args) => {
          if (engine.pending) {
            throw new MlxRuntimeUpdatePendingError(
              "The MLX worker update is not installed (fetch failed).",
            );
          }
          return ready.deps.createModel?.(...args) as never;
        },
      },
    });

    const s = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);

    const first = runsOf(f.meeting.id)[0];
    expect(first?.status).toBe("failed");
    expect(first?.error_kind).toBe("engine_not_ready");
    expect(
      stepsOf(s.runId).filter((st) => st.status === "failed")[0]?.error_kind,
    ).toBe("engine_not_ready");
    expect(ready.requests).toHaveLength(0);
    expect(engineRetryWaiting()).toEqual([f.meeting.id]);

    // The update still fails: no new run, the meeting still waits.
    await runEngineRetryTickForTest();
    expect(engine.downloads).toBe(1);
    expect(runsOf(f.meeting.id)).toHaveLength(1);
    expect(engineRetryWaiting()).toEqual([f.meeting.id]);

    // The engine is ready: the run starts again by itself and succeeds.
    engine.pending = false;
    await runEngineRetryTickForTest();
    expect(engineRetryWaiting()).toEqual([]);
    await waitUntil(() => runsOf(f.meeting.id).length === 2);
    await waitForNoJob(f.meeting.id);
    const runs = runsOf(f.meeting.id);
    expect(runs[1]?.started_by).toBe("auto");
    expect(runs[1]?.status).toBe("succeeded");
    expect(ready.requests.length).toBeGreaterThan(0);
  });

  it("a worker that exits before ready (old worker, unknown argument) ends the run at once: model_unavailable, no wait", async () => {
    const f = seedFixtureMeeting({
      chunks: 3,
      speakers: 1,
      meetingId: "m-engine",
    });
    sizeFixtureSegments(getDb(), f, 300);
    let starts = 0;
    const h = runnerHarness({
      deps: {
        createModel: async () => {
          starts += 1;
          throw new MlxWorkerStartError(
            "The local LLM worker exited before it was ready: exit code 2 (mlx_asr_worker: error: unrecognized arguments: --context-tokens 32768)",
          );
        },
      },
    });
    const s = startRun(
      { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    const run = runsOf(f.meeting.id)[0];
    expect(run?.status).toBe("failed");
    const failed = stepsOf(s.runId).filter((st) => st.status === "failed");
    expect(failed[0]?.error_kind).toBe("model_unavailable");
    // Run-wide: the first failure stops the run. Only the chunks that already
    // ran in parallel (fan-out) tried a start. No retry loop, no engine wait.
    expect(starts).toBeLessThanOrEqual(3);
    expect(engineRetryWaiting()).toEqual([]);
  });

  it("a new run of the meeting cancels the wait", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-engine",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const h = runnerHarness({
      deps: {
        createModel: async () => {
          throw new MlxRuntimeUpdatePendingError("pending");
        },
      },
    });
    const s = startRun(
      { meetingId: f.meeting.id, stages: ["enhance"], trigger: "button" },
      h.deps,
    );
    if (!s.ok) throw new Error("start failed");
    await waitForNoJob(f.meeting.id);
    expect(engineRetryWaiting()).toEqual([f.meeting.id]);
    const ok = runnerHarness();
    const again = startRun(
      { meetingId: f.meeting.id, stages: ["enhance"], trigger: "button" },
      ok.deps,
    );
    expect(again.ok).toBe(true);
    expect(engineRetryWaiting()).toEqual([]);
    await waitForNoJob(f.meeting.id);
  });
});
