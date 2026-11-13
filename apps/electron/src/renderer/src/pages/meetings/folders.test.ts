import type { MeetingListItem } from "@openstyle/validations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FolderRequestError,
  folderErrorKey,
  folderMoveTargets,
  folderNameTaken,
  folderPath,
  folderTreeOrder,
  type MeetingFolder,
  meetingGroups,
  recordingFolderId,
  widerScope,
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

describe("sub-folders", () => {
  const make = (
    id: string,
    name: string,
    parent: string | null = null,
    extra: Partial<MeetingFolder> = {},
  ): MeetingFolder => ({
    ...folder,
    id,
    name,
    parent_id: parent,
    child_count: 0,
    ...extra,
  });
  // The server order: by name, children mixed with the top level.
  const tree = [
    make("cust", "Customer calls", null, { child_count: 2, meeting_count: 3 }),
    make("hire", "Hiring", null, { meeting_count: 2 }),
    make("lumen", "Lumen Labs", "cust", { meeting_count: 1 }),
    make("prod", "Product team", null, { meeting_count: 5 }),
    make("supp", "Support", "cust", { meeting_count: 1 }),
  ];
  const row = (id: string, folderId: string | null) =>
    ({ id, folder_id: folderId }) as MeetingListItem;

  it("puts each child folder after its parent, one step in", () => {
    expect(
      folderTreeOrder(tree).map(({ folder: f, depth }) => `${depth}:${f.id}`),
    ).toEqual(["0:cust", "1:lumen", "1:supp", "0:hire", "0:prod"]);
    // A child of a missing parent shows at the top level.
    expect(
      folderTreeOrder([make("orphan", "Orphan", "gone")]).map((x) => x.depth),
    ).toEqual([0]);
  });

  it("names a child folder with its parent", () => {
    expect(folderPath(tree, "lumen")).toBe("Customer calls / Lumen Labs");
    expect(folderPath(tree, "hire")).toBe("Hiring");
    expect(folderPath(tree, null)).toBeNull();
    expect(folderPath(tree, "gone")).toBeNull();
  });

  it("checks a name per parent, with no case", () => {
    expect(folderNameTaken(tree, "support", "cust")).toBe(true);
    expect(folderNameTaken(tree, "Support", null)).toBe(false);
    expect(folderNameTaken(tree, "Support", "cust", "supp")).toBe(false);
    expect(folderNameTaken(tree, "hiring", null)).toBe(true);
  });

  it("offers the top level and the other top-level folders as move targets", () => {
    const targets = folderMoveTargets(tree, tree[2]);
    expect(targets.map((x) => x.parentId)).toEqual([
      null,
      "cust",
      "hire",
      "prod",
    ]);
    expect(targets.find((x) => x.current)?.parentId).toBe("cust");
    expect(targets.every((x) => !x.nameTaken)).toBe(true);
    // A top-level folder is at the top level now.
    const top = folderMoveTargets(tree, tree[1]);
    expect(top[0]).toMatchObject({ parentId: null, current: true });
    expect(top.map((x) => x.parentId)).not.toContain("hire");
  });

  it("marks a target that has a folder with the same name", () => {
    const withClash = [...tree, make("hire-supp", "support", "hire")];
    const targets = folderMoveTargets(withClash, tree[4]);
    expect(targets.find((x) => x.parentId === "hire")?.nameTaken).toBe(true);
    expect(targets.find((x) => x.parentId === "prod")?.nameTaken).toBe(false);
  });

  it("gives no move targets to a folder that has children", () => {
    expect(folderMoveTargets(tree, tree[0])).toEqual([]);
  });

  it("groups the list of a parent: own meetings first, then each child", () => {
    const meetings = [
      row("m1", "cust"),
      row("m2", "lumen"),
      row("m3", "supp"),
      row("m4", "cust"),
    ];
    const groups = meetingGroups(tree, tree[0], meetings);
    expect(
      groups?.map((g) => [g.folder.id, g.own, g.meetings.map((m) => m.id)]),
    ).toEqual([
      ["cust", true, ["m1", "m4"]],
      ["lumen", false, ["m2"]],
      ["supp", false, ["m3"]],
    ]);
    // A group with no meetings does not show.
    expect(
      meetingGroups(tree, tree[0], [row("m2", "lumen")])?.map(
        (g) => g.folder.id,
      ),
    ).toEqual(["lumen"]);
    // A folder with no children has one flat list.
    expect(meetingGroups(tree, tree[2], [row("m2", "lumen")])).toBeNull();
  });

  it("widens a child folder to its parent, then to all meetings", () => {
    const meetings = [row("m2", "lumen"), row("m5", null)];
    expect(widerScope({ kind: "meeting", id: "m2" }, meetings, tree)).toEqual({
      kind: "folder",
      id: "lumen",
    });
    expect(widerScope({ kind: "folder", id: "lumen" }, meetings, tree)).toEqual(
      { kind: "folder", id: "cust" },
    );
    expect(widerScope({ kind: "folder", id: "cust" }, meetings, tree)).toEqual({
      kind: "all",
    });
    expect(widerScope({ kind: "meeting", id: "m5" }, meetings, tree)).toEqual({
      kind: "all",
    });
    expect(widerScope({ kind: "all" }, meetings, tree)).toBeNull();
  });

  it("creates a child folder and moves a folder with parent_id", async () => {
    const actions = useMeetingFolders(true);
    await actions.create("Renewals", "cust");
    expect(mocks.create).toHaveBeenCalledWith({
      json: { name: "Renewals", parent_id: "cust" },
    });
    await actions.update("lumen", { parent_id: null });
    expect(mocks.update).toHaveBeenCalledWith({
      param: { id: "lumen" },
      json: { parent_id: null },
    });
  });

  it("keeps the child count of a blocked delete and names the depth error", async () => {
    mocks.remove.mockResolvedValue(
      response(
        { code: "folder_has_children", child_count: 2, error: "children" },
        false,
      ),
    );
    await expect(useMeetingFolders(true).remove("cust")).rejects.toMatchObject({
      code: "folder_has_children",
      childCount: 2,
      meetingCount: 0,
    });
    expect(
      folderErrorKey(new FolderRequestError("folder_depth_exceeded")),
    ).toBe("meetings.folders.depthExceeded");
  });
});
