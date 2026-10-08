// Dump one meeting's diarizer turns (id8-named output: turns-<id8>.json).
// compare.mts needs it to rebuild the R0d side offline.
//
// Usage: dump-turns.mjs <db> <meetingId> <out.json>

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [, , dbArg, meetingId, outPath] = process.argv;
if (!dbArg || !meetingId || !outPath) {
  console.error("usage: dump-turns.mjs <db> <meetingId> <out.json>");
  process.exit(2);
}
const db = new DatabaseSync(dbArg, { readOnly: true });
const rows = db
  .prepare(
    "SELECT speaker_id, start_ms, end_ms FROM meeting_diarizer_turns WHERE meeting_id = ? ORDER BY start_ms",
  )
  .all(meetingId);
writeFileSync(outPath, JSON.stringify(rows));
console.log(`dumped ${rows.length} turns -> ${outPath}`);
