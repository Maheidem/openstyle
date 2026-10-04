import { describe, expect, it } from "vitest";
import { stripModelPrefix } from "../src/lib/model-id.js";

describe("stripModelPrefix", () => {
  it("strips only the groq provider prefix", () => {
    expect(stripModelPrefix("groq", "groq/llama-3.1-8b-instant")).toBe(
      "llama-3.1-8b-instant",
    );
    expect(stripModelPrefix("groq", "groq/openai/gpt-oss-20b")).toBe(
      "openai/gpt-oss-20b",
    );
  });

  it("preserves nested vendor prefixes for Groq-hosted models", () => {
    expect(stripModelPrefix("groq", "openai/gpt-oss-20b")).toBe(
      "openai/gpt-oss-20b",
    );
    expect(stripModelPrefix("groq", "qwen/qwen3-32b")).toBe("qwen/qwen3-32b");
    expect(stripModelPrefix("groq", "mistral-saba-24b")).toBe(
      "mistral-saba-24b",
    );
  });

  it("uses the given provider id as the prefix", () => {
    expect(stripModelPrefix("openrouter", "openrouter/a/b")).toBe("a/b");
    expect(stripModelPrefix("openrouter", "groq/a")).toBe("groq/a");
  });
});
