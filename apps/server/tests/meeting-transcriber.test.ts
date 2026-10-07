import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import {
  type ChunkResult,
  createDefaultTranscriberDeps,
  MeetingTranscriber,
  parseWavHeader,
  type SttConfig,
  sliceWav,
  type TranscriberDeps,
} from "../src/lib/meetings/transcriber.js";
import { MLX_ASR_PROVIDER_ID } from "../src/lib/mlx-asr/constants.js";
import type {
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../src/lib/streaming/types.js";
import { WHISPER_PROVIDER_ID } from "../src/lib/whisper/constants.js";
import { buildWav } from "./helpers/wav.js";

const SAMPLE_RATE = 16_000;
/** Write a canonical 44-byte-header mono s16 WAV whose sample values ramp. */
function writeWav(path: string, durationMs: number, extraChunk = false): void {
  const samples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const wav = buildWav({
    samples,
    // Optional LIST chunk between fmt and data to exercise chunk walking.
    listChunk: extraChunk,
    fill: (data) => {
      for (let i = 0; i < samples; i++) data.writeInt16LE(i % 32768, i * 2);
    },
  });
  writeFileSync(path, wav);
}

function makeMeetingDir(durations: { mic: number; system: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
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
    /** Called (with the call's audio byte count) while the call is in
     * flight — a gate or delay here holds the worker. */
    onCall?: (bytes: number) => void | Promise<void>;
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
        await opts.onCall?.(o.audio.length);
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

type RunInput = Parameters<MeetingTranscriber["run"]>[0];

/** Run the transcriber on `dir`. `systemSegments` is empty unless a test sets it. */
function run(
  t: MeetingTranscriber,
  dir: string,
  overrides: Pick<RunInput, "micSegments"> & Partial<RunInput>,
): ReturnType<MeetingTranscriber["run"]> {
  return t.run({ meetingDir: dir, systemSegments: [], ...overrides });
}

describe("MeetingTranscriber", () => {
  it("slices WAV segments at the right byte offsets and durations", async () => {
    const dir = makeMeetingDir({ mic: 8500, system: 5000 });
    const { provider, calls } = makeFakeProvider();
    const t = new MeetingTranscriber(makeDeps(provider));

    // Durations kept >= MIN_BIAS_DURATION_MS (3s, Phase A3) so this test's
    // "every call carried bias" assertion below stays meaningful — the
    // bias-withholding behavior itself is covered separately.
    const results = await run(t, dir, {
      micSegments: [
        { startMs: 1000, endMs: 4000 },
        { startMs: 4200, endMs: 8200 },
      ],
      systemSegments: [{ startMs: 0, endMs: 5000 }],
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    // 1 s mono s16 @16k = 32000 data bytes + 44 header.
    const bytes = calls.map((c) => c.bytes).sort((a, b) => a - b);
    expect(bytes).toEqual([96_000 + 44, 128_000 + 44, 160_000 + 44]);
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
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
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

  // Phase 3a (specs/meeting-transcription-v2.md §3.1): lanes. Every test
  // below uses distinct chunk durations so a call's audio byte count
  // identifies its chunk (1 s = 32 044 bytes, +32 000 per second).
  it("runs the two lanes in parallel: one chunk in flight per lane, each lane starts with its first chunk (phase 3a)", async () => {
    const dir = makeMeetingDir({ mic: 5000, system: 9000 });
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let started = 0;
    const { provider, calls, maxInFlight } = makeFakeProvider({
      onCall: async () => {
        started++;
        if (started === 2) release();
        await gate;
      },
    });
    const t = new MeetingTranscriber(makeDeps(provider));
    const runPromise = t.run({
      meetingDir: dir,
      micSegments: [
        { startMs: 0, endMs: 1000 }, // 32 044 bytes
        { startMs: 2000, endMs: 4000 }, // 64 044
      ],
      systemSegments: [
        { startMs: 0, endMs: 3000 }, // 96 044
        { startMs: 4000, endMs: 8000 }, // 128 044
      ],
    });
    // Both lanes have a chunk in flight — the gate released at 2.
    await gate;
    expect(started).toBe(2);
    // One chunk from each lane: mic[0] then system[0]. The old pool would
    // hold the first two tasks, both mic (32 044 then 64 044).
    expect(calls.slice(0, 2).map((c) => c.bytes)).toEqual([32_044, 96_044]);
    release();
    const results = await runPromise;
    expect(results).toHaveLength(4);
    expect(maxInFlight()).toBe(2);
  });

  it("keeps chunk order within each lane: the next chunk starts only after the previous one finishes (phase 3a)", async () => {
    const dir = makeMeetingDir({ mic: 5000, system: 9000 });
    // Each chunk has a distinct byte count; bytes < 96 044 are mic.
    // The first chunk of each lane is held on its own gate — a lane that
    // ran its chunks in parallel would start its second chunk while the
    // first is still in flight.
    const { promise: micGate, resolve: releaseMic } =
      Promise.withResolvers<void>();
    const { promise: sysGate, resolve: releaseSys } =
      Promise.withResolvers<void>();
    const { promise: bothStarted, resolve: announceBoth } =
      Promise.withResolvers<void>();
    let micFirst = true;
    let sysFirst = true;
    const startedBytes: number[] = [];
    const { provider } = makeFakeProvider({
      onCall: async (bytes) => {
        startedBytes.push(bytes);
        if (bytes < 96_044) {
          if (micFirst) {
            micFirst = false;
            if (!sysFirst) announceBoth();
            await micGate;
          }
        } else if (sysFirst) {
          sysFirst = false;
          if (!micFirst) announceBoth();
          await sysGate;
        }
      },
    });
    const t = new MeetingTranscriber(makeDeps(provider));
    const runPromise = t.run({
      meetingDir: dir,
      micSegments: [
        { startMs: 0, endMs: 1000 }, // 32 044 bytes
        { startMs: 2000, endMs: 4000 }, // 64 044
      ],
      systemSegments: [
        { startMs: 0, endMs: 3000 }, // 96 044
        { startMs: 4000, endMs: 8000 }, // 128 044
      ],
    });
    // Both lanes have a chunk in flight — one per lane, in lane order.
    await bothStarted;
    expect(startedBytes).toEqual([32_044, 96_044]);
    releaseMic();
    releaseSys();
    const results = await runPromise;
    expect(results).toHaveLength(4);
    // Start order within each lane is the chunk order.
    expect(startedBytes.filter((b) => b < 96_044)).toEqual([32_044, 64_044]);
    expect(startedBytes.filter((b) => b >= 96_044)).toEqual([96_044, 128_044]);
  });

  it("lanes: false keeps the old shared cursor and pool (phase 3a)", async () => {
    const dir = makeMeetingDir({ mic: 5000, system: 9000 });
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let started = 0;
    const { provider, calls, maxInFlight } = makeFakeProvider({
      onCall: async () => {
        started++;
        if (started === 2) release();
        await gate;
      },
    });
    const t = new MeetingTranscriber(makeDeps(provider));
    const runPromise = t.run({
      meetingDir: dir,
      micSegments: [
        { startMs: 0, endMs: 1000 }, // 32 044 bytes
        { startMs: 2000, endMs: 4000 }, // 64 044
      ],
      systemSegments: [
        { startMs: 0, endMs: 3000 }, // 96 044
        { startMs: 4000, endMs: 8000 }, // 128 044
      ],
      lanes: false,
    });
    await gate;
    // The old pool takes the first two tasks — both mic — while the lanes
    // path would hold one chunk per lane (mic[0] and system[0]).
    expect(calls.slice(0, 2).map((c) => c.bytes)).toEqual([32_044, 64_044]);
    release();
    const results = await runPromise;
    expect(results).toHaveLength(4);
    expect(results.every((r) => r?.status === "ok")).toBe(true);
    expect(maxInFlight()).toBe(2);
  });

  it("shouldStop stops each lane between chunk tasks: in-flight chunks finish, unstarted chunks never run (holes in results) (phase 3a)", async () => {
    const dir = makeMeetingDir({ mic: 10_000, system: 10_000 });
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let started = 0;
    const { provider, calls } = makeFakeProvider({
      onCall: async () => {
        started++;
        if (started === 2) release();
        await gate;
      },
    });
    let stop = false;
    const onChunk: ChunkResult[] = [];
    const t = new MeetingTranscriber(
      makeDeps(provider, {
        shouldStop: () => stop,
        onChunk: (c) => onChunk.push(c),
      }),
    );
    const runPromise = t.run({
      meetingDir: dir,
      micSegments: [
        { startMs: 0, endMs: 1000 },
        { startMs: 2000, endMs: 3000 },
      ],
      systemSegments: [
        { startMs: 0, endMs: 1000 },
        { startMs: 2000, endMs: 3000 },
      ],
    });
    // Wait until both lanes have a chunk in flight, then cancel.
    await gate;
    stop = true;
    release();
    const results = await runPromise;
    // Only the two in-flight chunks ran (one per lane); their results
    // (and only theirs) are present, the rest are holes.
    expect(calls).toHaveLength(2);
    expect(onChunk).toHaveLength(2);
    expect(results).toHaveLength(4);
    expect(results.filter((r) => r !== undefined)).toHaveLength(2);
    expect(results[1]).toBeUndefined();
    expect(results[3]).toBeUndefined();
  });

  it("runs whisper-local serially (concurrency 1)", async () => {
    const dir = makeMeetingDir({ mic: 5000, system: 100 });
    const { provider, maxInFlight } = makeFakeProvider({
      providerId: WHISPER_PROVIDER_ID,
    });
    const t = new MeetingTranscriber(makeDeps(provider));
    await run(t, dir, {
      micSegments: [
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2000 },
        { startMs: 2000, endMs: 3000 },
      ],
    });
    expect(maxInFlight()).toBe(1);
  });

  it("runs local-whisper lane by lane: the mic lane first, then the system lane, one at a time (phase 3a)", async () => {
    const dir = makeMeetingDir({ mic: 5000, system: 9000 });
    const { provider, calls, maxInFlight } = makeFakeProvider({
      providerId: WHISPER_PROVIDER_ID,
    });
    const t = new MeetingTranscriber(makeDeps(provider));
    const results = await t.run({
      meetingDir: dir,
      micSegments: [
        { startMs: 0, endMs: 1000 }, // 32 044 bytes
        { startMs: 2000, endMs: 4000 }, // 64 044
      ],
      systemSegments: [
        { startMs: 0, endMs: 3000 }, // 96 044
        { startMs: 4000, endMs: 8000 }, // 128 044
      ],
    });
    expect(results).toHaveLength(4);
    // Same order as today's single pool: all mic chunks, then system.
    expect(calls.map((c) => c.bytes)).toEqual([
      32_044, 64_044, 96_044, 128_044,
    ]);
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
    const results = await run(t, dir, {
      micSegments: [{ startMs: 0, endMs: 1000 }],
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
    const results = await run(t, dir, {
      micSegments: [{ startMs: 0, endMs: 1000 }],
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
    const results = await run(t, dir, {
      micSegments: [
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2000 },
      ],
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
    const results = await run(t, dir, {
      micSegments: [{ startMs: 0, endMs: 1000 }],
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
    const results = await run(t, dir, {
      micSegments: [{ startMs: 0, endMs: 1000 }],
    });
    expect(results[0].status).toBe("ok");
    expect(asked).toBe(0);
  });

  it("withholds bias for chunks under MIN_BIAS_DURATION_MS (Phase A3)", async () => {
    const dir = makeMeetingDir({ mic: 5000, system: 100 });
    const { provider, calls } = makeFakeProvider();
    const t = new MeetingTranscriber(makeDeps(provider));
    await run(t, dir, {
      micSegments: [
        { startMs: 0, endMs: 1700 }, // 1.7s — under threshold
        { startMs: 2000, endMs: 5000 }, // 3s — at threshold, bias sent
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].bias).toBeNull();
    expect(calls[1].bias).toEqual({ kind: "prompt", text: "vocab" });
  });

  it("returns status 'empty' (not 'ok') for a chunk that transcribes to blank text (Phase A4)", async () => {
    const dir = makeMeetingDir({ mic: 2000, system: 100 });
    const provider: TranscriptionProvider = {
      providerId: "fake",
      supportsStreaming: () => false,
      async transcribe() {
        return { text: "   " };
      },
    };
    const t = new MeetingTranscriber(makeDeps(provider));
    const results = await run(t, dir, {
      micSegments: [{ startMs: 0, endMs: 1000 }],
    });
    expect(results[0].status).toBe("empty");
    expect(results[0].text).toBe("");
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
      run(t, dir, { micSegments: [{ startMs: 0, endMs: 500 }] }),
    ).rejects.toThrow(/Unsupported transcription provider/);
  });

  it("yields to active dictation for local-mlx when the model differs from the dictation model (I3)", async () => {
    const dir = makeMeetingDir({ mic: 2000, system: 100 });
    const { provider } = makeFakeProvider({
      providerId: MLX_ASR_PROVIDER_ID,
    });
    let clock = 0;
    const isDictationActive = () => clock < 1000;
    const t = new MeetingTranscriber(
      makeDeps(
        provider,
        {
          isDictationActive,
          now: () => clock,
          sleep: (ms) => {
            clock += ms;
            return Promise.resolve();
          },
          dictationIdleResumeMs: 15_000,
          dictationPollMs: 500,
        },
        { differsFromDictation: true },
      ),
    );
    const results = await run(t, dir, {
      micSegments: [{ startMs: 0, endMs: 1000 }],
    });
    expect(results[0].status).toBe("ok");
    // Dictation was active until t=1000; the call may only start after a
    // full 15 s idle window — same contract as the whisper-local test.
    expect(clock).toBeGreaterThanOrEqual(15_000);
    expect(clock).toBeLessThan(17_000);
  });

  it("does not consult the dictation lease for local-mlx when the model IS the dictation model (I3)", async () => {
    const dir = makeMeetingDir({ mic: 2000, system: 100 });
    const { provider } = makeFakeProvider({
      providerId: MLX_ASR_PROVIDER_ID,
    });
    let asked = 0;
    const t = new MeetingTranscriber(
      makeDeps(
        provider,
        {
          isDictationActive: () => {
            asked++;
            return true;
          },
        },
        { differsFromDictation: false },
      ),
    );
    const results = await run(t, dir, {
      micSegments: [{ startMs: 0, endMs: 1000 }],
    });
    expect(results[0].status).toBe("ok");
    expect(asked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createDefaultTranscriberDeps — I3 (specs/meeting-transcription-v2.md §3.3)
// model resolution: row override > meeting_stt_model setting > default voice
// ---------------------------------------------------------------------------

function setDefaultVoice(
  provider: string,
  modelId: string,
  modelName = "Voice",
): void {
  const db = getDb();
  db.prepare("DELETE FROM model_configs WHERE type = 'voice'").run();
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES (?, ?, ?, 'voice', 1)`,
  ).run(provider, modelId, modelName);
}

describe("createDefaultTranscriberDeps (meeting model, I3)", () => {
  afterEach(() => {
    deleteSetting("meeting_stt_model");
    const db = getDb();
    db.prepare("DELETE FROM model_configs WHERE type = 'voice'").run();
    db.prepare(
      "DELETE FROM api_keys WHERE provider IN ('openai', 'groq')",
    ).run();
    db.prepare("DELETE FROM vocabulary WHERE term = 'Qwen3'").run();
  });

  it("uses the stored meeting_stt_model over the default voice model", async () => {
    setDefaultVoice("local-mlx", "mlx/dictation-model");
    writeSetting(
      "meeting_stt_model",
      JSON.stringify({
        provider: "local-mlx",
        model_id: "mlx/meeting-model",
        model_name: "Meeting Model",
      }),
    );
    const config = (await createDefaultTranscriberDeps()).resolveConfig();
    expect(config.providerId).toBe("local-mlx");
    expect(config.modelId).toBe("mlx/meeting-model");
    expect(config.differsFromDictation).toBe(true);
  });

  // The default voice in these two tests is local-whisper, not local-mlx:
  // getDefaultModels() swaps an MLX default to local-whisper on machines that
  // are not Apple silicon (reconcileUnsupportedMlxVoiceDefault), and CI runs
  // on Linux.
  it("uses the default voice model when the row is missing, empty or bad JSON", async () => {
    setDefaultVoice("local-whisper", "whisper/dictation-model");
    for (const value of [undefined, "", "not json", '{"provider":"x"}']) {
      if (value === undefined) deleteSetting("meeting_stt_model");
      else writeSetting("meeting_stt_model", value);
      const config = (await createDefaultTranscriberDeps()).resolveConfig();
      expect(config.providerId).toBe("local-whisper");
      expect(config.modelId).toBe("whisper/dictation-model");
      expect(config.differsFromDictation).toBe(false);
    }
  });

  it("flags differsFromDictation false when the stored model equals the default", async () => {
    setDefaultVoice("local-whisper", "whisper/same-model");
    writeSetting(
      "meeting_stt_model",
      JSON.stringify({
        provider: "local-whisper",
        model_id: "whisper/same-model",
        model_name: "Same",
      }),
    );
    const config = (await createDefaultTranscriberDeps()).resolveConfig();
    expect(config.modelId).toBe("whisper/same-model");
    expect(config.differsFromDictation).toBe(false);
  });

  it("resolves the API key and vocabulary bias for the stored provider", async () => {
    setDefaultVoice("local-mlx", "mlx/dictation-model");
    getDb()
      .prepare(
        "INSERT INTO api_keys (provider, key) VALUES ('openai', 'sk-stored-test')",
      )
      .run();
    getDb().prepare("INSERT INTO vocabulary (term) VALUES ('Qwen3')").run();
    writeSetting(
      "meeting_stt_model",
      JSON.stringify({
        provider: "openai",
        model_id: "whisper-1",
        model_name: "OpenAI Whisper",
      }),
    );
    const config = (await createDefaultTranscriberDeps()).resolveConfig();
    expect(config.providerId).toBe("openai");
    expect(config.modelId).toBe("whisper-1");
    expect(config.apiKey).toBe("sk-stored-test");
    expect(config.differsFromDictation).toBe(true);
    // The bias is built for the STORED provider/model, not the default.
    expect(config.bias).toEqual({
      kind: "prompt",
      text: expect.stringContaining("Qwen3"),
    });
  });

  it("lets an explicit row override win over the setting (retry-failed, I3)", async () => {
    setDefaultVoice("local-mlx", "mlx/dictation-model");
    writeSetting(
      "meeting_stt_model",
      JSON.stringify({
        provider: "local-mlx",
        model_id: "mlx/meeting-model",
        model_name: "Meeting Model",
      }),
    );
    const deps = await createDefaultTranscriberDeps(
      {},
      { provider: "local-mlx", modelId: "mlx/row-model" },
    );
    const config = deps.resolveConfig();
    expect(config.modelId).toBe("mlx/row-model");
    expect(config.differsFromDictation).toBe(true);
  });
});
