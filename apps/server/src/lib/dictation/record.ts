// The call record of one dictation (specs/dictation-pipeline.md 4.6). Each LLM
// stage call is one `llm_calls` row of a run with scope "dictation", written
// by the same recorder as Enhance. The run is written in one transaction after
// the dictation, so a crash never leaves a "running" dictation run. Only the
// newest DICTATION_RUNS_KEPT runs stay.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createAppLogger } from "@openstyle/utils";
import { withTransaction } from "../db.js";
import type { DictationStepId } from "../llm/call-record.js";
import { createLlmRecorder } from "../llm/recorder.js";
import type { LlmStage } from "./pipeline.js";

const log = createAppLogger("dictation-record");

export const DICTATION_RUNS_KEPT = 200;

const NODE: Record<LlmStage, DictationStepId> = {
  cleanup: "dictationCleanup",
  polish: "dictationPolish",
  tone: "dictationTone",
};

export interface DictationCall {
  stage: LlmStage;
  provider: string;
  modelId: string;
  system: string;
  prompt: string;
  temperature: number | undefined;
  maxOutputTokens: number;
  /** The answer, or null when the call failed. */
  text: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  finishedAt: number;
}

/** Write the calls of one dictation. It never throws. Returns the run id or null. */
export function recordDictationCalls(
  db: DatabaseSync,
  calls: readonly DictationCall[],
): string | null {
  if (calls.length === 0) return null;
  const runId = randomUUID();
  const recorder = createLlmRecorder(db);
  try {
    withTransaction(db, () => {
      const startedAt = calls[0]?.startedAt ?? Date.now();
      if (
        recorder.startRun({
          id: runId,
          scope: "dictation",
          scopeId: runId,
          kind: "dictation",
          startedBy: "auto",
          graphVersion: 1,
          startedAt,
        }) !== "ok"
      ) {
        throw new Error("startRun failed");
      }
      calls.forEach((c, i) => {
        const key = `${c.stage}/${i + 1}`;
        recorder.startStep(runId, { key, node: NODE[c.stage] });
        recorder.startAttempt({ runId, stepKey: key });
        recorder.recordCall({
          runId,
          unitKey: key,
          node: NODE[c.stage],
          retryReason: null,
          provider: c.provider,
          modelRequested: c.modelId,
          modelServed: c.text === null ? null : c.modelId,
          instructions: c.system,
          messages: [{ role: "user", content: c.prompt }],
          schema: { name: "text", version: 1, json: null },
          params: {
            topLevel: {
              ...(c.temperature !== undefined
                ? { temperature: c.temperature }
                : {}),
              max_tokens: c.maxOutputTokens,
            },
            extraBody: {},
            dropped: [],
            source: { mode: "auto" },
            capturedFrom: "sdk_request",
            warnings: [],
            structuredMode: "prompt_only",
          },
          rawText: c.text,
          parsed: null,
          reasoningChars: null,
          finishUnified: c.text === null ? "error" : "stop",
          finishRaw: c.text === null ? null : "stop",
          usage: {
            input: c.inputTokens,
            output: c.outputTokens,
            reasoning: null,
            cached: null,
          },
          queuedMs: null,
          latencyMs: c.finishedAt - c.startedAt,
          errorKind: c.text === null ? "provider_unavailable" : null,
          errorDetail: c.error,
          startedAt: c.startedAt,
          finishedAt: c.finishedAt,
        });
        recorder.finishStep(
          runId,
          key,
          c.text === null ? "failed" : "succeeded",
          c.text === null
            ? { kind: "provider_unavailable", detail: c.error ?? "" }
            : undefined,
        );
      });
      const failed = calls.filter((c) => c.text === null).length;
      recorder.finishRun(
        runId,
        failed === 0
          ? "succeeded"
          : failed === calls.length
            ? "failed"
            : "partial",
        {
          errorKind: null,
          errorDetail: null,
          result: null,
          lostRecords: 0,
          finishedAt: calls[calls.length - 1]?.finishedAt ?? Date.now(),
        },
      );
      db.prepare(
        `DELETE FROM llm_runs
          WHERE scope = 'dictation'
            AND id NOT IN (SELECT id FROM llm_runs WHERE scope = 'dictation'
                            ORDER BY started_at DESC LIMIT ?)`,
      ).run(DICTATION_RUNS_KEPT);
    });
    return runId;
  } catch (err) {
    log.warn(`the dictation call record was not written: ${String(err)}`);
    return null;
  }
}
