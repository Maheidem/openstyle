import {
  meetingDetailResponseSchema,
  meetingFolderErrorSchema,
  meetingFolderSchema,
  meetingFoldersResponseSchema,
  meetingListResponseSchema,
  meetingStartResponseSchema,
  moveMeetingsResponseSchema,
} from "@openstyle/validations";
import { afterEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { jsonRequest } from "./helpers/http.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";

const app = createApp();
const base = "/api/meetings";

afterEach(resetMeetingTables);

async function createFolder(name = "Work", description?: string) {
  const res = await jsonRequest(app, "POST", `${base}/folders`, {
    name,
    description,
  });
  expect(res.status).toBe(201);
  return meetingFolderSchema.parse(await res.json());
}

function insertMeeting(id: string, createdAt = 1) {
  getDb()
    .prepare(
      "INSERT INTO meetings (id, title, status, created_at) VALUES (?, ?, 'recorded', ?)",
    )
    .run(id, id, createdAt);
}

async function list(query = "") {
  const res = await app.request(`${base}${query}`);
  expect(res.status).toBe(200);
  return meetingListResponseSchema.parse(await res.json());
}

async function move(meeting_ids: string[], folder_id: string | null) {
  return jsonRequest(app, "POST", `${base}/move`, { meeting_ids, folder_id });
}

describe("meeting folders", () => {
  it("creates a trimmed name and lists empty folders with dates and counts", async () => {
    const folder = await createFolder("  Work  ", "Project notes");
    expect(folder).toMatchObject({
      name: "Work",
      description: "Project notes",
      meeting_count: 0,
    });
    expect(folder.created_at).toBeGreaterThan(0);
    expect(folder.updated_at).toBe(folder.created_at);
    const res = await app.request(`${base}/folders`);
    expect(res.status).toBe(200);
    expect(meetingFoldersResponseSchema.parse(await res.json()).items).toEqual([
      folder,
    ]);
  });

  it("renames a folder, updates its description, and clears the description", async () => {
    const folder = await createFolder();
    const patch = (body: unknown) =>
      jsonRequest(app, "PATCH", `${base}/folders/${folder.id}`, body);
    const res = await patch({ name: "  Home  ", description: "New notes" });
    expect(res.status).toBe(200);
    expect(meetingFolderSchema.parse(await res.json())).toMatchObject({
      id: folder.id,
      name: "Home",
      description: "New notes",
      created_at: folder.created_at,
    });
    const cleared = await patch({ description: null });
    expect(cleared.status).toBe(200);
    expect(meetingFolderSchema.parse(await cleared.json())).toMatchObject({
      name: "Home",
      description: null,
    });
    expect((await patch({ name: "HOME" })).status).toBe(200);
  });

  it("rejects duplicate names on create and rename, with no change to either folder", async () => {
    const first = await createFolder("Work");
    const second = await createFolder("Home");
    const duplicate = await jsonRequest(app, "POST", `${base}/folders`, {
      name: " work ",
    });
    expect(duplicate.status).toBe(409);
    expect(meetingFolderErrorSchema.parse(await duplicate.json()).code).toBe(
      "folder_name_exists",
    );
    const rename = await jsonRequest(
      app,
      "PATCH",
      `${base}/folders/${second.id}`,
      { name: "WORK", description: "Do not save" },
    );
    expect(rename.status).toBe(409);
    expect(meetingFolderErrorSchema.parse(await rename.json()).code).toBe(
      "folder_name_exists",
    );
    const res = await app.request(`${base}/folders`);
    expect(meetingFoldersResponseSchema.parse(await res.json()).items).toEqual([
      second,
      first,
    ]);
    await createFolder("Équipe");
    expect(
      (await jsonRequest(app, "POST", `${base}/folders`, { name: "équipe" }))
        .status,
    ).toBe(409);
  });

  it("rejects blank and long names and an empty update", async () => {
    for (const name of ["", " \n\t", "x".repeat(61), null]) {
      const res = await jsonRequest(app, "POST", `${base}/folders`, { name });
      expect(res.status).toBe(400);
      expect(meetingFolderErrorSchema.parse(await res.json()).code).toBe(
        "invalid_request",
      );
    }
    const folder = await createFolder("x".repeat(60));
    expect(
      (await jsonRequest(app, "PATCH", `${base}/folders/${folder.id}`, {}))
        .status,
    ).toBe(400);
    expect(
      (
        await jsonRequest(app, "PATCH", `${base}/folders/${folder.id}`, {
          name: " ",
        })
      ).status,
    ).toBe(400);
  });

  it("moves one or many meetings and filters folders and unfiled meetings", async () => {
    const first = await createFolder("First");
    const second = await createFolder("Second");
    insertMeeting("m1", 1);
    insertMeeting("m2", 2);
    insertMeeting("m3", 3);
    let res = await move(["m1"], first.id);
    expect(res.status).toBe(200);
    expect(moveMeetingsResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      meeting_ids: ["m1"],
      folder_id: first.id,
    });
    res = await move(["m2", "m3", "m2"], second.id);
    expect(res.status).toBe(200);
    expect(
      moveMeetingsResponseSchema.parse(await res.json()).meeting_ids,
    ).toEqual(["m2", "m3"]);
    expect((await list()).items.map((m) => m.id)).toEqual(["m3", "m2", "m1"]);
    expect(
      (await list(`?folder_id=${first.id}`)).items.map((m) => m.id),
    ).toEqual(["m1"]);
    expect(
      (await list(`?folder_id=${second.id}`)).items.map((m) => m.id),
    ).toEqual(["m3", "m2"]);
    expect((await list("?folder_id=none")).items).toEqual([]);
    expect((await move(["m2"], null)).status).toBe(200);
    const unfiled = await list("?folder_id=none");
    expect(unfiled.total).toBe(1);
    expect(unfiled.items[0]).toMatchObject({ id: "m2", folder_id: null });
    const detail = await app.request(`${base}/m1`);
    expect(
      meetingDetailResponseSchema.parse(await detail.json()).folder_id,
    ).toBe(first.id);
    const folders = await app.request(`${base}/folders`);
    expect(
      meetingFoldersResponseSchema
        .parse(await folders.json())
        .items.map((f) => f.meeting_count),
    ).toEqual([1, 1]);
  });

  it("blocks delete with a typed 409 and count, then deletes the empty folder", async () => {
    const folder = await createFolder();
    insertMeeting("m1");
    insertMeeting("m2");
    await move(["m1", "m2"], folder.id);
    const blocked = await app.request(`${base}/folders/${folder.id}`, {
      method: "DELETE",
    });
    expect(blocked.status).toBe(409);
    expect(meetingFolderErrorSchema.parse(await blocked.json())).toMatchObject({
      code: "folder_not_empty",
      meeting_count: 2,
    });
    expect((await list(`?folder_id=${folder.id}`)).items).toHaveLength(2);
    await move(["m1", "m2"], null);
    const removed = await app.request(`${base}/folders/${folder.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await list()).items).toHaveLength(2);
    const folders = await app.request(`${base}/folders`);
    expect(
      meetingFoldersResponseSchema.parse(await folders.json()).items,
    ).toEqual([]);
  });

  it("rejects missing folders and meetings and never moves part of a batch", async () => {
    const folder = await createFolder();
    insertMeeting("m1");
    const missingMeeting = await move(["m1", "missing"], folder.id);
    expect(missingMeeting.status).toBe(404);
    expect(
      meetingFolderErrorSchema.parse(await missingMeeting.json()).code,
    ).toBe("meeting_not_found");
    const missingFolder = await move(["m1"], "missing");
    expect(missingFolder.status).toBe(404);
    expect(
      meetingFolderErrorSchema.parse(await missingFolder.json()).code,
    ).toBe("folder_not_found");
    expect((await list("?folder_id=none")).items.map((m) => m.id)).toEqual([
      "m1",
    ]);
    expect((await move([], folder.id)).status).toBe(400);
    expect((await move(["m1"], "")).status).toBe(400);
    expect(
      (await jsonRequest(app, "POST", `${base}/move`, { meeting_ids: ["m1"] }))
        .status,
    ).toBe(400);
    expect(
      (
        await jsonRequest(app, "PATCH", `${base}/folders/missing`, {
          name: "New",
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`${base}/folders/missing`, { method: "DELETE" }))
        .status,
    ).toBe(404);
  });

  it("returns folder facts for all rows, also past the list limit", async () => {
    const folder = await createFolder();
    expect(folder).toMatchObject({
      first_meeting_at: null,
      last_meeting_at: null,
      total_duration_ms: 0,
    });
    for (let i = 0; i < 205; i++) {
      getDb()
        .prepare(`INSERT INTO meetings (id, status, folder_id, started_at, duration_ms)
        VALUES (?, 'recorded', ?, ?, ?)`)
        .run(`fact-${i}`, folder.id, i + 1, i === 0 ? null : 1000);
    }
    const res = await app.request(`${base}/folders`);
    const items = meetingFoldersResponseSchema.parse(await res.json()).items;
    expect(items[0]).toMatchObject({
      meeting_count: 205,
      first_meeting_at: 1,
      last_meeting_at: 205,
      total_duration_ms: 204000,
    });
    const renamed = await jsonRequest(
      app,
      "PATCH",
      `${base}/folders/${folder.id}`,
      { name: "New name" },
    );
    expect(meetingFolderSchema.parse(await renamed.json())).toMatchObject({
      meeting_count: 205,
      first_meeting_at: 1,
      last_meeting_at: 205,
      total_duration_ms: 204000,
    });
  });

  it("filters before the 200-row limit", async () => {
    const folder = await createFolder();
    insertMeeting("old", 0);
    await move(["old"], folder.id);
    for (let i = 1; i <= 205; i++) insertMeeting(`new-${i}`, i);
    expect((await list()).items).toHaveLength(200);
    expect(
      (await list(`?folder_id=${folder.id}`)).items.map((m) => m.id),
    ).toEqual(["old"]);
    const folders = await app.request(`${base}/folders`);
    expect(
      meetingFoldersResponseSchema.parse(await folders.json()).items[0]
        ?.meeting_count,
    ).toBe(1);
  });

  it("starts a recording in a folder or with no folder and rejects an unknown ID", async () => {
    const folder = await createFolder();
    for (const [id, folder_id] of [
      ["filed", folder.id],
      ["unfiled", null],
      ["default", undefined],
    ] as const) {
      const res = await jsonRequest(app, "POST", `${base}/start`, {
        id,
        folder_id,
        audio_dir: "/unused",
        started_at: 123,
      });
      expect(res.status).toBe(200);
      expect(meetingStartResponseSchema.parse(await res.json()).folder_id).toBe(
        folder_id ?? null,
      );
      const detail = await app.request(`${base}/${id}`);
      expect(
        meetingDetailResponseSchema.parse(await detail.json()).folder_id,
      ).toBe(folder_id ?? null);
    }
    const rejected = await jsonRequest(app, "POST", `${base}/start`, {
      id: "bad",
      folder_id: "missing",
      audio_dir: "/unused",
      started_at: 123,
    });
    expect(rejected.status).toBe(404);
    expect(meetingFolderErrorSchema.parse(await rejected.json()).code).toBe(
      "folder_not_found",
    );
    expect(
      getDb().prepare("SELECT id FROM meetings WHERE id = 'bad'").get(),
    ).toBeUndefined();
  });
});
