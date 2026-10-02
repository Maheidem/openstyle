import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// MLX needs Apple Silicon and Python, so fake its status. Only
// "sensevoice-small" is ready. The catalog helper stays real.
vi.mock("../src/lib/mlx-asr/models.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/mlx-asr/models.js")>();
  return {
    ...actual,
    getMlxModelStatus: (id: string) => {
      const state = actual.getMlxModelStatus(id);
      if (!state) return state;
      return {
        ...state,
        status: id === "sensevoice-small" ? "ready" : "error",
      };
    },
  };
});
const ORIGINAL_HOME = process.env.HOME;
let homeDir = "";

interface Entry {
  provider_id: string;
  provider_name: string;
  model_id: string;
  model_name: string;
  family: string;
  type: string;
  cost_input?: number;
  cost_output?: number;
  curated?: boolean;
}

/** Make a sparse file that passes the 95 percent size check. */
function seedWhisperFile(fileName: string, sizeBytes: number): void {
  const dir = join(homeDir, ".cache", "freestyle", "whisper-models");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, "");
  truncateSync(path, sizeBytes);
}

describe("GET /api/models/available local voice entries", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openstyle-models-home-"));
    process.env.HOME = homeDir;
    // Registry and local servers must fail fast. Voice entries do not need them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    process.env.HOME = ORIGINAL_HOME;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("lists only ready local models, curated first, with the same fields", async () => {
    // A curated model and a legacy model, both on disk.
    seedWhisperFile("ggml-base-q5_1.bin", 57_000_000);
    seedWhisperFile("ggml-tiny.bin", 75_000_000);

    const { default: createApp } = await import("../src/index.js");
    const res = await createApp().request("/api/models/available");
    expect(res.status).toBe(200);

    const local = ((await res.json()) as Entry[]).filter(
      (m) => m.provider_id === "local-whisper" || m.provider_id === "local-mlx",
    );

    expect(local).toEqual([
      {
        provider_id: "local-whisper",
        provider_name: "Local Whisper",
        model_id: "local-whisper/base-q5_1",
        model_name: "Whisper Fast",
        family: "whisper-local",
        type: "voice",
        cost_input: 0,
        cost_output: 0,
        curated: true,
      },
      {
        provider_id: "local-whisper",
        provider_name: "Local Whisper",
        model_id: "local-whisper/tiny",
        model_name: "Whisper Tiny",
        family: "whisper-local",
        type: "voice",
        cost_input: 0,
        cost_output: 0,
        curated: true,
      },
      expect.objectContaining({
        provider_id: "local-mlx",
        model_id: "local-mlx/sensevoice-small",
        model_name: "SenseVoice",
        family: "sensevoice",
        type: "voice",
        cost_input: 0,
        cost_output: 0,
        curated: true,
      }),
    ]);
  });
});
