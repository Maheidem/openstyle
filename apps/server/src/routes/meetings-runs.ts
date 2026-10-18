/**
 * `GET /api/meetings/:id/llm-runs` and `GET /api/meetings/:id/llm-calls` — the
 * LLM call record of one meeting (specs/meeting-enhance-agentic.md 8.3), and
 * `POST /api/meetings/:id/runs/:runId/resume` (3.4.2).
 *
 * These are the meeting adapter of a generic record API: each handler checks
 * that the meeting exists, then calls the scope-generic reader
 * (`lib/llm/record-read.ts`) with `scope = 'meeting'`, `scope_id = :id`. The
 * meeting-only parts (which call made a text, the stale-label check) live in
 * `lib/meetings/llm-record-read.ts`. A meeting delete removes its record
 * through the `llm_runs.meeting_id` cascade, so these routes have no delete
 * code. The server has no `advanced_mode` gate: the renderer decides.
 *
 * Mounted as a sibling router at the same `/meetings` prefix
 * (`routes/index.ts`), like `meetings-import.ts`.
 */

import { zValidator } from "@hono/zod-validator";
import type {
  LlmCallsResponse,
  LlmRunListResponse,
  StartRunResponse,
} from "@openstyle/validations";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../lib/db.js";
import {
  type CallSelector,
  latestRuns,
  listRuns,
  readCalls,
  readRun,
} from "../lib/llm/record-read.js";
import {
  MEETING_LLM_NODES,
  MEETING_SUMMARY_NODE,
  meetingScope,
} from "../lib/meetings/llm-record.js";
import {
  findSegmentCallId,
  findSpeakerRunId,
  findSummaryRunId,
  speakerProposalCallIds,
  speakerStaleCheck,
} from "../lib/meetings/llm-record-read.js";
import { getMeetingRow } from "../lib/meetings/store.js";
import { resumeRun } from "../lib/meetings/workflow/runner.js";
import { getWorkflowTestDeps } from "./meetings.js";

const DEFAULT_RUNS_LIMIT = 10;
const DEFAULT_CALLS_LIMIT = 20;
// detail=full answers 400 when limit is above this value. It does not clamp.
// tests/meetings-runs.test.ts pins this rule (limit=11).
const MAX_FULL_CALLS = 10;

const runsQuerySchema = z.object({
  run_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  latest: z.literal("1").optional(),
});

const callsQuerySchema = z.object({
  call_id: z.coerce.number().int().positive().optional(),
  run_id: z.string().min(1).optional(),
  step_key: z.string().min(1).optional(),
  target_type: z.enum(["segment", "speaker", "summary"]).optional(),
  target_id: z.string().min(1).optional(),
  failed: z.literal("1").optional(),
  detail: z.enum(["summary", "full"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

type CallsQuery = z.infer<typeof callsQuerySchema>;

type Selection =
  | { error: string }
  | {
      kind: "call" | "step" | "target" | "run" | "failed" | "none";
    };

/** Exactly one selector, or none. A mixed query is an error. */
function classifySelector(q: CallsQuery): Selection {
  const hasTarget = q.target_type !== undefined || q.target_id !== undefined;
  const used = [
    q.call_id !== undefined,
    q.step_key !== undefined,
    hasTarget,
    q.failed !== undefined,
    // run_id alone is a selector. Beside step_key it is part of one.
    q.run_id !== undefined && q.step_key === undefined,
  ].filter(Boolean).length;
  if (used > 1) {
    return {
      error:
        "Use one selector: call_id, run_id with step_key, target_type with target_id, run_id, or failed.",
    };
  }
  if (q.call_id !== undefined) return { kind: "call" };
  if (q.step_key !== undefined) {
    return q.run_id === undefined
      ? { error: "step_key needs run_id." }
      : { kind: "step" };
  }
  if (hasTarget) {
    if (q.target_type === undefined) {
      return { error: "target_id needs target_type." };
    }
    if (q.target_type !== "summary" && q.target_id === undefined) {
      return { error: "target_id is required for this target_type." };
    }
    return { kind: "target" };
  }
  if (q.failed !== undefined) return { kind: "failed" };
  if (q.run_id !== undefined) return { kind: "run" };
  return { kind: "none" };
}

const meetingsRuns = new Hono()
  // Resume an interrupted run (specs/meeting-enhance-agentic.md 3.4.2, 3.4.7).
  // 202 with the run id, 404 for an unknown meeting or run, 409 with the reason
  // of the guard that refused it.
  .post("/:id/runs/:runId/resume", async (c) => {
    const id = c.req.param("id");
    const result = await resumeRun(
      id,
      c.req.param("runId"),
      getWorkflowTestDeps(),
    );
    if (result.ok) {
      return c.json(
        { ok: true, id, runId: result.runId } satisfies StartRunResponse,
        202,
      );
    }
    if (result.status === 404) return c.json({ error: result.error }, 404);
    return c.json(result.conflict, 409);
  })
  .get("/:id/llm-runs", zValidator("query", runsQuerySchema), (c) => {
    const id = c.req.param("id");
    if (!getMeetingRow(id)) return c.json({ error: "Not found" }, 404);
    const q = c.req.valid("query");
    if (
      q.latest !== undefined &&
      (q.run_id !== undefined || q.limit !== undefined)
    ) {
      return c.json({ error: "latest excludes run_id and limit." }, 400);
    }
    const db = getDb();
    const key = meetingScope(id);
    if (q.latest !== undefined) {
      return c.json({
        runs: latestRuns(db, key, MEETING_LLM_NODES),
      } satisfies LlmRunListResponse);
    }
    if (q.run_id !== undefined) {
      const run = readRun(db, key, q.run_id, MEETING_LLM_NODES);
      if (!run) return c.json({ error: "Not found" }, 404);
      return c.json({ runs: [run] } satisfies LlmRunListResponse);
    }
    return c.json({
      runs: listRuns(db, key, q.limit ?? DEFAULT_RUNS_LIMIT, MEETING_LLM_NODES),
    } satisfies LlmRunListResponse);
  })
  .get("/:id/llm-calls", zValidator("query", callsQuerySchema), (c) => {
    const id = c.req.param("id");
    if (!getMeetingRow(id)) return c.json({ error: "Not found" }, 404);
    const q = c.req.valid("query");
    const selection = classifySelector(q);
    if ("error" in selection) return c.json({ error: selection.error }, 400);

    const detail = q.detail ?? "summary";
    if (detail === "full") {
      if (!["call", "step", "target"].includes(selection.kind)) {
        return c.json(
          {
            error:
              "detail=full needs call_id, run_id with step_key, or target_type with target_id.",
          },
          400,
        );
      }
      if (q.limit !== undefined && q.limit > MAX_FULL_CALLS) {
        return c.json(
          { error: `limit is at most ${MAX_FULL_CALLS} with detail=full.` },
          400,
        );
      }
    }
    const limit =
      q.limit ?? (detail === "full" ? MAX_FULL_CALLS : DEFAULT_CALLS_LIMIT);

    const db = getDb();
    const key = meetingScope(id);
    const opts = { limit, isStale: speakerStaleCheck(db, id) };
    let selector: CallSelector;
    let linkFilter:
      | { targetType: "segment" | "speaker"; targetId: string }
      | undefined;
    switch (selection.kind) {
      case "call":
        selector = { kind: "call", callId: q.call_id as number };
        break;
      case "step":
        selector = {
          kind: "step",
          runId: q.run_id as string,
          stepKey: q.step_key as string,
        };
        break;
      case "run":
        selector = { kind: "run", runId: q.run_id as string };
        break;
      case "failed":
        selector = { kind: "failed" };
        break;
      case "none":
        selector = { kind: "all" };
        break;
      case "target": {
        const targetId = q.target_id as string;
        if (q.target_type === "segment") {
          const callId = findSegmentCallId(db, id, targetId);
          selector = { kind: "ids", callIds: callId === null ? [] : [callId] };
          linkFilter = { targetType: "segment", targetId };
        } else if (q.target_type === "speaker") {
          const runId = findSpeakerRunId(db, id, targetId);
          selector = {
            kind: "ids",
            callIds:
              runId === null
                ? []
                : speakerProposalCallIds(db, id, targetId, runId),
          };
          linkFilter = { targetType: "speaker", targetId };
        } else {
          // The summary calls of the run that made the current summary.
          const runId = findSummaryRunId(db, id);
          selector =
            runId === null
              ? { kind: "ids", callIds: [] }
              : { kind: "run", runId, nodes: [MEETING_SUMMARY_NODE] };
        }
        break;
      }
    }

    const response: LlmCallsResponse =
      detail === "full"
        ? {
            detail: "full",
            calls: readCalls(db, key, selector, {
              ...opts,
              detail: "full",
              linkFilter,
            }),
          }
        : {
            detail: "summary",
            calls: readCalls(db, key, selector, {
              ...opts,
              detail: "summary",
              linkFilter,
            }),
          };
    return c.json(response);
  });

export default meetingsRuns;
