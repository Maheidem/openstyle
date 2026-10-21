/**
 * sqlite-vec load, OFF and ON mode (specs/local-semantic-search.md 6.1, 9.1,
 * 12.2). OFF mode is the default with no dylib. ON mode sets
 * OPENSTYLE_SQLITE_VEC_PATH to the sqlite-vec build of this platform.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../src/lib/db.js";
import { getExtensionState } from "../src/lib/search/extension.js";
import { sqliteVecTestPath } from "./helpers/sqlite-vec.js";

const VEC_PATH = sqliteVecTestPath();

function reopen(vecPath: string | undefined) {
  closeDb();
  if (vecPath === undefined) delete process.env.OPENSTYLE_SQLITE_VEC_PATH;
  else process.env.OPENSTYLE_SQLITE_VEC_PATH = vecPath;
  return getDb();
}

function tableNames(): string[] {
  return (
    getDb().prepare("SELECT name FROM sqlite_master").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

afterEach(() => {
  reopen(undefined);
});

describe("OFF mode (no dylib)", () => {
  it("keeps search off and creates only the plain tables", () => {
    reopen(undefined);
    const state = getExtensionState();
    expect(state.state).toBe("failed");
    expect(["unsupported_platform", "extension_missing"]).toContain(
      state.reason,
    );
    const names = tableNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "meeting_chunks",
        "meeting_chunk_gc",
        "meeting_index_state",
        "meeting_chunks_ad",
      ]),
    );
    expect(names.some((n) => n.startsWith("meeting_chunk_vec"))).toBe(false);
  });

  it("fills meeting_chunk_gc when a meeting delete cascades", () => {
    const db = reopen(undefined);
    db.prepare(
      "INSERT INTO meetings (id, title, status, started_at) VALUES ('m1', 't', 'transcribed', 1)",
    ).run();
    const ins = db.prepare(
      `INSERT INTO meeting_chunks (meeting_id, ordinal, segment_ids, char_start, token_estimate, text_hash, model_id, created_at)
       VALUES ('m1', ?, '[]', 0, 1, 'h', 'x', 1)`,
    );
    const a = Number(ins.run(0).lastInsertRowid);
    const b = Number(ins.run(1).lastInsertRowid);
    db.prepare("DELETE FROM meetings WHERE id = 'm1'").run();
    expect(
      db.prepare("SELECT chunk_id FROM meeting_chunk_gc ORDER BY 1").all(),
    ).toEqual([{ chunk_id: a }, { chunk_id: b }]);
    db.exec("DELETE FROM meeting_chunk_gc");
  });

  it("reports extension_load_failed for a file that is not an extension", () => {
    const bad = join(tmpdir(), `not-vec-${process.pid}.so`);
    writeFileSync(bad, "not a library");
    reopen(bad);
    expect(getExtensionState()).toMatchObject({
      state: "failed",
      reason: "extension_load_failed",
      path: bad,
    });
  });

  it("reports extension_missing for a path that does not exist", () => {
    reopen(join(tmpdir(), "no-such-vec0.dylib"));
    expect(getExtensionState().reason).toBe("extension_missing");
  });
});

describe.skipIf(!VEC_PATH)("ON mode (sqlite-vec 0.1.9)", () => {
  it("loads v0.1.9 and turns extension loading off again", () => {
    const db = reopen(VEC_PATH as string);
    expect(getExtensionState()).toEqual({
      state: "loaded",
      reason: null,
      path: VEC_PATH,
      vecVersion: "v0.1.9",
    });
    // P1 1c: a second load fails after enableLoadExtension(false).
    expect(() => db.loadExtension(VEC_PATH as string)).toThrow(/not allowed/);
    // P4: the SQL function stays "not authorized".
    expect(() =>
      db.prepare("SELECT load_extension(?)").get(VEC_PATH as string),
    ).toThrow(/not authorized/);
  });

  it("creates the vec0 table, binds chunk ids as BigInt, and rolls back", () => {
    const db = reopen(VEC_PATH as string);
    expect(tableNames()).toContain("meeting_chunk_vec");
    const v = new Int8Array(768);
    v[0] = 127;
    const ins = db.prepare(
      `INSERT INTO meeting_chunk_vec (chunk_id, folder_id, embedding, meeting_id, model_id)
       VALUES (?, '', vec_int8(?), 'm', 'x')`,
    );
    // P1 3a: a JS number is refused as a primary key value.
    expect(() => ins.run(1, v)).toThrow(/Only integers/);
    db.exec("BEGIN");
    ins.run(1n, v);
    db.exec("ROLLBACK");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM meeting_chunk_vec").get(),
    ).toEqual({ n: 0 });
  });
});
