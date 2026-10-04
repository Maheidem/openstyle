import { describe, expect, it } from "vitest";
import { addCustomMlxModelSchema, mlxSearchQuerySchema } from "./models.js";

describe("addCustomMlxModelSchema", () => {
  it("trims the model text", () => {
    expect(addCustomMlxModelSchema.parse({ model: "  org/name  " })).toEqual({
      model: "org/name",
    });
  });

  it("rejects an empty or blank model", () => {
    expect(addCustomMlxModelSchema.safeParse({ model: "" }).success).toBe(
      false,
    );
    expect(addCustomMlxModelSchema.safeParse({ model: "   " }).success).toBe(
      false,
    );
    expect(addCustomMlxModelSchema.safeParse({}).success).toBe(false);
  });

  it("accepts 300 characters and rejects 301", () => {
    expect(
      addCustomMlxModelSchema.safeParse({ model: "a".repeat(300) }).success,
    ).toBe(true);
    expect(
      addCustomMlxModelSchema.safeParse({ model: "a".repeat(301) }).success,
    ).toBe(false);
  });
});

describe("mlxSearchQuerySchema", () => {
  it("allows a missing q and trims a given q", () => {
    expect(mlxSearchQuerySchema.parse({})).toEqual({});
    expect(mlxSearchQuerySchema.parse({ q: " qwen3 " })).toEqual({
      q: "qwen3",
    });
  });

  it("accepts 100 characters and rejects 101", () => {
    expect(mlxSearchQuerySchema.safeParse({ q: "a".repeat(100) }).success).toBe(
      true,
    );
    expect(mlxSearchQuerySchema.safeParse({ q: "a".repeat(101) }).success).toBe(
      false,
    );
  });
});
