#!/usr/bin/env node
// Phase 0a helper (specs/meeting-transcription-v2.md, section 7.2).
//
// Seeds the fresh scratch DB with the allow-listed rows of the real DB
// (vocabulary rows, the `languages` setting, own_servers rows, default
// voice + llm model rows) and inserts one `meetings` row per copied
// meeting (status 'recorded', audio_dir pointing at the copy, created_at
// = now so the retention sweep ignores the row). Never the api_keys table.
// Prints counts, ids and durations only.
//
// Usage:
//   node scripts/meeting-v2/seed-scratch-db.mjs <scratch> <attach-db> \
//     <meeting-id> [<meeting-id> ...]

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const [scratchRoot, srcDbPath, ...meetingIds] = process.argv.slice(2);
if (!scratchRoot || !srcDbPath || meetingIds.length === 0) {
  console.error(
    "usage: seed-scratch-db.mjs <scratch> <attach-db> <meeting-id> [...]",
  );
  process.exit(2);
}

// 16 kHz mono PCM16 = 32,000 bytes per second (spec 7.1).
function wavDurationMs(path) {
  const fd = openSync(path, "r");
  const head = Buffer.alloc(44);
  readSync(fd, head, 0, 44, 0);
  closeSync(fd);
  let off = 12;
  while (off + 8 <= head.length) {
    const chunkId = head.toString("ascii", off, off + 4);
    const size = head.readUInt32LE(off + 4);
    if (chunkId === "data") break;
    off += 8 + size;
  }
  if (off + 8 > head.length) return null;
  const dataBytes = statSync(path).size - (off + 8);
  return Math.round((dataBytes / 32000) * 1000);
}

const db = new DatabaseSync(join(scratchRoot, "test.db"));

// The scratch DB must already be migrated (step 3 of setup-scratch.sh). An
// empty main DB would make unqualified table names resolve to the attached
// source, so fail loudly instead of seeding the wrong database.
const version = db.prepare("SELECT version FROM schema_version").get();
const hasVocab = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vocabulary'",
  )
  .get();
if (!version || !hasVocab) {
  console.error(
    `scratch DB is not migrated (schema_version=${version?.version ?? "?"}); run setup-scratch.sh from its start`,
  );
  db.close();
  process.exit(1);
}

db.exec(`ATTACH DATABASE '${srcDbPath}' AS src`);
try {
  db.exec(`
    INSERT OR IGNORE INTO main.vocabulary (term, notes, created_at, updated_at)
      SELECT term, notes, created_at, updated_at FROM src.vocabulary;
    INSERT OR IGNORE INTO main.settings (key, value, updated_at)
      SELECT key, value, updated_at FROM src.settings WHERE key = 'languages';
    INSERT OR IGNORE INTO main.own_servers (id, base_url, api_key, flavor, server_key)
      SELECT id, base_url, api_key, flavor, server_key FROM src.own_servers;
    INSERT OR IGNORE INTO main.model_configs (provider, model_id, model_name, type, is_default)
      SELECT provider, model_id, model_name, type, is_default
      FROM src.model_configs WHERE is_default = 1 AND type IN ('voice','llm');
  `);

  const realRow = db.prepare(
    "SELECT title, started_at, ended_at, duration_ms FROM src.meetings WHERE id = ?",
  );
  const insert = db.prepare(
    `INSERT INTO main.meetings
       (id, title, started_at, ended_at, duration_ms, status, audio_dir, created_at)
     VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = 'recorded', audio_dir = excluded.audio_dir,
       language = NULL, error = NULL,
       stt_provider = NULL, stt_model = NULL,
       created_at = excluded.created_at`,
  );
  const now = Date.now();
  for (const id of meetingIds) {
    const row = realRow.get(id);
    const audioDir = join(scratchRoot, "meetings", id);
    let durationMs = row?.duration_ms ?? null;
    if (!durationMs) {
      for (const name of ["mic.wav", "system.wav"]) {
        const t = wavDurationMs(join(audioDir, name));
        if (t) {
          durationMs = t;
          break;
        }
      }
    }
    if (!durationMs) {
      console.error(`cannot determine duration for meeting ${id}`);
      process.exit(1);
    }
    const startedAt = row?.started_at ?? now - durationMs;
    const endedAt = row?.ended_at ?? now;
    insert.run(
      id,
      row?.title ?? `scratch ${id.slice(0, 8)}`,
      startedAt,
      endedAt,
      durationMs,
      audioDir,
      now,
    );
    console.log(`meeting row ${id}: status=recorded duration_ms=${durationMs}`);
  }
} finally {
  db.exec("DETACH DATABASE src");
  db.close();
}
