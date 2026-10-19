import type {
  CorrectionDropReason,
  DropReason,
  EvidenceType,
  LlmCallSummary,
  LlmLinkInfo,
  LlmParamsLedger,
  LlmRunInfo,
  LlmRunKind,
  LlmStepInfo,
} from "@openstyle/validations";
import { chunkNumber } from "./run-notice";

// Pure rules of the LLM inspector (specs/meeting-enhance-agentic.md 8.7, 10.10).
// No React, no i18n, no clock: the views pass data in and get back what to
// show. The views own the text, through the keys that these helpers name.

/** The one gate of every inspector entry (8.2 I2): the setting is the text "true". */
export function isAdvancedMode(value: string | null | undefined): boolean {
  return value === "true";
}

export { llmErrorKey as errorTextKey } from "./run-notice";

const VERDICT_CODES: ReadonlySet<string> = new Set<
  DropReason | CorrectionDropReason | EvidenceType
>([
  "unknown_label",
  "unknown_segment",
  "no_quote",
  "quote_too_long",
  "quote_not_in_segment",
  "empty_name",
  "name_not_in_quote",
  "not_self_introduction",
  "conflict_lost",
  "duplicate_same_name",
  "unknown_id",
  "duplicate_id",
  "empty_text",
  "unchanged",
  "format_only",
  "deletes_words",
  "too_different",
  "meaning_flip",
  "inflection_only",
  "self_introduction",
  "addressed_as",
  "role_detail",
]);

/**
 * The text key of a verdict code or a drop reason:
 * `meetings.inspector.verdict.<code>`. An unknown code gets the `unknown` text,
 * so the person never sees a raw internal code.
 */
export function verdictTextKey(code: string): string {
  return `meetings.inspector.verdict.${VERDICT_CODES.has(code) ? code : "unknown"}`;
}

/** The badge of a link: Kept, Dropped, or none when the outcome is unknown. */
export function linkBadgeKey(
  outcome: LlmLinkInfo["outcome"],
): "meetings.inspector.kept" | "meetings.inspector.dropped" | null {
  if (outcome === "applied") return "meetings.inspector.kept";
  if (outcome === "dropped") return "meetings.inspector.dropped";
  return null;
}

/** One name and value pair of the ledger, the value as text. */
export interface LedgerRow {
  name: string;
  value: string;
}

export interface LedgerView {
  /** Request fields: temperature, max_tokens, response_format. */
  topLevel: LedgerRow[];
  /** Fields the gateway added. A nested object gives one row for each leaf. */
  extraBody: LedgerRow[];
  /** Asked for and not sent, with the reason. */
  dropped: (LedgerRow & { reason: string })[];
  source: LlmParamsLedger["source"];
  structuredMode: LlmParamsLedger["structuredMode"];
  capturedFrom: LlmParamsLedger["capturedFrom"];
  warnings: string[];
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rows for a record. A nested object becomes dotted names: `chat_template_kwargs.enable_thinking`. */
function flattenRows(
  record: Record<string, unknown>,
  prefix = "",
): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const [key, value] of Object.entries(record)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      rows.push(...flattenRows(value, name));
    } else {
      rows.push({ name, value: valueText(value) });
    }
  }
  return rows;
}

/**
 * Group the params ledger of a call for display (8.7 Parameters). The request
 * fields keep their top-level names, so a person compares them with the logged
 * request body. Null when the ledger did not parse.
 */
export function groupLedger(
  params: LlmParamsLedger | null | undefined,
): LedgerView | null {
  if (!params) return null;
  return {
    topLevel: Object.entries(params.topLevel ?? {}).map(([name, value]) => ({
      name,
      value: valueText(value),
    })),
    extraBody: flattenRows(params.extraBody ?? {}),
    dropped: (params.dropped ?? []).map((d) => ({
      name: d.name,
      value: valueText(d.value),
      reason: d.reason,
    })),
    source: params.source,
    structuredMode: params.structuredMode,
    capturedFrom: params.capturedFrom,
    warnings: params.warnings ?? [],
  };
}

/**
 * True when a speaker link is the one the current suggestion came from (8.7
 * Speaker, "Current"): it was applied and its applied text equals the
 * suggestion.
 */
export function isCurrentLink(
  link: Pick<LlmLinkInfo, "outcome" | "appliedText">,
  currentSuggestion: string | null | undefined,
): boolean {
  return (
    link.outcome === "applied" &&
    link.appliedText !== null &&
    currentSuggestion != null &&
    link.appliedText === currentSuggestion
  );
}

/**
 * The call that produced the shown edit of a segment (8.12): the call that
 * holds an applied link to the segment. The route returns at most one call for
 * a segment target; the check keeps a wrong answer from showing as the cause.
 */
export function producingCall<T extends Pick<LlmCallSummary, "links">>(
  calls: readonly T[],
  segmentId: string,
): T | null {
  return (
    calls.find((call) =>
      call.links.some(
        (l) =>
          l.targetType === "segment" &&
          l.targetId === segmentId &&
          l.outcome === "applied",
      ),
    ) ?? null
  );
}

/** What a step key means to a person (4.0.7 grammar). */
export type StepLabel =
  | { kind: "single" }
  | { kind: "map"; n: number }
  | { kind: "reduce"; level: number; group: number }
  | { kind: "chunk"; n: number }
  | { kind: "other"; key: string };

/**
 * Parse a step or unit key. A half such as `map:2/0` is a part of its step, so
 * it gives the label of `map:2`. `map:2` is "Map 3": people count from 1.
 */
export function stepLabel(stepKey: string): StepLabel {
  const top = stepKey.split("/")[0];
  if (top === "single") return { kind: "single" };
  const map = /^map:(\d+)$/.exec(top);
  if (map) return { kind: "map", n: Number(map[1]) + 1 };
  const reduce = /^reduce:(\d+):(\d+)$/.exec(top);
  if (reduce) {
    return {
      kind: "reduce",
      level: Number(reduce[1]) + 1,
      group: Number(reduce[2]) + 1,
    };
  }
  const chunk = chunkNumber(top);
  if (chunk !== null) return { kind: "chunk", n: chunk };
  return { kind: "other", key: top };
}

/** True when the reduce steps of a list have several levels or groups, so the label needs both. */
export function reduceNeedsDetail(stepKeys: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const key of stepKeys) {
    const label = stepLabel(key);
    if (label.kind === "reduce") seen.add(`${label.level}:${label.group}`);
  }
  return seen.size > 1;
}

/** A failed step of a run and the run it belongs to (8.7 Runs view, "Failures"). */
export interface FailureEntry {
  run: LlmRunInfo;
  step: LlmStepInfo;
}

const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "partial",
  "interrupted",
]);

/**
 * The failures to list on top of the Runs view: each `failed`, `partial` or
 * `interrupted` step of the newest run of each kind, in start order. `runs`
 * is the list the route sends, newest first.
 */
export function failureEntries(runs: readonly LlmRunInfo[]): FailureEntry[] {
  const newest = new Map<LlmRunKind, LlmRunInfo>();
  for (const run of runs) {
    const best = newest.get(run.kind);
    if (!best || run.startedAt > best.startedAt) newest.set(run.kind, run);
  }
  const entries: FailureEntry[] = [];
  for (const run of newest.values()) {
    const steps = run.steps
      .filter((s) => FAILURE_STATUSES.has(s.status))
      .sort((a, b) => a.seq - b.seq);
    for (const step of steps) entries.push({ run, step });
  }
  return entries;
}

/**
 * The call a failure opens (8.7 Runs view): the last attempt of the step. For a
 * `partial` step that ran as halves (`chunk:3/0`, `chunk:3/1`), the last
 * attempt of the first half that ended in an error. Null when the step has no
 * call row. `calls` are the calls of the step in start order.
 */
export function failureCall<
  T extends Pick<LlmCallSummary, "stepKey" | "errorKind">,
>(calls: readonly T[]): T | null {
  if (calls.length === 0) return null;
  const lastOfUnit = new Map<string, T>();
  for (const call of calls) lastOfUnit.set(call.stepKey, call);
  for (const last of lastOfUnit.values()) {
    if (last.errorKind !== null) return last;
  }
  return calls[calls.length - 1];
}

/** Calls that ran but left no record: `attempts` above `recordedCalls` (8.7 Attempts). */
export function missingCalls(step: {
  attempts: number;
  recordedCalls: number;
}): number {
  return Math.max(0, step.attempts - step.recordedCalls);
}

/**
 * The finish reason line of a call: the unified value, and the raw value when
 * it differs. Null when the call has neither.
 */
export function finishText(call: {
  finishUnified: string | null;
  finishRaw: string | null;
}): string | null {
  const { finishUnified, finishRaw } = call;
  if (finishUnified === null) return finishRaw;
  if (finishRaw === null || finishRaw === finishUnified) return finishUnified;
  return `${finishUnified} (${finishRaw})`;
}

/** True when the served model is known and is not the requested model (8.7 Overview). */
export function isModelMismatch(call: {
  requestedModel: string | null;
  servedModel: string | null;
}): boolean {
  return (
    call.requestedModel !== null &&
    call.servedModel !== null &&
    call.requestedModel !== call.servedModel
  );
}
