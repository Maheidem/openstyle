import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { __resetDictationIdleStateForTests } from "../src/lib/dictation-activity.js";
import {
  type DetectAllFn,
  pickDeclaredLanguage,
  pickProbeSegment,
  readMeetingLanguage,
  resolveMeetingLanguage,
} from "../src/lib/meetings/language.js";
import { MLX_ASR_PROVIDER_ID } from "../src/lib/mlx-asr/constants.js";
import type {
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../src/lib/streaming/types.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";
import { buildWav } from "./helpers/wav.js";

const SAMPLE_RATE = 16_000;
/** Minimal 44-byte-header mono s16 WAV of the given duration, silent. */
function writeWav(path: string, durationMs: number): void {
  const samples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  writeFileSync(path, buildWav({ samples }));
}

function makeAudioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-lang-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeWav(join(dir, "mic.wav"), 5000);
  writeWav(join(dir, "system.wav"), 5000);
  return dir;
}

function setDeclaredLanguages(codes: string[]): void {
  writeSetting("languages", JSON.stringify(codes));
}

function insertMeeting(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO meetings (id, status, created_at) VALUES (?, 'transcribed', ?)`,
    )
    .run(id, Date.now());
}

function makeProvider(
  impl: (opts: TranscribeOptions) => Promise<TranscribeResult>,
): { provider: TranscriptionProvider; calls: TranscribeOptions[] } {
  const calls: TranscribeOptions[] = [];
  return {
    provider: {
      providerId: "fake",
      supportsStreaming: () => false,
      async transcribe(opts) {
        calls.push(opts);
        return impl(opts);
      },
    },
    calls,
  };
}

type ResolveArgs = Parameters<typeof resolveMeetingLanguage>[0];

/** Call `resolveMeetingLanguage` for meeting "m1" with one 3 s mic segment.
 * Each test overrides only what it needs. */
function run(
  overrides: Pick<ResolveArgs, "provider"> & Partial<ResolveArgs>,
): ReturnType<typeof resolveMeetingLanguage> {
  return resolveMeetingLanguage({
    meetingId: "m1",
    audioDir: makeAudioDir(),
    config: { providerId: "fake", modelId: "m", apiKey: "k" },
    micSegments: [{ startMs: 0, endMs: 3000 }],
    systemSegments: [],
    ...overrides,
  });
}

afterEach(() => {
  resetMeetingTables();
  deleteSetting("languages");
  __resetDictationIdleStateForTests();
});

describe("pickProbeSegment", () => {
  it("picks the longest early segment across both channels", () => {
    const mic = [
      { startMs: 0, endMs: 500 },
      { startMs: 1000, endMs: 4000 },
    ];
    const system = [{ startMs: 0, endMs: 2000 }];
    expect(pickProbeSegment(mic, system)).toEqual({
      source: "mic",
      startMs: 1000,
      endMs: 4000,
    });
  });

  it("falls back to whatever exists when nothing meets the 1s minimum", () => {
    const mic = [{ startMs: 0, endMs: 300 }];
    expect(pickProbeSegment(mic, [])).toEqual({
      source: "mic",
      startMs: 0,
      endMs: 300,
    });
  });

  it("returns null when both channels are empty", () => {
    expect(pickProbeSegment([], [])).toBeNull();
  });
});

describe("pickDeclaredLanguage", () => {
  const detectAll: DetectAllFn = () => [
    { lang: "en", accuracy: 0.9 },
    { lang: "pt", accuracy: 0.1 },
  ];

  it("picks the highest-ranked candidate in the declared set", () => {
    expect(pickDeclaredLanguage("some text", ["en", "pt"], detectAll)).toBe(
      "en",
    );
  });

  it("scans past the top match to a lower-ranked declared candidate", () => {
    // Top match "en" is not declared; "pt" (rank 2) is.
    expect(pickDeclaredLanguage("some text", ["pt"], detectAll)).toBe("pt");
  });

  it("returns null when no ranked candidate is in the declared set", () => {
    expect(pickDeclaredLanguage("some text", ["de"], detectAll)).toBeNull();
  });
});

describe("resolveMeetingLanguage", () => {
  it("pins immediately with one declared language, no probe call", async () => {
    setDeclaredLanguages(["pt"]);
    insertMeeting("m1");
    const { provider, calls } = makeProvider(async () => ({ text: "" }));
    const result = await run({ provider });
    expect(result).toBe("pt");
    expect(calls).toHaveLength(0);
    expect(readMeetingLanguage("m1")).toBe("pt");
  });

  it("returns undefined and leaves meetings.language untouched when no languages are declared", async () => {
    setDeclaredLanguages([]);
    insertMeeting("m1");
    const { provider, calls } = makeProvider(async () => ({ text: "" }));
    const result = await run({ provider });
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(readMeetingLanguage("m1")).toBeUndefined();
  });

  it("short-circuits when meetings.language is already set — provider never called", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    getDb()
      .prepare("UPDATE meetings SET language = 'pt' WHERE id = 'm1'")
      .run();
    const { provider, calls } = makeProvider(async () => ({ text: "hello" }));
    const result = await run({ provider });
    expect(result).toBe("pt");
    expect(calls).toHaveLength(0);
  });

  it("resolves via text-based LID when two languages are declared", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    const { provider, calls } = makeProvider(async () => ({
      text: "oi tudo bem com voce",
    }));
    const detectAll: DetectAllFn = () => [
      { lang: "pt", accuracy: 0.8 },
      { lang: "en", accuracy: 0.05 },
    ];
    const result = await run({ provider, detectAll });
    expect(result).toBe("pt");
    expect(calls).toHaveLength(1);
    // Probe never biases and never pins a language of its own.
    expect(calls[0].bias).toBeNull();
    expect(calls[0].language).toBeUndefined();
    expect(readMeetingLanguage("m1")).toBe("pt");
  });

  it("scans past the top LID match to a lower-ranked declared candidate", async () => {
    setDeclaredLanguages(["pt"].concat(["en"]));
    insertMeeting("m1");
    const { provider } = makeProvider(async () => ({ text: "some text" }));
    // Top match "de" is not declared; "en" further down is.
    const detectAll: DetectAllFn = () => [
      { lang: "de", accuracy: 0.5 },
      { lang: "en", accuracy: 0.2 },
    ];
    const result = await run({ provider, detectAll });
    expect(result).toBe("en");
  });

  it("falls back to declared[0] and never throws when the probe transcription fails", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    const { provider } = makeProvider(async () => {
      throw new Error("provider down");
    });
    const result = await run({ provider });
    expect(result).toBe("en");
    expect(readMeetingLanguage("m1")).toBe("en");
  });

  it("falls back to declared[0] with no probe attempted when no segments exist", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    const { provider, calls } = makeProvider(async () => ({ text: "hi" }));
    const result = await run({ provider, micSegments: [] });
    expect(result).toBe("en");
    expect(calls).toHaveLength(0);
  });

  it("falls back to declared[0] when the probe transcribes to empty text", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    const { provider } = makeProvider(async () => ({ text: "   " }));
    const result = await run({ provider });
    expect(result).toBe("en");
  });

  // I3 (specs/meeting-transcription-v2.md §3.3): a meeting model that
  // differs from the dictation model yields to active dictation before the
  // language probe (same lease as chunk transcription); the dictation
  // model itself never waits.
  it("waits out active dictation for a different local-mlx model (I3)", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    const { provider, calls } = makeProvider(async () => ({ text: "oi" }));
    let active = true;
    const detectAll: DetectAllFn = () => [{ lang: "pt", accuracy: 0.9 }];
    const promise = run({
      provider,
      detectAll,
      config: {
        providerId: MLX_ASR_PROVIDER_ID,
        modelId: "mlx/meeting-model",
        apiKey: "k",
        differsFromDictation: true,
      },
      isDictationActive: () => active,
    });
    // Dictation stays active across several polls: the probe must not
    // have started yet.
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(0);
    active = false;
    // Then the full 15 s idle window after the last active observation.
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await promise;
    expect(result).toBe("pt");
    expect(calls).toHaveLength(1);
  });

  it("never consults the dictation lease for the dictation model itself (I3)", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    const { provider, calls } = makeProvider(async () => ({ text: "oi" }));
    let asked = 0;
    const detectAll: DetectAllFn = () => [{ lang: "pt", accuracy: 0.9 }];
    const result = await run({
      provider,
      detectAll,
      config: {
        providerId: MLX_ASR_PROVIDER_ID,
        modelId: "mlx/dictation-model",
        apiKey: "k",
        differsFromDictation: false,
      },
      // Even with dictation reported active, the probe must run at once.
      isDictationActive: () => {
        asked++;
        return true;
      },
    });
    expect(result).toBe("pt");
    expect(calls).toHaveLength(1);
    expect(asked).toBe(0);
  });
});
