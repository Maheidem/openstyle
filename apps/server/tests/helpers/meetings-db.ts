import { getDb } from "../../src/lib/db.js";

/** Delete every meeting row and its child rows. Call it from `afterEach`. */
export function resetMeetingTables(): void {
  const db = getDb();
  db.exec("DELETE FROM meeting_summaries");
  db.exec("DELETE FROM meeting_speakers");
  db.exec("DELETE FROM meeting_segments");
  db.exec("DELETE FROM meetings");
}

interface InsertSegmentOptions {
  id: string;
  meetingId: string;
  idx: number;
  startMs: number;
  endMs: number;
  source?: "mic" | "system";
  text?: string | null;
  status?: string;
  speakerLabel?: string | null;
}

/** Insert one `meeting_segments` row. The parent meeting must exist. */
export function insertSegment(o: InsertSegmentOptions): void {
  getDb()
    .prepare(
      `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status, speaker_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      o.meetingId,
      o.source ?? "system",
      o.idx,
      o.startMs,
      o.endMs,
      o.text === undefined ? "hello" : o.text,
      o.status ?? "ok",
      o.speakerLabel ?? null,
    );
}

/** Insert one "hello" segment on the system channel. */
export function insertSystemSegment(
  id: string,
  meetingId: string,
  idx: number,
  startMs: number,
  endMs: number,
  speakerLabel?: string,
): void {
  insertSegment({ id, meetingId, idx, startMs, endMs, speakerLabel });
}

/** specs/meeting-speaker-naming.md §3.1: seed a meeting_speakers row directly. */
export function insertSpeaker(
  meetingId: string,
  label: string,
  opts: {
    displayName?: string | null;
    suggestedName?: string | null;
    suggestedEvidence?: string | null;
    suggestedKind?: string | null;
    mergedInto?: string | null;
    /** Real-E2E fix regression coverage: only a genuinely *confirmed*
     * write (routes/meetings.ts's PATCH handler) sets this — a plain
     * suggestion upsert (enhance.ts) never does. Tests that simulate a
     * confirmed row must pass this explicitly; it is NOT inferred from
     * `displayName`/`mergedInto` being set, to keep the two independent
     * the same way the real schema does. */
    confirmedAt?: number | null;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO meeting_speakers
         (meeting_id, speaker_label, display_name, suggested_name, suggested_evidence, suggested_kind, merged_into, updated_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meetingId,
      label,
      opts.displayName ?? null,
      opts.suggestedName ?? null,
      opts.suggestedEvidence ?? null,
      opts.suggestedKind ?? null,
      opts.mergedInto ?? null,
      Date.now(),
      opts.confirmedAt ?? null,
    );
}
