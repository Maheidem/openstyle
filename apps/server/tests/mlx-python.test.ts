import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

let workDir = "";

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

interface FakeLogger {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function fakeLogger(): FakeLogger {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

/**
 * Imports a fresh copy of python.ts with `createAppLogger` replaced so the
 * trusted-operator-escape-hatch warnings can be asserted on directly.
 */
async function importPython(): Promise<{
  python: typeof import("../src/lib/mlx-asr/python.js");
  log: FakeLogger;
}> {
  const log = fakeLogger();
  vi.doMock("@openstyle/utils", () => ({
    createAppLogger: () => log,
    enableFileLogging: vi.fn(),
    traceLog: vi.fn(),
  }));

  const python = await import("../src/lib/mlx-asr/python.js");
  return { python, log };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openstyle-mlx-python-"));
  delete process.env.OPENSTYLE_MLX_ASR_WORKER;
  delete process.env.FREESTYLE_MLX_ASR_WORKER;
  delete process.env.OPENSTYLE_MLX_ASR_SCRIPT;
  delete process.env.FREESTYLE_MLX_ASR_SCRIPT;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@openstyle/utils");
  restoreEnv();
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe("MLX ASR worker/script path env overrides", () => {
  it("warns loudly and uses the operator-supplied binary when OPENSTYLE_MLX_ASR_WORKER is set", async () => {
    const workerPath = join(workDir, "custom-worker");
    writeFileSync(workerPath, "fake binary");
    process.env.OPENSTYLE_MLX_ASR_WORKER = workerPath;

    const { python, log } = await importPython();

    expect(python.getMlxAsrWorkerPath()).toBe(workerPath);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("OPENSTYLE_MLX_ASR_WORKER"),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(workerPath));
  });

  it("does not warn when OPENSTYLE_MLX_ASR_WORKER is unset", async () => {
    const { python, log } = await importPython();

    python.getMlxAsrWorkerPath();

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("only warns once per process even if the path is resolved repeatedly (result is cached)", async () => {
    const workerPath = join(workDir, "custom-worker");
    writeFileSync(workerPath, "fake binary");
    process.env.OPENSTYLE_MLX_ASR_WORKER = workerPath;

    const { python, log } = await importPython();

    python.getMlxAsrWorkerPath();
    python.getMlxAsrWorkerPath();
    python.getMlxAsrWorkerPath();

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("warns loudly and uses the operator-supplied script when OPENSTYLE_MLX_ASR_SCRIPT is set", async () => {
    const scriptPath = join(workDir, "custom_script.py");
    writeFileSync(scriptPath, "# fake script");
    process.env.OPENSTYLE_MLX_ASR_SCRIPT = scriptPath;

    const { python, log } = await importPython();

    expect(python.getMlxAsrServerScriptPath()).toBe(scriptPath);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("OPENSTYLE_MLX_ASR_SCRIPT"),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(scriptPath));
  });

  it("does not warn when OPENSTYLE_MLX_ASR_SCRIPT is unset", async () => {
    const { python, log } = await importPython();

    python.getMlxAsrServerScriptPath();

    expect(log.warn).not.toHaveBeenCalled();
  });
});
