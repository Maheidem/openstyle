import { describe, expect, it } from "vitest";
import {
  filterConsecutiveRepeats,
  formatTranscriptMarkdown,
  isHallucination,
  isVocabLeak,
  mergeTranscript,
  type SyncData,
  type TranscriptSegment,
  textSimilarity,
} from "../src/lib/meetings/merge.js";

function seg(
  startMs: number,
  endMs: number,
  text: string,
  speakerLabel?: string,
): TranscriptSegment {
  return { startMs, endMs, text, ...(speakerLabel ? { speakerLabel } : {}) };
}

describe("mergeTranscript", () => {
  it("interleaves channels ordered by startMs with speaker labels", () => {
    const mic = [
      seg(0, 2000, "hello there"),
      seg(8000, 9000, "sounds good to me"),
    ];
    const system = [seg(3000, 6000, "hi, how are you doing today?")];
    const merged = mergeTranscript(mic, system);

    expect(merged.map((m) => [m.speaker, m.text])).toEqual([
      ["Me", "hello there"],
      ["Them", "hi, how are you doing today?"],
      ["Me", "sounds good to me"],
    ]);
  });

  it("drops the mic copy of an echoed system segment (Them wins)", () => {
    const mic = [
      seg(1000, 3000, "Let's review the quarterly numbers together."),
      seg(10_000, 11_000, "sure, that works for me"),
    ];
    const system = [
      seg(1400, 3400, "let's review the quarterly numbers together"),
    ];
    const merged = mergeTranscript(mic, system);

    expect(merged).toHaveLength(2);
    expect(merged[0].speaker).toBe("Them");
    expect(merged[1]).toMatchObject({
      speaker: "Me",
      text: "sure, that works for me",
    });
  });

  it("keeps a mic segment overlapping a dissimilar system segment", () => {
    const mic = [seg(1000, 3000, "I totally disagree with that plan")];
    const system = [seg(1200, 3200, "the weather has been great this week")];
    const merged = mergeTranscript(mic, system);
    expect(merged).toHaveLength(2);
  });

  it("keeps a similar mic segment outside the ±1 s echo window", () => {
    const mic = [
      seg(10_000, 12_000, "let's review the quarterly numbers together"),
    ];
    const system = [
      seg(1000, 3000, "let's review the quarterly numbers together"),
    ];
    const merged = mergeTranscript(mic, system);
    expect(merged).toHaveLength(2);
  });

  it("filters silence hallucinations from both channels", () => {
    const mic = [
      seg(0, 500, "Thank you."),
      seg(1000, 3000, "here is the actual agenda for today"),
    ];
    const system = [
      seg(500, 900, "Thanks for watching!"),
      seg(1500, 1900, "Subtitles by the Amara.org community"),
    ];
    const merged = mergeTranscript(mic, system);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("here is the actual agenda for today");
  });

  it("collapses same-channel runs of >=3 identical segments to the first", () => {
    const mic = [
      seg(0, 1000, "Okay, okay, okay."),
      seg(1000, 2000, "okay okay okay"),
      seg(2000, 3000, "Okay okay okay!"),
      seg(4000, 5000, "moving on to the next topic now"),
    ];
    const merged = mergeTranscript(mic, []);
    expect(merged.map((m) => m.startMs)).toEqual([0, 4000]);
  });

  it("keeps a pair of identical segments (run of 2 is below the threshold)", () => {
    const mic = [
      seg(0, 1000, "can you hear me alright over there"),
      seg(1000, 2000, "can you hear me alright over there"),
    ];
    expect(mergeTranscript(mic, [])).toHaveLength(2);
  });

  it("applies linear drift correction when implied delta exceeds 500 ms", () => {
    // System channel's clock started 2 s after mic and drifts none.
    const sync: SyncData = {
      sampleRate: 16_000,
      epochs: [
        { channel: "mic", t0WallclockMs: 100_000 },
        { channel: "system", t0WallclockMs: 102_000 },
      ],
      syncMarkers: [
        { channel: "mic", wallclockMs: 160_000, totalSamples: 60 * 16_000 },
        { channel: "system", wallclockMs: 162_000, totalSamples: 60 * 16_000 },
      ],
    };
    const mic = [seg(0, 1000, "starting the call now")];
    const system = [seg(0, 1000, "joining, sorry i am late")];
    const merged = mergeTranscript(mic, system, sync);

    // Mic anchors the shared timeline; system shifts +2000 ms.
    expect(merged[0]).toMatchObject({ speaker: "Me", startMs: 0 });
    expect(merged[1]).toMatchObject({
      speaker: "Them",
      startMs: 2000,
      endMs: 3000,
    });
  });

  it("leaves timestamps alone when implied drift is under 500 ms", () => {
    const sync: SyncData = {
      sampleRate: 16_000,
      epochs: [
        { channel: "mic", t0WallclockMs: 100_000 },
        { channel: "system", t0WallclockMs: 100_300 },
      ],
    };
    const mic = [seg(0, 1000, "quick check in from my side")];
    const system = [seg(0, 1000, "all good over here thanks")];
    const merged = mergeTranscript(mic, system, sync);
    expect(merged.map((m) => m.startMs)).toEqual([0, 0]);
  });

  it("corrects slope drift accumulated over a long recording", () => {
    // System clock runs 1% fast: after 60 s of samples only 59.4 s of
    // wallclock elapsed → segments late in the meeting shift noticeably.
    const sync: SyncData = {
      sampleRate: 16_000,
      epochs: [
        { channel: "mic", t0WallclockMs: 0 },
        { channel: "system", t0WallclockMs: 0 },
      ],
      syncMarkers: [
        { channel: "mic", wallclockMs: 600_000, totalSamples: 600 * 16_000 },
        { channel: "system", wallclockMs: 600_000, totalSamples: 606 * 16_000 },
      ],
    };
    const mic = [seg(590_000, 592_000, "wrapping up now")];
    const system = [
      seg(596_000, 598_000, "thanks everyone for joining the discussion"),
    ];
    const merged = mergeTranscript(mic, system, sync);

    const them = merged.find((m) => m.speaker === "Them");
    // 596000 * (600/606) ≈ 590099 — pulled back by ~5.9 s.
    expect(them?.startMs).toBeGreaterThan(589_000);
    expect(them?.startMs).toBeLessThan(591_000);
  });

  it("ignores syncData without usable fits", () => {
    const sync: SyncData = { sampleRate: 16_000 };
    const mic = [seg(0, 1000, "no sync info available here")];
    const merged = mergeTranscript(mic, [], sync);
    expect(merged[0].startMs).toBe(0);
  });

  it("carries a diarization speakerLabel through unchanged (system channel)", () => {
    const system = [seg(0, 1000, "the second point is this", "2")];
    const merged = mergeTranscript([], system);
    expect(merged).toEqual([
      {
        speaker: "Them",
        startMs: 0,
        endMs: 1000,
        text: "the second point is this",
        speakerLabel: "2",
      },
    ]);
  });

  it("leaves speakerLabel undefined for an undiarized segment and for mic segments", () => {
    const mic = [seg(0, 1000, "hello from the mic")];
    const system = [seg(2000, 3000, "undiarized system speech")];
    const merged = mergeTranscript(mic, system);
    // Regression check (spec §12): the type extension in §6 must not touch
    // existing bare "Me"/"Them" output.
    expect(merged.map((m) => [m.speaker, m.text])).toEqual([
      ["Me", "hello from the mic"],
      ["Them", "undiarized system speech"],
    ]);
    expect(merged.every((m) => m.speakerLabel === undefined)).toBe(true);
  });
});

describe("formatTranscriptMarkdown", () => {
  it('renders "Them N" for a segment with a speakerLabel', () => {
    const merged = mergeTranscript(
      [],
      [seg(0, 1000, "second speaker's point", "2")],
    );
    expect(formatTranscriptMarkdown(merged)).toContain(
      "**[0:00] Them 2:** second speaker's point",
    );
  });

  it('renders unmodified "Them"/"Me" for segments without a speakerLabel', () => {
    const mic = [seg(0, 1000, "hello from the mic")];
    const system = [seg(2000, 3000, "undiarized system speech")];
    const merged = mergeTranscript(mic, system);
    const md = formatTranscriptMarkdown(merged);
    expect(md).toContain("**[0:00] Me:** hello from the mic");
    expect(md).toContain("**[0:02] Them:** undiarized system speech");
  });
});

describe("textSimilarity", () => {
  it("is 1 for identical text modulo case and punctuation", () => {
    expect(textSimilarity("Hello, World!", "hello world")).toBe(1);
  });

  it("is 0 for disjoint text", () => {
    expect(textSimilarity("alpha beta", "gamma delta")).toBe(0);
  });

  it("is partial for overlapping token sets", () => {
    const s = textSimilarity("the red car drove fast", "the red car stopped");
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(0.7);
  });
});

describe("isHallucination", () => {
  it("flags classic whisper fillers", () => {
    expect(isHallucination(seg(0, 500, "Thank you."))).toBe(true);
    expect(isHallucination(seg(0, 500, "THANKS FOR WATCHING"))).toBe(true);
    expect(isHallucination(seg(0, 500, "Subtitles by SomeCorp"))).toBe(true);
    expect(isHallucination(seg(0, 500, ""))).toBe(true);
  });

  it("does not flag real speech containing a blocklisted phrase", () => {
    expect(
      isHallucination(
        seg(
          0,
          3000,
          "thank you for sending the report over, i reviewed all of it yesterday",
        ),
      ),
    ).toBe(false);
  });
});

describe("isVocabLeak", () => {
  // Mirrors the real investigation shape (specs/meeting-transcription-
  // quality.md §1 finding #1): an 80-term vocabulary list, comma-joined.
  const vocabTerms = Array.from({ length: 80 }, (_, i) => `Zylotrix${i + 1}`);

  it("flags a full echo of the omlx/local-mlx 'Technical terms:' prompt", () => {
    const leak = `Technical terms: ${vocabTerms.join(", ")}`;
    expect(isVocabLeak(leak, vocabTerms)).toBe(true);
  });

  it("flags a full echo of the openai/local-whisper 'Terms:' prompt", () => {
    const leak = `Terms: ${vocabTerms.join(", ")}.`;
    expect(isVocabLeak(leak, vocabTerms)).toBe(true);
  });

  it("flags a partial leak (several consecutive vocab terms dominating a short segment)", () => {
    const leak = `${vocabTerms[0]} ${vocabTerms[1]} ${vocabTerms[2]}`;
    expect(isVocabLeak(leak, vocabTerms)).toBe(true);
  });

  it("does not flag real speech that merely mentions one vocab term among ordinary words", () => {
    const real = `so the plan is to ship ${vocabTerms[0]} next week once qa signs off on the release`;
    expect(isVocabLeak(real, vocabTerms)).toBe(false);
  });

  it("never flags anything when the vocabulary list is empty", () => {
    expect(isVocabLeak(`Terms: ${vocabTerms.join(", ")}`, [])).toBe(false);
    expect(isVocabLeak("", [])).toBe(false);
  });
});

describe("mergeTranscript leak backstop (Phase A1 §3.1)", () => {
  const vocabTerms = Array.from({ length: 80 }, (_, i) => `Zylotrix${i + 1}`);

  it("drops a segment matching the leak pattern when vocabTerms is passed", () => {
    const mic = [
      seg(0, 1700, `Technical terms: ${vocabTerms.join(", ")}`),
      seg(2000, 4000, "let's move on to the roadmap discussion now"),
    ];
    const merged = mergeTranscript(mic, [], undefined, vocabTerms);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("let's move on to the roadmap discussion now");
  });

  it("existing three-argument call sites behave exactly as before (regression)", () => {
    const mic = [seg(0, 1700, `Technical terms: ${vocabTerms.join(", ")}`)];
    // No vocabTerms passed — the leak text is real "content" as far as the
    // hallucination/repeat filters are concerned and survives unfiltered.
    const merged = mergeTranscript(mic, []);
    expect(merged).toHaveLength(1);
  });

  it("filter-order: three consecutive leak segments produce zero survivors, not one", () => {
    // Proves the leak filter runs before filterConsecutiveRepeats — if it
    // ran after, the REPEAT_MIN_RUN=3 collapse would keep one leaked
    // segment as the "first" of the run instead of dropping all three.
    const leakText = `Technical terms: ${vocabTerms.join(", ")}`;
    const mic = [
      seg(0, 1700, leakText),
      seg(1800, 3500, leakText),
      seg(3600, 5300, leakText),
      seg(6000, 8000, "back to real conversation after the leak burst"),
    ];
    const merged = mergeTranscript(mic, [], undefined, vocabTerms);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe(
      "back to real conversation after the leak burst",
    );
  });
});

describe("filterConsecutiveRepeats", () => {
  it("keeps the first of a long identical run", () => {
    const run = [
      seg(0, 1, "I'm sorry."),
      seg(1, 2, "im sorry"),
      seg(2, 3, "I'm sorry"),
      seg(3, 4, "I'm sorry."),
    ];
    const out = filterConsecutiveRepeats(run);
    expect(out).toHaveLength(1);
    expect(out[0].startMs).toBe(0);
  });

  it("does not merge non-consecutive duplicates", () => {
    const segs = [
      seg(0, 1, "yes"),
      seg(1, 2, "what do you think"),
      seg(2, 3, "yes"),
    ];
    expect(filterConsecutiveRepeats(segs)).toHaveLength(3);
  });
});
