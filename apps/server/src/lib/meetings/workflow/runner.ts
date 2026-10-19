import { randomUUID } from "node:crypto";
import { createAppLogger } from "@openstyle/utils";
import type {
  LlmRunKind,
  LlmRunStatus,
  ResumeConflict,
  ResumeConflictReason,
} from "@openstyle/validations";
import { parseServerModelId } from "@openstyle/validations";
import { getDb } from "../../db.js";
import type { CallProfile } from "../../llm/model-profiles.js";
import { createRunAdmin, type RunRow } from "../../llm/recorder.js";
import { createRunRegistry } from "../../llm/workflow/run-registry.js";
import { hashVariantOf, inputHash, loadHashRows } from "../input-hash.js";
import {
  claimJob,
  hasJob,
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
  const counts = { total: 0, done: 0, failed: 0 };
  let queued: { ahead: number; sinceMs: number } | null = null;
  const publish = () =>
    updateProgress(meetingId, {
      total: counts.total,
      done: counts.done,
      failed: counts.failed,
      queued,
    });
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
        publish();
      },
      callEnded(outcome) {
        counts.done += 1;
        if (outcome === "failed") counts.failed += 1;
        queued = null;
        publish();
      },
      onQueued(info) {
        // The entry with the smallest `ahead` shows (3.4.4).
        if (queued === null || info.ahead < queued.ahead) {
          queued = { ahead: info.ahead, sinceMs: info.waitedMs };
          publish();
        }
      },
    },
    setInputHash(hash) {
      deps.recorder.setInputHash(runId, hash);
    },
    onNodeStart(node: NodeId) {
      // The job starts as `enhance`. The banner names the running stage (3.6).
      if (node === "summarize") setJobKind(meetingId, "summarize");
    },
  };
  return { ctx, lostRecords: () => lost };
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
  void execute({ runId, meetingId, mode: "start", stages, deps, controller });
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
  return {
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
  const onSoft = () => {
    // A node that ignores its signal is a defect. The hard stop is the fallback.
    hardTimer = setTimeout(() => {
      hardStopped = true;
      invokeController.abort(new Error("Abort"));
    }, HARD_STOP_GRACE_MS);
  };
  try {
    handle = makeRunContext({ runId, meetingId, controller, deps });
    runContexts.register(handle.ctx);
    registered = true;
    if (controller.signal.aborted) onSoft();
    else controller.signal.addEventListener("abort", onSoft, { once: true });

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
      finish({ a, handle, final, fault, faultKind, faultDetail, hardStopped });
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

/** The steps of 3.4.6: derive the status, write it, close steps, drop checkpoints. */
function finish(o: {
  a: ExecuteArgs;
  handle: RunContextHandle | null;
  final: FinalState;
  fault: RunEnd["fault"];
  faultKind: string | null;
  faultDetail: string | null;
  hardStopped: boolean;
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
  const result =
    kindOf(final.stages) === "enhance" && final.saved
      ? {
          correctedCount: final.saved.correctedCount,
          suggestionCount: final.saved.suggestionCount,
        }
      : null;
  deps.recorder.finishRun(runId, status as LlmRunStatus, {
    errorKind,
    errorDetail,
    result,
    lostRecords: handle?.lostRecords() ?? 0,
    finishedAt: deps.now(),
  });
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
    void execute({ runId, meetingId, mode: "resume", deps, controller, graph });
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
    steps.push("correctChunk", "identifySpeakers");
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
