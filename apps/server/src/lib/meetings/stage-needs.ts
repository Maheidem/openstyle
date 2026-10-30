import type { MeetingStage } from "@openstyle/validations";
import { getDb } from "../db.js";
import { getDefaultModels } from "../providers.js";
import { hasJob } from "./job-registry.js";

/**
 * The "needs stage" rules of the folder counts, the batch queue and the
 * selection (specs/meeting-folder-batch.md 2). This file is the only place
 * that defines them. Each rule is one SQL expression over the `meetings` row
 * with the alias `m`, so the folder list counts them in one query.
 */

/** The meeting has transcript text. Summarize and Enhance need it. */
const HAS_TEXT = `EXISTS (SELECT 1 FROM meeting_segments ts
  WHERE ts.meeting_id = m.id AND ts.text IS NOT NULL AND ts.text <> '')`;

/** The status of a meeting with a finished transcript. */
const TRANSCRIBED = `m.status IN ('transcribed', 'summarized')`;

const NEEDS: Record<MeetingStage, string> = {
  // No transcript yet, a stopped or failed run, or chunks that failed.
  transcribe: `(m.status IN ('recorded', 'interrupted', 'failed')
    OR (${TRANSCRIBED} AND EXISTS (SELECT 1 FROM meeting_segments fs
      WHERE fs.meeting_id = m.id AND fs.status = 'failed')))`,
  // The save sets 'summarized'. A transcript with no summary for it stays
  // 'transcribed' (also after a re-transcribe). A summary repaired from a
  // cut answer (partial, PR #258) needs a new run too.
  summarize: `(${HAS_TEXT} AND (m.status = 'transcribed'
    OR (m.status = 'summarized' AND COALESCE((SELECT partial
      FROM meeting_summaries ps WHERE ps.meeting_id = m.id), 0) = 1)))`,
  // The same Enhance test as meetingDisplayStatus (store.ts).
  enhance: `(${TRANSCRIBED} AND ${HAS_TEXT} AND NOT EXISTS (
    SELECT 1 FROM meeting_segments es WHERE es.meeting_id = m.id
      AND es.enhanced_text IS NOT NULL AND es.enhanced_text <> ''))`,
};

/** The SQL expression (alias `m`) that is true when a meeting needs `stage`. */
export function stageNeedSql(stage: MeetingStage): string {
  return NEEDS[stage];
}

/** True when a default LLM is set up. Summarize and Enhance need it (the
 * same test as the stage routes). */
function hasDefaultLlm(): boolean {
  return getDefaultModels().llm !== null;
}

/** Why a meeting cannot run a stage now. */
export type StageBlock =
  | "gone"
  | "busy"
  | "no_audio"
  | "no_transcript"
  | "no_llm";

/**
 * Why `stage` cannot run on this meeting now, or null when it can. The rules
 * are the guards of the stage routes (POST /:id/transcribe, /summarize,
 * /enhance). A route can still refuse (an empty merged transcript): the
 * queue then counts the meeting as skipped.
 */
export function stageBlock(id: string, stage: MeetingStage): StageBlock | null {
  const row = getDb()
    .prepare(
      `SELECT m.status, m.audio_dir, ${HAS_TEXT} AS has_text
       FROM meetings m WHERE m.id = ?`,
    )
    .get(id) as
    | { status: string; audio_dir: string | null; has_text: number }
    | undefined;
  if (!row) return "gone";
  if (hasJob(id) || row.status === "recording" || row.status === "transcribing")
    return "busy";
  if (stage === "transcribe") return row.audio_dir ? null : "no_audio";
  if (
    (row.status !== "transcribed" && row.status !== "summarized") ||
    row.has_text !== 1
  )
    return "no_transcript";
  return hasDefaultLlm() ? null : "no_llm";
}

/** True when the meeting needs `stage` (the rule above, for one meeting). */
export function needsStage(id: string, stage: MeetingStage): boolean {
  return Boolean(
    getDb()
      .prepare(`SELECT 1 FROM meetings m WHERE m.id = ? AND ${NEEDS[stage]}`)
      .get(id),
  );
}

/** The meetings of a folder that need `stage`, oldest first. */
export function folderMeetingsNeeding(
  folderId: string,
  stage: MeetingStage,
): string[] {
  return (
    getDb()
      .prepare(
        `SELECT m.id FROM meetings m WHERE m.folder_id = ? AND ${NEEDS[stage]}
         ORDER BY m.started_at, m.id`,
      )
      .all(folderId) as { id: string }[]
  ).map((r) => r.id);
}

/** The stage counts of one folder (the chips of the folder page). */
export interface FolderStageCounts {
  transcribe: { ready: number; blocked: number };
  summarize: { ready: number; blocked: number };
  enhance: { ready: number; blocked: number };
}

/** The SQL columns that `stageCountsOf` reads, for the folder list query. */
export const stageCountColumns = `
  COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND ${NEEDS.transcribe}
    AND m.audio_dir IS NOT NULL THEN 1 ELSE 0 END), 0) AS need_transcribe,
  COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND ${NEEDS.transcribe}
    AND m.audio_dir IS NULL THEN 1 ELSE 0 END), 0) AS need_transcribe_no_audio,
  COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND ${NEEDS.summarize}
    THEN 1 ELSE 0 END), 0) AS need_summarize,
  COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND ${NEEDS.enhance}
    THEN 1 ELSE 0 END), 0) AS need_enhance`;

/**
 * The stage counts from the columns of `stageCountColumns`. Transcribe is
 * blocked when the audio is gone (the retention sweep). Summarize and Enhance
 * are blocked for every meeting when no AI model is set up.
 */
export function stageCountsOf(row: {
  need_transcribe: number;
  need_transcribe_no_audio: number;
  need_summarize: number;
  need_enhance: number;
}): FolderStageCounts {
  const llm = hasDefaultLlm();
  const llmStage = (n: number) =>
    llm ? { ready: n, blocked: 0 } : { ready: 0, blocked: n };
  return {
    transcribe: {
      ready: row.need_transcribe,
      blocked: row.need_transcribe_no_audio,
    },
    summarize: llmStage(row.need_summarize),
    enhance: llmStage(row.need_enhance),
  };
}
