import { describe, expect, it } from "vitest";
import type { MergedSegment } from "../src/lib/meetings/merge.js";
import {
  chunkTranscript,
  DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
  type SummaryLlmRequest,
  type SummaryLlmResponse,
  summarizeMeeting,
} from "../src/lib/meetings/summarize.js";

function seg(
  speaker: "Me" | "Them",
  text: string,
  startMs = 0,
  endMs = 1000,
): MergedSegment {
  return { speaker, startMs, endMs, text };
}

/** A fake LLM that records every request and returns canned responses. */
function fakeLlm(
  respond?: (
    request: SummaryLlmRequest,
    index: number,
  ) => Partial<SummaryLlmResponse>,
) {
  const requests: SummaryLlmRequest[] = [];
  const call = async (
    request: SummaryLlmRequest,
  ): Promise<SummaryLlmResponse> => {
    const index = requests.length;
    requests.push(request);
    return {
      text: `summary-${index}`,
      inputTokens: 0,
      outputTokens: 0,
      ...respond?.(request, index),
    };
  };
  return { requests, call };
}

const SHORT_TRANSCRIPT: MergedSegment[] = [
  seg("Me", "Hi, thanks for joining.", 0, 2000),
  seg("Them", "Of course. Let's talk about the launch date.", 2000, 5000),
  seg("Me", "We decided to ship on Friday.", 5000, 8000),
];

/** ~60 segments of ~100 chars each ≈ 1500+ estimated tokens. */
function longTranscript(count = 60): MergedSegment[] {
  return Array.from({ length: count }, (_, i) =>
    seg(
      i % 2 === 0 ? "Me" : "Them",
      `Segment number ${i} where we discuss project topic ${i} in a fair amount of spoken detail for the test.`,
      i * 1000,
      i * 1000 + 900,
    ),
  );
}

describe("summarizeMeeting", () => {
  it("uses a single pass when the transcript fits the budget", async () => {
    const llm = fakeLlm();
    const result = await summarizeMeeting(SHORT_TRANSCRIPT, {
      contextBudgetTokens: 8000,
      llmCall: llm.call,
    });

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].kind).toBe("single");
    expect(llm.requests[0].prompt).toContain("Me: Hi, thanks for joining.");
    expect(llm.requests[0].prompt).toContain(
      "Them: Of course. Let's talk about the launch date.",
    );
    expect(result.markdown).toBe("summary-0");
  });

  it("switches to map-reduce when the transcript exceeds the budget", async () => {
    const llm = fakeLlm();
    await summarizeMeeting(longTranscript(), {
      contextBudgetTokens: 300,
      llmCall: llm.call,
    });

    const kinds = llm.requests.map((r) => r.kind);
    expect(kinds.filter((k) => k === "map").length).toBeGreaterThanOrEqual(2);
    expect(kinds[kinds.length - 1]).toBe("reduce");
    expect(kinds).not.toContain("single");
  });

  it("chunks at segment boundaries with overlap", () => {
    const segments = longTranscript();
    const lines = segments.map((s) => `${s.speaker}: ${s.text}`);
    const chunks = chunkTranscript(segments, 300);

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Every chunk line is a whole segment line — never split mid-segment.
    const lineSet = new Set(lines);
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        expect(lineSet.has(line)).toBe(true);
      }
    }

    // Coverage: every segment appears in some chunk, in order.
    const joined = chunks.join("\n");
    for (const line of lines) {
      expect(joined).toContain(line);
    }

    // Overlap: each later chunk starts with the tail of the previous one.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1].split("\n");
      const head = chunks[i].split("\n")[0];
      expect(prev[prev.length - 1]).toBe(head);
    }
  });

  it("a single oversized segment still becomes its own chunk", () => {
    const big = seg("Me", "x".repeat(4000)); // ~1000 tokens > 300 budget
    const chunks = chunkTranscript([big, seg("Them", "ok")], 300);
    expect(chunks[0]).toContain("Me: " + "x".repeat(4000));
  });

  it("passes each partial summary to the combine call", async () => {
    const llm = fakeLlm((request, index) => ({
      text: request.kind === "map" ? `partial-${index}` : "final",
    }));
    const result = await summarizeMeeting(longTranscript(), {
      contextBudgetTokens: 300,
      llmCall: llm.call,
    });

    const mapCount = llm.requests.filter((r) => r.kind === "map").length;
    const reduce = llm.requests[llm.requests.length - 1];
    for (let i = 0; i < mapCount; i++) {
      expect(reduce.prompt).toContain(`partial-${i}`);
    }
    expect(result.markdown).toBe("final");
  });

  it("propagates an explicit maxOutputTokens to every call", async () => {
    const llm = fakeLlm();
    await summarizeMeeting(longTranscript(), {
      contextBudgetTokens: 300,
      maxOutputTokens: 777,
      llmCall: llm.call,
    });
    for (const request of llm.requests) {
      expect(request.maxOutputTokens).toBe(777);
    }
  });

  it("defaults maxOutputTokens to the summary default, not the input-scaled heuristic", async () => {
    const llm = fakeLlm();
    await summarizeMeeting(SHORT_TRANSCRIPT, {
      contextBudgetTokens: 8000,
      llmCall: llm.call,
    });
    expect(llm.requests[0].maxOutputTokens).toBe(
      DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
    );
  });

  it("aggregates usage and cost across map-reduce calls", async () => {
    const llm = fakeLlm(() => ({
      inputTokens: 100,
      outputTokens: 10,
      provider: "local-llm",
      model: "local-llm/test-model",
      pricing: { input: 0.000001, output: 0.000002 },
    }));
    const result = await summarizeMeeting(longTranscript(), {
      contextBudgetTokens: 300,
      llmCall: llm.call,
    });

    const calls = llm.requests.length;
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(result.inputTokens).toBe(100 * calls);
    expect(result.outputTokens).toBe(10 * calls);
    expect(result.llmProvider).toBe("local-llm");
    expect(result.llmModel).toBe("local-llm/test-model");
    expect(result.costUsd).toBeCloseTo(
      100 * calls * 0.000001 + 10 * calls * 0.000002,
      12,
    );
  });

  it("reports null cost when pricing is unavailable", async () => {
    const llm = fakeLlm(() => ({
      inputTokens: 5,
      outputTokens: 5,
      provider: "openai",
      model: "gpt-4o-mini",
    }));
    const result = await summarizeMeeting(SHORT_TRANSCRIPT, {
      contextBudgetTokens: 8000,
      llmCall: llm.call,
    });
    expect(result.costUsd).toBeNull();
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(5);
  });

  it("returns an empty result without calling the LLM for an empty transcript", async () => {
    const llm = fakeLlm();
    const result = await summarizeMeeting([seg("Me", "   ")], {
      contextBudgetTokens: 8000,
      llmCall: llm.call,
    });
    expect(llm.requests).toHaveLength(0);
    expect(result).toEqual({
      markdown: "",
      llmProvider: null,
      llmModel: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    });
  });
});
