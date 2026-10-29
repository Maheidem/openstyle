// List the unsupported attendee-name tokens of one arm (same rule as
// score_arms.mts: no gold span of any confidence on the same channel within
// +-3 s holds the same normal words). Writes private JSON (mode 0600) with
// the segment text, so the evaluator can review each one. Prints counts only.
// usage (from the repo root; the output file must be outside the repo):
//   pnpm meeting:silver:extract-unsup <arm> <id8,...> <out.json>
// Input: $SILVER_EVAL_HOME/out/<arm>/raw.db (default /tmp/meeting-eval).
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadGold } from "../../gold.mts";
import { normalizeWords, scoreWords } from "../../score.mts";
import {
  attendeeNames,
  attendeeTokens,
  countRun as count,
  hasRun as has,
} from "./names.mts";

const [arm, list, outPath] = process.argv.slice(2);
const MEETINGS = (list ?? "").split(",");
const TOL = 3000;
const EVAL_HOME = process.env.SILVER_EVAL_HOME || "/tmp/meeting-eval";
const KEYS =
  process.env.SILVER_KEYS || join(homedir(), ".openstyle-eval", "gold-silver");
const REPO = resolve(import.meta.dirname, "../../../../..");
if (!arm || !list || !outPath)
  throw new Error("usage: extract_unsup.mts <arm> <id8,...> <out.json>");
if (resolve(outPath).startsWith(`${REPO}/`))
  throw new Error("the output holds meeting text: write it outside the repo");
const golds = loadGold(MEETINGS, KEYS);
const norm = (t: string) => normalizeWords(scoreWords(t)).words;
const db = new DatabaseSync(join(EVAL_HOME, "out", arm, "raw.db"), {
  readOnly: true,
});
const items: unknown[] = [];
const perMeeting: Record<string, { occ: number; unsup: number }> = {};
for (const id8 of MEETINGS) {
  const gold = golds.get(id8);
  const m = db
    .prepare("SELECT id, calendar_attendees FROM meetings WHERE id LIKE ?")
    .get(`${id8}%`) as { id: string; calendar_attendees: string | null };
  const rows = db
    .prepare(
      "SELECT source, idx, start_ms, end_ms, text FROM meeting_segments WHERE meeting_id = ? ORDER BY source, idx, start_ms",
    )
    .all(m.id) as any[];
  const gs = (gold?.spans ?? []).map((sp) => ({ ...sp, words: norm(sp.text) }));
  const names = attendeeTokens(m.calendar_attendees)
    .map((t) => ({ t, w: norm(t) }))
    .filter((x) => x.w.length > 0);
  const pm = { occ: 0, unsup: 0 };
  for (const s of rows) {
    if (s.start_ms === null) continue;
    const words = norm(s.text ?? "");
    const start = s.start_ms as number;
    const end = Math.max(start, s.end_ms ?? start);
    const near = gs.filter(
      (sp) =>
        sp.channel === s.source &&
        sp.endMs >= start - TOL &&
        sp.startMs <= end + TOL,
    );
    for (const { t, w } of names) {
      const n = count(words, w);
      if (n === 0) continue;
      pm.occ += n;
      if (near.some((sp) => has(sp.words, w))) continue;
      pm.unsup += n;
      items.push({
        id8,
        meetingId: m.id,
        channel: s.source,
        idx: s.idx,
        startMs: start,
        endMs: end,
        token: t,
        count: n,
        text: s.text,
        attendees: attendeeNames(m.calendar_attendees),
      });
    }
  }
  perMeeting[id8] = pm;
}
db.close();
writeFileSync(outPath, `${JSON.stringify(items, null, 1)}\n`, { mode: 0o600 });
for (const [k, v] of Object.entries(perMeeting))
  console.log(`${arm} ${k} nameOcc=${v.occ} nameUnsup=${v.unsup}`);
console.log(
  `${arm} total nameUnsup=${Object.values(perMeeting).reduce((a, v) => a + v.unsup, 0)} rows=${items.length}`,
);
