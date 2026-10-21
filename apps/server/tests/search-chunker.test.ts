/**
 * The search chunker, the token estimate and the int8 step
 * (specs/local-semantic-search.md 4, 5.4, 12.1). Fictional text only.
 */
import { describe, expect, it } from "vitest";
import { EMBED_DOC_PROMPT } from "../src/lib/mlx-embed/constants.js";
import {
  buildChunks,
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  CHUNKER_VERSION,
  type ChunkSegment,
  estimateEmbedTokens,
  sha256Json,
  spanText,
} from "../src/lib/search/chunker.js";
import { quantizeInt8 } from "../src/lib/search/embedder.js";

/** A segment of about `tokens` estimated tokens (4 chars each). */
function seg(i: number, tokens: number, word = "word"): ChunkSegment {
  const unit = `${word}${i} `.padEnd(8, "x");
  return {
    id: `m:system:${i}`,
    text: unit
      .repeat(Math.max(1, Math.round((tokens * 4) / unit.length)))
      .trim(),
    startMs: i * 1000,
    endMs: i * 1000 + 900,
  };
}

describe("estimateEmbedTokens", () => {
  it("counts Latin text as 1 token per 4 characters", () => {
    expect(estimateEmbedTokens("abcd")).toBe(1);
    expect(estimateEmbedTokens("abcde")).toBe(2);
    expect(estimateEmbedTokens("a".repeat(400))).toBe(100);
  });
  it("counts CJK ideographs, kana and Hangul as 1 token each", () => {
    expect(estimateEmbedTokens("明日は会議です")).toBe(7);
    expect(estimateEmbedTokens("회의")).toBe(2);
    expect(estimateEmbedTokens("会議 ok")).toBe(2 + 1);
  });
});

describe("buildChunks", () => {
  it("joins whole segments up to 300 tokens and overlaps up to 45 tokens", () => {
    const segs = Array.from({ length: 30 }, (_, i) => seg(i, 40));
    const chunks = buildChunks(segs, "en");
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(c.charStart).toBe(0);
      expect(c.charEnd).toBeNull();
    }
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]?.segmentIds ?? [];
      const cur = chunks[i]?.segmentIds ?? [];
      const shared = cur.filter((id) => prev.includes(id));
      // One 40-token segment fits in the 45-token overlap; two do not.
      expect(shared).toHaveLength(1);
      expect(shared[0]).toBe(prev[prev.length - 1]);
    }
    // Every segment is in some chunk, in order.
    const seen = [...new Set(chunks.flatMap((c) => c.segmentIds))];
    expect(seen).toEqual(segs.map((s) => s.id));
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0]?.startMs).toBe(0);
  });

  it("keeps the first chunk at or below the target", () => {
    const chunks = buildChunks(
      Array.from({ length: 10 }, (_, i) => seg(i, 100)),
      "en",
    );
    expect(chunks[0]?.tokenEstimate).toBeLessThanOrEqual(
      CHUNK_TARGET_TOKENS + 2,
    );
  });

  it("joins a short tail chunk to the previous chunk", () => {
    const segs = [seg(0, 150), seg(1, 140), seg(2, 20)];
    const chunks = buildChunks(segs, "en");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.segmentIds).toEqual(segs.map((s) => s.id));
  });

  it("uses the enhanced text that the input gives and no speaker label", () => {
    const chunks = buildChunks(
      [{ id: "a", text: "The launch moves to Friday.", startMs: 0, endMs: 1 }],
      "en",
    );
    expect(chunks[0]?.text).toBe("The launch moves to Friday.");
  });

  it("gives no chunks for an empty meeting and skips blank segments", () => {
    expect(buildChunks([], "en")).toEqual([]);
    expect(
      buildChunks([{ id: "a", text: "   ", startMs: 0, endMs: 1 }], "en"),
    ).toEqual([]);
    expect(
      buildChunks(
        [
          { id: "", text: "no id", startMs: 0, endMs: 1 },
          { id: "b", text: "kept", startMs: 0, endMs: 1 },
        ],
        "en",
      ).map((c) => c.segmentIds),
    ).toEqual([["b"]]);
  });

  it.each([
    [
      "pt",
      "A Lívia disse que o projeto Aurora sai na sexta-feira. O Rafael concordou com a data. ",
    ],
    [
      "en",
      "Olivia said the Aurora project ships on Friday. Rafael agreed with the date. ",
    ],
    ["ja", "明日は会議です。資料を送ります。プロジェクトは金曜日に出ます。"],
  ])("splits a long %s segment by sentences with overlap", (lang, sentence) => {
    const text = sentence.repeat(60);
    const chunks = buildChunks(
      [{ id: "long", text, startMs: 0, endMs: 60_000 }],
      lang,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.segmentIds).toEqual(["long"]);
      expect(c.tokenEstimate).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(c.text).toBe(
        text.slice(c.charStart, c.charEnd ?? undefined).trim(),
      );
    }
    expect(chunks[0]?.charStart).toBe(0);
    expect(chunks[chunks.length - 1]?.charEnd).toBeNull();
    // Overlap: each piece starts before the previous one ends.
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1]?.charEnd ?? text.length;
      const start = chunks[i]?.charStart ?? 0;
      expect(start).toBeLessThan(prevEnd);
      expect(
        estimateEmbedTokens(text.slice(start, prevEnd)),
      ).toBeLessThanOrEqual(CHUNK_OVERLAP_TOKENS + 2);
    }
  });

  it("cuts a sentence above 400 tokens at word edges", () => {
    const text = "lorem ipsum ".repeat(300); // one sentence, about 900 tokens
    const chunks = buildChunks([{ id: "s", text, startMs: 0, endMs: 1 }], "en");
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(c.text.startsWith("lorem") || c.text.startsWith("ipsum")).toBe(
        true,
      );
    }
  });

  it("gives a stable text hash, and a CHUNKER_VERSION change changes every hash", () => {
    const segs = [seg(0, 30), seg(1, 30)];
    const a = buildChunks(segs, "en");
    const b = buildChunks(segs, "en");
    expect(a.map((c) => c.textHash)).toEqual(b.map((c) => c.textHash));
    for (const c of a) {
      expect(c.textHash).toBe(
        sha256Json([CHUNKER_VERSION, EMBED_DOC_PROMPT, c.text]),
      );
      expect(c.textHash).not.toBe(
        sha256Json([CHUNKER_VERSION + 1, EMBED_DOC_PROMPT, c.text]),
      );
    }
  });
});

describe("spanText", () => {
  it("cuts the first and last segment at the offsets", () => {
    expect(spanText(["abc def", "ghi jkl"], 4, 3)).toBe("def ghi");
    expect(spanText(["abcdef"], 2, 4)).toBe("cd");
    expect(spanText(["a", "b"], 0, null)).toBe("a b");
  });
});

describe("quantizeInt8", () => {
  it("gives clamp(round(x * 127)) on a unit vector", () => {
    const v = new Float32Array([0.6, -0.8, 0, 0]);
    expect([...quantizeInt8(v)]).toEqual([76, -102, 0, 0]);
  });
  it("gives +-127 at +-1", () => {
    expect([...quantizeInt8(new Float32Array([1, 0]))]).toEqual([127, 0]);
    expect([...quantizeInt8(new Float32Array([0, -1]))]).toEqual([0, -127]);
  });
  it("normalizes first, and refuses NaN", () => {
    expect([...quantizeInt8(new Float32Array([3, 4]))]).toEqual([76, 102]);
    expect(() => quantizeInt8(new Float32Array([Number.NaN, 1]))).toThrow(
      /NaN/,
    );
  });
});
