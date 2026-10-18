// What is left of the old Summarize tests after WP5b deleted `summarize.ts`,
// `summary-prompt.ts` and `llm-call.ts` (specs/meeting-enhance-agentic.md
// 11.5): the transcript chunker that the `summarize` node still uses. The
// summarize calls, prompts and cost moved to `workflow-summarize.test.ts`
// (WP6). The list of each deleted test and its successor is in the PR body.
import { describe, expect, it } from "vitest";
import type { MergedSegment } from "../src/lib/meetings/merge.js";
import { chunkTranscript } from "../src/lib/meetings/workflow/chunking.js";

function seg(
  speaker: "Me" | "Them",
  text: string,
  startMs = 0,
  endMs = 1000,
): MergedSegment {
  return { speaker, startMs, endMs, text };
}

/** ~60 segments of ~100 chars each, about 1500 estimated tokens. */
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

// specs/meeting-speaker-naming.md 9.1: the line label rule is reached through
// chunkTranscript, which formats every line through it.
describe("line label resolution (via chunkTranscript)", () => {
  it("renders a confirmed speakerName instead of the numbered fallback", () => {
    const segments: MergedSegment[] = [
      {
        speaker: "Them",
        startMs: 0,
        endMs: 1000,
        text: "hello",
        speakerLabel: "2",
        speakerName: "Ana",
      },
    ];
    const [chunk] = chunkTranscript(segments, 8000);
    expect(chunk).toBe("Ana: hello");
  });

  it("renders 'Them N' for a speakerLabel with no confirmed name", () => {
    const segments: MergedSegment[] = [
      {
        speaker: "Them",
        startMs: 0,
        endMs: 1000,
        text: "hello",
        speakerLabel: "2",
      },
    ];
    const [chunk] = chunkTranscript(segments, 8000);
    expect(chunk).toBe("Them 2: hello");
  });

  it('renders the literal "Unidentified" for a Them segment with no label and no name', () => {
    const segments: MergedSegment[] = [
      { speaker: "Them", startMs: 0, endMs: 1000, text: "hello" },
    ];
    const [chunk] = chunkTranscript(segments, 8000);
    expect(chunk).toBe("Unidentified: hello");
  });
});

describe("chunkTranscript", () => {
  it("chunks at segment boundaries with overlap", () => {
    const segments = longTranscript();
    const lines = segments.map(
      (s) => `${s.speaker === "Them" ? "Unidentified" : s.speaker}: ${s.text}`,
    );
    const chunks = chunkTranscript(segments, 300);

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Every chunk line is a whole segment line, never split mid-segment.
    const lineSet = new Set(lines);
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        expect(lineSet.has(line)).toBe(true);
      }
    }

    // Coverage: every segment appears in some chunk.
    const joined = chunks.join("\n");
    for (const line of lines) {
      expect(joined).toContain(line);
    }

    // Overlap: each later chunk starts with the tail of the previous one.
    for (let i = 1; i < chunks.length; i++) {
      const prev = (chunks[i - 1] as string).split("\n");
      const head = (chunks[i] as string).split("\n")[0];
      expect(prev[prev.length - 1]).toBe(head);
    }
  });

  it("a single oversized segment still becomes its own chunk", () => {
    const big = seg("Me", "x".repeat(4000)); // about 1000 tokens, over the 300 budget
    const chunks = chunkTranscript([big, seg("Them", "ok")], 300);
    expect(chunks[0]).toContain(`Me: ${"x".repeat(4000)}`);
  });

  it("renders enhancedText when present, else text", () => {
    const segments: MergedSegment[] = [
      {
        speaker: "Me",
        startMs: 0,
        endMs: 1000,
        text: "raw words",
        enhancedText: "enhanced words",
      },
      { speaker: "Me", startMs: 1000, endMs: 2000, text: "raw only" },
    ];
    const [chunk] = chunkTranscript(segments, 8000);
    expect(chunk).toBe("Me: enhanced words\nMe: raw only");
  });

  it("mixes enhanced and raw lines in one chunk", () => {
    const segments: MergedSegment[] = [
      seg("Me", "raw words"),
      {
        speaker: "Them",
        startMs: 1000,
        endMs: 2000,
        text: "raw them",
        enhancedText: "enhanced them",
      },
    ];
    const [chunk] = chunkTranscript(segments, 8000);
    expect(chunk).toContain("Me: raw words");
    expect(chunk).toContain("enhanced them");
    expect(chunk).not.toContain("raw them");
  });
});
