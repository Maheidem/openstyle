import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseWavHeader, sliceWavSpans } from "../src/lib/audio/wav.js";
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

describe("sliceWavSpans", () => {
  it("joins the PCM of each span in order; the length is the sum of the spans", () => {
    const dir = tempDir();
    const path = join(dir, "a.wav");
    const samples = 16_000 * 4;
    writeFileSync(
      path,
      buildWav({
        samples,
        fill: (data) => {
          for (let i = 0; i < samples; i++) data.writeInt16LE(i % 32768, i * 2);
        },
      }),
    );
    const fd = openSync(path, "r");
    try {
      const info = parseWavHeader(fd);
      const out = Buffer.from(
        sliceWavSpans(fd, info, [
          { startMs: 1000, endMs: 1500 },
          { startMs: 3000, endMs: 3250 },
        ]),
      );
      const outInfo = parseWavHeader(out);
      // 500 ms + 250 ms at 16 kHz s16 mono.
      expect(outInfo.dataLength).toBe((8000 + 4000) * 2);
      expect(out.length).toBe(44 + (8000 + 4000) * 2);
      // First sample of each part comes from the span start.
      expect(out.readInt16LE(44)).toBe(16_000 % 32768);
      expect(out.readInt16LE(44 + 8000 * 2)).toBe(48_000 % 32768);
    } finally {
      closeSync(fd);
    }
  });
});
