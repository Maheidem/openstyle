// Node `prepare` (specs/meeting-enhance-agentic.md 4.1, 10.6 row `prepare`).
// The inputHash cases belong to the WP2 test `input-hash.test.ts`; here
// `prepare` only has to pass the hash to the run context.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import {
  hashVariantOf,
  inputHash,
  loadHashRows,
} from "../src/lib/meetings/input-hash.js";
import { makePrepareNode } from "../src/lib/meetings/workflow/nodes/prepare.js";
import {
  buildPromptContext,
  FOLDER_CONTEXT_MAX_CHARS,
  FOLDER_CONTEXT_LABEL as L,
} from "../src/lib/meetings/workflow/prompts.js";
import type { WorkflowStateType } from "../src/lib/meetings/workflow/state.js";
import {
  CHUNK_TOKENS_MAX,
  PrepareFailure,
} from "../src/lib/meetings/workflow/types.js";
import { fetchModelsFromRegistry } from "../src/lib/model-registry.js";
import {
  makeTestDeps,
  makeTestRunContext,
  resetWorkflowTables,
  seedFixtureMeeting,
  seedTestModel,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn(),
}));
const registryMock = vi.mocked(fetchModelsFromRegistry);

function stateFor(meetingId: string, runId = "run-1"): WorkflowStateType {
  return {
    runId,
    meetingId,
    stages: ["enhance"],
    prepared: null,
    models: null,
    corrections: [],
    identify: null,
    verify: null,
    summary: null,
    saved: null,
    tags: null,
  };
}

async function prepare(
  meetingId: string,
  stages: ("enhance" | "summarize")[] = ["enhance"],
) {
  const { deps, contexts } = makeTestDeps();
  const ctx = makeTestRunContext({ meetingId });
  contexts.register(ctx);
  const node = makePrepareNode(deps);
  const out = await node({ ...stateFor(meetingId), stages });
  return { out, ctx, deps };
}

beforeEach(() => {
  resetWorkflowTables();
  registryMock.mockReset();
  registryMock.mockResolvedValue({});
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  getDb().exec("DELETE FROM api_keys");
  seedTestModel();
});

describe("prepare", () => {
  it("builds the prepared meeting, fixes the models and passes the hash to the context", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      withCalendar: true,
    });
    const { out, ctx, deps } = await prepare(f.meeting.id);
    const p = out.prepared;
    expect(p.meetingId).toBe(f.meeting.id);
    expect(p.language).toBe("en");
    expect(p.title).toBe("Rollout planning");
    expect(p.segments).toHaveLength(8);
    // P3, P4: raw text, display label.
    expect(p.segments[0]?.displayLabel).toBe("Me");
    expect(p.segments[1]?.displayLabel).toBe("Them 2");
    expect(p.segments[1]?.speakerLabel).toBe("2");
    expect(p.segments[0]?.speakerLabel).toBeNull();
    // P8: names only, no emails.
    expect(p.attendeeNames).toEqual([
      "Jordan Vale",
      "Casey Marlow",
      "Riley Quinn",
    ]);
    expect(JSON.stringify(p)).not.toContain("example.test");
    // P9: one model for each LLM node, fixed once.
    expect(Object.keys(out.models).sort()).toEqual([
      "correctChunk",
      "identifySpeakers",
      "suggestTags",
      "summarize",
    ]);
    expect(out.models.correctChunk.provider).toBe("server");
    // P11: the hash equals the one function, and the context got it.
    const expected = inputHash(
      loadHashRows(deps.db, f.meeting.id),
      hashVariantOf(["enhance"]),
    );
    expect(p.inputHash).toBe(expected);
    expect(ctx.inputHash).toBe(expected);
    expect(ctx.startedNodes).toEqual(["prepare"]);
  });

  it("No diarization: labels.all is empty. All labels named: toIdentify is empty", async () => {
    const solo = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-solo",
    });
    const a = await prepare(solo.meeting.id);
    expect(a.out.prepared.labels).toEqual({
      all: [],
      confirmed: [],
      toIdentify: [],
    });

    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      meetingId: "m-named",
    });
    const db = getDb();
    for (const label of ["2", "3"]) {
      db.prepare(
        "INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, updated_at) VALUES (?, ?, ?, 0)",
      ).run(f.meeting.id, label, `Person ${label}`);
    }
    const b = await prepare(f.meeting.id);
    expect(b.out.prepared.labels.all.sort()).toEqual(["2", "3"]);
    expect(b.out.prepared.labels.toIdentify).toEqual([]);
    expect(b.out.prepared.labels.confirmed.sort()).toEqual(["2", "3"]);
    // A confirmed name shows in the line label.
    expect(
      b.out.prepared.segments.some((s) => s.displayLabel === "Person 2"),
    ).toBe(true);
    expect(
      b.out.prepared.segments.find((s) => s.displayLabel === "Person 2")
        ?.speakerName,
    ).toBe("Person 2");
  });

  it("A chunk never splits a segment, and chunk ids never overlap", async () => {
    const f = seedFixtureMeeting({ chunks: 6, speakers: 3, padChars: 1000 });
    const { out } = await prepare(f.meeting.id);
    const chunks = out.prepared.chunks;
    expect(chunks.length).toBeGreaterThan(1);
    const flat = chunks.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toEqual(out.prepared.segments.map((s) => s.id));
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
  });

  it("an empty transcript fails with empty_input and sends no call", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 2,
      meetingId: "m-empty",
    });
    getDb()
      .prepare("UPDATE meeting_segments SET text = '   ' WHERE meeting_id = ?")
      .run(f.meeting.id);
    const { deps, contexts } = makeTestDeps();
    contexts.register(makeTestRunContext({ meetingId: f.meeting.id }));
    const node = makePrepareNode(deps);
    const err = await node(stateFor(f.meeting.id)).catch((e) => e);
    expect(err).toBeInstanceOf(PrepareFailure);
    expect((err as PrepareFailure).kind).toBe("empty_input");
    // The step row closes failed with the typed kind.
    const step = (
      deps.recorder as unknown as {
        steps: Map<string, { status: string; errorKind: string | null }>;
      }
    ).steps.get("prepare");
    expect(step).toMatchObject({ status: "failed", errorKind: "empty_input" });
  });

  it("no model set up: the run ends with model_unavailable", async () => {
    getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 2,
      meetingId: "m-nomodel",
    });
    const { deps, contexts } = makeTestDeps();
    contexts.register(makeTestRunContext({ meetingId: f.meeting.id }));
    const err = await makePrepareNode(deps)(stateFor(f.meeting.id)).catch(
      (e) => e,
    );
    expect((err as { kind: string }).kind).toBe("model_unavailable");
  });

  it("the chunk size shrinks when the fit check fails (4.0.5)", async () => {
    getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO api_keys (provider, key) VALUES ('openai', 'key')",
      )
      .run();
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES ('openai', 'gpt-4o-mini', 'gpt-4o-mini', 'llm', 1)",
      )
      .run();
    registryMock.mockResolvedValue({
      openai: {
        models: {
          "gpt-4o-mini": {
            id: "gpt-4o-mini",
            structured_output: true,
            reasoning: false,
            limit: { context: 2000, output: 1000 },
          },
        },
      },
    });
    const f = seedFixtureMeeting({
      chunks: 4,
      speakers: 2,
      padChars: 600,
      meetingId: "m-small",
    });
    const { out } = await prepare(f.meeting.id);
    expect(out.models.correctChunk.contextWindow).toBe(2000);
    // floor((2000 - system - 256 - 200) / 3) is far below 1200.
    expect(out.prepared.chunkTokens).toBeLessThan(CHUNK_TOKENS_MAX);
    expect(out.prepared.chunkTokens).toBeGreaterThan(100);
  });

  it("prepared.summary holds the two settings; a later change does not change the state", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 2,
      meetingId: "m-settings",
    });
    const db = getDb();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('meeting_summary_context_budget', '2000')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('meeting_summary_instructions', 'Write in a short style.')",
    ).run();
    const { out } = await prepare(f.meeting.id);
    expect(out.prepared.summary).toEqual({
      instructions: "Write in a short style.",
      contextBudget: 2000,
    });
    db.prepare(
      "UPDATE settings SET value = '9000' WHERE key = 'meeting_summary_context_budget'",
    ).run();
    // The state is a value: the stored object does not follow the setting.
    expect(out.prepared.summary.contextBudget).toBe(2000);
    // A fresh run reads the new value.
    const again = await prepare(f.meeting.id);
    expect(again.out.prepared.summary.contextBudget).toBe(9000);
    db.prepare(
      "DELETE FROM settings WHERE key IN ('meeting_summary_context_budget', 'meeting_summary_instructions')",
    ).run();
    const dflt = await prepare(f.meeting.id);
    expect(dflt.out.prepared.summary).toEqual({
      instructions: "",
      contextBudget: 8000,
    });
  });

  it("a blank-text segment is left out (P2)", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 2,
      meetingId: "m-blank",
    });
    getDb()
      .prepare("UPDATE meeting_segments SET text = '  ' WHERE id = ?")
      .run(f.segments[1]?.id);
    const { out } = await prepare(f.meeting.id);
    expect(out.prepared.segments.map((s) => s.id)).not.toContain(
      f.segments[1]?.id,
    );
  });
});

// Issue #230 phase 2: the folder text in the prompt context.
describe("prepare: folder context (#230)", () => {
  const MEETING_CONTEXT = "Weekly planning call of a made-up product team.";

  function fileInFolder(
    meetingId: string,
    name: string,
    description: string | null,
  ): string {
    const id = `folder-${meetingId}`;
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, name, description, now, now);
    getDb()
      .prepare("UPDATE meetings SET folder_id = ? WHERE id = ?")
      .run(id, meetingId);
    return id;
  }

  beforeEach(() => {
    // resetWorkflowTables deleted the meetings, so no row holds a folder.
    getDb().exec("DELETE FROM meeting_folders");
  });

  it("a filed meeting: the meeting context first, then the folder block", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    fileInFolder(f.meeting.id, "Orchid Rollout", "Launch of a made-up app.");
    const { out } = await prepare(f.meeting.id);
    expect(out.prepared.context).toBe(
      `${MEETING_CONTEXT}\n\n${L} Orchid Rollout - Launch of a made-up app.`,
    );
  });

  it("a folder with no description: the label and the name only", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    fileInFolder(f.meeting.id, "Orchid Rollout", "   ");
    const { out } = await prepare(f.meeting.id);
    expect(out.prepared.context).toBe(
      `${MEETING_CONTEXT}\n\n${L} Orchid Rollout`,
    );
  });

  it("an unfiled meeting gets no folder block", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    const { out } = await prepare(f.meeting.id);
    expect(out.prepared.context).toBe(MEETING_CONTEXT);
    expect(out.prepared.context).not.toContain(L);
  });

  it("a filed meeting with no own context gets the block alone", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    getDb()
      .prepare("UPDATE meetings SET context = NULL WHERE id = ?")
      .run(f.meeting.id);
    fileInFolder(f.meeting.id, "Orchid Rollout", null);
    const { out } = await prepare(f.meeting.id);
    expect(out.prepared.context).toBe(`${L} Orchid Rollout`);
  });

  it("the folder text is cut to 500 characters, the meeting context never", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    const longOwn = `${"Long made-up meeting note. ".repeat(60)}End.`;
    getDb()
      .prepare("UPDATE meetings SET context = ? WHERE id = ?")
      .run(longOwn, f.meeting.id);
    fileInFolder(f.meeting.id, "Orchid Rollout", "x".repeat(2000));
    const { out } = await prepare(f.meeting.id);
    const ctx = out.prepared.context as string;
    const [own, block] = ctx.split(`\n\n${L} `);
    expect(own).toBe(longOwn.trim());
    expect(Array.from(block as string)).toHaveLength(FOLDER_CONTEXT_MAX_CHARS);
    expect(block).toBe(
      `Orchid Rollout - ${"x".repeat(FOLDER_CONTEXT_MAX_CHARS - 17)}`,
    );
  });

  it("a renamed folder reaches the next run", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 2 });
    const id = fileInFolder(f.meeting.id, "Orchid Rollout", null);
    const first = await prepare(f.meeting.id);
    expect(first.out.prepared.context).toContain(`${L} Orchid Rollout`);
    getDb()
      .prepare(
        "UPDATE meeting_folders SET name = ?, description = ?, updated_at = ? WHERE id = ?",
      )
      .run("Lantern Migration", "Move of a made-up store.", Date.now(), id);
    const again = await prepare(f.meeting.id);
    expect(again.out.prepared.context).toBe(
      `${MEETING_CONTEXT}\n\n${L} Lantern Migration - Move of a made-up store.`,
    );
    expect(again.out.prepared.context).not.toContain("Orchid");
  });

  it("buildPromptContext: null when both parts are blank; cuts by character, not UTF-16 unit", () => {
    expect(buildPromptContext(null, null)).toBeNull();
    expect(buildPromptContext("  ", null)).toBeNull();
    const emoji = buildPromptContext(null, {
      name: "P",
      description: "\u{1F600}".repeat(600),
    }) as string;
    expect(Array.from(emoji.slice(`${L} `.length))).toHaveLength(
      FOLDER_CONTEXT_MAX_CHARS,
    );
  });
});
