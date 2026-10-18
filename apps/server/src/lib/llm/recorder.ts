import type { DatabaseSync } from "node:sqlite";
import { createAppLogger } from "@openstyle/utils";
import type {
  LlmParamsLedger,
  LlmRunKind,
  LlmRunStatus,
  LlmScope,
  LlmStepStatus,
  LlmTargetType,
} from "@openstyle/validations";
import { withTransaction } from "../db.js";
import { redact } from "../trace.js";
import type {
  CallRecord,
  CallSink,
  RecordedCall,
  TokenUsage,
} from "./call-record.js";

const log = createAppLogger("llm-recorder");

// The recorder is the only writer of `llm_runs`, `llm_run_steps`, `llm_calls`
// and `llm_call_links` (specs/meeting-enhance-agentic.md 7.7). It is generic:
// it knows a scope and a scope id, never a meeting. Every method catches its
// errors and returns. A failed record write never fails the run.

/** A text column is cut at this length. */
const MAX_TEXT_CHARS = 500_000;

function cap(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n[cut: ${text.length - MAX_TEXT_CHARS} characters]`;
}

function capOrNull(text: string | null | undefined): string | null {
  return text == null ? null : cap(text);
}

/** `JSON.stringify` that gives null for undefined and null. */
function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return cap(JSON.stringify(value));
}

export interface NewRun {
  /** = thread_id. */
  id: string;
  scope: LlmScope;
  /** Scope "meeting": also written to meeting_id. Other scopes: meeting_id NULL. */
  scopeId: string;
  kind: LlmRunKind;
  startedBy: "auto" | "button";
  graphVersion: number;
  /** Epoch ms. */
  startedAt: number;
}

export interface RunFinish {
  errorKind: string | null;
  errorDetail: string | null;
  /** Written to result_json. */
  result: unknown | null;
  lostRecords: number;
  /** Epoch ms. Also written to updated_at. */
  finishedAt: number;
}

export interface NewLink {
  targetType: LlmTargetType;
  targetId: string;
  /** Index of the entry in the call output. 0 for a summary link. */
  seq: number;
  outcome: "applied" | "dropped";
  reason: string | null;
  appliedText: string | null;
  /** Written to verdict_json. */
  verdict: unknown | null;
}

/** A finished call that `callUnit` reuses after a resume. */
export interface ParsedCall {
  callId: number;
  attempt: number;
  parsed: unknown;
  rawFinishReason: string;
  usage: TokenUsage;
  provider: string | null;
  modelRequested: string;
  modelServed: string | null;
  queuedMs: number | null;
  latencyMs: number | null;
  params: LlmParamsLedger;
}

export interface LlmRecorder extends CallSink {
  /** "no_scope": FK failure, the scope owner is gone. */
  startRun(r: NewRun): "ok" | "no_scope" | "error";
  finishRun(id: string, status: LlmRunStatus, f: RunFinish): void;
  setInputHash(id: string, hash: string): void;
  markResumed(id: string): void;
  startStep(runId: string, step: { key: string; node: string }): void;
  finishStep(
    runId: string,
    key: string,
    status: LlmStepStatus,
    err?: { kind: string; detail: string },
  ): void;
  /** Null when none, cut, or a JSON column does not parse. */
  finishedCall(runId: string, unitKey: string): ParsedCall | null;
  /** Joins the open transaction. */
  linkCall(callId: number, links: NewLink[]): void;
  /** "running" to "interrupted". Returns the run count. */
  sweepInterrupted(): number;
}

function isForeignKeyError(err: unknown): boolean {
  return err instanceof Error && /FOREIGN KEY/i.test(err.message);
}

/** Delete the checkpoint rows of one thread (a run id). */
function deleteThreadRows(db: DatabaseSync, threadId: string): void {
  db.prepare("DELETE FROM llm_checkpoint_writes WHERE thread_id = ?").run(
    threadId,
  );
  db.prepare("DELETE FROM llm_checkpoints WHERE thread_id = ?").run(threadId);
}

interface CallRow {
  id: number;
  attempt: number;
  parsed_json: string | null;
  params_json: string;
  finish_raw: string | null;
  provider: string | null;
  requested_model: string | null;
  served_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  queued_ms: number | null;
  latency_ms: number | null;
}

export function createLlmRecorder(db: DatabaseSync): LlmRecorder {
  return {
    startRun(r) {
      try {
        const insert = () => {
          db.prepare(
            `INSERT INTO llm_runs
               (id, scope, scope_id, meeting_id, kind, started_by, status,
                graph_version, input_hash, resume_count, result_json,
                lost_records, error_kind, error_detail,
                started_at, updated_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL, 0, NULL, 0, NULL, NULL, ?, ?, NULL)`,
          ).run(
            r.id,
            r.scope,
            r.scopeId,
            r.scope === "meeting" ? r.scopeId : null,
            r.kind,
            r.startedBy,
            r.graphVersion,
            r.startedAt,
            r.startedAt,
          );
          // A new run replaces an older interrupted run of the same stages:
          // the screen offers Resume first, so a start is the user's choice to
          // begin again (3.4.2 step 2). The checkpoints go with it.
          const older = db
            .prepare(
              `SELECT id FROM llm_runs
                WHERE scope = ? AND scope_id = ? AND kind = ?
                  AND status = 'interrupted' AND id <> ?`,
            )
            .all(r.scope, r.scopeId, r.kind, r.id) as { id: string }[];
          for (const { id } of older) {
            db.prepare(
              "UPDATE llm_runs SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ?",
            ).run(r.startedAt, r.startedAt, id);
            deleteThreadRows(db, id);
          }
        };
        if (db.isTransaction) insert();
        else withTransaction(db, insert);
        return "ok";
      } catch (err) {
        if (isForeignKeyError(err)) {
          log.debug(`startRun: scope owner is gone (run ${r.id})`);
          return "no_scope";
        }
        log.warn(`startRun failed (run ${r.id}): ${String(err)}`);
        return "error";
      }
    },

    finishRun(id, status, f) {
      try {
        db.prepare(
          `UPDATE llm_runs
              SET status = ?, error_kind = ?, error_detail = ?, result_json = ?,
                  lost_records = ?, finished_at = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          status,
          f.errorKind,
          capOrNull(f.errorDetail),
          jsonOrNull(f.result),
          f.lostRecords,
          f.finishedAt,
          f.finishedAt,
          id,
        );
      } catch (err) {
        log.warn(`finishRun failed (run ${id}): ${String(err)}`);
      }
    },

    setInputHash(id, hash) {
      try {
        db.prepare("UPDATE llm_runs SET input_hash = ? WHERE id = ?").run(
          hash,
          id,
        );
      } catch (err) {
        log.warn(`setInputHash failed (run ${id}): ${String(err)}`);
      }
    },

    markResumed(id) {
      try {
        db.prepare(
          `UPDATE llm_runs
              SET status = 'running', resume_count = resume_count + 1,
                  updated_at = ?, finished_at = NULL
            WHERE id = ?`,
        ).run(Date.now(), id);
      } catch (err) {
        log.warn(`markResumed failed (run ${id}): ${String(err)}`);
      }
    },

    startStep(runId, step) {
      try {
        // First call for a key inserts with the next seq. A later call sets
        // `running` and keeps seq and attempts.
        db.prepare(
          `INSERT INTO llm_run_steps
             (run_id, step_key, node, seq, status, attempts, started_at)
           VALUES (?, ?, ?,
             (SELECT COALESCE(MAX(seq), 0) + 1 FROM llm_run_steps WHERE run_id = ?),
             'running', 0, ?)
           ON CONFLICT(run_id, step_key) DO UPDATE SET
             status = 'running', error_kind = NULL, error_detail = NULL,
             finished_at = NULL`,
        ).run(runId, step.key, step.node, runId, Date.now());
      } catch (err) {
        log.warn(`startStep failed (run ${runId}): ${String(err)}`);
      }
    },

    startAttempt({ runId, stepKey }) {
      try {
        // The step key equals the unit key, or is its prefix before "/".
        db.prepare(
          `UPDATE llm_run_steps SET attempts = attempts + 1
            WHERE run_id = ?1
              AND (step_key = ?2 OR substr(?2, 1, length(step_key) + 1) = step_key || '/')`,
        ).run(runId, stepKey);
      } catch (err) {
        log.warn(`startAttempt failed (run ${runId}): ${String(err)}`);
      }
    },

    finishStep(runId, key, status, err) {
      try {
        db.prepare(
          `UPDATE llm_run_steps
              SET status = ?, error_kind = ?, error_detail = ?, finished_at = ?
            WHERE run_id = ? AND step_key = ?`,
        ).run(
          status,
          err?.kind ?? null,
          capOrNull(err?.detail),
          Date.now(),
          runId,
          key,
        );
      } catch (e) {
        log.warn(`finishStep failed (run ${runId}): ${String(e)}`);
      }
    },

    recordCall(c: CallRecord): RecordedCall | null {
      try {
        const messages = [
          { role: "system", content: c.instructions },
          ...c.messages,
        ];
        // scope and scope_id come from the run row. No run row: no insert.
        const result = db
          .prepare(
            `INSERT INTO llm_calls
               (run_id, scope, scope_id, step_key, node, attempt, retry_reason,
                provider, requested_model, served_model, messages_json,
                schema_name, schema_version, schema_json, params_json,
                raw_text, parsed_json, finish_unified, finish_raw,
                input_tokens, output_tokens, reasoning_tokens, cached_tokens,
                reasoning_chars, queued_ms, latency_ms, error_kind, error_detail,
                started_at, finished_at)
             SELECT r.id, r.scope, r.scope_id, ?2, ?3,
                (SELECT count(*) FROM llm_calls x WHERE x.run_id = r.id AND x.step_key = ?2) + 1,
                ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27
               FROM llm_runs r WHERE r.id = ?1`,
          )
          .run(
            c.runId,
            c.unitKey,
            c.node,
            c.retryReason,
            c.provider,
            c.modelRequested,
            c.modelServed,
            cap(JSON.stringify(messages)),
            c.schema.name,
            c.schema.version,
            cap(JSON.stringify(c.schema.json) ?? "null"),
            // Mask like the trace log: Authorization and api_key values.
            cap(JSON.stringify(redact(c.params))),
            capOrNull(c.rawText),
            jsonOrNull(c.parsed),
            c.finishUnified,
            c.finishRaw,
            c.usage.input,
            c.usage.output,
            c.usage.reasoning,
            c.usage.cached,
            c.reasoningChars,
            c.queuedMs,
            c.latencyMs,
            c.errorKind,
            capOrNull(c.errorDetail),
            c.startedAt,
            c.finishedAt,
          );
        if (Number(result.changes) === 0) {
          log.debug(`recordCall: run ${c.runId} is gone`);
          return null;
        }
        const id = Number(result.lastInsertRowid);
        const row = db
          .prepare("SELECT attempt FROM llm_calls WHERE id = ?")
          .get(id) as { attempt: number } | undefined;
        return row ? { id, attempt: row.attempt } : null;
      } catch (err) {
        if (isForeignKeyError(err)) {
          log.debug(`recordCall: scope owner is gone (run ${c.runId})`);
        } else {
          log.warn(`recordCall failed (run ${c.runId}): ${String(err)}`);
        }
        return null;
      }
    },

    finishedCall(runId, unitKey) {
      try {
        const row = db
          .prepare(
            `SELECT id, attempt, parsed_json, params_json, finish_raw, provider,
                    requested_model, served_model, input_tokens, output_tokens,
                    reasoning_tokens, cached_tokens, queued_ms, latency_ms
               FROM llm_calls
              WHERE run_id = ? AND step_key = ? AND error_kind IS NULL
              ORDER BY id DESC LIMIT 1`,
          )
          .get(runId, unitKey) as CallRow | undefined;
        if (!row || row.finish_raw === null || row.parsed_json === null) {
          return null;
        }
        // A cut column does not parse, so a cut call is never reused.
        return {
          callId: row.id,
          attempt: row.attempt,
          parsed: JSON.parse(row.parsed_json) as unknown,
          rawFinishReason: row.finish_raw,
          usage: {
            input: row.input_tokens,
            output: row.output_tokens,
            reasoning: row.reasoning_tokens,
            cached: row.cached_tokens,
          },
          provider: row.provider,
          modelRequested: row.requested_model ?? "",
          modelServed: row.served_model,
          queuedMs: row.queued_ms,
          latencyMs: row.latency_ms,
          params: JSON.parse(row.params_json) as LlmParamsLedger,
        };
      } catch (err) {
        log.debug(
          `finishedCall: no reusable call (run ${runId}): ${String(err)}`,
        );
        return null;
      }
    },

    linkCall(callId, links) {
      // One link fails alone. The caller's transaction still commits.
      for (const l of links) {
        try {
          db.prepare(
            `INSERT INTO llm_call_links
               (call_id, scope, scope_id, target_type, target_id, seq,
                outcome, reason, applied_text, verdict_json, created_at)
             SELECT c.id, c.scope, c.scope_id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
               FROM llm_calls c WHERE c.id = ?1
             ON CONFLICT(call_id, target_type, target_id, seq) DO UPDATE SET
               outcome = excluded.outcome, reason = excluded.reason,
               applied_text = excluded.applied_text,
               verdict_json = excluded.verdict_json,
               created_at = excluded.created_at`,
          ).run(
            callId,
            l.targetType,
            l.targetId,
            l.seq,
            l.outcome,
            l.reason,
            l.appliedText,
            jsonOrNull(l.verdict),
            Date.now(),
          );
        } catch (err) {
          log.warn(`linkCall failed (call ${callId}): ${String(err)}`);
        }
      }
    },

    sweepInterrupted() {
      try {
        const now = Date.now();
        const sweep = (): number => {
          db.prepare(
            `UPDATE llm_run_steps SET status = 'interrupted', finished_at = ?
              WHERE status = 'running'
                AND run_id IN (SELECT id FROM llm_runs WHERE status = 'running')`,
          ).run(now);
          const runs = db
            .prepare(
              `UPDATE llm_runs
                  SET status = 'interrupted', updated_at = ?, finished_at = ?
                WHERE status = 'running'`,
            )
            .run(now, now);
          return Number(runs.changes);
        };
        return db.isTransaction ? sweep() : withTransaction(db, sweep);
      } catch (err) {
        log.warn(`sweepInterrupted failed: ${String(err)}`);
        return 0;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Run administration for the runner (specs/meeting-enhance-agentic.md 3.4.6,
// 3.4.7). Reads of the run row, the boot sweep and the checkpoint tables. It
// is a separate interface from `LlmRecorder`: the call path never needs it, and
// a test recorder for a node test need not implement it. Like the recorder it
// never throws.
// ---------------------------------------------------------------------------

/** A run row as the runner reads it. */
export interface RunRow {
  id: string;
  scope: LlmScope;
  scopeId: string;
  kind: LlmRunKind;
  startedBy: "auto" | "button";
  status: LlmRunStatus;
  graphVersion: number;
  inputHash: string | null;
  resumeCount: number;
  errorKind: string | null;
  errorDetail: string | null;
}

interface RunDbRow {
  id: string;
  scope: string;
  scope_id: string;
  kind: string;
  started_by: string;
  status: string;
  graph_version: number;
  input_hash: string | null;
  resume_count: number;
  error_kind: string | null;
  error_detail: string | null;
}

function toRunRow(r: RunDbRow): RunRow {
  return {
    id: r.id,
    scope: r.scope as LlmScope,
    scopeId: r.scope_id,
    kind: r.kind as LlmRunKind,
    startedBy: r.started_by as "auto" | "button",
    status: r.status as LlmRunStatus,
    graphVersion: r.graph_version,
    inputHash: r.input_hash,
    resumeCount: r.resume_count,
    errorKind: r.error_kind,
    errorDetail: r.error_detail,
  };
}

const RUN_COLUMNS = `id, scope, scope_id, kind, started_by, status,
  graph_version, input_hash, resume_count, error_kind, error_detail`;

export interface RunAdmin {
  /** Null when no row exists. */
  getRun(id: string): RunRow | null;
  /** `interrupted` runs with no failure and fewer than `maxResumes` resumes. Oldest first. */
  listAutoResumable(maxResumes: number): RunRow[];
  hasCheckpoint(runId: string): boolean;
  /** Delete the checkpoint rows of the thread (3.4.6 step 5). */
  deleteCheckpoints(runId: string): void;
  /** Close the step rows still `running`. */
  closeOpenSteps(
    runId: string,
    status: "cancelled" | "interrupted" | "failed",
    err?: { kind: string; detail: string },
  ): void;
  /**
   * The boot sweep (3.4.7). A `running` run with a checkpoint becomes
   * `interrupted`. One without becomes `failed` with
   * `interrupted_before_checkpoint`. Synchronous SQL only.
   */
  sweepOrphans(): { interrupted: number; failed: number };
}

export function createRunAdmin(db: DatabaseSync): RunAdmin {
  return {
    getRun(id) {
      try {
        const row = db
          .prepare(`SELECT ${RUN_COLUMNS} FROM llm_runs WHERE id = ?`)
          .get(id) as RunDbRow | undefined;
        return row ? toRunRow(row) : null;
      } catch (err) {
        log.warn(`getRun failed (run ${id}): ${String(err)}`);
        return null;
      }
    },

    listAutoResumable(maxResumes) {
      try {
        const rows = db
          .prepare(
            `SELECT ${RUN_COLUMNS} FROM llm_runs
              WHERE status = 'interrupted' AND error_kind IS NULL
                AND resume_count < ?
              ORDER BY started_at, id`,
          )
          .all(maxResumes) as unknown as RunDbRow[];
        return rows.map(toRunRow);
      } catch (err) {
        log.warn(`listAutoResumable failed: ${String(err)}`);
        return [];
      }
    },

    hasCheckpoint(runId) {
      try {
        return (
          db
            .prepare(
              "SELECT 1 AS one FROM llm_checkpoints WHERE thread_id = ? LIMIT 1",
            )
            .get(runId) !== undefined
        );
      } catch (err) {
        log.warn(`hasCheckpoint failed (run ${runId}): ${String(err)}`);
        return false;
      }
    },

    deleteCheckpoints(runId) {
      try {
        deleteThreadRows(db, runId);
      } catch (err) {
        log.warn(`deleteCheckpoints failed (run ${runId}): ${String(err)}`);
      }
    },

    closeOpenSteps(runId, status, err) {
      try {
        db.prepare(
          `UPDATE llm_run_steps
              SET status = ?, error_kind = ?, error_detail = ?, finished_at = ?
            WHERE run_id = ? AND status = 'running'`,
        ).run(
          status,
          err?.kind ?? null,
          capOrNull(err?.detail),
          Date.now(),
          runId,
        );
      } catch (e) {
        log.warn(`closeOpenSteps failed (run ${runId}): ${String(e)}`);
      }
    },

    sweepOrphans() {
      const out = { interrupted: 0, failed: 0 };
      try {
        const sweep = () => {
          const now = Date.now();
          const running = db
            .prepare("SELECT id FROM llm_runs WHERE status = 'running'")
            .all() as { id: string }[];
          for (const { id } of running) {
            const has =
              db
                .prepare(
                  "SELECT 1 AS one FROM llm_checkpoints WHERE thread_id = ? LIMIT 1",
                )
                .get(id) !== undefined;
            if (has) {
              db.prepare(
                `UPDATE llm_run_steps SET status = 'interrupted', finished_at = ?
                  WHERE run_id = ? AND status = 'running'`,
              ).run(now, id);
              db.prepare(
                `UPDATE llm_runs SET status = 'interrupted', updated_at = ?, finished_at = ?
                  WHERE id = ?`,
              ).run(now, now, id);
              out.interrupted += 1;
            } else {
              db.prepare(
                `UPDATE llm_run_steps
                    SET status = 'failed', error_kind = 'interrupted_before_checkpoint',
                        finished_at = ?
                  WHERE run_id = ? AND status = 'running'`,
              ).run(now, id);
              db.prepare(
                `UPDATE llm_runs
                    SET status = 'failed', error_kind = 'interrupted_before_checkpoint',
                        error_detail = 'The app stopped before the first checkpoint.',
                        updated_at = ?, finished_at = ?
                  WHERE id = ?`,
              ).run(now, now, id);
              out.failed += 1;
            }
          }
        };
        if (db.isTransaction) sweep();
        else withTransaction(db, sweep);
      } catch (err) {
        log.warn(`sweepOrphans failed: ${String(err)}`);
      }
      return out;
    },
  };
}
