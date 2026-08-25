import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import {
  MEETING_RETENTION_SETTING_KEY,
  purgeExpiredMeetingAudio,
} from "../src/lib/meetings/retention.js";
import type { TranscriberDeps } from "../src/lib/meetings/transcriber.js";
import { __setMeetingsTestOverrides } from "../src/routes/meetings.js";

const app = createApp();

const SAMPLE_RATE = 16000;

/** Mono 16 kHz PCM16 WAV: silence — loud tone burst — silence. */
function buildWav(burstMs = 1000, padMs = 500): Buffer {
  const totalSamples = Math.round(((burstMs + 2 * padMs) / 1000) * SAMPLE_RATE);
  const burstStart = Math.round((padMs / 1000) * SAMPLE_RATE);
  const burstEnd = burstStart + Math.round((burstMs / 1000) * SAMPLE_RATE);
  const data = Buffer.alloc(totalSamples * 2);
  for (let i = burstStart; i < burstEnd; i++) {
    // 440 Hz tone at high amplitude so the energy gate always opens.
    const s = Math.round(
      8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE),
    );
    data.writeInt16LE(s, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
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
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let audioDir: string;

beforeAll(() => {
  audioDir = mkdtempSync(join(tmpdir(), "meeting-test-"));
  const wav = buildWav();
  writeFileSync(join(audioDir, "mic.wav"), wav);
  writeFileSync(join(audioDir, "system.wav"), wav);
  writeFileSync(
    join(audioDir, "sync.json"),
    JSON.stringify({
      meetingId: "m1",
      sampleRate: SAMPLE_RATE,
      micT0: 1000,
      systemT0: 1000,
      micSamples: 0,
      systemSamples: 0,
      syncMarkers: [],
      epochs: [],
    }),
  );
});

afterAll(() => {
  rmSync(audioDir, { recursive: true, force: true });
});

afterEach(() => {
  getDb().exec("DELETE FROM meeting_summaries");
  getDb().exec("DELETE FROM meeting_segments");
  getDb().exec("DELETE FROM meetings");
  __setMeetingsTestOverrides();
});

function insertMeeting(
  id: string,
  status = "recorded",
  dir: string | null = audioDir,
  createdAt = Date.now(),
): void {
  getDb()
    .prepare(
      `INSERT INTO meetings (id, title, started_at, status, audio_dir, created_at)
       VALUES (?, 'Test meeting', ?, ?, ?, ?)`,
    )
    .run(id, Date.now(), status, dir, createdAt);
}

/** Fake transcriber deps: no real providers, no waiting. */
function fakeDeps(
  transcribe: () => Promise<{ text: string }>,
): (
  extras: Pick<TranscriberDeps, "isDictationActive" | "onChunk" | "onProgress">,
) => Promise<TranscriberDeps> {
  return async (extras) => ({
    getProvider: () => ({
      providerId: "fake",
      transcribe,
      supportsStreaming: () => false,
    }),
    resolveConfig: () => ({
      providerId: "fake",
      modelId: "fake-model",
      apiKey: "key",
      bias: null,
    }),
    sleep: async () => {},
    backoffBaseMs: 1,
    maxAttempts: 2,
    ...extras,
  });
}

async function getMeeting(id: string): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/meetings/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function waitForTerminalStatus(
  id: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const body = await getMeeting(id);
    if (body.status !== "transcribing") return body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("transcription job never finished");
}

describe("POST /api/meetings/:id/transcribe", () => {
  it("404s for an unknown meeting", async () => {
    const res = await app.request("/api/meetings/nope/transcribe", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("409s while the meeting is still recording", async () => {
    insertMeeting("m1", "recording");
    const res = await app.request("/api/meetings/m1/transcribe", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("runs the pipeline async and persists segments + merged transcript", async () => {
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({
        text: "the quarterly numbers look great",
      })),
    });
    insertMeeting("m1");

    const res = await app.request("/api/meetings/m1/transcribe", {
      method: "POST",
    });
    expect(res.status).toBe(202);

    const done = await waitForTerminalStatus("m1");
    expect(done.status).toBe("transcribed");
    expect(done.stt_provider).toBe("fake");
    expect(done.stt_model).toBe("fake-model");
    expect(done.job).toBeNull();
    const counts = done.segment_counts as { total: number; failed: number };
    expect(counts.total).toBeGreaterThan(0);
    expect(counts.failed).toBe(0);

    const tRes = await app.request("/api/meetings/m1/transcript");
    expect(tRes.status).toBe(200);
    const { segments } = (await tRes.json()) as {
      segments: Array<{ speaker: string; text: string }>;
    };
    expect(segments.length).toBeGreaterThan(0);
    // Identical text on both channels: echo dedup keeps the "Them" copy.
    expect(
      segments.every((s) => s.speaker === "Me" || s.speaker === "Them"),
    ).toBe(true);
    expect(segments[0].text).toBe("the quarterly numbers look great");
  });

  it("marks the meeting failed when the pipeline throws", async () => {
    __setMeetingsTestOverrides({
      createTranscriberDeps: async () => {
        throw new Error("no voice model configured");
      },
    });
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1/transcribe", {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const done = await waitForTerminalStatus("m1");
    expect(done.status).toBe("failed");
    expect(done.error).toContain("no voice model configured");
  });
});

describe("POST /api/meetings/:id/retry-failed", () => {
  it("re-transcribes only failed chunks", async () => {
    // First pass: every chunk fails.
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        throw new Error("rate limited");
      }),
    });
    insertMeeting("m1");
    await app.request("/api/meetings/m1/transcribe", { method: "POST" });
    const afterFirst = await waitForTerminalStatus("m1");
    expect(afterFirst.status).toBe("transcribed");
    const firstCounts = afterFirst.segment_counts as { failed: number };
    expect(firstCounts.failed).toBeGreaterThan(0);

    // Retry with a working provider: everything recovers.
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({ text: "recovered" })),
    });
    const res = await app.request("/api/meetings/m1/retry-failed", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { retried: number; failed: number };
    expect(body.retried).toBe(firstCounts.failed);
    expect(body.failed).toBe(0);

    const after = await getMeeting("m1");
    expect((after.segment_counts as { failed: number }).failed).toBe(0);
    expect(after.error).toBeNull();
  });

  it("no-ops when there are no failed chunks", async () => {
    insertMeeting("m1", "transcribed");
    const res = await app.request("/api/meetings/m1/retry-failed", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, retried: 0 });
  });
});

describe("POST /api/meetings/:id/summarize", () => {
  it("409s when the meeting has no transcript", async () => {
    insertMeeting("m1", "recorded");
    const res = await app.request("/api/meetings/m1/summarize", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("summarizes the merged transcript and upserts the summary", async () => {
    insertMeeting("m1", "transcribed");
    getDb()
      .prepare(
        `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
         VALUES ('m1:mic:0', 'm1', 'mic', 0, 0, 2000, 'we should ship on friday', 'ok')`,
      )
      .run();
    __setMeetingsTestOverrides({
      summarize: async (segments) => {
        expect(segments).toHaveLength(1);
        expect(segments[0].speaker).toBe("Me");
        return {
          markdown: "## Overview\nShip on Friday.",
          llmProvider: "fake-llm",
          llmModel: "fake-model",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.001,
        };
      },
    });

    const res = await app.request("/api/meetings/m1/summarize", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string };
    expect(body.markdown).toContain("Ship on Friday");

    const after = await getMeeting("m1");
    expect(after.status).toBe("summarized");
    const summary = after.summary as { markdown: string; llm_provider: string };
    expect(summary.markdown).toContain("Ship on Friday");
    expect(summary.llm_provider).toBe("fake-llm");
  });
});

/** The meetings root the server guards against: <db dir>/meetings/. */
function meetingsRoot(): string {
  return join(dirname(process.env.OPENSTYLE_DB_PATH as string), "meetings");
}

function makeMeetingDir(id: string): string {
  const dir = join(meetingsRoot(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mic.wav"), buildWav(100, 50));
  writeFileSync(join(dir, "system.wav"), buildWav(100, 50));
  writeFileSync(join(dir, "sync.json"), "{}");
  return dir;
}

describe("meeting audio retention sweep", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  afterEach(() => {
    getDb()
      .prepare("DELETE FROM settings WHERE key = ?")
      .run(MEETING_RETENTION_SETTING_KEY);
    rmSync(meetingsRoot(), { recursive: true, force: true });
  });

  it("deletes only expired WAV files, keeps rows, nulls audio_dir", async () => {
    const oldDir = makeMeetingDir("old");
    const freshDir = makeMeetingDir("fresh");
    insertMeeting("old", "summarized", oldDir, Date.now() - 40 * DAY_MS);
    insertMeeting("fresh", "recorded", freshDir, Date.now() - 1 * DAY_MS);

    expect(purgeExpiredMeetingAudio()).toBe(1);

    expect(existsSync(join(oldDir, "mic.wav"))).toBe(false);
    expect(existsSync(join(oldDir, "system.wav"))).toBe(false);
    expect(existsSync(join(freshDir, "mic.wav"))).toBe(true);

    const oldRow = await getMeeting("old");
    expect(oldRow.audio_dir).toBeNull();
    expect(oldRow.status).toBe("summarized");
    const freshRow = await getMeeting("fresh");
    expect(freshRow.audio_dir).toBe(freshDir);
  });

  it("skips meetings still recording, honors the retention setting", () => {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, '7', datetime('now'))`,
      )
      .run(MEETING_RETENTION_SETTING_KEY);
    const liveDir = makeMeetingDir("live");
    const doneDir = makeMeetingDir("done");
    insertMeeting("live", "recording", liveDir, Date.now() - 10 * DAY_MS);
    insertMeeting("done", "recorded", doneDir, Date.now() - 10 * DAY_MS);

    expect(purgeExpiredMeetingAudio()).toBe(1);
    expect(existsSync(join(liveDir, "mic.wav"))).toBe(true);
    expect(existsSync(join(doneDir, "mic.wav"))).toBe(false);
    // Second sweep is a no-op: audio_dir was nulled.
    expect(purgeExpiredMeetingAudio()).toBe(0);
  });
});

describe("DELETE /api/meetings/:id", () => {
  it("removes the audio dir when it lives under the meetings root", async () => {
    const dir = makeMeetingDir("del1");
    insertMeeting("del1", "recorded", dir);
    const res = await app.request("/api/meetings/del1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    const listRes = await app.request("/api/meetings/del1");
    expect(listRes.status).toBe(404);
  });

  it("never follows an audio_dir outside the meetings root", async () => {
    // audioDir (the fixture tmp dir) is outside <db dir>/meetings.
    insertMeeting("del2", "recorded", audioDir);
    const res = await app.request("/api/meetings/del2", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(join(audioDir, "mic.wav"))).toBe(true);
  });
});
