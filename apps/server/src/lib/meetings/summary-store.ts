import type { DatabaseSync } from "node:sqlite";

// The write of a meeting summary. The workflow save node (step SW3) and the
// route PUT /api/meetings/:id/summary (an agent through MCP) use it. The
// caller runs it in a transaction.

/** One summary to store. */
export interface MeetingSummaryWrite {
  markdown: string;
  /** The summary object as JSON text. */
  summaryJson: string;
  llmProvider: string | null;
  llmModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** A summary repaired from a cut answer (PR #258). */
  partial: boolean;
  createdAt: number;
}

/**
 * Replace the summary of a meeting. The summary that it replaces goes to
 * `meeting_summary_versions` (specs/meeting-folder-batch.md 5). The meeting
 * gets the status `summarized`. Run it in one transaction with the caller's
 * other writes, so a failed save keeps no change.
 */
export function saveMeetingSummary(
  db: DatabaseSync,
  meetingId: string,
  summary: MeetingSummaryWrite,
): void {
  db.prepare(
    `INSERT INTO meeting_summary_versions
       (meeting_id, markdown, summary_json, llm_provider, llm_model,
        input_tokens, output_tokens, cost_usd, created_at, partial,
        replaced_at)
     SELECT meeting_id, markdown, summary_json, llm_provider, llm_model,
            input_tokens, output_tokens, cost_usd, created_at, partial, ?
     FROM meeting_summaries WHERE meeting_id = ?`,
  ).run(summary.createdAt, meetingId);
  db.prepare(
    `INSERT OR REPLACE INTO meeting_summaries
       (meeting_id, markdown, summary_json, llm_provider, llm_model,
        input_tokens, output_tokens, cost_usd, created_at, partial)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    meetingId,
    summary.markdown,
    summary.summaryJson,
    summary.llmProvider,
    summary.llmModel,
    summary.inputTokens,
    summary.outputTokens,
    summary.costUsd,
    summary.createdAt,
    summary.partial ? 1 : 0,
  );
  db.prepare("UPDATE meetings SET status = 'summarized' WHERE id = ?").run(
    meetingId,
  );
}
