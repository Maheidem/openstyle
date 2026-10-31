/**
 * Keep the live transcript at Stop (issue #375).
 *
 * The live loop reads the audio while it records. At Stop, the final lines are
 * saved as the segments of the meeting, and the meeting gets the status
 * `transcribed` with `transcript_source = 'live'`. The user can read it at
 * once. "Re-transcribe" runs the full pass and replaces it. A job then adds
 * the steps that the live loop does not do (speaker labels and word timing,
 * see `runLiveFinishJob` in `routes/meetings.ts`).
 */
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../../db.js";
import type { LiveLine } from "./store.js";

/** The value of `meetings.transcript_source` for a transcript from the loop. */
export const TRANSCRIPT_SOURCE_LIVE = "live";

/**
 * Save the live final lines as the transcript of a meeting that has just
 * stopped. Returns the number of segments written. It writes nothing when the
 * meeting already has segments or is not `recorded`.
 */
export function saveLiveTranscript(
  db: DatabaseSync,
  meetingId: string,
  lines: readonly LiveLine[],
  stt: { provider: string; modelId: string },
): number {
  const usable = lines.filter((l) => l.final && l.text.trim().length > 0);
  if (usable.length === 0) return 0;
  const row = db
    .prepare("SELECT status FROM meetings WHERE id = ?")
    .get(meetingId) as { status: string } | undefined;
  if (row?.status !== "recorded") return 0;
  const existing = db
    .prepare("SELECT COUNT(*) AS c FROM meeting_segments WHERE meeting_id = ?")
    .get(meetingId) as { c: number };
  if (existing.c > 0) return 0;

  const insert = db.prepare(
    `INSERT INTO meeting_segments
       (id, meeting_id, source, idx, start_ms, end_ms, text, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ok')`,
  );
  const next = { mic: 0, system: 0 };
  const ordered = [...usable].sort((a, b) => a.startMs - b.startMs);
  withTransaction(db, () => {
    for (const line of ordered) {
      const idx = next[line.source]++;
      insert.run(
        `${meetingId}:${line.source}:${idx}`,
        meetingId,
        line.source,
        idx,
        line.startMs,
        line.endMs,
        line.text,
      );
    }
    db.prepare(
      `UPDATE meetings
          SET status = 'transcribed', error = NULL, transcript_source = ?,
              stt_provider = ?, stt_model = ?
        WHERE id = ?`,
    ).run(TRANSCRIPT_SOURCE_LIVE, stt.provider, stt.modelId, meetingId);
  });
  return ordered.length;
}
