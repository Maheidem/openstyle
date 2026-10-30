// Seeds the folder data that project memory needs (issue #370).
//
// `seedFolderMemory` runs on a scratch DB that has the source DB attached as
// `src`. For each target meeting that sits in a folder it copies:
//   - the folder row, and sets the folder_id of the target;
//   - every earlier meeting of that folder, with its segments, speakers,
//     summary and tags, with the real dates and no audio (audio_dir NULL).
// "Earlier" is the rule of `folderMeetingsByTime` in the server
// (apps/server/src/lib/meetings/workflow/folder-memory.ts): a meeting that
// started after the target is later and is not copied.
// The search indexer of the server builds the index rows when the scratch DB
// boots. This file does not index.
//
// `seedStoredTranscript` is for a target with no audio. Its transcript comes
// from the stored segments of the source DB, as a fresh transcription would
// leave it: no enhanced text, no summary, no speaker names.
//
// Only columns that both DBs hold are copied, so a schema change on one side
// does not break the copy. Prints counts only.

/** Columns of `table` that main and src both have. */
function sharedColumns(db, table) {
  const cols = (schema) =>
    db
      .prepare(`PRAGMA ${schema}.table_info(${table})`)
      .all()
      .map((c) => c.name);
  const src = new Set(cols("src"));
  return cols("main").filter((c) => src.has(c));
}

/** Copy the rows of `table` that match `where` from src to main. */
function copyRows(db, table, where, params, replace = {}) {
  const cols = sharedColumns(db, table);
  if (cols.length === 0) return 0;
  const select = cols
    .map((c) => (c in replace ? replace[c] : `"${c}"`))
    .join(", ");
  const names = cols.map((c) => `"${c}"`).join(", ");
  return Number(
    db
      .prepare(
        `INSERT OR REPLACE INTO main.${table} (${names}) SELECT ${select} FROM src.${table} WHERE ${where}`,
      )
      .run(...params).changes,
  );
}

const inList = (ids) => ids.map(() => "?").join(", ");

/**
 * @param {import("node:sqlite").DatabaseSync} db scratch DB with `src` attached
 * @param {string[]} targets full ids of the eval meetings
 * @returns {{ id: string, folder: boolean, earlier: number, later: number }[]}
 */
export function seedFolderMemory(db, targets) {
  const report = [];
  for (const id of targets) {
    const row = db
      .prepare(
        "SELECT folder_id, COALESCE(started_at, created_at) AS at FROM src.meetings WHERE id = ?",
      )
      .get(id);
    if (!row?.folder_id) {
      report.push({ id, folder: false, earlier: 0, later: 0 });
      continue;
    }
    copyRows(db, "meeting_folders", "id = ?", [row.folder_id]);
    db.prepare("UPDATE main.meetings SET folder_id = ? WHERE id = ?").run(
      row.folder_id,
      id,
    );
    const others = db
      .prepare(
        `SELECT id, COALESCE(started_at, created_at) AS at FROM src.meetings
          WHERE folder_id = ? AND id <> ? ORDER BY id`,
      )
      .all(row.folder_id, id);
    const earlier = [];
    let later = 0;
    for (const o of others) {
      if (row.at !== null && o.at !== null && o.at > row.at) later += 1;
      else earlier.push(o.id);
    }
    // A target that is also an earlier meeting of another target is in main
    // already, with its own rows. Do not overwrite it.
    const fresh = earlier.filter(
      (e) => !db.prepare("SELECT 1 FROM main.meetings WHERE id = ?").get(e),
    );
    if (fresh.length > 0) copyEarlier(db, fresh);
    report.push({ id, folder: true, earlier: earlier.length, later });
  }
  return report;
}

function copyEarlier(db, ids) {
  const slots = inList(ids);
  copyRows(db, "meetings", `id IN (${slots})`, ids, { audio_dir: "NULL" });
  for (const table of [
    "meeting_segments",
    "meeting_speakers",
    "meeting_summaries",
    "meeting_diarizer_turns",
    "meeting_tags",
  ]) {
    copyRows(db, table, `meeting_id IN (${slots})`, ids);
  }
  // meeting_tags needs its tag rows (the title and tags make the meta chunk).
  copyRows(
    db,
    "tags",
    `id IN (SELECT tag_id FROM src.meeting_tags WHERE meeting_id IN (${slots}))`,
    ids,
  );
}

/**
 * The stored transcript of a target with no audio. The meetings row exists
 * (the seed loop made it); here it gets its status and the transcript rows.
 */
export function seedStoredTranscript(db, id) {
  copyRows(db, "meeting_segments", "meeting_id = ?", [id], {
    enhanced_text: "NULL",
  });
  copyRows(db, "meeting_speakers", "meeting_id = ?", [id], {
    display_name: "NULL",
    suggested_name: "NULL",
    suggested_evidence: "NULL",
    suggested_kind: "NULL",
    merged_into: "NULL",
    confirmed_at: "NULL",
  });
  copyRows(db, "meeting_diarizer_turns", "meeting_id = ?", [id]);
  db.prepare(
    `UPDATE main.meetings SET status = 'transcribed', audio_dir = NULL,
       language = (SELECT language FROM src.meetings WHERE id = ?),
       stt_provider = (SELECT stt_provider FROM src.meetings WHERE id = ?),
       stt_model = (SELECT stt_model FROM src.meetings WHERE id = ?)
     WHERE id = ?`,
  ).run(id, id, id, id);
}
