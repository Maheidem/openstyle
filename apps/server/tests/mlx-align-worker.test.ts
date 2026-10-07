/**
 * I4b (specs/meeting-transcription-v2.md §3.6): the aligner worker
 * contract (`align` message → `aligned` response) and the helper-model
 * rule (resolvable by the worker, never in the ASR picker).
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake aligner worker: reads one JSON line from stdin, answers the
// "align" message with an "aligned" response (or an error), and never
// understands "transcribe" (the aligner is not an ASR model).
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

vi.mock("../src/lib/mlx-asr/python.js", () => ({
  canRunMlxAsr: () => true,
  describeMlxSetupBlocker: () => null,
  findPythonExecutable: () => null,
  getMlxAsrServerScriptPath: () => null,
  getMlxAsrWorkerPath: () => process.execPath,
  isMlxAudioInstalled: () => false,
}));

vi.mock("../src/lib/mlx-asr/runtime.js", () => ({
  isManagedMlxRuntimeAvailable: () => false,
  markManagedMlxRuntimeSyncedForAppVersion: () => {},
  mlxAsrReleaseTagOverride: () => null,
  updateManagedMlxRuntimeIfNeeded: async () => {},
}));

import {
  getMlxAsrModel,
  MLX_ALIGNER_MODEL_ID,
} from "../src/lib/mlx-asr/constants.js";
import { getMlxCatalogModels } from "../src/lib/mlx-asr/models.js";
import {
  alignWithMlxAsr,
  ensureMlxServerRunning,
  stopMlxServer,
} from "../src/lib/mlx-asr/server.js";

let lastPayload: Record<string, unknown> | null = null;

function fakeAlignerWorker() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      write: (data: string, cb?: () => void) => {
        for (const line of data.split("\n")) {
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.type === "ready-ping") {
            cb?.();
            continue;
          }
          if (msg.type === "align") {
            lastPayload = msg;
            proc.stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({
                  id: msg.id,
                  type: "aligned",
                  words: [
                    { text: "right", start: 0.16, end: 0.32 },
                    { text: "so", start: 0.32, end: 0.48 },
                  ],
                })}\n`,
              ),
            );
            cb?.();
            continue;
          }
          if (msg.type === "shutdown") {
            cb?.();
            return;
          }
          // The aligner is not an ASR model: "transcribe" must be an error.
          proc.stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({ id: msg.id, error: "not an aligner" })}\n`,
            ),
          );
          cb?.();
        }
      },
      end: () => {},
    },
    kill: () => {
      proc.emit("close", 0);
    },
  });
  Promise.resolve().then(() => {
    proc.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
  });
  return proc;
}

beforeEach(() => {
  lastPayload = null;
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(fakeAlignerWorker);
});

afterEach(async () => {
  await stopMlxServer();
});

describe("worker align message contract (I4b, §3.6 step 2)", () => {
  it("alignWithMlxAsr sends {id, type: align, wav, text, language} and returns the words", async () => {
    await ensureMlxServerRunning(MLX_ALIGNER_MODEL_ID);
    const words = await alignWithMlxAsr({
      audio: new Uint8Array([0, 1, 2, 3]),
      text: "Right so",
      language: "English",
    });
    expect(lastPayload).not.toBeNull();
    expect(lastPayload!.type).toBe("align");
    expect(lastPayload!.text).toBe("Right so");
    expect(lastPayload!.language).toBe("English");
    expect(typeof lastPayload!.id).toBe("number");
    // The audio is written as a WAV file the worker reads from disk.
    expect(String(lastPayload!.audio_path).endsWith(".wav")).toBe(true);
    expect(words).toEqual([
      { text: "right", start: 0.16, end: 0.32 },
      { text: "so", start: 0.32, end: 0.48 },
    ]);
  });

  it("a worker error rejects the promise with the worker's message", async () => {
    // A fake ASR worker (not the aligner) answers "transcribe" fine but
    // "align" with an error — alignWithMlxAsr must reject, not hang.
    await stopMlxServer();
    mocks.spawn.mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: {
          write: (data: string, cb?: () => void) => {
            for (const line of data.split("\n")) {
              if (!line.trim()) continue;
              const msg = JSON.parse(line) as Record<string, unknown>;
              if (msg.type === "shutdown") {
                cb?.();
                return;
              }
              proc.stdout.emit(
                "data",
                Buffer.from(
                  `${JSON.stringify({
                    id: msg.id,
                    error: "generate(): expected an aligner model",
                  })}\n`,
                ),
              );
              cb?.();
            }
          },
          end: () => {},
        },
        kill: () => {
          proc.emit("close", 0);
        },
      });
      Promise.resolve().then(() => {
        proc.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      return proc;
    });
    await expect(
      alignWithMlxAsr({
        audio: new Uint8Array([0, 1, 2, 3]),
        text: "hi",
        language: "English",
        timeoutMs: 2000,
      }),
    ).rejects.toThrow("expected an aligner model");
  });

  it("the align call times out at the 10 s default path (short timeout here)", async () => {
    vi.useRealTimers();
    // A worker that answers "align" with nothing: the request must time
    // out (the pipeline's fallback triggers on the rejection).
    await stopMlxServer();
    mocks.spawn.mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: {
          write: (_data: string, cb?: () => void) => {
            cb?.();
          },
          end: () => {},
        },
        kill: () => {
          proc.emit("close", 0);
        },
      });
      Promise.resolve().then(() => {
        proc.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      return proc;
    });
    await expect(
      alignWithMlxAsr({
        audio: new Uint8Array([0, 1]),
        text: "hi",
        language: "English",
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/);
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
});

describe("helper model picker rule (I4b, §3.6 step 1)", () => {
  it("is resolvable by getMlxAsrModel but never in the ASR picker", () => {
    const def = getMlxAsrModel(MLX_ALIGNER_MODEL_ID);
    expect(def).not.toBeNull();
    expect(def?.hfId).toBe("mlx-community/Qwen3-ForcedAligner-0.6B-8bit");
    // The catalog (what the pickers and /status modelDefinitions list)
    // must not offer it as a transcription model.
    const catalog = getMlxCatalogModels();
    expect(catalog.map((m) => m.id)).not.toContain(MLX_ALIGNER_MODEL_ID);
  });
});
