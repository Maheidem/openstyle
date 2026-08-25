import { describe, expect, it } from "vitest";
import { type Segment, segmentPcm } from "../src/lib/meetings/segmenter.js";

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
