// The graph (specs/meeting-enhance-agentic.md 3.2, 10.8): GR1 to GR3, U6, GR5,
// GR7, GR14, GR18, GR19, GR21 (a) (no key and a plain Error), GR25, the
// stability test and "no attendee in any request" (10.5.4). The real graph, the
// real saver on a SQLite file, and the real gateway over a scripted model or a
// stubbed `fetch` run.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { createLlmRecorder } from "../src/lib/llm/recorder.js";
import { stripTracingEnv } from "../src/lib/llm/workflow/env-guard.js";
import { createRunContextRegistry } from "../src/lib/llm/workflow/run-context-registry.js";
import { fixNameSpelling } from "../src/lib/meetings/speaker-spelling.js";
import {
  productionDeps,
  type RunContext,
} from "../src/lib/meetings/workflow/context.js";
import { buildGraph } from "../src/lib/meetings/workflow/graph.js";
import {
  deriveRunStatus,
  type FinalState,
} from "../src/lib/meetings/workflow/types.js";
import { guardNode, runStep } from "../src/lib/meetings/workflow/unit.js";
import { okReply, reply, type ScriptStep } from "./helpers/fake-model.js";
import {
  chatReply,
  errorReply,
  type FakeRecorder,
  isTagsRequest,
  makeFakeRecorder,
  makeTestDeps,
  makeTestRunContext,
  type RecordedRequest,
  resetWorkflowTables,
  restoreFetch,
  runScriptedGraph,
  seedFixtureMeeting,
  seedTestModel,
  sizeFixtureSegments,
  stubFetch,
  systemOf,
  userOf,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

// `verifyEvidence` calls this function for a passed name. A test makes it throw once.
vi.mock("../src/lib/meetings/speaker-spelling.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/lib/meetings/speaker-spelling.js")
    >();
  return { ...actual, fixNameSpelling: vi.fn(actual.fixNameSpelling) };
});

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../src");
const noEnd = {
  cancelled: false,
  fault: "none" as const,
  hasCheckpoint: false,
};

const isIdentify = (r: RecordedRequest) => r.system.includes("diarized labels");
const NONE = okReply('{"corrections":[]}');
const EMPTY_SPEAKERS = okReply('{"speakers":[]}');
const isSummary = (r: RecordedRequest) =>
  r.system.includes("You summarize meeting transcripts");
const SUMMARY = okReply(
  JSON.stringify({
    overview: "A planning call.",
    keyPoints: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
  }),
);
const corr = (...pairs: [string, string][]) =>
  okReply(
    JSON.stringify({ corrections: pairs.map(([id, text]) => ({ id, text })) }),
  );

function apiError(status: number): APICallError {
  return new APICallError({
    message: `HTTP ${status}`,
    url: "http://127.0.0.1:1/v1/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    isRetryable: status >= 500,
  });
}

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreFetch();
});

// --- GR1 to GR3 -----------------------------------------------------------------

describe("GR1: the graph is Figure 1", () => {
  it("names exactly the seven nodes", () => {
    const { deps } = makeTestDeps();
    const drawn = buildGraph(deps).getGraph();
    const names = Object.keys(drawn.nodes).filter((n) => !n.startsWith("__"));
    expect(names.sort()).toEqual(
      [
        "correctChunk",
        "identifySpeakers",
        "prepare",
        "save",
        "suggestTags",
        "summarize",
        "verifyEvidence",
      ].sort(),
    );
    const mermaid = drawn.drawMermaid();
    for (const n of names) expect(mermaid).toContain(n);
  });
});

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** Static value imports of a file: `import x from`, `export * from`, `import "x"`. Not `import type`, not `import(`. */
function staticImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  const re =
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) continue; // a type-only import is erased
    out.push(m[2] as string);
  }
  return out;
}

describe("GR2: where LangGraph is imported", () => {
  const files = tsFiles(SRC);
  const importsLangchain = (f: string) =>
    staticImports(f).some((s) => s.startsWith("@langchain/")) ||
    /import\(\s*["']@langchain\//.test(readFileSync(f, "utf8"));

  it("only files in the workflow folders import @langchain/*", () => {
    const offenders = files
      .filter(importsLangchain)
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders.length).toBeGreaterThan(0);
    for (const f of offenders) {
      expect(
        f.startsWith("lib/meetings/workflow/") ||
          f.startsWith("lib/llm/workflow/"),
      ).toBe(true);
    }
  });

  it("the nodes, the unit helpers and the context import graph.ts and state.ts as types only", () => {
    const guarded = files.filter((f) =>
      /lib\/meetings\/workflow\/(nodes\/|unit\.ts|context\.ts|types\.ts|prompts\.ts|summary-pure\.ts|chunking\.ts)/.test(
        f,
      ),
    );
    expect(guarded.length).toBeGreaterThan(5);
    for (const f of guarded) {
      for (const spec of staticImports(f)) {
        expect(spec, f).not.toMatch(/(^|\/)(graph|state)\.js$/);
      }
    }
  });

  it("no static import path from src/index.ts reaches a module that imports @langchain/*", () => {
    const seen = new Set<string>();
    const queue = [join(SRC, "index.ts")];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of staticImports(file)) {
        if (!spec.startsWith(".")) continue;
        const base = resolve(dirname(file), spec.replace(/\.js$/, ""));
        for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
          if (existsSync(candidate)) {
            queue.push(candidate);
            break;
          }
        }
      }
    }
    expect(seen.size).toBeGreaterThan(20);
    const reached = [...seen].filter(importsLangchain);
    expect(reached).toEqual([]);
  });

  it("layer rule: no file under lib/llm imports a module of lib/meetings", () => {
    const llm = files.filter((f) => f.startsWith(`${join(SRC, "lib/llm")}/`));
    expect(llm.length).toBeGreaterThan(8);
    for (const f of llm) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(
        /lib\/meetings|meetings\/workflow|\.\.\/meetings\//,
      );
    }
  });
});

describe("GR3 and U6: the tracing variables", () => {
  const NAMES = [
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING_V2",
    "LANGSMITH_TRACING",
    "LANGCHAIN_TRACING",
  ];

  afterEach(() => {
    for (const n of NAMES) delete process.env[n];
    vi.doUnmock("../src/lib/llm/workflow/env-guard.js");
    vi.doUnmock("../src/lib/meetings/workflow/graph.js");
  });

  it("(a) stripTracingEnv removes all four variables", () => {
    for (const n of NAMES) process.env[n] = "true";
    stripTracingEnv();
    for (const n of NAMES) expect(process.env[n]).toBeUndefined();
  });

  it("(b) loadGraph strips the variables before the graph module loads", async () => {
    for (const n of NAMES) process.env[n] = "true";
    vi.resetModules();
    const order: string[] = [];
    let seenAtLoad: (string | undefined)[] = [];
    vi.doMock("../src/lib/llm/workflow/env-guard.js", async (orig) => {
      const real =
        await orig<typeof import("../src/lib/llm/workflow/env-guard.js")>();
      return {
        ...real,
        stripTracingEnv: () => {
          order.push("strip");
          real.stripTracingEnv();
        },
      };
    });
    vi.doMock("../src/lib/meetings/workflow/graph.js", () => {
      order.push("graph module loaded");
      seenAtLoad = NAMES.map((n) => process.env[n]);
      return { buildGraph: () => ({ marker: true }) };
    });
    const { loadGraph } = await import(
      "../src/lib/meetings/workflow/load-graph.js"
    );
    // Nothing loads until the first run.
    expect(order).toEqual([]);
    const graph = await loadGraph(makeTestDeps().deps);
    expect(order).toEqual(["strip", "graph module loaded"]);
    expect(seenAtLoad).toEqual([undefined, undefined, undefined, undefined]);
    expect(graph).toEqual({ marker: true });
  });

  it("U6: the installed @langchain/core knows these four names and no other tracing variable", () => {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@langchain/core/package.json");
    const file = join(dirname(pkg), "dist/utils/callbacks.js");
    const text = readFileSync(file, "utf8");
    const lines = text
      .split("\n")
      .filter((l) => /LANGSMITH_TRACING|LANGCHAIN_TRACING/.test(l));
    const found = new Set(
      text.match(/(?:LANGSMITH|LANGCHAIN)_TRACING(?:_V2)?/g),
    );
    expect([...found].sort()).toEqual([...NAMES].sort());
    expect(lines.length).toBeGreaterThan(0);
  });
});

// --- GR5, GR7 -------------------------------------------------------------------

describe("GR5: one failed chunk", () => {
  it("chunk 2 ends content_filter: the run is partial, the chunk keeps its raw text, identifySpeakers still runs", async () => {
    const f = seedFixtureMeeting({
      chunks: 4,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-gr5",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const chunk2 = new Set(f.segmentIdsByChunk[2]);
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: (req) => {
        if (isIdentify(req)) {
          return okReply(
            JSON.stringify({
              speakers: [
                {
                  segmentId: intro?.id,
                  quote: "I am Morgan Ellis",
                  label: intro?.speakerLabel,
                  kind: "name",
                  name: "Morgan Ellis",
                },
              ],
            }),
          );
        }
        const first = /\[([^\]]+)\]/.exec(req.user)?.[1] ?? "";
        return chunk2.has(first)
          ? reply("content-filter", "content_filter", "")
          : corr([first, "Fixed."]);
      },
    });
    expect(r.finalState.corrections.map((c) => c.status)).toEqual([
      "ok",
      "ok",
      "failed",
      "ok",
    ]);
    expect(r.finalState.identify?.status).toBe("ok");
    expect(r.finalState.verify?.suggestions).toHaveLength(1);
    expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe("partial");
    // The failed chunk keeps its raw text: no enhanced_text was written for it.
    for (const id of f.segmentIdsByChunk[2] ?? []) {
      const row = getDb()
        .prepare("SELECT enhanced_text FROM meeting_segments WHERE id = ?")
        .get(id) as { enhanced_text: string | null };
      expect(row.enhanced_text).toBeNull();
    }
  });

  it("#163 replay: chunk 0 ends length; the speaker suggestions survive", async () => {
    const f = seedFixtureMeeting({
      chunks: 3,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-163",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    const chunk0 = new Set(f.segmentIdsByChunk[0]);
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: (req) => {
        if (isIdentify(req)) {
          return okReply(
            JSON.stringify({
              speakers: [
                {
                  segmentId: intro?.id,
                  quote: "I am Morgan Ellis",
                  label: intro?.speakerLabel,
                  kind: "name",
                  name: "Morgan Ellis",
                },
              ],
            }),
          );
        }
        const first = /\[([^\]]+)\]/.exec(req.user)?.[1] ?? "";
        return chunk0.has(first)
          ? reply("length", "length", '{"corrections":[')
          : NONE;
      },
    });
    expect(r.finalState.corrections[0]?.status).toBe("failed");
    expect(r.finalState.identify?.status).toBe("ok");
    expect(r.finalState.saved?.sw2).toBe("ok");
    const row = getDb()
      .prepare(
        "SELECT suggested_name FROM meeting_speakers WHERE meeting_id = ? AND speaker_label = ?",
      )
      .get(f.meeting.id, intro?.speakerLabel as string) as {
      suggested_name: string;
    };
    expect(row.suggested_name).toBe("Morgan Ellis");
  });
});

describe("GR7: total requests for the whole graph, with the real retry settings (G5)", () => {
  /** One chunk and one speaker: the only node that calls the model is correctChunk. */
  async function wire(handler: () => Response) {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: `m-gr7-${Math.random()}`,
    });
    const all = stubFetch(handler);
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
    });
    // Count the correctChunk requests. `suggestTags` runs after `save` and
    // gets the same fault; its requests are not part of this count.
    const seen = all.filter((q) => !isTagsRequest({ system: systemOf(q) }));
    return { seen, r };
  }

  it("a persistent 503 is 2 requests", async () => {
    const { seen, r } = await wire(() => errorReply(503));
    expect(seen).toHaveLength(2);
    expect(r.finalState.corrections[0]?.units[0]?.failure?.kind).toBe(
      "provider_unavailable",
    );
  });

  it("content_filter is 1 request", async () => {
    const { seen } = await wire(() =>
      chatReply("", { finish: "content_filter" }),
    );
    expect(seen).toHaveLength(1);
  });

  it("HTTP 401 is 1 request", async () => {
    const { seen, r } = await wire(() => errorReply(401));
    expect(seen).toHaveLength(1);
    expect(r.finalState.corrections[0]?.units[0]?.failure?.kind).toBe(
      "provider_auth",
    );
  });

  it("invalid JSON is 2 requests", async () => {
    const { seen } = await wire(() => chatReply('{"corrections":["}'));
    expect(seen).toHaveLength(2);
  });
});

// --- GR14 -----------------------------------------------------------------------

describe("GR14: checkpoint size", () => {
  it("no checkpoint row holds the system prompt, and a row stays near the transcript size", async () => {
    const f = seedFixtureMeeting({
      chunks: 6,
      speakers: 1,
      meetingId: "m-gr14",
    });
    sizeFixtureSegments(getDb(), f, 290);
    const transcriptBytes = (
      getDb()
        .prepare(
          "SELECT sum(length(text)) AS n FROM meeting_segments WHERE meeting_id = ?",
        )
        .get(f.meeting.id) as { n: number }
    ).n;
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: [NONE],
    });
    expect(r.finalState.prepared?.chunks.length).toBeGreaterThan(5);
    const rows = getDb()
      .prepare(
        "SELECT length(checkpoint) AS bytes, instr(checkpoint, CAST('You clean up a speech-to-text' AS BLOB)) AS sys FROM llm_checkpoints WHERE thread_id = ?",
      )
      .all(r.ctx.runId) as { bytes: number; sys: number }[];
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((x) => x.sys === 0)).toBe(true);
    const writes = getDb()
      .prepare(
        "SELECT count(*) AS n FROM llm_checkpoint_writes WHERE thread_id = ? AND instr(value, CAST('You clean up a speech-to-text' AS BLOB)) > 0",
      )
      .get(r.ctx.runId) as { n: number };
    expect(writes.n).toBe(0);
    const biggest = Math.max(...rows.map((x) => x.bytes));
    // `prepared` once and the fan-out payloads once: about twice the text, never 40 times.
    expect(biggest).toBeGreaterThan(transcriptBytes);
    expect(biggest).toBeLessThan(4 * transcriptBytes);
  });
});

// --- GR18, GR19, GR21 ------------------------------------------------------------

describe("GR18: a run-wide stop", () => {
  it("the first request gets HTTP 401: 1 request in all, the other units are skipped, save runs, the run is failed", async () => {
    const f = seedFixtureMeeting({
      chunks: 6,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-gr18",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: () => apiError(401),
    });
    expect(r.requests).toHaveLength(1);
    const statuses = r.finalState.corrections.map((c) => c.status);
    expect(statuses.filter((s) => s === "failed")).toHaveLength(1);
    expect(statuses.filter((s) => s === "skipped").length).toBe(
      statuses.length - 1,
    );
    // Each skipped chunk row says why (issue #300): the run stopped.
    for (const c of r.finalState.corrections) {
      if (c.status !== "skipped") continue;
      expect(
        (deps.recorder as FakeRecorder).steps.get(`chunk:${c.chunkIndex}`),
      ).toMatchObject({
        status: "skipped",
        errorKind: "skipped",
        errorDetail: "stopped",
      });
    }
    // The router sends a stopped run from correctChunk straight to save.
    expect(r.finalState.identify).toBeNull();
    expect((deps.recorder as FakeRecorder).steps.has("candidates")).toBe(false);
    expect(r.ctx.startedNodes).not.toContain("identifySpeakers");
    expect(r.finalState.verify).toBeNull();
    expect(r.finalState.saved).toMatchObject({
      sw1: "none",
      sw2: "none",
      wroteAny: false,
    });
    expect(r.ctx.stoppedKind).toBe("provider_auth");
    expect(r.ctx.startedNodes.at(-1)).toBe("save");
    expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe("failed");
  });

  it("three schema failures in a row stop the node (BREAKER_N)", async () => {
    const f = seedFixtureMeeting({
      chunks: 8,
      speakers: 1,
      meetingId: "m-breaker",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: [okReply('{"corrections":["}')],
    });
    const statuses = r.finalState.corrections.map((c) => c.status);
    expect(statuses).toHaveLength(8);
    expect(
      statuses.filter((s) => s === "failed").length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      statuses.filter((s) => s === "skipped").length,
    ).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === "failed" || s === "skipped")).toBe(true);
    // Every chunk would have sent 2 requests; the breaker saved some.
    expect(r.requests.length).toBeLessThan(16);
    expect(r.ctx.stoppedKind).toBe("schema");
  });
});

describe("GR19: two units, one node run", () => {
  it("chunks 1 and 2 each get one retryable error: each is retried once, none escapes, the run succeeds", async () => {
    const f = seedFixtureMeeting({
      chunks: 3,
      speakers: 1,
      meetingId: "m-gr19",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const failedOnce = new Set<string>();
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: (req): ScriptStep => {
        const first = /\[([^\]]+)\]/.exec(req.user)?.[1] ?? "";
        const idx = f.segmentIdsByChunk.findIndex((ids) => ids.includes(first));
        if ((idx === 1 || idx === 2) && !failedOnce.has(first)) {
          failedOnce.add(first);
          return apiError(503);
        }
        return NONE;
      },
    });
    expect(r.requests).toHaveLength(5); // 3 chunks and 2 retries
    expect(r.finalState.corrections.map((c) => c.status)).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
    expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe(
      "succeeded",
    );
  });
});

describe("GR21 (a): faults", () => {
  it("no API key: model_unavailable, 0 requests, the other units are skipped, the run is failed", async () => {
    getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
    getDb().exec("DELETE FROM api_keys");
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES ('openai', 'gpt-4o-mini', 'gpt-4o-mini', 'llm', 1)",
      )
      .run();
    const f = seedFixtureMeeting({
      chunks: 6,
      speakers: 1,
      meetingId: "m-nokey",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const seen = stubFetch(() => chatReply('{"corrections":[]}'));
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
    });
    expect(seen).toHaveLength(0);
    const statuses = r.finalState.corrections.map((c) => c.status);
    expect(statuses).toHaveLength(6);
    // The first super-step starts WORKFLOW_FANOUT_CAP tasks at once. Each fails
    // before the lane, so none sends a request. Units that start later are skipped.
    const failedCount = statuses.filter((s) => s === "failed").length;
    expect(failedCount).toBeGreaterThanOrEqual(1);
    expect(failedCount).toBeLessThanOrEqual(3);
    expect(statuses.slice(3).every((s) => s === "skipped")).toBe(true);
    const failed = r.finalState.corrections.find((c) => c.status === "failed");
    expect(failed?.units[0]?.failure?.kind).toBe("model_unavailable");
    expect(r.ctx.stoppedKind).toBe("model_unavailable");
    expect(r.finalState.saved?.wroteAny).toBe(false);
    expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe("failed");
  });

  it("a plain Error in one correctChunk task is internal; the graph reaches save; the run is partial", async () => {
    const f = seedFixtureMeeting({
      chunks: 3,
      speakers: 1,
      meetingId: "m-plain-chunk",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const model = seedTestModel();
    expect(model).toContain("Qwen3.8-27B");
    const { callStructured } = await import("../src/lib/llm/gateway.js");
    let calls = 0;
    const recorder = makeFakeRecorder();
    const { deps } = makeTestDeps({
      recorder,
      callStructured: async (input) => {
        calls += 1;
        if (calls === 2) throw new TypeError("boom");
        return callStructured(input);
      },
    });
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: [corr([f.segments[0]?.id as string, "Fixed."])],
    });
    const statuses = r.finalState.corrections.map((c) => c.status).sort();
    expect(statuses).toEqual(["failed", "ok", "ok"]);
    const failed = r.finalState.corrections.find((c) => c.status === "failed");
    expect(failed?.units[0]?.failure).toMatchObject({
      kind: "internal",
      node: "correctChunk",
    });
    expect(failed?.units[0]?.failure?.message).toContain("boom");
    expect(r.finalState.saved?.wroteAny).toBe(true);
    expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe("partial");
    expect(recorder.steps.get(`chunk:${failed?.chunkIndex}`)).toMatchObject({
      status: "failed",
      errorKind: "internal",
    });
  });

  it("a plain Error in verifyEvidence is internal; the graph reaches save; the run is partial", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-plain-verify",
    });
    const intro = f.segments.find((s) => s.text.includes("Morgan Ellis"));
    vi.mocked(fixNameSpelling).mockImplementationOnce(() => {
      throw new Error("spelling table broke");
    });
    const recorder = makeFakeRecorder();
    const { deps } = makeTestDeps({ recorder });
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: (req) =>
        isIdentify(req)
          ? okReply(
              JSON.stringify({
                speakers: [
                  {
                    segmentId: intro?.id,
                    quote: "I am Morgan Ellis",
                    label: intro?.speakerLabel,
                    kind: "name",
                    name: "Morgan Ellis",
                  },
                ],
              }),
            )
          : corr([f.segments[1]?.id as string, "Fixed."]),
    });
    expect(r.finalState.verify).toMatchObject({
      status: "failed",
      verdicts: [],
      suggestions: [],
    });
    expect(r.finalState.verify?.failure).toMatchObject({
      kind: "internal",
      node: "verifyEvidence",
    });
    // save writes no suggestion, but the correction is saved.
    expect(r.finalState.saved).toMatchObject({ sw1: "ok", sw2: "none" });
    expect(deriveRunStatus(r.finalState as FinalState, noEnd)).toBe("partial");
    expect(recorder.steps.get("verify")).toMatchObject({
      status: "failed",
      errorKind: "internal",
    });
  });
});

// --- GR25 -----------------------------------------------------------------------

describe("GR25: step rows and the run context", () => {
  it("(a) each node run opens and closes its step row; seq follows the start order; no row named summarize", async () => {
    const f = seedFixtureMeeting({
      chunks: 3,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-gr25",
    });
    sizeFixtureSegments(getDb(), f, 300);
    const recorder = makeFakeRecorder();
    const { deps } = makeTestDeps({ recorder });
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance", "summarize"],
      script: (req) =>
        isIdentify(req) ? EMPTY_SPEAKERS : isSummary(req) ? SUMMARY : NONE,
    });
    const steps = [...recorder.steps.entries()].map(([key, v]) => ({
      key,
      ...v,
    }));
    expect(steps.map((s) => s.key).sort()).toEqual(
      [
        "candidates",
        "chunk:0",
        "chunk:1",
        "chunk:2",
        "prepare",
        "save",
        "single",
        "tags",
        "verify",
      ].sort(),
    );
    expect(steps.every((s) => s.status === "succeeded")).toBe(true);
    expect(steps.some((s) => s.key === "summarize")).toBe(false);
    const bySeq = [...steps].sort((a, b) => a.seq - b.seq).map((s) => s.key);
    expect(bySeq[0]).toBe("prepare");
    expect(bySeq.slice(1, 4).sort()).toEqual(["chunk:0", "chunk:1", "chunk:2"]);
    expect(bySeq.slice(4)).toEqual([
      "candidates",
      "verify",
      "single",
      "save",
      "tags",
    ]);
    // Every call of the three chunks counted an attempt on its step row.
    expect(steps.find((s) => s.key === "chunk:0")?.attempts).toBe(1);
    // (b) onNodeStart: once for each node run, in node order.
    expect(r.ctx.startedNodes[0]).toBe("prepare");
    expect(r.ctx.startedNodes.filter((n) => n === "correctChunk")).toHaveLength(
      3,
    );
    expect(r.ctx.startedNodes.slice(4)).toEqual([
      "identifySpeakers",
      "verifyEvidence",
      "summarize",
      "save",
      "suggestTags",
    ]);
    expect(r.finalState.summary?.status).toBe("ok");
  });

  it("a node that throws a plain Error closes its row failed with kind internal; for prepare the error is rethrown", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-prepare-throw",
    });
    const recorder = makeFakeRecorder();
    const { deps } = makeTestDeps({
      recorder,
      loadTranscript: () => {
        throw new TypeError("loader broke");
      },
    });
    await expect(
      runScriptedGraph({
        deps,
        meetingId: f.meeting.id,
        stages: ["enhance"],
        script: [NONE],
      }),
    ).rejects.toThrow("loader broke");
    expect(recorder.steps.get("prepare")).toMatchObject({
      status: "failed",
      errorKind: "internal",
    });
  });

  it("(b) a throw in onNodeStart is ignored", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-hook",
    });
    const ctx = makeTestRunContext({ meetingId: f.meeting.id });
    const orig = ctx.onNodeStart;
    ctx.onNodeStart = (node) => {
      orig(node);
      throw new Error("hook broke");
    };
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: [NONE],
      ctx,
    });
    expect(r.finalState.saved?.sw1).toBe("ok");
    expect(ctx.startedNodes).toContain("save");
  });

  it("(c) guardNode twice for one key, as a resume does: one row, seq and attempts kept", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-resume-row",
    });
    const recorder = createLlmRecorder(getDb());
    createLlmRecorder(getDb()).startRun({
      id: "run-rs",
      scope: "meeting",
      scopeId: f.meeting.id,
      kind: "enhance",
      startedBy: "button",
      graphVersion: 1,
      startedAt: 1,
    });
    const { deps, contexts } = makeTestDeps({ recorder });
    contexts.register(
      makeTestRunContext({ runId: "run-rs", meetingId: f.meeting.id }),
    );
    const node = guardNode<{ runId: string }, { ok: boolean }>(
      deps,
      {
        id: "verifyEvidence",
        stepKey: () => "verify",
        failed: null,
        outcome: () => ({ status: "ok", failure: null }),
      },
      async () => ({ ok: true }),
    );
    const stepRows = () =>
      getDb()
        .prepare(
          "SELECT status, seq, attempts FROM llm_run_steps WHERE run_id = 'run-rs'",
        )
        .all();
    await node({ runId: "run-rs" });
    recorder.startAttempt({ runId: "run-rs", stepKey: "verify" });
    const first = stepRows();
    expect(first).toEqual([{ status: "succeeded", seq: 1, attempts: 1 }]);
    await node({ runId: "run-rs" });
    expect(stepRows()).toEqual(first);
  });

  it("runStep opens the row, runs the body and closes it; a throw closes it failed with internal and rethrows", async () => {
    const recorder = makeFakeRecorder();
    const { deps } = makeTestDeps({ recorder });
    const out = await runStep(
      deps,
      "r",
      { key: "single", node: "summarize" },
      async () => 5,
      () => ({ status: "ok", failure: null }),
    );
    expect(out).toBe(5);
    expect(recorder.steps.get("single")?.status).toBe("succeeded");
    await expect(
      runStep(
        deps,
        "r",
        { key: "map:0", node: "summarize" },
        async () => {
          throw new Error("x");
        },
        () => ({ status: "ok", failure: null }),
      ),
    ).rejects.toThrow("x");
    expect(recorder.steps.get("map:0")).toMatchObject({
      status: "failed",
      errorKind: "internal",
    });
  });

  it("(d) createRunContextRegistry: get of an unknown run throws, a second register throws, drop removes, size follows", () => {
    const registry = createRunContextRegistry<RunContext>();
    const ctx = makeTestRunContext({ runId: "a" });
    expect(() => registry.get("a")).toThrow();
    registry.register(ctx);
    expect(registry.size()).toBe(1);
    expect(registry.get("a")).toBe(ctx);
    expect(() => registry.register(ctx)).toThrow();
    registry.drop("a");
    expect(registry.size()).toBe(0);
    expect(() => registry.get("a")).toThrow();
  });

  it("productionDeps().getRunContext throws for an unregistered run", () => {
    expect(() => productionDeps().getRunContext("nobody")).toThrow();
  });
});

describe("edges", () => {
  it("a summarize-only run goes prepare, summarize, save and sends one summary call", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-sum-only",
    });
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["summarize"],
      script: [SUMMARY],
    });
    expect(r.requests).toHaveLength(1);
    expect(r.ctx.startedNodes).toEqual(["prepare", "summarize", "save"]);
    expect(r.finalState.corrections).toEqual([]);
    expect(r.finalState.identify).toBeNull();
    expect(r.finalState.summary?.status).toBe("ok");
    expect(r.finalState.saved?.wroteAny).toBe(true);
  });

  it("a cancel before the graph starts sends the run from prepare straight to save", async () => {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-cancel-early",
    });
    const ctx = makeTestRunContext({ meetingId: f.meeting.id });
    ctx.cancel();
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: [NONE],
      ctx,
    });
    expect(r.requests).toHaveLength(0);
    expect(r.ctx.startedNodes).toEqual(["prepare", "save"]);
    expect(
      deriveRunStatus(r.finalState as FinalState, {
        ...noEnd,
        cancelled: true,
      }),
    ).toBe("cancelled");
  });

  it("the errorHandler backstop records an internal failure and goes to save when guardNode itself fails", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 3,
      selfIntroduction: true,
      meetingId: "m-backstop",
    });
    const recorder = makeFakeRecorder();
    const startStep = recorder.startStep.bind(recorder);
    recorder.startStep = (runId, step) => {
      // A fault outside the try of guardNode: the step row cannot open.
      if (step.key === "candidates") throw new Error("recorder broke");
      startStep(runId, step);
    };
    const { deps } = makeTestDeps({ recorder });
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: (req) => (isIdentify(req) ? EMPTY_SPEAKERS : NONE),
    });
    expect(r.finalState.identify).toMatchObject({ status: "failed" });
    expect(r.finalState.identify?.failures[0]).toMatchObject({
      kind: "internal",
      node: "identifySpeakers",
    });
    expect(r.finalState.verify).toBeNull(); // the handler went straight to save
    expect(r.finalState.saved).not.toBeNull();
  });
});

// --- 10.5.4: stability and no attendee -------------------------------------------

describe("10.5.4: the wire", () => {
  async function wireRun(id: string, withCalendar: boolean) {
    const f = seedFixtureMeeting({
      chunks: 2,
      speakers: 3,
      selfIntroduction: true,
      meetingId: id,
      withCalendar,
    });
    const seen = stubFetch((req) =>
      systemOf(req).includes("diarized labels")
        ? chatReply('{"speakers":[]}')
        : isTagsRequest({ system: systemOf(req) })
          ? chatReply('{"tags":[]}')
          : chatReply('{"corrections":[]}'),
    );
    const { deps } = makeTestDeps();
    await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
    });
    return seen;
  }

  it("two different meetings put the same JSON schemas on the wire, except the per-call enum; every request is strict", async () => {
    const a = await wireRun("m-stab-a", true);
    vi.restoreAllMocks();
    restoreFetch();
    resetWorkflowTables();
    seedTestModel();
    const b = await wireRun("m-stab-b", false);
    // The id and label enums change with each call (owner decision
    // 2026-10-20). The rest of the schema stays the same.
    const withoutEnums = (format: unknown) =>
      JSON.stringify(format).replace(/"enum":\[[^\]]*\]/g, '"enum":[]');
    const nodeOf = (r: (typeof a)[number]) =>
      systemOf(r).includes("diarized labels")
        ? "identify"
        : isTagsRequest({ system: systemOf(r) })
          ? "tags"
          : "correct";
    const schemas = (seen: typeof a, node: string) => [
      ...new Set(
        seen
          .filter((r) => nodeOf(r) === node)
          .map((r) => withoutEnums(r.body?.response_format)),
      ),
    ];
    for (const r of [...a, ...b]) {
      const text = JSON.stringify(r.body?.response_format);
      const enums = [...text.matchAll(/"enum":\[([^\]]*)\]/g)].map(
        (m) => JSON.parse(`[${m[1]}]`) as string[],
      );
      // id enum: exactly the ids of the lines in this request.
      const shown = [...userOf(r).matchAll(/^\[([^\]]+)\] /gm)].map(
        (m) => m[1],
      );
      const node = nodeOf(r);
      if (node === "identify") {
        // segmentId enum: the shown ids. label enum: the label numbers that
        // the system prompt lists. The third enum is the fixed `kind`.
        const listed = [...systemOf(r).matchAll(/Them (\d+)/g)].map(
          (m) => m[1],
        );
        expect(enums).toHaveLength(3);
        expect(enums[0]).toEqual(shown);
        expect(enums[2]).toEqual(["name", "role"]);
        expect(enums[1]?.every((l) => listed.includes(l))).toBe(true);
        expect(enums[1]?.length).toBeGreaterThan(0);
      } else if (node === "tags") {
        // The tags schema is fixed: it has no per-call enum.
        expect(enums).toEqual([]);
      } else {
        expect(enums).toEqual([shown]);
      }
    }
    for (const node of ["correct", "identify", "tags"]) {
      const sa = schemas(a, node);
      const sb = schemas(b, node);
      expect(sa).toHaveLength(1);
      expect(sb).toEqual(sa);
    }
    for (const r of [...a, ...b]) {
      expect((r.body?.response_format as { type: string }).type).toBe(
        "json_schema",
      );
    }
    // correctChunk sends enable_thinking false on a local server.
    const correct = a.filter((r) => nodeOf(r) === "correct");
    expect(correct.length).toBeGreaterThan(0);
    for (const r of correct) {
      expect(
        (r.body?.chat_template_kwargs as { enable_thinking: boolean })
          .enable_thinking,
      ).toBe(false);
    }
  });

  it("no attendee name or email is in any request body, with a calendar link that has attendees", async () => {
    const seen = await wireRun("m-attendees", true);
    expect(seen.length).toBeGreaterThan(1);
    for (const r of seen) {
      const text = `${systemOf(r)}\n${userOf(r)}\n${JSON.stringify(r.body)}`;
      expect(text).not.toMatch(
        /Jordan Vale|Casey Marlow|Riley Quinn|example\.test/,
      );
    }
  });
});
