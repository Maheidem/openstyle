import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db.js";
import {
  type DetectAllFn,
  pickDeclaredLanguage,
  pickProbeSegment,
  readMeetingLanguage,
  resolveMeetingLanguage,
} from "../src/lib/meetings/language.js";
import type {
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../src/lib/streaming/types.js";

const SAMPLE_RATE = 16_000;
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Minimal 44-byte-header mono s16 WAV of the given duration, silent. */
function writeWav(path: string, durationMs: number): void {
  const samples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const dataBytes = samples * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  writeFileSync(path, Buffer.concat([h, Buffer.alloc(dataBytes)]));
}

function makeAudioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-lang-test-"));
  dirs.push(dir);
  writeWav(join(dir, "mic.wav"), 5000);
  writeWav(join(dir, "system.wav"), 5000);
  return dir;
}

function setDeclaredLanguages(codes: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('languages', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(JSON.stringify(codes));
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

afterEach(() => {
  getDb().exec("DELETE FROM meetings");
  getDb().exec("DELETE FROM settings WHERE key = 'languages'");
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
    const result = await resolveMeetingLanguage({
      meetingId: "m1",
      audioDir: makeAudioDir(),
      provider,
      config: { providerId: "fake", modelId: "m", apiKey: "k" },
      micSegments: [{ startMs: 0, endMs: 3000 }],
      systemSegments: [],
    });
    expect(result).toBe("pt");
    expect(calls).toHaveLength(0);
    expect(readMeetingLanguage("m1")).toBe("pt");
  });

  it("returns undefined and leaves meetings.language untouched when no languages are declared", async () => {
    setDeclaredLanguages([]);
    insertMeeting("m1");
    const { provider, calls } = makeProvider(async () => ({ text: "" }));
    const result = await resolveMeetingLanguage({
      meetingId: "m1",
      audioDir: makeAudioDir(),
      provider,
      config: { providerId: "fake", modelId: "m", apiKey: "k" },
      micSegments: [{ startMs: 0, endMs: 3000 }],
      systemSegments: [],
    });
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
    const result = await resolveMeetingLanguage({
      meetingId: "m1",
      audioDir: makeAudioDir(),
      provider,
      config: { providerId: "fake", modelId: "m", apiKey: "k" },
      micSegments: [{ startMs: 0, endMs: 3000 }],
      systemSegments: [],
    });
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
    const result = await resolveMeetingLanguage({
      meetingId: "m1",
      audioDir: makeAudioDir(),
      provider,
      config: { providerId: "fake", modelId: "m", apiKey: "k" },
      micSegments: [{ startMs: 0, endMs: 3000 }],
      systemSegments: [],
      detectAll,
    });
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
    const result = await resolveMeetingLanguage({
      meetingId: "m1",
      audioDir: makeAudioDir(),
      provider,
      config: { providerId: "fake", modelId: "m", apiKey: "k" },
      micSegments: [{ startMs: 0, endMs: 3000 }],
      systemSegments: [],
      detectAll,
    });
    expect(result).toBe("en");
  });

  it("falls back to declared[0] and never throws when the probe transcription fails", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    const { provider } = makeProvider(async () => {
      throw new Error("provider down");
    });
    const result = await resolveMeetingLanguage({
      meetingId: "m1",
      audioDir: makeAudioDir(),
      provider,
      config: { providerId: "fake", modelId: "m", apiKey: "k" },
      micSegments: [{ startMs: 0, endMs: 3000 }],
      systemSegments: [],
    });
    expect(result).toBe("en");
    expect(readMeetingLanguage("m1")).toBe("en");
  });

  it("falls back to declared[0] with no probe attempted when no segments exist", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    const { provider, calls } = makeProvider(async () => ({ text: "hi" }));
    const result = await resolveMeetingLanguage({
      meetingId: "m1",
      audioDir: makeAudioDir(),
      provider,
      config: { providerId: "fake", modelId: "m", apiKey: "k" },
      micSegments: [],
      systemSegments: [],
    });
    expect(result).toBe("en");
    expect(calls).toHaveLength(0);
  });

  it("falls back to declared[0] when the probe transcribes to empty text", async () => {
    setDeclaredLanguages(["en", "pt"]);
    insertMeeting("m1");
    const { provider } = makeProvider(async () => ({ text: "   " }));
    const result = await resolveMeetingLanguage({
      meetingId: "m1",
      audioDir: makeAudioDir(),
      provider,
      config: { providerId: "fake", modelId: "m", apiKey: "k" },
      micSegments: [{ startMs: 0, endMs: 3000 }],
      systemSegments: [],
    });
    expect(result).toBe("en");
  });
});
