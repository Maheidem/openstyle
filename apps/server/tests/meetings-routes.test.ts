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
  type LlmRunInfo,
  type LlmRunListResponse,
  type MeetingDetail,
  type StartRunResponse,
  SYSTEM_REPAIR_TMP,
} from "@openstyle/validations";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import createApp from "../src/index.js";
import { readWavInfo, wavDurationMs } from "../src/lib/audio/wav.js";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import {
  __resetDictationIdleStateForTests,
  beginDictation,
  endDictation,
} from "../src/lib/dictation-activity.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import type { DiarizeDeps } from "../src/lib/meetings/diarize.js";
import {
  MEETING_RETENTION_SETTING_KEY,
  purgeExpiredMeetingAudio,
} from "../src/lib/meetings/retention.js";
import type { TranscriberDeps } from "../src/lib/meetings/transcriber.js";
import { SUMMARIZE_IS_STUB } from "../src/lib/meetings/workflow/nodes/summarize.js";
import { __setMeetingsTestOverrides } from "../src/routes/meetings.js";
import { HANG, okReply, reply } from "./helpers/fake-model.js";
import { jsonRequest, postEmpty } from "./helpers/http.js";
import {
  insertSegment,
  insertSpeaker,
  insertSystemSegment,
  resetMeetingTables,
} from "./helpers/meetings-db.js";
import {
  correctionText,
  defaultAnswer,
  firstIdOf,
  holdFirstRequest,
  isSummaryRequest,
  runnerHarness,
  waitForNoJob,
  waitUntil,
} from "./helpers/runner-helpers.js";
import { writeSqueezedMeeting } from "./helpers/squeezed-meeting.js";
import { buildWav as buildBaseWav } from "./helpers/wav.js";
import {
  seedFixtureMeeting,
  seedTestModel,
  sizeFixtureSegments,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const app = createApp();

const SAMPLE_RATE = 16000;

/** PCM16 payload of silence with a 440 Hz tone (high amplitude, so the energy
 * gate always opens) over each `[start, end)` sample range. */
function tonePayload(
  totalSamples: number,
  ranges: Array<[number, number]>,
): Buffer {
  const data = Buffer.alloc(totalSamples * 2);
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) {
      const s = Math.round(
        8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE),
      );
      data.writeInt16LE(s, i * 2);
    }
  }
  return data;
}

/** Mono 16 kHz PCM16 WAV: silence — loud tone burst — silence. */
function buildWav(burstMs = 1000, padMs = 500): Buffer {
  const totalSamples = Math.round(((burstMs + 2 * padMs) / 1000) * SAMPLE_RATE);
  const burstStart = Math.round((padMs / 1000) * SAMPLE_RATE);
  const burstEnd = burstStart + Math.round((burstMs / 1000) * SAMPLE_RATE);
  return buildBaseWav({
    data: tonePayload(totalSamples, [[burstStart, burstEnd]]),
  });
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
  resetMeetingTables();
  __setMeetingsTestOverrides();
  // The retry-failed stamp tests insert model_configs rows; the per-file
  // scratch DB starts with none, so a full delete restores that state.
  getDb().prepare("DELETE FROM model_configs").run();
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
  extras?: Pick<
    TranscriberDeps,
    "isDictationActive" | "onChunk" | "onProgress"
  >,
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
    const res = await postEmpty(app, "/api/meetings/nope/transcribe");
    expect(res.status).toBe(404);
  });

  it("409s while the meeting is still recording", async () => {
    insertMeeting("m1", "recording");
    const res = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(res.status).toBe(409);
  });

  it("runs the pipeline async and persists segments + merged transcript", async () => {
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({
        text: "the quarterly numbers look great",
      })),
    });
    insertMeeting("m1");

    const res = await postEmpty(app, "/api/meetings/m1/transcribe");
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

  it("VAD gate: skips the mic chunk with no speech span and sends the full system chunk", async () => {
    const audioBytes: number[] = [];
    __setMeetingsTestOverrides({
      createTranscriberDeps: async (extras) => ({
        ...(await fakeDeps(async () => ({ text: "unused" }))(extras)),
        getProvider: () => ({
          providerId: "fake",
          supportsStreaming: () => false,
          transcribe: async (o) => {
            audioBytes.push(o.audio.length);
            return { text: "hello from the system track" };
          },
        }),
      }),
      vadDeps: {
        resolveBinaryPath: () => "/fake/fluidaudio-diarize",
        resolveModelsDirPath: () => "/fake/resources/models",
        execFile: async (_file, args) => ({
          stdout: args[1]?.endsWith("mic.wav")
            ? "[]"
            : '[{"startMs":600,"endMs":1400}]',
          stderr: "",
        }),
      },
    });
    insertMeeting("m1");

    const res = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(res.status).toBe(202);
    const done = await waitForTerminalStatus("m1");
    expect(done.status).toBe("transcribed");

    // One provider call (system). 800 ms of 16 kHz s16 mono + 44-byte header.
    // The full 1800 ms system chunk, not only its 800 ms span (round r227).
    expect(audioBytes).toEqual([44 + 1800 * 16 * 2]);
    const rows = getDb()
      .prepare(
        "SELECT source, status, start_ms, end_ms FROM meeting_segments WHERE meeting_id = 'm1' ORDER BY source",
      )
      .all() as Array<{
      source: string;
      status: string;
      start_ms: number;
      end_ms: number;
    }>;
    const mic = rows.find((r) => r.source === "mic");
    const system = rows.find((r) => r.source === "system");
    expect(mic?.status).toBe("empty");
    expect(system?.status).toBe("ok");
    // The stored chunk times are the segment times, not the span times.
    expect(system!.start_ms).toBeLessThanOrEqual(600);
    expect(system!.end_ms).toBeGreaterThanOrEqual(1400);
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
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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

    const res = await postEmpty(app, "/api/meetings/m1/transcribe");
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
    // Microtask poll: see "re-transcribes only failed chunks".
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
    const res = await postEmpty(app, "/api/meetings/m1/transcribe");
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
    insertSpeaker("m1", "1", { displayName: "Ana" });

    const res = await postEmpty(app, "/api/meetings/m1/transcribe");
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
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      title: "  New title  ",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; title: string };
    expect(body.title).toBe("New title");
    const after = await getMeeting("m1");
    expect(after.title).toBe("New title");
  });

  it("404s for an unknown meeting", async () => {
    const res = await jsonRequest(app, "PATCH", "/api/meetings/nope", {
      title: "New title",
    });
    expect(res.status).toBe(404);
  });

  it("rejects an empty or whitespace-only title", async () => {
    insertMeeting("m1");
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      title: "   ",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a title over the length cap", async () => {
    insertMeeting("m1");
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      title: "x".repeat(513),
    });
    expect(res.status).toBe(400);
  });

  it("sets the meeting's language (Phase A2 chip edit)", async () => {
    insertMeeting("m1");
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      language: "pt",
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
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      language: null,
    });
    expect(res.status).toBe(200);
    const after = await getMeeting("m1");
    expect(after.language).toBeNull();
  });

  it("rejects a PATCH body with neither title nor language", async () => {
    insertMeeting("m1");
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {});
    expect(res.status).toBe(400);
  });

  // specs/meeting-speaker-naming.md §3.4/§6.4
  it("sets the meeting's context and returns it on the next GET", async () => {
    insertMeeting("m1");
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      context: "Call with Ana from Acme",
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
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      context: null,
    });
    expect(res.status).toBe(200);
    const after = await getMeeting("m1");
    expect(after.context).toBeNull();
  });

  it("accepts a body with only context (no title/language) — the refine no longer rejects it", async () => {
    insertMeeting("m1");
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      context: "just context",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a body with none of title/language/context", async () => {
    insertMeeting("m1");
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {});
    expect(res.status).toBe(400);
  });

  it("rejects context over the 2000-char cap", async () => {
    insertMeeting("m1");
    const res = await jsonRequest(app, "PATCH", "/api/meetings/m1", {
      context: "x".repeat(2001),
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
    await postEmpty(app, "/api/meetings/m1/transcribe");
    // The job has more async steps (the VAD gate) than one real-timer
    // poll covers under fake timers: poll on microtasks.
    const afterFirst = await waitForTerminalStatusNoRealTimers("m1");
    expect(afterFirst.status).toBe("transcribed");
    const firstCounts = afterFirst.segment_counts as { failed: number };
    expect(firstCounts.failed).toBeGreaterThan(0);

    // Retry with a working provider: everything recovers.
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({ text: "recovered" })),
    });
    const res = await postEmpty(app, "/api/meetings/m1/retry-failed");
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
    const res = await postEmpty(app, "/api/meetings/m1/retry-failed");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, retried: 0 });
  });

  // Phase 3a (specs/meeting-transcription-v2.md §3.1): retry-failed passes
  // lanes: false — the old shared pool, not the per-channel lanes.
  it("runs the retry pass on the old shared pool, not the lanes (phase 3a)", async () => {
    // The shared audioDir WAV is 2 s; the failed rows below reach 5 s,
    // so this meeting gets its own dir with 8 s WAVs.
    const dir = mkdtempSync(join(tmpdir(), "meeting-retry-test-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const wav = buildWav(4000, 2000);
    writeFileSync(join(dir, "mic.wav"), wav);
    writeFileSync(join(dir, "system.wav"), wav);
    insertMeeting("m1", "transcribed", dir);
    // Two failed rows per channel, distinct lengths per channel, so the
    // slice byte count identifies the chunk (1 s = 32 044 B, 3 s = 96 044).
    // mic.wav and system.wav are identical, so mic[i] and system[i] share
    // a length: the old pool's first two in-flight calls (mic[0], mic[1])
    // have DIFFERENT lengths, while the lanes path's (mic[0], system[0])
    // would have EQUAL ones.
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 1000,
      source: "mic",
      text: null,
      status: "failed",
    });
    insertSegment({
      id: "s2",
      meetingId: "m1",
      idx: 1,
      startMs: 2000,
      endMs: 5000,
      source: "mic",
      text: null,
      status: "failed",
    });
    insertSegment({
      id: "s3",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 1000,
      source: "system",
      text: null,
      status: "failed",
    });
    insertSegment({
      id: "s4",
      meetingId: "m1",
      idx: 1,
      startMs: 2000,
      endMs: 5000,
      source: "system",
      text: null,
      status: "failed",
    });

    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let started = 0;
    const startedBytes: number[] = [];
    __setMeetingsTestOverrides({
      createTranscriberDeps: async (extras) => ({
        getProvider: () => ({
          providerId: "fake",
          transcribe: async (o) => {
            startedBytes.push(o.audio.length);
            started++;
            if (started === 2) release();
            await gate;
            return { text: "recovered" };
          },
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
      }),
    });

    const res = await postEmpty(app, "/api/meetings/m1/retry-failed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { retried: number; failed: number };
    expect(body.retried).toBe(4);
    expect(body.failed).toBe(0);
    // The first two in-flight calls were the first two tasks — both mic.
    expect(startedBytes.slice(0, 2)).toEqual([32_044, 96_044]);
  });

  // I3 (specs/meeting-transcription-v2.md §3.3): retry-failed resolves the
  // model from the row's own stt_provider/stt_model stamp, not from the
  // current default or the meeting model setting.
  it("resolves the model from a still-valid row stamp (I3)", async () => {
    insertMeeting("m1", "transcribed");
    getDb()
      .prepare(
        "UPDATE meetings SET stt_provider = ?, stt_model = ? WHERE id = ?",
      )
      .run("openai", "whisper-1", "m1");
    getDb()
      .prepare(
        `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
         VALUES ('openai', 'whisper-1', 'Whisper', 'voice', 0)`,
      )
      .run();
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 1000,
      source: "system",
      text: null,
      status: "failed",
    });

    let seenOverride: { provider: string; modelId: string } | undefined;
    const seenModels: string[] = [];
    __setMeetingsTestOverrides({
      createTranscriberDeps: async (extras, override) => {
        seenOverride = override;
        return {
          getProvider: () => ({
            providerId: "openai",
            transcribe: async (o) => {
              seenModels.push(o.model);
              return { text: "recovered" };
            },
            supportsStreaming: () => false,
          }),
          resolveConfig: () => ({
            providerId: override?.provider ?? "fake",
            modelId: override?.modelId ?? "fake-model",
            apiKey: "key",
            bias: null,
          }),
          sleep: async () => {},
          backoffBaseMs: 1,
          maxAttempts: 1,
          ...extras,
        };
      },
    });

    const res = await postEmpty(app, "/api/meetings/m1/retry-failed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { retried: number; failed: number };
    expect(body.retried).toBe(1);
    expect(body.failed).toBe(0);
    // The factory got the row's pair, and the provider was called with it.
    expect(seenOverride).toEqual({ provider: "openai", modelId: "whisper-1" });
    expect(seenModels).toEqual(["whisper-1"]);
    const after = await getMeeting("m1");
    expect((after.segment_counts as { failed: number }).failed).toBe(0);
  });

  it("passes no model override when the row has no stt stamp (I3)", async () => {
    insertMeeting("m1", "transcribed");
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 1000,
      source: "system",
      text: null,
      status: "failed",
    });

    let seenOverride: unknown = "unset";
    const seenModels: string[] = [];
    __setMeetingsTestOverrides({
      createTranscriberDeps: async (extras, override) => {
        seenOverride = override;
        return {
          getProvider: () => ({
            providerId: "fake",
            transcribe: async (o) => {
              seenModels.push(o.model);
              return { text: "recovered" };
            },
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
          maxAttempts: 1,
          ...extras,
        };
      },
    });

    const res = await postEmpty(app, "/api/meetings/m1/retry-failed");
    expect(res.status).toBe(200);
    expect(seenOverride).toBeUndefined();
    // Normal resolution ran: the provider was called with the default.
    expect(seenModels).toEqual(["fake-model"]);
  });

  it("falls back to normal resolution for a stamp whose provider is gone (I3)", async () => {
    // Migration 36 never rewrites meetings.stt_provider: a meeting stamped
    // "omlx" must retry with the normal resolution, not 500 on the gone
    // provider.
    insertMeeting("m1", "transcribed");
    getDb()
      .prepare(
        "UPDATE meetings SET stt_provider = ?, stt_model = ? WHERE id = ?",
      )
      .run("omlx", "omlx/qwen3-asr", "m1");
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 1000,
      source: "system",
      text: null,
      status: "failed",
    });

    let seenOverride: unknown = "unset";
    const seenModels: string[] = [];
    __setMeetingsTestOverrides({
      createTranscriberDeps: async (extras, override) => {
        seenOverride = override;
        return {
          getProvider: () => ({
            providerId: "fake",
            transcribe: async (o) => {
              seenModels.push(o.model);
              return { text: "recovered" };
            },
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
          maxAttempts: 1,
          ...extras,
        };
      },
    });

    const res = await postEmpty(app, "/api/meetings/m1/retry-failed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { retried: number; failed: number };
    expect(body.retried).toBe(1);
    expect(body.failed).toBe(0);
    expect(seenOverride).toBeUndefined();
    expect(seenModels).toEqual(["fake-model"]);
  });

  it("falls back to normal resolution for a stamp whose pair is no longer configured (I3)", async () => {
    // An "openai" stamp from the old openai_stt_base_url override: the
    // provider still exists, but the pair is gone from model_configs — the
    // retry must not send meeting audio to a cloud provider the user no
    // longer configured.
    insertMeeting("m1", "transcribed");
    getDb()
      .prepare(
        "UPDATE meetings SET stt_provider = ?, stt_model = ? WHERE id = ?",
      )
      .run("openai", "whisper-1", "m1");
    insertSegment({
      id: "s1",
      meetingId: "m1",
      idx: 0,
      startMs: 0,
      endMs: 1000,
      source: "system",
      text: null,
      status: "failed",
    });

    let seenOverride: unknown = "unset";
    __setMeetingsTestOverrides({
      createTranscriberDeps: async (extras, override) => {
        seenOverride = override;
        return fakeDeps(async () => ({ text: "recovered" }))(extras);
      },
    });

    const res = await postEmpty(app, "/api/meetings/m1/retry-failed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { retried: number; failed: number };
    expect(body.retried).toBe(1);
    expect(body.failed).toBe(0);
    expect(seenOverride).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T1-1 (specs/lean-audit-2026-09.md §3): cancellable transcription jobs +
// boot recovery for a quit mid-job. The shared fixture WAV is a single burst
// per channel (2 chunks total, both in flight at once under concurrency 2) —
// the cancel tests below need more chunks than workers, so they get their
// own fixture: 3 bursts per channel separated by 6 s of silence (gap >
// mergeSegmentsToward's 4 s maxGapMs, so nothing merges) = 6 chunk tasks,
// concurrency 2.
// ---------------------------------------------------------------------------

/** 16 kHz mono PCM16 WAV: 2 s lead-in silence, then N × (1 s tone burst +
 * 6 s silence). The lead-in matters: the segmenter's noise floor is
 * adaptive, and without calibration silence it swallows the first burst. */
function buildMultiBurstWav(bursts: number): Buffer {
  const leadMs = 2000;
  const burstMs = 1000;
  const gapMs = 6000;
  const totalMs = leadMs + bursts * burstMs + (bursts - 1) * gapMs;
  const totalSamples = Math.round((totalMs / 1000) * SAMPLE_RATE);
  const ranges: Array<[number, number]> = [];
  for (let b = 0; b < bursts; b++) {
    const start = Math.round(
      ((leadMs + b * (burstMs + gapMs)) / 1000) * SAMPLE_RATE,
    );
    const end = Math.round(
      ((leadMs + b * (burstMs + gapMs) + burstMs) / 1000) * SAMPLE_RATE,
    );
    ranges.push([start, end]);
  }
  return buildBaseWav({ data: tonePayload(totalSamples, ranges) });
}

let cancelAudioDir: string;

/** Spin microtasks until `cond` holds (bounded). The transcribe job is
 * all-microtask under fake timers once the fake deps park on a gate, same
 * reasoning as waitForTerminalStatusNoRealTimers. */
async function waitForMicrotasks(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 20_000; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error("condition never met via microtasks");
}

describe("POST /api/meetings/:id/cancel-transcribe", () => {
  beforeAll(() => {
    cancelAudioDir = mkdtempSync(join(tmpdir(), "meeting-cancel-"));
    const wav = buildMultiBurstWav(3);
    writeFileSync(join(cancelAudioDir, "mic.wav"), wav);
    writeFileSync(join(cancelAudioDir, "system.wav"), wav);
    writeFileSync(
      join(cancelAudioDir, "sync.json"),
      JSON.stringify({
        meetingId: "m1",
        sampleRate: SAMPLE_RATE,
        micT0: 1000,
        systemT0: 1000,
        syncMarkers: [],
        epochs: [],
      }),
    );
  });

  afterAll(() => {
    rmSync(cancelAudioDir, { recursive: true, force: true });
  });

  it("404s for an unknown meeting", async () => {
    const res = await postEmpty(app, "/api/meetings/nope/cancel-transcribe");
    expect(res.status).toBe(404);
  });

  it("409s when no job is running for the meeting", async () => {
    insertMeeting("m1", "recorded");
    const res = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("No transcription job");
  });

  it("409s when the active job is a diarize pass (slot held, not cancellable)", async () => {
    insertMeeting("m1", "transcribed", cancelAudioDir);
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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

    const diarizePromise = postEmpty(app, "/api/meetings/m1/diarize");
    // Let the diarize handler claim the slot under fake timers (same
    // reasoning as the enhance 409 test above).
    await vi.advanceTimersByTimeAsync(20);

    const res = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
    expect(res.status).toBe(409);

    release();
    await diarizePromise;
  });

  it("cancels mid-job: in-flight chunks finish and persist, unstarted chunks never run, status → failed, segments kept, slot freed", async () => {
    let calls = 0;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        // Capture the call number *before* parking: both workers increment
        // before either gate resolves.
        const n = ++calls;
        // Park the first two chunks (both workers) so the cancel lands
        // with 2 of 6 tasks in flight and 4 unstarted.
        if (n <= 2) await gate;
        return { text: `chunk number ${n}` };
      }),
    });
    insertMeeting("m1", "recorded", cancelAudioDir);

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    await waitForMicrotasks(() => calls >= 2);

    // Release the gate no matter what any assertion below does — a failed
    // expect mid-test must not park the job (and its activeJobs slot)
    // forever for every test after this one.
    try {
      // Fixture sanity: 3 bursts × 2 channels = 6 chunk tasks, so the
      // cancel below really leaves 4 unstarted (a 2-task fixture would
      // pass the later assertions vacuously).
      const mid = await getMeeting("m1");
      expect(mid.job).toMatchObject({ done: 0, total: 6 });

      const cancel = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
      expect(cancel.status).toBe(202);

      // Idempotent while winding down: the slot is still held, the second
      // cancel is an acknowledged no-op (documented semantics).
      const cancelAgain = await postEmpty(
        app,
        "/api/meetings/m1/cancel-transcribe",
      );
      expect(cancelAgain.status).toBe(202);
    } finally {
      release();
    }

    const done = await waitForTerminalStatusNoRealTimers("m1");
    expect(done.status).toBe("failed");
    expect(done.error).toBe("Cancelled by user");
    expect(done.job).toBeNull();

    // The two in-flight chunks were allowed to finish and their segments
    // survive; the four unstarted chunks never ran (calls stays at 2).
    expect(calls).toBe(2);
    const counts = done.segment_counts as { total: number; failed: number };
    expect(counts.total).toBe(2);
    expect(counts.failed).toBe(0);

    const tRes = await app.request("/api/meetings/m1/transcript");
    const { segments } = (await tRes.json()) as {
      segments: Array<{ text: string }>;
    };
    expect(segments.map((s) => s.text).sort()).toEqual([
      "chunk number 1",
      "chunk number 2",
    ]);

    // Slot freed — a third cancel is a plain 409.
    const after = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
    expect(after.status).toBe(409);
  });

  it("GET /orphans excludes meetings with a live job (boot sweep must not kill a running/winding-down transcription)", async () => {
    let calls = 0;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        calls++;
        await gate;
        return { text: `chunk ${calls}` };
      }),
    });
    insertMeeting("m1", "recorded", cancelAudioDir);
    // A second stuck row with NO live job — this one *is* an orphan.
    insertMeeting("m2", "transcribing", cancelAudioDir);

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    await waitForMicrotasks(() => calls >= 1);

    try {
      const res = await app.request("/api/meetings/orphans");
      expect(res.status).toBe(200);
      const { items } = (await res.json()) as {
        items: Array<{ id: string }>;
      };
      const ids = items.map((o) => o.id);
      // The live job's row is excluded even mid-wind-down; the jobless
      // 'transcribing' row still sweeps.
      expect(ids).toContain("m2");
      expect(ids).not.toContain("m1");
    } finally {
      release();
    }
    await waitForTerminalStatusNoRealTimers("m1");
  });
});

describe("POST /api/meetings/:id/cancel-transcribe — with a failed chunk (the Electron E2E staging)", () => {
  // Mirror of apps/electron/tests/meeting-cancel-transcribe.test.ts: a
  // system-channel-only 2-burst meeting (2 chunks, one serial lane — phase
  // 3a means a single-channel meeting can never have two chunks in flight).
  // Chunk 1 burns all its attempts (failed segment persisted), chunk 2
  // parks in flight; the cancel lands with one failed + one in-flight
  // chunk. Proves the data contract the E2E's UI assertions rest on: the
  // partial transcript survives, segment_counts carries the failed chunk,
  // and /retry-failed re-runs it.
  let e2eAudioDir: string;

  beforeAll(() => {
    e2eAudioDir = mkdtempSync(join(tmpdir(), "meeting-cancel-e2e-"));
    writeFileSync(join(e2eAudioDir, "system.wav"), buildMultiBurstWav(2));
    writeFileSync(
      join(e2eAudioDir, "sync.json"),
      JSON.stringify({
        meetingId: "m1",
        sampleRate: SAMPLE_RATE,
        micT0: 1000,
        systemT0: 1000,
        syncMarkers: [],
        epochs: [],
      }),
    );
  });

  afterAll(() => {
    rmSync(e2eAudioDir, { recursive: true, force: true });
  });

  it("keeps the partial transcript, counts the failed chunk, and retry-failed re-runs it", async () => {
    let calls = 0;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        const n = ++calls;
        // Chunk 1 burns both attempts (fakeDeps: maxAttempts 2); chunk 2
        // (call 3 — the lane is serial) parks until release.
        if (n <= 2) throw new Error("forced 500 for the cancel test");
        await gate;
        return { text: "kept partial transcript" };
      }),
    });
    insertMeeting("m1", "recorded", e2eAudioDir);

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    await waitForMicrotasks(() => calls >= 3);

    try {
      // One chunk failed (persisted), one in flight — the E2E's cancel
      // point.
      const mid = await getMeeting("m1");
      expect(mid.job).toMatchObject({ done: 1, failed: 1, total: 2 });

      const cancel = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
      expect(cancel.status).toBe(202);
    } finally {
      release();
    }

    const done = await waitForTerminalStatusNoRealTimers("m1");
    expect(done.status).toBe("failed");
    expect(done.error).toBe("Cancelled by user");
    expect(done.job).toBeNull();
    // Both segments kept: the ok one (kept partial transcript) and the
    // failed one — so the UI's "Retry 1 failed" has something real to
    // retry.
    expect(done.segment_counts).toEqual({ total: 2, failed: 1 });

    const rows = getDb()
      .prepare(
        `SELECT status, text FROM meeting_segments WHERE meeting_id = 'm1' ORDER BY idx`,
      )
      .all() as Array<{ status: string; text: string }>;
    expect(rows).toEqual([
      { status: "failed", text: "" },
      { status: "ok", text: "kept partial transcript" },
    ]);

    // The merged transcript carries only the ok segment.
    const tRes = await app.request("/api/meetings/m1/transcript");
    const { segments } = (await tRes.json()) as {
      segments: Array<{ text: string }>;
    };
    expect(segments.map((s) => s.text)).toEqual(["kept partial transcript"]);

    // The retry route re-runs exactly the failed chunk; on success its row
    // flips to ok and the stale failure error clears.
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({
        text: "recovered chunk",
      })),
    });
    const retry = await postEmpty(app, "/api/meetings/m1/retry-failed");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, retried: 1, failed: 0 });

    const after = await getMeeting("m1");
    expect(after.error).toBeNull();
    expect(after.segment_counts).toEqual({ total: 2, failed: 0 });
    const t2 = await app.request("/api/meetings/m1/transcript");
    const seg2 = (
      (await t2.json()) as { segments: Array<{ text: string }> }
    ).segments.map((s) => s.text);
    expect(seg2.sort()).toEqual(["kept partial transcript", "recovered chunk"]);
  });
});

describe("POST /api/meetings/:id/cancel-transcribe — during retry-failed", () => {
  beforeAll(() => {
    cancelAudioDir = mkdtempSync(join(tmpdir(), "meeting-cancel-retry-"));
    const wav = buildMultiBurstWav(3);
    writeFileSync(join(cancelAudioDir, "mic.wav"), wav);
    writeFileSync(join(cancelAudioDir, "system.wav"), wav);
    writeFileSync(
      join(cancelAudioDir, "sync.json"),
      JSON.stringify({ sampleRate: SAMPLE_RATE, syncMarkers: [], epochs: [] }),
    );
  });

  afterAll(() => {
    rmSync(cancelAudioDir, { recursive: true, force: true });
  });

  it("cancels a retry-failed pass: retried chunks keep their new text, the rest stay failed, meeting status untouched, slot freed", async () => {
    insertMeeting("m1", "transcribed", cancelAudioDir);
    // 4 failed system segments on disk-backed times.
    for (let i = 0; i < 4; i++) {
      insertSegment({
        id: `m1:system:${i}`,
        meetingId: "m1",
        idx: i,
        startMs: i * 7000,
        endMs: i * 7000 + 1000,
        text: null,
        status: "failed",
      });
    }
    getDb()
      .prepare("UPDATE meetings SET error = '4 chunks failed' WHERE id = 'm1'")
      .run();

    let calls = 0;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        calls++;
        if (calls <= 2) await gate;
        return { text: `recovered ${calls}` };
      }),
    });

    const retryPromise = postEmpty(app, "/api/meetings/m1/retry-failed");
    await waitForMicrotasks(() => calls >= 2);

    try {
      const cancel = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
      expect(cancel.status).toBe(202);
    } finally {
      release();
    }

    const res = await retryPromise;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: true, retried: 2 });

    const rows = getDb()
      .prepare(
        "SELECT text, status FROM meeting_segments WHERE meeting_id = 'm1' ORDER BY idx",
      )
      .all() as { text: string | null; status: string }[];
    expect(rows.filter((r) => r.status === "ok")).toHaveLength(2);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(2);
    expect(
      rows.filter((r) => r.status === "ok").map((r) => r.text?.slice(0, 9)),
    ).toEqual(["recovered", "recovered"]);

    // retry-failed never owns meetings.status — cancelled or not.
    const after = await getMeeting("m1");
    expect(after.status).toBe("transcribed");
    expect(after.job).toBeNull();

    const cancelAgain = await postEmpty(
      app,
      "/api/meetings/m1/cancel-transcribe",
    );
    expect(cancelAgain.status).toBe(409);
  });
});

describe("boot sweep — quit-mid-transcription recovery (T1-1a)", () => {
  it("GET /orphans returns both 'recording' and 'transcribing' rows with their status", async () => {
    insertMeeting("rec1", "recording");
    insertMeeting("tra1", "transcribing");
    insertMeeting("done1", "transcribed");
    const res = await app.request("/api/meetings/orphans");
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ id: string; status: string }>;
    };
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["rec1", "tra1"]);
    const byId = new Map(items.map((i) => [i.id, i.status]));
    expect(byId.get("rec1")).toBe("recording");
    expect(byId.get("tra1")).toBe("transcribing");
  });

  it("the boot path (orphans → /transcribe-interrupted) resets a 'transcribing' row to failed with the exact error", async () => {
    insertMeeting("m1", "transcribing");
    // Whatever the job managed to persist before the quit survives.
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);

    const orphans = await app.request("/api/meetings/orphans");
    const { items } = (await orphans.json()) as { items: { id: string }[] };
    expect(items.some((i) => i.id === "m1")).toBe(true);

    const res = await postEmpty(app, "/api/meetings/m1/transcribe-interrupted");
    expect(res.status).toBe(200);

    const after = await getMeeting("m1");
    expect(after.status).toBe("failed");
    expect(after.error).toBe("Interrupted — app quit during transcription");
    const counts = after.segment_counts as { total: number };
    expect(counts.total).toBe(1);
  });

  it("POST /:id/transcribe-interrupted is strict: 404 from any other status", async () => {
    insertMeeting("m1", "recorded");
    const fromRecorded = await postEmpty(
      app,
      "/api/meetings/m1/transcribe-interrupted",
    );
    expect(fromRecorded.status).toBe(404);

    // 'recording' orphans belong to the recorder's endpoint, not this one.
    insertMeeting("m2", "recording");
    const fromRecording = await postEmpty(
      app,
      "/api/meetings/m2/transcribe-interrupted",
    );
    expect(fromRecording.status).toBe(404);

    const unknown = await postEmpty(
      app,
      "/api/meetings/nope/transcribe-interrupted",
    );
    expect(unknown.status).toBe(404);

    // And a second sweep pass over an already-failed row is a 404 no-op.
    insertMeeting("m3", "transcribing");
    await postEmpty(app, "/api/meetings/m3/transcribe-interrupted");
    const again = await postEmpty(
      app,
      "/api/meetings/m3/transcribe-interrupted",
    );
    expect(again.status).toBe(404);
  });

  it("the recording branch of the boot path still works: /interrupted from 'recording' only", async () => {
    insertMeeting("m1", "recording");
    const res = await jsonRequest(app, "POST", "/api/meetings/m1/interrupted", {
      duration_ms: 12345,
    });
    expect(res.status).toBe(200);
    const after = await getMeeting("m1");
    expect(after.status).toBe("interrupted");
    expect(after.duration_ms).toBe(12345);

    // Strict from anywhere else.
    insertMeeting("m2", "transcribing");
    const wrongState = await jsonRequest(
      app,
      "POST",
      "/api/meetings/m2/interrupted",
      {},
    );
    expect(wrongState.status).toBe(404);
  });
});

describe("POST /api/meetings/:id/transcribe — Phase A1 leak filter", () => {
  afterEach(() => {
    getDb().exec("DELETE FROM vocabulary");
    getDb()
      .prepare("DELETE FROM settings WHERE key = 'meeting_asr_context'")
      .run();
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

    await postEmpty(app, "/api/meetings/m1/transcribe");
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

  it("filters a stored full-prompt echo (label + terms + context) end to end", async () => {
    // Phase 3b: the echo guard retries a full-prompt echo without context,
    // but a stubborn model returns the echo again; the persist check must
    // catch it (label AND terms+context draw), where the terms-only check
    // is diluted by the context words.
    getDb().prepare("INSERT INTO vocabulary (term) VALUES (?)").run("AlphaCo");
    getDb().prepare("INSERT INTO vocabulary (term) VALUES (?)").run("BetaLab");
    // The context must be on (off by default since 2026-10-07): the echo
    // only contains the context words when chunk 1 got chunk 0's tail.
    getDb()
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('meeting_asr_context', 'true') \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run();
    const dir = mkdtempSync(join(tmpdir(), "meeting-3b-persist-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // Two 3.5 s tone bursts (both >= 3 s, so the second chunk is eligible
    // for context) with a 5 s silence between (the segmenter keeps two
    // bursts separate at 5 s, merges them at 4.5 s, for this layout), 2 s
    // lead-in so the adaptive noise floor calibrates, 2 s trailing.
    // Silence-only system.
    const leadMs = 2000,
      burstMs = 3500,
      gapMs = 5000,
      trailMs = 2000;
    const totalMs = leadMs + 2 * burstMs + gapMs + trailMs;
    const s = (ms: number) => Math.round((ms / 1000) * SAMPLE_RATE);
    writeFileSync(
      join(dir, "mic.wav"),
      buildBaseWav({
        data: tonePayload(s(totalMs), [
          [s(leadMs), s(leadMs + burstMs)],
          [s(leadMs + burstMs + gapMs), s(leadMs + 2 * burstMs + gapMs)],
        ]),
      }),
    );
    writeFileSync(join(dir, "system.wav"), buildBaseWav({ samples: 1600 }));
    writeFileSync(
      join(dir, "sync.json"),
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
    const cleanText =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi";
    const fullEcho = `Technical terms: AlphaCo, BetaLab ${cleanText}`;
    let call = 0;
    __setMeetingsTestOverrides({
      createTranscriberDeps: async (extras) => ({
        getProvider: () => ({
          providerId: "server",
          transcribe: async () => ({
            text: ++call === 1 ? cleanText : fullEcho,
          }),
          supportsStreaming: () => false,
        }),
        resolveConfig: () => ({
          providerId: "server",
          modelId: "fake-model",
          apiKey: "key",
          language: "en",
          bias: { kind: "prompt", text: "Technical terms: AlphaCo, BetaLab" },
        }),
        sleep: async () => {},
        backoffBaseMs: 1,
        maxAttempts: 2,
        detectAll: () => [{ lang: "en", accuracy: 0.9 }],
        // onChunk (the persist hook) and friends come from the route.
        ...extras,
      }),
    });
    insertMeeting("m1", "recorded", dir);
    // A2: the route pins the meeting language (stored value wins
    // without probing) and wraps resolveConfig with it — the
    // context guard needs a declared language.
    getDb()
      .prepare("UPDATE meetings SET language = 'en' WHERE id = 'm1'")
      .run();

    await postEmpty(app, "/api/meetings/m1/transcribe");
    const done = await waitForTerminalStatusNoRealTimers("m1");
    expect(done.status).toBe("transcribed");

    const rows = getDb()
      .prepare(
        "SELECT source, idx, status, text FROM meeting_segments WHERE meeting_id = 'm1' ORDER BY source, idx",
      )
      .all() as {
      source: string;
      idx: number;
      status: string;
      text: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.text).toBe(cleanText);
    // The stubborn full-prompt echo: label AND terms+context draw →
    // filtered, text NULL.
    expect(rows[1]!.status).toBe("filtered");
    expect(rows[1]!.text).toBeNull();
  });
});

describe("POST /api/meetings/:id/diarize", () => {
  it("404s for an unknown meeting", async () => {
    const res = await postEmpty(app, "/api/meetings/nope/diarize");
    expect(res.status).toBe(404);
  });

  it("409s when the meeting has no transcript yet", async () => {
    insertMeeting("m1", "recorded");
    const res = await postEmpty(app, "/api/meetings/m1/diarize");
    expect(res.status).toBe(409);
  });

  it("409s while the meeting is still transcribing", async () => {
    insertMeeting("m1", "transcribing");
    const res = await postEmpty(app, "/api/meetings/m1/diarize");
    expect(res.status).toBe(409);
  });

  it("409s when the meeting has no audio directory", async () => {
    insertMeeting("m1", "transcribed", null);
    const res = await postEmpty(app, "/api/meetings/m1/diarize");
    expect(res.status).toBe(409);
  });

  it("409s when system.wav is missing from disk", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "meeting-diarize-nowav-"));
    try {
      insertMeeting("m1", "transcribed", emptyDir);
      const res = await postEmpty(app, "/api/meetings/m1/diarize");
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
    const res = await postEmpty(app, "/api/meetings/m1/diarize");
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

    const res = await postEmpty(app, "/api/meetings/m1/diarize");
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

    const res = await postEmpty(app, "/api/meetings/m1/diarize");
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
    insertSpeaker("m1", "1", { displayName: "Ana" });

    const res = await postEmpty(app, "/api/meetings/m1/diarize");
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

    const res = await postEmpty(app, "/api/meetings/m1/diarize");
    expect(res.status).toBe(200);

    const after = readFileSync(transcriptPath, "utf8");
    expect(after).not.toContain("STALE-PLACEHOLDER-CONTENT");
    expect(after).toMatch(/Them 1:/);
  });
});

describe("GET /api/meetings/:id/speakers", () => {
  it("404s for an unknown meeting", async () => {
    const res = await app.request("/api/meetings/nope/speakers");
    expect(res.status).toBe(404);
  });

  it("returns one row per distinct labeled speaker plus unlabeledCount; a labeled row without a meeting_speakers row shows all-null optional fields", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
    insertSystemSegment("m1:system:1", "m1", 1, 1000, 2000, "2");
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
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
    insertSystemSegment("m1:system:1", "m1", 1, 1000, 2000, "2");
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
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");

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
    return jsonRequest(
      app,
      "PATCH",
      `/api/meetings/${meetingId}/speakers/${label}`,
      body,
    );
  }

  it("404s when the meeting doesn't exist", async () => {
    const res = await patchSpeaker("nope", "1", { displayName: "Ana" });
    expect(res.status).toBe(404);
  });

  it("400s on an empty body", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
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
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
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
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
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
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
    insertSystemSegment("m1:system:1", "m1", 1, 1000, 2000, "2");
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
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
    const res = await patchSpeaker("m1", "1", { mergedInto: "1" });
    expect(res.status).toBe(400);
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM meeting_speakers WHERE meeting_id = 'm1' AND speaker_label = '1'",
      )
      .get() as { c: number };
    expect(row.c).toBe(0);
  });

  it("400s when the target already merged into this label, changing no row", async () => {
    insertMeeting("m1", "transcribed");
    for (const [id, idx, label] of [
      ["m1:system:0", 0, "1"],
      ["m1:system:1", 1, "2"],
    ] as const) {
      insertSystemSegment(id, "m1", idx, idx * 1000, idx * 1000 + 1000, label);
    }
    // "2" is already merged into "1". Merging "1" into "2" would loop.
    insertSpeaker("m1", "2", { mergedInto: "1" });
    const res = await patchSpeaker("m1", "1", { mergedInto: "2" });
    expect(res.status).toBe(400);
    const rows = getDb()
      .prepare(
        "SELECT speaker_label, merged_into FROM meeting_speakers WHERE meeting_id = 'm1' ORDER BY speaker_label",
      )
      .all() as { speaker_label: string; merged_into: string | null }[];
    expect(rows).toEqual([{ speaker_label: "2", merged_into: "1" }]);
  });

  it("404s when mergedInto targets a nonexistent label", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
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
      insertSystemSegment(id, "m1", idx, idx * 1000, idx * 1000 + 1000, label);
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
      insertSystemSegment(id, "m1", idx, idx * 1000, idx * 1000 + 1000, label);
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
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
    insertSystemSegment("m1:system:1", "m1", 1, 1000, 2000, "2");
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
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000, "1");
    const transcriptPath = join(audioDir, "transcript.md");
    writeFileSync(transcriptPath, "STALE-PLACEHOLDER-CONTENT", "utf8");

    const res = await patchSpeaker("m1", "1", { displayName: "Ana" });
    expect(res.status).toBe(200);

    const after = readFileSync(transcriptPath, "utf8");
    expect(after).not.toContain("STALE-PLACEHOLDER-CONTENT");
    expect(after).toContain("Ana");
  });
});

/** The run list of a meeting, newest first (the route of 8.3). */
async function llmRuns(id: string): Promise<LlmRunInfo[]> {
  const res = await app.request(`/api/meetings/${id}/llm-runs`);
  expect(res.status).toBe(200);
  return ((await res.json()) as LlmRunListResponse).runs;
}

function seedModelAndMeeting(text = "we should ship on friday"): void {
  seedTestModel();
  insertMeeting("m1", "transcribed");
  insertSegment({
    id: "m1:mic:0",
    meetingId: "m1",
    source: "mic",
    idx: 0,
    startMs: 0,
    endMs: 2000,
    text,
  });
}

describe("POST /api/meetings/:id/summarize", () => {
  beforeEach(() => {
    __resetLlmLanesForTests();
    __clearModeCacheForTests();
  });

  it("409s when the meeting has no transcript", async () => {
    insertMeeting("m1", "recorded");
    const res = await postEmpty(app, "/api/meetings/m1/summarize");
    expect(res.status).toBe(409);
  });

  it("returns 202 with the run id before any answer; the run has the summarize stage only and frees the slot", async () => {
    seedModelAndMeeting();
    const h = runnerHarness({
      answer: defaultAnswer,
    });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    const res = await postEmpty(app, "/api/meetings/m1/summarize");
    expect(res.status).toBe(202);
    const body = (await res.json()) as StartRunResponse;
    expect(body).toEqual({ ok: true, id: "m1", runId: body.runId });
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);

    await waitForNoJob("m1");
    const runs = await llmRuns("m1");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: body.runId,
      kind: "summarize",
      startedBy: "button",
      status: "succeeded",
    });
    // No correction request: the summarize stage only.
    expect(h.requests.some((r) => !isSummaryRequest(r))).toBe(false);
    expect((await getMeeting("m1")).job).toBeNull();
  });

  it.skipIf(SUMMARIZE_IS_STUB)(
    "persists the summary the poll delivers; the job names kind summarize while it runs",
    async () => {
      seedModelAndMeeting();
      const h = runnerHarness({
        answer: defaultAnswer,
      });
      const hold = holdFirstRequest(h.model);
      __setMeetingsTestOverrides({ workflowDeps: h.deps });

      const res = await postEmpty(app, "/api/meetings/m1/summarize");
      expect(res.status).toBe(202);
      try {
        await hold.reached;
        const mid = await getMeeting("m1");
        expect(mid.job).toMatchObject({ kind: "summarize" });
        expect(mid.status).toBe("transcribed");
      } finally {
        hold.release();
      }
      await waitForNoJob("m1");
      const after = await getMeeting("m1");
      expect(after.status).toBe("summarized");
      expect(after.job).toBeNull();
      const summary = after.summary as { markdown: string };
      expect(summary.markdown).toContain("The team agreed to ship on Friday.");
      const stored = getDb()
        .prepare(
          "SELECT json_valid(summary_json) AS ok FROM meeting_summaries WHERE meeting_id = 'm1'",
        )
        .get() as { ok: number };
      expect(stored.ok).toBe(1);
    },
  );

  // specs/meeting-speaker-naming.md 9.3: threading check. The route must read
  // meetings.context and the run must put it in the prompt.
  it.skipIf(SUMMARIZE_IS_STUB)(
    "puts row.context in the summary prompt",
    async () => {
      seedModelAndMeeting("hello");
      getDb()
        .prepare(
          "UPDATE meetings SET context = 'Call with Ana from Acme' WHERE id = 'm1'",
        )
        .run();
      const h = runnerHarness({
        answer: defaultAnswer,
      });
      __setMeetingsTestOverrides({ workflowDeps: h.deps });
      expect((await postEmpty(app, "/api/meetings/m1/summarize")).status).toBe(
        202,
      );
      await waitForNoJob("m1");
      const request = h.requests.find(isSummaryRequest);
      expect(request?.system).toContain("Call with Ana from Acme");
    },
  );

  it.skipIf(SUMMARIZE_IS_STUB)(
    "409s a second summarize while one runs, and frees the slot afterwards",
    async () => {
      seedModelAndMeeting();
      const h = runnerHarness({
        answer: defaultAnswer,
      });
      const hold = holdFirstRequest(h.model);
      __setMeetingsTestOverrides({ workflowDeps: h.deps });
      expect((await postEmpty(app, "/api/meetings/m1/summarize")).status).toBe(
        202,
      );
      try {
        await hold.reached;
        // specs/meeting-llm-queue.md 2.4: the double submit used to be legal.
        const second = await postEmpty(app, "/api/meetings/m1/summarize");
        expect(second.status).toBe(409);
        expect((await postEmpty(app, "/api/meetings/m1/diarize")).status).toBe(
          409,
        );
        expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(
          409,
        );
      } finally {
        hold.release();
      }
      await waitForNoJob("m1");
      expect((await getMeeting("m1")).status).toBe("summarized");
      // One Summarize run: three extraction calls and the overview call.
      expect(h.requests.filter(isSummaryRequest)).toHaveLength(4);
      // The slot is free: a follow-up summarize is accepted again.
      expect((await postEmpty(app, "/api/meetings/m1/summarize")).status).toBe(
        202,
      );
      await waitForNoJob("m1");
      expect(h.requests.filter(isSummaryRequest)).toHaveLength(8);
    },
  );

  it("rejects a summary without an LLM and leaves meetings.error untouched", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 2000);
    // 6 constraint 3: meetings.error is the chunk-failure banner. A summarize
    // failure must not overwrite the transcript-integrity warning.
    getDb()
      .prepare(
        "UPDATE meetings SET error = '2 of 5 chunks failed' WHERE id = ?",
      )
      .run("m1");
    // No default model: reject the request before creating a run.
    getDb().prepare("DELETE FROM model_configs").run();
    const h = runnerHarness();
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    const res = await postEmpty(app, "/api/meetings/m1/summarize");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no_llm" });
    await waitForNoJob("m1");
    const after = await getMeeting("m1");
    expect(after.error).toBe("2 of 5 chunks failed");
    expect(after.status).toBe("transcribed");
    expect(after.summary).toBeNull();
    expect(await llmRuns("m1")).toEqual([]);
    const segments = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM meeting_segments WHERE meeting_id = ?",
      )
      .get("m1") as { c: number };
    expect(segments.c).toBe(1);

    // A later run starts clean.
    seedTestModel();
    const again = await postEmpty(app, "/api/meetings/m1/summarize");
    expect(again.status).toBe(202);
    await waitForNoJob("m1");
    expect((await llmRuns("m1"))[0]?.status).toBe("succeeded");
  });

  it.skipIf(SUMMARIZE_IS_STUB)(
    "is cancellable: no summary is written, the transcript survives, the slot frees",
    async () => {
      seedModelAndMeeting("hello");
      const h = runnerHarness({ answer: () => HANG });
      __setMeetingsTestOverrides({ workflowDeps: h.deps });
      expect((await postEmpty(app, "/api/meetings/m1/summarize")).status).toBe(
        202,
      );
      await waitUntil(() => h.requests.length >= 1);
      const cancel = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
      expect(cancel.status).toBe(202);
      await waitForNoJob("m1");
      const after = await getMeeting("m1");
      expect(after.summary).toBeNull();
      expect(after.status).toBe("transcribed");
      expect(after.error).toBeNull();
      expect((await llmRuns("m1"))[0]?.status).toBe("cancelled");
      const tRes = await app.request("/api/meetings/m1/transcript");
      const body = (await tRes.json()) as { segments: { text: string }[] };
      expect(body.segments.map((s) => s.text)).toEqual(["hello"]);

      // The cancel flag went with the slot: a fresh summarize is not born cancelled.
      const h2 = runnerHarness({
        answer: defaultAnswer,
      });
      __setMeetingsTestOverrides({ workflowDeps: h2.deps });
      expect((await postEmpty(app, "/api/meetings/m1/summarize")).status).toBe(
        202,
      );
      await waitForNoJob("m1");
      expect((await getMeeting("m1")).status).toBe("summarized");
    },
  );
});

describe("POST /api/meetings/:id/enhance", () => {
  beforeEach(() => {
    __resetLlmLanesForTests();
    __clearModeCacheForTests();
  });

  it("404s for an unknown meeting", async () => {
    const res = await postEmpty(app, "/api/meetings/nope/enhance");
    expect(res.status).toBe(404);
  });

  it("409s when the meeting has no transcript", async () => {
    insertMeeting("m1", "recorded");
    const res = await postEmpty(app, "/api/meetings/m1/enhance");
    expect(res.status).toBe(409);
  });

  it("409s when the merged transcript is empty", async () => {
    insertMeeting("m1", "transcribed");
    const res = await postEmpty(app, "/api/meetings/m1/enhance");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Transcript is empty");
  });

  it("409s while another job is running for the meeting", async () => {
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    // Diarize claims the concurrency slot before its (fake) execFile call
    // resolves: a real interaction the route guards against, since diarize
    // never touches meetings.status.
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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

    const diarizePromise = postEmpty(app, "/api/meetings/m1/diarize");
    // Yield to the pending diarize handler under fake timers (setup.ts).
    await vi.advanceTimersByTimeAsync(20);

    const res = await postEmpty(app, "/api/meetings/m1/enhance");
    expect(res.status).toBe(409);

    release();
    await diarizePromise;
  });

  // specs/meeting-llm-queue.md 2.3 (Defect A): the route used to CHECK the
  // job and never CLAIM it. This pins the claim, the mutual exclusion in both
  // directions, the 202 body, and that the slot is released on every exit
  // path, success and failure alike. A leaked slot means that meeting can never
  // transcribe, diarize, summarize or enhance again until the app quits.
  it("409s a second concurrent enhance, then frees the slot on success and on failure", async () => {
    seedModelAndMeeting();
    const h = runnerHarness();
    const hold = holdFirstRequest(h.model);
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    const first = await postEmpty(app, "/api/meetings/m1/enhance");
    expect(first.status).toBe(202);
    const started = (await first.json()) as StartRunResponse;
    expect(started).toEqual({ ok: true, id: "m1", runId: started.runId });
    try {
      await hold.reached;
      const second = await postEmpty(app, "/api/meetings/m1/enhance");
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: string }).error).toBe(
        "Enhance is already running",
      );
      // The other writers are locked out for the same window.
      expect((await postEmpty(app, "/api/meetings/m1/summarize")).status).toBe(
        409,
      );
      expect((await postEmpty(app, "/api/meetings/m1/transcribe")).status).toBe(
        409,
      );
      // Held, and named: the renderer reads this to decide what it is looking at.
      expect((await getMeeting("m1")).job).toMatchObject({ kind: "enhance" });
    } finally {
      hold.release();
    }
    await waitForNoJob("m1");
    expect((await getMeeting("m1")).job).toBeNull();
    expect((await llmRuns("m1"))[0]).toMatchObject({
      id: started.runId,
      status: "succeeded",
    });

    // The slot is free after success. A rejected run does not claim it.
    expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(202);
    await waitForNoJob("m1");
    getDb().prepare("DELETE FROM model_configs").run();
    const runsBefore = await llmRuns("m1");
    expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(409);
    await waitForNoJob("m1");
    expect((await getMeeting("m1")).job).toBeNull();
    expect(await llmRuns("m1")).toEqual(runsBefore);
    expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(409);
    await waitForNoJob("m1");
  });

  it("enhances the merged transcript and persists enhanced_text; the run keeps the counts", async () => {
    seedModelAndMeeting("garbled txt here");
    const h = runnerHarness();
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    const res = await postEmpty(app, "/api/meetings/m1/enhance");
    expect(res.status).toBe(202);
    await waitForNoJob("m1");

    const row = getDb()
      .prepare(
        "SELECT enhanced_text FROM meeting_segments WHERE id = 'm1:mic:0'",
      )
      .get() as { enhanced_text: string };
    expect(row.enhanced_text).toBe(correctionText("m1:mic:0"));
    expect((await llmRuns("m1"))[0]).toMatchObject({
      status: "succeeded",
      correctedCount: 1,
      suggestionCount: 0,
    });
  });

  it("writes enhanced text only to transcript-enhanced.md, never to transcript.md", async () => {
    // 6.8 invariant: transcript.md is the RAW ASR file and must never be
    // touched by Enhance. The enhanced rendering goes only to the sibling file.
    seedModelAndMeeting("garbled txt here");
    const h = runnerHarness();
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(202);
    await waitForNoJob("m1");

    const raw = readFileSync(join(audioDir, "transcript.md"), "utf8");
    expect(raw).toContain("garbled txt here");
    expect(raw).not.toContain(correctionText("m1:mic:0"));

    const enhanced = readFileSync(
      join(audioDir, "transcript-enhanced.md"),
      "utf8",
    );
    expect(enhanced).toContain(correctionText("m1:mic:0"));
  });

  it("rejects Enhance and Summarize without a default LLM and creates no run", async () => {
    insertMeeting("m1", "transcribed");
    insertSegment({
      id: "m1:mic:0",
      meetingId: "m1",
      source: "mic",
      idx: 0,
      startMs: 0,
      endMs: 2000,
      text: "hello",
    });
    // No default model: "No AI model is set up yet."
    getDb().prepare("DELETE FROM model_configs").run();
    const h = runnerHarness();
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    for (const action of ["enhance", "summarize"]) {
      const res = await postEmpty(app, `/api/meetings/m1/${action}`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "No AI model is set up. Add one in Settings > Models.",
        code: "no_llm",
      });
      expect(await llmRuns("m1")).toEqual([]);
    }
    expect((await getMeeting("m1")).error).toBeNull();
  });

  // A wholly-failed pass is NOT "no segments needed correction". The run is
  // `failed`, the failed steps carry the error kind, nothing is persisted, and
  // meetings.error (the transcription chunk-failure banner) stays NULL.
  it("a pass in which every chunk failed is a failed run with the kind on its steps, and writes nothing", async () => {
    seedModelAndMeeting("garbled txt here");
    const h = runnerHarness({
      answer: () => reply("content-filter", "content_filter", ""),
    });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(202);
    await waitForNoJob("m1");

    const [run] = await llmRuns("m1");
    expect(run?.status).toBe("failed");
    const failedStep = run?.steps.find((s) => s.node === "correctChunk");
    expect(failedStep).toMatchObject({
      status: "failed",
      errorKind: "content_filter",
    });
    const seg = getDb()
      .prepare(
        "SELECT enhanced_text FROM meeting_segments WHERE id = 'm1:mic:0'",
      )
      .get() as { enhanced_text: string | null };
    expect(seg.enhanced_text).toBeNull();
    expect((await getMeeting("m1")).error).toBeNull();
    expect((await getMeeting("m1")).job).toBeNull();
  });

  it("a timeout of the model reaches the run record as provider_timeout", async () => {
    seedModelAndMeeting("garbled txt here");
    // The call timer fires at once: the call signal carries a TimeoutError.
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() =>
        AbortSignal.abort(new DOMException("timeout", "TimeoutError")),
      );
    onTestFinished(() => timeoutSpy.mockRestore());
    const h = runnerHarness({ answer: () => HANG });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(202);
    await waitForNoJob("m1");

    const [run] = await llmRuns("m1");
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.node === "correctChunk")?.errorKind).toBe(
      "provider_timeout",
    );
  });

  it("marks a partial pass partial in the run record instead of hiding the failed chunks", async () => {
    seedModelAndMeeting("garbled txt here");
    // Three chunks: the middle one is filtered.
    const f = seedFixtureMeeting({
      chunks: 3,
      speakers: 1,
      meetingId: "m2",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const h = runnerHarness({
      answer: (r) =>
        firstIdOf(r) === f.segmentIdsByChunk[1]?.[0]
          ? reply("content-filter", "content_filter", "")
          : defaultAnswer(r),
    });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    expect((await postEmpty(app, "/api/meetings/m2/enhance")).status).toBe(202);
    await waitForNoJob("m2");

    const [run] = await llmRuns("m2");
    expect(run).toMatchObject({
      status: "partial",
      correctedCount: 2,
      failedStepCount: 1,
    });
    expect((await getMeeting("m2")).error).toBeNull();
  });

  it("reports a clean pass as neither partial nor failed", async () => {
    seedModelAndMeeting("clean text");
    const h = runnerHarness({
      answer: (r) =>
        isSummaryRequest(r) ? defaultAnswer(r) : okReply('{"corrections":[]}'),
    });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(202);
    await waitForNoJob("m1");

    expect((await llmRuns("m1"))[0]).toMatchObject({
      status: "succeeded",
      correctedCount: 0,
      failedStepCount: 0,
    });
  });

  it("WP7: reports the dropped count when the model returns only the changed words", async () => {
    seedModelAndMeeting("we moved the cluster to cooper netties last week");
    const h = runnerHarness({
      answer: (r) =>
        isSummaryRequest(r)
          ? defaultAnswer(r)
          : okReply(
              JSON.stringify({
                corrections: [{ id: firstIdOf(r), text: "Kubernetes" }],
              }),
            ),
    });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(202);
    await waitForNoJob("m1");

    expect((await llmRuns("m1"))[0]).toMatchObject({
      status: "succeeded",
      correctedCount: 0,
      droppedCount: 1,
    });
  });

  it("treats a pass cancelled before any chunk succeeded as cancelled, not failed (5.7)", async () => {
    seedModelAndMeeting("hello");
    const h = runnerHarness({ answer: () => HANG });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    expect((await postEmpty(app, "/api/meetings/m1/enhance")).status).toBe(202);
    await waitUntil(() => h.requests.length >= 1);
    const cancel = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
    expect(cancel.status).toBe(202);
    await waitForNoJob("m1");

    expect((await llmRuns("m1"))[0]?.status).toBe("cancelled");
    expect((await getMeeting("m1")).status).toBe("transcribed");
  });

  it("is cancellable: cancel-transcribe 202s, finished chunks keep their text and the run ends cancelled", async () => {
    const f = seedFixtureMeeting({ chunks: 3, speakers: 1, meetingId: "m3" });
    sizeFixtureSegments(getDb(), f, 300);
    seedTestModel();
    // Chunk 0 answers. The next request never answers until it is aborted.
    const h = runnerHarness({
      answer: (r) => (r.n === 0 ? defaultAnswer(r) : HANG),
    });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    expect((await postEmpty(app, "/api/meetings/m3/enhance")).status).toBe(202);
    await waitUntil(() => h.requests.length >= 2);
    const cancel = await postEmpty(app, "/api/meetings/m3/cancel-transcribe");
    expect(cancel.status).toBe(202);
    await waitForNoJob("m3");

    expect((await llmRuns("m3"))[0]?.status).toBe("cancelled");
    const kept = getDb()
      .prepare(
        "SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = 'm3' AND enhanced_text IS NOT NULL",
      )
      .get() as { n: number };
    expect(kept.n).toBe(1);
    // The slot is free: a late cancel is a plain 409.
    const late = await postEmpty(app, "/api/meetings/m3/cancel-transcribe");
    expect(late.status).toBe(409);
  });
});

describe("POST /api/meetings/:id/runs/:runId/resume", () => {
  beforeEach(() => {
    __resetLlmLanesForTests();
    __clearModeCacheForTests();
  });

  it("404s for an unknown meeting and an unknown run", async () => {
    insertMeeting("m1", "transcribed");
    expect(
      (await postEmpty(app, "/api/meetings/nope/runs/r1/resume")).status,
    ).toBe(404);
    expect(
      (await postEmpty(app, "/api/meetings/m1/runs/nope/resume")).status,
    ).toBe(404);
  });

  it("409s with the reason of the guard, and resumes an interrupted run with 202", async () => {
    seedModelAndMeeting("garbled txt here");
    const h = runnerHarness();
    __setMeetingsTestOverrides({ workflowDeps: h.deps });
    // A saver fault after the Enhance steps leaves the run interrupted.
    getDb().exec(
      `CREATE TRIGGER fail_summary_write BEFORE INSERT ON llm_checkpoint_writes
       WHEN NEW.channel = 'summary'
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    let runId = "";
    try {
      const res = await postEmpty(app, "/api/meetings/m1/enhance");
      runId = ((await res.json()) as StartRunResponse).runId;
      await waitForNoJob("m1");
    } finally {
      getDb().exec("DROP TRIGGER fail_summary_write");
    }
    expect((await llmRuns("m1"))[0]?.status).toBe("interrupted");

    // Guard 1: the meeting status.
    getDb()
      .prepare("UPDATE meetings SET status = 'transcribing' WHERE id = 'm1'")
      .run();
    const blocked = await postEmpty(
      app,
      `/api/meetings/m1/runs/${runId}/resume`,
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: expect.any(String),
      reason: "meeting_status",
    });
    getDb()
      .prepare("UPDATE meetings SET status = 'transcribed' WHERE id = 'm1'")
      .run();

    const sent = h.requests.length;
    const ok = await postEmpty(app, `/api/meetings/m1/runs/${runId}/resume`);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ ok: true, id: "m1", runId });
    await waitForNoJob("m1");
    expect((await llmRuns("m1"))[0]).toMatchObject({
      id: runId,
      status: "succeeded",
      resumeCount: 1,
    });
    expect(h.requests).toHaveLength(sent);

    // Guard 3: the run is not interrupted any more.
    const again = await postEmpty(app, `/api/meetings/m1/runs/${runId}/resume`);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { reason: string }).reason).toBe(
      "not_interrupted",
    );
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
    deleteSetting("languages");
  });

  it("resolves and persists meetings.language once; a second run (re-transcribe) does not re-probe", async () => {
    writeSetting("languages", JSON.stringify(["en", "pt"]));

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

    await postEmpty(app, "/api/meetings/m1/transcribe");
    await waitForTerminalStatusFast("m1");
    const after1 = await getMeeting("m1");
    expect(after1.language).toBe("pt");
    const callsAfterFirstRun = calls;
    expect(callsAfterFirstRun).toBeGreaterThan(1); // probe + at least one chunk

    // Re-transcribe: meetings.language is already set, so no new probe call
    // — only chunk-transcription calls should be added.
    await postEmpty(app, "/api/meetings/m1/transcribe");
    await waitForTerminalStatusFast("m1");
    const after2 = await getMeeting("m1");
    expect(after2.language).toBe("pt");
    const chunksInSecondRun = calls - callsAfterFirstRun;
    const chunksInFirstRun = callsAfterFirstRun - 1; // minus the one probe call
    expect(chunksInSecondRun).toBe(chunksInFirstRun);
  });

  it("with a single declared language, pins immediately with no probe call", async () => {
    writeSetting("languages", JSON.stringify(["pt"]));
    let calls = 0;
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        calls++;
        return { text: "hello" };
      }),
    });
    insertMeeting("m1");
    await postEmpty(app, "/api/meetings/m1/transcribe");
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
    deleteSetting(MEETING_RETENTION_SETTING_KEY);
    rmSync(meetingsRoot(), { recursive: true, force: true });
  });

  it("deletes only expired WAV files, keeps rows, nulls audio_dir", async () => {
    const oldDir = makeMeetingDir("old");
    // Kept by an issue #170 track repair. It is audio too.
    writeFileSync(join(oldDir, "system.original.wav"), buildWav(100, 50));
    // Left by a track repair that stopped half way.
    writeFileSync(join(oldDir, SYSTEM_REPAIR_TMP), buildWav(100, 50));
    const freshDir = makeMeetingDir("fresh");
    insertMeeting("old", "summarized", oldDir, Date.now() - 40 * DAY_MS);
    insertMeeting("fresh", "recorded", freshDir, Date.now() - 1 * DAY_MS);

    expect(purgeExpiredMeetingAudio()).toBe(1);

    expect(existsSync(join(oldDir, "mic.wav"))).toBe(false);
    expect(existsSync(join(oldDir, "system.wav"))).toBe(false);
    expect(existsSync(join(oldDir, "system.original.wav"))).toBe(false);
    expect(existsSync(join(oldDir, SYSTEM_REPAIR_TMP))).toBe(false);
    expect(existsSync(join(freshDir, "mic.wav"))).toBe(true);

    const oldRow = await getMeeting("old");
    expect(oldRow.audio_dir).toBeNull();
    expect(oldRow.status).toBe("summarized");
    const freshRow = await getMeeting("fresh");
    expect(freshRow.audio_dir).toBe(freshDir);
  });

  it("skips meetings still recording, honors the retention setting", () => {
    writeSetting(MEETING_RETENTION_SETTING_KEY, "7");
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

  it("never sweeps a meeting marked retentionExempt (eval gold)", async () => {
    const goldDir = makeMeetingDir("gold");
    const normalDir = makeMeetingDir("normal");
    insertMeeting("gold", "summarized", goldDir, Date.now() - 400 * DAY_MS);
    insertMeeting("normal", "summarized", normalDir, Date.now() - 400 * DAY_MS);

    const res = await app.request("/api/meetings/gold", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retentionExempt: true }),
    });
    expect(res.status).toBe(200);
    // Read the flag back: a 200 alone does not prove it was stored.
    const detail = await app.request("/api/meetings/gold");
    expect(((await detail.json()) as MeetingDetail).retention_exempt).toBe(
      true,
    );
    const normalDetail = await app.request("/api/meetings/normal");
    expect(
      ((await normalDetail.json()) as MeetingDetail).retention_exempt,
    ).toBe(false);

    expect(purgeExpiredMeetingAudio()).toBe(1);
    expect(existsSync(join(goldDir, "mic.wav"))).toBe(true);
    expect(existsSync(join(goldDir, "system.wav"))).toBe(true);
    expect((await getMeeting("gold")).audio_dir).toBe(goldDir);
    expect(existsSync(join(normalDir, "mic.wav"))).toBe(false);
    expect((await getMeeting("normal")).audio_dir).toBeNull();

    // Clearing the flag makes the meeting sweepable again.
    await app.request("/api/meetings/gold", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retentionExempt: false }),
    });
    expect(purgeExpiredMeetingAudio()).toBe(1);
    expect(existsSync(join(goldDir, "mic.wav"))).toBe(false);
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

  it("asks a running enhance run to stop when the meeting is deleted (no 409; the run ends and leaves no record)", async () => {
    seedTestModel();
    insertMeeting("m1", "transcribed");
    insertSystemSegment("m1:system:0", "m1", 0, 0, 1000);
    const h = runnerHarness();
    const hold = holdFirstRequest(h.model);
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    const start = await postEmpty(app, "/api/meetings/m1/enhance");
    expect(start.status).toBe(202);
    const { runId } = (await start.json()) as StartRunResponse;
    await hold.reached;

    // DELETE never 409s on a running job: it asks the job to stop and deletes
    // the row either way.
    const del = await app.request("/api/meetings/m1", { method: "DELETE" });
    expect(del.status).toBe(200);

    hold.release();
    await waitForNoJob("m1");

    // The row is gone and the record cascades with it.
    const row = getDb()
      .prepare("SELECT id FROM meetings WHERE id = 'm1'")
      .get();
    expect(row).toBeUndefined();
    for (const table of [
      "llm_runs",
      "llm_run_steps",
      "llm_calls",
      "llm_checkpoints",
    ]) {
      const column =
        table === "llm_runs"
          ? "id"
          : table === "llm_checkpoints"
            ? "thread_id"
            : "run_id";
      const n = getDb()
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
        .get(runId) as { n: number };
      expect(n.n, table).toBe(0);
    }
  });
});

// With the auto-run setting on, the status flips to 'transcribed' first, then
// the job releases its slot and the runner starts one cancellable run that
// chains Enhance into Summarize (specs/meeting-enhance-agentic.md 3.4.2, 3.6),
// in the background with progress of its own.
describe("transcribe: auto-run Enhance as its own run", () => {
  beforeEach(() => {
    __resetLlmLanesForTests();
    __clearModeCacheForTests();
    seedTestModel();
  });

  afterEach(() => {
    deleteSetting("meeting_enhance_auto_run");
  });

  it("does not start a run when the setting row is missing (default off)", async () => {
    const h = runnerHarness();
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({ text: "some words" })),
      workflowDeps: h.deps,
    });
    insertMeeting("m1");
    const res = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(res.status).toBe(202);
    const done = await waitForTerminalStatus("m1");
    expect(done.status).toBe("transcribed");
    expect(done.job).toBeNull();
    expect(h.requests).toHaveLength(0);
    expect(await llmRuns("m1")).toHaveLength(0);
  });

  it("keeps the status transcribed with job kind enhance while the run goes, starts it after the flip, and records the trigger auto", async () => {
    let startedStatus: string | null = null;
    const h = runnerHarness({
      answer: (r) => {
        startedStatus ??= (
          getDb()
            .prepare("SELECT status FROM meetings WHERE id = 'm1'")
            .get() as { status: string }
        ).status;
        return defaultAnswer(r);
      },
    });
    const hold = holdFirstRequest(h.model);
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({ text: "some words" })),
      workflowDeps: h.deps,
    });
    insertMeeting("m1");
    writeSetting("meeting_enhance_auto_run", "true");
    const res = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(res.status).toBe(202);

    // While the first call is parked, the meeting already reads 'transcribed'
    // and the polled job names kind "enhance".
    try {
      await hold.reached;
      const mid = await getMeeting("m1");
      expect(mid.status).toBe("transcribed");
      expect(mid.job).toMatchObject({ kind: "enhance" });
      expect((mid.job as { total: number }).total).toBeGreaterThan(0);
    } finally {
      hold.release();
    }
    await waitForNoJob("m1");
    const done = await getMeeting("m1");
    // Enhance never changes the status. A saved summary sets `summarized`.
    expect(done.status).toBe(SUMMARIZE_IS_STUB ? "transcribed" : "summarized");
    expect(done.job).toBeNull();
    // The save step rewrote the export: the enhanced file now exists beside
    // the raw transcript.
    expect(existsSync(join(audioDir, "transcript-enhanced.md"))).toBe(true);
    // The flip happened BEFORE the run's first call.
    expect(startedStatus).toBe("transcribed");
    const cnt = (
      getDb()
        .prepare(
          "SELECT COUNT(*) AS c FROM meeting_segments WHERE enhanced_text IS NOT NULL",
        )
        .get() as unknown as { c: number }
    ).c;
    expect(cnt).toBeGreaterThan(0);
    const runs = await llmRuns("m1");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: "enhance",
      startedBy: "auto",
      status: "succeeded",
    });
  });

  it("cancel-transcribe stops an in-flight auto-run: the status stays transcribed, the run is cancelled, the slot frees", async () => {
    const h = runnerHarness({ answer: () => HANG });
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({ text: "some words" })),
      workflowDeps: h.deps,
    });
    insertMeeting("m1");
    writeSetting("meeting_enhance_auto_run", "true");
    await postEmpty(app, "/api/meetings/m1/transcribe");
    await waitUntil(() => h.requests.length >= 1);
    expect((await getMeeting("m1")).status).toBe("transcribed");

    const cancel = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
    expect(cancel.status).toBe(202); // kind "enhance" IS cancellable

    await waitForNoJob("m1");
    const done = await getMeeting("m1");
    expect(done.status).toBe("transcribed"); // never changed by the run
    expect(done.error).toBeNull();
    expect(done.job).toBeNull();
    expect((await llmRuns("m1"))[0]?.status).toBe("cancelled");

    // Slot freed: a late cancel is a plain 409.
    const after = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
    expect(after.status).toBe(409);
  });

  it("skips auto-run without a default LLM and leaves the status transcribed", async () => {
    // No default model: skip the automatic run.
    getDb().prepare("DELETE FROM model_configs").run();
    const h = runnerHarness();
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({ text: "some words" })),
      workflowDeps: h.deps,
    });
    insertMeeting("m1");
    writeSetting("meeting_enhance_auto_run", "true");
    const res = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(res.status).toBe(202);
    await waitForTerminalStatus("m1");
    await waitForNoJob("m1");
    const done = await getMeeting("m1");
    expect(done.status).toBe("transcribed");
    expect(done.error).toBeNull();
    expect(await llmRuns("m1")).toEqual([]);
    expect(h.requests).toHaveLength(0);
  });

  it("a cancel that lands during the diarizer run exits the job (I4: cancel right after runDiarizer)", async () => {
    // Phase 4 (specs/meeting-transcription-v2.md 3.4): the diarizer runs BEFORE
    // transcription, and the cancel check sits right after it. A cancel that
    // lands while the diarizer is parked takes the cancel exit: no chunks run,
    // no labels, no status flip, no auto-run.
    writeSetting("meeting_diarization_enabled", "true");
    try {
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      let diarizeRuns = 0;
      let transcribeCalls = 0;
      const h = runnerHarness();
      __setMeetingsTestOverrides({
        createTranscriberDeps: fakeDeps(async () => {
          transcribeCalls++;
          return { text: "some words" };
        }),
        diarizeDeps: {
          resolveBinaryPath: () => "/fake/fluidaudio-diarize",
          resolveModelsDirPath: () => "/fake/resources/models",
          execFile: async (_file, args) => {
            if (args[0] === "--probe") return { stdout: "READY", stderr: "" };
            diarizeRuns++;
            await gate; // park inside the real diarizer run
            return { stdout: "[]", stderr: "" };
          },
        },
        workflowDeps: h.deps,
      });
      insertMeeting("m1");
      writeSetting("meeting_enhance_auto_run", "true");
      const res = await postEmpty(app, "/api/meetings/m1/transcribe");
      expect(res.status).toBe(202);
      // The job is parked inside the diarizer run (before any chunk).
      await waitForMicrotasks(() => diarizeRuns >= 1);

      const cancel = await postEmpty(app, "/api/meetings/m1/cancel-transcribe");
      expect(cancel.status).toBe(202); // kind transcribe is cancellable

      release();
      await waitForNoJob("m1");
      const done = await getMeeting("m1");
      expect(done.status).toBe("failed");
      expect(done.error).toBe("Cancelled by user");
      expect(transcribeCalls).toBe(0); // no chunk ever ran
      expect(h.requests).toHaveLength(0); // the auto-run never happened
      expect(await llmRuns("m1")).toHaveLength(0);
    } finally {
      deleteSetting("meeting_diarization_enabled");
    }
  });

  it("names the real job kind in the 409 while an enhance run holds the slot", async () => {
    const h = runnerHarness();
    const hold = holdFirstRequest(h.model);
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({ text: "some words" })),
      workflowDeps: h.deps,
    });
    insertMeeting("m1");
    writeSetting("meeting_enhance_auto_run", "true");
    await postEmpty(app, "/api/meetings/m1/transcribe");
    try {
      await hold.reached;
      const res = await postEmpty(app, "/api/meetings/m1/transcribe");
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(
        "Enhance is already running",
      );
    } finally {
      hold.release();
    }
    await waitForNoJob("m1");
  });
});

// ---------------------------------------------------------------------------
// Phase 4 (I4, specs/meeting-transcription-v2.md §3.4): diarize first,
// cut the system track at speaker changes, label with the same turns.
// ---------------------------------------------------------------------------

describe("Phase 4 (I4): diarize first and speaker cuts", () => {
  /** One 7 s tone from 1.5 s on (8.5 s total): a single VAD opening that
   * spans the 4 s turn boundary, so the cut really splits the segment. */
  function longToneWav(): Buffer {
    const leadMs = 1500;
    const toneMs = 7000;
    const totalMs = leadMs + toneMs;
    const totalSamples = Math.round((totalMs / 1000) * SAMPLE_RATE);
    return buildBaseWav({
      data: tonePayload(totalSamples, [
        [
          Math.round((leadMs / 1000) * SAMPLE_RATE),
          Math.round(((leadMs + toneMs) / 1000) * SAMPLE_RATE),
        ],
      ]),
    });
  }

  function makeAudioDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "meeting-i4-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const wav = longToneWav();
    writeFileSync(join(dir, "mic.wav"), wav);
    writeFileSync(join(dir, "system.wav"), wav);
    return dir;
  }

  async function waitForNoJob(id: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 2000; i++) {
      const res = await app.request(`/api/meetings/${id}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (body.job === null) return body;
      await Promise.resolve();
    }
    throw new Error("the job never released its slot");
  }

  it("runs the binary once, cuts the system track, and labels from the stored turns", async () => {
    const dir = makeAudioDir();
    let probeCalls = 0;
    let runCalls = 0;
    let transcribeCalls = 0;
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        transcribeCalls++;
        return { text: "some words" };
      }),
      diarizeDeps: {
        resolveBinaryPath: () => "/fake/fluidaudio-diarize",
        resolveModelsDirPath: () => "/fake/resources/models",
        execFile: async (_file, args) => {
          if (args[0] === "--probe") {
            probeCalls++;
            return { stdout: "READY", stderr: "" };
          }
          runCalls++;
          return {
            stdout: JSON.stringify([
              { speakerId: "A", startTimeSeconds: 0, endTimeSeconds: 4 },
              { speakerId: "B", startTimeSeconds: 4, endTimeSeconds: 10 },
            ]),
            stderr: "",
          };
        },
      },
    });
    insertMeeting("m1", "recorded", dir);

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("transcribed");

    // The binary ran exactly once (probe + one real run): the job labels
    // with the turns it already has — never a second run.
    expect(probeCalls).toBe(1);
    expect(runCalls).toBe(1);

    // The 7 s tone is one VAD opening on each channel. The system track
    // is cut at the 4 s turn boundary; the mic track is never cut.
    const rows = getDb()
      .prepare(
        `SELECT source, idx, start_ms, end_ms, speaker_label
           FROM meeting_segments WHERE meeting_id = 'm1' ORDER BY source, idx`,
      )
      .all() as unknown as Array<{
      source: string;
      idx: number;
      start_ms: number;
      end_ms: number;
      speaker_label: string | null;
    }>;
    const mic = rows.filter((r) => r.source === "mic");
    const system = rows.filter((r) => r.source === "system");
    expect(mic).toHaveLength(1);
    expect(system).toHaveLength(2);
    expect(transcribeCalls).toBe(3); // 1 mic + 2 system chunks

    // The cut sits within the +/-300 ms snap window of the 4 s turn start.
    expect(system[0]!.end_ms).toBe(system[1]!.start_ms);
    expect(Math.abs(system[0]!.end_ms - 4000)).toBeLessThanOrEqual(300);

    // Labels from the stored turns: first appearance A -> "1", B -> "2";
    // the mic channel is never labeled.
    expect(system.map((r) => r.speaker_label)).toEqual(["1", "2"]);
    expect(mic.map((r) => r.speaker_label)).toEqual([null]);
  });

  it("a missing binary keeps the old behavior: no cuts, no labels, never fails the job", async () => {
    const dir = makeAudioDir();
    let transcribeCalls = 0;
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => {
        transcribeCalls++;
        return { text: "some words" };
      }),
      // Deterministic "not built" regardless of process.cwd().
      diarizeDeps: {
        resolveBinaryPath: () => null,
        resolveModelsDirPath: () => null,
        execFile: async () => {
          throw new Error("must not run");
        },
      },
    });
    insertMeeting("m1", "recorded", dir);

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("transcribed");
    expect(done.error).toBeNull();

    // The same 7 s tone, uncut, on both channels; no labels anywhere.
    const rows = getDb()
      .prepare(
        `SELECT source, speaker_label FROM meeting_segments
           WHERE meeting_id = 'm1' ORDER BY source, idx`,
      )
      .all() as unknown as Array<{
      source: string;
      speaker_label: string | null;
    }>;
    expect(rows).toHaveLength(2); // one segment per channel
    expect(rows.every((r) => r.speaker_label === null)).toBe(true);
    expect(transcribeCalls).toBe(2);
  });

  it("resolveConfig runs before the diarizer: a missing model never spends diarizer time", async () => {
    const dir = makeAudioDir();
    let runCalls = 0;
    __setMeetingsTestOverrides({
      createTranscriberDeps: async () => ({
        getProvider: () => ({
          providerId: "fake",
          transcribe: async () => ({ text: "unreachable" }),
          supportsStreaming: () => false,
        }),
        resolveConfig: () => {
          throw new Error("No voice model configured");
        },
        sleep: async () => {},
        backoffBaseMs: 1,
        maxAttempts: 1,
      }),
      diarizeDeps: {
        resolveBinaryPath: () => "/fake/fluidaudio-diarize",
        resolveModelsDirPath: () => "/fake/resources/models",
        execFile: async (_file, args) => {
          if (args[0] !== "--probe") runCalls++;
          return { stdout: args[0] === "--probe" ? "READY" : "[]", stderr: "" };
        },
      },
    });
    insertMeeting("m1", "recorded", dir);

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("failed");
    // The diarizer never ran: the failure surfaced before it.
    expect(runCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 4b (I4b, specs/meeting-transcription-v2.md §3.6): forced alignment
// at speaker cuts — the align-then-split path, the gate fallbacks, and the
// automatic-download trigger.
// ---------------------------------------------------------------------------

describe("Phase 4b (I4b): forced alignment at speaker cuts (§3.6)", () => {
  function makeAudioDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "meeting-i4b-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const wav = (() => {
      const leadMs = 1500;
      const toneMs = 7000;
      const totalSamples = Math.round(((leadMs + toneMs) / 1000) * SAMPLE_RATE);
      return buildBaseWav({
        data: tonePayload(totalSamples, [
          [
            Math.round((leadMs / 1000) * SAMPLE_RATE),
            Math.round(((leadMs + toneMs) / 1000) * SAMPLE_RATE),
          ],
        ]),
      });
    })();
    writeFileSync(join(dir, "mic.wav"), wav);
    writeFileSync(join(dir, "system.wav"), wav);
    return dir;
  }

  async function waitForNoJob(id: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 2000; i++) {
      const res = await app.request(`/api/meetings/${id}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (body.job === null) return body;
      await Promise.resolve();
    }
    throw new Error("the job never released its slot");
  }

  const twoTurns = [
    { speakerId: "A", startTimeSeconds: 0, endTimeSeconds: 4 },
    { speakerId: "B", startTimeSeconds: 4, endTimeSeconds: 10 },
  ];

  function alignOverrides(
    alignChunk: (
      wav: Uint8Array,
      text: string,
      language: string,
    ) => Promise<Array<{ text: string; start: number; end: number }>>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      // The default chunk text carries the sentence end at the speaker
      // change — the cut is kept only on a sentence end (decision
      // 2026-10-07); the 1:1 mapping reads the source token.
      createTranscriberDeps: fakeDeps(async () => ({ text: "Left. Right." })),
      diarizeDeps: {
        resolveBinaryPath: () => "/fake/fluidaudio-diarize",
        resolveModelsDirPath: () => "/fake/resources/models",
        execFile: async (_file: string, args: string[]) => ({
          stdout: args[0] === "--probe" ? "READY" : JSON.stringify(twoTurns),
          stderr: "",
        }),
      },
      alignerReady: true,
      // The gate's platform inputs, forced so the align tests run on any
      // host (Linux CI has no Apple silicon / MLX runtime).
      appleSilicon: true,
      canRunMlx: true,
      alignChunk,
      startAlignerDownload: () => false,
      ...extra,
    };
  }

  it("splits a mixed chunk at the change time and labels the parts (any provider)", async () => {
    const dir = makeAudioDir();
    let alignCalls = 0;
    let seenLanguage: string | null = null;
    __setMeetingsTestOverrides(
      alignOverrides(async (_wav, _text, language) => {
        alignCalls++;
        seenLanguage = language;
        // Word times RELATIVE to the chunk start (the worker's contract):
        // "left." well inside A's turn, "right." well inside B's. The
        // sentence ends are what KEEP the cut (decision 2026-10-07).
        return [
          { text: "left.", start: 0.5, end: 1.5 },
          { text: "right.", start: 5.0, end: 6.0 },
        ];
      }),
    );
    insertMeeting("m1", "recorded", dir);
    // Declared + sticky language (the gate needs it; "en" maps to English).
    getDb()
      .prepare("UPDATE meetings SET language = ? WHERE id = ?")
      .run("en", "m1");

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("transcribed");

    // The aligner was called once for the one mixed system chunk, with
    // the aligner's language NAME (the meeting language "en" mapped).
    expect(alignCalls).toBe(1);
    expect(seenLanguage).toBe("English");

    // The single uncut system chunk was REPLACED by its parts: the id
    // carries the part suffix, the times come from the words, and the
    // labels number by first appearance (A -> 1, B -> 2). The provider
    // here is the FAKE one — not Qwen: the path is model-agnostic.
    const rows = getDb()
      .prepare(
        `SELECT id, source, idx, start_ms, end_ms, text, speaker_label
           FROM meeting_segments WHERE meeting_id = 'm1'
           ORDER BY source, idx, start_ms, id`,
      )
      .all() as unknown as Array<{
      id: string;
      source: string;
      idx: number;
      start_ms: number;
      end_ms: number;
      text: string | null;
      speaker_label: string | null;
    }>;
    const system = rows.filter((r) => r.source === "system");
    expect(system).toHaveLength(2);
    expect(system.map((r) => r.speaker_label)).toEqual(["1", "2"]);
    expect(
      system.every((r) => r.id.endsWith(":0:0") || r.id.endsWith(":0:1")),
    ).toBe(true);
    // Word-derived times (chunk starts ~1.2 s after the tone lead-in):
    // part 0 ends before the 4 s change; part 1 starts after it.
    expect(system[0]!.end_ms).toBeLessThan(4000 + 300);
    expect(system[1]!.start_ms).toBeGreaterThan(4000 - 300);
    // The turns are stored (the measurement reads the table).
    const turns = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM meeting_diarizer_turns WHERE meeting_id = 'm1'",
      )
      .get() as { n: number };
    expect(turns.n).toBe(2);
    // The mic chunk is untouched and unlabeled.
    const mic = rows.filter((r) => r.source === "mic");
    expect(mic).toHaveLength(1);
    expect(mic[0]!.speaker_label).toBeNull();
  });

  it("waits for dictation to be idle before the align call", async () => {
    // An align call loads the aligner into the single MLX worker, which
    // evicts a local MLX dictation model. While dictation is active, no
    // align call may start. Dictation ends after three polls. Then the
    // call runs.
    const dir = makeAudioDir();
    __resetDictationIdleStateForTests();
    beginDictation();
    let dictationEnded = false;
    const endOnce = () => {
      if (dictationEnded) return;
      dictationEnded = true;
      endDictation();
    };
    onTestFinished(() => {
      endOnce();
      __resetDictationIdleStateForTests();
    });
    let alignCalls = 0;
    let polls = 0;
    const callsSeenWhileWaiting: number[] = [];
    __setMeetingsTestOverrides(
      alignOverrides(
        async () => {
          alignCalls++;
          return [
            { text: "left.", start: 0.5, end: 1.5 },
            { text: "right.", start: 5.0, end: 6.0 },
          ];
        },
        {
          alignDictationWait: {
            idleMs: 0,
            pollMs: 1,
            sleep: async () => {
              polls++;
              callsSeenWhileWaiting.push(alignCalls);
              if (polls >= 3) endOnce();
            },
          },
        },
      ),
    );
    insertMeeting("m1", "recorded", dir);
    getDb()
      .prepare("UPDATE meetings SET language = ? WHERE id = ?")
      .run("en", "m1");

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("transcribed");

    expect(polls).toBeGreaterThanOrEqual(3);
    expect(callsSeenWhileWaiting.every((n) => n === 0)).toBe(true);
    expect(alignCalls).toBe(1);
  });

  it("stops the align pass when the meeting is cancelled during the dictation wait", async () => {
    // Dictation stays active. The user cancels during the wait. The wait
    // ends, no align call runs, and the pass ends with the transcribed
    // rows kept. The cancel path then skips the auto Enhance.
    const dir = makeAudioDir();
    __resetDictationIdleStateForTests();
    beginDictation();
    let dictationEnded = false;
    const endOnce = () => {
      if (dictationEnded) return;
      dictationEnded = true;
      endDictation();
    };
    onTestFinished(() => {
      endOnce();
      __resetDictationIdleStateForTests();
    });
    let alignCalls = 0;
    let polls = 0;
    let cancelStatus = 0;
    __setMeetingsTestOverrides(
      alignOverrides(
        async () => {
          alignCalls++;
          return [];
        },
        {
          alignDictationWait: {
            idleMs: 0,
            pollMs: 1,
            sleep: async () => {
              polls++;
              if (polls === 2) {
                cancelStatus = (
                  await postEmpty(app, "/api/meetings/m1/cancel-transcribe")
                ).status;
              }
              // Safety stop: a missing abort would loop here for ever.
              if (polls >= 50) endOnce();
            },
          },
        },
      ),
    );
    insertMeeting("m1", "recorded", dir);
    getDb()
      .prepare("UPDATE meetings SET language = ? WHERE id = ?")
      .run("en", "m1");

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");

    expect(cancelStatus).toBe(202);
    expect(polls).toBe(2);
    expect(alignCalls).toBe(0);
    expect(done.status).toBe("transcribed");
    const rows = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id = ? AND source = 'system'",
      )
      .get("m1") as { n: number };
    expect(rows.n).toBeGreaterThan(0);
  });

  it("keeps the ASR punctuation and case in the stored parts (§3.6 review)", async () => {
    // The stored part text must come from the ORIGINAL ASR tokens (the
    // aligner's words are normalized): the parts keep punctuation and
    // sentence capitals, and joined with a space they equal the
    // original chunk text. The labels stay per-part (the later label
    // step must not overwrite them with the overlap winner).
    const dir = makeAudioDir();
    __setMeetingsTestOverrides(
      alignOverrides(
        async (_wav, _text, _language) => [
          { text: "left.", start: 0.5, end: 1.5 },
          { text: "right.", start: 5.0, end: 6.0 },
        ],
        {
          createTranscriberDeps: fakeDeps(async () => ({
            text: "Left. Right.",
          })),
        },
      ),
    );
    insertMeeting("m2", "recorded", dir);
    getDb()
      .prepare("UPDATE meetings SET language = ? WHERE id = ?")
      .run("en", "m2");

    const start = await postEmpty(app, "/api/meetings/m2/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m2");
    expect(done.status).toBe("transcribed");

    const rows = getDb()
      .prepare(
        `SELECT text, speaker_label FROM meeting_segments
           WHERE meeting_id = 'm2' AND source = 'system'
           ORDER BY start_ms, id`,
      )
      .all() as unknown as Array<{
      text: string | null;
      speaker_label: string | null;
    }>;
    expect(rows).toHaveLength(2);
    // Punctuation and case survive the split.
    expect(rows.map((r) => r.text)).toEqual(["Left.", "Right."]);
    // Joined with a space the parts equal the original chunk text.
    expect(rows.map((r) => r.text).join(" ")).toBe("Left. Right.");
    // Per-part midpoint labels (A then B), not the overlap winner's
    // label on the whole span (which would be B for both).
    expect(rows.map((r) => r.speaker_label)).toEqual(["1", "2"]);
  });

  it("keeps a single-speaker chunk as one row (no align call)", async () => {
    const dir = makeAudioDir();
    let alignCalls = 0;
    __setMeetingsTestOverrides(
      alignOverrides(
        async () => {
          alignCalls++;
          return [];
        },
        {
          // B starts after the chunk ends (~8.7 s): the chunk overlaps
          // only A — not mixed, stored as today, labeled by the winner.
          diarizeDeps: {
            resolveBinaryPath: () => "/fake/fluidaudio-diarize",
            resolveModelsDirPath: () => "/fake/resources/models",
            execFile: async (_file: string, args: string[]) => ({
              stdout:
                args[0] === "--probe"
                  ? "READY"
                  : JSON.stringify([
                      {
                        speakerId: "A",
                        startTimeSeconds: 0,
                        endTimeSeconds: 10,
                      },
                      {
                        speakerId: "B",
                        startTimeSeconds: 10,
                        endTimeSeconds: 12,
                      },
                    ]),
              stderr: "",
            }),
          },
        },
      ),
    );
    insertMeeting("m1", "recorded", dir);
    getDb()
      .prepare("UPDATE meetings SET language = ? WHERE id = ?")
      .run("en", "m1");

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("transcribed");

    expect(alignCalls).toBe(0);
    const rows = getDb()
      .prepare(
        `SELECT id, source, speaker_label FROM meeting_segments
           WHERE meeting_id = 'm1' ORDER BY source, idx`,
      )
      .all() as unknown as Array<{
      id: string;
      source: string;
      speaker_label: string | null;
    }>;
    const system = rows.filter((r) => r.source === "system");
    expect(system).toHaveLength(1);
    expect(system[0]!.speaker_label).toBe("1");
    expect(system[0]!.id.endsWith(":0:0")).toBe(false);
  });

  // Issue #259: the helper keeps turns under 1 s. They give labels only.
  function shortTurnRun(turns: unknown[]) {
    let alignCalls = 0;
    __setMeetingsTestOverrides(
      alignOverrides(
        async () => {
          alignCalls++;
          return [];
        },
        {
          diarizeDeps: {
            resolveBinaryPath: () => "/fake/fluidaudio-diarize",
            resolveModelsDirPath: () => "/fake/resources/models",
            execFile: async (_file: string, args: string[]) => ({
              stdout: args[0] === "--probe" ? "READY" : JSON.stringify(turns),
              stderr: "",
            }),
          },
        },
      ),
    );
    return { alignCalls: () => alignCalls };
  }

  async function transcribeAndRead() {
    const dir = makeAudioDir();
    insertMeeting("m1", "recorded", dir);
    getDb()
      .prepare("UPDATE meetings SET language = ? WHERE id = ?")
      .run("en", "m1");
    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("transcribed");
    const labels = (
      getDb()
        .prepare(
          `SELECT speaker_label FROM meeting_segments
             WHERE meeting_id = 'm1' AND source = 'system' ORDER BY idx`,
        )
        .all() as unknown as Array<{ speaker_label: string | null }>
    ).map((r) => r.speaker_label);
    const stored = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM meeting_diarizer_turns WHERE meeting_id = 'm1'",
      )
      .get() as { n: number };
    return { labels, stored: stored.n };
  }

  it("a short turn inside a chunk does not make the chunk mixed", async () => {
    // B's 0.6 s turn sits inside A's turn: no align call, one row, A's
    // label. Only the long turn is stored.
    const run = shortTurnRun([
      { speakerId: "A", startTimeSeconds: 0, endTimeSeconds: 10 },
      { speakerId: "B", startTimeSeconds: 5, endTimeSeconds: 5.6 },
    ]);
    const { labels, stored } = await transcribeAndRead();
    expect(run.alignCalls()).toBe(0);
    expect(labels).toEqual(["1"]);
    expect(stored).toBe(1);
  });

  it("labels a chunk from a short turn when no long turn reaches it", async () => {
    // The only long turn starts 20 s after the chunk: the old rule left
    // the row unlabeled. B's short turn overlaps the chunk.
    const run = shortTurnRun([
      {
        speakerId: "B",
        startTimeSeconds: 3,
        endTimeSeconds: 3.6,
        qualityScore: 0.8,
      },
      { speakerId: "A", startTimeSeconds: 30, endTimeSeconds: 40 },
    ]);
    const { labels, stored } = await transcribeAndRead();
    expect(run.alignCalls()).toBe(0);
    expect(labels).toEqual(["1"]);
    expect(stored).toBe(1);
  });

  it("falls back to the phase 4 cuts when the aligner is not downloaded", async () => {
    const dir = makeAudioDir();
    let alignCalls = 0;
    __setMeetingsTestOverrides(
      alignOverrides(
        async () => {
          alignCalls++;
          return [];
        },
        { alignerReady: false },
      ),
    );
    insertMeeting("m1", "recorded", dir);
    getDb()
      .prepare("UPDATE meetings SET language = ? WHERE id = ?")
      .run("en", "m1");

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("transcribed");

    // No align call; the phase 4 path ran instead: the chunk is CUT at
    // the 4 s change and labeled from the turns (1, 2) — a meeting that
    // starts before the download ends gets exactly the old behavior.
    expect(alignCalls).toBe(0);
    const rows = getDb()
      .prepare(
        `SELECT source, idx, speaker_label FROM meeting_segments
           WHERE meeting_id = 'm1' AND source = 'system' ORDER BY idx`,
      )
      .all() as unknown as Array<{
      idx: number;
      speaker_label: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.speaker_label)).toEqual(["1", "2"]);
  });

  it("falls back when the meeting language is not declared", async () => {
    const dir = makeAudioDir();
    let alignCalls = 0;
    __setMeetingsTestOverrides(
      alignOverrides(
        async () => {
          alignCalls++;
          return [];
        },
        { alignerReady: true },
      ),
    );
    insertMeeting("m1", "recorded", dir);
    // No meetings.language row and no declared languages: the gate's
    // "language not declared" reason applies.

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("transcribed");

    expect(alignCalls).toBe(0);
    const rows = getDb()
      .prepare(
        `SELECT source, idx FROM meeting_segments
           WHERE meeting_id = 'm1' AND source = 'system' ORDER BY idx`,
      )
      .all() as unknown as Array<{ idx: number }>;
    expect(rows).toHaveLength(2); // cut, as phase 4
  });

  it("starts the automatic aligner download once at job start", async () => {
    const dir = makeAudioDir();
    const startCalls: number[] = [];
    __setMeetingsTestOverrides(
      alignOverrides(async () => [], {
        startAlignerDownload: () => {
          startCalls.push(1);
          return true;
        },
      }),
    );
    insertMeeting("m1", "recorded", dir);
    getDb()
      .prepare("UPDATE meetings SET language = ? WHERE id = ?")
      .run("en", "m1");

    const start = await postEmpty(app, "/api/meetings/m1/transcribe");
    expect(start.status).toBe(202);
    const done = await waitForNoJob("m1");
    expect(done.status).toBe("transcribed");
    expect(startCalls).toHaveLength(1);
  });
});

describe("GET /api/meetings/:id — track ratio guard (issue #170)", () => {
  function meetingWithCounts(
    id: string,
    status: string,
    micSeconds: number,
    systemSeconds: number,
  ): void {
    const dir = mkdtempSync(join(tmpdir(), "meeting-ratio-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, "sync.json"),
      JSON.stringify({
        meetingId: id,
        sampleRate: SAMPLE_RATE,
        micSamples: Math.round(micSeconds * SAMPLE_RATE),
        systemSamples: Math.round(systemSeconds * SAMPLE_RATE),
      }),
    );
    insertMeeting(id, status, dir);
  }

  it("returns the ratio when the system track is 1/3 of the mic track", async () => {
    meetingWithCounts("ratio-bad", "recorded", 2329.8, 776.6);
    const body = await getMeeting("ratio-bad");
    expect(body.track_ratio_warning).toBeCloseTo(0.3333, 3);
  });

  it("returns null when both tracks have the same length", async () => {
    meetingWithCounts("ratio-ok", "recorded", 600, 600);
    expect((await getMeeting("ratio-ok")).track_ratio_warning).toBeNull();
  });

  it("returns null while the meeting still records", async () => {
    meetingWithCounts("ratio-live", "recording", 600, 200);
    expect((await getMeeting("ratio-live")).track_ratio_warning).toBeNull();
  });

  it("returns null when sync.json is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-ratio-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    insertMeeting("ratio-nofile", "recorded", dir);
    expect((await getMeeting("ratio-nofile")).track_ratio_warning).toBeNull();
  });
});

describe("POST /api/meetings/:id/transcribe — system track repair (issue #170)", () => {
  it("repairs a 1/3 system track before the pipeline reads it, and only once", async () => {
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({
        text: "the quarterly numbers look great",
      })),
    });
    const dir = mkdtempSync(join(tmpdir(), "meeting-repair-route-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const counts = writeSqueezedMeeting(dir, {
      seconds: 66,
      actualRate: 16000,
      assumedRate: 48000,
    });
    const originalBytes = readFileSync(join(dir, "system.wav"));
    insertMeeting("repair-1", "recorded", dir);

    // Before the transcription: the next run repairs it. No warning.
    const before = await getMeeting("repair-1");
    expect(before.track_repair).toEqual({
      fromRate: 48000,
      toRate: 16000,
      repaired: false,
    });
    expect(before.track_ratio_warning).toBeNull();

    expect(
      (await postEmpty(app, "/api/meetings/repair-1/transcribe")).status,
    ).toBe(202);
    const done = await waitForTerminalStatus("repair-1");
    expect(done.status).toBe("transcribed");
    expect(done.track_repair).toEqual({
      fromRate: 48000,
      toRate: 16000,
      repaired: true,
    });
    expect(done.track_ratio_warning).toBeNull();

    // The repaired track is as long as the mic track, within 0.5 %.
    const micMs = wavDurationMs(readWavInfo(join(dir, "mic.wav")));
    const systemMs = wavDurationMs(readWavInfo(join(dir, "system.wav")));
    expect(Math.abs(systemMs - micMs) / micMs).toBeLessThan(0.005);
    // The original stays, byte for byte.
    expect(
      readFileSync(join(dir, "system.original.wav")).equals(originalBytes),
    ).toBe(true);
    // sync.json has the corrected count and the repair record.
    const journal = JSON.parse(readFileSync(join(dir, "sync.json"), "utf8"));
    expect(journal.systemSamples).toBe(counts.systemSamples * 3);
    expect(journal.repair).toMatchObject({
      fromRate: 48000,
      toRate: 16000,
      originalSystemSamples: counts.systemSamples,
    });

    // A second transcription changes nothing on disk.
    const systemBytes = readFileSync(join(dir, "system.wav"));
    const syncText = readFileSync(join(dir, "sync.json"), "utf8");
    expect(
      (await postEmpty(app, "/api/meetings/repair-1/transcribe")).status,
    ).toBe(202);
    const again = await waitForTerminalStatus("repair-1");
    expect(again.status).toBe("transcribed");
    expect(readFileSync(join(dir, "system.wav")).equals(systemBytes)).toBe(
      true,
    );
    expect(
      readFileSync(join(dir, "system.original.wav")).equals(originalBytes),
    ).toBe(true);
    expect(readFileSync(join(dir, "sync.json"), "utf8")).toBe(syncText);
  });

  it("keeps the warning and the files for a bad ratio that no rate pair explains", async () => {
    __setMeetingsTestOverrides({
      createTranscriberDeps: fakeDeps(async () => ({ text: "hello" })),
    });
    const dir = mkdtempSync(join(tmpdir(), "meeting-repair-route-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // 0.8 is 6.7 % away from the nearest rate factor (0.75).
    writeSqueezedMeeting(dir, {
      seconds: 66,
      actualRate: 38400,
      assumedRate: 48000,
    });
    const before = readFileSync(join(dir, "system.wav"));
    insertMeeting("repair-2", "recorded", dir);

    expect(
      (await postEmpty(app, "/api/meetings/repair-2/transcribe")).status,
    ).toBe(202);
    const done = await waitForTerminalStatus("repair-2");
    expect(done.track_repair).toBeNull();
    expect(done.track_ratio_warning).toBeCloseTo(0.8, 3);
    expect(readFileSync(join(dir, "system.wav")).equals(before)).toBe(true);
    expect(existsSync(join(dir, "system.original.wav"))).toBe(false);
  });
});
