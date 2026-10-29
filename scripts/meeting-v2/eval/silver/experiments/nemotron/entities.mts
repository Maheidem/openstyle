// Entity lists of the app for whole-file runs: per meeting, the meeting terms
// (owner, attendee names, context terms: buildMeetingBiasTerms) and the same list merged
// with the global vocabulary (mergeContextVocabTerms). Reads the lab ASR cache DBs.
// Writes private JSON (a path in the repo is refused). Prints counts only.
// Run: node --import ./scripts/meeting-v2/ts-register.mjs <this file> <keys_file> <cache_dir> <out.json>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildMeetingBiasTerms } from "../../../../../../apps/server/src/lib/meetings/bias-terms.ts";
import { mergeContextVocabTerms } from "../../../../../../apps/server/src/lib/vocabulary-bias.ts";

const [keysFile, cacheDir, out] = process.argv.slice(2);
if (!keysFile || !cacheDir || !out) throw new Error("usage: keys cache out");
if (resolve(out).startsWith(resolve(process.cwd())))
  throw new Error("out points into the repo: the lists are private");
const res: Record<string, { meeting: string[]; merged: string[] }> = {};
for (const line of readFileSync(keysFile, "utf8").trim().split("\n")) {
  const [i8, key] = line.split(/\s+/);
  const f = readdirSync(cacheDir).find(
    (n) => n.startsWith(i8) && n.endsWith(`.${key}.db`),
  );
  if (!f || !existsSync(`${cacheDir}/${f}`))
    throw new Error(`no cache DB for ${i8}`);
  const db = new DatabaseSync(`${cacheDir}/${f}`, { readOnly: true });
  const row = db
    .prepare("SELECT calendar_attendees, context FROM meetings WHERE id LIKE ?")
    .get(`${i8}%`) as {
    calendar_attendees: string | null;
    context: string | null;
  };
  const owner = (
    db.prepare("SELECT value FROM settings WHERE key = 'owner_name'").get() as
      | { value: string }
      | undefined
  )?.value;
  const vocab = (
    db.prepare("SELECT term FROM vocabulary").all() as { term: string }[]
  ).map((r) => r.term);
  db.close();
  const meeting = buildMeetingBiasTerms(row as never, owner);
  res[i8] = { meeting, merged: mergeContextVocabTerms(meeting, vocab) };
  console.log(
    i8,
    "meeting terms",
    meeting.length,
    "merged",
    res[i8].merged.length,
  );
}
writeFileSync(out, JSON.stringify(res), { mode: 0o600 });
