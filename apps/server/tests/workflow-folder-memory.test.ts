// Project memory, folder-scoped retrieval (issue #234,
// specs/local-semantic-search.md 8.3 and 12.4 "#234"). Fictional meetings
// only. The index part is faked here: tests/search-index.test.ts runs the
// real `retrieve` against sqlite-vec.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { readRun } from "../src/lib/llm/record-read.js";
import { MEETING_LLM_NODES } from "../src/lib/meetings/llm-record.js";
import {
  buildFolderMemoryBlock,
  extractFolderTerms,
  FOLDER_MEMORY_BLOCK_MAX_CHARS,
  FOLDER_MEMORY_LABEL,
  type FolderMemoryDeps,
  loadFolderMemory,
  type MemorySnippet,
  mergeTerms,
} from "../src/lib/meetings/workflow/folder-memory.js";
import {
  buildCorrectSystemPrompt,
  buildSummarySingleSystemPrompt,
} from "../src/lib/meetings/workflow/prompts.js";
import { startRun } from "../src/lib/meetings/workflow/runner.js";
import type {
  RetrievalHit,
  RetrieveInput,
} from "../src/lib/search/retrieve.js";
import { loadVocabularyTerms } from "../src/lib/vocabulary.js";
import {
  defaultAnswer,
  runnerHarness,
  runRow,
  waitForNoJob,
} from "./helpers/runner-helpers.js";
import {
  type RecordedRequest,
  resetWorkflowTables,
  seedFixtureMeeting,
  seedTestModel,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const MODEL = "embeddinggemma-2-bf16-text";
const BOTH = ["enhance", "summarize"] as ("enhance" | "summarize")[];
const FOLDER = "folder-aurora";

/** The fictional decision of an earlier Aurora meeting. */
const DECISION =
  "Ana Souza said the Zephyrion launch moves to Friday after the security audit.";
const EARLIER_SUMMARY =
  "Decisions: the launch moves to Friday. Owner: Bruno Lima checks the Kestrel dashboard.";

const isSummary = (r: RecordedRequest) =>
  r.system.startsWith("You summarize meeting transcripts");
const isCorrect = (r: RecordedRequest) =>
  r.system.startsWith("You clean up a speech-to-text meeting transcript");

function seedFolder(): void {
  getDb()
    .prepare(
      "INSERT INTO meeting_folders (id, name, created_at, updated_at) VALUES (?, 'Aurora', 1, 1)",
    )
    .run(FOLDER);
}

function file(meetingId: string): void {
  getDb()
    .prepare("UPDATE meetings SET folder_id = ? WHERE id = ?")
    .run(FOLDER, meetingId);
}

/** One index row of `meetingId` (no vector: the fake retrieve needs none). */
function indexRow(meetingId: string, id: number, kind: string): void {
  getDb()
    .prepare(
      `INSERT INTO meeting_chunks
         (id, meeting_id, ordinal, segment_ids, char_start, char_end, start_ms,
          end_ms, token_estimate, text_hash, model_id, created_at, kind)
       VALUES (?, ?, ?, '[]', 0, NULL, NULL, NULL, 10, 'h', ?, 1, ?)`,
    )
    .run(id, meetingId, id, MODEL, kind);
}

function hit(
  chunkId: number,
  meetingId: string,
  kind: RetrievalHit["kind"],
  score: number,
): RetrievalHit {
  return {
    chunkId,
    meetingId,
    score,
    ordinal: chunkId,
    kind,
    startMs: null,
    endMs: null,
  };
}

/** Fake search: on, with fixed hits and texts. Records each retrieve input. */
function fakeSearch(
  hits: RetrievalHit[],
  texts: Record<number, string>,
  calls: RetrieveInput[] = [],
): FolderMemoryDeps {
  return {
    searchState: () => ({ state: "on", modelId: MODEL }),
    retrieve: async (input) => {
      calls.push(input);
      return { status: "ok", modelId: MODEL, hits };
    },
    hitText: (h, max) => (texts[h.chunkId] ?? "").slice(0, max),
  };
}

beforeEach(() => {
  resetWorkflowTables();
  getDb().exec("DELETE FROM meeting_folders");
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractFolderTerms", () => {
  it("keeps names, mixed-case words and acronyms, not sentence starts, days or plain words", () => {
    const terms = extractFolderTerms([
      DECISION,
      "Then Ana Souza asked about the CRM export. The ecoATM pilot is next.",
      "- Owner: Bruno Lima\n- Due: next Monday",
    ]);
    expect(terms).toEqual([
      "Ana Souza",
      "Zephyrion",
      "CRM",
      "ecoATM",
      "Bruno Lima",
    ]);
  });

  it("dedupes without case, puts the most frequent first and caps the list", () => {
    const terms = extractFolderTerms(
      ["We met Kestrel. Then Kestrel and KESTREL again, and Orion once."],
      1,
    );
    expect(terms).toEqual(["Kestrel"]);
  });

  it("mergeTerms keeps own vocabulary first and skips folder duplicates", () => {
    expect(mergeTerms(["Kestrel"], ["kestrel", "Orion"])).toEqual([
      "Kestrel",
      "Orion",
    ]);
  });
});

describe("buildFolderMemoryBlock", () => {
  it("labels the block, sorts by meeting date and stays under the cap", () => {
    const long = "x".repeat(320);
    const snippets: MemorySnippet[] = Array.from({ length: 10 }, (_, i) => ({
      chunkId: i + 1,
      meetingId: `m${i}`,
      kind: i % 2 === 0 ? "summary" : "transcript",
      at: new Date(2026, 9, 20 - i).getTime(),
      text: long,
    }));
    const built = buildFolderMemoryBlock(snippets);
    expect(built).not.toBeNull();
    const block = built?.block ?? "";
    expect(block.length).toBeLessThanOrEqual(FOLDER_MEMORY_BLOCK_MAX_CHARS);
    const lines = block.split("\n");
    expect(lines[0]).toBe(FOLDER_MEMORY_LABEL);
    expect(lines.length - 1).toBe(built?.used.length);
    expect(built?.used.length).toBeLessThan(10);
    // Highest score first is kept; the lines show the oldest meeting first.
    expect(built?.used[0]?.chunkId).toBe(1);
    const dates = lines.slice(1).map((l) => l.slice(2, 12));
    expect([...dates].sort()).toEqual(dates);
    expect(lines[1]).toMatch(
      /^- \d{4}-\d{2}-\d{2} \(earlier (summary|transcript)\): x+$/,
    );
  });
});

describe("loadFolderMemory", () => {
  it("search off: no retrieve call, no memory", async () => {
    const calls: RetrieveInput[] = [];
    const deps = {
      ...fakeSearch([], {}, calls),
      searchState: () => ({
        state: "off" as const,
        reason: "no_model" as const,
      }),
    };
    expect(
      await loadFolderMemory(
        getDb(),
        { meetingId: "m-new", folderId: FOLDER },
        deps,
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("no index row of another folder meeting: no retrieve call (no embedding)", async () => {
    seedFolder();
    seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-new" });
    file("m-new");
    indexRow("m-new", 1, "transcript");
    const calls: RetrieveInput[] = [];
    expect(
      await loadFolderMemory(
        getDb(),
        { meetingId: "m-new", folderId: FOLDER },
        fakeSearch(
          [hit(1, "m-old", "transcript", 0.9)],
          { 1: DECISION },
          calls,
        ),
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("one call: meeting query, folder scope, self excluded; meta and own hits dropped; ids recorded", async () => {
    seedFolder();
    seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-new" });
    seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-old" });
    file("m-new");
    file("m-old");
    indexRow("m-old", 11, "transcript");
    const calls: RetrieveInput[] = [];
    const memory = await loadFolderMemory(
      getDb(),
      { meetingId: "m-new", folderId: FOLDER },
      fakeSearch(
        [
          hit(13, "m-old", "meta", 0.99),
          hit(11, "m-old", "transcript", 0.9),
          hit(5, "m-new", "transcript", 0.85),
          hit(12, "m-old", "summary", 0.8),
        ],
        { 11: DECISION, 12: EARLIER_SUMMARY, 13: "Aurora weekly sync aurora" },
        calls,
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      query: { kind: "meeting", meetingId: "m-new" },
      scope: { kind: "folder", folderId: FOLDER },
      excludeMeetingIds: ["m-new"],
    });
    expect(memory?.chunkIds).toEqual([11, 12]);
    expect(memory?.meetingIds).toEqual(["m-old"]);
    expect(memory?.modelId).toBe(MODEL);
    expect(memory?.summaryBlock.startsWith(FOLDER_MEMORY_LABEL)).toBe(true);
    expect(memory?.summaryBlock).toContain(DECISION);
    expect(memory?.summaryBlock).toContain("(earlier summary)");
    expect(memory?.summaryBlock).not.toContain("weekly sync");
    expect(memory?.terms).toContain("Zephyrion");
    expect(memory?.terms).toContain("Bruno Lima");
  });

  it("leaves out later meetings of the folder: no hit, no index check, excluded in the call", async () => {
    seedFolder();
    for (const [id, at] of [
      ["m-old", 1_000],
      ["m-new", 2_000],
      ["m-later", 3_000],
    ] as const) {
      seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: id });
      file(id);
      getDb()
        .prepare("UPDATE meetings SET started_at = ? WHERE id = ?")
        .run(at, id);
    }
    // Only the later meeting has index rows: no retrieve call.
    indexRow("m-later", 21, "transcript");
    const none: RetrieveInput[] = [];
    expect(
      await loadFolderMemory(
        getDb(),
        { meetingId: "m-new", folderId: FOLDER },
        fakeSearch(
          [hit(21, "m-later", "transcript", 0.9)],
          { 21: DECISION },
          none,
        ),
      ),
    ).toBeNull();
    expect(none).toHaveLength(0);

    indexRow("m-old", 11, "transcript");
    const calls: RetrieveInput[] = [];
    const memory = await loadFolderMemory(
      getDb(),
      { meetingId: "m-new", folderId: FOLDER },
      fakeSearch(
        [
          hit(21, "m-later", "transcript", 0.95),
          hit(11, "m-old", "transcript", 0.9),
        ],
        { 21: "Later text about Orion.", 11: DECISION },
        calls,
      ),
    );
    expect(calls[0]?.excludeMeetingIds).toEqual(["m-new", "m-later"]);
    expect(memory?.meetingIds).toEqual(["m-old"]);
    expect(memory?.chunkIds).toEqual([11]);
    expect(memory?.summaryBlock).not.toContain("Orion");
  });

  it("a retrieve error or a throw gives no memory and no throw", async () => {
    seedFolder();
    seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-new" });
    seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-old" });
    file("m-new");
    file("m-old");
    indexRow("m-old", 11, "transcript");
    const base = fakeSearch([], {});
    expect(
      await loadFolderMemory(
        getDb(),
        { meetingId: "m-new", folderId: FOLDER },
        {
          ...base,
          retrieve: async () => ({
            status: "error",
            kind: "worker_unavailable",
          }),
        },
      ),
    ).toBeNull();
    expect(
      await loadFolderMemory(
        getDb(),
        { meetingId: "m-new", folderId: FOLDER },
        {
          ...base,
          retrieve: async () => {
            throw new Error("boom");
          },
        },
      ),
    ).toBeNull();
  });
});

describe("the workflow with project memory", () => {
  /** A filed meeting "m-new" and an earlier meeting "m-old" in Aurora. */
  function seedAurora() {
    seedFolder();
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 2,
      meetingId: "m-new",
    });
    seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-old" });
    file("m-new");
    file("m-old");
    indexRow("m-old", 11, "transcript");
    return f;
  }

  async function run(
    meetingId: string,
    deps: Parameters<typeof runnerHarness>[0],
  ) {
    const h = runnerHarness(deps);
    const started = startRun(
      { meetingId, stages: BOTH, trigger: "button" },
      h.deps,
    );
    if (!started.ok) throw new Error("start failed");
    await waitForNoJob(meetingId);
    return { h, runId: started.runId };
  }

  it("Summary gets the labeled block; Enhance gets terms only, never chunk text; the run record holds the ids", async () => {
    seedAurora();
    const fake = fakeSearch(
      [hit(11, "m-old", "transcript", 0.9), hit(12, "m-old", "summary", 0.8)],
      { 11: DECISION, 12: EARLIER_SUMMARY },
    );
    const { h, runId } = await run("m-new", {
      answer: defaultAnswer,
      deps: {
        loadFolderMemory: (db, input) => loadFolderMemory(db, input, fake),
      },
    });
    expect(runRow(runId).status).toBe("succeeded");

    const summary = h.requests.filter(isSummary);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.system).toContain(FOLDER_MEMORY_LABEL);
    expect(summary[0]?.system).toContain(DECISION);
    // Never mixed into the transcript.
    expect(summary[0]?.user).not.toContain(DECISION);
    expect(summary[0]?.user).not.toContain(FOLDER_MEMORY_LABEL);

    const correct = h.requests.filter(isCorrect);
    expect(correct.length).toBeGreaterThan(0);
    for (const r of correct) {
      const text = `${r.system}\n${r.user}`;
      expect(r.system).toContain("Zephyrion");
      expect(r.system).toContain("Bruno Lima");
      expect(text).not.toContain(FOLDER_MEMORY_LABEL);
      // No run of 4 words of a retrieved chunk reaches the correct prompt.
      for (const source of [DECISION, EARLIER_SUMMARY]) {
        const words = source.split(/\s+/);
        for (let i = 0; i + 4 <= words.length; i++) {
          expect(text).not.toContain(words.slice(i, i + 4).join(" "));
        }
      }
    }
    // Other nodes get no memory block.
    for (const r of h.requests.filter((x) => !isSummary(x))) {
      expect(r.system).not.toContain(FOLDER_MEMORY_LABEL);
    }

    expect(JSON.parse(runRow(runId).result_json ?? "{}").retrieval).toEqual({
      modelId: MODEL,
      meetingIds: ["m-old"],
      chunkIds: [11, 12],
    });
    const info = readRun(
      getDb(),
      { scope: "meeting", scopeId: "m-new" },
      runId,
      MEETING_LLM_NODES,
    );
    expect(info?.retrieval).toEqual({
      modelId: MODEL,
      meetingIds: ["m-old"],
      chunkIds: [11, 12],
    });
    expect(info?.correctedCount).not.toBeNull();
  });

  it("search off: no retrieval, no error, prompts equal the prompts without the hook", async () => {
    seedAurora();
    const { h, runId } = await run("m-new", { answer: defaultAnswer });
    expect(runRow(runId).status).toBe("succeeded");
    expect(runRow(runId).error_kind).toBeNull();
    const summary = h.requests.find(isSummary);
    expect(summary?.system).toBe(
      buildSummarySingleSystemPrompt({
        language: "en",
        instructions: "",
        context: (
          getDb()
            .prepare("SELECT context FROM meetings WHERE id = 'm-new'")
            .get() as {
            context: string | null;
          }
        ).context,
      }),
    );
    for (const r of h.requests.filter(isCorrect)) {
      expect(r.system).toBe(
        buildCorrectSystemPrompt({
          language: "en",
          vocabTerms: loadVocabularyTerms(),
        }),
      );
    }
    expect(
      JSON.parse(runRow(runId).result_json ?? "{}").retrieval,
    ).toBeUndefined();
  });

  it("an unfiled meeting never calls the loader", async () => {
    seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-loose" });
    const loader = vi.fn(async () => null);
    const { h, runId } = await run("m-loose", {
      answer: defaultAnswer,
      deps: { loadFolderMemory: loader },
    });
    expect(runRow(runId).status).toBe("succeeded");
    expect(loader).not.toHaveBeenCalled();
    expect(h.requests.some((r) => r.system.includes(FOLDER_MEMORY_LABEL))).toBe(
      false,
    );
  });
});
