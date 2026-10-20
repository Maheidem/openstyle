import type { MockLanguageModelV4 } from "ai/test";
import { vi } from "vitest";
import { getDb } from "../../src/lib/db.js";
import { createLlmRecorder } from "../../src/lib/llm/recorder.js";
import { hasJob } from "../../src/lib/meetings/job-registry.js";
import type { RunnerDeps } from "../../src/lib/meetings/workflow/runner.js";
import { okReply, type ScriptStep, seamFor } from "./fake-model.js";
import {
  instantSleep,
  type RecordedRequest,
  responderModel,
  type TagsAnswer,
  TEST_MODEL,
} from "./workflow-harness.js";

// Helpers for the tests that go through the real runner (WP5b). They sit beside
// the WP5a harness and do not edit it.

export const isIdentify = (r: RecordedRequest) =>
  r.system.includes("diarized labels");

/** The first `[segment id]` of a request. */
export const firstIdOf = (r: RecordedRequest): string =>
  /\[([^\]]+)\]/.exec(r.user)?.[1] ?? "";

/** A request of the `summarize` node: single, map or reduce. */
export const isSummaryRequest = (r: RecordedRequest) =>
  /^You (summarize|combine)/.test(r.system);

/** A valid summary answer. */
export const SUMMARY_ANSWER = okReply(
  JSON.stringify({
    overview: "The team agreed to ship on Friday.",
    keyPoints: ["Ship on Friday."],
    decisions: ["Ship on Friday."],
    actionItems: [],
    openQuestions: [],
  }),
);

/**
 * The correction that the default responder returns for a segment: the segment
 * text plus one word. It passes every correction guard (overlap, deletion,
 * length, negation).
 */
export const correctionText = (id: string) =>
  `${
    (
      getDb()
        .prepare("SELECT text FROM meeting_segments WHERE id = ?")
        .get(id) as { text: string }
    ).text
  } fixed`;

/**
 * The default answers: one correction for the first segment of a chunk, no
 * speaker proposals, and a valid summary. A test passes its own `answer` for the cases it cares
 * about and falls back to this for the rest.
 */
export function defaultAnswer(r: RecordedRequest): ScriptStep {
  if (isSummaryRequest(r)) return SUMMARY_ANSWER;
  if (isIdentify(r)) return okReply('{"speakers":[]}');
  const id = firstIdOf(r);
  return okReply(
    JSON.stringify({ corrections: [{ id, text: correctionText(id) }] }),
  );
}

export interface RunnerHarness {
  /** Pass it to `startRun`, `resumeRun` or `__setMeetingsTestOverrides`. */
  deps: RunnerDeps;
  /** The requests of every node except `suggestTags`. */
  requests: RecordedRequest[];
  /** The requests of `suggestTags` (issue #231). */
  tagRequests: RecordedRequest[];
  /** The scripted model behind `deps.createModel`. */
  model: MockLanguageModelV4;
}

/** Deps with a scripted model, an instant sleep and the real recorder. */
export function runnerHarness(
  o: {
    answer?: (r: RecordedRequest) => ScriptStep;
    tags?: TagsAnswer;
    deps?: RunnerDeps;
  } = {},
): RunnerHarness {
  const { model, requests, tagRequests } = responderModel(
    TEST_MODEL,
    o.answer ?? defaultAnswer,
    o.tags,
  );
  return {
    requests,
    tagRequests,
    model,
    deps: {
      createModel: seamFor(model),
      sleep: instantSleep,
      recorder: createLlmRecorder(getDb()),
      ...o.deps,
    },
  };
}

/**
 * Count the requests that reach a scripted model with a live signal. A request
 * that arrives with a signal that is already aborted never reaches the wire
 * with a real `fetch`, so it is not a request to the server.
 */
export function trackLiveRequests(model: MockLanguageModelV4): {
  live: number;
  aborted: number;
} {
  const t = { live: 0, aborted: 0 };
  const generate = model.doGenerate as (o: {
    abortSignal?: AbortSignal;
  }) => Promise<unknown>;
  (model as { doGenerate: unknown }).doGenerate = (o: {
    abortSignal?: AbortSignal;
  }) => {
    if (o.abortSignal?.aborted) t.aborted += 1;
    else t.live += 1;
    return generate(o);
  };
  return t;
}

/**
 * Hold the first request that reaches the scripted model until `release()`.
 * `reached` resolves when that request arrives. Later requests pass at once.
 */
export function holdFirstRequest(model: MockLanguageModelV4): {
  reached: Promise<void>;
  release: () => void;
} {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let held = false;
  const generate = model.doGenerate as (o: unknown) => Promise<unknown>;
  (model as { doGenerate: unknown }).doGenerate = async (o: unknown) => {
    if (!held) {
      held = true;
      reached.resolve();
      await gate.promise;
    }
    return generate(o);
  };
  return { reached: reached.promise, release: () => gate.resolve() };
}

/**
 * Wait until no job holds the slot. Advancing the fake timers by 1 ms lets
 * the 50 ms poll of a queued call and the other timers of the run fire.
 */
export async function waitForNoJob(meetingId: string): Promise<void> {
  for (let i = 0; i < 6000; i++) {
    if (!hasJob(meetingId)) return;
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error("the job never released its slot");
}

/** Wait until `cond` holds. Advances the fake timers. */
export async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 6000; i++) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error("the condition never held");
}

export interface RunRowView {
  id: string;
  kind: string;
  started_by: string;
  status: string;
  graph_version: number;
  input_hash: string | null;
  resume_count: number;
  error_kind: string | null;
  error_detail: string | null;
  result_json: string | null;
  lost_records: number;
  finished_at: number | null;
}

export function runRow(runId: string): RunRowView {
  return getDb()
    .prepare("SELECT * FROM llm_runs WHERE id = ?")
    .get(runId) as unknown as RunRowView;
}

export function runsOf(meetingId: string): RunRowView[] {
  return getDb()
    .prepare(
      "SELECT * FROM llm_runs WHERE scope_id = ? ORDER BY started_at, id",
    )
    .all(meetingId) as unknown as RunRowView[];
}

export function checkpointCount(runId: string): number {
  const db = getDb();
  const a = db
    .prepare("SELECT count(*) AS n FROM llm_checkpoints WHERE thread_id = ?")
    .get(runId) as { n: number };
  const b = db
    .prepare(
      "SELECT count(*) AS n FROM llm_checkpoint_writes WHERE thread_id = ?",
    )
    .get(runId) as { n: number };
  return a.n + b.n;
}

export function stepsOf(runId: string): {
  step_key: string;
  node: string;
  seq: number;
  status: string;
  error_kind: string | null;
}[] {
  return getDb()
    .prepare(
      "SELECT step_key, node, seq, status, error_kind FROM llm_run_steps WHERE run_id = ? ORDER BY seq",
    )
    .all(runId) as never;
}

export const LLM_TABLES = [
  "llm_runs",
  "llm_run_steps",
  "llm_calls",
  "llm_call_links",
  "llm_checkpoints",
  "llm_checkpoint_writes",
] as const;
