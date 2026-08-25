import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseMeetingRetentionDays } from "@openstyle/validations";
import { getDb, readSetting } from "../db.js";

/**
 * Meeting audio retention: the WAV files are the heavy part of a meeting
 * (transcripts and summaries are a few KB of DB rows), so the sweep deletes
 * only mic.wav/system.wav once a meeting is older than
 * `meeting_retention_days` and nulls `audio_dir` as the "audio is gone"
 * marker. DB rows (segments + summaries) are kept forever.
 *
 * Modeled on startHistoryRetentionSweep in lib/history-store.ts.
 */

export const MEETING_RETENTION_SETTING_KEY = "meeting_retention_days";

const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ExpiredMeetingRow {
  id: string;
  audio_dir: string;
}

/**
 * Delete the audio files of every expired meeting and null its audio_dir.
 * Meetings still 'recording' are never touched. Returns the number of
 * meetings whose audio was purged.
 */
export function purgeExpiredMeetingAudio(): number {
  const days = parseMeetingRetentionDays(
    readSetting(MEETING_RETENTION_SETTING_KEY),
  );
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, audio_dir FROM meetings
       WHERE status != 'recording'
         AND audio_dir IS NOT NULL
         AND created_at < ?`,
    )
    .all(cutoff) as unknown as ExpiredMeetingRow[];

  let purged = 0;
  for (const row of rows) {
    for (const name of ["mic.wav", "system.wav"]) {
      try {
        unlinkSync(join(row.audio_dir, name));
      } catch {
        // Already gone (or the dir was removed manually) — still mark it.
      }
    }
    db.prepare("UPDATE meetings SET audio_dir = NULL WHERE id = ?").run(row.id);
    purged++;
  }
  return purged;
}

let retentionSweepTimer: NodeJS.Timeout | null = null;

export function startMeetingRetentionSweep(): void {
  if (retentionSweepTimer) return;

  const sweep = (): void => {
    try {
      purgeExpiredMeetingAudio();
    } catch {
      // Never let a sweep failure kill the periodic timer.
    }
  };

  sweep();
  retentionSweepTimer = setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS);
  retentionSweepTimer.unref();
}

export function stopMeetingRetentionSweep(): void {
  if (retentionSweepTimer) {
    clearInterval(retentionSweepTimer);
    retentionSweepTimer = null;
  }
}
