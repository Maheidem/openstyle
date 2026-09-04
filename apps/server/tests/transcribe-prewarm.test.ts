import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST /api/transcribe/pre-warm — the `cold` field (T1-3 / UX-01,
// specs/lean-audit-2026-09.md §3): the pill can only name the "warming up"
// wait when a model load is genuinely in flight, so the response must
// distinguish "spawn dispatched on a cold server" (warming + cold:true) from
// "already warm" (warming + cold:false). The spawn entry points and readiness
// probes are mocked so no real whisper/MLX process is ever started here.
// ---------------------------------------------------------------------------

const startInBackground = vi.fn();
const startMlxInBackground = vi.fn();

vi.mock("../src/lib/whisper/server.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/whisper/server.js")>();
  return {
    ...actual,
    isServerRunning: () => false,
    startInBackground: (...args: Parameters<typeof actual.startInBackground>) =>
      startInBackground(...args),
  };
});

vi.mock("../src/lib/whisper/binary.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/whisper/binary.js")>();
  return {
    ...actual,
    isServerBinaryAvailable: () => true,
  };
});

vi.mock("../src/lib/mlx-asr/server.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/mlx-asr/server.js")>();
  return {
    ...actual,
    // canRunMlxAsr is platform-gated in reality (Apple Silicon only), and
    // getDefaultModels() runs reconcileUnsupportedMlxVoiceDefault() — with
    // the real gate, a Linux CI runner rewrites the local-mlx default to
    // local-whisper *before* the route reads it, and this contract test
    // fails as warming: "whisper". The gate is incidental to what this
    // file asserts; pin it open like every other MLX seam here.
    canRunMlxAsr: () => true,
    isMlxServerRunning: () => false,
    startMlxInBackground: (
      ...args: Parameters<typeof actual.startMlxInBackground>
    ) => startMlxInBackground(...args),
  };
});

vi.mock("../src/lib/mlx-asr/models.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/mlx-asr/models.js")>();
  return {
    ...actual,
    getMlxModelStatus: () =>
      ({ status: "ready" }) as ReturnType<typeof actual.getMlxModelStatus>,
  };
});

import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";

const app = createApp();

function setDefaultVoiceModel(provider: string, modelId: string): void {
  getDb().exec("DELETE FROM model_configs WHERE type = 'voice'");
  getDb()
    .prepare(
      `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
       VALUES (?, ?, 'test model', 'voice', 1)`,
    )
    .run(provider, modelId);
}

beforeEach(() => {
  getDb().exec("DELETE FROM model_configs WHERE type = 'voice'");
  startInBackground.mockClear();
  startMlxInBackground.mockClear();
});

describe("POST /api/transcribe/pre-warm", () => {
  it("reports nothing to warm without a default voice model", async () => {
    const res = await app.request("/api/transcribe/pre-warm", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warming: null, cold: false });
    expect(startInBackground).not.toHaveBeenCalled();
    expect(startMlxInBackground).not.toHaveBeenCalled();
  });

  it("reports nothing to warm for a cloud provider", async () => {
    setDefaultVoiceModel("groq", "groq/whisper-large-v3-turbo");
    const res = await app.request("/api/transcribe/pre-warm", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warming: null, cold: false });
  });

  it("reports a cold whisper spawn when the server was not running", async () => {
    setDefaultVoiceModel("local-whisper", "local-whisper/base");
    const res = await app.request("/api/transcribe/pre-warm", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      warming: "whisper",
      cold: true,
    });
    expect(startInBackground).toHaveBeenCalledWith("base");
  });

  it("reports a cold mlx spawn when the worker was not running", async () => {
    setDefaultVoiceModel("local-mlx", "local-mlx/test-model");
    const res = await app.request("/api/transcribe/pre-warm", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warming: "mlx", cold: true });
    expect(startMlxInBackground).toHaveBeenCalledWith("test-model");
  });
});
