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

/**
 * Same polling contract as `waitForTerminalStatus`, but yields via
 * microtasks instead of a real `setTimeout` delay — `tests/setup.ts` installs
 * `vi.useFakeTimers({ shouldAdvanceTime: false })` file-wide, so a real timer
 * only ever fires if a job's own status flip already lands on the very first
 * poll (true for every other test here, which races nothing). A test that
 * deliberately holds a job mid-flight and polls across the flip needs this
 * instead, or the loop hangs forever waiting on a timer nothing advances.
 */
async function waitForTerminalStatusNoRealTimers(
  id: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 2000; i++) {
    const body = await getMeeting(id);
    if (body.status !== "transcribing") return body;
    await Promise.resolve();
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

  it("re-transcribe: status flips and segments are wiped synchronously before 202 returns, so a GET /transcript racing right after legitimately returns an empty array", async () => {
    // Server-side precondition for the frontend cache-poisoning bug: POST
    // /:id/transcribe does `UPDATE meetings SET status='transcribing'` then
    // `DELETE FROM meeting_segments` *before* returning 202 (the async job
    // itself is fired with `void` and runs after). A renderer query that's
    // still enabled from the previous 'transcribed' render can race that
    // DELETE, legitimately receive `{ segments: [] }`, and cache it — see
    // apps/electron/src/renderer/src/pages/meetings.tsx's transcript
    // useQuery and `transcribe` callback for the client-side fix. This test
    // only covers the server half: that the race window is real and that
    // `/transcript` never lies about it.
    // Gate the fake transcriber on a promise we control, so the job is
    // guaranteed to still be sitting in 'transcribing' — with segments
    // already deleted — when this test reads it back. That's the real race
    // window; without the gate the fake job (no real I/O) can finish before
    // the test gets a chance to observe the mid-job state at all.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        await gate;
        return { text: "hello again" };
      }),
    });
    insertMeeting("m1", "transcribed");
    insertSystemSegment("s1", "m1", 0, 0, 1000);

    const preTranscript = await app.request("/api/meetings/m1/transcript");
    const preBody = (await preTranscript.json()) as { segments: unknown[] };
    expect(preBody.segments.length).toBeGreaterThan(0);

    const res = await app.request("/api/meetings/m1/transcribe", {
      method: "POST",
    });
    expect(res.status).toBe(202);

    // The job is parked on `gate` inside its first transcribe call — the
    // route's synchronous UPDATE/DELETE already ran before the 202 resolved.
    const mid = await getMeeting("m1");
    expect(mid.status).toBe("transcribing");
    const tRes = await app.request("/api/meetings/m1/transcript");
    expect(tRes.status).toBe(200);
    const { segments } = (await tRes.json()) as { segments: unknown[] };
    expect(segments).toEqual([]);

    release();
    const done = await waitForTerminalStatusNoRealTimers("m1");
    expect(done.status).toBe("transcribed");
    const counts = done.segment_counts as { total: number; failed: number };
    expect(counts.total).toBeGreaterThan(0);
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

  // specs/meeting-speaker-naming.md §6.3/§8: a re-run's segment ids and (if
  // diarization runs again) clustering have no guaranteed relationship to
  // the old run's — a stale name/merge mapping would silently misattribute
  // a confirmed name to a different, unrelated voice.
  it("clears meeting_speakers rows on a transcribe re-run", async () => {
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({ text: "hello again" })),
    });
    insertMeeting("m1", "transcribed");
    insertSystemSegment("s1", "m1", 0, 0, 1000);
    getDb()
      .prepare(
        `INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, updated_at)
         VALUES ('m1', '1', 'Ana', ?)`,
      )
      .run(Date.now());

    const res = await app.request("/api/meetings/m1/transcribe", {
      method: "POST",
    });
    expect(res.status).toBe(202);
    await waitForTerminalStatusNoRealTimers("m1");

    const count = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM meeting_speakers WHERE meeting_id = 'm1'",
      )
      .get() as { c: number };
    expect(count.c).toBe(0);
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

  // specs/meeting-speaker-naming.md §3.4/§6.4
  it("sets the meeting's context and returns it on the next GET", async () => {
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: "Call with Ana from Acme" }),
    });
    expect(res.status).toBe(200);
    const after = await getMeeting("m1");
    expect(after.context).toBe("Call with Ana from Acme");
  });

  it("clears a previously-set context with an explicit null", async () => {
    insertMeeting("m1");
    getDb()
      .prepare("UPDATE meetings SET context = 'old context' WHERE id = 'm1'")
      .run();
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: null }),
    });
    expect(res.status).toBe(200);
    const after = await getMeeting("m1");
    expect(after.context).toBeNull();
  });

  it("accepts a body with only context (no title/language) — the refine no longer rejects it", async () => {
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: "just context" }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a body with none of title/language/context", async () => {
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects context over the 2000-char cap", async () => {
    insertMeeting("m1");
    const res = await app.request("/api/meetings/m1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: "x".repeat(2001) }),
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
      mappingReset: boolean;
    };
    expect(body).toEqual({
      ok: true,
      labeledCount: 2,
      speakerCount: 2,
      mappingReset: false,
    });

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
      mappingReset: false,
    });
  });

  // specs/meeting-speaker-naming.md §6.3/§8: label "N" from a re-run has no
  // guaranteed relationship to label "N" from the old run — a stale
  // confirmed name is a fail-open misattribution risk, so the pass resets
  // the naming mapping and reports it happened.
  it("clears meeting_speakers rows and reports mappingReset: true on re-run when the meeting had a confirmed name", async () => {
    __setMeetingsTestOverrides({
      diarizeDeps: fakeDiarizeDeps({
        runStdout: JSON.stringify([
          { speakerId: "A", startTimeSeconds: 0, endTimeSeconds: 1 },
        ]),
      }),
    });
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    getDb()
      .prepare(
        `INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, updated_at)
         VALUES ('m1', '1', 'Ana', ?)`,
      )
      .run(Date.now());

    const res = await app.request("/api/meetings/m1/diarize", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mappingReset: boolean };
    expect(body.mappingReset).toBe(true);

    const count = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM meeting_speakers WHERE meeting_id = 'm1'",
      )
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("refreshes transcript.md on disk with the new speaker labels", async () => {
    // Root-cause regression test: the standalone diarize pass persisted
    // speaker_label to the DB but never rewrote the meeting's exported
    // transcript.md, so the on-disk file kept showing plain "Them" forever
    // — only re-transcribing or enhancing (which do call
    // writeTranscriptMarkdown) would ever pick up the new labels.
    const diarJson = JSON.stringify([
      { speakerId: "A", startTimeSeconds: 0, endTimeSeconds: 1 },
    ]);
    __setMeetingsTestOverrides({
      diarizeDeps: fakeDiarizeDeps({ runStdout: diarJson }),
    });
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);

    // transcript.md lives in the shared fixture audioDir and isn't reset
    // between tests, so seed it with a known-stale placeholder rather than
    // relying on whatever the previous test happened to leave behind.
    const transcriptPath = join(audioDir, "transcript.md");
    writeFileSync(transcriptPath, "STALE-PLACEHOLDER-CONTENT", "utf8");

    const res = await app.request("/api/meetings/m1/diarize", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const after = readFileSync(transcriptPath, "utf8");
    expect(after).not.toContain("STALE-PLACEHOLDER-CONTENT");
    expect(after).toMatch(/Them 1:/);
  });
});

/** specs/meeting-speaker-naming.md §3.1: seed a meeting_speakers row directly. */
function insertSpeaker(
  meetingId: string,
  label: string,
  opts: {
    displayName?: string | null;
    suggestedName?: string | null;
    suggestedEvidence?: string | null;
    suggestedKind?: string | null;
    mergedInto?: string | null;
    /** Real-E2E fix regression coverage: only a genuinely *confirmed*
     * write (routes/meetings.ts's PATCH handler) sets this — a plain
     * suggestion upsert (enhance.ts) never does. Tests that simulate a
     * confirmed row must pass this explicitly; it is NOT inferred from
     * `displayName`/`mergedInto` being set, to keep the two independent
     * the same way the real schema does. */
    confirmedAt?: number | null;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO meeting_speakers
         (meeting_id, speaker_label, display_name, suggested_name, suggested_evidence, suggested_kind, merged_into, updated_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meetingId,
      label,
      opts.displayName ?? null,
      opts.suggestedName ?? null,
      opts.suggestedEvidence ?? null,
      opts.suggestedKind ?? null,
      opts.mergedInto ?? null,
      Date.now(),
      opts.confirmedAt ?? null,
    );
}

describe("GET /api/meetings/:id/speakers", () => {
  it("404s for an unknown meeting", async () => {
    const res = await app.request("/api/meetings/nope/speakers");
    expect(res.status).toBe(404);
  });

  it("returns one row per distinct labeled speaker plus unlabeledCount; a labeled row without a meeting_speakers row shows all-null optional fields", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    insertSystemSegment("m1:system:1", "m1", 1, 1000, 2000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '2' WHERE id = 'm1:system:1'",
      )
      .run();
    insertSystemSegment("m1:system:2", "m1", 2, 2000, 3000); // stays NULL
    insertSpeaker("m1", "1", {
      displayName: "Ana",
      suggestedName: "Ana",
      suggestedEvidence: "introduced herself",
    });

    const res = await app.request("/api/meetings/m1/speakers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      speakers: Array<{
        label: string;
        segmentCount: number;
        quote: string | null;
        displayName: string | null;
        suggestedName: string | null;
        suggestedEvidence: string | null;
        suggestedKind: string;
        mergedInto: string | null;
      }>;
      unlabeledCount: number;
    };
    expect(body.unlabeledCount).toBe(1);
    expect(body.speakers).toHaveLength(2);
    const one = body.speakers.find((s) => s.label === "1");
    const two = body.speakers.find((s) => s.label === "2");
    expect(one).toMatchObject({
      segmentCount: 1,
      displayName: "Ana",
      suggestedName: "Ana",
      suggestedEvidence: "introduced herself",
      suggestedKind: "name",
      mergedInto: null,
    });
    expect(two).toMatchObject({
      segmentCount: 1,
      displayName: null,
      suggestedName: null,
      suggestedEvidence: null,
      suggestedKind: "name",
      mergedInto: null,
    });
  });

  it("returns suggestedKind 'role' only when the stored row explicitly says so, defaulting a NULL/unknown value to 'name'", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    insertSystemSegment("m1:system:1", "m1", 1, 1000, 2000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '2' WHERE id = 'm1:system:1'",
      )
      .run();
    insertSpeaker("m1", "1", {
      suggestedName: "the hiring manager",
      suggestedKind: "role",
    });
    insertSpeaker("m1", "2", { suggestedName: "Ana" }); // suggestedKind: null

    const res = await app.request("/api/meetings/m1/speakers");
    const body = (await res.json()) as {
      speakers: Array<{ label: string; suggestedKind: string }>;
    };
    expect(body.speakers.find((s) => s.label === "1")?.suggestedKind).toBe(
      "role",
    );
    expect(body.speakers.find((s) => s.label === "2")?.suggestedKind).toBe(
      "name",
    );
  });

  it("reports latestSpeakerUpdate as the max confirmed_at across rows — never bumped by a suggestion-only write, or null when there are none confirmed", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();

    const empty = await app.request("/api/meetings/m1/speakers");
    const emptyBody = (await empty.json()) as {
      latestSpeakerUpdate: number | null;
    };
    expect(emptyBody.latestSpeakerUpdate).toBeNull();

    // Real-E2E fix: a row that only ever received a suggestion (Enhance's
    // upsert never sets confirmed_at) must NOT count — this is exactly the
    // false-staleness bug found on meeting 8e6aea86, where an Enhance run's
    // own suggestion writes made an unrelated, already-generated summary
    // read as stale.
    insertSpeaker("m1", "1", {
      suggestedName: "Ana",
      suggestedEvidence: "introduced herself",
    });
    const suggestionOnly = await app.request("/api/meetings/m1/speakers");
    const suggestionOnlyBody = (await suggestionOnly.json()) as {
      latestSpeakerUpdate: number | null;
    };
    expect(suggestionOnlyBody.latestSpeakerUpdate).toBeNull();

    // A genuinely confirmed row (confirmed_at set, as the PATCH handler
    // always does) does count.
    getDb()
      .prepare(
        "UPDATE meeting_speakers SET display_name = 'Ana', confirmed_at = ? WHERE meeting_id = 'm1' AND speaker_label = '1'",
      )
      .run(Date.now());
    const withRow = await app.request("/api/meetings/m1/speakers");
    const withRowBody = (await withRow.json()) as {
      latestSpeakerUpdate: number | null;
    };
    expect(withRowBody.latestSpeakerUpdate).toEqual(expect.any(Number));
  });
});

describe("PATCH /api/meetings/:id/speakers/:label", () => {
  function patchSpeaker(
    meetingId: string,
    label: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return app.request(`/api/meetings/${meetingId}/speakers/${label}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("404s when the meeting doesn't exist", async () => {
    const res = await patchSpeaker("nope", "1", { displayName: "Ana" });
    expect(res.status).toBe(404);
  });

  it("400s on an empty body", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    const res = await patchSpeaker("m1", "1", {});
    expect(res.status).toBe(400);
  });

  it("404s when :label has zero segments in this meeting", async () => {
    insertMeeting("m1", "transcribed");
    const res = await patchSpeaker("m1", "9", { displayName: "Ana" });
    expect(res.status).toBe(404);
  });

  it("saves a confirmed display name", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    const res = await patchSpeaker("m1", "1", { displayName: "Ana" });
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(
        "SELECT display_name FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '1'",
      )
      .get() as { display_name: string };
    expect(row.display_name).toBe("Ana");
  });

  it("sets confirmed_at on a successful PATCH (real-E2E fix: this, not updated_at, drives the summary staleness hint)", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    const res = await patchSpeaker("m1", "1", { displayName: "Ana" });
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(
        "SELECT confirmed_at FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '1'",
      )
      .get() as { confirmed_at: number | null };
    expect(row.confirmed_at).toEqual(expect.any(Number));
  });

  it("un-names a speaker with displayName: null without touching merged_into", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    insertSystemSegment("m1:system:1", "m1", 1, 1000, 2000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '2' WHERE id = 'm1:system:1'",
      )
      .run();
    insertSpeaker("m1", "1", { displayName: "Ana", mergedInto: "2" });

    const res = await patchSpeaker("m1", "1", { displayName: null });
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(
        "SELECT display_name, merged_into FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '1'",
      )
      .get() as { display_name: string | null; merged_into: string | null };
    expect(row.display_name).toBeNull();
    expect(row.merged_into).toBe("2");
  });

  it("400s on self-merge (mergedInto === label), writing no row", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    const res = await patchSpeaker("m1", "1", { mergedInto: "1" });
    expect(res.status).toBe(400);
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '1'",
      )
      .get() as { c: number };
    expect(row.c).toBe(0);
  });

  it("404s when mergedInto targets a nonexistent label", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    const res = await patchSpeaker("m1", "1", { mergedInto: "9" });
    expect(res.status).toBe(404);
  });

  it("resolves a merge into an already-merged target to that target's own root, no error", async () => {
    insertMeeting("m1", "transcribed");
    for (const [id, idx, label] of [
      ["m1:system:0", 0, "1"],
      ["m1:system:1", 1, "2"],
      ["m1:system:2", 2, "3"],
    ] as const) {
      insertSystemSegment(id, "m1", idx, idx * 1000, idx * 1000 + 1000);
      getDb()
        .prepare("UPDATE meeting_segments SET speaker_label = ? WHERE id = ?")
        .run(label, id);
    }
    // "2" is already merged into "3" (the root).
    insertSpeaker("m1", "2", { mergedInto: "3" });

    const res = await patchSpeaker("m1", "1", { mergedInto: "2" });
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(
        "SELECT merged_into FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '1'",
      )
      .get() as { merged_into: string };
    // Resolved to "2"'s own root ("3"), not the literal requested "2".
    expect(row.merged_into).toBe("3");
  });

  it("cascades rows already pointing at the merged label to the new target, in the same transaction as the row's own update", async () => {
    insertMeeting("m1", "transcribed");
    for (const [id, idx, label] of [
      ["m1:system:0", 0, "1"],
      ["m1:system:1", 1, "2"],
      ["m1:system:2", 2, "3"],
      ["m1:system:3", 3, "4"],
    ] as const) {
      insertSystemSegment(id, "m1", idx, idx * 1000, idx * 1000 + 1000);
      getDb()
        .prepare("UPDATE meeting_segments SET speaker_label = ? WHERE id = ?")
        .run(label, id);
    }
    // "1" and "4" already point at "2". Now merge "2" into "3".
    insertSpeaker("m1", "1", { mergedInto: "2" });
    insertSpeaker("m1", "4", { mergedInto: "2" });

    const res = await patchSpeaker("m1", "2", { mergedInto: "3" });
    expect(res.status).toBe(200);

    const rows = getDb()
      .prepare(
        "SELECT speaker_label, merged_into FROM meeting_speakers WHERE meeting_id = 'm1' ORDER BY speaker_label",
      )
      .all() as { speaker_label: string; merged_into: string | null }[];
    const byLabel = new Map(rows.map((r) => [r.speaker_label, r.merged_into]));
    expect(byLabel.get("1")).toBe("3"); // cascaded
    expect(byLabel.get("2")).toBe("3"); // this row's own update
    expect(byLabel.get("4")).toBe("3"); // cascaded
  });

  it("unmerges (mergedInto: null) without touching display_name", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    insertSystemSegment("m1:system:1", "m1", 1, 1000, 2000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '2' WHERE id = 'm1:system:1'",
      )
      .run();
    insertSpeaker("m1", "1", { displayName: "Ana", mergedInto: "2" });

    const res = await patchSpeaker("m1", "1", { mergedInto: null });
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(
        "SELECT display_name, merged_into FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '1'",
      )
      .get() as { display_name: string | null; merged_into: string | null };
    expect(row.display_name).toBe("Ana");
    expect(row.merged_into).toBeNull();
  });

  it("refreshes transcript.md on disk after a successful PATCH", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    getDb()
      .prepare(
        "UPDATE meeting_segments SET speaker_label = '1' WHERE id = 'm1:system:0'",
      )
      .run();
    const transcriptPath = join(audioDir, "transcript.md");
    writeFileSync(transcriptPath, "STALE-PLACEHOLDER-CONTENT", "utf8");

    const res = await patchSpeaker("m1", "1", { displayName: "Ana" });
    expect(res.status).toBe(200);

    const after = readFileSync(transcriptPath, "utf8");
    expect(after).not.toContain("STALE-PLACEHOLDER-CONTENT");
    expect(after).toContain("Ana");
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

  // specs/meeting-speaker-naming.md §9.3: threading check — the route must
  // actually read meetings.context and pass it through, not just store it.
  it("passes row.context through to summarize as meetingContext", async () => {
    insertMeeting("m1", "transcribed");
    getDb()
      .prepare(
        "UPDATE meetings SET context = 'Call with Ana from Acme' WHERE id = 'm1'",
      )
      .run();
    getDb()
      .prepare(
        `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
         VALUES ('m1:mic:0', 'm1', 'mic', 0, 0, 2000, 'hello', 'ok')`,
      )
      .run();
    let capturedOptions: { meetingContext?: string } | undefined;
    __setMeetingsTestOverrides({
      summarize: async (_segments, options) => {
        capturedOptions = options;
        return {
          markdown: "## Overview\nx",
          llmProvider: null,
          llmModel: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
        };
      },
    });

    const res = await app.request("/api/meetings/m1/summarize", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(capturedOptions?.meetingContext).toBe("Call with Ana from Acme");
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

  // specs/meeting-speaker-naming.md §5.4: threading check — row.title and
  // row.context must reach enhanceMeetingTranscript, and the route's JSON
  // body must surface speakerSuggestions (not just correctedCount). The
  // other enhance-route tests all return `{ correctedCount }` with no
  // `speakerSuggestions`, so this pass-through is otherwise unverified —
  // `c.json` silently drops an absent key and every `toEqual` still passes.
  it("threads meetingTitle/meetingContext to enhance and surfaces speakerSuggestions in the response", async () => {
    insertMeeting("m1", "transcribed");
    getDb()
      .prepare(
        "UPDATE meetings SET title = 'Weekly sync', context = 'Ana from Acme' WHERE id = 'm1'",
      )
      .run();
    getDb()
      .prepare(
        `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
         VALUES ('m1:mic:0', 'm1', 'mic', 0, 0, 2000, 'hello', 'ok')`,
      )
      .run();
    let capturedArgs: [string | undefined, string | undefined] | undefined;
    __setMeetingsTestOverrides({
      enhance: async (
        _meetingId,
        _segments,
        _language,
        _vocab,
        title,
        context,
      ) => {
        capturedArgs = [title, context];
        return { correctedCount: 0, speakerSuggestions: 2 };
      },
    });

    const res = await app.request("/api/meetings/m1/enhance", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      correctedCount: number;
      speakerSuggestions: number;
    };
    expect(body.speakerSuggestions).toBe(2);
    expect(capturedArgs).toEqual(["Weekly sync", "Ana from Acme"]);
  });

  it("writes enhanced text only to transcript-enhanced.md, never to transcript.md", async () => {
    // §6.8 invariant: transcript.md is the RAW ASR file and must never be
    // touched by Enhance, regardless of which route triggers the write.
    // The enhanced rendering goes exclusively to the sibling file.
    insertMeeting("m1", "transcribed");
    getDb()
      .prepare(
        `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
         VALUES ('m1:mic:0', 'm1', 'mic', 0, 0, 2000, 'garbled txt here', 'ok')`,
      )
      .run();
    __setMeetingsTestOverrides({
      enhance: async () => {
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

    const raw = readFileSync(join(audioDir, "transcript.md"), "utf8");
    expect(raw).toContain("garbled txt here");
    expect(raw).not.toContain("garbled text here");

    const enhanced = readFileSync(
      join(audioDir, "transcript-enhanced.md"),
      "utf8",
    );
    expect(enhanced).toContain("garbled text here");
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
