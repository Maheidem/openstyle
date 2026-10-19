import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Segment } from "../src/lib/meetings/segmenter.js";
import {
  attachSpeechSpans,
  detectSpeechSpans,
  type VadDeps,
} from "../src/lib/meetings/vad.js";
import { buildWav } from "./helpers/wav.js";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-vad-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeDeps(
  stdout: string | Error,
  calls: Array<{ args: string[]; timeout?: number }> = [],
): VadDeps {
  return {
    resolveBinaryPath: () => "/fake/fluidaudio-diarize",
    resolveModelsDirPath: () => "/fake/models",
    execFile: async (_file, args, opts) => {
      calls.push({ args, timeout: opts.timeout });
      if (stdout instanceof Error) throw stdout;
      return { stdout, stderr: "" };
    },
  };
}

describe("attachSpeechSpans", () => {
  const segments: Segment[] = [
    { startMs: 0, endMs: 5000, voicedMs: 100 },
    { startMs: 5000, endMs: 10_000 },
    { startMs: 12_000, endMs: 15_000 },
  ];

  it("attaches the overlapping spans, clipped to each segment", () => {
    const out = attachSpeechSpans(segments, [
      { startMs: 1000, endMs: 2000 },
      { startMs: 4500, endMs: 6000 }, // crosses the 5000 ms boundary
      { startMs: 10_000, endMs: 12_000 }, // touches both edges, no overlap
    ]);
    expect(out[0]!.speechSpans).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 4500, endMs: 5000 },
    ]);
    expect(out[1]!.speechSpans).toEqual([{ startMs: 5000, endMs: 6000 }]);
    expect(out[2]!.speechSpans).toEqual([]);
  });

  it("keeps the segment times and other fields", () => {
    const out = attachSpeechSpans(segments, []);
    expect(out.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 5000],
      [5000, 10_000],
      [12_000, 15_000],
    ]);
    expect(out[0]!.voicedMs).toBe(100);
    expect(out.every((s) => Array.isArray(s.speechSpans))).toBe(true);
  });

  it("returns the segments unchanged for null spans (old path)", () => {
    const out = attachSpeechSpans(segments, null);
    expect(out).toBe(segments);
    expect(out.every((s) => s.speechSpans === undefined)).toBe(true);
  });
});

describe("detectSpeechSpans", () => {
  it("runs --vad with the models dir and parses the spans", async () => {
    const dir = tempDir();
    const wav = join(dir, "mic.wav");
    writeFileSync(wav, buildWav({ samples: 16 }));
    const calls: Array<{ args: string[]; timeout?: number }> = [];
    const spans = await detectSpeechSpans(
      wav,
      600_000,
      fakeDeps(
        '[{"startMs":3000,"endMs":4500},{"startMs":100,"endMs":900}]',
        calls,
      ),
    );
    expect(spans).toEqual([
      { startMs: 100, endMs: 900 },
      { startMs: 3000, endMs: 4500 },
    ]);
    expect(calls[0]!.args).toEqual([
      "--vad",
      wav,
      "--models-dir",
      "/fake/models",
    ]);
    // max(60 s, duration / 2)
    expect(calls[0]!.timeout).toBe(300_000);
  });

  it("uses the 60 s timeout floor and returns [] for no speech", async () => {
    const dir = tempDir();
    const wav = join(dir, "mic.wav");
    writeFileSync(wav, buildWav({ samples: 16 }));
    const calls: Array<{ args: string[]; timeout?: number }> = [];
    expect(await detectSpeechSpans(wav, 10_000, fakeDeps("[]", calls))).toEqual(
      [],
    );
    expect(calls[0]!.timeout).toBe(60_000);
  });

  it("passes an integer timeout for a fractional duration", async () => {
    // The system track duration can be fractional (425323.125 ms on a real
    // meeting); execFile throws ERR_OUT_OF_RANGE for a non-integer timeout.
    const dir = tempDir();
    const wav = join(dir, "system.wav");
    writeFileSync(wav, buildWav({ samples: 16 }));
    const calls: Array<{ args: string[]; timeout?: number }> = [];
    await detectSpeechSpans(wav, 425_323.125, fakeDeps("[]", calls));
    expect(calls[0]!.timeout).toBe(212_662);
    expect(Number.isInteger(calls[0]!.timeout)).toBe(true);
  });

  it("returns null and never throws on any failure", async () => {
    const dir = tempDir();
    const wav = join(dir, "mic.wav");
    writeFileSync(wav, buildWav({ samples: 16 }));
    // Missing wav.
    expect(
      await detectSpeechSpans(join(dir, "nope.wav"), 0, fakeDeps("[]")),
    ).toBeNull();
    // Missing binary.
    expect(
      await detectSpeechSpans(wav, 0, {
        ...fakeDeps("[]"),
        resolveBinaryPath: () => null,
      }),
    ).toBeNull();
    // Missing model.
    expect(
      await detectSpeechSpans(wav, 0, {
        ...fakeDeps("[]"),
        resolveModelsDirPath: () => null,
      }),
    ).toBeNull();
    // Helper failure, bad JSON, wrong shape.
    expect(
      await detectSpeechSpans(wav, 0, fakeDeps(new Error("ERR_VAD_FAILED"))),
    ).toBeNull();
    expect(await detectSpeechSpans(wav, 0, fakeDeps("not json"))).toBeNull();
    expect(await detectSpeechSpans(wav, 0, fakeDeps('{"a":1}'))).toBeNull();
    expect(
      await detectSpeechSpans(wav, 0, fakeDeps('[{"startMs":"x","endMs":2}]')),
    ).toBeNull();
  });
});
