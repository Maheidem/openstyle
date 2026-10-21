// Node `suggestTags` (issue #231). The real graph, gateway and saver run over
// a scripted model. The meetings have one speaker, so `identifySpeakers` is
// skipped. The tag request comes after `save` and never fails the run.
import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { setMeetingTags } from "../src/lib/meetings/tags.js";
import { sampleLines } from "../src/lib/meetings/workflow/nodes/suggest-tags.js";
import { FOLDER_CONTEXT_LABEL } from "../src/lib/meetings/workflow/prompts.js";
import {
  deriveRunStatus,
  type FinalState,
} from "../src/lib/meetings/workflow/types.js";
import { okReply, type ScriptStep } from "./helpers/fake-model.js";
import { isSummaryRequest, SUMMARY_ANSWER } from "./helpers/runner-helpers.js";
import {
  makeFakeRecorder,
  makeTestDeps,
  type RecordedRequest,
  resetWorkflowTables,
  runScriptedGraph,
  seedFixtureMeeting,
  seedTestModel,
  type TagsAnswer,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const NONE = okReply('{"corrections":[]}');
const tagsReply = (tags: string[]) => okReply(JSON.stringify({ tags }));
const noEnd = {
  cancelled: false,
  fault: "none",
  hasCheckpoint: false,
} as const;

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

function meeting(id: string) {
  return seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: id });
}

function tagRows(meetingId: string) {
  return getDb()
    .prepare(
      `SELECT t.name, mt.source FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
       WHERE mt.meeting_id = ? ORDER BY t.name`,
    )
    .all(meetingId);
}

async function run(
  meetingId: string,
  tags: TagsAnswer,
  stages: ("enhance" | "summarize")[] = ["enhance"],
) {
  const recorder = makeFakeRecorder();
  const { deps } = makeTestDeps({ recorder });
  const out = await runScriptedGraph({
    deps,
    meetingId,
    stages,
    script: (req: RecordedRequest): ScriptStep =>
      isSummaryRequest(req) ? SUMMARY_ANSWER : NONE,
    tags,
  });
  return { ...out, recorder };
}

describe("suggestTags", () => {
  it("adds the normalized tags with source llm after save, in one strict request", async () => {
    const f = meeting("m-tags-ok");
    const r = await run(
      f.meeting.id,
      tagsReply(["  Budget ", "Q3   Plan", "budget", "", "x".repeat(41)]),
    );
    expect(r.tagRequests).toHaveLength(1);
    expect(r.finalState.tags).toMatchObject({
      status: "ok",
      suggested: ["budget", "q3 plan"],
      added: ["budget", "q3 plan"],
    });
    expect(tagRows(f.meeting.id)).toEqual([
      { name: "budget", source: "llm" },
      { name: "q3 plan", source: "llm" },
    ]);
    expect(r.recorder.steps.get("tags")?.status).toBe("succeeded");
    // The call is recorded like other calls, under its own node.
    const call = r.recorder.calls.find((c) => c.unitKey === "tags");
    expect(call?.node).toBe("suggestTags");
    expect(
      (r.tagRequests[0]?.responseFormat as { type: string } | undefined)?.type,
    ).toBe("json");
    // The tag request is the last request of the run.
    expect(r.requests.length).toBeGreaterThan(0);
    expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe(
      "succeeded",
    );
  });

  it("puts the existing tags in the prompt and reuses a tag without a new row", async () => {
    const other = meeting("m-other");
    setMeetingTags(other.meeting.id, ["hiring", "roadmap"]);
    const f = meeting("m-reuse");
    const r = await run(f.meeting.id, tagsReply(["Hiring"]));
    expect(r.tagRequests[0]?.system).toContain("hiring, roadmap");
    expect(r.tagRequests[0]?.system).toContain("use that exact tag");
    expect(tagRows(f.meeting.id)).toEqual([{ name: "hiring", source: "llm" }]);
    expect(getDb().prepare("SELECT count(*) AS c FROM tags").get()).toEqual({
      c: 2,
    });
    // No other node sees the tag list.
    for (const req of r.requests) {
      expect(req.system).not.toContain("hiring, roadmap");
      expect(req.user).not.toContain("hiring, roadmap");
    }
  });

  it("a filed meeting: the tag prompt has the folder block; the summary prompts do not (#230, P8b)", async () => {
    const f = meeting("m-tags-folder");
    const now = Date.now();
    getDb().exec("DELETE FROM meeting_folders");
    getDb()
      .prepare(
        "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("fold-t", "Orchid Rollout", "Launch of a made-up app.", now, now);
    getDb()
      .prepare("UPDATE meetings SET folder_id = ? WHERE id = ?")
      .run("fold-t", f.meeting.id);
    const r = await run(f.meeting.id, tagsReply(["orchid"]), [
      "enhance",
      "summarize",
    ]);
    expect(r.tagRequests).toHaveLength(1);
    expect(r.tagRequests[0]?.system).toContain(
      `Weekly planning call of a made-up product team.\n\n${FOLDER_CONTEXT_LABEL} Orchid Rollout - Launch of a made-up app.`,
    );
    const summaries = r.requests.filter(isSummaryRequest);
    expect(summaries.length).toBeGreaterThan(0);
    for (const req of summaries) {
      expect(req.system).not.toContain(FOLDER_CONTEXT_LABEL);
    }
    getDb().exec("DELETE FROM meetings");
    getDb().exec("DELETE FROM meeting_folders");
  });

  it("keeps at most 5 suggested tags", async () => {
    const f = meeting("m-cap");
    const r = await run(
      f.meeting.id,
      tagsReply(["a1", "a2", "a3", "a4", "a5", "a6", "a7"]),
    );
    expect(r.finalState.tags?.suggested).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
    expect(tagRows(f.meeting.id)).toHaveLength(5);
  });

  it("never removes or changes a user tag", async () => {
    const f = meeting("m-user");
    setMeetingTags(f.meeting.id, ["budget", "legal"]);
    await run(f.meeting.id, tagsReply(["budget", "launch"]));
    expect(tagRows(f.meeting.id)).toEqual([
      { name: "budget", source: "user" },
      { name: "launch", source: "llm" },
      { name: "legal", source: "user" },
    ]);
  });

  it("a failed tag call does not fail or block Enhance or Summarize", async () => {
    const f = meeting("m-fail");
    setMeetingTags(f.meeting.id, ["legal"]);
    const r = await run(
      f.meeting.id,
      new APICallError({
        message: "HTTP 401",
        url: "http://127.0.0.1:1/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      }),
      ["enhance", "summarize"],
    );
    expect(r.finalState.tags?.status).toBe("failed");
    expect(r.finalState.tags?.failure?.kind).toBe("provider_auth");
    expect(r.recorder.steps.get("tags")).toMatchObject({
      status: "failed",
      errorKind: "provider_auth",
    });
    expect(r.finalState.saved?.failures).toEqual([]);
    expect(r.finalState.summary?.status).toBe("ok");
    expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe(
      "succeeded",
    );
    expect(
      getDb()
        .prepare("SELECT markdown FROM meeting_summaries WHERE meeting_id = ?")
        .get(f.meeting.id),
    ).toBeTruthy();
    expect(tagRows(f.meeting.id)).toEqual([{ name: "legal", source: "user" }]);
  });

  it("an invalid answer fails only the tag step", async () => {
    const f = meeting("m-bad-json");
    const r = await run(f.meeting.id, okReply('{"tags":"budget"}'));
    expect(r.finalState.tags?.status).toBe("failed");
    expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe(
      "succeeded",
    );
    expect(tagRows(f.meeting.id)).toEqual([]);
  });

  it("a fault in the tag write becomes an internal failure, and the run still succeeds", async () => {
    const f = meeting("m-throw");
    // The answer is valid, but no tag row can be written.
    getDb().exec(
      `CREATE TRIGGER block_tags BEFORE INSERT ON tags
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    try {
      const r = await run(f.meeting.id, tagsReply(["budget"]));
      expect(r.finalState.tags?.status).toBe("failed");
      expect(r.finalState.tags?.failure?.kind).toBe("internal");
      expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe(
        "succeeded",
      );
    } finally {
      getDb().exec("DROP TRIGGER block_tags");
    }
  });

  it("a Summarize-only run sends no tag request", async () => {
    const f = meeting("m-summary-only");
    const r = await run(f.meeting.id, tagsReply(["budget"]), ["summarize"]);
    expect(r.tagRequests).toHaveLength(0);
    expect(r.finalState.tags).toBeNull();
    expect(tagRows(f.meeting.id)).toEqual([]);
  });

  it("other nodes send the same requests whether the tag call works or fails", async () => {
    const a = meeting("m-same");
    const ok = await run(a.meeting.id, tagsReply(["budget"]), [
      "enhance",
      "summarize",
    ]);
    resetWorkflowTables();
    seedTestModel();
    const b = meeting("m-same");
    const bad = await run(b.meeting.id, okReply("not json"), [
      "enhance",
      "summarize",
    ]);
    const view = (reqs: RecordedRequest[]) =>
      reqs.map((q) => ({ system: q.system, user: q.user }));
    expect(view(bad.requests)).toEqual(view(ok.requests));
    expect(bad.finalState.summary?.markdown).toBe(
      ok.finalState.summary?.markdown,
    );
  });
});

describe("sampleLines", () => {
  it("keeps every line when they fit, and spreads lines over the meeting when not", () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `Me: line ${i} ${"w".repeat(36)}`,
    );
    expect(sampleLines(lines, 100_000)).toEqual(lines);
    const picked = sampleLines(lines, 300);
    expect(picked.length).toBeGreaterThan(10);
    expect(picked.length).toBeLessThan(100);
    // Lines from the start and from the end of the meeting are in.
    expect(Number(picked[0]?.split(" ")[2])).toBeLessThan(15);
    expect(Number(picked.at(-1)?.split(" ")[2])).toBeGreaterThan(85);
  });
});
