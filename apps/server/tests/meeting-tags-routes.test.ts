import {
  meetingDetailResponseSchema,
  meetingTagErrorSchema,
  meetingTagListResponseSchema,
  meetingTagsResponseSchema,
} from "@openstyle/validations";
import { afterEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { addSuggestedTags } from "../src/lib/meetings/tags.js";
import { jsonRequest } from "./helpers/http.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";

const app = createApp();
const base = "/api/meetings";

afterEach(resetMeetingTables);

function insertMeeting(id: string) {
  getDb()
    .prepare(
      "INSERT INTO meetings (id, title, status, created_at) VALUES (?, ?, 'recorded', 1)",
    )
    .run(id, id);
}

function putTags(id: string, tags: unknown) {
  return jsonRequest(app, "PUT", `${base}/${id}/tags`, { tags });
}

async function detailTags(id: string) {
  const res = await app.request(`${base}/${id}`);
  expect(res.status).toBe(200);
  return meetingDetailResponseSchema.parse(await res.json()).tags;
}

function sources(id: string) {
  return getDb()
    .prepare(
      `SELECT t.name, mt.source FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
       WHERE mt.meeting_id = ? ORDER BY t.name`,
    )
    .all(id);
}

describe("meeting tags routes", () => {
  it("returns an empty tag list for a meeting with no tags", async () => {
    insertMeeting("m1");
    expect(await detailTags("m1")).toEqual([]);
  });

  it("sets normalized, unique, sorted tags and creates missing tags", async () => {
    insertMeeting("m1");
    const res = await putTags("m1", [
      "  Budget ",
      "roadmap",
      "BUDGET",
      "Q3  plan",
    ]);
    expect(res.status).toBe(200);
    expect(meetingTagsResponseSchema.parse(await res.json()).tags).toEqual([
      "budget",
      "q3 plan",
      "roadmap",
    ]);
    expect(await detailTags("m1")).toEqual(["budget", "q3 plan", "roadmap"]);
    expect(sources("m1")).toEqual([
      { name: "budget", source: "user" },
      { name: "q3 plan", source: "user" },
      { name: "roadmap", source: "user" },
    ]);
  });

  it("replaces the list, keeps unused tags, and keeps the source of a kept tag", async () => {
    insertMeeting("m1");
    addSuggestedTags("m1", ["hiring"]);
    await putTags("m1", ["budget", "hiring"]);
    const res = await putTags("m1", ["hiring", "launch"]);
    expect(meetingTagsResponseSchema.parse(await res.json()).tags).toEqual([
      "hiring",
      "launch",
    ]);
    expect(sources("m1")).toEqual([
      { name: "hiring", source: "llm" },
      { name: "launch", source: "user" },
    ]);
    // "budget" has no meeting now, but the tag row stays.
    const list = await app.request(`${base}/tags`);
    expect(list.status).toBe(200);
    expect(meetingTagListResponseSchema.parse(await list.json()).items).toEqual(
      [
        { name: "budget", meeting_count: 0 },
        { name: "hiring", meeting_count: 1 },
        { name: "launch", meeting_count: 1 },
      ],
    );
    await putTags("m1", []);
    expect(await detailTags("m1")).toEqual([]);
  });

  it("lists all tags with counts and is not caught by /:id", async () => {
    insertMeeting("m1");
    insertMeeting("m2");
    await putTags("m1", ["budget", "roadmap"]);
    await putTags("m2", ["budget"]);
    const res = await app.request(`${base}/tags`);
    expect(res.status).toBe(200);
    expect(meetingTagListResponseSchema.parse(await res.json()).items).toEqual([
      { name: "budget", meeting_count: 2 },
      { name: "roadmap", meeting_count: 1 },
    ]);
  });

  it("answers 400 above 20 tags and accepts exactly 20", async () => {
    insertMeeting("m1");
    const names = Array.from({ length: 21 }, (_, i) => `tag ${i}`);
    const over = await putTags("m1", names);
    expect(over.status).toBe(400);
    expect(meetingTagErrorSchema.parse(await over.json()).code).toBe(
      "too_many_tags",
    );
    const ok = await putTags("m1", names.slice(0, 20));
    expect(ok.status).toBe(200);
    expect(await detailTags("m1")).toHaveLength(20);
    // Duplicates count once.
    const dup = await putTags("m1", [...names.slice(0, 20), "TAG 0"]);
    expect(dup.status).toBe(200);
  });

  it("answers 400 for an empty or too long name and a bad body", async () => {
    insertMeeting("m1");
    for (const body of [[" "], ["x".repeat(41)], "budget", [1]]) {
      const res = await putTags("m1", body);
      expect(res.status).toBe(400);
      expect(meetingTagErrorSchema.parse(await res.json()).code).toBe(
        "invalid_request",
      );
    }
    expect((await putTags("m1", ["x".repeat(40)])).status).toBe(200);
  });

  it("answers 404 for a missing meeting", async () => {
    const res = await putTags("missing", ["budget"]);
    expect(res.status).toBe(404);
    expect(meetingTagErrorSchema.parse(await res.json()).code).toBe(
      "meeting_not_found",
    );
  });

  it("removes the links when the meeting is deleted", async () => {
    insertMeeting("m1");
    await putTags("m1", ["budget"]);
    const res = await app.request(`${base}/m1`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(
      getDb().prepare("SELECT count(*) AS c FROM meeting_tags").get(),
    ).toEqual({ c: 0 });
  });
});

describe("addSuggestedTags", () => {
  it("adds normalized tags, never removes user tags, and stops at 20", () => {
    insertMeeting("m1");
    const db = getDb();
    expect(
      addSuggestedTags("m1", [" Budget", "budget", "", "roadmap"]),
    ).toEqual(["budget", "roadmap"]);
    expect(addSuggestedTags("m1", ["budget"])).toEqual([]);
    expect(addSuggestedTags("missing", ["budget"])).toEqual([]);
    const names = Array.from({ length: 18 }, (_, i) => `user ${i}`);
    for (const name of names) {
      addSuggestedTags("m1", [name]);
    }
    expect(addSuggestedTags("m1", ["extra"])).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT count(*) AS c FROM meeting_tags WHERE meeting_id = 'm1'",
        )
        .get(),
    ).toEqual({ c: 20 });
  });
});
