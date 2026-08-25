import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ChunkResult,
  MeetingTranscriber,
  parseWavHeader,
  type SttConfig,
  sliceWav,
  type TranscriberDeps,
} from "../src/lib/meetings/transcriber.js";
import type {
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../src/lib/streaming/types.js";
import { WHISPER_PROVIDER_ID } from "../src/lib/whisper/constants.js";

const SAMPLE_RATE = 16_000;
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write a canonical 44-byte-header mono s16 WAV whose sample values ramp. */
function writeWav(path: string, durationMs: number, extraChunk = false): void {
  const samples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const dataBytes = samples * 2;
  const chunks: Buffer[] = [];

  const data = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples; i++) data.writeInt16LE(i % 32768, i * 2);

  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(SAMPLE_RATE, 12);
  fmt.writeUInt32LE(SAMPLE_RATE * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(dataBytes, 4);

  // Optional LIST chunk between fmt and data to exercise chunk walking.
  let list = Buffer.alloc(0);
  if (extraChunk) {
    list = Buffer.alloc(12);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(4, 4);
    list.write("INFO", 8, "ascii");
  }

  const body = Buffer.concat([fmt, list, dataHeader, data]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WAVE", 8, "ascii");
  chunks.push(riff, body);
  writeFileSync(path, Buffer.concat(chunks));
}

function makeMeetingDir(durations: { mic: number; system: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-test-"));
  dirs.push(dir);
  writeWav(join(dir, "mic.wav"), durations.mic);
  writeWav(join(dir, "system.wav"), durations.system);
  return dir;
}

interface FakeCall {
  bytes: number;
  model: string;
  bias: unknown;
  language?: string;
  startedAt: number;
}

/** Fake provider: records calls, returns canned text, can fail N times. */
function makeFakeProvider(
  opts: {
    providerId?: string;
    failFirst?: number;
    failWith?: () => Error;
    delayTicks?: number;
    onCall?: () => void | Promise<void>;
  } = {},
) {
  const calls: FakeCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failures = opts.failFirst ?? 0;

  const provider: TranscriptionProvider = {
    providerId: opts.providerId ?? "fake",
    supportsStreaming: () => false,
    async transcribe(o: TranscribeOptions): Promise<TranscribeResult> {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        calls.push({
          bytes: o.audio.length,
          model: o.model,
          bias: o.bias,
          ...(o.language ? { language: o.language } : {}),
          startedAt: Date.now(),
        });
        await opts.onCall?.();
        // Yield so concurrent workers actually overlap.
        await Promise.resolve();
        if (failures > 0) {
          failures--;
          throw opts.failWith?.() ?? new Error("boom");
        }
        return { text: `text-${calls.length}` };
      } finally {
        inFlight--;
      }
    },
  };
  return { provider, calls, maxInFlight: () => maxInFlight };
}

function makeDeps(
  provider: TranscriptionProvider,
  overrides: Partial<TranscriberDeps> = {},
  config: Partial<SttConfig> = {},
): TranscriberDeps {
  return {
    getProvider: (id) => (id === provider.providerId ? provider : null),
    resolveConfig: () => ({
      providerId: provider.providerId,
      modelId: "model-x",
      apiKey: "key",
      language: "en",
      bias: { kind: "prompt", text: "vocab" },
      ...config,
    }),
    sleep: () => Promise.resolve(),
    backoffBaseMs: 0,
    ...overrides,
  };
}

describe("MeetingTranscriber", () => {
  it("slices WAV segments at the right byte offsets and durations", async () => {
    const dir = makeMeetingDir({ mic: 5000, system: 3000 });
    const { provider, calls } = makeFakeProvider();
    const t = new MeetingTranscriber(makeDeps(provider));

    const results = await t.run({
      meetingDir: dir,
      micSegments: [
        { startMs: 1000, endMs: 2000 },
        { startMs: 2500, endMs: 4500 },
      ],
      systemSegments: [{ startMs: 0, endMs: 3000 }],
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    // 1 s mono s16 @16k = 32000 data bytes + 44 header.
    const bytes = calls.map((c) => c.bytes).sort((a, b) => a - b);
    expect(bytes).toEqual([32_000 + 44, 64_000 + 44, 96_000 + 44]);
    // Every call carried dictation's model + bias + language.
    for (const c of calls) {
      expect(c.model).toBe("model-x");
      expect(c.bias).toEqual({ kind: "prompt", text: "vocab" });
      expect(c.language).toBe("en");
    }
  });

  it("sliced audio contains the samples from the correct offset", async () => {
    const dir = makeMeetingDir({ mic: 2000, system: 100 });
    const fd = openSync(join(dir, "mic.wav"), "r");
    try {
      const info = parseWavHeader(fd);
      const wav = sliceWav(fd, info, 1000, 1500);
      // 500 ms → 8000 samples; first sample is sample index 16000 → 16000 % 32768.
      expect(wav.length).toBe(44 + 8000 * 2);
      const first = Buffer.from(wav).readInt16LE(44);
      expect(first).toBe(16_000 % 32_768);
      // Header declares 16 kHz mono s16.
      const b = Buffer.from(wav);
      expect(b.readUInt32LE(24)).toBe(SAMPLE_RATE);
      expect(b.readUInt16LE(22)).toBe(1);
      expect(b.readUInt16LE(34)).toBe(16);
    } finally {
      closeSync(fd);
    }
  });

  it("parses a WAV with an extra chunk before data", () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-test-"));
    dirs.push(dir);
    const path = join(dir, "extra.wav");
    writeWav(path, 100, true);
    const fd = openSync(path, "r");
    try {
      const info = parseWavHeader(fd);
      expect(info.sampleRate).toBe(SAMPLE_RATE);
      expect(info.dataLength).toBe(Math.round(0.1 * SAMPLE_RATE) * 2);
      // 12 (RIFF) + 24 (fmt) + 12 (LIST) + 8 (data header)
      expect(info.dataOffset).toBe(56);
    } finally {
      closeSync(fd);
    }
  });

  it("caps concurrency at 2 for cloud providers", async () => {
    const dir = makeMeetingDir({ mic: 10_000, system: 100 });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const { provider, maxInFlight } = makeFakeProvider({
      onCall: async () => {
        started++;
        if (started === 2) release();
        await gate;
      },
    });
    const t = new MeetingTranscriber(makeDeps(provider));
    const results = await t.run({
      meetingDir: dir,
      micSegments: [
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2000 },
        { startMs: 2000, endMs: 3000 },
        { startMs: 3000, endMs: 4000 },
      ],
      systemSegments: [],
    });
    expect(results).toHaveLength(4);
    expect(maxInFlight()).toBe(2);
  });

  it("runs whisper-local serially (concurrency 1)", async () => {
    const dir = makeMeetingDir({ mic: 5000, system: 100 });
    const { provider, maxInFlight } = makeFakeProvider({
      providerId: WHISPER_PROVIDER_ID,
    });
    const t = new MeetingTranscriber(makeDeps(provider));
    await t.run({
      meetingDir: dir,
      micSegments: [
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2000 },
        { startMs: 2000, endMs: 3000 },
      ],
      systemSegments: [],
    });
    expect(maxInFlight()).toBe(1);
  });

  it("retries failures and succeeds within the retry budget", async () => {
    const dir = makeMeetingDir({ mic: 2000, system: 100 });
    const { provider, calls } = makeFakeProvider({ failFirst: 2 });
    const slept: number[] = [];
    const t = new MeetingTranscriber(
      makeDeps(provider, {
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
        backoffBaseMs: 100,
      }),
    );
    const results = await t.run({
      meetingDir: dir,
      micSegments: [{ startMs: 0, endMs: 1000 }],
      systemSegments: [],
    });
    expect(results[0].status).toBe("ok");
    expect(calls).toHaveLength(3);
    // Exponential backoff: base, base*2.
    expect(slept).toEqual([100, 200]);
  });

  it("honors Retry-After on 429 errors", async () => {
    const dir = makeMeetingDir({ mic: 2000, system: 100 });
    const err = () =>
      Object.assign(new Error("rate limited"), {
        status: 429,
        retryAfterMs: 1234,
      });
    const { provider } = makeFakeProvider({ failFirst: 1, failWith: err });
    const slept: number[] = [];
    const t = new MeetingTranscriber(
      makeDeps(provider, {
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
        backoffBaseMs: 100,
      }),
    );
    const results = await t.run({
      meetingDir: dir,
      micSegments: [{ startMs: 0, endMs: 1000 }],
      systemSegments: [],
    });
    expect(results[0].status).toBe("ok");
    expect(slept).toEqual([1234]);
  });

  it("marks a chunk failed after exhausting retries without aborting the run", async () => {
    const dir = makeMeetingDir({ mic: 3000, system: 100 });
    // Serial (whisper-local) so the failure budget hits the first chunk only.
    const { provider, calls } = makeFakeProvider({
      failFirst: 3,
      providerId: WHISPER_PROVIDER_ID,
    });
    const chunks: ChunkResult[] = [];
    const progress: number[] = [];
    const t = new MeetingTranscriber(
      makeDeps(provider, {
        onChunk: (c) => chunks.push(c),
        onProgress: (p) => progress.push(p.done),
        maxAttempts: 3,
      }),
    );
    const results = await t.run({
      meetingDir: dir,
      micSegments: [
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2000 },
      ],
      systemSegments: [],
    });
    // First chunk burns all 3 attempts and fails; second succeeds.
    expect(results[0]).toMatchObject({
      status: "failed",
      text: "",
      idx: 0,
      source: "mic",
    });
    expect(results[1].status).toBe("ok");
    expect(calls).toHaveLength(4);
    expect(chunks).toHaveLength(2);
    expect(progress).toEqual([1, 2]);
  });

  it("pauses for active dictation and resumes after the idle window (whisper-local)", async () => {
    const dir = makeMeetingDir({ mic: 2000, system: 100 });
    const { provider, calls } = makeFakeProvider({
      providerId: WHISPER_PROVIDER_ID,
    });

    let clock = 0;
    // Dictation is active until t=1000.
    const isDictationActive = () => clock < 1000;
    const t = new MeetingTranscriber(
      makeDeps(provider, {
        isDictationActive,
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
        dictationIdleResumeMs: 15_000,
        dictationPollMs: 500,
      }),
    );
    const results = await t.run({
      meetingDir: dir,
      micSegments: [{ startMs: 0, endMs: 1000 }],
      systemSegments: [],
    });
    expect(results[0].status).toBe("ok");
    // Last active observation is at some t in [500, 1000); resume waits a
    // full 15 s idle window after it.
    expect(calls[0].startedAt).toBeGreaterThanOrEqual(0);
    expect(clock).toBeGreaterThanOrEqual(15_000);
    expect(clock).toBeLessThan(17_000);
  });

  it("does not consult the dictation lease for cloud providers", async () => {
    const dir = makeMeetingDir({ mic: 2000, system: 100 });
    const { provider } = makeFakeProvider();
    let asked = 0;
    const t = new MeetingTranscriber(
      makeDeps(provider, {
        isDictationActive: () => {
          asked++;
          return true;
        },
      }),
    );
    const results = await t.run({
      meetingDir: dir,
      micSegments: [{ startMs: 0, endMs: 1000 }],
      systemSegments: [],
    });
    expect(results[0].status).toBe("ok");
    expect(asked).toBe(0);
  });

  it("throws for an unknown provider", async () => {
    const dir = makeMeetingDir({ mic: 1000, system: 100 });
    const { provider } = makeFakeProvider();
    const t = new MeetingTranscriber(
      makeDeps(provider, {
        getProvider: () => null,
      }),
    );
    await expect(
      t.run({
        meetingDir: dir,
        micSegments: [{ startMs: 0, endMs: 500 }],
        systemSegments: [],
      }),
    ).rejects.toThrow(/Unsupported transcription provider/);
  });
});
