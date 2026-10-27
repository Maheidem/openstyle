import { randomUUID } from "node:crypto";
import { createAppLogger } from "@openstyle/utils";
import type {
  LlmRunKind,
  LlmRunStatus,
  ResumeConflict,
  ResumeConflictReason,
} from "@openstyle/validations";
import { parseServerModelId } from "@openstyle/validations";
import type { Span } from "@opentelemetry/api";
import { getDb } from "../../db.js";
import type { CallProfile } from "../../llm/model-profiles.js";
import { createRunAdmin, type RunRow } from "../../llm/recorder.js";
import {
  dropRunSpan,
  endRunSpan,
  getTracing,
  startRunSpan,
} from "../../llm/tracing.js";
import { createRunRegistry } from "../../llm/workflow/run-registry.js";
import { hashVariantOf, inputHash, loadHashRows } from "../input-hash.js";
import {
  claimJob,
  hasJob,
  type MeetingJobPhase,
  releaseJob,
  setJobKind,
  updateProgress,
} from "../job-registry.js";
import { getMeetingRow } from "../store.js";
import {
  productionDeps,
  type RunContext,
  runContexts,
  WORKFLOW_FANOUT_CAP,
  type WorkflowDeps,
} from "./context.js";
import { cancelEngineRetry, scheduleEngineRetry } from "./engine-retry.js";
import { type FolderMemory, folderMemoryRecord } from "./folder-memory.js";
import type { CompiledWorkflow } from "./graph.js";
import { loadGraph } from "./load-graph.js";
import {
  deriveRunStatus,
  type FailureKind,
  type FinalState,
  type NodeId,
  type RunEnd,
  type RunStage,
  WORKFLOW_GRAPH_VERSION,
} from "./types.js";

// The runner (specs/meeting-enhance-agentic.md 3.4). It starts, resumes and
// ends runs. It is the only writer of a run status, through the recorder. It
// does not import LangGraph: `load-graph.ts` loads the graph with a dynamic
// import on the first run, so a bundling fault breaks Enhance only (3.1 rule 2).

const log = createAppLogger("meeting-runner");

/** After the soft signal fires, this long passes before the hard stop (3.4.5). */
export const HARD_STOP_GRACE_MS = 30_000;
/** A boot resumes an interrupted run by itself this many times (3.4.7, OQ-1). */
export const MAX_AUTO_RESUMES = 1;
/** The boot probe tries this many times, this far apart (3.4.7). */
export const BOOT_PROBE_TRIES = 10;
export const BOOT_PROBE_WAIT_MS = 15_000;

const SCOPE = "meeting";

/** The claims and cancel controllers of running meeting runs (3.1). */
const runRegistry = createRunRegistry();

/**
 * Auto-run-after-transcribe setting (specs/meeting-transcription-quality.md
 * section 6.5). Default off: an explicit opt-in. It moved here from the old
 * Enhance module.
 */
export function getMeetingEnhanceAutoRunSetting(): boolean {
  const row = getDb()
    .prepare(
      "SELECT value FROM settings WHERE key = 'meeting_enhance_auto_run'",
    )
    .get() as { value: string } | undefined;
  return row?.value === "true";
}

/**
 * What a test may replace. The runner merges it into `productionDeps()`. The
 * context lookup is not replaceable: the runner registers each run context in
 * its own registry.
 */
export type RunnerDeps = Partial<Omit<WorkflowDeps, "getRunContext">>;

function buildDeps(overrides: RunnerDeps | undefined): WorkflowDeps {
  return {
    ...productionDeps(),
    ...overrides,
    getRunContext: (runId) => runContexts.get(runId),
  };
}

// ---------------------------------------------------------------------------
// Run context (3.4.2, 3.4.4, 3.4.5)
// ---------------------------------------------------------------------------

interface RunContextHandle {
  ctx: RunContext;
  /** What `recordLost` counted. */
  lostRecords(): number;
  /** The kind that stopped the run (`ctx.stopRun`), or null. */
  stoppedKind(): FailureKind | null;
  /** A resume: take the plan and the finished chunks from the checkpoint. */
  resumeFrom(values: StateValues): void;
}

/** The phase that the job blob shows for each node (3.4.4). `verifyEvidence`
 * is code only and quick, so it keeps the phase before it. */
const PHASE_OF: Partial<Record<NodeId, MeetingJobPhase>> = {
  prepare: "preparing",
  correctChunk: "reading",
  identifySpeakers: "speakers",
  summarize: "summarizing",
  save: "saving",
  suggestTags: "tags",
};

/** The first sentence of a text, at most `max` characters. */
function firstSentence(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?…](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length <= max
    ? sentence
    : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

function makeRunContext(o: {
  runId: string;
  meetingId: string;
  controller: AbortController;
  deps: WorkflowDeps;
}): RunContextHandle {
  const { runId, meetingId, controller, deps } = o;
  let stoppedKind: FailureKind | null = null;
  let lost = 0;
  // The LLM call counters. Only `failed` goes to the job blob.
  const counts = { total: 0, done: 0, failed: 0 };
  let queued: { ahead: number; sinceMs: number } | null = null;
  // The calls of this run that hold a lane slot. A run with a call in work
  // is not queued, also when its other chunks wait behind that call.
  let held = 0;
  // The job blob counts work steps: one for each chunk, then one for each
  // later phase. `setPlan` fixes the total once, so the bar never goes back.
  const view = {
    chunks: 0,
    chunksDone: 0,
    after: [] as NodeId[],
    afterDone: 0,
    phase: "preparing" as MeetingJobPhase,
    step: null as number | null,
    steps: null as number | null,
    detail: null as string | null,
  };
  /** The chunks in work: index to the first sentence of the chunk. */
  const reading = new Map<number, string>();
  const publish = () =>
    updateProgress(meetingId, {
      total: view.chunks + view.after.length,
      done: Math.min(view.chunks, view.chunksDone) + view.afterDone,
      failed: counts.failed,
      queued,
      phase: view.phase,
      step: view.step,
      steps: view.steps,
      detail: view.detail,
    });
  /** Show the lowest chunk in work. With no chunk in work, keep the last. */
  const showChunk = () => {
    if (reading.size === 0) return;
    const index = Math.min(...reading.keys());
    view.step = index + 1;
    view.steps = view.chunks > 0 ? view.chunks : null;
    view.detail = reading.get(index) ?? null;
  };
  const setPlan = (chunks: number, stages: readonly RunStage[]) => {
    const enhance = stages.includes("enhance");
    view.chunks = enhance ? chunks : 0;
    view.after = [
      ...(enhance ? (["identifySpeakers"] as const) : []),
      ...(stages.includes("summarize") ? (["summarize"] as const) : []),
      "save",
      ...(enhance ? (["suggestTags"] as const) : []),
    ];
    publish();
  };
  const ctx: RunContext = {
    runId,
    meetingId,
    signal: controller.signal,
    isCancelled: () => controller.signal.aborted,
    isStopped: () => stoppedKind !== null,
    stopRun(kind) {
      stoppedKind ??= kind;
    },
    recordLost() {
      lost += 1;
    },
    progress: {
      addTotal(calls) {
        counts.total += calls;
      },
      callEnded(outcome) {
        counts.done += 1;
        if (outcome === "failed") counts.failed += 1;
        queued = null;
        publish();
      },
      callHeld(isHeld) {
        held = Math.max(0, held + (isHeld ? 1 : -1));
        if (isHeld && queued !== null) {
          queued = null;
          publish();
        }
      },
      onQueued(info) {
        if (held > 0) return;
        // The entry with the smallest `ahead` shows (3.4.4).
        if (queued === null || info.ahead < queued.ahead) {
          queued = { ahead: info.ahead, sinceMs: info.waitedMs };
          publish();
        }
      },
      setPlan,
      chunkStarted(chunkIndex, text) {
        reading.set(chunkIndex, firstSentence(text));
        showChunk();
        publish();
      },
      chunkEnded(chunkIndex) {
        reading.delete(chunkIndex);
        view.chunksDone += 1;
        showChunk();
        publish();
      },
      summaryPart(part) {
        view.phase = part === "combine" ? "combining" : "summarizing";
        view.step = part === "combine" ? null : part.n;
        view.steps = part === "combine" ? null : part.of;
        publish();
      },
    },
    setInputHash(hash) {
      deps.recorder.setInputHash(runId, hash);
    },
    onNodeStart(node: NodeId) {
      // The job starts as `enhance`. The banner names the running stage (3.6).
      if (node === "summarize") setJobKind(meetingId, "summarize");
      const phase = PHASE_OF[node];
      if (!phase) return;
      const at = view.after.indexOf(node);
      if (at >= 0) {
        // A later phase starts: every chunk and every phase before it is done.
        view.chunksDone = view.chunks;
        view.afterDone = Math.max(view.afterDone, at);
      }
      view.phase = phase;
      if (node !== "correctChunk") {
        view.step = null;
        view.steps = null;
        view.detail = null;
      }
      publish();
    },
  };
  return {
    ctx,
    lostRecords: () => lost,
    stoppedKind: () => stoppedKind,
    resumeFrom(values) {
      const chunks = (values.prepared as { chunks?: unknown[] } | undefined)
        ?.chunks;
      if (!chunks) return;
      view.chunksDone = values.corrections?.length ?? 0;
      setPlan(chunks.length, values.stages ?? []);
    },
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartRunInput {
  meetingId: string;
  stages: RunStage[];
  trigger: "auto" | "button";
}

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "job_running" | "no_meeting" | "error" };

function kindOf(stages: readonly RunStage[]): LlmRunKind {
  return stages.includes("enhance") ? "enhance" : "summarize";
}

/**
 * Claim the slot, insert the run row and start the graph in the background.
 * The part before `void execute(...)` has no `await`, so no request can slip
 * between the check and the claim (3.4.2). The route has made its own guards.
 */
export function startRun(
  input: StartRunInput,
  overrides?: RunnerDeps,
): StartRunResult {
  const { meetingId, stages, trigger } = input;
  const controller = new AbortController();
  const runId = randomUUID();
  const kind = kindOf(stages);
  if (
    !claimJob(meetingId, kind, { done: 0, total: 0, failed: 0 }, controller)
  ) {
    return { ok: false, reason: "job_running" };
  }
  let deps: WorkflowDeps;
  try {
    deps = buildDeps(overrides);
    const started = deps.recorder.startRun({
      id: runId,
      scope: SCOPE,
      scopeId: meetingId,
      kind,
      startedBy: trigger,
      graphVersion: WORKFLOW_GRAPH_VERSION,
      startedAt: deps.now(),
    });
    if (started !== "ok") {
      releaseJob(meetingId);
      return {
        ok: false,
        reason: started === "no_scope" ? "no_meeting" : "error",
      };
    }
  } catch (err) {
    log.warn(`meeting ${meetingId}: start failed: ${String(err)}`);
    releaseJob(meetingId);
    return { ok: false, reason: "error" };
  }
  runRegistry.claim(SCOPE, meetingId, { runId, controller });
  // A new run replaces a run that waits for the on-device engine.
  cancelEngineRetry(meetingId);
  void execute({
    runId,
    meetingId,
    mode: "start",
    stages,
    deps,
    controller,
    overrides,
  });
  return { ok: true, runId };
}

// ---------------------------------------------------------------------------
// Execute (3.4.2, 3.4.5, 3.4.6)
// ---------------------------------------------------------------------------

interface ExecuteArgs {
  runId: string;
  meetingId: string;
  mode: "start" | "resume";
  /** Used only by a start. A resume reads the stages from the checkpoint. */
  stages?: RunStage[];
  deps: WorkflowDeps;
  controller: AbortController;
  /** A graph that the caller already built. */
  graph?: CompiledWorkflow;
  /** A resume: the checkpoint values that `resumeRun` read. */
  resumed?: StateValues;
  /** The test seams of the caller. A run that starts again uses them too. */
  overrides?: RunnerDeps;
}

interface StateValues {
  stages?: RunStage[];
  prepared?: unknown;
  corrections?: FinalState["corrections"];
  identify?: FinalState["identify"];
  verify?: FinalState["verify"];
  summary?: FinalState["summary"];
  saved?: FinalState["saved"];
}

function finalStateOf(values: StateValues, fallback: RunStage[]): FinalState {
  const prepared = values.prepared as
    | { folderMemory?: FolderMemory }
    | null
    | undefined;
  return {
    retrieval: folderMemoryRecord(prepared?.folderMemory),
    stages: values.stages ?? fallback,
    corrections: values.corrections ?? [],
    identify: values.identify ?? null,
    verify: values.verify ?? null,
    summary: values.summary ?? null,
    saved: values.saved ?? null,
  };
}

function typedKindOf(err: unknown): string {
  const kind = (err as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : "internal";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Run the graph and end the run. It never throws: the whole body, including
 * the first database call, sits in one `try`, and the `finally` releases the
 * job (3.4.2 step 3, 3.4.6).
 */
async function execute(a: ExecuteArgs): Promise<void> {
  const { runId, meetingId, deps, controller } = a;
  const invokeController = new AbortController();
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let handle: RunContextHandle | null = null;
  let registered = false;
  let fault: RunEnd["fault"] = "none";
  let faultKind: string | null = null;
  let faultDetail: string | null = null;
  let hardStopped = false;
  let final: FinalState = finalStateOf({}, a.stages ?? []);
  let span: Span | null = null;
  const onSoft = () => {
    // A node that ignores its signal is a defect. The hard stop is the fallback.
    hardTimer = setTimeout(() => {
      hardStopped = true;
      invokeController.abort(new Error("Abort"));
    }, HARD_STOP_GRACE_MS);
  };
  try {
    handle = makeRunContext({ runId, meetingId, controller, deps });
    if (a.resumed) handle.resumeFrom(a.resumed);
    runContexts.register(handle.ctx);
    registered = true;
    if (controller.signal.aborted) onSoft();
    else controller.signal.addEventListener("abort", onSoft, { once: true });

    span = openRunSpan(deps, runId, meetingId);
    const graph = a.graph ?? (await loadGraph(deps));
    const config = {
      configurable: { thread_id: runId },
      durability: "sync" as const,
      maxConcurrency: WORKFLOW_FANOUT_CAP,
      signal: invokeController.signal,
    };
    try {
      const state = await graph.invoke(
        a.mode === "start"
          ? { runId, meetingId, stages: a.stages ?? [] }
          : null,
        config,
      );
      final = finalStateOf(state as StateValues, a.stages ?? []);
    } catch (err) {
      if (!hardStopped) {
        // A fault of `prepare` leaves no prepared meeting in the checkpoint.
        // Any other graph error (saver fault, escaped bug) leaves one (3.4.3).
        let values: StateValues = {};
        try {
          values = (await graph.getState({ configurable: config.configurable }))
            .values as StateValues;
        } catch {
          // No readable state: treat it as a fault of the graph.
        }
        final = finalStateOf(values, a.stages ?? []);
        fault = values.prepared ? "graph" : "prepare";
        faultKind = fault === "prepare" ? typedKindOf(err) : "internal";
        faultDetail = oneLine(err instanceof Error ? err.message : String(err));
        log.warn(
          `meeting ${meetingId}: run ${runId} ended with a ${fault} fault: ${faultDetail}`,
        );
      } else {
        try {
          const values = (
            await graph.getState({ configurable: config.configurable })
          ).values as StateValues;
          final = finalStateOf(values, a.stages ?? []);
        } catch {
          // Keep the empty state.
        }
        log.info(`meeting ${meetingId}: run ${runId} hard-stopped`);
      }
    }
  } catch (err) {
    // The context, the graph load or the first database call failed.
    fault = "graph";
    faultKind = "internal";
    faultDetail = oneLine(err instanceof Error ? err.message : String(err));
    log.error(
      `meeting ${meetingId}: run ${runId} failed to run: ${faultDetail}`,
    );
  } finally {
    try {
      finish({
        a,
        handle,
        final,
        fault,
        faultKind,
        faultDetail,
        hardStopped,
        span,
      });
    } catch (err) {
      log.error(
        `meeting ${meetingId}: run ${runId} finish failed: ${String(err)}`,
      );
    }
    if (hardTimer) clearTimeout(hardTimer);
    controller.signal.removeEventListener("abort", onSoft);
    if (registered) runContexts.drop(runId);
    runRegistry.release(SCOPE, meetingId, runId);
    releaseJob(meetingId);
  }
}

/** Open the run span (9.6.1 rule 2). A resume opens a new trace. Never throws. */
function openRunSpan(
  deps: WorkflowDeps,
  runId: string,
  meetingId: string,
): Span | null {
  if (!getTracing().on) return null;
  try {
    const run = createRunAdmin(deps.db).getRun(runId);
    if (!run) return null;
    return startRunSpan(getTracing(), runId, {
      scope: run.scope,
      scopeId: run.scopeId,
      kind: run.kind,
      started_by: run.startedBy,
      resume_count: run.resumeCount,
      meeting_id: run.scope === SCOPE ? meetingId : undefined,
    });
  } catch {
    return null;
  }
}

/**
 * End the run span with the final status. An `interrupted` run never ends its
 * span (9.6.2). A deleted meeting is not a failure. Never throws.
 */
function closeRunSpan(
  span: Span | null,
  runId: string,
  status: string,
  errorKind: string | null,
): void {
  if (!span) return;
  try {
    if (status === "interrupted") {
      dropRunSpan(runId);
      return;
    }
    const outcome =
      status === "succeeded" || status === "partial" || status === "failed"
        ? status
        : "cancelled";
    endRunSpan(span, runId, outcome, errorKind);
  } catch {
    // A tracing fault never changes a run (T7).
  }
}

/** The steps of 3.4.6: derive the status, write it, close steps, drop checkpoints. */
function finish(o: {
  a: ExecuteArgs;
  handle: RunContextHandle | null;
  final: FinalState;
  fault: RunEnd["fault"];
  faultKind: string | null;
  faultDetail: string | null;
  hardStopped: boolean;
  span: Span | null;
}): void {
  const { a, handle, final, fault, hardStopped } = o;
  const { runId, meetingId, deps, controller } = a;
  const admin = createRunAdmin(deps.db);
  const hasCheckpoint = fault === "graph" ? admin.hasCheckpoint(runId) : false;
  const cancelled = controller.signal.aborted || hardStopped;
  let status = deriveRunStatus(final, { cancelled, fault, hasCheckpoint });
  // A row that is gone now also means the meeting was deleted (3.4.8).
  if (status !== "meeting_deleted" && getMeetingRow(meetingId) === undefined) {
    status = "meeting_deleted";
  }
  if (status === "meeting_deleted") {
    log.info(`meeting ${meetingId}: run ended because the meeting was deleted`);
    closeRunSpan(o.span, runId, status, null);
    return;
  }
  let errorKind: string | null = null;
  let errorDetail: string | null = null;
  if (fault === "prepare") {
    errorKind = o.faultKind;
    errorDetail = o.faultDetail;
  } else if (fault === "graph") {
    errorKind = "internal";
    errorDetail = o.faultDetail;
  }
  // The on-device engine was not ready (the MLX worker update is not
  // installed). The run names this state, and it starts again when the
  // engine is ready (engine-retry.ts).
  const engineNotReady =
    handle?.stoppedKind() === "engine_not_ready" &&
    (status === "failed" || status === "partial");
  if (engineNotReady) errorKind ??= "engine_not_ready";
  const counts =
    kindOf(final.stages) === "enhance" && final.saved
      ? {
          correctedCount: final.saved.correctedCount,
          droppedCount: final.saved.droppedCount,
          suggestionCount: final.saved.suggestionCount,
        }
      : null;
  // The project memory of the run: ids only, no text (issue #234, D13).
  const result =
    counts || final.retrieval
      ? {
          ...counts,
          ...(final.retrieval ? { retrieval: final.retrieval } : {}),
        }
      : null;
  deps.recorder.finishRun(runId, status as LlmRunStatus, {
    errorKind,
    errorDetail,
    result,
    lostRecords: handle?.lostRecords() ?? 0,
    finishedAt: deps.now(),
  });
  closeRunSpan(o.span, runId, status, errorKind);
  if (hardStopped) admin.closeOpenSteps(runId, "cancelled");
  else if (status === "interrupted") admin.closeOpenSteps(runId, "interrupted");
  else {
    admin.closeOpenSteps(runId, "failed", {
      kind: errorKind ?? "internal",
      detail: errorDetail ?? "The run ended before this step ended.",
    });
  }
  if (status !== "interrupted") admin.deleteCheckpoints(runId);
  log.info(`meeting ${meetingId}: run ${runId} ${status}`);
  if (engineNotReady) {
    const stages = final.stages;
    scheduleEngineRetry(meetingId, () => {
      const r = startRun({ meetingId, stages, trigger: "auto" }, a.overrides);
      if (r.ok) return "started";
      return r.reason === "job_running" ? "busy" : "gone";
    });
  }
}

// ---------------------------------------------------------------------------
// Resume (3.4.7)
// ---------------------------------------------------------------------------

const CONFLICT_TEXT: Record<ResumeConflictReason, string> = {
  meeting_status: "The meeting has no transcript to resume on.",
  job_running: "A job is already running for this meeting.",
  not_interrupted: "This run is not interrupted.",
  graph_changed: "The app changed since this run started. Start again.",
  no_checkpoint: "This run has no saved progress to resume from.",
  transcript_changed: "The transcript changed since this run started.",
};

export type ResumeResult =
  | { ok: true; runId: string }
  | { ok: false; status: 404 | 500; error: string }
  | { ok: false; status: 409; conflict: ResumeConflict };

function conflict(reason: ResumeConflictReason): ResumeResult {
  return {
    ok: false,
    status: 409,
    conflict: { error: CONFLICT_TEXT[reason], reason },
  };
}

/** End a run that a guard refused for good (guards 4 and 6). */
function failRun(
  deps: WorkflowDeps,
  run: RunRow,
  kind: "graph_changed" | "transcript_changed",
): void {
  const admin = createRunAdmin(deps.db);
  // The run span has no node span; it ends at once with ERROR (9.6.1 rule 5).
  try {
    const span = startRunSpan(getTracing(), run.id, {
      scope: run.scope,
      scopeId: run.scopeId,
      kind: run.kind,
      started_by: run.startedBy,
      resume_count: run.resumeCount,
      meeting_id: run.scope === SCOPE ? run.scopeId : undefined,
    });
    endRunSpan(span, run.id, "failed", kind);
  } catch {
    // T7
  }
  deps.recorder.finishRun(run.id, "failed", {
    errorKind: kind,
    errorDetail: CONFLICT_TEXT[kind],
    result: null,
    lostRecords: 0,
    finishedAt: deps.now(),
  });
  admin.closeOpenSteps(run.id, "failed", {
    kind,
    detail: CONFLICT_TEXT[kind],
  });
  admin.deleteCheckpoints(run.id);
}

/**
 * Resume an interrupted run. The guards run in the order of 3.4.7. Guards 1 to
 * 5 need no graph; the job is claimed right after them, before the first
 * `await`. Guard 6 reads the stage list from the checkpoint.
 */
export async function resumeRun(
  meetingId: string,
  runId: string,
  overrides?: RunnerDeps,
): Promise<ResumeResult> {
  const meeting = getMeetingRow(meetingId);
  if (!meeting) return { ok: false, status: 404, error: "Not found" };
  const deps = buildDeps(overrides);
  const admin = createRunAdmin(deps.db);
  const run = admin.getRun(runId);
  if (!run || run.scope !== SCOPE || run.scopeId !== meetingId) {
    return { ok: false, status: 404, error: "Not found" };
  }
  if (meeting.status !== "transcribed" && meeting.status !== "summarized") {
    return conflict("meeting_status");
  }
  if (hasJob(meetingId)) return conflict("job_running");
  if (run.status !== "interrupted") return conflict("not_interrupted");
  if (run.graphVersion !== WORKFLOW_GRAPH_VERSION) {
    failRun(deps, run, "graph_changed");
    return conflict("graph_changed");
  }
  if (!admin.hasCheckpoint(runId)) return conflict("no_checkpoint");

  const controller = new AbortController();
  if (
    !claimJob(meetingId, run.kind, { done: 0, total: 0, failed: 0 }, controller)
  ) {
    return conflict("job_running");
  }
  try {
    const graph = await loadGraph(deps);
    const snap = await graph.getState({ configurable: { thread_id: runId } });
    const stages = ((snap.values as StateValues).stages ??
      (run.kind === "enhance"
        ? ["enhance", "summarize"]
        : ["summarize"])) as RunStage[];
    if (run.inputHash !== null) {
      const fresh = inputHash(
        loadHashRows(deps.db, meetingId),
        hashVariantOf(stages),
      );
      if (fresh !== run.inputHash) {
        failRun(deps, run, "transcript_changed");
        releaseJob(meetingId);
        return conflict("transcript_changed");
      }
    }
    deps.recorder.markResumed(runId);
    runRegistry.claim(SCOPE, meetingId, { runId, controller });
    void execute({
      runId,
      meetingId,
      mode: "resume",
      deps,
      controller,
      graph,
      resumed: snap.values as StateValues,
      overrides,
    });
    return { ok: true, runId };
  } catch (err) {
    log.warn(`meeting ${meetingId}: resume of ${runId} failed: ${String(err)}`);
    releaseJob(meetingId);
    return { ok: false, status: 500, error: "The run could not be resumed" };
  }
}

// ---------------------------------------------------------------------------
// Boot (3.4.7)
// ---------------------------------------------------------------------------

/**
 * The boot sweep. Synchronous SQL only, no LangGraph. `startServer` calls it
 * before `serve()`.
 */
export function sweepOrphanRuns(): { interrupted: number; failed: number } {
  const out = createRunAdmin(getDb()).sweepOrphans();
  if (out.interrupted > 0 || out.failed > 0) {
    log.info(
      `boot sweep: ${out.interrupted} run(s) interrupted, ${out.failed} failed before a checkpoint`,
    );
  }
  return out;
}

/** One key for each endpoint: the server for a local profile, else the provider. */
function endpointKey(p: Pick<CallProfile, "provider" | "modelId">): string {
  const target = parseServerModelId(p.modelId);
  return target ? `server:${target.serverId}` : p.provider;
}

/** The profiles of the steps that the stage list uses. */
function profilesFor(
  models: Record<string, CallProfile> | null | undefined,
  stages: readonly RunStage[],
): CallProfile[] {
  if (!models) return [];
  const steps: string[] = [];
  if (stages.includes("enhance"))
    steps.push("correctChunk", "identifySpeakers", "suggestTags");
  if (stages.includes("summarize")) steps.push("summarize");
  return steps.flatMap((s) => (models[s] ? [models[s]] : []));
}

/** True when every endpoint answers within the tries. */
async function endpointsUp(
  deps: WorkflowDeps,
  profiles: CallProfile[],
): Promise<boolean> {
  const distinct = new Map<string, CallProfile>();
  for (const p of profiles) distinct.set(endpointKey(p), p);
  const never = new AbortController().signal;
  for (const p of distinct.values()) {
    let up = false;
    for (let i = 0; i < BOOT_PROBE_TRIES; i++) {
      if (await deps.probeEndpoint(p)) {
        up = true;
        break;
      }
      if (i < BOOT_PROBE_TRIES - 1) {
        await deps.sleep(BOOT_PROBE_WAIT_MS, never);
      }
    }
    if (!up) return false;
  }
  return true;
}

/**
 * After the server listens: resume each interrupted run once by itself. One
 * `HEAD` or `GET` probe, with no key and no meeting data, goes to each
 * endpoint of the run first. A run whose endpoint stays down stays
 * `interrupted`, the resume is not counted and the user can click Resume.
 */
export async function resumeInterruptedRuns(
  overrides?: RunnerDeps,
): Promise<void> {
  try {
    const deps = buildDeps(overrides);
    const admin = createRunAdmin(deps.db);
    for (const run of admin.listAutoResumable(MAX_AUTO_RESUMES)) {
      if (run.scope !== SCOPE) continue;
      try {
        const graph = await loadGraph(deps);
        const snap = await graph.getState({
          configurable: { thread_id: run.id },
        });
        const values = snap.values as StateValues & {
          models?: Record<string, CallProfile> | null;
        };
        const stages = (values.stages ??
          (run.kind === "enhance"
            ? ["enhance", "summarize"]
            : ["summarize"])) as RunStage[];
        const profiles = profilesFor(values.models, stages);
        if (!(await endpointsUp(deps, profiles))) {
          log.info(
            `run ${run.id}: the model endpoint is down. It stays interrupted.`,
          );
          continue;
        }
        const res = await resumeRun(run.scopeId, run.id, overrides);
        if (!res.ok) {
          log.info(
            `run ${run.id}: boot resume refused (${res.status === 409 ? res.conflict.reason : "not found"})`,
          );
        }
      } catch (err) {
        log.warn(`run ${run.id}: boot resume failed: ${String(err)}`);
      }
    }
  } catch (err) {
    log.warn(`boot resume failed: ${String(err)}`);
  }
}
