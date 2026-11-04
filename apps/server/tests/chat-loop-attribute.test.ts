// Code-owned citations (owner decision 2026-11-04): the best block above the
// threshold is the cite. All text is fictional.

import { describe, expect, it } from "vitest";
import { attributeCites } from "../src/lib/chat/loop/attribute.js";
import { SourceMap } from "../src/lib/chat/types.js";

const base = {
  kind: "transcript" as const,
  meetingId: "m1",
  title: "Alpha sync",
  startedAt: 0,
  startMs: 0,
  endMs: 1000,
  itemId: null,
};

function map(texts: string[]) {
  const sources = new SourceMap();
  const list = texts.map((text) => sources.add({ ...base, text }));
  return { sources, list };
}

describe("attributeCites", () => {
  it("takes the best block above the threshold and leaves the rest uncited", async () => {
    const { sources, list } = map([
      "The vendor contract is signed by Maria.",
      "Lunch is at noon.",
    ]);
    const sentences = [
      { text: "Maria signed the vendor contract.", cites: [] as string[] },
      { text: "The moon is made of cheese.", cites: [] as string[] },
    ];
    const rank = async (q: string, docs: string[]) =>
      docs.map((d) =>
        q.includes("Maria") && d.includes("Maria") ? 0.95 : 0.05,
      );
    const stats = await attributeCites(sentences, list, sources, rank, {
      min: 0.5,
    });
    expect(sentences[0]?.cites).toEqual(["S1"]);
    expect(sentences[1]?.cites).toEqual([]);
    expect(stats).toMatchObject({ cited: 1, uncited: 1, reranked: true });
  });

  it("scores each segment of a hit and adds a second block that is nearly as good", async () => {
    const sources = new SourceMap();
    const a = sources.add({ ...base, text: "Ann: one\nBob: two" });
    sources.segments.set(a.label, [
      { startMs: 0, text: "one" },
      { startMs: 1000, text: "two" },
    ]);
    const b = sources.add({ ...base, startMs: 5000, text: "Other text" });
    const sentences = [{ text: "A fact.", cites: [] as string[] }];
    const rank = async (_q: string, docs: string[]) =>
      docs.map((d) =>
        d === "Bob: two" ? 0.9 : d === "Other text" ? 0.85 : 0.1,
      );
    await attributeCites(sentences, [a, b], sources, rank, {
      min: 0.5,
      max: 2,
      mix: 0,
      spoken: 0,
    });
    expect(sentences[0]?.cites).toEqual([a.label, b.label]);
  });

  it("uses the share of the words when there is no reranker", async () => {
    const { sources, list } = map(["The review is on December fourth."]);
    const sentences = [
      { text: "The review is on December fourth.", cites: [] as string[] },
      {
        text: "Completely different words appear here.",
        cites: [] as string[],
      },
    ];
    const stats = await attributeCites(sentences, list, sources, null);
    expect(sentences[0]?.cites).toEqual(["S1"]);
    expect(sentences[1]?.cites).toEqual([]);
    expect(stats.reranked).toBe(false);
  });
});
