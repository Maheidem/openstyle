import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db.js";
import { getMlxAsrModel } from "../src/lib/mlx-asr/constants.js";
import {
  customModelId,
  deleteCustomModelRow,
  findCustomModelId,
  getCustomMlxDef,
  insertCustomModel,
  isSafeHfId,
  listCustomMlxDefs,
  type NewCustomModel,
} from "../src/lib/mlx-asr/custom-models.js";
import { initSchema } from "../src/lib/schema.js";
import { createVersionedDb } from "./helpers/schema-db.js";

let migrated: DatabaseSync | null = null;

function model(hfId: string, overrides: Partial<NewCustomModel> = {}) {
  return {
    hfId,
    family: "whisper",
    modelType: "whisper",
    totalBytes: 1_000_000_000,
    revision: "sha-1",
    files: [{ path: "config.json", size: 262 }],
    ...overrides,
  };
}

beforeEach(() => {
  getDb().exec("DELETE FROM custom_mlx_models");
});

afterEach(() => {
  migrated?.close();
  migrated = null;
});

describe("custom_mlx_models migration (v35)", () => {
  it("creates the table on a v34 database and bumps the version", () => {
    migrated = createVersionedDb(34);

    initSchema(migrated);

    const columns = (
      migrated.prepare("PRAGMA table_info(custom_mlx_models)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(columns).toEqual([
      "id",
      "hf_id",
      "display_name",
      "family",
      "model_type",
      "total_bytes",
      "revision",
      "files_json",
      "added_at",
    ]);
    const version = migrated
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(35);
  });

  it("keeps rows when it runs again", () => {
    migrated = createVersionedDb(34);
    initSchema(migrated);
    migrated
      .prepare(
        `INSERT INTO custom_mlx_models
           (id, hf_id, display_name, family, total_bytes, revision, files_json)
         VALUES ('custom--a--b', 'a/b', 'b', 'whisper', 1, 'r', '[]')`,
      )
      .run();

    initSchema(migrated);

    expect(
      (
        migrated
          .prepare("SELECT COUNT(*) AS n FROM custom_mlx_models")
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it("makes hf_id unique", () => {
    migrated = createVersionedDb(34);
    initSchema(migrated);
    const insert = (id: string) =>
      migrated
        ?.prepare(
          `INSERT INTO custom_mlx_models
             (id, hf_id, display_name, family, total_bytes, revision, files_json)
           VALUES (?, 'a/b', 'b', 'whisper', 1, 'r', '[]')`,
        )
        .run(id);
    insert("custom--a--b");

    expect(() => insert("custom--other")).toThrow(/UNIQUE/);
  });
});

describe("custom model ids", () => {
  it("builds custom--<org>--<name>, with no slash", () => {
    const id = customModelId("mlx-community/whisper-tiny-asr-fp16");

    expect(id).toBe("custom--mlx-community--whisper-tiny-asr-fp16");
    expect(id).not.toContain("/");
  });

  it("never equals a curated id", () => {
    expect(customModelId("mlx-community/x").startsWith("custom--")).toBe(true);
    expect(getMlxAsrModel("qwen3-0.6b-8bit")?.custom).toBeUndefined();
  });

  it.each([
    ["mlx-community/whisper-tiny", true],
    ["a.b/c_d-e", true],
    ["a/..", false],
    ["../b", false],
    ["a--b/c", false],
    ["a/b--c", false],
    [".a/b", false],
    ["a/.b", false],
    ["a/b/c", false],
    ["a", false],
    ["a b/c", false],
    ["a-/b", false],
    ["a/-b", false],
    ["-a/b", false],
    ["a/b-", false],
  ])("isSafeHfId(%j) is %s", (hfId, expected) => {
    expect(isSafeHfId(hfId)).toBe(expected);
  });
});

describe("custom model rows", () => {
  it("inserts a row and resolves it as a catalog definition", () => {
    const id = insertCustomModel(
      model("mlx-community/whisper-tiny-asr-fp16", {
        totalBytes: 1_500_000_000,
      }),
    );

    expect(getCustomMlxDef(id)).toEqual({
      id: "custom--mlx-community--whisper-tiny-asr-fp16",
      hfId: "mlx-community/whisper-tiny-asr-fp16",
      displayName: "whisper-tiny-asr-fp16",
      family: "whisper",
      sizeBytes: 1_500_000_000,
      // 1.5e9 bytes * 1.5 = 2.1 GiB, rounded up
      ramRequired: "~3 GB",
      speed: "",
      quality: "",
      quantized: false,
      custom: {
        revision: "sha-1",
        files: [{ path: "config.json", size: 262 }],
      },
    });
    expect(getMlxAsrModel(id)).toEqual(getCustomMlxDef(id));
  });

  it("derives at least ~1 GB of RAM", () => {
    const id = insertCustomModel(model("a/small", { totalBytes: 10 }));

    expect(getCustomMlxDef(id)?.ramRequired).toBe("~1 GB");
  });

  it("returns undefined for an unknown id", () => {
    expect(getMlxAsrModel("custom--nobody--nothing")).toBeUndefined();
  });

  it("lists rows in the order they were added", () => {
    insertCustomModel(model("a/first"));
    insertCustomModel(model("a/second"));

    expect(listCustomMlxDefs().map((d) => d.hfId)).toEqual([
      "a/first",
      "a/second",
    ]);
  });

  it("refuses a second row for the same hf_id", () => {
    insertCustomModel(model("a/b"));

    expect(() => insertCustomModel(model("a/b"))).toThrow(/UNIQUE|constraint/i);
  });

  it("refuses a second row for a repo id that differs only in case", () => {
    insertCustomModel(model("Org/Name"));

    expect(() => insertCustomModel(model("org/name"))).toThrow(
      /UNIQUE|constraint/i,
    );
  });

  it("finds a row that differs only in case", () => {
    const id = insertCustomModel(model("Org/Model-X"));

    expect(findCustomModelId("org/model-x")).toBe(id);
    expect(findCustomModelId("ORG/MODEL-X")).toBe(id);
    expect(findCustomModelId("org/other")).toBeUndefined();
  });

  it("skips a stored row whose hf_id is not safe", () => {
    getDb()
      .prepare(
        `INSERT INTO custom_mlx_models
           (id, hf_id, display_name, family, total_bytes, revision, files_json)
         VALUES ('custom--evil', '../../etc', 'x', 'whisper', 1, 'r', '[]')`,
      )
      .run();

    expect(getCustomMlxDef("custom--evil")).toBeUndefined();
    expect(listCustomMlxDefs()).toEqual([]);
  });

  it("skips a stored row whose files_json is not JSON", () => {
    getDb()
      .prepare(
        `INSERT INTO custom_mlx_models
           (id, hf_id, display_name, family, total_bytes, revision, files_json)
         VALUES ('custom--a--b', 'a/b', 'b', 'whisper', 1, 'r', 'oops')`,
      )
      .run();

    expect(getCustomMlxDef("custom--a--b")).toBeUndefined();
  });

  it("deletes a row and reports whether one existed", () => {
    const id = insertCustomModel(model("a/b"));

    expect(deleteCustomModelRow(id)).toBe(true);
    expect(deleteCustomModelRow(id)).toBe(false);
    expect(getCustomMlxDef(id)).toBeUndefined();
  });
});
