// Opt-in MLflow tracing (specs/meeting-enhance-agentic.md 9.9 tests 1 to 8).
// The real runner, graph, gateway and recorder run with a scripted model. An
// in-memory exporter sits behind the real `MLflowSpanProcessor`, so the
// translation of the AI SDK spans is part of what these tests check. The live
// check against a real MLflow server is a separate proof (C1 to C10).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LegacyOpenTelemetry } from "@ai-sdk/otel";
import { MLflowSpanProcessor } from "@mlflow/vercel";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import {
  __setTracingForTests,
  getTracing,
  startTracing,
  stopTracing,
  type Tracing,
  telemetryFor,
} from "../src/lib/llm/tracing.js";
import { releaseJob } from "../src/lib/meetings/job-registry.js";
import { resumeRun, startRun } from "../src/lib/meetings/workflow/runner.js";
import { reply } from "./helpers/fake-model.js";
import {
  defaultAnswer,
  isIdentify,
  isSummaryRequest,
  type RunnerHarness,
  runnerHarness,
  runRow,
  waitForNoJob,
} from "./helpers/runner-helpers.js";
import {
  resetWorkflowTables,
  seedFixtureMeeting,
  seedTestModel,
  sizeFixtureSegments,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

type Stages = ("enhance" | "summarize")[];
const BOTH: Stages = ["enhance", "summarize"];

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new MLflowSpanProcessor(exporter)],
});
provider.register();
const tracer = provider.getTracer("openstyle-test");
const ON: Tracing = {
  on: true,
  tracer,
  integrations: [new LegacyOpenTelemetry({ tracer })],
  forceFlush: () => provider.forceFlush(),
  shutdown: () => provider.shutdown(),
};

/** Flush the batch processor. The fake timers need a push. */
async function flush(): Promise<ReadableSpan[]> {
  const p = provider.forceFlush();
  await vi.advanceTimersByTimeAsync(10);
  await p;
  return exporter.getFinishedSpans();
}

const attr = (s: ReadableSpan, k: string) => s.attributes[k];
const byName = (spans: ReadableSpan[], name: string) =>
  spans.filter((s) => s.name === name);

function seedMeeting(chunks: number) {
  const f = seedFixtureMeeting({ chunks, speakers: 1, meetingId: "m-trace" });
  sizeFixtureSegments(getDb(), f, 300);
  return f;
}

async function runToEnd(
  h: RunnerHarness,
  meetingId: string,
  stages: Stages,
): Promise<string> {
  const s = startRun({ meetingId, stages, trigger: "button" }, h.deps);
  if (!s.ok) throw new Error("start failed");
  await waitForNoJob(meetingId);
  return s.runId;
}

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
  exporter.reset();
  __setTracingForTests(ON);
});

afterEach(() => {
  __setTracingForTests(null);
  vi.restoreAllMocks();
  releaseJob("m-trace");
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

describe("startTracing (test 1)", () => {
  it("stays off with no variable, one variable or a bad scheme, and loads nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __setTracingForTests(null);
    for (const env of [
      {},
      { OPENSTYLE_MLFLOW_TRACKING_URI: "" },
      { OPENSTYLE_MLFLOW_TRACKING_URI: "http://127.0.0.1:4871" },
      { OPENSTYLE_MLFLOW_EXPERIMENT_ID: "1" },
      {
        OPENSTYLE_MLFLOW_TRACKING_URI: "127.0.0.1:4871",
        OPENSTYLE_MLFLOW_EXPERIMENT_ID: "1",
      },
    ]) {
      const t = await startTracing(env);
      expect(t.on).toBe(false);
      expect(t.integrations).toBeUndefined();
      expect(getTracing()).toBe(t);
    }
    warn.mockRestore();
  });

  it("a second startTracing keeps the first provider", async () => {
    __setTracingForTests(null);
    const register = vi.spyOn(NodeTracerProvider.prototype, "register");
    const env = {
      OPENSTYLE_MLFLOW_TRACKING_URI: "http://127.0.0.1:4871/",
      OPENSTYLE_MLFLOW_EXPERIMENT_ID: "7",
    };
    const a = await startTracing(env);
    const b = await startTracing(env);
    expect(a.on).toBe(true);
    expect(b).toBe(a);
    expect(register).toHaveBeenCalledTimes(1);
    const stopped = stopTracing();
    await vi.advanceTimersByTimeAsync(2100);
    await stopped;
  });

  it("goes on with both variables, and stopTracing ends it inside its cap", async () => {
    __setTracingForTests(null);
    const t = await startTracing({
      OPENSTYLE_MLFLOW_TRACKING_URI: "http://127.0.0.1:4871/",
      OPENSTYLE_MLFLOW_EXPERIMENT_ID: "7",
    });
    expect(t.on).toBe(true);
    expect(t.integrations).toBeDefined();
    const stopped = stopTracing();
    await vi.advanceTimersByTimeAsync(2100);
    await stopped;
    expect(getTracing().on).toBe(false);
  });
});

describe("one trace per run (tests 2, 3, 6, 8)", () => {
  it("a chained Enhance run gives one root, one node span per node call and AI SDK spans below them", async () => {
    const f = seedMeeting(3);
    const h = runnerHarness();
    const runId = await runToEnd(h, f.meeting.id, BOTH);
    const spans = await flush();

    const roots = byName(spans, "meeting.enhance");
    expect(roots).toHaveLength(1);
    const root = roots[0] as ReadableSpan;
    expect(attr(root, "mlflow.spanType")).toBe("WORKFLOW");
    expect(attr(root, "openstyle.kind")).toBe("enhance");
    expect(attr(root, "openstyle.scope")).toBe("meeting");
    expect(attr(root, "openstyle.run_id")).toBe(runId);
    expect(attr(root, "openstyle.started_by")).toBe("button");
    expect(attr(root, "openstyle.resume_count")).toBe(0);
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.status.code).not.toBe(SpanStatusCode.ERROR);

    const counts: Record<string, number> = {
      "node.prepare": 1,
      "node.correctChunk": 3,
      "node.identifySpeakers": 1,
      "node.verifyEvidence": 1,
      "node.summarize": 1,
      "node.save": 1,
    };
    for (const [name, n] of Object.entries(counts)) {
      expect(byName(spans, name), name).toHaveLength(n);
    }
    // One trace.
    const traceId = root.spanContext().traceId;
    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(
      new Set([traceId]),
    );
    // The AI SDK spans are LLM spans below a node span.
    const nodeIds = new Set(
      spans
        .filter((s) => s.name.startsWith("node."))
        .map((s) => s.spanContext().spanId),
    );
    const ai = byName(spans, "ai.generateText");
    expect(ai.length).toBeGreaterThan(0);
    for (const s of ai) {
      expect(attr(s, "mlflow.spanType")).toBe("LLM");
      expect(nodeIds.has(s.parentSpanContext?.spanId ?? "")).toBe(true);
    }
    expect(byName(spans, "ai.generateText.doGenerate")).toHaveLength(ai.length);
    // Join: the call ids of the node spans are the rows of the run (C5).
    const ids = spans
      .flatMap((s) => (attr(s, "openstyle.llm_call_ids") as string[]) ?? [])
      .sort();
    const rows = (
      getDb()
        .prepare("SELECT id FROM llm_calls WHERE run_id = ? ORDER BY id")
        .all(runId) as { id: number }[]
    ).map((r) => String(r.id));
    expect(ids).toEqual(rows.sort());
    expect(rows.length).toBe(ai.length);
  });

  it("a Summarize run is the root meeting.summarize with kind summarize", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    await runToEnd(h, f.meeting.id, ["summarize"]);
    const spans = await flush();
    const roots = byName(spans, "meeting.summarize");
    expect(roots).toHaveLength(1);
    expect(attr(roots[0] as ReadableSpan, "openstyle.kind")).toBe("summarize");
    expect(byName(spans, "node.correctChunk")).toHaveLength(0);
    expect(byName(spans, "node.summarize")).toHaveLength(1);
  });

  it("a length stop with valid JSON sets ERROR on the node span and on the run span", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness({
      answer: (r) =>
        isIdentify(r) || isSummaryRequest(r)
          ? defaultAnswer(r)
          : reply("length", "length", '{"corrections":[]}'),
    });
    const runId = await runToEnd(h, f.meeting.id, ["enhance"]);
    const status = runRow(runId).status;
    expect(["partial", "failed"]).toContain(status);
    const spans = await flush();
    const root = byName(spans, "meeting.enhance")[0] as ReadableSpan;
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(attr(root, "openstyle.outcome")).toBe(status);
    const failed = byName(spans, "node.correctChunk").filter(
      (s) => s.status.code === SpanStatusCode.ERROR,
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(attr(failed[0] as ReadableSpan, "openstyle.error_kind")).toBe(
      "length",
    );
  });

  it("a body that throws ends its node span with ERROR before the typed internal failure", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness({
      deps: {
        loadTranscript: () => {
          throw new TypeError("loader broke");
        },
      },
    });
    const runId = await runToEnd(h, f.meeting.id, ["enhance"]);
    expect(runRow(runId).status).not.toBe("succeeded");
    const spans = await flush();
    const errored = spans.filter(
      (s) =>
        s.name.startsWith("node.") && s.status.code === SpanStatusCode.ERROR,
    );
    expect(errored.length).toBeGreaterThan(0);
    const root = byName(spans, "meeting.enhance")[0] as ReadableSpan;
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("with the export off a run makes no span and ends as with it on", async () => {
    __setTracingForTests(null);
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await runToEnd(h, f.meeting.id, BOTH);
    expect(runRow(runId).status).toBe("succeeded");
    expect(await flush()).toHaveLength(0);
  });
});

describe("resume (tests 6, 8)", () => {
  let n = 0;
  async function interrupted(h: RunnerHarness, meetingId: string) {
    const name = `trace_fail_${n++}`;
    getDb().exec(
      `CREATE TRIGGER ${name} BEFORE INSERT ON llm_checkpoint_writes
       WHEN NEW.channel = 'summary'
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    try {
      return await runToEnd(h, meetingId, BOTH);
    } finally {
      getDb().exec(`DROP TRIGGER ${name}`);
    }
  }

  it("a resume starts a second trace with resume_count above 0; an interrupted run never ends its first root", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await interrupted(h, f.meeting.id);
    expect(runRow(runId).status).toBe("interrupted");
    let spans = await flush();
    expect(byName(spans, "meeting.enhance")).toHaveLength(0);

    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res.ok).toBe(true);
    await waitForNoJob(f.meeting.id);
    spans = await flush();
    const roots = byName(spans, "meeting.enhance");
    expect(roots).toHaveLength(1);
    const root = roots[0] as ReadableSpan;
    expect(attr(root, "openstyle.run_id")).toBe(runId);
    expect(attr(root, "openstyle.resume_count")).toBe(1);
    expect(attr(root, "openstyle.started_by")).toBe("button");
  });

  it("a changed transcript ends the resume with a run span in ERROR and kind transcript_changed", async () => {
    const f = seedMeeting(2);
    const h = runnerHarness();
    const runId = await interrupted(h, f.meeting.id);
    await flush();
    exporter.reset();
    getDb()
      .prepare(
        "UPDATE meeting_segments SET text = text || ' again' WHERE id = ?",
      )
      .run(f.segmentIdsByChunk[0]?.[0] as string);
    const res = await resumeRun(f.meeting.id, runId, h.deps);
    expect(res.ok).toBe(false);
    const spans = await flush();
    expect(spans.filter((s) => s.name.startsWith("node."))).toHaveLength(0);
    const root = byName(spans, "meeting.enhance")[0] as ReadableSpan;
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(attr(root, "openstyle.error_kind")).toBe("transcript_changed");
    expect(attr(root, "openstyle.outcome")).toBe("failed");
  });
});

describe("privacy (test 4)", () => {
  it("off gives telemetry isEnabled false; on gives the per-call integration", () => {
    expect(telemetryFor(ON, "x").integrations).toBeDefined();
    __setTracingForTests(null);
    expect(getTracing().on).toBe(false);
    expect(telemetryFor(getTracing(), "correctChunk")).toEqual({
      isEnabled: false,
    });
    expect(telemetryFor(ON, "correctChunk")).toMatchObject({
      functionId: "openstyle.correctChunk",
    });
  });

  it("no span holds request headers or a key", async () => {
    const f = seedMeeting(2);
    await runToEnd(runnerHarness(), f.meeting.id, ["enhance"]);
    const spans = await flush();
    for (const s of spans) {
      for (const k of Object.keys(s.attributes)) {
        // The SDK adds its own user-agent header. No key or token may appear.
        expect(k).not.toMatch(/headers\.(authorization|.*key|.*token)/i);
      }
    }
  });

  it("a dictation cleanup call exports no span while tracing is on", async () => {
    const { postProcess } = await import("@openstyle/stt");
    const { scriptedModel, okReply } = await import("./helpers/fake-model.js");
    const fake = scriptedModel("dict", [okReply("hello there")]);
    const res = await postProcess({
      model: fake.model,
      text: "hello there",
      system: "Clean the text.",
    });
    expect(fake.calls).toHaveLength(1);
    expect(res.cleaned).toBe("hello there");
    const spans = await flush();
    expect(spans).toHaveLength(0);
  });

  it("the dictation cleanup code in packages/stt has no telemetry hook", () => {
    const dir = join(process.cwd(), "..", "..", "packages", "stt", "src");
    const files = readdirSync(dir).filter((x) => x.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(src, file).not.toMatch(/integrations|registerTelemetry/);
    }
  });
});

// Last in the file: it resets the module cache, and a fresh tracing module
// would hide the ON object from the graph's later imports.
describe("startTracing off path (test 1)", () => {
  it("loads no export module and opens no socket while off", async () => {
    const loaded: string[] = [];
    const mods = [
      "@opentelemetry/sdk-trace-node",
      "@opentelemetry/exporter-trace-otlp-proto",
      "@mlflow/vercel",
      "@ai-sdk/otel",
    ];
    vi.resetModules();
    for (const m of mods) {
      vi.doMock(m, () => {
        loaded.push(m);
        return {};
      });
    }
    try {
      const fresh = await import("../src/lib/llm/tracing.js");
      const t = await fresh.startTracing({});
      expect(t.on).toBe(false);
      expect(loaded).toEqual([]);
    } finally {
      for (const m of mods) vi.doUnmock(m);
      vi.resetModules();
    }
  });
});
