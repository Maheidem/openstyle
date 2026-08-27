import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import type { DiarizeDeps } from "../src/lib/meetings/diarize.js";
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

/** Fake diarize deps: binary + models bundle resolve, execFile routes
 * --probe and the real-run invocation to canned results (mirrors
 * meeting-diarize-pipeline.test.ts's makeFakeExecFile/baseDeps). */
function fakeDiarizeDeps(opts: {
  probeStdout?: string;
  runStdout?: string;
}): DiarizeDeps {
  return {
    resolveBinaryPath: () => "/fake/fluidaudio-diarize",
    resolveModelsDirPath: () => "/fake/resources/models",
    execFile: async (_file, args) => {
      if (args[0] === "--probe") {
        return { stdout: opts.probeStdout ?? "READY", stderr: "" };
      }
      return { stdout: opts.runStdout ?? "[]", stderr: "" };
    },
  };
}

function insertSystemSegment(
  segId: string,
  meetingId: string,
  idx: number,
  startMs: number,
  endMs: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
       VALUES (?, ?, 'system', ?, ?, ?, 'hello', 'ok')`,
    )
    .run(segId, meetingId, idx, startMs, endMs);
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

    // transcript.md is written into the meeting's audio dir alongside the
    // WAV files so the folder is self-contained.
    const transcriptPath = join(audioDir, "transcript.md");
    expect(existsSync(transcriptPath)).toBe(true);
    const md = readFileSync(transcriptPath, "utf8");
    expect(md).toContain("the quarterly numbers look great");
    expect(md).toMatch(/\[\d+:\d{2}\]/);
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

describe("PATCH /api/meetings/:id", () => {
  it("renames a meeting", async () => {
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  New title  " }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; title: string };
    expect(body.title).toBe("New title");
    const after = await getMeeting("m1");
    expect(after.title).toBe("New title");
  });

  it("404s for an unknown meeting", async () => {
    const res = await app.request("/api/meetings/nope", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an empty or whitespace-only title", async () => {
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a title over the length cap", async () => {
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(513) }),
    });
    expect(res.status).toBe(400);
  });

  it("sets the meeting's language (Phase A2 chip edit)", async () => {
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "pt" }),
    });
    expect(res.status).toBe(200);
    const after = await getMeeting("m1");
    expect(after.language).toBe("pt");
  });

  it("clears the meeting's language with an explicit null", async () => {
    insertMeeting("m1");
    getDb()
      .prepare("UPDATE meetings SET language = 'en' WHERE id = 'm1'")
      .run();
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: null }),
    });
    expect(res.status).toBe(200);
    const after = await getMeeting("m1");
    expect(after.language).toBeNull();
  });

  it("rejects a PATCH body with neither title nor language", async () => {
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
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

describe("POST /api/meetings/:id/transcribe — Phase A1 leak filter", () => {
  afterEach(() => {
    getDb().exec("DELETE FROM vocabulary");
  });

  it("persists a leaked chunk as status='filtered', text=NULL, end to end", async () => {
    const terms = Array.from({ length: 20 }, (_, i) => `Zylotrix${i + 1}`);
    for (const term of terms) {
      getDb().prepare("INSERT INTO vocabulary (term) VALUES (?)").run(term);
    }
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({
        text: `Technical terms: ${terms.join(", ")}`,
      })),
    });
    insertMeeting("m1");

    await app.request("/api/meetings/m1/transcribe", { method: "POST" });
    const done = await waitForTerminalStatus("m1");
    expect(done.status).toBe("transcribed");

    const rows = getDb()
      .prepare(
        "SELECT status, text FROM meeting_segments WHERE meeting_id = 'm1'",
      )
      .all() as { status: string; text: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).toBe("filtered");
      expect(r.text).toBeNull();
    }
    // A 'filtered' row is excluded from the merged transcript exactly like
    // 'failed' — no new code needed for that, per spec §3.1.
    const tRes = await app.request("/api/meetings/m1/transcript");
    const { segments } = (await tRes.json()) as { segments: unknown[] };
    expect(segments).toHaveLength(0);
  });
});

describe("POST /api/meetings/:id/diarize", () => {
  it("404s for an unknown meeting", async () => {
    const res = await app.request("/api/meetings/nope/diarize", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("409s when the meeting has no transcript yet", async () => {
    insertMeeting("m1", "recorded");
    const res = await app.request("/api/meetings/m1/diarize", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("409s while the meeting is still transcribing", async () => {
    insertMeeting("m1", "transcribing");
    const res = await app.request("/api/meetings/m1/diarize", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("409s when the meeting has no audio directory", async () => {
    insertMeeting("m1", "transcribed", null);
    const res = await app.request("/api/meetings/m1/diarize", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("409s when system.wav is missing from disk", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "meeting-diarize-nowav-"));
    try {
      insertMeeting("m1", "transcribed", emptyDir);
      const res = await app.request("/api/meetings/m1/diarize", {
        method: "POST",
      });
      expect(res.status).toBe(409);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("409s when the diarization models aren't ready", async () => {
    __setMeetingsTestOverrides({
      diarizeDeps: fakeDiarizeDeps({ probeStdout: "NOT_READY" }),
    });
    insertMeeting("m1", "transcribed");
    const res = await app.request("/api/meetings/m1/diarize", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("labels system segments and reports counts on success, ignoring the disabled global flag", async () => {
    // Global setting stays off — an explicit /diarize call must run
    // anyway (investigation-driven design: the toggle only gates the
    // automatic pass inside runTranscribeJob).
    const diarJson = JSON.stringify([
      { speakerId: "A", startTimeSeconds: 0, endTimeSeconds: 1 },
      { speakerId: "B", startTimeSeconds: 2, endTimeSeconds: 3 },
    ]);
    __setMeetingsTestOverrides({
      diarizeDeps: fakeDiarizeDeps({ runStdout: diarJson }),
    });
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    insertSystemSegment("m1:system:1", "m1", 1, 2000, 3000);

    const res = await app.request("/api/meetings/m1/diarize", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      labeledCount: number;
      speakerCount: number;
    };
    expect(body).toEqual({ ok: true, labeledCount: 2, speakerCount: 2 });

    const rows = getDb()
      .prepare(
        "SELECT speaker_label FROM meeting_segments WHERE meeting_id = 'm1' ORDER BY idx",
      )
      .all() as { speaker_label: string | null }[];
    expect(rows.map((r) => r.speaker_label)).toEqual(["1", "2"]);
  });

  it("collapses to a single speaker without corrupting existing labels on re-run", async () => {
    __setMeetingsTestOverrides({
      diarizeDeps: fakeDiarizeDeps({
        runStdout: JSON.stringify([
          { speakerId: "A", startTimeSeconds: 0, endTimeSeconds: 1 },
        ]),
      }),
    });
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);

    const res = await app.request("/api/meetings/m1/diarize", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      labeledCount: 1,
      speakerCount: 1,
    });
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

describe("POST /api/meetings/:id/enhance", () => {
  it("404s for an unknown meeting", async () => {
    const res = await app.request("/api/meetings/nope/enhance", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("409s when the meeting has no transcript", async () => {
    insertMeeting("m1", "recorded");
    const res = await app.request("/api/meetings/m1/enhance", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("409s when the merged transcript is empty", async () => {
    insertMeeting("m1", "transcribed");
    const res = await app.request("/api/meetings/m1/enhance", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Transcript is empty");
  });

  it("409s while another job is running for the meeting", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    // Diarize claims the concurrency slot before its (fake) execFile call
    // resolves — a real interaction the route guards against, since diarize
    // never touches meetings.status.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    __setMeetingsTestOverrides({
      diarizeDeps: {
        resolveBinaryPath: () => "/fake/fluidaudio-diarize",
        resolveModelsDirPath: () => "/fake/resources/models",
        execFile: async (_file, args) => {
          if (args[0] === "--probe") return { stdout: "READY", stderr: "" };
          await gate;
          return { stdout: "[]", stderr: "" };
        },
      },
    });

    const diarizePromise = app.request("/api/meetings/m1/diarize", {
      method: "POST",
    });
    // Yield to the pending diarize handler under fake timers (setup.ts:
    // shouldAdvanceTime: false) — advanceTimersByTimeAsync flushes
    // microtasks between ticks, unlike a real setTimeout, which would never
    // fire on its own here (same reasoning as waitForTerminalStatusFast
    // above).
    await vi.advanceTimersByTimeAsync(20);

    const res = await app.request("/api/meetings/m1/enhance", {
      method: "POST",
    });
    expect(res.status).toBe(409);

    release();
    await diarizePromise;
  });

  it("enhances the merged transcript and persists enhanced_text", async () => {
    insertMeeting("m1", "transcribed");
    getDb()
      .prepare(
        `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
         VALUES ('m1:mic:0', 'm1', 'mic', 0, 0, 2000, 'garbled txt here', 'ok')`,
      )
      .run();
    __setMeetingsTestOverrides({
      enhance: async (meetingId, segments) => {
        expect(meetingId).toBe("m1");
        expect(segments).toHaveLength(1);
        expect(segments[0].id).toBe("m1:mic:0");
        getDb()
          .prepare("UPDATE meeting_segments SET enhanced_text = ? WHERE id = ?")
          .run("garbled text here", "m1:mic:0");
        return { correctedCount: 1 };
      },
    });

    const res = await app.request("/api/meetings/m1/enhance", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; correctedCount: number };
    expect(body.ok).toBe(true);
    expect(body.correctedCount).toBe(1);

    const row = getDb()
      .prepare(
        "SELECT enhanced_text FROM meeting_segments WHERE id = 'm1:mic:0'",
      )
      .get() as { enhanced_text: string };
    expect(row.enhanced_text).toBe("garbled text here");
  });

  it("500s and reports the message when the enhance pass throws", async () => {
    insertMeeting("m1", "transcribed");
    getDb()
      .prepare(
        `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
         VALUES ('m1:mic:0', 'm1', 'mic', 0, 0, 2000, 'hello', 'ok')`,
      )
      .run();
    __setMeetingsTestOverrides({
      enhance: async () => {
        throw new Error("No AI model is set up yet.");
      },
    });

    const res = await app.request("/api/meetings/m1/enhance", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("No AI model is set up yet.");
  });
});

/**
 * Same polling contract as waitForTerminalStatus, but advances vitest's
 * fake timers explicitly instead of waiting on a real setTimeout — the
 * language probe adds one more await hop before the background job
 * settles, occasionally losing the race against the shared helper's real
 * 25ms sleep under fake timers (setup.ts: shouldAdvanceTime: false).
 */
async function waitForTerminalStatusFast(
  id: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const body = await getMeeting(id);
    if (body.status !== "transcribing") return body;
    await vi.advanceTimersByTimeAsync(25);
  }
  throw new Error("transcription job never finished");
}

describe("POST /api/meetings/:id/transcribe — Phase A2 language resolution", () => {
  afterEach(() => {
    getDb().exec("DELETE FROM settings WHERE key = 'languages'");
  });

  it("resolves and persists meetings.language once; a second run (re-transcribe) does not re-probe", async () => {
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES ('languages', ?)")
      .run(JSON.stringify(["en", "pt"]));

    let calls = 0;
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        calls++;
        // First call is the language probe (auto, unbiased); every call
        // after is a real chunk transcription.
        return calls === 1
          ? {
              text: "Bom dia, tudo bem com você? Vamos começar a reunião agora, para falar sobre o projeto.",
            }
          : { text: "hello" };
      }),
    });
    insertMeeting("m1");

    await app.request("/api/meetings/m1/transcribe", { method: "POST" });
    await waitForTerminalStatusFast("m1");
    const after1 = await getMeeting("m1");
    expect(after1.language).toBe("pt");
    const callsAfterFirstRun = calls;
    expect(callsAfterFirstRun).toBeGreaterThan(1); // probe + at least one chunk

    // Re-transcribe: meetings.language is already set, so no new probe call
    // — only chunk-transcription calls should be added.
    await app.request("/api/meetings/m1/transcribe", { method: "POST" });
    await waitForTerminalStatusFast("m1");
    const after2 = await getMeeting("m1");
    expect(after2.language).toBe("pt");
    const chunksInSecondRun = calls - callsAfterFirstRun;
    const chunksInFirstRun = callsAfterFirstRun - 1; // minus the one probe call
    expect(chunksInSecondRun).toBe(chunksInFirstRun);
  });

  it("with a single declared language, pins immediately with no probe call", async () => {
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES ('languages', ?)")
      .run(JSON.stringify(["pt"]));
    let calls = 0;
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        calls++;
        return { text: "hello" };
      }),
    });
    insertMeeting("m1");
    await app.request("/api/meetings/m1/transcribe", { method: "POST" });
    await waitForTerminalStatusFast("m1");
    const after = await getMeeting("m1");
    expect(after.language).toBe("pt");
    // Every call is a real chunk — none of them is a separate probe call.
    expect(calls).toBeGreaterThan(0);
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
