import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MeetingBatchState,
  meetingBatchStateSchema,
  meetingDetailResponseSchema,
  meetingFolderSchema,
  meetingFoldersResponseSchema,
  meetingSummaryVersionsResponseSchema,
} from "@openstyle/validations";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import type { DiarizeDeps } from "../src/lib/meetings/diarize.js";
import { listJobs } from "../src/lib/meetings/job-registry.js";
import type { TranscriberDeps } from "../src/lib/meetings/transcriber.js";
import {
  __batchQueueIdle,
  __setMeetingsTestOverrides,
} from "../src/routes/meetings.js";
import { okReply } from "./helpers/fake-model.js";
import { jsonRequest, postEmpty } from "./helpers/http.js";
import {
  insertSegment,
  insertSpeaker,
  resetMeetingTables,
} from "./helpers/meetings-db.js";
import {
  defaultAnswer,
  isIdentify,
  isSummaryRequest,
  runnerHarness,
  SUMMARY_ANSWER,
  waitUntil,
} from "./helpers/runner-helpers.js";
import { buildWav } from "./helpers/wav.js";
import { seedTestModel } from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const app = createApp();
const base = "/api/meetings";
const RATE = 16000;

/** 4 s of audio: a tone at 0.5-1.7 s and at 2.3-3.5 s, silence else. */
function twoBurstWav(): Buffer {
  const total = 4 * RATE;
  const data = Buffer.alloc(total * 2);
  for (const [a, b] of [
    [0.5, 1.7],
    [2.3, 3.5],
  ]) {
    for (let i = Math.round(a * RATE); i < Math.round(b * RATE); i++) {
      data.writeInt16LE(
        Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / RATE)),
        i * 2,
      );
    }
  }
  return buildWav({ data });
}

let audioDir: string;

beforeAll(() => {
  audioDir = mkdtempSync(join(tmpdir(), "meeting-batch-test-"));
  writeFileSync(join(audioDir, "system.wav"), twoBurstWav());
});

afterAll(() => {
  rmSync(audioDir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
});

afterEach(async () => {
  await __batchQueueIdle();
  resetMeetingTables();
  __setMeetingsTestOverrides();
  getDb().prepare("DELETE FROM model_configs").run();
});

function insertMeeting(
  id: string,
  status: string,
  o: { folder?: string | null; dir?: string | null; startedAt?: number } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO meetings (id, title, started_at, status, audio_dir, created_at, folder_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `Meeting ${id}`,
      o.startedAt ?? 1,
      status,
      o.dir === undefined ? audioDir : o.dir,
      1,
      o.folder ?? null,
    );
}

function text(meetingId: string, idx = 0, o: { failed?: boolean } = {}) {
  insertSegment({
    id: `${meetingId}:${idx}`,
    meetingId,
    idx,
    startMs: idx * 1000,
    endMs: idx * 1000 + 900,
    text: o.failed ? null : "We plan the garden fair for May.",
    status: o.failed ? "failed" : "ok",
  });
}

function enhanced(meetingId: string) {
  getDb()
    .prepare(
      "UPDATE meeting_segments SET enhanced_text = text WHERE meeting_id = ? AND text IS NOT NULL",
    )
    .run(meetingId);
}

function summary(meetingId: string, markdown: string, partial = 0) {
  getDb()
    .prepare(
      `INSERT INTO meeting_summaries (meeting_id, markdown, llm_provider, llm_model, created_at, partial)
       VALUES (?, ?, 'fake', 'fake-model', 100, ?)`,
    )
    .run(meetingId, markdown, partial);
}

async function createFolder(name: string) {
  const res = await jsonRequest(app, "POST", `${base}/folders`, { name });
  expect(res.status).toBe(201);
  return meetingFolderSchema.parse(await res.json());
}

async function folderCounts(id: string) {
  const res = await app.request(`${base}/folders`);
  const items = meetingFoldersResponseSchema.parse(await res.json()).items;
  return items.find((f) => f.id === id)?.stage_counts;
}

async function startBatch(body: unknown): Promise<Response> {
  return jsonRequest(app, "POST", `${base}/batch`, body);
}

async function batchState(): Promise<MeetingBatchState> {
  const res = await app.request(`${base}/batch`);
  expect(res.status).toBe(200);
  return meetingBatchStateSchema.parse(await res.json());
}

function statusOf(id: string): string {
  return (
    getDb().prepare("SELECT status FROM meetings WHERE id = ?").get(id) as {
      status: string;
    }
  ).status;
}

/** Fake STT: no real provider, no waits. `onCall` sees each chunk call. */
function fakeTranscriber(onCall: () => Promise<string> | string) {
  return async (
    extras?: Pick<TranscriberDeps, "isDictationActive" | "onChunk">,
  ): Promise<TranscriberDeps> => ({
    getProvider: () => ({
      providerId: "fake",
      transcribe: async () => ({ text: await onCall() }),
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

/** Fake diarizer that answers with these turns. */
function fakeDiarizer(
  turns: Array<{ speakerId: string; start: number; end: number }>,
): DiarizeDeps {
  return {
    resolveBinaryPath: () => "/fake/fluidaudio-diarize",
    resolveModelsDirPath: () => "/fake/resources/models",
    execFile: async (_file, args) =>
      args[0] === "--probe"
        ? { stdout: "READY", stderr: "" }
        : {
            stdout: JSON.stringify(
              turns.map((t) => ({
                speakerId: t.speakerId,
                startTimeSeconds: t.start,
                endTimeSeconds: t.end,
                qualityScore: 1,
              })),
            ),
            stderr: "",
          },
  };
}

/** The plain cut path: no aligner, no VAD helper (route test seams). */
const noAligner = {
  alignerReady: false,
  appleSilicon: false,
  canRunMlx: false,
  startAlignerDownload: () => false,
};

describe("folder stage counts", () => {
  it("counts what each stage needs, and what cannot run", async () => {
    const folder = await createFolder("Garden club");
    const other = await createFolder("Other");
    const f = folder.id;
    insertMeeting("rec1", "recorded", { folder: f });
    insertMeeting("rec-gone", "recorded", { folder: f, dir: null });
    insertMeeting("failed1", "failed", { folder: f });
    insertMeeting("interrupted1", "interrupted", { folder: f });
    insertMeeting("live", "recording", { folder: f });
    insertMeeting("tr1", "transcribed", { folder: f });
    text("tr1");
    insertMeeting("tr-chunk", "transcribed", { folder: f });
    text("tr-chunk", 0);
    text("tr-chunk", 1, { failed: true });
    insertMeeting("sum-done", "summarized", { folder: f });
    text("sum-done");
    enhanced("sum-done");
    summary("sum-done", "Fair in May.");
    insertMeeting("sum-partial", "summarized", { folder: f });
    text("sum-partial");
    enhanced("sum-partial");
    summary("sum-partial", "Fair in", 1);
    insertMeeting("tr-empty", "transcribed", { folder: f });
    insertMeeting("elsewhere", "recorded", { folder: other.id });

    // No AI model: Summarize and Enhance cannot run.
    expect(await folderCounts(f)).toEqual({
      transcribe: { ready: 4, blocked: 1 },
      summarize: { ready: 0, blocked: 3 },
      enhance: { ready: 0, blocked: 2 },
    });
    seedTestModel();
    expect(await folderCounts(f)).toEqual({
      transcribe: { ready: 4, blocked: 1 },
      summarize: { ready: 3, blocked: 0 },
      enhance: { ready: 2, blocked: 0 },
    });
    expect(await folderCounts(other.id)).toEqual({
      transcribe: { ready: 1, blocked: 0 },
      summarize: { ready: 0, blocked: 0 },
      enhance: { ready: 0, blocked: 0 },
    });
  });
});

describe("POST /api/meetings/batch", () => {
  it("answers the idle state, 400 for a bad body and 404 for an unknown folder", async () => {
    expect(await batchState()).toMatchObject({
      active: false,
      total: 0,
      current: null,
      pending: [],
    });
    expect((await startBatch({ stage: "dance", folder_id: "x" })).status).toBe(
      400,
    );
    expect((await startBatch({ stage: "transcribe" })).status).toBe(400);
    expect(
      (await startBatch({ stage: "transcribe", meeting_ids: [] })).status,
    ).toBe(400);
    expect(
      (await startBatch({ stage: "transcribe", folder_id: "nope" })).status,
    ).toBe(404);
  });

  it("transcribes the folder's meetings one at a time, skips what cannot run, and the counts go down", async () => {
    const folder = await createFolder("Garden club");
    insertMeeting("a", "recorded", { folder: folder.id, startedAt: 1 });
    insertMeeting("b", "failed", { folder: folder.id, startedAt: 2 });
    insertMeeting("c", "interrupted", { folder: folder.id, startedAt: 3 });
    insertMeeting("gone", "recorded", { folder: folder.id, dir: null });
    insertMeeting("done", "transcribed", { folder: folder.id });
    text("done");
    const order: string[] = [];
    let maxTranscriptions = 0;
    __setMeetingsTestOverrides({
      ...noAligner,
      createTranscriberDeps: fakeTranscriber(() => {
        const running = listJobs().filter((j) => j.kind === "transcribe");
        maxTranscriptions = Math.max(maxTranscriptions, running.length);
        const id = running[0]?.id ?? "?";
        if (order.at(-1) !== id) order.push(id);
        return "The fair needs ten tables.";
      }),
    });
    expect(await folderCounts(folder.id)).toMatchObject({
      transcribe: { ready: 3, blocked: 1 },
    });

    const res = await startBatch({ stage: "transcribe", folder_id: folder.id });
    expect(res.status).toBe(202);
    const started = meetingBatchStateSchema.parse(await res.json());
    expect(started).toMatchObject({ active: true, total: 4 });
    await __batchQueueIdle();

    expect(maxTranscriptions).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
    expect(["a", "b", "c"].map(statusOf)).toEqual([
      "transcribed",
      "transcribed",
      "transcribed",
    ]);
    expect(await batchState()).toMatchObject({
      active: false,
      total: 4,
      done: 3,
      skipped: 1,
      skip_reasons: { no_audio: 1 },
    });
    expect(await folderCounts(folder.id)).toMatchObject({
      transcribe: { ready: 0, blocked: 1 },
    });
  });

  it("cancel stops the running transcription and drops the rest", async () => {
    const folder = await createFolder("Garden club");
    for (const [i, id] of ["a", "b", "c"].entries()) {
      insertMeeting(id, "recorded", { folder: folder.id, startedAt: i });
    }
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    __setMeetingsTestOverrides({
      ...noAligner,
      createTranscriberDeps: fakeTranscriber(async () => {
        reached.resolve();
        await gate.promise;
        return "The fair needs ten tables.";
      }),
    });
    expect(
      (await startBatch({ stage: "transcribe", folder_id: folder.id })).status,
    ).toBe(202);
    await reached.promise;
    const res = await postEmpty(app, `${base}/batch/cancel`);
    expect(res.status).toBe(200);
    expect(meetingBatchStateSchema.parse(await res.json())).toMatchObject({
      active: true,
      cancelled: 2,
      pending: [],
      current: { meeting_id: "a", title: "Meeting a", stage: "transcribe" },
    });
    gate.resolve();
    await __batchQueueIdle();
    expect(await batchState()).toMatchObject({
      active: false,
      total: 3,
      done: 0,
      cancelled: 3,
    });
    // The running one ends the normal cancelled way; the rest never ran.
    const a = getDb()
      .prepare("SELECT status, error FROM meetings WHERE id = 'a'")
      .get();
    expect(a).toEqual({ status: "failed", error: "Cancelled by user" });
    expect(statusOf("b")).toBe("recorded");
    expect(statusOf("c")).toBe("recorded");
    expect(await folderCounts(folder.id)).toMatchObject({
      transcribe: { ready: 3, blocked: 0 },
    });
  });

  it("re-runs Summarize on selected meetings and keeps the old summary as a version", async () => {
    seedTestModel();
    for (const id of ["s1", "s2"]) {
      insertMeeting(id, "summarized");
      text(id);
      summary(id, `Old summary of ${id}.`);
    }
    const h = runnerHarness({ answer: defaultAnswer });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    const res = await startBatch({
      stage: "summarize",
      meeting_ids: ["s1", "s2"],
    });
    expect(res.status).toBe(202);
    await __batchQueueIdle();
    expect(await batchState()).toMatchObject({ total: 2, done: 2, skipped: 0 });

    for (const id of ["s1", "s2"]) {
      const detail = meetingDetailResponseSchema.parse(
        await (await app.request(`${base}/${id}`)).json(),
      );
      expect(detail.summary?.markdown).not.toContain("Old summary");
      const versions = meetingSummaryVersionsResponseSchema.parse(
        await (await app.request(`${base}/${id}/summary-versions`)).json(),
      ).items;
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        markdown: `Old summary of ${id}.`,
        llm_model: "fake-model",
        created_at: 100,
        partial: false,
      });
      expect(versions[0].replaced_at).toBeGreaterThan(0);
    }
    expect((await app.request(`${base}/nope/summary-versions`)).status).toBe(
      404,
    );
  });

  it("runs Enhance on a folder one meeting at a time, and the Need-it count goes down", async () => {
    seedTestModel();
    const folder = await createFolder("Enhance batch");
    for (const [id, at] of [
      ["e1", 1],
      ["e2", 2],
    ] as const) {
      insertMeeting(id, "transcribed", { folder: folder.id, startedAt: at });
      text(id);
    }
    insertMeeting("e3", "summarized", { folder: folder.id, startedAt: 3 });
    text("e3");
    enhanced("e3");
    summary("e3", "Fine summary.");
    expect((await folderCounts(folder.id))?.enhance).toEqual({
      ready: 2,
      blocked: 0,
    });
    const h = runnerHarness({ answer: defaultAnswer });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    const res = await startBatch({ stage: "enhance", folder_id: folder.id });
    expect(res.status).toBe(202);
    await __batchQueueIdle();
    expect(await batchState()).toMatchObject({
      total: 2,
      done: 2,
      failed: 0,
      skipped: 0,
    });
    expect((await folderCounts(folder.id))?.enhance).toEqual({
      ready: 0,
      blocked: 0,
    });
    expect((await folderCounts(folder.id))?.summarize).toEqual({
      ready: 0,
      blocked: 0,
    });
  });

  it("ends the Enhance need also when the run finds nothing to correct", async () => {
    seedTestModel();
    const folder = await createFolder("Enhance clean");
    for (const [id, at] of [
      ["c1", 1],
      ["c2", 2],
    ] as const) {
      insertMeeting(id, "transcribed", { folder: folder.id, startedAt: at });
      text(id);
    }
    const h = runnerHarness({
      answer: (r) =>
        isSummaryRequest(r)
          ? SUMMARY_ANSWER
          : isIdentify(r)
            ? okReply('{"speakers":[]}')
            : okReply('{"corrections":[]}'),
    });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    await startBatch({ stage: "enhance", folder_id: folder.id });
    await __batchQueueIdle();
    expect(await batchState()).toMatchObject({ total: 2, done: 2, failed: 0 });
    // No segment has enhanced_text: the run mark ends the need.
    expect(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM meeting_segments WHERE enhanced_text IS NOT NULL",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect((await folderCounts(folder.id))?.enhance).toEqual({
      ready: 0,
      blocked: 0,
    });
    // A new transcript clears the mark: the meeting needs Enhance again.
    getDb().prepare("UPDATE meetings SET enhanced_at = NULL").run();
    expect((await folderCounts(folder.id))?.enhance.ready).toBe(2);
  });

  it("counts an Enhance run that failed as failed, and the meetings still need it", async () => {
    seedTestModel();
    const folder = await createFolder("Enhance fail");
    for (const [id, at] of [
      ["f1", 1],
      ["f2", 2],
    ] as const) {
      insertMeeting(id, "transcribed", { folder: folder.id, startedAt: at });
      text(id);
    }
    const h = runnerHarness({ answer: () => new Error("model down") });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });

    await startBatch({ stage: "enhance", folder_id: folder.id });
    await __batchQueueIdle();
    const state = await batchState();
    expect(state).toMatchObject({ total: 2, done: 0, skipped: 0 });
    expect(state.failed).toBe(2);
    expect((await folderCounts(folder.id))?.enhance.ready).toBe(2);
  });

  it("skips a selected meeting with no transcript, and a folder meeting that is done", async () => {
    seedTestModel();
    const folder = await createFolder("Garden club");
    insertMeeting("raw", "recorded", { folder: folder.id });
    insertMeeting("done", "summarized", { folder: folder.id });
    text("done");
    summary("done", "Fair in May.");
    const ids = await startBatch({
      stage: "summarize",
      meeting_ids: ["raw", "missing"],
    });
    expect(ids.status).toBe(202);
    await __batchQueueIdle();
    expect(await batchState()).toMatchObject({
      total: 2,
      done: 0,
      skip_reasons: { no_transcript: 1, gone: 1 },
    });
    // The folder has nothing to summarize: an empty batch.
    const empty = await startBatch({
      stage: "summarize",
      folder_id: folder.id,
    });
    expect(meetingBatchStateSchema.parse(await empty.json())).toMatchObject({
      active: false,
      total: 0,
    });
  });
});

describe("re-transcribe keeps confirmed speaker names", () => {
  /** Old run: label "2" at the first burst (Ana), label "1" at the second
   * (Ben). The new run numbers in first-appearance order, so the labels
   * swap: the names must follow the time, not the number. */
  function seedNamedMeeting() {
    insertMeeting("m1", "summarized");
    insertSegment({
      id: "old:0",
      meetingId: "m1",
      idx: 0,
      startMs: 400,
      endMs: 1800,
      text: "Hi, I am Ana.",
      speakerLabel: "2",
    });
    insertSegment({
      id: "old:1",
      meetingId: "m1",
      idx: 1,
      startMs: 2200,
      endMs: 3600,
      text: "Hi, I am Ben.",
      speakerLabel: "1",
    });
    insertSpeaker("m1", "2", { displayName: "Ana Lima", confirmedAt: 5 });
    insertSpeaker("m1", "1", { displayName: "Ben Ortiz", confirmedAt: 6 });
  }

  async function names(): Promise<Record<string, string | null>> {
    const res = await app.request(`${base}/m1/speakers`);
    const body = (await res.json()) as {
      speakers: { label: string; displayName: string | null }[];
    };
    return Object.fromEntries(
      body.speakers.map((s) => [s.label, s.displayName]),
    );
  }

  async function transcribeAgain() {
    expect((await postEmpty(app, `${base}/m1/transcribe`)).status).toBe(202);
    await waitUntil(() => statusOf("m1") !== "transcribing");
    expect(statusOf("m1")).toBe("transcribed");
  }

  it("moves each name to the new label with the same time", async () => {
    seedNamedMeeting();
    __setMeetingsTestOverrides({
      ...noAligner,
      createTranscriberDeps: fakeTranscriber(() => "Hello there."),
      diarizeDeps: fakeDiarizer([
        { speakerId: "S1", start: 0.4, end: 1.8 },
        { speakerId: "S2", start: 2.2, end: 3.6 },
      ]),
    });
    await transcribeAgain();
    expect(await names()).toEqual({ "1": "Ana Lima", "2": "Ben Ortiz" });
    const detail = meetingDetailResponseSchema.parse(
      await (await app.request(`${base}/m1`)).json(),
    );
    expect(detail.speaker_names_lost).toEqual([]);
  });

  it("leaves the speakers unnamed and lists the names when the new speakers do not match", async () => {
    seedNamedMeeting();
    __setMeetingsTestOverrides({
      ...noAligner,
      createTranscriberDeps: fakeTranscriber(() => "Hello there."),
      // The new run hears one speaker over both bursts.
      diarizeDeps: fakeDiarizer([{ speakerId: "S1", start: 0.4, end: 3.6 }]),
    });
    await transcribeAgain();
    expect(Object.values(await names()).every((n) => n === null)).toBe(true);
    const detail = meetingDetailResponseSchema.parse(
      await (await app.request(`${base}/m1`)).json(),
    );
    expect(detail.speaker_names_lost).toEqual(["Ana Lima", "Ben Ortiz"]);
    // Naming a speaker again clears the note.
    const patch = await jsonRequest(app, "PATCH", `${base}/m1/speakers/1`, {
      displayName: "Ana Lima",
    });
    expect(patch.status).toBe(200);
    const after = meetingDetailResponseSchema.parse(
      await (await app.request(`${base}/m1`)).json(),
    );
    expect(after.speaker_names_lost).toEqual([]);
  });
});
