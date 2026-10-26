// A cleanup model that does not start is an engine problem: the person gets
// the raw text with the dictionary applied, never an error. Fictional text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("@openstyle/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openstyle/utils")>();
  return {
    ...actual,
    createAppLogger: (name: string) => {
      const real = actual.createAppLogger(name);
      return name === "post-process" ? { ...real, warn } : real;
    },
  };
});

const startError = vi.fn<() => Error | null>(() => null);
vi.mock("../src/lib/providers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/providers.js")>();
  return {
    ...actual,
    createChatModel: async (
      ...args: Parameters<typeof actual.createChatModel>
    ) => {
      const err = startError();
      if (err) throw err;
      return actual.createChatModel(...args);
    },
  };
});

const { getDb, deleteSetting, writeSetting } = await import("../src/lib/db.js");
const { postProcess } = await import("../src/lib/post-process.js");
const { MlxRuntimeUpdatePendingError } = await import(
  "../src/lib/mlx-asr/runtime.js"
);

beforeEach(() => {
  warn.mockClear();
  deleteSetting("llm_task_assignments");
  writeSetting("llm_cleanup", "true");
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES ('local-mlx-llm', 'local-mlx-llm/gemma-4-e2b-qat-4bit', 'Gemma 4 E2B', 'llm', 1)`,
  ).run();
  db.exec("DELETE FROM dictionary");
  db.prepare("INSERT INTO dictionary (key, value) VALUES (?, ?)").run(
    "tacoma depot",
    "Tacoma Depot",
  );
});

afterEach(() => {
  startError.mockReset();
  startError.mockImplementation(() => null);
  getDb().exec("DELETE FROM dictionary");
});

describe("cleanup when the model does not start", () => {
  it("gives the raw text with the dictionary applied and logs one warn line", async () => {
    startError.mockImplementation(
      () =>
        new MlxRuntimeUpdatePendingError(
          "The MLX worker update is not installed (offline). The old worker does not start.",
        ),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const r = await postProcess(
      "the riverside team ships the beta adapter to the tacoma depot on friday",
      null,
    );

    expect(r).toMatchObject({
      cleaned:
        "the riverside team ships the beta adapter to the Tacoma Depot on friday",
      llmProvider: null,
      llmModel: null,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "LLM cleanup skipped: the model local-mlx-llm/gemma-4-e2b-qat-4bit did not start; the raw text is kept: The MLX worker update is not installed (offline). The old worker does not start.",
    );
    fetchSpy.mockRestore();
  });
});
