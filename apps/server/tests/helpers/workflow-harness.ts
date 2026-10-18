import type { DatabaseSync } from "node:sqlite";
import { type LlmStepStatus, serverModelId } from "@openstyle/validations";
import type { MockLanguageModelV4 } from "ai/test";
import { vi } from "vitest";
import { getDb } from "../../src/lib/db.js";
import type { CallRecord } from "../../src/lib/llm/call-record.js";
import { callStructured } from "../../src/lib/llm/gateway.js";
import {
  createLlmRecorder,
  type LlmRecorder,
  type NewLink,
  type ParsedCall,
} from "../../src/lib/llm/recorder.js";
import {
  createRunContextRegistry,
  type RunContextRegistry,
} from "../../src/lib/llm/workflow/run-context-registry.js";
import { loadMergedTranscript } from "../../src/lib/meetings/transcript-io.js";
import {
  type RunContext,
  WORKFLOW_FANOUT_CAP,
  type WorkflowDeps,
} from "../../src/lib/meetings/workflow/context.js";
import { buildGraph } from "../../src/lib/meetings/workflow/graph.js";
import type { WorkflowStateType } from "../../src/lib/meetings/workflow/state.js";
import {
  type FailureKind,
  type NodeId,
  WORKFLOW_GRAPH_VERSION,
} from "../../src/lib/meetings/workflow/types.js";
import { insertOwnServer } from "../../src/lib/own-servers.js";
import { type ScriptStep, scriptedModel, seamFor } from "./fake-model.js";
import {
  buildMeetingFixture,
  type MeetingFixture,
  type MeetingFixtureInput,
  writeMeetingFixture,
} from "./meeting-fixture.js";

// The one workflow harness (specs/meeting-enhance-agentic.md 10.2 rule 9).
// WP5b and WP6 import it and do not edit it. It builds a run context, an
// in-memory recorder, a deps object and a runner-less graph run.

/** Resolves at once. Rejects when the signal is aborted. */
export const instantSleep: WorkflowDeps["sleep"] = (_ms, signal) =>
  signal.aborted
    ? Promise.reject(signal.reason ?? new Error("aborted"))
    : Promise.resolve();

export interface TestRunContext extends RunContext {
  /** Set the flag that isCancelled() reads, and abort the signal. */
  cancel(): void;
  /** Set the flag that isStopped() reads. */
  stop(kind: FailureKind): void;
  /** onNodeStart calls, in order. */
  readonly startedNodes: NodeId[];
  readonly progress: RunContext["progress"] & {
    total: number;
    done: number;
    failed: number;
  };
  /** What recordLost and setInputHash received. */
  readonly lostRecords: number;
  readonly inputHash: string | null;
  readonly stoppedKind: FailureKind | null;
}

export function makeTestRunContext(
  o: { runId?: string; meetingId?: string; signal?: AbortSignal } = {},
): TestRunContext {
  const controller = new AbortController();
  const signal = o.signal
    ? AbortSignal.any([o.signal, controller.signal])
    : controller.signal;
  let cancelled = false;
  let stoppedKind: FailureKind | null = null;
  let lostRecords = 0;
  let inputHash: string | null = null;
  const startedNodes: NodeId[] = [];
  const progress = {
    total: 0,
    done: 0,
    failed: 0,
    addTotal(n: number) {
      progress.total += n;
    },
    callEnded(outcome: "ok" | "failed") {
      progress.done += 1;
      if (outcome === "failed") progress.failed += 1;
    },
    onQueued() {},
  };
  return {
    runId: o.runId ?? "run-1",
    meetingId: o.meetingId ?? "fixture-meeting",
    signal,
    isCancelled: () => cancelled,
    isStopped: () => stoppedKind !== null || cancelled,
    stopRun(kind) {
      stoppedKind ??= kind;
    },
    recordLost() {
      lostRecords += 1;
    },
    progress,
    setInputHash(hash) {
      inputHash = hash;
    },
    onNodeStart(node) {
      startedNodes.push(node);
    },
    cancel() {
      cancelled = true;
      controller.abort(new DOMException("Cancelled", "AbortError"));
    },
    stop(kind) {
      stoppedKind ??= kind;
    },
    startedNodes,
    get lostRecords() {
      return lostRecords;
    },
    get inputHash() {
      return inputHash;
    },
    get stoppedKind() {
      return stoppedKind;
    },
  };
}

type StepRow = {
  runId: string;
  node: string;
  status: LlmStepStatus;
  attempts: number;
  seq: number;
  errorKind: string | null;
};

export type FakeRecorder = LlmRecorder & {
  steps: Map<string, StepRow>;
  calls: (CallRecord & { id: number; attempt: number })[];
  links: (NewLink & { callId: number })[];
};

/** An in-memory recorder. It follows 7.7 for seq and attempt. */
export function makeFakeRecorder(): FakeRecorder {
  const steps = new Map<string, StepRow>();
  const calls: FakeRecorder["calls"] = [];
  const links: FakeRecorder["links"] = [];
  return {
    steps,
    calls,
    links,
    startRun: () => "ok",
    finishRun() {},
    setInputHash() {},
    markResumed() {},
    startStep(runId, step) {
      const cur = steps.get(step.key);
      const seq = steps.size + 1;
      steps.set(step.key, {
        runId,
        node: step.node,
        status: "running",
        attempts: cur?.attempts ?? 0,
        seq: cur?.seq ?? seq,
        errorKind: null,
      });
    },
    startAttempt({ stepKey }) {
      const top = stepKey.split("/")[0] ?? stepKey;
      const cur = steps.get(top);
      if (cur) cur.attempts += 1;
    },
    finishStep(_runId, key, status, err) {
      const cur = steps.get(key);
      if (!cur) return;
      cur.status = status;
      cur.errorKind = err?.kind ?? null;
    },
    recordCall(c) {
      const id = calls.length + 1;
      const attempt = calls.filter((x) => x.unitKey === c.unitKey).length + 1;
      calls.push({ ...c, id, attempt });
      return { id, attempt };
    },
    finishedCall(runId, unitKey): ParsedCall | null {
      for (let i = calls.length - 1; i >= 0; i--) {
        const c = calls[i];
        if (
          c &&
          c.runId === runId &&
          c.unitKey === unitKey &&
          c.errorKind === null &&
          c.parsed !== null &&
          c.finishRaw !== null
        ) {
          return {
            callId: c.id,
            attempt: c.attempt,
            parsed: c.parsed,
            rawFinishReason: c.finishRaw,
            usage: c.usage,
            provider: c.provider,
            modelRequested: c.modelRequested ?? "",
            modelServed: c.modelServed,
            queuedMs: c.queuedMs,
            latencyMs: c.latencyMs,
            params: c.params,
          };
        }
      }
      return null;
    },
    linkCall(callId, list) {
      for (const l of list) {
        const i = links.findIndex(
          (x) =>
            x.callId === callId &&
            x.targetType === l.targetType &&
            x.targetId === l.targetId &&
            x.seq === l.seq,
        );
        if (i >= 0) links[i] = { callId, ...l };
        else links.push({ callId, ...l });
      }
    },
    sweepInterrupted: () => 0,
  };
}

/**
 * Deps for a test. Defaults: the database of the test file (`getDb()`), the
 * in-memory recorder, `instantSleep`, a counter clock, an own context
 * registry and the real gateway. A test replaces only the fields it needs.
 */
export function makeTestDeps(o: Partial<WorkflowDeps> = {}): {
  deps: WorkflowDeps;
  contexts: RunContextRegistry<RunContext>;
} {
  const contexts = createRunContextRegistry<RunContext>();
  let tick = 1_760_000_000_000;
  const deps: WorkflowDeps = {
    db: getDb(),
    recorder: makeFakeRecorder(),
    callStructured,
    sleep: instantSleep,
    now: () => {
      tick += 1000;
      return tick;
    },
    loadTranscript: loadMergedTranscript,
    getRunContext: (runId) => contexts.get(runId),
    probeEndpoint: async () => true,
    ...o,
  };
  return { deps, contexts };
}

/** One request that the scripted model received. */
export interface RecordedRequest {
  n: number;
  system: string;
  user: string;
  /** The JSON Schema the request asked for, when the SDK sent one. */
  responseFormat: unknown;
  /** The output limit of the request. */
  maxOutputTokens: number | undefined;
}

export type ScriptedAnswer = ScriptStep;
export type Script =
  | ScriptedAnswer[]
  | ((req: RecordedRequest) => ScriptedAnswer);

function textOfMessage(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && "text" in p ? String(p.text) : "",
      )
      .join("");
  }
  return "";
}

/** A mock model whose answer comes from a function of the request. */
export function responderModel(
  modelId: string,
  responder: (req: RecordedRequest) => ScriptedAnswer,
): { model: MockLanguageModelV4; requests: RecordedRequest[] } {
  const base = scriptedModel(modelId, []);
  const requests: RecordedRequest[] = [];
  base.model.doGenerate = async (options) => {
    const prompt = options.prompt as { role: string; content: unknown }[];
    const req: RecordedRequest = {
      n: requests.length,
      system: textOfMessage(prompt.find((m) => m.role === "system")?.content),
      user: prompt
        .filter((m) => m.role === "user")
        .map((m) => textOfMessage(m.content))
        .join("\n"),
      responseFormat: (options as { responseFormat?: unknown }).responseFormat,
      maxOutputTokens: options.maxOutputTokens,
    };
    requests.push(req);
    base.calls.push(options);
    return scriptedModel(modelId, [responder(req)]).model.doGenerate(options);
  };
  return { model: base.model, requests };
}

export const TEST_MODEL = "Qwen3.8-27B";

/**
 * Make `server` the default LLM, as the gateway tests do. The model id of the
 * run is `server/<id>/Qwen3.8-27B`.
 */
export function seedTestModel(db: DatabaseSync = getDb()): string {
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.exec("DELETE FROM own_servers");
  const server = insertOwnServer({
    baseUrl: "http://127.0.0.1:8123",
    apiKey: null,
    flavor: "omlx",
  });
  const id = serverModelId(server.id, TEST_MODEL);
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES ('server', ?, ?, 'llm', 1)`,
  ).run(id, id);
  return id;
}

/**
 * Open the run row, register the context, run the graph with the config of
 * 3.4.2 and drop the context. It has no runner, job registry or route.
 */
export async function runScriptedGraph(o: {
  deps: WorkflowDeps;
  meetingId: string;
  stages: ("enhance" | "summarize")[];
  script?: Script;
  ctx?: TestRunContext;
  config?: { maxConcurrency?: number };
  /** The registry of `makeTestDeps`. The context is registered in it and dropped at the end. */
  contexts?: RunContextRegistry<RunContext>;
}): Promise<{
  finalState: WorkflowStateType;
  requests: RecordedRequest[];
  ctx: TestRunContext;
}> {
  const ctx = o.ctx ?? makeTestRunContext({ meetingId: o.meetingId });
  let requests: RecordedRequest[] = [];
  let deps = o.deps;
  if (o.script && !deps.createModel) {
    const responder: (req: RecordedRequest) => ScriptedAnswer =
      typeof o.script === "function"
        ? o.script
        : (() => {
            const list = o.script as ScriptedAnswer[];
            return (req) => {
              const step = list[Math.min(req.n, list.length - 1)];
              if (!step) throw new Error("empty script");
              return step;
            };
          })();
    const { model, requests: seen } = responderModel(TEST_MODEL, responder);
    requests = seen;
    deps = { ...deps, createModel: seamFor(model) };
  }
  // The checkpoint tables have a foreign key to `llm_runs`.
  createLlmRecorder(deps.db).startRun({
    id: ctx.runId,
    scope: "meeting",
    scopeId: o.meetingId,
    kind: o.stages.includes("enhance") ? "enhance" : "summarize",
    startedBy: "button",
    graphVersion: WORKFLOW_GRAPH_VERSION,
    startedAt: deps.now(),
  });
  o.contexts?.register(ctx);
  const registry = deps.getRunContext;
  deps = {
    ...deps,
    getRunContext: (runId) => (runId === ctx.runId ? ctx : registry(runId)),
  };
  try {
    const finalState = await buildGraph(deps).invoke(
      { runId: ctx.runId, meetingId: o.meetingId, stages: o.stages },
      {
        configurable: { thread_id: ctx.runId },
        durability: "sync",
        maxConcurrency: o.config?.maxConcurrency ?? WORKFLOW_FANOUT_CAP,
      },
    );
    return { finalState, requests, ctx };
  } finally {
    o.contexts?.drop(ctx.runId);
  }
}

/**
 * Lengthen the text of every segment of a meeting with made-up filler, so
 * `chunkForEnhance` makes more chunks (the fixture lines are short and fit one
 * chunk of 1200 tokens). The filler goes after the original sentence.
 */
export function padFixtureSegments(
  db: DatabaseSync,
  meetingId: string,
  extraChars: number,
): void {
  const filler =
    " We also went through the budget lines, the staffing plan and the open risks one more time.";
  const pad = filler
    .repeat(Math.ceil(extraChars / filler.length))
    .slice(0, extraChars);
  db.prepare(
    "UPDATE meeting_segments SET text = text || ? WHERE meeting_id = ?",
  ).run(pad, meetingId);
}

/**
 * Write a fictional meeting to the database of the test file, optionally with
 * longer segments and the made-up calendar link. Returns the fixture.
 */
export function seedFixtureMeeting(
  o: MeetingFixtureInput & { padChars?: number; withCalendar?: boolean },
): MeetingFixture {
  const f = buildMeetingFixture(o);
  writeMeetingFixture(getDb(), f, { withCalendar: o.withCalendar ?? false });
  if (o.padChars) padFixtureSegments(getDb(), f.meeting.id, o.padChars);
  return f;
}

/** Delete the meeting rows of the test file. The run, call and checkpoint rows cascade. */
export function resetWorkflowTables(): void {
  const db = getDb();
  db.exec("DELETE FROM meeting_summaries");
  db.exec("DELETE FROM meeting_speakers");
  db.exec("DELETE FROM meeting_segments");
  db.exec("DELETE FROM meetings");
}

/**
 * Set the text of every segment so that its transcript line (`[id] Label: text`)
 * is exactly `lineTokens` tokens by `estimateTokens` (ceil(chars / 4)) plus 1 for
 * the line break. Used to build chunks of a known size (4.0.6: the halves of a
 * 1200-token chunk are 600 tokens, the quarters 300). Made-up words only.
 */
export function sizeFixtureSegments(
  db: DatabaseSync,
  f: MeetingFixture,
  lineTokens: number,
): void {
  const words = [
    "budget",
    "rollout",
    "vendor",
    "review",
    "launch",
    "backlog",
    "staffing",
    "forecast",
    "release",
    "support",
    "metrics",
    "pilot",
    "roadmap",
    "audit",
  ];
  const update = db.prepare(
    "UPDATE meeting_segments SET text = ? WHERE id = ?",
  );
  for (const seg of f.segments) {
    const label = seg.source === "mic" ? "Me" : `Them ${seg.speakerLabel}`;
    const prefix = `[${seg.id}] ${label}: `;
    const chars = 4 * (lineTokens - 1);
    let text = seg.text;
    let k = 0;
    while (prefix.length + text.length < chars) {
      text += ` ${words[(k + seg.idx) % words.length]} ${seg.idx}-${k}`;
      k += 1;
    }
    text = text.slice(0, chars - prefix.length).replace(/\s+$/, "x");
    update.run(text, seg.id);
  }
}

// --- A stubbed chat endpoint, for runs through the real provider code ---

export interface SeenRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

const jsonHeaders = { "content-type": "application/json" };

/** An OpenAI chat completion. `model` null leaves the served model out. */
export function chatReply(
  content: string,
  o: { finish?: string | null; model?: string | null } = {},
): Response {
  return new Response(
    JSON.stringify({
      id: "1",
      object: "chat.completion",
      created: 0,
      ...(o.model === null ? {} : { model: o.model ?? TEST_MODEL }),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: o.finish === undefined ? "stop" : o.finish,
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 },
    }),
    { status: 200, headers: jsonHeaders },
  );
}

export function errorReply(status: number, body = "{}"): Response {
  return new Response(body, { status, headers: jsonHeaders });
}

/**
 * Stub `globalThis.fetch`. The handler gets each chat request and its index
 * among the chat requests. A models.dev read is a network fault. Call
 * `vi.restoreAllMocks()` after the test.
 */
export function stubFetch(
  handler: (r: SeenRequest, n: number) => Response | Promise<Response>,
): SeenRequest[] {
  const seen: SeenRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const raw = init?.body;
    let body: Record<string, unknown> | null = null;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    const r: SeenRequest = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
    };
    if (r.url.includes("models.dev")) throw new TypeError("fetch failed");
    seen.push(r);
    return handler(r, seen.length - 1);
  });
  return seen;
}

/** The system text of a chat request body. */
export function systemOf(r: SeenRequest): string {
  const messages = (r.body?.messages ?? []) as {
    role: string;
    content: unknown;
  }[];
  return textOfMessage(messages.find((m) => m.role === "system")?.content);
}

/** The user text of a chat request body. */
export function userOf(r: SeenRequest): string {
  const messages = (r.body?.messages ?? []) as {
    role: string;
    content: unknown;
  }[];
  return messages
    .filter((m) => m.role === "user")
    .map((m) => textOfMessage(m.content))
    .join("\n");
}
