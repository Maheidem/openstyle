// Dump one meeting's speaker-naming result from the scratch DB as
// {meetingId, speakers, segments}:
//   speakers: meeting_speakers rows {label, display_name, suggested_name,
//     suggested_evidence, suggested_kind, merged_into} ordered by label.
//     The table has no confidence column; the evidence text and the kind
//     are the only confidence signals it stores.
//   segments: meeting_segments rows {source, idx, start_ms, speaker_label,
//     text, enhanced_text} ordered by (source, idx, start_ms). Speaker-cut
//     splits share (source, idx), so start_ms is part of the row key.
// This is the stored-dump format that scripts/meeting-v2/compare-speakers.mts
// reads (and self-checks against).
//
// Usage: dump-speakers.mjs <db> <meetingId> <out.json>

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [, , dbArg, meetingId, outPath] = process.argv;
if (!dbArg || !meetingId || !outPath) {
  console.error("usage: dump-speakers.mjs <db> <meetingId> <out.json>");
  process.exit(2);
}
const db = new DatabaseSync(dbArg, { readOnly: true });
const speakers = db
  .prepare(
    `SELECT speaker_label AS label, display_name, suggested_name,
            suggested_evidence, suggested_kind, merged_into
     FROM meeting_speakers
     WHERE meeting_id = ?
     ORDER BY speaker_label`,
  )
  .all(meetingId);
const segments = db
  .prepare(
    `SELECT source, idx, start_ms, speaker_label, text, enhanced_text
     FROM meeting_segments
     WHERE meeting_id = ?
     ORDER BY source, idx, start_ms`,
  )
  .all(meetingId);
writeFileSync(
  outPath,
  JSON.stringify({ meetingId, speakers, segments }, null, 1),
);
console.log(
  `dumped ${speakers.length} speakers, ${segments.length} segments -> ${outPath}`,
);
