import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readWavPcm16 } from "../src/lib/audio/wav.js";
import type { DiarizerSegment } from "../src/lib/meetings/diarize.js";
import {
  annotateSpeechEvidence,
  channelNoiseFloorDb,
  chunkVoicedMs,
  cutAtSpeakerChanges,
  DEFAULT_MERGE_TOWARD_OPTIONS,
  isMixedChunk,
  mergeSegmentsToward,
  type Segment,
  SILENCE_GATE_DB,
  segmentPcm,
  segmentWavFile,
  splitAlignedChunk,
} from "../src/lib/meetings/segmenter.js";
import { buildWav } from "./helpers/wav.js";

const SAMPLE_RATE = 16_000;

/** dBFS → linear amplitude for PCM16. */
function amp(db: number): number {
  return 10 ** (db / 20) * 32767;
}

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE));
}

/** Sine tone at the given dBFS level. */
function tone(ms: number, db: number, freq = 440): Int16Array {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const out = new Int16Array(n);
  // Sine RMS is peak/sqrt(2); scale so RMS matches the requested dBFS.
  const peak = amp(db) * Math.SQRT2;
  for (let i = 0; i < n; i++) {
    out[i] = Math.max(
      -32768,
      Math.min(
        32767,
        Math.round(peak * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE)),
      ),
    );
  }
  return out;
}

/** White noise at roughly the given dBFS RMS (deterministic LCG). */
function noise(ms: number, db: number, seed = 12345): Int16Array {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const out = new Int16Array(n);
  const scale = amp(db) * Math.sqrt(3); // uniform [-1,1] has RMS 1/sqrt(3)
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const u = state / 0xffffffff;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(scale * (2 * u - 1))));
  }
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Mix a tone on top of a noise bed of the same length. */
function mix(
  bed: Int16Array,
  overlay: Int16Array,
  offsetSamples: number,
): Int16Array {
  const out = Int16Array.from(bed);
  for (let i = 0; i < overlay.length && offsetSamples + i < out.length; i++) {
    out[offsetSamples + i] = Math.max(
      -32768,
      Math.min(32767, out[offsetSamples + i] + overlay[i]),
    );
  }
  return out;
}

function covering(segments: Segment[], ms: number): boolean {
  return segments.some((s) => s.startMs <= ms && ms <= s.endMs);
}

describe("segmentPcm", () => {
  it("returns no segments for pure silence", () => {
    expect(segmentPcm(silence(15_000), SAMPLE_RATE)).toEqual([]);
  });

  it("returns no segments for empty input", () => {
    expect(segmentPcm(new Int16Array(0), SAMPLE_RATE)).toEqual([]);
  });

  it("detects a single 1 s burst with pads", () => {
    const pcm = concat(silence(5000), tone(1000, -20), silence(5000));
    const segments = segmentPcm(pcm, SAMPLE_RATE);

    expect(segments).toHaveLength(1);
    const [seg] = segments;
    // Burst spans 5000–6000 ms; pads extend 300 ms back and 400 ms forward
    // (plus hangover), so it must cover the burst and stay within tolerance.
    expect(seg.startMs).toBeLessThanOrEqual(5000);
    expect(seg.startMs).toBeGreaterThanOrEqual(5000 - 300 - 100);
    expect(seg.endMs).toBeGreaterThanOrEqual(6000);
    expect(seg.endMs).toBeLessThanOrEqual(6000 + 400 + 700 + 100);
  });

  it("coalesces two bursts 1 s apart into one segment", () => {
    const pcm = concat(
      silence(5000),
      tone(1000, -20),
      silence(1000),
      tone(1000, -20),
      silence(5000),
    );
    const segments = segmentPcm(pcm, SAMPLE_RATE);

    expect(segments).toHaveLength(1);
    expect(covering(segments, 5500)).toBe(true);
    expect(covering(segments, 7500)).toBe(true);
  });

  it("keeps two bursts 5 s apart as separate segments", () => {
    const pcm = concat(
      silence(5000),
      tone(1000, -20),
      silence(5000),
      tone(1000, -20),
      silence(5000),
    );
    const segments = segmentPcm(pcm, SAMPLE_RATE);

    expect(segments).toHaveLength(2);
    expect(segments[0].endMs).toBeLessThan(segments[1].startMs);
    expect(covering(segments, 5500)).toBe(true);
    expect(covering(segments, 11_500)).toBe(true);
  });

  it("force-splits a sustained 60 s tone into segments of at most 30 s", () => {
    const pcm = concat(silence(2000), tone(60_000, -20), silence(2000));
    const segments = segmentPcm(pcm, SAMPLE_RATE);

    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const seg of segments) {
      expect(seg.endMs - seg.startMs).toBeLessThanOrEqual(30_000);
    }
    // No audio dropped between splits: contiguous coverage over the tone.
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].startMs).toBe(segments[i - 1].endMs);
    }
    expect(segments[0].startMs).toBeLessThanOrEqual(2000);
    expect(segments[segments.length - 1].endMs).toBeGreaterThanOrEqual(62_000);
  });

  it("detects soft speech 12 dB over a -50 dBFS noise bed", () => {
    const bed = noise(15_000, -50);
    const pcm = mix(bed, tone(2000, -38), 6 * SAMPLE_RATE);
    const segments = segmentPcm(pcm, SAMPLE_RATE);

    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(covering(segments, 7000)).toBe(true);
  });

  it("discards a 100 ms blip (min speech duration)", () => {
    const pcm = concat(silence(5000), tone(100, -20), silence(5000));
    expect(segmentPcm(pcm, SAMPLE_RATE)).toEqual([]);
  });

  it("honors option overrides", () => {
    const pcm = concat(silence(5000), tone(100, -20), silence(5000));
    // Lowering minSpeechMs makes the blip detectable.
    const segments = segmentPcm(pcm, SAMPLE_RATE, { minSpeechMs: 50 });
    expect(segments).toHaveLength(1);
  });

  it("throws on invalid sample rate", () => {
    expect(() => segmentPcm(silence(100), 0)).toThrow(/sampleRate/);
  });
});

describe("mergeSegmentsToward", () => {
  const seg = (startMs: number, endMs: number): Segment => ({ startMs, endMs });

  it("returns [] unchanged for empty input", () => {
    expect(mergeSegmentsToward([])).toEqual([]);
  });

  it("returns a single segment unchanged (long monologue, no neighbor to merge)", () => {
    const input = [seg(1000, 29_000)]; // 28s, already at/near target, alone
    const out = mergeSegmentsToward(input);
    expect(out).toEqual([{ startMs: 1000, endMs: 29_000 }]);
  });

  it("does not mutate the caller's input array", () => {
    const input = [seg(0, 1000), seg(1500, 2500)];
    const snapshot = input.map((s) => ({ ...s }));
    mergeSegmentsToward(input);
    expect(input).toEqual(snapshot);
  });

  it("merges a run of five 1s bursts 500ms apart into one ~7s segment", () => {
    const input = [
      seg(0, 1000),
      seg(1500, 2500),
      seg(3000, 4000),
      seg(4500, 5500),
      seg(6000, 7000),
    ];
    const out = mergeSegmentsToward(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ startMs: 0, endMs: 7000 });
  });

  it("bridges a gap of exactly maxGapMs (inclusive boundary)", () => {
    const { maxGapMs } = DEFAULT_MERGE_TOWARD_OPTIONS;
    const input = [seg(0, 1000), seg(1000 + maxGapMs, 1000 + maxGapMs + 1000)];
    const out = mergeSegmentsToward(input);
    expect(out).toHaveLength(1);
    expect(out[0].endMs).toBe(1000 + maxGapMs + 1000);
  });

  it("never bridges a gap one ms wider than maxGapMs", () => {
    const { maxGapMs } = DEFAULT_MERGE_TOWARD_OPTIONS;
    const gap = maxGapMs + 1;
    const input = [seg(0, 1000), seg(1000 + gap, 1000 + gap + 1000)];
    const out = mergeSegmentsToward(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ startMs: 0, endMs: 1000 });
    expect(out[1]).toEqual({ startMs: 1000 + gap, endMs: 1000 + gap + 1000 });
  });

  it("stops merging once the combined span would exceed maxSegmentMs, even though the target hasn't been reached", () => {
    // last duration 20_000ms is well under targetMs (22_500), so the target
    // guard alone would allow another merge — only the hard cap should stop
    // it: 0..20_000 merged with 20_500..32_000 spans 32_000ms > 30_000ms.
    const input = [seg(0, 20_000), seg(20_500, 32_000)];
    const out = mergeSegmentsToward(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ startMs: 0, endMs: 20_000 });
    expect(out[1]).toEqual({ startMs: 20_500, endMs: 32_000 });
  });

  it("merges when the combined span is exactly maxSegmentMs (inclusive boundary)", () => {
    const { maxSegmentMs } = DEFAULT_MERGE_TOWARD_OPTIONS;
    const input = [seg(0, 20_000), seg(20_500, maxSegmentMs)];
    const out = mergeSegmentsToward(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ startMs: 0, endMs: maxSegmentMs });
  });

  it("never produces a segment over the hard maxSegmentMs cap on a long alternating-burst train", () => {
    // 20 bursts of 1000ms speech separated by 500ms gaps (period 1500ms):
    // the target guard (22_500ms) should force a split partway through,
    // well before the 30_000ms hard cap would ever bind.
    const input: Segment[] = [];
    for (let k = 0; k < 20; k++) {
      input.push(seg(k * 1500, k * 1500 + 1000));
    }
    const out = mergeSegmentsToward(input);

    // Hand-computed against the algorithm: merging accumulates until the
    // *running* segment's duration reaches/exceeds targetMs, then starts a
    // new segment — producing exactly two merged segments for this input.
    expect(out).toEqual([
      { startMs: 0, endMs: 23_500 },
      { startMs: 24_000, endMs: 29_500 },
    ]);

    for (const s of out) {
      expect(s.endMs - s.startMs).toBeLessThanOrEqual(
        DEFAULT_MERGE_TOWARD_OPTIONS.maxSegmentMs,
      );
    }
    // Coverage: first and last input burst are both still covered.
    expect(out[0].startMs).toBeLessThanOrEqual(0);
    expect(out[out.length - 1].endMs).toBeGreaterThanOrEqual(29_500);
  });

  it("never exceeds the 30s hard cap when merging segmentPcm's own force-split pieces", () => {
    // segmentPcm's forceSplit picks a low-energy split point within the
    // 25%-75% window of an oversized span, not necessarily the midpoint, so
    // adjacent pieces can come out uneven (verified against this codebase's
    // real output, not assumed): a piece under targetMs immediately
    // following another piece under targetMs, with a 0ms gap between them,
    // is legitimately re-coalesced by the merge pass. That's expected, not
    // a bug — the one invariant that must hold regardless is the hard cap.
    const pcm = concat(silence(2000), tone(60_000, -20), silence(2000));
    const split = segmentPcm(pcm, SAMPLE_RATE);
    expect(split.length).toBeGreaterThanOrEqual(2); // precondition from the existing test above
    for (const s of split) {
      expect(s.endMs - s.startMs).toBeLessThanOrEqual(30_000);
    }

    const merged = mergeSegmentsToward(split);
    for (const s of merged) {
      expect(s.endMs - s.startMs).toBeLessThanOrEqual(
        DEFAULT_MERGE_TOWARD_OPTIONS.maxSegmentMs,
      );
    }
    // Full coverage preserved: same overall start/end span, contiguous.
    expect(merged[0].startMs).toBe(split[0].startMs);
    expect(merged[merged.length - 1].endMs).toBe(split[split.length - 1].endMs);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].startMs).toBe(merged[i - 1].endMs);
    }
  });

  it("respects a partial options override, keeping the rest at defaults", () => {
    const input = [seg(0, 1000), seg(1200, 2000), seg(2200, 3000)];
    const out = mergeSegmentsToward(input, { targetMs: 500 });
    // With targetMs lowered to 500ms, the first segment (1000ms) already
    // meets/exceeds target before any merge is attempted, so nothing merges.
    expect(out).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// Speaker cuts (specs/meeting-transcription-v2.md §3.4, I4)
// ---------------------------------------------------------------------------

describe("cutAtSpeakerChanges", () => {
  const FRAME_MS = 20;

  /** A flat-energy rmsDb (dBFS) covering `totalMs`. */
  function flatDb(totalMs: number, db = -30): Float64Array {
    return new Float64Array(Math.ceil(totalMs / FRAME_MS)).fill(db);
  }

  const turn = (speaker: string, startSeconds: number, endSeconds: number) => ({
    speakerId: speaker,
    startTimeSeconds: startSeconds,
    endTimeSeconds: endSeconds,
  });

  it("two turns in one segment give two parts, one per speaker", () => {
    const out = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("A", 0, 4), turn("B", 4, 10)],
      flatDb(10_000),
      FRAME_MS,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.speaker).toBe("A");
    expect(out[1]!.speaker).toBe("B");
    // The cut sits at the turn boundary: part 0 ends where part 1 starts,
    // within the +/-300 ms snap window of 4000 ms.
    expect(out[0]!.endMs).toBe(out[1]!.startMs);
    expect(Math.abs(out[0]!.endMs - 4000)).toBeLessThanOrEqual(300);
    expect(out[0]!.startMs).toBe(0);
    expect(out[1]!.endMs).toBe(10_000);
  });

  it("a flicker under 1 s is absorbed into the previous turn", () => {
    // A ... B (300 ms blip) ... A: the blip joins the previous turn and the
    // re-join collapses everything back to one A part.
    const out = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("A", 0, 4), turn("B", 4, 4.3), turn("A", 4.3, 10)],
      flatDb(10_000),
      FRAME_MS,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 10_000, speaker: "A" }]);
  });

  it("a first turn under 1 s joins the next turn", () => {
    const out = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("B", 0, 0.3), turn("A", 0.3, 10)],
      flatDb(10_000),
      FRAME_MS,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 10_000, speaker: "A" }]);
  });

  it("same-speaker neighbors re-join after flicker absorption", () => {
    // A B(300ms flicker) A A: step 2 joins the two A turns, step 3 extends
    // the first A over the blip, and step 4 re-joins the now-touching A
    // turns. Without the re-join this would be two A parts; with it, one.
    const out = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("A", 0, 3), turn("B", 3, 3.3), turn("A", 3.3, 5), turn("A", 5, 10)],
      flatDb(10_000),
      FRAME_MS,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 10_000, speaker: "A" }]);
  });

  it("a cut snaps to the lowest-energy frame within 300 ms", () => {
    // Flat energy except one dip at 4200 ms (frame 210): the cut at the
    // 4000 ms turn start snaps forward to the frame center, 4210 ms.
    const db = flatDb(10_000);
    db[210] = -90;
    const out = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("A", 0, 4), turn("B", 4, 10)],
      db,
      FRAME_MS,
    );
    expect(out[0]!.endMs).toBe(4210);
    expect(out[1]!.startMs).toBe(4210);
  });

  it("a part under 1.5 s merges into the longer neighbor", () => {
    // The B turn leaves only a 1200 ms part at the end: it merges into the
    // longer A part and takes A's speaker.
    const out = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("A", 0, 8.8), turn("B", 8.8, 10)],
      flatDb(10_000),
      FRAME_MS,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 10_000, speaker: "A" }]);
  });

  it("the FIRST short part merges into the next part (step 8 covers it too)", () => {
    // A 0-1.2 s, B 1.2-10 s: the loop only ever merges a part into the one
    // before it, so the short opening A part used to survive as a ~1.2 s
    // chunk of its own. Now it merges into the longer B part, keeping B.
    const out = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("A", 0, 1.2), turn("B", 1.2, 10)],
      flatDb(10_000),
      FRAME_MS,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 10_000, speaker: "B" }]);
  });

  it("a part with no overlapping turn has no speaker", () => {
    const out = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("A", 20, 25)],
      flatDb(10_000),
      FRAME_MS,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 10_000 }]);
    expect(out[0]!.speaker).toBeUndefined();
  });

  it("segments with no overlapping turns are returned untouched", () => {
    const input: Segment[] = [
      { startMs: 0, endMs: 3_000 },
      { startMs: 5_000, endMs: 8_000 },
    ];
    const out = cutAtSpeakerChanges(
      input,
      [turn("A", 30, 40)],
      flatDb(40_000),
      FRAME_MS,
    );
    expect(out).toEqual(input);
  });

  it("unsorted turns give the same parts as sorted ones", () => {
    // The cut rule assumes time order; the diarizer output is sanitized at
    // the source, but the pure function must not depend on the caller's
    // order. Reversed input must produce the identical parts.
    const sorted = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("A", 0, 4), turn("B", 4, 10)],
      flatDb(10_000),
      FRAME_MS,
    );
    const reversed = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 10_000 }],
      [turn("B", 4, 10), turn("A", 0, 4)],
      flatDb(10_000),
      FRAME_MS,
    );
    expect(reversed).toEqual(sorted);
    expect(reversed).toHaveLength(2);
    expect(reversed[0]!.speaker).toBe("A");
    expect(reversed[1]!.speaker).toBe("B");
  });

  it("no part ever ends past the segment end when a cut snaps to the edge", () => {
    // B starts 150 ms before the segment ends: the snap window (300 ms)
    // reaches seg.endMs, so the snapped cut can land exactly on it and the
    // +1 ms nudge must clamp instead of pushing the final bound past it.
    const out = cutAtSpeakerChanges(
      [{ startMs: 0, endMs: 5_000 }],
      [turn("A", 0, 4.9), turn("B", 4.9, 5.2)],
      flatDb(5_000),
      FRAME_MS,
    );
    expect(out.length).toBeGreaterThanOrEqual(1);
    for (const p of out) {
      expect(p.endMs).toBeLessThanOrEqual(5_000);
      expect(p.startMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("first part starts at the segment start, last ends at the segment end, parts tile each segment", () => {
    // Guard for the gap fix: whatever the cuts and short-part merges do,
    // the parts must tile each segment exactly — no hole at either edge or
    // between parts (a hole would be audio sent to nobody). The 2 s hole
    // BETWEEN the two input segments is the VAD's own (silence) and is not
    // a part's business.
    const out = cutAtSpeakerChanges(
      [
        { startMs: 0, endMs: 10_000 },
        { startMs: 12_000, endMs: 25_000 },
      ],
      [turn("A", 0, 5), turn("B", 5, 18), turn("A", 18, 30)],
      flatDb(30_000),
      FRAME_MS,
    );
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]!.startMs).toBe(0);
    expect(out[out.length - 1]!.endMs).toBe(25_000);
    let expectStart: number | null = null;
    for (const p of out) {
      if (expectStart === null) {
        expect(p.startMs).toBeGreaterThanOrEqual(0);
      } else {
        // Either the next part of the same segment (exact tile) or the
        // start of the next input segment (the VAD gap).
        const nextSegStart = 12_000;
        expect(
          p.startMs === expectStart || p.startMs === nextSegStart,
          `part ${p.startMs} does not tile after ${expectStart}`,
        ).toBe(true);
      }
      expectStart = p.endMs;
    }
  });
});

describe("mergeSegmentsToward speaker rule (I4, §3.4)", () => {
  it("never merges across two different speakers", () => {
    const out = mergeSegmentsToward([
      { startMs: 0, endMs: 10_000, speaker: "A" },
      { startMs: 10_200, endMs: 20_000, speaker: "B" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.speaker).toBe("A");
    expect(out[1]!.speaker).toBe("B");
  });

  it("still merges parts of the same speaker toward the target", () => {
    const out = mergeSegmentsToward([
      { startMs: 0, endMs: 10_000, speaker: "A" },
      { startMs: 10_200, endMs: 20_000, speaker: "A" },
    ]);
    expect(out).toEqual([{ startMs: 0, endMs: 20_000, speaker: "A" }]);
  });

  it("a part with no speaker still merges as before", () => {
    const out = mergeSegmentsToward([
      { startMs: 0, endMs: 10_000 },
      { startMs: 10_200, endMs: 20_000, speaker: "B" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.endMs).toBe(20_000);
  });

  it("an unlabeled part absorbs the neighbor's speaker when they merge", () => {
    // The speech in the merged part came from the labeled neighbor, so the
    // merged part keeps that attribution. Without the carry-over, "no-turn,
    // A, B" with gaps under maxGapMs merged into ONE unlabeled chunk and
    // swallowed the A|B boundary (G4 break).
    const out = mergeSegmentsToward([
      { startMs: 0, endMs: 5_000 }, // no overlapping turn
      { startMs: 5_200, endMs: 11_000, speaker: "A" },
      { startMs: 11_200, endMs: 18_000, speaker: "B" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.speaker).toBe("A");
    expect(out[0]!.endMs).toBe(11_000);
    expect(out[1]!.speaker).toBe("B");
  });

  it("the gap between two speakers' parts goes to the new part (council fix, 2026-10-07)", () => {
    // A speaker cut blocks the merge, but the speech in the gap must still
    // be sent: without the fix this gap (2660 ms, the real case from the
    // council root cause) went to nobody and a word was lost in R4b.
    const out = mergeSegmentsToward([
      { startMs: 0, endMs: 4_000, speaker: "A" },
      { startMs: 6_660, endMs: 20_000, speaker: "B" },
    ]);
    expect(out).toHaveLength(2);
    // Contiguous: the new part extends back over the gap, cut at the
    // speaker boundary.
    expect(out[0]!.endMs).toBe(out[1]!.startMs);
    expect(out[0]!.startMs).toBe(0);
    expect(out[1]!.endMs).toBe(20_000);
    expect(out[0]!.speaker).toBe("A");
    expect(out[1]!.speaker).toBe("B");
  });

  it("extends the previous part instead when extending the new one would pass 30 s", () => {
    // Extending B back to A's end would span 32 s; extending A forward to
    // B's start spans 6 s, so A takes the gap.
    const out = mergeSegmentsToward([
      { startMs: 0, endMs: 5_000, speaker: "A" },
      { startMs: 6_000, endMs: 37_000, speaker: "B" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.endMs).toBe(out[1]!.startMs);
    expect(out[0]!.endMs).toBe(6_000);
  });

  it("keeps the gap when extending either part would pass 30 s", () => {
    // A ends at 27 s, B starts 4 s later: extending B back spans 31 s and
    // extending A forward spans 31 s — neither side can take the gap, so
    // it stays where the VAD left it (the old behavior for this case).
    const out = mergeSegmentsToward([
      { startMs: 0, endMs: 27_000, speaker: "A" },
      { startMs: 31_000, endMs: 58_000, speaker: "B" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.endMs).toBe(27_000);
    expect(out[1]!.startMs).toBe(31_000);
  });
});

describe("gap coverage across speaker cuts (council fix, 2026-10-07)", () => {
  /** True when every millisecond in `base` lies inside the union of `parts`. */
  function unionCovers(base: Segment[], parts: Segment[]): boolean {
    const ordered = [...parts].sort((a, b) => a.startMs - b.startMs);
    for (const seg of base) {
      let pos = seg.startMs;
      for (const p of ordered) {
        if (p.endMs <= pos) continue;
        if (p.startMs > pos) return false; // a hole
        pos = Math.max(pos, p.endMs);
        if (pos >= seg.endMs) break;
      }
      if (pos < seg.endMs) return false;
    }
    return true;
  }

  it("segmentPcm + mergeSegmentsToward with turns covers at least the span it covers without turns", () => {
    // Speech 2-5.3 s and 8-22 s (2 s lead so the adaptive floor calibrates
    // before the first opening), turns A (1-4 s) then B (4-20 s+): the VAD
    // opening 2-5.3 s straddles the A|B boundary, so the cut splits it and
    // the merge pass meets a speaker cut. Everything covered without turns
    // must still be covered with turns — the gap between the two speakers'
    // parts may not go unsent.
    const pcm = concat(
      silence(2_000),
      tone(3_300, -20),
      silence(2_700),
      tone(14_000, -20),
      silence(1_000),
    );
    const turns = [
      { speakerId: "A", startTimeSeconds: 1, endTimeSeconds: 4 },
      { speakerId: "B", startTimeSeconds: 4, endTimeSeconds: 20 },
    ];
    const withoutRaw = segmentPcm(pcm, SAMPLE_RATE);
    const withRaw = segmentPcm(pcm, SAMPLE_RATE, undefined, turns);
    const without = mergeSegmentsToward(withoutRaw);
    const withTurns = mergeSegmentsToward(withRaw);
    expect(withoutRaw.length).toBeGreaterThanOrEqual(2);
    expect(withRaw.length).toBeGreaterThanOrEqual(3);
    expect(
      withTurns.some((p) => p.speaker !== undefined),
      "the turns must actually produce speaker parts",
    ).toBe(true);
    expect(unionCovers(without, withTurns)).toBe(true);
  });
});

/**
 * The "speech" clip for the turn tests, synthesized in JS (the old version
 * was generated with `ffmpeg -f lavfi`, and Linux CI has no ffmpeg).
 * Same shape: a quiet noise bed (so the adaptive noise floor calibrates) with
 * a 440 Hz tone on top from 2 s on — continuous "speech", one VAD opening.
 * 10 s, 16 kHz, mono, PCM16.
 */
function synthToneWav(dir: string): string {
  const rate = 16_000;
  const frames = 10 * rate;
  const pcm = Buffer.alloc(frames * 2);
  let seed = 0x1234567;
  for (let i = 0; i < frames; i += 1) {
    // xorshift32 — deterministic across hosts.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    const tone =
      i >= 2 * rate ? Math.sin((2 * Math.PI * 440 * i) / rate) * 0.8 : 0;
    const v = Math.max(-1, Math.min(1, noise * 0.005 + tone));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const wavPath = join(dir, "tone.wav");
  writeFileSync(wavPath, buildWav({ sampleRate: rate, data: pcm }));
  return wavPath;
}

describe("segmentPcm with diarizer turns (I4, §3.4)", () => {
  it("a 10 s clip with turns 0-4 s and 4-10 s gives exactly 2 chunks, cut within 300 ms of 4 s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seg-turns-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const wavPath = synthToneWav(dir);
    const channel = readWavPcm16(wavPath);
    expect(channel).not.toBeNull();
    const segments = segmentPcm(channel!.pcm, channel!.sampleRate, undefined, [
      { speakerId: "A", startTimeSeconds: 0, endTimeSeconds: 4 },
      { speakerId: "B", startTimeSeconds: 4, endTimeSeconds: 10 },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.speaker).toBe("A");
    expect(segments[1]!.speaker).toBe("B");
    expect(segments[0]!.endMs).toBe(segments[1]!.startMs);
    expect(Math.abs(segments[0]!.endMs - 4000)).toBeLessThanOrEqual(300);
  });

  it("without turns the same clip gives one chunk, unspoken", () => {
    // Regression guard for the argument: no turns in, no speaker out.
    const dir = mkdtempSync(join(tmpdir(), "seg-noturns-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const wavPath = synthToneWav(dir);
    const segments = segmentWavFile(wavPath);
    expect(segments!.length).toBeGreaterThanOrEqual(1);
    // No turns in: no part may carry a speaker.
    for (const s of segments!) expect(s.speaker).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// I4b (specs/meeting-transcription-v2.md §3.6): forced alignment at speaker
// cuts — the pure split rule and the mixed-chunk rule.
// ---------------------------------------------------------------------------

const turn = (
  speakerId: string,
  startMs: number,
  endMs: number,
): DiarizerSegment => ({
  speakerId,
  startTimeSeconds: startMs / 1000,
  endTimeSeconds: endMs / 1000,
});

describe("splitAlignedChunk (I4b, §3.6 + Decision owner 2026-10-07)", () => {
  it("splits at a sentence end and keeps the midpoint rule", () => {
    // Chunk 0-10 s; speaker A until 4 s, B after. Word "alpha." ends just
    // after the change (midpoint 3.5 s → A) and ends a sentence, so the
    // cut at its boundary is kept; "beta" and "gamma" are B.
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "alpha.", startMs: 3_000, endMs: 4_000 },
        { text: "beta", startMs: 4_100, endMs: 5_100 },
        { text: "gamma", startMs: 5_200, endMs: 6_200 },
      ],
      [turn("A", 0, 4_000), turn("B", 4_000, 10_000)],
    );
    expect(res.parts).toHaveLength(2);
    expect(res.parts[0]).toEqual({
      startMs: 3_000,
      endMs: 4_000,
      text: "alpha.",
      speakerId: "A",
    });
    expect(res.parts[1]).toEqual({
      startMs: 4_100,
      endMs: 6_200,
      text: "beta gamma",
      speakerId: "B",
    });
    expect(res.cutsDropped).toBe(0);
  });

  it("gives a word in a gap to the NEAREST turn", () => {
    // Turns 0-3 s (A) and 5-10 s (B): a gap 3-5 s. A word at 3.9-4.1 s has
    // its midpoint (4.0 s) 0.9 s from A's end and 0.9 s from B's start —
    // equal; the earlier turn wins (A). "gap." ends a sentence, so the
    // cut before "y" is kept.
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "x", startMs: 1_000, endMs: 1_400 },
        { text: "gap.", startMs: 3_900, endMs: 4_100 },
        { text: "y", startMs: 6_000, endMs: 7_000 },
      ],
      [turn("A", 0, 3_000), turn("B", 5_000, 10_000)],
    );
    expect(res.parts).toHaveLength(2);
    expect(res.parts[0]!.speakerId).toBe("A");
    expect(res.parts[0]!.text).toBe("x gap.");
    expect(res.parts[1]!.speakerId).toBe("B");
    expect(res.parts[1]!.text).toBe("y");
  });

  it("re-joins alternating same-speaker runs (A, B, A → two parts)", () => {
    const res = splitAlignedChunk(
      { startMs: 1_000, endMs: 10_000 },
      [
        { text: "a1.", startMs: 0, endMs: 1_500 },
        { text: "b1", startMs: 1_500, endMs: 2_400 },
        { text: "a2", startMs: 2_400, endMs: 3_400 },
      ],
      [
        turn("A", 1_000, 2_000),
        turn("B", 2_000, 4_000),
        turn("A", 4_000, 5_000),
      ],
    );
    // Midpoints: a1. → 1_750 (A turn 1), b1 → 2_950 (B), a2 → 3_900 (B!).
    // So the runs are A(a1.) then B(b1 a2); the cut after "a1." is kept.
    expect(res.parts).toHaveLength(2);
    expect(res.parts[0]!.speakerId).toBe("A");
    expect(res.parts[0]!.text).toBe("a1.");
    expect(res.parts[1]!.speakerId).toBe("B");
    expect(res.parts[1]!.text).toBe("b1 a2");
    // Absolute times: the chunk starts at 1_000.
    expect(res.parts[1]!.startMs).toBe(2_500);
    expect(res.parts[1]!.endMs).toBe(4_400);
  });

  it("keeps the ASR punctuation and case from the source text (1:1)", () => {
    // The aligner returns normalized words (no punctuation, no case); the
    // parts must be built from the ORIGINAL tokens in order, so joining
    // the parts with a space reproduces the chunk text.
    const source = "I don't see any other. Yeah, we all here.";
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "i", startMs: 0, endMs: 300 },
        { text: "don't", startMs: 300, endMs: 700 },
        { text: "see", startMs: 700, endMs: 1_000 },
        { text: "any", startMs: 1_000, endMs: 1_300 },
        { text: "other", startMs: 1_300, endMs: 1_700 },
        { text: "yeah", startMs: 2_000, endMs: 2_400 },
        { text: "we", startMs: 2_400, endMs: 2_700 },
        { text: "all", startMs: 2_700, endMs: 3_000 },
        { text: "here", startMs: 3_000, endMs: 3_400 },
      ],
      [turn("A", 0, 1_900), turn("B", 1_900, 10_000)],
      source,
    );
    expect(res.parts).toHaveLength(2);
    expect(res.parts[0]).toEqual({
      startMs: 0,
      endMs: 1_700,
      text: "I don't see any other.",
      speakerId: "A",
    });
    expect(res.parts[1]).toEqual({
      startMs: 2_000,
      endMs: 3_400,
      text: "Yeah, we all here.",
      speakerId: "B",
    });
    // The two parts joined with a space equal the original text.
    expect(res.parts.map((p) => p.text).join(" ")).toBe(source);
  });

  it("falls back to normalized words on a token count mismatch", () => {
    // 3 words but only 1 source token: no 1:1 mapping, the parts use the
    // normalized words (no punctuation → no sentence end → the cut is
    // DROPPED, one part with the larger word share).
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "alpha", startMs: 0, endMs: 900 },
        { text: "beta", startMs: 1_000, endMs: 1_900 },
        { text: "gamma", startMs: 2_000, endMs: 2_900 },
      ],
      [turn("A", 0, 1_500), turn("B", 1_500, 10_000)],
      "Alpha.",
    );
    // Midpoints: alpha 450 (A), beta 1450 (A), gamma 2450 (B).
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0]!.text).toBe("alpha beta gamma");
    expect(res.parts[0]!.speakerId).toBe("A"); // 2 words vs 1
    expect(res.cutsDropped).toBe(1);
  });

  it("snaps the cut to a sentence end one word away", () => {
    // The diarizer says A ends after "you" (a false change inside the
    // sentence): the cut there cannot stay, but "stop." one word later
    // ends a turn, so the cut snaps ONTO that boundary and A keeps the
    // word "stop." 2.14.1: both parts' word-midpoint majority is A, so
    // the same-speaker neighbor merge re-joins them (the split did no
    // visible work).
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "did", startMs: 0, endMs: 500 },
        { text: "you", startMs: 500, endMs: 1_100 },
        { text: "stop.", startMs: 1_100, endMs: 1_900 },
        { text: "ok", startMs: 1_900, endMs: 2_400 },
        { text: "yes", startMs: 3_400, endMs: 3_900 },
        { text: "right", startMs: 3_900, endMs: 4_400 },
      ],
      [turn("A", 0, 1_200), turn("B", 1_200, 3_500), turn("A", 3_500, 10_000)],
    );
    // Midpoints: did 250 (A), you 800 (A), stop. 1500 (B), ok 2150 (B),
    // yes 3650 (A), right 4150 (A). Speaker changes after "you" (A→B)
    // and after "ok" (B→A); both snap onto the "stop." boundary.
    // Parts before the merge: "did you stop." (A 2 vs B 1) and
    // "ok yes right" (A 2 vs B 1) — same label, merged.
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0]).toEqual({
      startMs: 0,
      endMs: 4_400,
      text: "did you stop. ok yes right",
      speakerId: "A",
    });
    expect(res.cutsDropped).toBe(0);
    expect(res.sameSpeakerMerges).toBe(1);
  });

  it("drops the cut (and keeps the larger share) when no sentence end is within one word", () => {
    // No word in any window ends a sentence: both candidate cuts are
    // DROPPED and all the words stay in one part, labeled by the larger
    // word share (A: 3 of 5).
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "I", startMs: 0, endMs: 500 },
        { text: "think", startMs: 500, endMs: 1_100 },
        { text: "so", startMs: 4_000, endMs: 4_500 },
        { text: "do", startMs: 4_500, endMs: 5_000 },
        { text: "you", startMs: 6_000, endMs: 6_500 },
      ],
      [turn("A", 0, 4_000), turn("B", 4_000, 6_000), turn("A", 6_000, 10_000)],
    );
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0]!.text).toBe("I think so do you");
    expect(res.parts[0]!.speakerId).toBe("A");
    expect(res.cutsDropped).toBe(2);
  });

  it("merges a part shorter than 1000 ms into its LARGER neighbor", () => {
    // The B part ("bb.") is 400 ms, squeezed between a 1200 ms A part and
    // a 2000 ms C part: it merges into the LARGER neighbor (the next
    // part, not the previous one). Both cuts were kept (turn ends). The
    // neighbors keep DIFFERENT labels, so the 2.14.1 same-speaker merge
    // does not touch them.
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "aa.", startMs: 0, endMs: 1_200 },
        { text: "bb.", startMs: 1_300, endMs: 1_700 },
        { text: "cc", startMs: 1_800, endMs: 3_800 },
      ],
      [turn("A", 0, 1_300), turn("B", 1_300, 1_800), turn("C", 1_800, 10_000)],
    );
    // Midpoints: aa. 600 (A), bb. 1500 (B), cc 2800 (C). Cuts after "aa."
    // and after "bb." (both turn ends). "bb." (400 ms) merges into the
    // 2000 ms neighbor; the merged part's label is C (word-count tie:
    // the longer total word time wins).
    expect(res.parts).toHaveLength(2);
    expect(res.parts[0]).toEqual({
      startMs: 0,
      endMs: 1_200,
      text: "aa.",
      speakerId: "A",
    });
    expect(res.parts[1]).toEqual({
      startMs: 1_300,
      endMs: 3_800,
      text: "bb. cc",
      speakerId: "C", // 1 word 400 ms (B) vs 1 word 2000 ms (C)
    });
    expect(res.cutsDropped).toBe(0);
    expect(res.sameSpeakerMerges).toBe(0);
  });

  it("keeps a real one-word reply that starts after a sentence end", () => {
    // A asks, B answers "ok.", A continues: the middle B part starts
    // after "there?" — a real reply — and stays separate (the A-B-A rule
    // must not merge it).
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "are", startMs: 0, endMs: 600 },
        { text: "you", startMs: 600, endMs: 1_200 },
        { text: "there?", startMs: 1_200, endMs: 2_000 },
        { text: "ok.", startMs: 2_000, endMs: 3_000 },
        { text: "thanks", startMs: 3_000, endMs: 3_900 },
        { text: "for", startMs: 3_900, endMs: 4_500 },
        { text: "coming.", startMs: 4_500, endMs: 5_300 },
      ],
      [turn("A", 0, 2_000), turn("B", 2_000, 3_000), turn("A", 3_000, 10_000)],
    );
    expect(res.parts).toHaveLength(3);
    expect(res.parts[0]).toEqual({
      startMs: 0,
      endMs: 2_000,
      text: "are you there?",
      speakerId: "A",
    });
    expect(res.parts[1]).toEqual({
      startMs: 2_000,
      endMs: 3_000,
      text: "ok.",
      speakerId: "B",
    });
    expect(res.parts[2]).toEqual({
      startMs: 3_000,
      endMs: 5_300,
      text: "thanks for coming.",
      speakerId: "A",
    });
    expect(res.cutsDropped).toBe(0);
  });

  it("snaps back and drops the no-sentence cut for a false mid-sentence change", () => {
    // B's words are a false change inside A's sentence: the A→B cut
    // snaps back onto "two." (one word earlier) and the B→A cut has no
    // sentence end in its window (dropped) — the middle part does not
    // start after a sentence end and merges into the surrounding A.
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "one", startMs: 0, endMs: 600 },
        { text: "two.", startMs: 600, endMs: 1_400 },
        { text: "three", startMs: 1_400, endMs: 1_900 },
        { text: "four", startMs: 1_900, endMs: 3_400 },
        { text: "five", startMs: 3_400, endMs: 4_900 },
      ],
      [turn("A", 0, 1_800), turn("B", 1_800, 3_400), turn("A", 3_400, 10_000)],
    );
    // Midpoints: two. 1000 (A), three 1650 (A — turn ends 1800), four
    // 2650 (B), five 4150 (A). Changes: after "three" (A→B) — "three" is
    // not a turn end, "two." one word earlier is, so the cut snaps back
    // onto "two."; after "four" (B→A) — no turn end within one word
    // ("four", "three", "five"), so it is DROPPED. 2.14.1: both parts'
    // majority is A, so the same-speaker neighbor merge re-joins them.
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0]).toEqual({
      startMs: 0,
      endMs: 4_900,
      text: "one two. three four five",
      speakerId: "A",
    });
    expect(res.cutsDropped).toBe(1);
    expect(res.sameSpeakerMerges).toBe(1);
  });

  it("keeps a reply that is the ONLY change and starts after a sentence end", () => {
    // A single A→B→A wiggle around a one-word B reply: both cuts sit on
    // sentence ends ("there?", "ok.") so nothing is dropped and no
    // part is short — the reply survives.
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 10_000 },
      [
        { text: "is", startMs: 0, endMs: 500 },
        { text: "it", startMs: 500, endMs: 1_000 },
        { text: "ready?", startMs: 1_000, endMs: 1_800 },
        { text: "ok.", startMs: 1_800, endMs: 2_800 },
        { text: "go", startMs: 2_800, endMs: 3_400 },
        { text: "ahead", startMs: 3_400, endMs: 4_200 },
        { text: "then", startMs: 4_200, endMs: 4_900 },
        { text: "start.", startMs: 4_900, endMs: 5_600 },
      ],
      [turn("A", 0, 1_800), turn("B", 1_800, 2_800), turn("A", 2_800, 10_000)],
    );
    expect(res.parts).toHaveLength(3);
    expect(res.parts.map((p) => p.text)).toEqual([
      "is it ready?",
      "ok.",
      "go ahead then start.",
    ]);
    expect(res.parts.map((p) => p.speakerId)).toEqual(["A", "B", "A"]);
    expect(res.cutsDropped).toBe(0);
  });

  it("skips words without text and returns empty parts when nothing survives", () => {
    expect(
      splitAlignedChunk(
        { startMs: 0, endMs: 5_000 },
        [
          { text: "", startMs: 0, endMs: 500 },
          { text: "  ", startMs: 500, endMs: 1_000 },
          { text: "!", startMs: 1_000, endMs: 1_200 },
        ],
        [turn("A", 0, 5_000)],
      ),
    ).toEqual({ parts: [], cutsDropped: 0, sameSpeakerMerges: 0 });
    // No turns at all: the caller keeps the chunk unsplit.
    expect(
      splitAlignedChunk(
        { startMs: 0, endMs: 5_000 },
        [{ text: "hi", startMs: 0, endMs: 500 }],
        [],
      ),
    ).toEqual({ parts: [], cutsDropped: 0, sameSpeakerMerges: 0 });
  });

  it("does not cut on a Portuguese tag question (sabe?)", () => {
    // 2.14.1, council round 4 (9742105a #125 shape): A's explanation
    // ends on "sabe?" — a tag question that ends the clause, not the
    // turn — and the diarizer's false change lands right after it. The
    // cut has no turn end within one word and is DROPPED; the words
    // stay in one part (A's, the larger share) and the text is kept
    // exactly.
    const source = "Eu sei, sabe? Tá ótimo";
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 5_000 },
      [
        { text: "eu", startMs: 100, endMs: 400 },
        { text: "sei,", startMs: 500, endMs: 800 },
        { text: "sabe?", startMs: 900, endMs: 1_400 },
        { text: "tá", startMs: 2_100, endMs: 2_400 },
        { text: "ótimo", startMs: 2_500, endMs: 3_000 },
      ],
      [turn("A", 0, 2_000), turn("B", 2_000, 5_000)],
      source,
    );
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0]).toEqual({
      startMs: 100,
      endMs: 3_000,
      text: source, // kept exactly, 1:1 source tokens
      speakerId: "A", // 3 words vs 2
    });
    expect(res.cutsDropped).toBe(1);
    expect(res.sameSpeakerMerges).toBe(0);
  });

  it("does not cut on a Portuguese tag question (tá?)", () => {
    // 9ad10a3c #59 shape: "tá?" does not end the turn, so the cut after
    // it is dropped and the next speaker's words do not start a new
    // part.
    const source = "Você viu, tá? Beleza ótimo";
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 5_000 },
      [
        { text: "você", startMs: 100, endMs: 400 },
        { text: "viu,", startMs: 500, endMs: 800 },
        { text: "tá?", startMs: 900, endMs: 1_400 },
        { text: "beleza", startMs: 2_100, endMs: 2_400 },
        { text: "ótimo", startMs: 2_500, endMs: 3_000 },
      ],
      [turn("A", 0, 2_000), turn("B", 2_000, 5_000)],
      source,
    );
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0]!.text).toBe(source);
    expect(res.parts[0]!.speakerId).toBe("A");
    expect(res.cutsDropped).toBe(1);
    expect(res.sameSpeakerMerges).toBe(0);
  });

  it("still cuts on an English question mark (Are you? | Yeah)", () => {
    // "there?" is a real question (not a tag question): the cut after
    // it is KEPT and the reply starts a new part. The reply part is
    // >= 1000 ms so the pre-existing short-part merge (rule 2a) does not
    // re-join it: the test isolates the cut rule.
    const source = "Are you there? Yeah";
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 5_000 },
      [
        { text: "are", startMs: 100, endMs: 400 },
        { text: "you", startMs: 500, endMs: 800 },
        { text: "there?", startMs: 900, endMs: 1_500 },
        { text: "yeah", startMs: 2_100, endMs: 3_300 },
      ],
      [turn("A", 0, 2_000), turn("B", 2_000, 5_000)],
      source,
    );
    expect(res.parts).toHaveLength(2);
    expect(res.parts[0]).toEqual({
      startMs: 100,
      endMs: 1_500,
      text: "Are you there?",
      speakerId: "A",
    });
    expect(res.parts[1]).toEqual({
      startMs: 2_100,
      endMs: 3_300,
      text: "Yeah",
      speakerId: "B",
    });
    expect(res.cutsDropped).toBe(0);
    expect(res.sameSpeakerMerges).toBe(0);
  });

  it("merges neighboring parts with the same speaker label (a24 #20)", () => {
    // 2.14.1, council round 4 (a24a70ec #20 shape): the cut snaps onto
    // "it." (a turn end), but the second part's word-midpoint majority
    // is the SAME speaker as the first part (B's single word is the
    // minority) — the split does no visible work, so the parts merge
    // back into one and the text is kept exactly.
    const source = "We fixed it. Next time.";
    const res = splitAlignedChunk(
      { startMs: 0, endMs: 5_000 },
      [
        { text: "we", startMs: 100, endMs: 400 },
        { text: "fixed", startMs: 500, endMs: 900 },
        { text: "it.", startMs: 1_000, endMs: 1_400 },
        { text: "next", startMs: 1_800, endMs: 2_100 },
        { text: "time.", startMs: 2_800, endMs: 3_200 },
      ],
      [turn("A", 0, 1_500), turn("B", 1_500, 2_500), turn("A", 2_500, 5_000)],
      source,
    );
    // Midpoints: we 250 (A), fixed 700 (A), it. 1200 (A), next 1950
    // (B), time. 3000 (A). Both speaker changes snap onto the "it."
    // boundary; the parts are "we fixed it." (A 3 vs B 0) and
    // "next time." (A 2 vs B 1) — same label, merged.
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0]).toEqual({
      startMs: 100,
      endMs: 3_200,
      text: source,
      speakerId: "A",
    });
    expect(res.cutsDropped).toBe(0);
    expect(res.sameSpeakerMerges).toBe(1);
  });
});

describe("speech evidence (PR #38)", () => {
  it("chunkVoicedMs counts only frames strictly above floor + gate", () => {
    // floor -50, gate +6 → level -44. Loud frames: -40 and -30 only
    // (-44.0, -44.1 and -44.5 stay below the strict >).
    const rms = Float64Array.from([-60, -40, -44.5, -44.1, -30, -50, -44]);
    expect(chunkVoicedMs(rms, 20, 0, 140, -50)).toBe(40);
    // The span clips to the frames it actually covers.
    expect(chunkVoicedMs(rms, 20, 40, 100, -50)).toBe(20);
    expect(chunkVoicedMs(rms, 20, 0, 0, -50)).toBe(0);
    expect(chunkVoicedMs(new Float64Array(0), 20, 0, 100, -50)).toBe(0);
  });

  it("channelNoiseFloorDb tracks a steady noise bed", () => {
    const floor = channelNoiseFloorDb(noise(30_000, -50), SAMPLE_RATE);
    expect(floor).toBeGreaterThan(-53);
    expect(floor).toBeLessThan(-47);
  });

  it("channelNoiseFloorDb clamps to minNoiseFloorDb on pure silence", () => {
    expect(channelNoiseFloorDb(silence(10_000), SAMPLE_RATE)).toBe(-70);
  });

  it("a 400 ms voiced burst on a noise bed yields >= 400 ms of evidence", () => {
    // A short real-like reply: 400 ms at -30 dBFS on a -50 dBFS bed.
    const bed = noise(20_000, -50);
    const pcm = mix(bed, tone(400, -30), 10 * SAMPLE_RATE); // 10 s in
    const segs = mergeSegmentsToward(segmentPcm(pcm, SAMPLE_RATE));
    expect(segs).toHaveLength(1);
    const [annotated] = annotateSpeechEvidence(pcm, SAMPLE_RATE, segs);
    expect(annotated!.voicedMs).toBeGreaterThanOrEqual(400);
    expect(annotated!.voicedMs!).toBeLessThan(
      annotated!.endMs - annotated!.startMs,
    );
  });

  it("annotateSpeechEvidence leaves the chunk geometry untouched", () => {
    const bed = noise(15_000, -50);
    const pcm = mix(bed, tone(600, -32), 5 * SAMPLE_RATE); // 5 s in
    const segs = mergeSegmentsToward(segmentPcm(pcm, SAMPLE_RATE));
    const annotated = annotateSpeechEvidence(pcm, SAMPLE_RATE, segs);
    expect(annotated.map((s) => [s.startMs, s.endMs])).toEqual(
      segs.map((s) => [s.startMs, s.endMs]),
    );
    for (const s of annotated) {
      expect(s.voicedMs).toBeGreaterThanOrEqual(0);
      expect(s.voicedMs!).toBeLessThanOrEqual(s.endMs - s.startMs);
    }
  });

  it("segmentWavFile annotates every chunk (evidence present)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seg-evidence-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const bed = noise(12_000, -50);
    const pcm = mix(bed, tone(800, -30), 4 * SAMPLE_RATE); // 4 s in
    const path = join(dir, "mic.wav");
    const data = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) data.writeInt16LE(pcm[i]!, i * 2);
    writeFileSync(path, buildWav({ sampleRate: SAMPLE_RATE, data }));
    const segs = segmentWavFile(path);
    expect(segs).not.toBeNull();
    expect(segs!.length).toBeGreaterThanOrEqual(1);
    for (const s of segs!) {
      expect(s.voicedMs).toBeTypeOf("number");
      expect(s.voicedMs!).toBeGreaterThan(0);
    }
    // The burst itself must dominate the evidence.
    const total = segs!.reduce((a, s) => a + (s.voicedMs ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(800);
  });

  it("SILENCE_GATE_DB is a positive dB offset", () => {
    expect(SILENCE_GATE_DB).toBeGreaterThan(0);
  });
});

describe("isMixedChunk (I4b, §3.6)", () => {
  it("is true only with two speakers beyond the 300 ms snap window", () => {
    const a = turn("A", 0, 10_000);
    const b = turn("B", 10_100, 12_000);
    // A chunk inside A only.
    expect(isMixedChunk(0, 4_000, [a, b])).toBe(false);
    // A chunk spanning the change with real overlap on both sides.
    expect(isMixedChunk(8_000, 11_000, [a, b])).toBe(true);
    // Same speaker, two turns: never mixed.
    expect(
      isMixedChunk(0, 10_000, [turn("A", 0, 4_900), turn("A", 5_100, 10_000)]),
    ).toBe(false);
    // The second speaker only touches the edge within the snap window
    // (a 250 ms sliver) — the sanctioned cut artifact, not mixed.
    expect(isMixedChunk(8_500, 10_500, [a, turn("B", 10_250, 12_000)])).toBe(
      false,
    );
    // A 350 ms sliver of the second speaker IS beyond the window.
    expect(isMixedChunk(8_500, 10_500, [a, turn("B", 10_100, 12_000)])).toBe(
      true,
    );
  });
});
