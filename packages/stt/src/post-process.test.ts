import { describe, expect, it, vi } from "vitest";
import { postProcess } from "./post-process.js";

function fakeModel(doGenerate: (opts?: unknown) => unknown) {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "fake-model",
    doGenerate,
  } as never;
}

// Provider spec v3 result. `generateText` flattens `unified` onto the result
// as a plain string.
function textResult(
  text: string,
  finishReason = { unified: "stop", raw: "stop" },
  usage = { inputTokens: { total: 5 }, outputTokens: { total: 7 } },
) {
  return {
    content: [{ type: "text", text }],
    finishReason,
    usage,
    warnings: [],
  };
}

describe("postProcess", () => {
  it("short-circuits filler-only text without calling the model", async () => {
    const doGenerate = vi.fn(() => {
      throw new Error("should not be called");
    });
    const result = await postProcess({
      model: fakeModel(doGenerate),
      system: "irrelevant — never reached",
      text: "um uh, you know...",
    });
    expect(result).toEqual({
      cleaned: "",
      model: null,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(doGenerate).not.toHaveBeenCalled();
  });

  it("does not short-circuit filler-only text when skipEmptyText is false", async () => {
    const doGenerate = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await postProcess({
      model: fakeModel(doGenerate),
      system: "irrelevant",
      text: "um uh",
      skipEmptyText: false,
    });
    expect(doGenerate).toHaveBeenCalled();
    // Falls back to sanitized raw text since the fake model throws.
    expect(result.cleaned).toBe("um uh");
  });

  it("falls back to sanitized raw text when the model call throws", async () => {
    const result = await postProcess({
      model: fakeModel(async () => {
        throw new Error("boom");
      }),
      system: "irrelevant — model throws before using it",
      text: '"hello there"',
    });
    expect(result.model).toBeNull();
    expect(result.cleaned).toBe("hello there");
  });

  it("takes the caller's system/prompt verbatim (no built-in tone or preset logic)", async () => {
    const doGenerate = vi.fn(async (_opts?: unknown) =>
      textResult("Ahoy there"),
    );
    const result = await postProcess({
      model: fakeModel(doGenerate),
      system: "You are a pirate. Rewrite everything in pirate speak.",
      prompt: "Ahoy, edit this: hello there",
      text: "hello there",
    });
    expect(result.cleaned).toBe("Ahoy there");
    // The model gets the caller's system and user prompts as they are.
    expect(JSON.stringify(doGenerate.mock.calls[0]?.[0])).toContain(
      "You are a pirate. Rewrite everything in pirate speak.",
    );
    expect(JSON.stringify(doGenerate.mock.calls[0]?.[0])).toContain(
      "Ahoy, edit this: hello there",
    );
  });

  it("calls onError with the raw error before falling back, without throwing", async () => {
    const boom = new Error("boom");
    const onError = vi.fn();
    const result = await postProcess({
      model: fakeModel(async () => {
        throw boom;
      }),
      system: "irrelevant",
      text: "hello there",
      onError,
    });
    expect(onError).toHaveBeenCalledWith(boom);
    expect(result.model).toBeNull();
    expect(result.cleaned).toBe("hello there");
  });

  // Reproduced against a live oMLX server: with thinking on and a token budget
  // scaled off the input, generation is cut off mid-reasoning, the parser never
  // sees the closing `</think>`, and the raw chain-of-thought is flushed into
  // `content` with no tag left for the sanitizer to catch. `finishReason` is
  // the only reliable signal, so this must keep failing loudly if removed.
  it("discards truncated output and returns the raw transcript", async () => {
    const onError = vi.fn();
    const model = fakeModel(async () =>
      textResult(
        "The user wants me to clean up a dictated transcript. I need to fix grammar, punctuation, and remove filler words. Let me identify the core message: they were thinking about whether line breaks and n",
        { unified: "length", raw: "length" },
        { inputTokens: { total: 120 }, outputTokens: { total: 60 } },
      ),
    );
    const result = await postProcess({
      model,
      system: "irrelevant",
      text: "so um i was thinking about whether the line breaks should be preserved",
      onError,
    });
    expect(result.cleaned).toBe(
      "so um i was thinking about whether the line breaks should be preserved",
    );
    expect(result.cleaned).not.toContain("The user wants me to");
    expect(result.model).toBeNull();
    // Usage that actually occurred is still reported.
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(60);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain("length");
  });

  it("returns the raw transcript when output sanitizes away to nothing", async () => {
    const model = fakeModel(async () =>
      textResult("<think>only reasoning, no answer"),
    );
    const result = await postProcess({
      model,
      system: "irrelevant",
      text: "hello there",
    });
    expect(result.cleaned).toBe("hello there");
    expect(result.model).toBeNull();
  });

  it("strips a leaked reasoning block from otherwise good output", async () => {
    const model = fakeModel(async () =>
      textResult("<think>Fix the punctuation.</think>Hello there."),
    );
    const result = await postProcess({
      model,
      system: "irrelevant",
      text: "hello there",
    });
    expect(result.cleaned).toBe("Hello there.");
    expect(result.model).toBe("fake-model");
  });

  it("never calls onError when the model call succeeds", async () => {
    const onError = vi.fn();
    const model = fakeModel(async () => textResult("cleaned output"));
    const result = await postProcess({
      model,
      system: "irrelevant",
      text: "hello there",
      onError,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.model).toBe("fake-model");
    expect(result.cleaned).toBe("cleaned output");
  });
});
