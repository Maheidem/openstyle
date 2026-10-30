#!/usr/bin/env node
// Phase 0a helper (specs/meeting-transcription-v2.md, section 7.2).
//
// Seeds the fresh scratch DB with the allow-listed rows of the real DB
// (vocabulary rows, the `languages` and `owner_name` settings, the default
// llm model row when it is a built-in MLX model) and inserts one `meetings`
// row per copied
// meeting (status 'recorded', audio_dir pointing at the copy, created_at
// = now so the retention sweep ignores the row). The default voice row is
// always the built-in MLX ASR model (local-mlx/qwen3-1.7b-8bit). Never the
// api_keys table, never the own_servers rows: nothing may call the owner's
// model server (owner rule 2026-10-21).
// SEED_FOLDER_MEMORY=1 also copies the folder of each meeting and its earlier
// folder meetings (seed-folder-memory.mjs), for the project memory eval.
// MEETING_EVAL_STORED_IDS=<full id,...> marks meetings with no audio: they
// come from the stored transcript of the source DB.
// Prints counts, ids and durations only.
//
// Usage:
//   node scripts/meeting-v2/seed-scratch-db.mjs <scratch> <attach-db> \
//     <meeting-id> [<meeting-id> ...]

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import {
  seedFolderMemory,
  seedStoredTranscript,
} from "./seed-folder-memory.mjs";

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

/** The built-in MLX ASR voice row of every scratch DB (MEETING_EVAL_ASR_MODEL selects another catalog id). */
const BUILTIN_VOICE_ID = `local-mlx/${process.env.MEETING_EVAL_ASR_MODEL?.trim() || "qwen3-1.7b-8bit"}`;

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
      SELECT key, value, updated_at FROM src.settings
      WHERE key IN ('languages', 'owner_name');
  `);
  // The owner name is the first term of the meeting ASR bias.
  // MEETING_EVAL_OWNER_NAME sets it in the scratch DB only (for an eval
  // when the real DB has no value, or to measure another value). The log
  // shows set or unset, never the name.
  const ownerOverride = process.env.MEETING_EVAL_OWNER_NAME?.trim();
  if (ownerOverride) {
    db.prepare(
      `INSERT OR REPLACE INTO main.settings (key, value, updated_at)
       VALUES ('owner_name', ?, datetime('now'))`,
    ).run(ownerOverride);
  }
  const owner = db
    .prepare("SELECT value FROM main.settings WHERE key = 'owner_name'")
    .get();
  console.log(
    `owner_name: ${owner?.value?.trim() ? "set" : "unset"}${ownerOverride ? " (MEETING_EVAL_OWNER_NAME)" : ""}`,
  );

  // Voice: the built-in MLX ASR model (the "Qwen3 Pro" entry of
  // apps/server/src/lib/mlx-asr/constants.ts), never an own-server row.
  db.prepare(
    `INSERT OR IGNORE INTO main.model_configs (provider, model_id, model_name, type, is_default)
     VALUES ('local-mlx', ?, 'Qwen3 Pro', 'voice', 1)`,
  ).run(BUILTIN_VOICE_ID);
  console.log(`voice row: ${BUILTIN_VOICE_ID} (built-in MLX ASR)`);

  // LLM: the real default row when it is a built-in MLX model, else the
  // built-in Gemma 4 E2B. A run that needs another model sets its own row
  // (pnpm meeting:eval does).
  const realLlm = db
    .prepare(
      "SELECT provider, model_id, model_name FROM src.model_configs WHERE is_default = 1 AND type = 'llm'",
    )
    .get();
  const llm =
    realLlm?.provider === "local-mlx-llm"
      ? realLlm
      : {
          provider: "local-mlx-llm",
          model_id: "local-mlx-llm/gemma-4-e2b-qat-4bit",
          model_name: "gemma-4-e2b-qat-4bit",
        };
  db.prepare(
    `INSERT OR IGNORE INTO main.model_configs (provider, model_id, model_name, type, is_default)
     VALUES (?, ?, ?, 'llm', 1)`,
  ).run(llm.provider, llm.model_id, llm.model_name);
  console.log(
    `llm row: ${llm.model_id} (${llm === realLlm ? "real default" : "built-in fallback"})`,
  );

  // SEED_ASR_CONTEXT=1 copies the owner's `meeting_asr_context` setting
  // (previous-chunk context in the ASR prompt), so an eval runs with it.
  if (process.env.SEED_ASR_CONTEXT === "1") {
    db.exec(`
      INSERT OR REPLACE INTO main.settings (key, value)
        SELECT key, value FROM src.settings WHERE key = 'meeting_asr_context';
    `);
    const ctx = db
      .prepare(
        "SELECT value FROM main.settings WHERE key = 'meeting_asr_context'",
      )
      .get();
    console.log(`meeting_asr_context: ${ctx?.value ?? "unset"}`);
  }

  // PR #39: the `context` column (free-text per-meeting context — the
  // calendar invitee list) and the `calendar_attendees` column must reach
  // the scratch DB: the meeting ASR bias reads both at transcribe time.
  const realRow = db.prepare(
    "SELECT title, context, calendar_attendees, started_at, ended_at, duration_ms FROM src.meetings WHERE id = ?",
  );
  const insert = db.prepare(
    `INSERT INTO main.meetings
       (id, title, context, calendar_attendees, started_at, ended_at, duration_ms, status, audio_dir, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = 'recorded', audio_dir = excluded.audio_dir,
       context = excluded.context,
       calendar_attendees = excluded.calendar_attendees,
       language = NULL, error = NULL,
       stt_provider = NULL, stt_model = NULL,
       created_at = excluded.created_at`,
  );
  const now = Date.now();
  const storedIds = (process.env.MEETING_EVAL_STORED_IDS ?? "")
    .split(",")
    .filter(Boolean);
  for (const id of meetingIds) {
    const row = realRow.get(id);
    const audioDir = join(scratchRoot, "meetings", id);
    let durationMs = row?.duration_ms ?? null;
    if (!durationMs && !storedIds.includes(id)) {
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
      row?.context ?? null,
      row?.calendar_attendees ?? null,
      startedAt,
      endedAt,
      durationMs,
      audioDir,
      now,
    );
    console.log(`meeting row ${id}: status=recorded duration_ms=${durationMs}`);
  }
  for (const id of storedIds) {
    seedStoredTranscript(db, id);
    console.log(`stored transcript ${id.slice(0, 8)}: copied (no audio)`);
  }
  if (process.env.SEED_FOLDER_MEMORY === "1") {
    for (const r of seedFolderMemory(db, meetingIds)) {
      console.log(
        `folder memory ${r.id.slice(0, 8)}: folder=${r.folder ? "yes" : "no"} earlier=${r.earlier} later=${r.later}`,
      );
    }
  }
} finally {
  db.exec("DETACH DATABASE src");
  db.close();
}
