import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_MEETING_TAGS, normalizeTagNames } from "@openstyle/validations";
import { getDb, withTransaction } from "../db.js";

type TagSource = "llm" | "user";

/** The tag names of one meeting, sorted by name. */
export function getMeetingTags(
  meetingId: string,
  db: DatabaseSync = getDb(),
): string[] {
  const rows = db
    .prepare(
      `SELECT t.name FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
       WHERE mt.meeting_id = ? ORDER BY t.name`,
    )
    .all(meetingId) as { name: string }[];
  return rows.map((r) => r.name);
}

/** All tag names with the number of meetings that use each tag. */
export function listTagsWithCounts(db: DatabaseSync = getDb()): {
  name: string;
  meeting_count: number;
}[] {
  return db
    .prepare(
      `SELECT t.name, COUNT(mt.meeting_id) AS meeting_count
       FROM tags t LEFT JOIN meeting_tags mt ON mt.tag_id = t.id
       GROUP BY t.id ORDER BY t.name`,
    )
    .all() as { name: string; meeting_count: number }[];
}

/** Get the id of a tag. Create the tag when it does not exist. The name must
 * be normalized. Call it inside a transaction. */
function ensureTagId(db: DatabaseSync, name: string, now: number): string {
  const row = db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as
    | { id: string }
    | undefined;
  if (row) return row.id;
  const id = randomUUID();
  db.prepare("INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)").run(
    id,
    name,
    now,
  );
  return id;
}

function linkTag(
  db: DatabaseSync,
  meetingId: string,
  tagId: string,
  source: TagSource,
  now: number,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id, source, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(meetingId, tagId, source, now);
  return result.changes > 0;
}

/**
 * Set the full tag list of a meeting (the user edit). Names must be
 * normalized, unique and at most MAX_MEETING_TAGS. A tag that stays keeps
 * its row and its source. A new tag gets source 'user'.
 */
export function setMeetingTags(meetingId: string, names: string[]): string[] {
  const db = getDb();
  return withTransaction(db, () => {
    const now = Date.now();
    const keepIds = names.map((name) => ensureTagId(db, name, now));
    for (const tagId of keepIds) linkTag(db, meetingId, tagId, "user", now);
    const current = db
      .prepare("SELECT tag_id FROM meeting_tags WHERE meeting_id = ?")
      .all(meetingId) as { tag_id: string }[];
    const remove = db.prepare(
      "DELETE FROM meeting_tags WHERE meeting_id = ? AND tag_id = ?",
    );
    for (const { tag_id } of current) {
      if (!keepIds.includes(tag_id)) remove.run(meetingId, tag_id);
    }
    return getMeetingTags(meetingId, db);
  });
}

/**
 * Add tags that the LLM suggested. It never removes a tag and never changes
 * the source of a tag the meeting has. It stops at MAX_MEETING_TAGS.
 * Returns the names it added.
 */
export function addSuggestedTags(
  meetingId: string,
  suggested: readonly string[],
  db: DatabaseSync = getDb(),
): string[] {
  return withTransaction(db, () => {
    const meeting = db
      .prepare("SELECT 1 FROM meetings WHERE id = ?")
      .get(meetingId);
    if (!meeting) return [];
    const now = Date.now();
    const existing = getMeetingTags(meetingId, db);
    let room = MAX_MEETING_TAGS - existing.length;
    const added: string[] = [];
    for (const name of normalizeTagNames(suggested)) {
      if (room <= 0) break;
      if (existing.includes(name)) continue;
      if (linkTag(db, meetingId, ensureTagId(db, name, now), "llm", now)) {
        added.push(name);
        room -= 1;
      }
    }
    return added;
  });
}
