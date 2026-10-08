// Dump one meeting's chunks from the scratch DB as an array of
// {source, idx, start_ms, end_ms, text, speaker_label} ordered by
// (source, idx). This is the stored-dump format that
// scripts/meeting-v2/compare.mts reads (and self-checks against).
//
// Usage: dump-chunks.mjs <db> <meetingId> <out.json>

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [, , dbArg, meetingId, outPath] = process.argv;
if (!dbArg || !meetingId || !outPath) {
  console.error("usage: dump-chunks.mjs <db> <meetingId> <out.json>");
  process.exit(2);
}
const db = new DatabaseSync(dbArg, { readOnly: true });
const rows = db
  .prepare(
    `SELECT source, idx, start_ms, end_ms, text, speaker_label
     FROM meeting_segments
     WHERE meeting_id = ?
     ORDER BY source, idx`,
  )
  .all(meetingId);
writeFileSync(outPath, JSON.stringify(rows, null, 1));
console.log(`dumped ${rows.length} chunks -> ${outPath}`);
