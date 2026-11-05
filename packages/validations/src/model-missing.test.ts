import { describe, expect, it } from "vitest";
import {
  formatModelMissingDetail,
  parseModelMissingDetail,
} from "./model-missing.js";

describe("model missing detail", () => {
  it("reads back the model that it wrote", () => {
    const ref = {
      engine: "mlx-llm",
      defId: "gemma-4-e2b-qat-4bit",
      name: "Gemma 4 E2B",
    } as const;
    expect(parseModelMissingDetail(formatModelMissingDetail(ref))).toEqual(ref);
  });

  it("keeps a bar inside the name", () => {
    const ref = { engine: "mlx", defId: "a", name: "A | B" } as const;
    expect(parseModelMissingDetail(formatModelMissingDetail(ref))).toEqual(ref);
  });

  it("returns null for other text", () => {
    expect(parseModelMissingDetail(null)).toBeNull();
    expect(
      parseModelMissingDetail("TypeError: x is not a function"),
    ).toBeNull();
    expect(parseModelMissingDetail("model_missing|nope|id|Name")).toBeNull();
    expect(parseModelMissingDetail("model_missing|mlx|id")).toBeNull();
  });
});
