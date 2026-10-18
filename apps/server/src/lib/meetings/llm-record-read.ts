import type { DatabaseSync } from "node:sqlite";
import type { StaleCheck } from "../llm/record-read.js";
import { hashVariantOf, inputHash, loadHashRows } from "./input-hash.js";

// The meeting queries of the LLM call record (specs/meeting-enhance-agentic.md
// 7.8). A link stays when its target changes, so each query checks the link
// against the current target value. These read the generic link table by
// `scope = 'meeting'` and join the meeting tables. The platform reader
// (`llm/record-read.ts`) cannot hold them.

/** The call that made the current `enhanced_text` of a segment, or null. */
export function findSegmentCallId(
  db: DatabaseSync,
  meetingId: string,
  segmentId: string,
): number | null {
  const row = db
    .prepare(
      `SELECT l.id, l.call_id FROM llm_call_links l
         JOIN meeting_segments s ON s.id = l.target_id AND s.meeting_id = l.scope_id
        WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'segment' AND l.target_id = ?
          AND l.outcome = 'applied' AND l.applied_text = s.enhanced_text
        ORDER BY l.created_at DESC, l.id DESC LIMIT 1`,
    )
    .get(meetingId, segmentId) as { call_id: number } | undefined;
  return row ? row.call_id : null;
}

/**
 * The run that produced the current suggestion of a speaker label. Else the
 * newest run that made any proposal for the label (all proposals dropped).
 */
export function findSpeakerRunId(
  db: DatabaseSync,
  meetingId: string,
  label: string,
): string | null {
  const producing = db
    .prepare(
      `SELECT l.call_id, c.run_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
         JOIN meeting_speakers s ON s.meeting_id = l.scope_id AND s.speaker_label = l.target_id
        WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'speaker' AND l.target_id = ?
          AND l.outcome = 'applied' AND l.applied_text = s.suggested_name
        ORDER BY l.created_at DESC, l.id DESC LIMIT 1`,
    )
    .get(meetingId, label) as { run_id: string } | undefined;
  if (producing) return producing.run_id;
  const newest = db
    .prepare(
      `SELECT c.run_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
        WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'speaker' AND l.target_id = ?
        ORDER BY c.started_at DESC, l.id DESC LIMIT 1`,
    )
    .get(meetingId, label) as { run_id: string } | undefined;
  return newest ? newest.run_id : null;
}

/** The calls of one run that made a proposal for the label, in call order. */
export function speakerProposalCallIds(
  db: DatabaseSync,
  meetingId: string,
  label: string,
  runId: string,
): number[] {
  const rows = db
    .prepare(
      `SELECT l.call_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
        WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'speaker' AND l.target_id = ? AND c.run_id = ?
        ORDER BY c.started_at, l.id`,
    )
    .all(meetingId, label, runId) as { call_id: number }[];
  return [...new Set(rows.map((r) => r.call_id))];
}

/** The run that made the current summary row, or null. */
export function findSummaryRunId(
  db: DatabaseSync,
  meetingId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT c.run_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
         JOIN meeting_summaries s ON s.meeting_id = l.scope_id
        WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'summary' AND l.outcome = 'applied'
          AND l.applied_text = CAST(s.created_at AS TEXT)
        ORDER BY l.created_at DESC, l.id DESC LIMIT 1`,
    )
    .get(meetingId) as { run_id: string } | undefined;
  return row ? row.run_id : null;
}

/**
 * `staleLabels` for speaker links: the clustering or a confirmed name changed
 * since the run. The run row stores the kind, not the stage list, so both
 * variants `chain` and `enhance` are tried and the first match wins. A NULL
 * stored hash is stale. The current rows load once, on first use.
 */
export function speakerStaleCheck(
  db: DatabaseSync,
  meetingId: string,
): StaleCheck {
  let current: string[] | null = null;
  return ({ run }) => {
    if (run.inputHash === null) return true;
    if (current === null) {
      const rows = loadHashRows(db, meetingId);
      current = [
        inputHash(rows, hashVariantOf(["enhance", "summarize"])),
        inputHash(rows, hashVariantOf(["enhance"])),
      ];
    }
    return !current.includes(run.inputHash);
  };
}
