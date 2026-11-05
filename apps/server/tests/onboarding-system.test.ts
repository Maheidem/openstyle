/**
 * The server parts of the onboarding (specs/onboarding.md): the reconcile step
 * keeps an MLX voice default on a Mac that can install the worker, the Qwen3
 * language list reaches the status, and GET /api/system/profile.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  appleSilicon: true,
  installable: true,
  canRun: false,
}));

vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => state.appleSilicon,
}));
vi.mock("../src/lib/mlx-asr/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/runtime.js")>()),
  isMlxRuntimeInstallable: () => state.installable,
  isManagedMlxRuntimeAvailable: () => false,
}));
vi.mock("../src/lib/mlx-asr/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/server.js")>()),
  canRunMlxAsr: () => state.canRun,
  stopMlxServer: async () => {},
}));

import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { qwen3LanguageCodes } from "../src/lib/mlx-asr/language.js";
import { reconcileUnsupportedMlxVoiceDefault } from "../src/lib/mlx-asr/reconcile.js";
import {
  computeVoiceFit,
  parseRamRequiredBytes,
} from "../src/lib/mlx-llm/fit.js";

function setDefaultVoice(provider: string, modelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM model_configs WHERE type = 'voice'").run();
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES (?, ?, 'x', 'voice', 1)`,
  ).run(provider, modelId);
}

function defaultVoiceProvider(): string | undefined {
  return (
    getDb()
      .prepare(
        "SELECT provider FROM model_configs WHERE type = 'voice' AND is_default = 1",
      )
      .get() as { provider: string } | undefined
  )?.provider;
}

beforeEach(() => {
  state.appleSilicon = true;
  state.installable = true;
  state.canRun = false;
});

describe("reconcileUnsupportedMlxVoiceDefault", () => {
  it("keeps the MLX default when the worker is installable but not installed", () => {
    setDefaultVoice("local-mlx", "local-mlx/qwen3-0.6b-8bit");
    expect(reconcileUnsupportedMlxVoiceDefault()).toBe(false);
    expect(defaultVoiceProvider()).toBe("local-mlx");
  });

  it("keeps the MLX default when MLX runs", () => {
    state.installable = false;
    state.canRun = true;
    setDefaultVoice("local-mlx", "local-mlx/qwen3-0.6b-8bit");
    expect(reconcileUnsupportedMlxVoiceDefault()).toBe(false);
    expect(defaultVoiceProvider()).toBe("local-mlx");
  });

  it("switches to Whisper when MLX cannot run and cannot be installed", () => {
    state.appleSilicon = false;
    state.installable = false;
    setDefaultVoice("local-mlx", "local-mlx/qwen3-0.6b-8bit");
    expect(reconcileUnsupportedMlxVoiceDefault()).toBe(true);
    expect(defaultVoiceProvider()).toBe("local-whisper");
  });
});

describe("Qwen3 languages", () => {
  it("lists the app codes of the Qwen3 set", () => {
    const codes = qwen3LanguageCodes();
    for (const code of ["en", "pt", "es", "de", "fr", "ja", "zh", "nl"]) {
      expect(codes).toContain(code);
    }
    // Ukrainian and Norwegian are not in the Qwen3 set of the server.
    expect(codes).not.toContain("uk");
    expect(codes).not.toContain("no");
  });

  it("is in GET /api/mlx-asr/status for the Qwen3 models only", async () => {
    const app = createApp();
    const res = await app.request("/api/mlx-asr/status");
    const body = (await res.json()) as {
      modelDefinitions: { id: string; family: string; languages?: string[] }[];
    };
    const qwen = body.modelDefinitions.find((m) => m.id === "qwen3-0.6b-8bit");
    expect(qwen?.languages).toEqual(qwen3LanguageCodes());
    const parakeet = body.modelDefinitions.find((m) => m.family === "parakeet");
    expect(parakeet?.languages).toBeUndefined();
  });
});

describe("voice fit and the system profile", () => {
  it("parses the RAM text of the catalog", () => {
    expect(parseRamRequiredBytes("~1.5 GB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseRamRequiredBytes("none")).toBeNull();
  });

  it("gives a worse label on a small Mac", () => {
    const GIB = 1024 ** 3;
    expect(computeVoiceFit("~3 GB", 8 * GIB)).not.toBe("runs_well");
    expect(computeVoiceFit("~1.5 GB", 32 * GIB)).toBe("runs_well");
    expect(computeVoiceFit("~6 GB", 8 * GIB)).toBe("wont_fit");
  });

  it("answers GET /api/system/profile", async () => {
    const app = createApp();
    const res = await app.request("/api/system/profile");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      appleSilicon: boolean;
      ramBytes: number;
      freeDiskBytes: number | null;
      mlxWorkerBytes: number;
      voiceFit: Record<string, string>;
    };
    expect(body.appleSilicon).toBe(true);
    expect(body.ramBytes).toBeGreaterThan(0);
    expect(body.mlxWorkerBytes).toBe(174_000_000);
    expect(body.voiceFit["local-whisper/small-q5_1"]).toBeTruthy();
    expect(body.voiceFit["local-mlx/qwen3-0.6b-8bit"]).toBeTruthy();
  });
});
