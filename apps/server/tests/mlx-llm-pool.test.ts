/**
 * The local LLM model pool (specs/llm-runtime-tuning.md section 6, owner
 * decision 2026-10-26): the admission rule (pure), and the pool in
 * mlx-llm/server.ts with a fake worker binary. One worker per model, the
 * memory budget with the MLX peak values, LRU eviction, the pinned dictation
 * model, busy workers, "Keep ready", and the typed no-room error.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { writeFakeLlmWorker } from "./helpers/fake-llm-worker.js";

vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));

import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { __resetLlmLanesForTests, withLlmLane } from "../src/lib/llm/lane.js";
import { hfRepoCacheDir } from "../src/lib/mlx-asr/constants.js";
import { MlxWorkerStartError } from "../src/lib/mlx-asr/http-worker.js";
import {
  GIB,
  getMlxLlmModel,
  MLX_LLM_PROVIDER_ID,
} from "../src/lib/mlx-llm/constants.js";
import { memoryBudgetBytes } from "../src/lib/mlx-llm/fit.js";
import {
  MlxLlmPoolNoRoomError,
  type PoolMember,
  planPoolStart,
} from "../src/lib/mlx-llm/pool.js";
import {
  ensureMlxLlmWorker,
  getMlxLlmPoolMemory,
  getMlxLlmPoolWorkers,
  getMlxLlmWorkerState,
  stopMlxLlmWorker,
  trackMlxLlmFetch,
} from "../src/lib/mlx-llm/server.js";
import { createChatModel } from "../src/lib/providers.js";

const E2B = "gemma-4-e2b-qat-4bit"; // P = 5.1 GiB
const E4B = "gemma-4-e4b-qat-4bit"; // P = 7.5 GiB
const BOLT = "nemotron-3.5-bolt-e4b-4bit"; // P = 6.0 GiB
const B26 = "gemma-4-26b-a4b-qat-4bit"; // P = 16.3 GiB

const member = (
  modelId: string,
  gib: number,
  extra: Partial<PoolMember> = {},
): PoolMember => ({
  modelId,
  peakBytes: gib * GIB,
  lastUsedAt: 0,
  busy: false,
  pinned: false,
  keepReady: false,
  ...extra,
});

describe("planPoolStart (section 6 item 3)", () => {
  it("starts with no eviction when the sum fits", () => {
    const plan = planPoolStart(
      [member("a", 5)],
      { modelId: "b", peakBytes: 7 * GIB },
      20 * GIB,
    );
    expect(plan).toEqual({ ok: true, evict: [] });
  });

  it("a model that is already loaded needs nothing (two tasks share one worker)", () => {
    const plan = planPoolStart(
      [member("a", 5), member("b", 30, { pinned: true })],
      { modelId: "a", peakBytes: 5 * GIB },
      10 * GIB,
    );
    expect(plan).toEqual({ ok: true, evict: [] });
  });

  it("evicts least recently used first, and only as many as needed", () => {
    const plan = planPoolStart(
      [
        member("new", 5, { lastUsedAt: 300 }),
        member("old", 5, { lastUsedAt: 100 }),
        member("mid", 5, { lastUsedAt: 200 }),
      ],
      { modelId: "x", peakBytes: 6 * GIB },
      17 * GIB,
    );
    // 5+5+5+6 = 21 > 17: stop "old" (16 <= 17).
    expect(plan).toEqual({ ok: true, evict: ["old"] });
  });

  it("evicts the Keep ready workers last, also when they are older", () => {
    const plan = planPoolStart(
      [
        member("ready-old", 5, { lastUsedAt: 1, keepReady: true }),
        member("plain-new", 5, { lastUsedAt: 9 }),
      ],
      { modelId: "x", peakBytes: 6 * GIB },
      12 * GIB,
    );
    expect(plan).toEqual({ ok: true, evict: ["plain-new"] });
    const both = planPoolStart(
      [
        member("ready-old", 5, { lastUsedAt: 1, keepReady: true }),
        member("plain-new", 5, { lastUsedAt: 9 }),
      ],
      { modelId: "x", peakBytes: 6 * GIB },
      6 * GIB,
    );
    expect(both).toEqual({ ok: true, evict: ["plain-new", "ready-old"] });
  });

  it("never evicts a pinned or a busy worker: the typed no-room result names them", () => {
    const plan = planPoolStart(
      [
        member("dictation", 5, { pinned: true }),
        member("summary", 16, { busy: true }),
        member("idle", 7),
      ],
      { modelId: "x", peakBytes: 8 * GIB },
      20 * GIB,
    );
    expect(plan).toEqual({
      ok: false,
      neededBytes: 29 * GIB,
      limitBytes: 20 * GIB,
      blockers: ["dictation", "summary"],
    });
  });

  it("a model alone over the limit still starts (the one-worker shape of a small Mac)", () => {
    const plan = planPoolStart(
      [member("idle", 5)],
      { modelId: "x", peakBytes: 9 * GIB },
      4 * GIB,
    );
    expect(plan).toEqual({ ok: true, evict: ["idle"] });
  });

  it("the no-room error is typed and has numbers, not user text", () => {
    const err = new MlxLlmPoolNoRoomError({
      modelId: "x",
      neededBytes: 29 * GIB,
      limitBytes: 20 * GIB,
      blockers: ["dictation"],
    });
    expect(err.code).toBe("llm-pool-no-room");
    expect(err.message).toContain("29.0 GiB needed, 20.0 GiB budget");
  });
});

// ---------------------------------------------------------------------------
// The pool with a fake worker
// ---------------------------------------------------------------------------

let scratch = "";
let workerLog = "";

function seedModel(id: string): void {
  const def = getMlxLlmModel(id);
  if (!def) throw new Error(id);
  const snap = join(hfRepoCacheDir(def.hfId), "snapshots", "abc123");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "config.json"), "{}");
  writeFileSync(join(snap, "model.safetensors"), "w");
}

function starts(): string[] {
  if (!existsSync(workerLog)) return [];
  return readFileSync(workerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { start?: boolean; args?: string[] })
    .filter((e) => e.start)
    .map((e) => e.args?.[(e.args?.indexOf("--model") ?? -2) + 1] ?? "");
}

function setDefaultLlm(modelId: string): void {
  getDb().prepare("DELETE FROM model_configs WHERE type = 'llm'").run();
  getDb()
    .prepare(
      "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, 'llm', 1)",
    )
    .run(MLX_LLM_PROVIDER_ID, `${MLX_LLM_PROVIDER_ID}/${modelId}`, modelId);
}

/** Task `task` uses the built-in `modelId` instead of the default. */
function overrideTask(task: string, modelId: string): void {
  writeSetting(
    "llm_task_assignments",
    JSON.stringify({
      [task]: {
        mode: "auto",
        modelOverride: {
          provider: MLX_LLM_PROVIDER_ID,
          model_id: `${MLX_LLM_PROVIDER_ID}/${modelId}`,
        },
      },
    }),
  );
}

/** Simulate a Mac with `gib` of RAM: the pool budget (no ASR worker) follows. */
function setRam(gib: number): void {
  process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB = String(gib);
}

beforeAll(() => {
  vi.useRealTimers();
  scratch = mkdtempSync(join(tmpdir(), "openstyle-mlx-pool-"));
  workerLog = join(scratch, "worker.log");
  process.env.HUGGINGFACE_HUB_CACHE = join(scratch, "hf");
  process.env.OPENSTYLE_MLX_LLM_WORKER = writeFakeLlmWorker(scratch);
  process.env.FAKE_LLM_LOG = workerLog;
  for (const id of [E2B, E4B, BOLT, B26]) seedModel(id);
});

afterEach(async () => {
  await stopMlxLlmWorker();
  delete process.env.FAKE_LLM_DELAY_MS;
  for (const key of [
    "llm_cleanup",
    "llm_task_assignments",
    "mlx_llm_keep_ready",
    "mlx_llm_keep_alive_minutes",
  ]) {
    deleteSetting(key);
  }
  getDb().prepare("DELETE FROM model_configs").run();
  rmSync(workerLog, { force: true });
});

afterAll(() => {
  delete process.env.HUGGINGFACE_HUB_CACHE;
  delete process.env.OPENSTYLE_MLX_LLM_WORKER;
  delete process.env.FAKE_LLM_LOG;
  delete process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB;
  rmSync(scratch, { recursive: true, force: true });
});

describe("the model pool with a fake worker", () => {
  it("the budget is RAM minus the OS reserve and the app (5.1 constants)", () => {
    setRam(32);
    expect(getMlxLlmPoolMemory()).toEqual({
      usedBytes: 0,
      limitBytes: memoryBudgetBytes(32 * GIB, false),
    });
    expect(memoryBudgetBytes(32 * GIB, false) / GIB).toBeCloseTo(
      32 - 4 - 1.65,
      6,
    );
  });

  it("the limit is the smaller of the budget and the GPU cap that the worker reports", async () => {
    delete process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB;
    process.env.OPENSTYLE_MLX_LLM_FIT_GPU_CAP_GIB = "";
    await ensureMlxLlmWorker(E2B);
    // The fake worker reports max_recommended_working_set_size = 100 GiB.
    const { totalmem } = await import("node:os");
    expect(getMlxLlmPoolMemory().limitBytes).toBe(
      Math.min(memoryBudgetBytes(totalmem(), false), 100 * GIB),
    );
    expect(getMlxLlmWorkerState(E2B).gpu?.maxRecommendedWorkingSetBytes).toBe(
      100 * GIB,
    );
  });

  it("two tasks with the same model share one worker", async () => {
    setRam(128);
    setDefaultLlm(E2B);
    await createChatModel(
      MLX_LLM_PROVIDER_ID,
      `${MLX_LLM_PROVIDER_ID}/${E2B}`,
      {
        task: "cleanup",
        sampling: {},
      },
    );
    await createChatModel(
      MLX_LLM_PROVIDER_ID,
      `${MLX_LLM_PROVIDER_ID}/${E2B}`,
      {
        task: "meetingSummarize",
        sampling: {},
      },
    );
    expect(starts()).toEqual(["mlx-community/gemma-4-E2B-it-qat-4bit"]);
    expect(getMlxLlmPoolWorkers().map((w) => w.model)).toEqual([E2B]);
  });

  it("a second model gets its own worker when it fits, and both stay ready", async () => {
    setRam(64);
    const a = await ensureMlxLlmWorker(E2B);
    const b = await ensureMlxLlmWorker(B26);
    expect(a.baseURL).not.toBe(b.baseURL);
    expect(getMlxLlmWorkerState(E2B).state).toBe("ready");
    expect(getMlxLlmWorkerState(B26).state).toBe("ready");
    expect(getMlxLlmPoolMemory().usedBytes).toBe(
      (getMlxLlmModel(E2B)?.peakBytes ?? 0) +
        (getMlxLlmModel(B26)?.peakBytes ?? 0),
    );
  });

  it("stops the least recently used worker when the new model does not fit", async () => {
    // 16 GiB: budget 16 - 3 - 1.65 = 11.35 GiB. E2B 5.1 + E4B 7.5 = 12.6.
    setRam(16);
    const a = await ensureMlxLlmWorker(E2B);
    await ensureMlxLlmWorker(E4B);
    expect(getMlxLlmWorkerState(E2B).state).toBe("stopped");
    expect(getMlxLlmWorkerState(E4B).state).toBe("ready");
    await expect(fetch(`${a.baseURL}/models`)).rejects.toThrow();
  });

  it("never stops the pinned dictation model: the start fails with MlxLlmPoolNoRoomError", async () => {
    setRam(16);
    setDefaultLlm(E2B);
    writeSetting("llm_cleanup", "true");
    await ensureMlxLlmWorker(E2B);
    await expect(ensureMlxLlmWorker(E4B)).rejects.toBeInstanceOf(
      MlxLlmPoolNoRoomError,
    );
    expect(getMlxLlmWorkerState(E2B).state).toBe("ready");
    expect(getMlxLlmWorkerState(E4B).state).toBe("stopped");
    expect(getMlxLlmPoolWorkers()).toMatchObject([
      { model: E2B, pinned: true, keepReadyTasks: ["cleanup"] },
    ]);
  });

  it("with dictation cleanup off, the same model is not pinned and can stop", async () => {
    setRam(16);
    setDefaultLlm(E2B);
    writeSetting("llm_cleanup", "false");
    writeSetting("mlx_llm_keep_ready", JSON.stringify({ cleanup: false }));
    await ensureMlxLlmWorker(E2B);
    await ensureMlxLlmWorker(E4B);
    expect(getMlxLlmWorkerState(E2B).state).toBe("stopped");
  });

  it("never stops a busy worker; the start works after the request ends", async () => {
    setRam(16);
    process.env.FAKE_LLM_DELAY_MS = "600";
    const a = await ensureMlxLlmWorker(E2B);
    const f = trackMlxLlmFetch(E2B, fetch);
    const inFlight = f(`${a.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    await new Promise((r) => setTimeout(r, 100));
    await expect(ensureMlxLlmWorker(E4B)).rejects.toMatchObject({
      code: "llm-pool-no-room",
      blockers: [E2B],
    });
    expect((await inFlight).status).toBe(200);
    await ensureMlxLlmWorker(E4B);
    expect(getMlxLlmWorkerState(E4B).state).toBe("ready");
    expect(getMlxLlmWorkerState(E2B).state).toBe("stopped");
  });

  it("stops a plain worker before a Keep ready worker, also when it is newer", async () => {
    // 24 GiB: budget 24 - 4 - 1.65 = 18.35. E2B 5.1 + Bolt 6.0 + E4B 7.5 = 18.6.
    setRam(24);
    setDefaultLlm(BOLT);
    overrideTask("meetingSummarize", E2B);
    writeSetting(
      "mlx_llm_keep_ready",
      JSON.stringify({ cleanup: false, meetingSummarize: true }),
    );
    await ensureMlxLlmWorker(E2B);
    await new Promise((r) => setTimeout(r, 5));
    await ensureMlxLlmWorker(BOLT);
    await ensureMlxLlmWorker(E4B);
    expect(getMlxLlmWorkerState(E2B).state).toBe("ready");
    expect(getMlxLlmWorkerState(BOLT).state).toBe("stopped");
    expect(getMlxLlmWorkerState(E4B).state).toBe("ready");
  });

  it("a Keep ready model stays loaded after its request; a plain one unloads (keep-alive 0)", async () => {
    setRam(128);
    setDefaultLlm(E2B);
    overrideTask("meetingSummarize", E4B);
    writeSetting("mlx_llm_keep_alive_minutes", "0");
    writeSetting(
      "mlx_llm_keep_ready",
      JSON.stringify({ cleanup: true, meetingSummarize: false }),
    );
    for (const id of [E2B, E4B]) {
      const { baseURL } = await ensureMlxLlmWorker(id);
      const f = trackMlxLlmFetch(id, fetch);
      await (
        await f(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "x", messages: [] }),
        })
      ).text();
    }
    expect(getMlxLlmWorkerState(E2B).state).toBe("ready");
    expect(getMlxLlmWorkerState(E4B).state).toBe("stopped");
  });

  it("each worker has its own lane: a call on one model does not wait behind another model", async () => {
    __resetLlmLanesForTests();
    let releaseSummary: () => void = () => {};
    const summary = withLlmLane(
      MLX_LLM_PROVIDER_ID,
      `${MLX_LLM_PROVIDER_ID}/${B26}`,
      { cls: "interactive", taskId: "meetingSummarize" },
      () => new Promise<void>((r) => (releaseSummary = r)),
    );
    // The dictation model answers while the Summarize call holds its lane.
    const order: string[] = [];
    await withLlmLane(
      MLX_LLM_PROVIDER_ID,
      `${MLX_LLM_PROVIDER_ID}/${E2B}`,
      { cls: "interactive", taskId: "cleanup" },
      async () => {
        order.push("cleanup");
      },
    );
    // The same model still has one slot: a second call waits.
    const second = withLlmLane(
      MLX_LLM_PROVIDER_ID,
      `${MLX_LLM_PROVIDER_ID}/${B26}`,
      { cls: "interactive", taskId: "meetingEnhance" },
      async () => {
        order.push("enhance");
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["cleanup"]);
    releaseSummary();
    await summary;
    await second;
    expect(order).toEqual(["cleanup", "enhance"]);
  });

  it("an old worker that exits at start on an unknown argument fails at once with a typed error", async () => {
    // The shipped 2.23.0 worker does not know --context-tokens: argparse
    // prints "unrecognized arguments" and exits 2 before the ready line.
    const old = join(scratch, "old-worker");
    writeFileSync(
      old,
      `#!/bin/sh\necho "mlx_asr_worker: error: unrecognized arguments: --context-tokens 32768" >&2\nexit 2\n`,
    );
    const { chmodSync } = await import("node:fs");
    chmodSync(old, 0o755);
    const saved = process.env.OPENSTYLE_MLX_LLM_WORKER;
    process.env.OPENSTYLE_MLX_LLM_WORKER = old;
    try {
      const t0 = Date.now();
      const err = await ensureMlxLlmWorker(E2B).catch((e: unknown) => e);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(err).toBeInstanceOf(MlxWorkerStartError);
      expect((err as MlxWorkerStartError).code).toBe("worker-start-failed");
      expect(String((err as Error).message)).toContain(
        "unrecognized arguments",
      );
      expect(getMlxLlmWorkerState(E2B).state).toBe("error");
    } finally {
      process.env.OPENSTYLE_MLX_LLM_WORKER = saved;
    }
  });

  it("stopMlxLlmWorker(model) stops only that worker", async () => {
    setRam(128);
    await ensureMlxLlmWorker(E2B);
    await ensureMlxLlmWorker(E4B);
    await stopMlxLlmWorker(E4B);
    expect(getMlxLlmWorkerState(E2B).state).toBe("ready");
    expect(getMlxLlmWorkerState(E4B).state).toBe("stopped");
  });
});
