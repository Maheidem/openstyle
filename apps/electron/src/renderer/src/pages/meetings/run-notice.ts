import type {
  LlmRunInfo,
  LlmRunKind,
  LlmSkipReason,
  LlmStepInfo,
} from "@openstyle/validations";

// Pure helpers for the run notices of the meeting detail view
// (specs/meeting-enhance-agentic.md 8.9). No React, no i18n, no clock: the
// view passes the newest run of a kind and gets back what to show. The view
// owns the text, through the keys that `llmErrorKey` and `noticeTextKey` name.

/** The error kinds that have a `meetings.llmError.<kind>` text (8.10). */
const KNOWN_ERROR_KINDS: ReadonlySet<string> = new Set([
  "length",
  "content_filter",
  "unexpected_tool_calls",
  "abnormal_stop",
  "reasoning_leak",
  "schema",
  "provider_timeout",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_auth",
  "provider_invalid_request",
  "model_mismatch",
  "model_unavailable",
  "engine_not_ready",
  "deadline_exceeded",
  "budget_exceeded",
  "empty_input",
  "save_failed",
  "internal",
  "interrupted_before_checkpoint",
  "graph_changed",
  "transcript_changed",
  "cancelled",
  "unknown",
]);

/** The nodes that have a `meetings.llmRun.node.<node>` label (8.10). */
const KNOWN_NODES: ReadonlySet<string> = new Set([
  "correctChunk",
  "identifySpeakers",
  "summarize",
  "save",
  "suggestTags",
]);

/** The run statuses that show a failure or interrupted notice. */
export type NoticeStatus = "failed" | "partial" | "interrupted";

/**
 * One line of a notice. `node` is null for the line of a run that has no
 * failed step (`run.errorKind` only). `chunks` holds the chunk numbers as a
 * person counts them, from 1, and is empty for a node that has no chunks.
 */
export interface NoticeLine {
  node: string | null;
  chunks: number[];
  kind: string;
}

export interface RunNotice {
  runId: string;
  kind: LlmRunKind;
  status: NoticeStatus;
  tone: "destructive" | "neutral";
  lines: NoticeLine[];
  /** `{{failed}}` and `{{total}}` of the `partial` text. From the server. */
  failedSteps: number;
  totalSteps: number;
  /** The "Resume" button: an interrupted run only. */
  canResume: boolean;
  /** The "Start again" label says that it discards the stopped run's work. */
  startAgainDiscards: boolean;
  /**
   * The run stopped because the on-device engine was not ready (an update of
   * the MLX worker is not installed). The server starts the run again when
   * the engine is ready, so the notice is neutral and has its own text.
   */
  waitingForEngine: boolean;
}

/**
 * True when the newest run of a kind stopped because the on-device engine was
 * not ready. The server starts it again by itself, so the view polls.
 */
export function waitsForEngine(
  runs: readonly LlmRunInfo[] | undefined,
): boolean {
  if (!runs) return false;
  const newest = new Map<LlmRunKind, LlmRunInfo>();
  for (const run of runs) {
    const seen = newest.get(run.kind);
    if (!seen || run.startedAt > seen.startedAt) newest.set(run.kind, run);
  }
  return [...newest.values()].some(
    (run) =>
      run.status !== "interrupted" && run.errorKind === "engine_not_ready",
  );
}

/** The i18n key of the headline of a run that waits for the on-device engine. */
export function engineNotReadyTextKey(kind: LlmRunKind): string {
  return `meetings.llmRun.engineNotReady.${kind}`;
}

/** The i18n key of the text for an error kind. An unknown kind reads as `unknown`. */
export function llmErrorKey(kind: string | null | undefined): string {
  return `meetings.llmError.${
    kind && KNOWN_ERROR_KINDS.has(kind) ? kind : "unknown"
  }`;
}

/**
 * The skip reasons that have a `meetings.skipReason.<reason>` text (issue
 * #300). The Record type makes a new reason in `LlmSkipReason` a type error
 * here until it gets its text.
 */
export const SKIP_REASONS: Readonly<Record<LlmSkipReason, true>> = {
  no_labels: true,
  all_confirmed: true,
  stopped: true,
  cancelled: true,
  speakers_skipped: true,
  speakers_failed: true,
  not_saved: true,
  meeting_gone: true,
  empty_transcript: true,
};

/**
 * The i18n key of the neutral text of a skipped step. A skip is not an error,
 * so a missing or unknown reason reads as `other`, never as `unknown` error.
 */
export function skipReasonKey(reason: string | null | undefined): string {
  return `meetings.skipReason.${
    reason && Object.hasOwn(SKIP_REASONS, reason) ? reason : "other"
  }`;
}

/** The i18n key of a node label, or null when the node has none. */
export function nodeLabelKey(node: string): string | null {
  return KNOWN_NODES.has(node) ? `meetings.llmRun.node.${node}` : null;
}

/** The i18n key of the headline: `meetings.llmRun.<kind>.<status>`. */
export function noticeTextKey(kind: LlmRunKind, status: NoticeStatus): string {
  return `meetings.llmRun.${kind}.${status}`;
}

/**
 * The chunk number a person reads for a step key: `chunk:0` is chunk 1
 * (4.0.7 counts from 0). A half such as `chunk:3/0` belongs to chunk 4.
 * Returns null for a key that is not a chunk.
 */
export function chunkNumber(stepKey: string): number | null {
  const m = /^chunk:(\d+)(?:\/.*)?$/.exec(stepKey);
  return m ? Number(m[1]) + 1 : null;
}

/** "4, 7" for the `{{list}}` of `meetings.llmRun.chunks`. */
export function formatChunkList(chunks: readonly number[]): string {
  return chunks.join(", ");
}

/** A step counts as failed when it failed or partly failed (4.0.7). */
function isFailedStep(step: LlmStepInfo): boolean {
  return step.status === "failed" || step.status === "partial";
}

/**
 * One line for each distinct pair of node and error kind among the failed and
 * partly failed steps, in the order the steps started. Chunk steps add their
 * chunk numbers to the line of their pair. A run with no failed step gives one
 * line from `run.errorKind`; with no error kind either, the `unknown` line.
 */
export function noticeLines(run: LlmRunInfo): NoticeLine[] {
  const lines: NoticeLine[] = [];
  const steps = run.steps
    .filter(isFailedStep)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  for (const step of steps) {
    const kind = step.errorKind ?? "unknown";
    let line = lines.find((l) => l.node === step.node && l.kind === kind);
    if (!line) {
      line = { node: step.node, chunks: [], kind };
      lines.push(line);
    }
    const n = chunkNumber(step.key);
    if (n !== null && !line.chunks.includes(n)) line.chunks.push(n);
  }
  for (const line of lines) line.chunks.sort((a, b) => a - b);
  if (lines.length === 0) {
    lines.push({ node: null, chunks: [], kind: run.errorKind ?? "unknown" });
  }
  return lines;
}

/**
 * True when a Summarize run is old news: a newer run (by `startedAt`) of any
 * kind has a Summarize step. A chained Enhance run writes the summary, so it
 * replaces the result of an earlier Summarize run that failed or stopped.
 * This goes a little beyond 8.9, which clears a notice only for a newer run
 * of the same kind.
 */
function summarizeSuperseded(
  run: LlmRunInfo,
  allRuns: readonly LlmRunInfo[],
): boolean {
  return (
    run.kind === "summarize" &&
    allRuns.some(
      (other) =>
        other.id !== run.id &&
        other.startedAt > run.startedAt &&
        other.steps.some((s) => s.node === "summarize"),
    )
  );
}

/**
 * The notice for the newest run of one kind, or null. A notice shows for a
 * `failed`, `partial` or `interrupted` run, and never while a job holds the
 * slot (8.9: the notice clears when a run starts). An interrupted run lists
 * lines only when it has a failure (`errorKind`). A Summarize notice also
 * hides when a newer run in `allRuns` has a Summarize step.
 */
export function runNotice(
  run: LlmRunInfo | undefined,
  jobHoldsSlot: boolean,
  allRuns: readonly LlmRunInfo[] = [],
  hasLlm = true,
): RunNotice | null {
  if (
    !hasLlm &&
    run?.status === "failed" &&
    run.errorKind === "model_unavailable"
  )
    return null;
  if (!run || jobHoldsSlot || summarizeSuperseded(run, allRuns)) return null;
  if (
    run.status !== "failed" &&
    run.status !== "partial" &&
    run.status !== "interrupted"
  ) {
    return null;
  }
  const interrupted = run.status === "interrupted";
  const waitingForEngine = !interrupted && run.errorKind === "engine_not_ready";
  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    tone: interrupted || waitingForEngine ? "neutral" : "destructive",
    lines:
      (interrupted && run.errorKind === null) || waitingForEngine
        ? []
        : noticeLines(run),
    failedSteps: run.failedStepCount,
    totalSteps: run.llmStepCount,
    canResume: interrupted,
    startAgainDiscards: interrupted,
    waitingForEngine,
  };
}

/** The i18n key under `meetings.` and the count of the Enhance note. */
export interface EnhanceNote {
  key: "enhanceResult" | "enhanceNoneCorrected" | "enhanceAllDropped";
  n: number;
}

/**
 * The neutral success note of an Enhance run (8.9), for a `succeeded` or
 * `partial` run that ended after `endedAfter` (epoch ms, the moment the page
 * opened or the user last acted). Null when no note shows. When no correction
 * was applied but the model suggested some that the checks dropped, the note
 * says so: "No segments needed correction" would then be false.
 */
export function enhanceNoteOf(
  run: LlmRunInfo | undefined,
  jobHoldsSlot: boolean,
  endedAfter: number,
): EnhanceNote | null {
  if (!run || jobHoldsSlot || run.kind !== "enhance") return null;
  if (run.status !== "succeeded" && run.status !== "partial") return null;
  if (run.finishedAt === null || run.finishedAt <= endedAfter) return null;
  if (run.correctedCount === null) return null;
  if (run.correctedCount > 0) {
    return { key: "enhanceResult", n: run.correctedCount };
  }
  const dropped = run.droppedCount ?? 0;
  return dropped > 0
    ? { key: "enhanceAllDropped", n: dropped }
    : { key: "enhanceNoneCorrected", n: 0 };
}

/**
 * True for a cancelled Summarize run. It drives the neutral text that
 * `summarizeCancelled` holds (8.9, decided 2026-10-17: the renderer reads the
 * run).
 */
export function isSummarizeCancelled(
  run: LlmRunInfo | undefined,
  jobHoldsSlot: boolean,
  allRuns: readonly LlmRunInfo[] = [],
): boolean {
  return (
    !jobHoldsSlot &&
    run?.kind === "summarize" &&
    run.status === "cancelled" &&
    !summarizeSuperseded(run, allRuns)
  );
}
