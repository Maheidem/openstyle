import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake worker process. It answers "ready" unless a test makes it exit.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  exitCode: null as number | null,
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

import { getDb } from "../src/lib/db.js";
import { insertCustomModel } from "../src/lib/mlx-asr/custom-models.js";
import {
  ensureMlxServerRunning,
  stopMlxServer,
} from "../src/lib/mlx-asr/server.js";

function fakeWorker() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      write: (_data: string, cb?: () => void) => cb?.(),
      end: () => {},
    },
    kill: () => {
      proc.emit("close", 0);
    },
  });
  Promise.resolve().then(() => {
    if (mocks.exitCode === null) {
      proc.stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    } else {
      proc.emit("close", mocks.exitCode);
    }
  });
  return proc;
}

function spawnedEnv(): NodeJS.ProcessEnv {
  const options = mocks.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
  return options.env;
}

beforeEach(() => {
  mocks.exitCode = null;
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(fakeWorker);
  getDb().exec("DELETE FROM custom_mlx_models");
  insertCustomModel({
    hfId: "someone/whisper-tiny",
    family: "whisper",
    modelType: "whisper",
    totalBytes: 10,
    revision: "r",
    files: [],
  });
});

afterEach(async () => {
  await stopMlxServer();
  vi.unstubAllEnvs();
});

describe("worker launch for a custom model", () => {
  it("sets HF_HUB_OFFLINE=1 and passes the repo id", async () => {
    await ensureMlxServerRunning("custom--someone--whisper-tiny");

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual([
      "--model",
      "someone/whisper-tiny",
    ]);
    expect(spawnedEnv().HF_HUB_OFFLINE).toBe("1");
  });

  it("does not set HF_HUB_OFFLINE for a curated model", async () => {
    vi.stubEnv("HF_HUB_OFFLINE", "");

    await ensureMlxServerRunning("sensevoice-small");

    expect(spawnedEnv().HF_HUB_OFFLINE).toBe("");
  });

  it("gives a clear load error when the worker exits while loading", async () => {
    mocks.exitCode = 1;

    await expect(
      ensureMlxServerRunning("custom--someone--whisper-tiny"),
    ).rejects.toThrow(
      /Could not load the custom model someone\/whisper-tiny\. Its files may be incomplete\. Delete it and add it again\./,
    );
  });

  it("keeps the plain error for a curated model", async () => {
    mocks.exitCode = 1;

    await expect(ensureMlxServerRunning("sensevoice-small")).rejects.toThrow(
      /^mlx-asr worker exited unexpectedly: exit code 1$/,
    );
  });
});
