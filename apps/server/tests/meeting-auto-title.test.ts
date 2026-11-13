// Auto title (AI meeting titles). The graph node `suggestTitle` runs after
// Summarize over a scripted model; the Generate title route and the batch
// stage `title` run through the real app. Fictional meetings only.
import { DatabaseSync } from "node:sqlite";
import {
  meetingBatchStateSchema,
  meetingTitleGenerateResponseSchema,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import {
  cleanTitle,
  titleSkipReason,
  writeAiTitle,
} from "../src/lib/meetings/meeting-title.js";
import { initSchema } from "../src/lib/schema.js";
import {
  __batchQueueIdle,
  __setMeetingsTestOverrides,
} from "../src/routes/meetings.js";
import { okReply, type ScriptStep } from "./helpers/fake-model.js";
import { jsonRequest, postEmpty } from "./helpers/http.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";
import {
  isSummaryRequest,
  runnerHarness,
  SUMMARY_ANSWER,
} from "./helpers/runner-helpers.js";
import {
  makeFakeRecorder,
  makeTestDeps,
  type RecordedRequest,
  resetWorkflowTables,
  runScriptedGraph,
  seedFixtureMeeting,
  seedTestModel,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const app = createApp();
const NONE = okReply('{"corrections":[]}');
const TITLE_MARK = "You write a short title for a meeting";
const isTitleRequest = (r: RecordedRequest) => r.system.includes(TITLE_MARK);
const titleReply = (title: string) => okReply(JSON.stringify({ title }));

function setAutoTitle(value: "true" | "false" | null): void {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key = ?").run(
    SETTINGS_KEYS.meetingAutoTitle,
  );
  if (value !== null) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      SETTINGS_KEYS.meetingAutoTitle,
      value,
    );
  }
}

function titleRow(id: string): { title: string | null; title_source: string } {
  return getDb()
    .prepare("SELECT title, title_source FROM meetings WHERE id = ?")
    .get(id) as { title: string | null; title_source: string };
}

function setTitle(id: string, title: string | null, source: string): void {
  getDb()
    .prepare("UPDATE meetings SET title = ?, title_source = ? WHERE id = ?")
    .run(title, source, id);
}

beforeEach(() => {
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  setAutoTitle(null);
});

afterEach(() => {
  setAutoTitle(null);
});

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe("cleanTitle", () => {
  it("removes quotes, a label, a trailing period and extra spaces", () => {
    expect(cleanTitle('  "Garden fair   budget."  ')).toBe(
      "Garden fair budget",
    );
    expect(cleanTitle("Title: «Orchid rollout plan»")).toBe(
      "Orchid rollout plan",
    );
    expect(cleanTitle("   ")).toBe("");
  });

  it("cuts a long title at a word end, at most 80 characters", () => {
    const out = cleanTitle(`${"word ".repeat(30)}end`);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("word")).toBe(true);
  });
});

describe("titleSkipReason (node skip rules)", () => {
  const base = { settingOn: true, source: "default", overview: "A plan." };
  it("runs on a default or file title with a summary", () => {
    expect(titleSkipReason(base)).toBeNull();
    expect(titleSkipReason({ ...base, source: "file" })).toBeNull();
  });
  it("skips when the setting is off", () => {
    expect(titleSkipReason({ ...base, settingOn: false })).toBe(
      "auto_title_off",
    );
  });
  it.each([
    "user",
    "calendar",
    "ai",
    null,
  ])("keeps a title with the source %s", (source) => {
    expect(titleSkipReason({ ...base, source })).toBe("title_kept");
  });
  it("skips with no summary", () => {
    expect(titleSkipReason({ ...base, overview: "  " })).toBe("no_summary");
  });
});

// ---------------------------------------------------------------------------
// Schema 58 backfill
// ---------------------------------------------------------------------------

describe("schema 58: title_source backfill", () => {
  it("fills default and calendar, and keeps every other old title as user", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    initSchema(db);
    // Back to a version-57 file: no title_source column yet.
    db.exec(`
      ALTER TABLE meetings DROP COLUMN title_source;
      UPDATE schema_version SET version = 57;
      INSERT INTO meetings (id, title, status, created_at)
        VALUES ('none', NULL, 'transcribed', 1),
               ('blank', '  ', 'transcribed', 1),
               ('cal', 'Weekly sync', 'transcribed', 1),
               ('imp', 'zoom_0412_rec', 'transcribed', 1),
               ('rec', 'Budget talk', 'transcribed', 1),
               ('imp-new', 'audio-file', 'recorded', 1);
      UPDATE meetings SET calendar_title = 'Weekly sync' WHERE id = 'cal';
      INSERT INTO meeting_segments (id, meeting_id, source, idx, text) VALUES
        ('i1', 'imp', 'system', 0, 'Hello'),
        ('r1', 'rec', 'mic', 0, 'Hello'),
        ('r2', 'rec', 'system', 1, 'Hi');
    `);
    initSchema(db);
    const rows = db
      .prepare("SELECT id, title, title_source FROM meetings ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "blank", title: "  ", title_source: "default" },
      { id: "cal", title: "Weekly sync", title_source: "calendar" },
      // An old import title stays: the AI never writes over an old title.
      { id: "imp", title: "zoom_0412_rec", title_source: "user" },
      { id: "imp-new", title: "audio-file", title_source: "user" },
      { id: "none", title: null, title_source: "default" },
      { id: "rec", title: "Budget talk", title_source: "user" },
    ]);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: 58,
    });
    // A second run changes nothing.
    initSchema(db);
    expect(
      db
        .prepare("SELECT id, title, title_source FROM meetings ORDER BY id")
        .all(),
    ).toEqual(rows);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// The conditional write
// ---------------------------------------------------------------------------

describe("writeAiTitle", () => {
  beforeEach(() => resetWorkflowTables());

  it("writes over default and file only, unless forced", () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "w1" });
    const id = f.meeting.id;
    for (const source of ["default", "file"]) {
      setTitle(id, "old", source);
      expect(writeAiTitle(getDb(), id, "New title", { force: false })).toBe(
        true,
      );
      expect(titleRow(id)).toEqual({ title: "New title", title_source: "ai" });
    }
    for (const source of ["user", "calendar", "ai"]) {
      setTitle(id, "Kept", source);
      expect(writeAiTitle(getDb(), id, "Other", { force: false })).toBe(false);
      expect(titleRow(id)).toEqual({ title: "Kept", title_source: source });
    }
    // The button forces the write; the title is the AI's again.
    setTitle(id, "Typed by me", "user");
    expect(writeAiTitle(getDb(), id, "Forced", { force: true })).toBe(true);
    expect(titleRow(id)).toEqual({ title: "Forced", title_source: "ai" });
  });
});

// ---------------------------------------------------------------------------
// The graph node
// ---------------------------------------------------------------------------

describe("suggestTitle node", () => {
  beforeEach(() => {
    resetWorkflowTables();
    seedTestModel();
  });

  async function summarizeRun(
    meetingId: string,
    onTitle: (r: RecordedRequest) => ScriptStep = () =>
      titleReply('"Ship date for the Friday release."'),
  ) {
    const recorder = makeFakeRecorder();
    const { deps } = makeTestDeps({ recorder });
    const out = await runScriptedGraph({
      deps,
      meetingId,
      stages: ["summarize"],
      script: (req) =>
        isTitleRequest(req)
          ? onTitle(req)
          : isSummaryRequest(req)
            ? SUMMARY_ANSWER
            : NONE,
    });
    return {
      ...out,
      recorder,
      titleRequests: out.requests.filter(isTitleRequest),
    };
  }

  it("writes a cleaned AI title over an empty title after Summarize", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "t-ok" });
    setTitle(f.meeting.id, null, "default");
    const r = await summarizeRun(f.meeting.id);
    expect(r.titleRequests).toHaveLength(1);
    const req = r.titleRequests[0] as RecordedRequest;
    expect(req.user).toContain("The team agreed to ship on Friday.");
    expect(req.user).toContain("<current_title>(none)</current_title>");
    expect(req.system).toContain("Do not write a date.");
    expect(r.finalState.title).toMatchObject({
      status: "ok",
      title: "Ship date for the Friday release",
      written: true,
    });
    expect(titleRow(f.meeting.id)).toEqual({
      title: "Ship date for the Friday release",
      title_source: "ai",
    });
    expect(r.recorder.steps.get("title")?.status).toBe("succeeded");
    expect(r.recorder.calls.find((c) => c.unitKey === "title")?.node).toBe(
      "suggestTitle",
    );
  });

  it("replaces a file-name title and shows it to the model", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "t-file",
    });
    setTitle(f.meeting.id, "zoom_0412_rec", "file");
    const r = await summarizeRun(f.meeting.id);
    expect(r.titleRequests[0]?.user).toContain(
      "<current_title>zoom_0412_rec</current_title>",
    );
    expect(titleRow(f.meeting.id).title_source).toBe("ai");
  });

  it("does not run when the setting is off", async () => {
    setAutoTitle("false");
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "t-off",
    });
    setTitle(f.meeting.id, null, "default");
    const r = await summarizeRun(f.meeting.id);
    expect(r.titleRequests).toHaveLength(0);
    expect(r.finalState.title).toBeNull();
    expect(titleRow(f.meeting.id)).toEqual({
      title: null,
      title_source: "default",
    });
  });

  it.each([
    "user",
    "calendar",
    "ai",
  ])("keeps a %s title: no title call", async (source) => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: `t-${source}`,
    });
    setTitle(f.meeting.id, "Kept title", source);
    const r = await summarizeRun(f.meeting.id);
    expect(r.titleRequests).toHaveLength(0);
    expect(titleRow(f.meeting.id)).toEqual({
      title: "Kept title",
      title_source: source,
    });
  });

  it("a rename during the call wins over the AI title", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "t-race",
    });
    setTitle(f.meeting.id, null, "default");
    const r = await summarizeRun(f.meeting.id, () => {
      // The user renames the meeting while the model writes (PATCH).
      setTitle(f.meeting.id, "My own name", "user");
      return titleReply("AI name");
    });
    expect(r.titleRequests).toHaveLength(1);
    expect(r.finalState.title).toMatchObject({
      status: "ok",
      title: "AI name",
      written: false,
    });
    expect(titleRow(f.meeting.id)).toEqual({
      title: "My own name",
      title_source: "user",
    });
  });
});

// ---------------------------------------------------------------------------
// Routes: PATCH, Generate title and the batch
// ---------------------------------------------------------------------------

describe("title routes", () => {
  const base = "/api/meetings";

  beforeEach(() => {
    resetMeetingTables();
    seedTestModel();
  });

  afterEach(async () => {
    await __batchQueueIdle();
    resetMeetingTables();
    __setMeetingsTestOverrides();
  });

  function insertMeeting(
    id: string,
    title: string | null,
    source: string,
    summary: string | null,
  ): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO meetings (id, title, title_source, started_at, status, created_at)
       VALUES (?, ?, ?, 1, ?, 1)`,
    ).run(id, title, source, summary ? "summarized" : "transcribed");
    insertSegment({
      id: `${id}:0`,
      meetingId: id,
      idx: 0,
      startMs: 0,
      endMs: 900,
      text: "We plan the garden fair for May.",
    });
    if (summary) {
      db.prepare(
        `INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, llm_provider, llm_model, created_at)
         VALUES (?, ?, ?, 'fake', 'fake-model', 100)`,
      ).run(
        id,
        `## Overview\n${summary}`,
        JSON.stringify({ overview: summary }),
      );
    }
  }

  function useTitleModel(title: string) {
    const h = runnerHarness({
      answer: (r) => (isTitleRequest(r) ? titleReply(title) : NONE),
    });
    __setMeetingsTestOverrides({ workflowDeps: h.deps });
    return h;
  }

  it("PATCH makes the title the user's", async () => {
    insertMeeting("p1", null, "default", null);
    const res = await jsonRequest(app, "PATCH", `${base}/p1`, {
      title: "Typed name",
    });
    expect(res.status).toBe(200);
    expect(titleRow("p1")).toEqual({
      title: "Typed name",
      title_source: "user",
    });
  });

  it("Generate title writes over a typed title and answers the title", async () => {
    insertMeeting("g1", "Typed name", "user", "The fair moves to May.");
    const h = useTitleModel("Garden fair moves to May");
    const res = await postEmpty(app, `${base}/g1/title/generate`);
    expect(res.status).toBe(200);
    expect(meetingTitleGenerateResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      title: "Garden fair moves to May",
      title_source: "ai",
    });
    expect(titleRow("g1")).toEqual({
      title: "Garden fair moves to May",
      title_source: "ai",
    });
    expect(h.requests.filter(isTitleRequest)).toHaveLength(1);
    // The call is a `title` run of the meeting in the call record.
    const run = getDb()
      .prepare("SELECT kind, status FROM llm_runs WHERE scope_id = ?")
      .get("g1");
    expect(run).toEqual({ kind: "title", status: "succeeded" });
  });

  it("Generate title answers 409 with no summary and 404 for no meeting", async () => {
    insertMeeting("g2", null, "default", null);
    useTitleModel("Unused");
    const res = await postEmpty(app, `${base}/g2/title/generate`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no_summary" });
    const gone = await postEmpty(app, `${base}/nope/title/generate`);
    expect(gone.status).toBe(404);
  });

  it("the batch fills only empty and file-name titles (decision 9)", async () => {
    insertMeeting("b-default", null, "default", "Plan for the fair.");
    insertMeeting("b-file", "rec_0412", "file", "Budget for the fair.");
    insertMeeting("b-user", "Typed name", "user", "A user meeting.");
    insertMeeting("b-cal", "Weekly sync", "calendar", "A calendar meeting.");
    insertMeeting("b-ai", "Old AI title", "ai", "An AI meeting.");
    insertMeeting("b-nosum", null, "default", null);
    const h = useTitleModel("Garden fair plan");
    const res = await jsonRequest(app, "POST", `${base}/batch`, {
      stage: "title",
      meeting_ids: [
        "b-default",
        "b-file",
        "b-user",
        "b-cal",
        "b-ai",
        "b-nosum",
      ],
    });
    expect(res.status).toBe(202);
    await __batchQueueIdle();
    const state = meetingBatchStateSchema.parse(
      await (await app.request(`${base}/batch`)).json(),
    );
    expect(state).toMatchObject({ total: 6, done: 2, skipped: 4, failed: 0 });
    expect(state.skip_reasons).toEqual({ not_needed: 4 });
    expect(h.requests.filter(isTitleRequest)).toHaveLength(2);
    expect(titleRow("b-default")).toEqual({
      title: "Garden fair plan",
      title_source: "ai",
    });
    expect(titleRow("b-file").title_source).toBe("ai");
    expect(titleRow("b-user")).toEqual({
      title: "Typed name",
      title_source: "user",
    });
    expect(titleRow("b-cal").title_source).toBe("calendar");
    expect(titleRow("b-ai").title).toBe("Old AI title");
    expect(titleRow("b-nosum")).toEqual({
      title: null,
      title_source: "default",
    });
  });
});
