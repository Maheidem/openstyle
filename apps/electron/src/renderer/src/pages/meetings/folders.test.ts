import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FolderRequestError,
  folderErrorKey,
  recordingFolderId,
} from "./folders-model";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  folders: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  move: vi.fn(),
  invalidate: vi.fn(async () => {}),
  setData: vi.fn(),
  query: vi.fn(() => ({ data: [] })),
}));
vi.mock("@renderer/lib/api", () => ({
  getClient: () => ({
    api: {
      meetings: {
        $get: mocks.list,
        folders: {
          $get: mocks.folders,
          $post: mocks.create,
          ":id": { $patch: mocks.update, $delete: mocks.remove },
        },
        move: { $post: mocks.move },
      },
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: mocks.query,
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidate,
    setQueryData: mocks.setData,
  }),
}));

const { folderMeetingsOptions, useMeetingFolders } = await import(
  "./folders-data"
);
const folder = {
  id: "f1",
  name: "Work",
  description: null,
  color: null,
  created_at: 1,
  updated_at: 1,
  meeting_count: 0,
  first_meeting_at: null,
  last_meeting_at: null,
  total_duration_ms: 0,
  stage_counts: {
    transcribe: { ready: 0, blocked: 0 },
    summarize: { ready: 0, blocked: 0 },
    enhance: { ready: 0, blocked: 0 },
  },
};
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue(response(folder));
  mocks.update.mockResolvedValue(response(folder));
  mocks.remove.mockResolvedValue(response({ ok: true }));
  mocks.move.mockResolvedValue(response({ ok: true }));
  mocks.list.mockResolvedValue(response({ items: [] }));
});

describe("record target", () => {
  it("uses the selected folder before the open meeting", () => {
    expect(recordingFolderId("selected", { folder_id: "meeting-folder" })).toBe(
      "selected",
    );
    expect(recordingFolderId("selected", null)).toBe("selected");
  });
  it("uses the open meeting folder, also when it has no folder", () => {
    expect(recordingFolderId(null, { folder_id: "meeting-folder" })).toBe(
      "meeting-folder",
    );
    expect(recordingFolderId(null, { folder_id: null })).toBeNull();
    expect(recordingFolderId(null, null)).toBeNull();
  });
});

describe("folder requests", () => {
  it("uses folder and unfiled filters with separate query keys", async () => {
    const filed = folderMeetingsOptions("f1");
    const unfiled = folderMeetingsOptions(null);
    expect(filed.queryKey).not.toEqual(unfiled.queryKey);
    await filed.queryFn();
    expect(mocks.list).toHaveBeenLastCalledWith({ query: { folder_id: "f1" } });
    await unfiled.queryFn();
    expect(mocks.list).toHaveBeenLastCalledWith({
      query: { folder_id: "none" },
    });
  });

  it("polls while a row runs a job, and stops when no row is busy", () => {
    const { refetchInterval } = folderMeetingsOptions("f1");
    const rows = (job: unknown) => ({
      state: {
        data: [{ status: "transcribed", job }] as never,
      },
    });
    expect(refetchInterval(rows({ kind: "enhance", done: 1, total: 8 }))).toBe(
      2000,
    );
    expect(refetchInterval(rows(null))).toBe(false);
  });

  it("creates and updates folders, then refreshes all meeting data", async () => {
    const actions = useMeetingFolders(true);
    expect(await actions.create("Work")).toEqual(folder);
    expect(mocks.create).toHaveBeenCalledWith({ json: { name: "Work" } });
    await actions.update("f1", { name: "Home", description: null });
    expect(mocks.update).toHaveBeenCalledWith({
      param: { id: "f1" },
      json: { name: "Home", description: null },
    });
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["meetings"] });
  });

  it("keeps duplicate-name errors typed for the inline input", async () => {
    mocks.create.mockResolvedValue(
      response({ code: "folder_name_exists", error: "duplicate" }, false),
    );
    await expect(useMeetingFolders(true).create("Work")).rejects.toMatchObject({
      code: "folder_name_exists",
    });
    expect(folderErrorKey(new FolderRequestError("folder_name_exists"))).toBe(
      "meetings.folders.nameExists",
    );
    expect(folderErrorKey(new Error("offline"))).toBe(
      "meetings.folders.requestFailed",
    );
  });

  it("keeps a blocked delete count and does not report success", async () => {
    mocks.remove.mockResolvedValue(
      response(
        { code: "folder_not_empty", meeting_count: 12, error: "not empty" },
        false,
      ),
    );
    await expect(useMeetingFolders(true).remove("f1")).rejects.toMatchObject({
      code: "folder_not_empty",
      meetingCount: 12,
    });
  });

  it("deletes an empty folder and refreshes the tree", async () => {
    await useMeetingFolders(true).remove("f1");
    expect(mocks.remove).toHaveBeenCalledWith({ param: { id: "f1" } });
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it("moves to a folder or unfiled and updates the cached record target", async () => {
    const actions = useMeetingFolders(true);
    await actions.move({ id: "m1", folder_id: null }, "f1");
    expect(mocks.move).toHaveBeenCalledWith({
      json: { meeting_ids: ["m1"], folder_id: "f1" },
    });
    const updater = mocks.setData.mock.calls[0][1] as (old: unknown) => unknown;
    expect(updater({ id: "m1", folder_id: null })).toEqual({
      id: "m1",
      folder_id: "f1",
    });
    await actions.move({ id: "m1", folder_id: "f1" }, null);
    expect(mocks.move).toHaveBeenLastCalledWith({
      json: { meeting_ids: ["m1"], folder_id: null },
    });
  });

  it("does not send a move to the same folder or change the cache on failure", async () => {
    const actions = useMeetingFolders(true);
    await actions.move({ id: "m1", folder_id: "f1" }, "f1");
    expect(mocks.move).not.toHaveBeenCalled();
    mocks.move.mockResolvedValue(
      response({ code: "folder_not_found", error: "gone" }, false),
    );
    await expect(
      actions.move({ id: "m1", folder_id: null }, "gone"),
    ).rejects.toMatchObject({ code: "folder_not_found" });
    expect(mocks.setData).not.toHaveBeenCalled();
  });
});
