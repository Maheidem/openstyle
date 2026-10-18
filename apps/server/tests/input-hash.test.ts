import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HashVariant,
  hashVariantOf,
  inputHash,
  loadHashRows,
} from "../src/lib/meetings/input-hash.js";
import { initSchema } from "../src/lib/schema.js";

// Check 6 of specs/meeting-enhance-agentic.md 10.9 (4.1 P11), on a real file.

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "input-hash-"));
  db = new DatabaseSync(join(dir, "db.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  db.prepare(
    "INSERT INTO meetings (id, title, status, created_at) VALUES ('m1', 'T', 'transcribed', 1)",
  ).run();
  seed("m1:mic:0", "mic", 0, "Hello team");
  seed("m1:system:1", "system", 1, "Hi, this is Ana", "SPEAKER_00");
  seed("m1:system:2", "system", 2, "Nice to meet you", "SPEAKER_01");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(
  id: string,
  source: "mic" | "system",
  idx: number,
  text: string | null,
  label: string | null = null,
  status = "ok",
): void {
  db.prepare(
    `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status, speaker_label)
     VALUES (?, 'm1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, source, idx, idx * 1000, idx * 1000 + 900, text, status, label);
}

function speaker(
  label: string,
  o: { displayName?: string; mergedInto?: string } = {},
): void {
  db.prepare(
    `INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, merged_into, updated_at)
     VALUES ('m1', ?, ?, ?, 1)`,
  ).run(label, o.displayName ?? null, o.mergedInto ?? null);
}

function hash(variant: HashVariant): string {
  return inputHash(loadHashRows(db, "m1"), variant);
}

const VARIANTS: HashVariant[] = ["enhance", "summarize", "chain"];

function snapshot(): Record<HashVariant, string> {
  return {
    enhance: hash("enhance"),
    summarize: hash("summarize"),
    chain: hash("chain"),
  };
}

describe("loadHashRows", () => {
  it("reads rows in transcript order with effective labels and no confirmed names", () => {
    expect(loadHashRows(db, "m1")).toEqual([
      {
        id: "m1:mic:0",
        text: "Hello team",
        speakerLabel: null,
        enhancedText: null,
        speakerName: null,
      },
      {
        id: "m1:system:1",
        text: "Hi, this is Ana",
        speakerLabel: "SPEAKER_00",
        enhancedText: null,
        speakerName: null,
      },
      {
        id: "m1:system:2",
        text: "Nice to meet you",
        speakerLabel: "SPEAKER_01",
        enhancedText: null,
        speakerName: null,
      },
    ]);
  });

  it("applies a merge (one hop) and the confirmed name of the effective label", () => {
    speaker("SPEAKER_00", { displayName: "Ana" });
    speaker("SPEAKER_01", { mergedInto: "SPEAKER_00" });
    const rows = loadHashRows(db, "m1");
    expect(rows[1]).toMatchObject({
      speakerLabel: "SPEAKER_00",
      speakerName: "Ana",
    });
    expect(rows[2]).toMatchObject({
      speakerLabel: "SPEAKER_00",
      speakerName: "Ana",
    });
  });

  it("gives a mic row no label and no name, and treats empty enhanced_text as null", () => {
    db.prepare(
      "UPDATE meeting_segments SET speaker_label = 'SPEAKER_09', enhanced_text = '' WHERE id = 'm1:mic:0'",
    ).run();
    speaker("SPEAKER_09", { displayName: "Bob" });
    expect(loadHashRows(db, "m1")[0]).toMatchObject({
      speakerLabel: null,
      speakerName: null,
      enhancedText: null,
    });
  });
});

describe("inputHash", () => {
  it("is the sha256 of the JSON of the variant and the row tuples", () => {
    const rows = loadHashRows(db, "m1");
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          "enhance",
          rows.map((r) => [r.id, r.text, r.speakerLabel]),
        ]),
        "utf8",
      )
      .digest("hex");
    expect(inputHash(rows, "enhance")).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    // Same database, same string. The variants differ from each other.
    expect(snapshot()).toEqual(snapshot());
    expect(new Set(VARIANTS.map(hash)).size).toBe(3);
  });

  it("is not changed by a blank-text row or a failed-status row", () => {
    const before = snapshot();
    seed("m1:system:3", "system", 3, "   ", "SPEAKER_00");
    seed("m1:system:4", "system", 4, null, "SPEAKER_00");
    seed("m1:system:5", "system", 5, "lost chunk", "SPEAKER_00", "failed");
    expect(snapshot()).toEqual(before);
  });

  it("changes for every variant on a merge, a re-diarize and a re-transcribe", () => {
    const base = snapshot();
    speaker("SPEAKER_01", { mergedInto: "SPEAKER_00" });
    const merged = snapshot();
    for (const v of VARIANTS) expect(merged[v], `merge ${v}`).not.toBe(base[v]);

    db.prepare("DELETE FROM meeting_speakers").run();
    db.prepare(
      "UPDATE meeting_segments SET speaker_label = 'SPEAKER_05' WHERE id = 'm1:system:2'",
    ).run();
    const rediarized = snapshot();
    for (const v of VARIANTS)
      expect(rediarized[v], `rediarize ${v}`).not.toBe(base[v]);

    db.prepare(
      "UPDATE meeting_segments SET speaker_label = 'SPEAKER_01' WHERE id = 'm1:system:2'",
    ).run();
    expect(snapshot()).toEqual(base);
    db.prepare("DELETE FROM meeting_segments WHERE id = 'm1:system:2'").run();
    seed("m1:system:2", "system", 2, "Nice to meet you all", "SPEAKER_01");
    const retranscribed = snapshot();
    for (const v of VARIANTS)
      expect(retranscribed[v], `retranscribe ${v}`).not.toBe(base[v]);
  });

  it("a confirmed name changes chain and summarize but not enhance", () => {
    const base = snapshot();
    speaker("SPEAKER_00", { displayName: "Ana" });
    const named = snapshot();
    expect(named.enhance).toBe(base.enhance);
    expect(named.chain).not.toBe(base.chain);
    expect(named.summarize).not.toBe(base.summarize);
  });

  it("enhanced_text changes summarize only", () => {
    const base = snapshot();
    db.prepare(
      "UPDATE meeting_segments SET enhanced_text = 'Hi, this is Anna' WHERE id = 'm1:system:1'",
    ).run();
    const enhanced = snapshot();
    expect(enhanced.enhance).toBe(base.enhance);
    expect(enhanced.chain).toBe(base.chain);
    expect(enhanced.summarize).not.toBe(base.summarize);
  });
});

describe("hashVariantOf", () => {
  it("gives enhance, summarize or chain from the stage list", () => {
    expect(hashVariantOf(["enhance"])).toBe("enhance");
    expect(hashVariantOf(["summarize"])).toBe("summarize");
    expect(hashVariantOf(["enhance", "summarize"])).toBe("chain");
    expect(hashVariantOf(["summarize", "enhance"])).toBe("chain");
    expect(hashVariantOf([])).toBe("summarize");
  });
});
