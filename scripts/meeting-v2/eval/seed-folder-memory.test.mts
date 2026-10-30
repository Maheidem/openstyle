// Unit tests of the folder seed for the project memory eval
// (seed-folder-memory.mjs) and of the flag check of eval.mts.
// Fictional data only. Run: pnpm meeting:eval:test (node --test).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  seedFolderMemory,
  seedStoredTranscript,
} from "../seed-folder-memory.mjs";

// A small copy of the real tables: the columns that the seed reads or sets.
const SCHEMA = `
  CREATE TABLE meeting_folders (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER);
  CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, started_at INTEGER,
    status TEXT, audio_dir TEXT, created_at INTEGER, language TEXT,
    stt_provider TEXT, stt_model TEXT, folder_id TEXT);
  CREATE TABLE meeting_segments (id TEXT PRIMARY KEY, meeting_id TEXT, text TEXT, enhanced_text TEXT);
  CREATE TABLE meeting_speakers (meeting_id TEXT, speaker_label TEXT, display_name TEXT,
    suggested_name TEXT, suggested_evidence TEXT, suggested_kind TEXT,
    merged_into TEXT, confirmed_at INTEGER);
  CREATE TABLE meeting_summaries (meeting_id TEXT PRIMARY KEY, markdown TEXT, created_at INTEGER);
  CREATE TABLE meeting_diarizer_turns (meeting_id TEXT, idx INTEGER, speaker_id TEXT);
  CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE meeting_tags (meeting_id TEXT, tag_id TEXT);
`;

/** A scratch DB with `src` attached. The src side has one folder of four meetings. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "seed-fm-"));
  const src = new DatabaseSync(join(dir, "src.db"));
  src.exec(SCHEMA);
  src.exec(`
    INSERT INTO meeting_folders VALUES ('f1', 'Project Alpha', 1);
    INSERT INTO meeting_folders VALUES ('f2', 'Project Beta', 1);
    INSERT INTO meetings (id, title, started_at, status, audio_dir, created_at, folder_id) VALUES
      ('m-old', 'Kickoff', 1000, 'summarized', '/gone', 5000, 'f1'),
      ('m-mid', 'Review', 2000, 'transcribed', '/gone', 5000, 'f1'),
      ('m-now', 'Target', 3000, 'transcribed', '/gone', 5000, 'f1'),
      ('m-new', 'Later', 4000, 'summarized', '/gone', 5000, 'f1'),
      ('m-solo', 'Solo', 3000, 'transcribed', '/gone', 5000, 'f2'),
      ('m-free', 'No folder', 3000, 'transcribed', '/gone', 5000, NULL);
    INSERT INTO meeting_segments VALUES ('s1', 'm-old', 'hello', 'Hello.');
    INSERT INTO meeting_segments VALUES ('s2', 'm-new', 'later text', NULL);
    INSERT INTO meeting_segments VALUES ('s3', 'm-now', 'target text', 'Target text.');
    INSERT INTO meeting_summaries VALUES ('m-old', '# Notes', 1500);
    INSERT INTO tags VALUES ('t1', 'planning');
    INSERT INTO meeting_tags VALUES ('m-mid', 't1');
    INSERT INTO meeting_speakers VALUES ('m-now', 'Them 1', 'Ana', 'Ana', 'ev', 'person', NULL, 9);
  `);
  src.close();
  const db = new DatabaseSync(join(dir, "main.db"));
  db.exec(SCHEMA);
  // The seed loop of seed-scratch-db.mjs has made the target rows already.
  db.exec(`
    INSERT INTO meetings (id, title, started_at, status, audio_dir, created_at) VALUES
      ('m-now', 'Target', 3000, 'recorded', '/scratch', 9999),
      ('m-solo', 'Solo', 3000, 'recorded', '/scratch', 9999),
      ('m-free', 'No folder', 3000, 'recorded', '/scratch', 9999);
  `);
  db.exec(`ATTACH DATABASE '${join(dir, "src.db")}' AS src`);
  return { db, dir };
}

const ids = (db: DatabaseSync, sql: string) =>
  (db.prepare(sql).all() as { id: string }[]).map((r) => r.id);

test("seedFolderMemory copies the folder and the earlier meetings, with real dates and no audio", () => {
  const { db, dir } = fixture();
  try {
    const report = seedFolderMemory(db, ["m-now", "m-free"]);
    assert.deepEqual(report, [
      { id: "m-now", folder: true, earlier: 2, later: 1 },
      { id: "m-free", folder: false, earlier: 0, later: 0 },
    ]);
    // The later meeting is not copied.
    assert.deepEqual(ids(db, "SELECT id FROM main.meetings ORDER BY id"), [
      "m-free",
      "m-mid",
      "m-now",
      "m-old",
      "m-solo",
    ]);
    const old = db
      .prepare("SELECT * FROM main.meetings WHERE id = 'm-old'")
      .get() as Record<string, unknown>;
    assert.equal(old.started_at, 1000);
    assert.equal(old.created_at, 5000);
    assert.equal(old.audio_dir, null);
    assert.equal(old.status, "summarized");
    assert.equal(old.folder_id, "f1");
    // The target gets its folder and keeps its own row.
    const now = db
      .prepare(
        "SELECT folder_id, created_at, audio_dir FROM main.meetings WHERE id = 'm-now'",
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...now },
      {
        folder_id: "f1",
        created_at: 9999,
        audio_dir: "/scratch",
      },
    );
    // Rows of the earlier meetings: segments (with enhanced text), summary, tags.
    assert.equal(
      (
        db
          .prepare(
            "SELECT enhanced_text AS e FROM main.meeting_segments WHERE id = 's1'",
          )
          .get() as { e: string }
      ).e,
      "Hello.",
    );
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM main.meeting_summaries")
          .get() as { n: number }
      ).n,
      1,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM main.meeting_tags WHERE tag_id = 't1'",
          )
          .get() as { n: number }
      ).n,
      1,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM main.tags").get() as { n: number })
        .n,
      1,
    );
    // The segments of the later meeting and of the target are not copied.
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS n FROM main.meeting_segments").get() as {
          n: number;
        }
      ).n,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedFolderMemory: a folder with no earlier meeting copies only the folder row (control)", () => {
  const { db, dir } = fixture();
  try {
    const report = seedFolderMemory(db, ["m-solo"]);
    assert.deepEqual(report, [
      { id: "m-solo", folder: true, earlier: 0, later: 0 },
    ]);
    assert.deepEqual(ids(db, "SELECT id FROM main.meetings ORDER BY id"), [
      "m-free",
      "m-now",
      "m-solo",
    ]);
    assert.deepEqual(ids(db, "SELECT id FROM main.meeting_folders"), ["f2"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedStoredTranscript copies the segments without enhanced text and clears speaker names", () => {
  const { db, dir } = fixture();
  try {
    seedStoredTranscript(db, "m-now");
    const seg = db
      .prepare(
        "SELECT text, enhanced_text FROM main.meeting_segments WHERE id = 's3'",
      )
      .get() as Record<string, unknown>;
    assert.deepEqual({ ...seg }, { text: "target text", enhanced_text: null });
    const sp = db
      .prepare(
        "SELECT display_name, suggested_name, suggested_kind, confirmed_at FROM main.meeting_speakers",
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...sp },
      {
        display_name: null,
        suggested_name: null,
        suggested_kind: null,
        confirmed_at: null,
      },
    );
    const m = db
      .prepare("SELECT status, audio_dir FROM main.meetings WHERE id = 'm-now'")
      .get() as Record<string, unknown>;
    assert.deepEqual({ ...m }, { status: "transcribed", audio_dir: null });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval.mts: --project-memory takes on or off only", () => {
  const run = (value: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/meeting-v2/ts-register.mjs",
        "scripts/meeting-v2/eval/eval.mts",
        "--models",
        "gemma-4-e2b-qat-4bit",
        "--project-memory",
        value,
      ],
      { encoding: "utf8" },
    );
  const bad = run("maybe");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--project-memory must be on or off/);
});
