// The token estimate and the text split of the context guard
// (specs/llm-runtime-tuning.md 9 item 5). Fictional text only.
import { describe, expect, it } from "vitest";
import {
  CALL_OVERHEAD_TOKENS,
  contextWindowFor,
  estimateCallTokens,
  estimatePromptTokens,
  fitsWindow,
  MESSAGE_OVERHEAD_TOKENS,
  splitTextToFit,
} from "../src/lib/llm/token-budget.js";
import { joinCleanedPieces } from "../src/lib/post-process.js";

// Real token counts of these texts, the highest of the 5 catalog tokenizers
// (Gemma 4 E2B, E4B, 26B-A4B, Nemotron 3.5 Bolt E4B, Qwen3.8 27B), read with
// the `tokenizers` package on 2026-10-26.
const EN =
  "[s12] Me: Okay so the plan for the Riverside launch is that Dana owns the vendor list and we ship the beta on March 14th. ";
const ZH =
  "[s12] 我：好的，Riverside 发布的计划是由 Dana 负责供应商名单，我们在三月十四日发布测试版。";

describe("estimatePromptTokens", () => {
  it("weights ASCII 1/3, a digit 1, Latin and Cyrillic 1/2, CJK 0.8, Hangul 0.9", () => {
    expect(estimatePromptTokens("")).toBe(0);
    expect(estimatePromptTokens("abc")).toBe(1);
    expect(estimatePromptTokens("123")).toBe(3);
    expect(estimatePromptTokens("éé")).toBe(1);
    expect(estimatePromptTokens("привет")).toBe(3);
    expect(estimatePromptTokens("我们发布发布")).toBe(5);
    expect(estimatePromptTokens("한국어요")).toBe(4);
    expect(estimatePromptTokens("🎉")).toBe(2);
  });

  it("is over the real count for English and Chinese, where chars / 4 is under it", () => {
    // Real: 20 x EN = 681 tokens, 20 x ZH = 599 tokens (highest of the 5).
    const en = EN.repeat(20);
    expect(estimatePromptTokens(en)).toBeGreaterThan(681);
    expect(Math.ceil(en.length / 4)).toBeLessThan(681);
    const zh = ZH.repeat(20);
    expect(estimatePromptTokens(zh)).toBeGreaterThan(599);
    expect(Math.ceil(zh.length / 4)).toBeLessThan(599);
  });
});

describe("estimateCallTokens and fitsWindow", () => {
  it("adds the call and message overhead", () => {
    expect(
      estimateCallTokens({ instructions: "abc", messages: [{ content: "" }] }),
    ).toBe(CALL_OVERHEAD_TOKENS + 1 + MESSAGE_OVERHEAD_TOKENS);
  });

  it("prompt + max_tokens must be at or under the window; null always fits", () => {
    expect(fitsWindow(28_672, 4096, 32_768)).toBe(true);
    expect(fitsWindow(28_673, 4096, 32_768)).toBe(false);
    expect(fitsWindow(1_000_000, 4096, null)).toBe(true);
  });
});

describe("contextWindowFor", () => {
  it("reads the catalog of the local MLX LLM", () => {
    expect(contextWindowFor("local-mlx-llm", "gemma-4-e2b-qat-4bit")).toBe(
      32_768,
    );
    expect(
      contextWindowFor("local-mlx-llm", "local-mlx-llm/qwen3.8-27b-4bit"),
    ).toBe(32_768);
  });

  it("is null for an own server and a cold models.dev cache", () => {
    expect(contextWindowFor("server", "server/srv_1/m")).toBeNull();
    expect(contextWindowFor("openai", "openai/gpt-4o-mini")).toBeNull();
  });
});

describe("splitTextToFit", () => {
  const under = (n: number) => (p: string) => estimatePromptTokens(p) <= n;

  it("gives the text itself when it fits", () => {
    expect(splitTextToFit("one. two.", under(100))).toEqual(["one. two."]);
  });

  it("cuts at sentence ends; the pieces fit and join back to the text", () => {
    const text = EN.repeat(30).trim();
    const pieces = splitTextToFit(text, under(400));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(text);
    for (const p of pieces)
      expect(estimatePromptTokens(p)).toBeLessThanOrEqual(400);
    // Each cut is after a sentence end.
    for (const p of pieces.slice(0, -1)) expect(p).toMatch(/[.!?]\s+$/);
  });

  it("cuts at paragraph ends first", () => {
    const text = `${"a b c. ".repeat(40)}\n\n${"d e f. ".repeat(40)}`;
    const pieces = splitTextToFit(text, under(120));
    expect(pieces).toHaveLength(2);
    expect(pieces[0]?.endsWith("\n\n")).toBe(true);
  });

  it("cuts CJK text after 。 with no space", () => {
    const text = ZH.repeat(10);
    const pieces = splitTextToFit(text, under(150));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(text);
    for (const p of pieces.slice(0, -1)) expect(p.endsWith("。")).toBe(true);
  });

  it("cuts one long word in halves", () => {
    const pieces = splitTextToFit("x".repeat(90), under(10));
    expect(pieces.join("")).toBe("x".repeat(90));
    for (const p of pieces)
      expect(estimatePromptTokens(p)).toBeLessThanOrEqual(10);
  });
});

describe("joinCleanedPieces", () => {
  const ok = (cleaned: string) => ({
    cleaned,
    model: "m",
    inputTokens: 10,
    outputTokens: 5,
    error: null,
  });

  it("keeps a line break, turns a space into one space, adds nothing to CJK", () => {
    const r = joinCleanedPieces(
      ["one. ", "two.\n\n", "三。", "四。"],
      [ok("One."), ok("Two."), ok("三。"), ok("四。")],
    );
    expect(r.cleaned).toBe("One. Two.\n\n三。四。");
    expect(r.inputTokens).toBe(40);
    expect(r.outputTokens).toBe(20);
    expect(r.model).toBe("m");
  });

  it("a failed piece keeps its raw text; the model stays set when one piece worked", () => {
    const err = new Error("refused");
    const r = joinCleanedPieces(
      ["one. ", "two."],
      [
        {
          cleaned: "one.",
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          error: err,
        },
        ok("Two."),
      ],
    );
    expect(r.cleaned).toBe("one. Two.");
    expect(r.model).toBe("m");
    expect(r.error).toBe(err);
  });
});
