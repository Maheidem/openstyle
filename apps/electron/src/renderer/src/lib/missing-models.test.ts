import type { MissingModel } from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import {
  missingForTask,
  missingForTasks,
  modelsPathFor,
  parseMissingParam,
} from "./missing-models";

const gemma: MissingModel = {
  engine: "mlx-llm",
  defId: "gemma-4-e2b-qat-4bit",
  name: "Gemma 4 E2B",
  tasks: ["cleanup", "meetingEnhance"],
};
const asr: MissingModel = {
  engine: "mlx",
  defId: "qwen3-1.7b-8bit",
  name: "Qwen3 ASR",
  tasks: ["dictation"],
};

describe("missing models helpers", () => {
  it("builds the Models link and reads it back", () => {
    const path = modelsPathFor(gemma);
    expect(path).toBe(
      "/settings/models?missing=mlx-llm%3Agemma-4-e2b-qat-4bit",
    );
    const param = new URL(`app://x${path}`).searchParams.get("missing");
    expect(parseMissingParam(param)).toEqual({
      engine: "mlx-llm",
      defId: "gemma-4-e2b-qat-4bit",
    });
    expect(parseMissingParam(null)).toBeNull();
    expect(parseMissingParam("nocolon")).toBeNull();
  });

  it("picks the models of the asked tasks", () => {
    expect(missingForTasks([gemma, asr], ["meetingEnhance"])).toEqual([gemma]);
    expect(missingForTasks([gemma, asr], ["dictation", "cleanup"])).toEqual([
      gemma,
      asr,
    ]);
    expect(missingForTasks(undefined, ["ask"])).toEqual([]);
    expect(missingForTask([gemma, asr], "dictation")).toEqual(asr);
    expect(missingForTask([gemma], "ask")).toBeUndefined();
  });
});
