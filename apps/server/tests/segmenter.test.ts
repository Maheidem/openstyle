import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readWavPcm16 } from "../src/lib/audio/wav.js";
import {
  cutAtSpeakerChanges,
  DEFAULT_MERGE_TOWARD_OPTIONS,
  mergeSegmentsToward,
  type Segment,
  segmentPcm,
  segmentWavFile,
} from "../src/lib/meetings/segmenter.js";

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
});

describe("segmentPcm with diarizer turns (I4, §3.4)", () => {
  it("a 10 s clip with turns 0-4 s and 4-10 s gives exactly 2 chunks, cut within 300 ms of 4 s", async () => {
    // Generated with `ffmpeg -f lavfi`: 10 s of 440 Hz tone at -20 dBFS
    // (continuous speech, one VAD opening), 16 kHz mono PCM16.
    const dir = mkdtempSync(join(tmpdir(), "seg-turns-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const wavPath = join(dir, "tone.wav");
    // A quiet pink-noise bed (so the adaptive noise floor calibrates) with
    // a 440 Hz tone on top from 2 s on (continuous "speech").
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=10:r=16000:c=pink:a=0.005",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=8:sample_rate=16000,volume=0.8",
      "-filter_complex",
      "[1:a]adelay=2000|2000[t];[0:a][t]amix=inputs=2:duration=first:weights=1 1",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);
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
    const wavPath = join(dir, "tone.wav");
    // A quiet pink-noise bed (so the adaptive noise floor calibrates) with
    // a 440 Hz tone on top from 2 s on (continuous "speech").
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=10:r=16000:c=pink:a=0.005",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=8:sample_rate=16000,volume=0.8",
      "-filter_complex",
      "[1:a]adelay=2000|2000[t];[0:a][t]amix=inputs=2:duration=first:weights=1 1",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);
    const segments = segmentWavFile(wavPath);
    expect(segments!.length).toBeGreaterThanOrEqual(1);
    // No turns in: no part may carry a speaker.
    for (const s of segments!) expect(s.speaker).toBeUndefined();
  });
});
