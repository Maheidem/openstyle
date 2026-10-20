import type { DatabaseSync } from "node:sqlite";
import type {
  LlmCallFull,
  LlmCallSummary,
  LlmLinkInfo,
  LlmMessage,
  LlmParamsLedger,
  LlmRunInfo,
  LlmRunKind,
  LlmRunStatus,
  LlmScope,
  LlmStepInfo,
  LlmStepStatus,
  LlmTargetType,
  SpeakerVerdict,
} from "@openstyle/validations";

// Generic reader of the LLM call record (specs/meeting-enhance-agentic.md 8.3).
// It takes a scope and a scope id as arguments and knows no consumer. A
// consumer passes its LLM node names and, for stale checks, a callback. A JSON
// column that does not parse reads as null. A status, outcome or error kind
// the code does not know reads as "unknown" (7.2 P7). The scope, run kind and
// link target type pass as stored.

export interface RecordKey {
  scope: LlmScope;
  scopeId: string;
}

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);

const STEP_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
]);

/** The error kinds of 7.6: gateway, step and run. */
const ERROR_KINDS: ReadonlySet<string> = new Set([
  "length",
  "content_filter",
  "unexpected_tool_calls",
  "abnormal_stop",
  "reasoning_leak",
  "schema",
  "model_mismatch",
  "cancelled",
  "provider_timeout",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_auth",
  "provider_invalid_request",
  "model_unavailable",
  "deadline_exceeded",
  "budget_exceeded",
  "empty_input",
  "save_failed",
  "internal",
  "interrupted_before_checkpoint",
  "graph_changed",
  "transcript_changed",
]);

const RUN_KINDS = ["enhance", "summarize"] as const;

/** Steps a run lists when the caller asks for no run id. */
const OPEN_OR_BAD_STEPS = ["failed", "partial", "interrupted", "running"];

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorKindOf(value: string | null): string | null {
  if (value === null) return null;
  return ERROR_KINDS.has(value) ? value : "unknown";
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

interface RunRow {
  id: string;
  scope: string;
  scope_id: string;
  kind: string;
  started_by: string;
  status: string;
  graph_version: number;
  resume_count: number;
  result_json: string | null;
  lost_records: number;
  error_kind: string | null;
  error_detail: string | null;
  started_at: number;
  finished_at: number | null;
  call_count: number;
  failed_call_count: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  llm_step_count: number;
  failed_step_count: number;
}

interface StepRow {
  step_key: string;
  node: string;
  seq: number;
  status: string;
  attempts: number;
  error_kind: string | null;
  error_detail: string | null;
  started_at: number | null;
  finished_at: number | null;
  recorded_calls: number;
}

function runSelect(llmNodes: readonly string[]): string {
  const nodes = placeholders(llmNodes.length);
  return `SELECT r.*,
      (SELECT count(*) FROM llm_calls c WHERE c.run_id = r.id) AS call_count,
      (SELECT count(*) FROM llm_calls c WHERE c.run_id = r.id AND c.error_kind IS NOT NULL) AS failed_call_count,
      (SELECT COALESCE(sum(input_tokens), 0) FROM llm_calls c WHERE c.run_id = r.id) AS input_tokens,
      (SELECT COALESCE(sum(output_tokens), 0) FROM llm_calls c WHERE c.run_id = r.id) AS output_tokens,
      (SELECT COALESCE(sum(reasoning_tokens), 0) FROM llm_calls c WHERE c.run_id = r.id) AS reasoning_tokens,
      (SELECT count(*) FROM llm_run_steps s WHERE s.run_id = r.id AND s.node IN (${nodes})) AS llm_step_count,
      (SELECT count(*) FROM llm_run_steps s WHERE s.run_id = r.id AND s.node IN (${nodes}) AND s.status IN ('failed', 'partial')) AS failed_step_count
    FROM llm_runs r`;
}

function toStep(row: StepRow): LlmStepInfo {
  return {
    key: row.step_key,
    node: row.node,
    status: (STEP_STATUSES.has(row.status)
      ? row.status
      : "unknown") as LlmStepStatus,
    seq: row.seq,
    attempts: row.attempts,
    recordedCalls: row.recorded_calls,
    errorKind: errorKindOf(row.error_kind),
    errorDetail: row.error_detail,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRun(
  db: DatabaseSync,
  row: RunRow,
  onlyOpenOrBadSteps: boolean,
): LlmRunInfo {
  const stepFilter = onlyOpenOrBadSteps
    ? ` AND s.status IN (${placeholders(OPEN_OR_BAD_STEPS.length)})`
    : "";
  const steps = db
    .prepare(
      `SELECT s.step_key, s.node, s.seq, s.status, s.attempts, s.error_kind,
              s.error_detail, s.started_at, s.finished_at,
              (SELECT count(*) FROM llm_calls c
                WHERE c.run_id = s.run_id
                  AND (c.step_key = s.step_key
                       OR substr(c.step_key, 1, length(s.step_key) + 1) = s.step_key || '/')) AS recorded_calls
         FROM llm_run_steps s
        WHERE s.run_id = ?${stepFilter}
        ORDER BY s.seq`,
    )
    .all(
      row.id,
      ...(onlyOpenOrBadSteps ? OPEN_OR_BAD_STEPS : []),
    ) as unknown as StepRow[];
  const result = parseJson(row.result_json);
  const counts =
    result !== null && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    scope: row.scope as LlmScope,
    scopeId: row.scope_id,
    kind: row.kind as LlmRunKind,
    startedBy: row.started_by === "button" ? "button" : "auto",
    resumeCount: row.resume_count,
    status: (RUN_STATUSES.has(row.status)
      ? row.status
      : "unknown") as LlmRunStatus,
    graphVersion: row.graph_version,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorKind: errorKindOf(row.error_kind),
    errorDetail: row.error_detail,
    callCount: row.call_count,
    failedCallCount: row.failed_call_count,
    llmStepCount: row.llm_step_count,
    failedStepCount: row.failed_step_count,
    correctedCount: numberOrNull(counts.correctedCount),
    droppedCount: numberOrNull(counts.droppedCount),
    suggestionCount: numberOrNull(counts.suggestionCount),
    lostRecords: row.lost_records,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    steps: steps.map(toStep),
  };
}

/** One run of the scope with all its steps in `seq` order, or null. */
export function readRun(
  db: DatabaseSync,
  key: RecordKey,
  runId: string,
  llmNodes: readonly string[],
): LlmRunInfo | null {
  const row = db
    .prepare(
      `${runSelect(llmNodes)} WHERE r.scope = ? AND r.scope_id = ? AND r.id = ?`,
    )
    .get(...llmNodes, ...llmNodes, key.scope, key.scopeId, runId) as
    | RunRow
    | undefined;
  return row ? toRun(db, row, false) : null;
}

/** The newest runs of the scope, newest first. Each lists only open or bad steps. */
export function listRuns(
  db: DatabaseSync,
  key: RecordKey,
  limit: number,
  llmNodes: readonly string[],
): LlmRunInfo[] {
  const rows = db
    .prepare(
      `${runSelect(llmNodes)} WHERE r.scope = ? AND r.scope_id = ?
        ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?`,
    )
    .all(
      ...llmNodes,
      ...llmNodes,
      key.scope,
      key.scopeId,
      limit,
    ) as unknown as RunRow[];
  return rows.map((r) => toRun(db, r, true));
}

/** The newest run of each kind, newest first. Each lists only open or bad steps. */
export function latestRuns(
  db: DatabaseSync,
  key: RecordKey,
  llmNodes: readonly string[],
): LlmRunInfo[] {
  const runs: LlmRunInfo[] = [];
  for (const kind of RUN_KINDS) {
    const row = db
      .prepare(
        `${runSelect(llmNodes)} WHERE r.scope = ? AND r.scope_id = ? AND r.kind = ?
          ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`,
      )
      .get(...llmNodes, ...llmNodes, key.scope, key.scopeId, kind) as
      | RunRow
      | undefined;
    if (row) runs.push(toRun(db, row, true));
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

export type CallSelector =
  | { kind: "call"; callId: number }
  /** The calls of one step: the unit key equals the step key or starts with it plus "/". */
  | { kind: "step"; runId: string; stepKey: string }
  | { kind: "run"; runId: string; nodes?: readonly string[] }
  | { kind: "ids"; callIds: readonly number[] }
  | { kind: "failed" }
  | { kind: "all" };

/** Says whether a speaker link no longer describes the current data. */
export type StaleCheck = (link: {
  targetType: string;
  targetId: string;
  run: { id: string; inputHash: string | null };
}) => boolean;

export interface ReadCallsOptions {
  detail: "summary" | "full";
  limit: number;
  /** Show only the links to this target. */
  linkFilter?: { targetType: LlmTargetType; targetId: string };
  isStale?: StaleCheck;
}

interface CallDbRow {
  id: number;
  run_id: string;
  step_key: string;
  node: string;
  attempt: number;
  retry_reason: string | null;
  provider: string | null;
  requested_model: string | null;
  served_model: string | null;
  messages_json: string;
  schema_name: string;
  schema_version: number;
  schema_json: string;
  params_json: string;
  raw_text: string | null;
  parsed_json: string | null;
  finish_unified: string | null;
  finish_raw: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  reasoning_chars: number | null;
  queued_ms: number | null;
  latency_ms: number | null;
  error_kind: string | null;
  error_detail: string | null;
  started_at: number;
  finished_at: number;
}

interface LinkDbRow {
  id: number;
  call_id: number;
  target_type: string;
  target_id: string;
  outcome: string;
  reason: string | null;
  applied_text: string | null;
  verdict_json: string | null;
}

function selectCallRows(
  db: DatabaseSync,
  key: RecordKey,
  sel: CallSelector,
  limit: number,
): CallDbRow[] {
  const base = "SELECT * FROM llm_calls WHERE scope = ? AND scope_id = ?";
  const args: (string | number)[] = [key.scope, key.scopeId];
  let where = "";
  let order = "ORDER BY started_at, id";
  switch (sel.kind) {
    case "call":
      where = " AND id = ?";
      args.push(sel.callId);
      break;
    case "step":
      where =
        " AND run_id = ? AND (step_key = ? OR substr(step_key, 1, length(?) + 1) = ? || '/')";
      args.push(sel.runId, sel.stepKey, sel.stepKey, sel.stepKey);
      break;
    case "run":
      where = " AND run_id = ?";
      args.push(sel.runId);
      if (sel.nodes) {
        where += ` AND node IN (${placeholders(sel.nodes.length)})`;
        args.push(...sel.nodes);
      }
      break;
    case "ids":
      if (sel.callIds.length === 0) return [];
      where = ` AND id IN (${placeholders(sel.callIds.length)})`;
      args.push(...sel.callIds);
      break;
    case "failed":
      where = " AND error_kind IS NOT NULL";
      order = "ORDER BY started_at DESC, id DESC";
      break;
    case "all":
      order = "ORDER BY started_at DESC, id DESC";
      break;
  }
  return db
    .prepare(`${base}${where} ${order} LIMIT ?`)
    .all(...args, limit) as unknown as CallDbRow[];
}

function loadLinks(
  db: DatabaseSync,
  key: RecordKey,
  callIds: number[],
  opts: ReadCallsOptions,
): Map<number, LlmLinkInfo[]> {
  const byCall = new Map<number, LlmLinkInfo[]>();
  if (callIds.length === 0) return byCall;
  const rows = db
    .prepare(
      `SELECT id, call_id, target_type, target_id, outcome, reason, applied_text, verdict_json
         FROM llm_call_links
        WHERE scope = ? AND scope_id = ? AND call_id IN (${placeholders(callIds.length)})
        ORDER BY id`,
    )
    .all(key.scope, key.scopeId, ...callIds) as unknown as LinkDbRow[];
  const runOfCall = new Map<number, { id: string; inputHash: string | null }>();
  if (opts.isStale) {
    const runs = db
      .prepare(
        `SELECT c.id AS call_id, r.id AS run_id, r.input_hash
           FROM llm_calls c JOIN llm_runs r ON r.id = c.run_id
          WHERE c.id IN (${placeholders(callIds.length)})`,
      )
      .all(...callIds) as unknown as {
      call_id: number;
      run_id: string;
      input_hash: string | null;
    }[];
    for (const r of runs) {
      runOfCall.set(r.call_id, { id: r.run_id, inputHash: r.input_hash });
    }
  }
  for (const row of rows) {
    if (
      opts.linkFilter &&
      (row.target_type !== opts.linkFilter.targetType ||
        row.target_id !== opts.linkFilter.targetId)
    ) {
      continue;
    }
    const run = runOfCall.get(row.call_id);
    const stale =
      row.target_type === "speaker" && opts.isStale && run
        ? opts.isStale({
            targetType: row.target_type,
            targetId: row.target_id,
            run,
          })
        : false;
    const link: LlmLinkInfo = {
      id: row.id,
      callId: row.call_id,
      targetType: row.target_type as LlmTargetType,
      targetId: row.target_id,
      outcome:
        row.outcome === "applied" || row.outcome === "dropped"
          ? row.outcome
          : "unknown",
      reason: row.reason,
      appliedText: row.applied_text,
      verdict: parseJson(row.verdict_json) as SpeakerVerdict | null,
      staleLabels: stale,
    };
    const list = byCall.get(row.call_id) ?? [];
    list.push(link);
    byCall.set(row.call_id, list);
  }
  return byCall;
}

function toSummary(row: CallDbRow, links: LlmLinkInfo[]): LlmCallSummary {
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    node: row.node,
    attempt: row.attempt,
    retryReason: row.retry_reason,
    provider: row.provider,
    requestedModel: row.requested_model,
    servedModel: row.served_model,
    finishUnified: row.finish_unified,
    finishRaw: row.finish_raw,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cachedTokens: row.cached_tokens,
    queuedMs: row.queued_ms,
    latencyMs: row.latency_ms,
    errorKind: errorKindOf(row.error_kind),
    errorDetail: row.error_detail,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    links,
  };
}

function toFull(
  db: DatabaseSync,
  key: RecordKey,
  row: CallDbRow,
  links: LlmLinkInfo[],
): LlmCallFull {
  const messages = parseJson(row.messages_json);
  const attempts = db
    .prepare(
      `SELECT id, attempt, finish_unified, error_kind, latency_ms
         FROM llm_calls
        WHERE scope = ? AND scope_id = ? AND run_id = ? AND step_key = ?
        ORDER BY attempt, id`,
    )
    .all(key.scope, key.scopeId, row.run_id, row.step_key) as unknown as {
    id: number;
    attempt: number;
    finish_unified: string | null;
    error_kind: string | null;
    latency_ms: number | null;
  }[];
  return {
    ...toSummary(row, links),
    messages: Array.isArray(messages) ? (messages as LlmMessage[]) : [],
    schema: {
      name: row.schema_name,
      version: row.schema_version,
      json: parseJson(row.schema_json),
    },
    params: parseJson(row.params_json) as LlmParamsLedger | null,
    rawText: row.raw_text,
    parsed: parseJson(row.parsed_json),
    reasoningChars: row.reasoning_chars,
    attempts: attempts.map((a) => ({
      callId: a.id,
      attempt: a.attempt,
      finishUnified: a.finish_unified,
      errorKind: errorKindOf(a.error_kind),
      latencyMs: a.latency_ms,
    })),
  };
}

/** Calls of the scope that match the selector. A run of another scope never appears. */
export function readCalls(
  db: DatabaseSync,
  key: RecordKey,
  sel: CallSelector,
  opts: ReadCallsOptions & { detail: "summary" },
): LlmCallSummary[];
export function readCalls(
  db: DatabaseSync,
  key: RecordKey,
  sel: CallSelector,
  opts: ReadCallsOptions & { detail: "full" },
): LlmCallFull[];
export function readCalls(
  db: DatabaseSync,
  key: RecordKey,
  sel: CallSelector,
  opts: ReadCallsOptions,
): LlmCallSummary[] | LlmCallFull[] {
  const rows = selectCallRows(db, key, sel, opts.limit);
  const links = loadLinks(
    db,
    key,
    rows.map((r) => r.id),
    opts,
  );
  if (opts.detail === "full") {
    return rows.map((r) => toFull(db, key, r, links.get(r.id) ?? []));
  }
  return rows.map((r) => toSummary(r, links.get(r.id) ?? []));
}
