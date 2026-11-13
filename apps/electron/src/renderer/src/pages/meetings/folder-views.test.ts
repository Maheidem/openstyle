import type { MeetingListItem } from "@openstyle/validations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../locales/en.json";
import { toggleSelection } from "./batch";
import { FolderNameInput } from "./folder-controls";
import { FolderPanel } from "./folder-panel";
import { FolderTree } from "./folder-tree";
import type { MeetingFolder } from "./folders-model";
import { RecordingCard, type useRecorder } from "./recording";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: i18n.t.bind(i18n), i18n }),
}));

const folder: MeetingFolder = {
  id: "f1",
  name: "Work",
  description: "Test notes",
  color: "blue",
  created_at: 1000,
  updated_at: 1000,
  meeting_count: 205,
  first_meeting_at: 1000,
  last_meeting_at: 5000,
  total_duration_ms: 204000,
  stage_counts: {
    transcribe: { ready: 3, blocked: 1 },
    summarize: { ready: 0, blocked: 2 },
    enhance: { ready: 0, blocked: 0 },
    title: { ready: 0, blocked: 0 },
  },
};
function panel(value: MeetingFolder, action?: "description" | "delete") {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(FolderPanel, {
        folder: value,
        folders: [value],
        meetings: [],
        loading: false,
        failed: false,
        initialAction: action,
        onUpdate: vi.fn(async () => {}),
        onDelete: vi.fn(async () => {}),
        onOpen: vi.fn(),
        onMove: vi.fn(),
        onBack: vi.fn(),
        onStartBatch: vi.fn(async () => true),
      }),
    ),
  );
}

describe("folder views", () => {
  it("shows a lock notice and count for a non-empty folder", () => {
    const html = panel(folder, "delete");
    expect(html).toContain("You cannot delete this folder.");
    expect(html).toContain("Meetings in this folder: 205.");
    expect(html).toContain("Move or remove the meetings first.");
    expect(html).not.toContain("No meeting is deleted.");
  });
  it("asks for a confirm before it deletes an empty folder", () => {
    const html = panel({ ...folder, meeting_count: 0 }, "delete");
    expect(html).toContain("No meeting is deleted.");
    expect(html).toContain("You cannot undo this action.");
    expect(html).not.toContain("You cannot delete this folder.");
  });
  it("uses server facts and shows the list limit", () => {
    const html = panel(folder);
    expect(html).toContain("205");
    expect(html).toContain("3:24");
    expect(html).toContain("Shows the 0 newest meetings of 205.");
    expect(html).toContain("First meeting");
    expect(html).toContain("Last meeting");
  });
  it("shows what each stage needs, what cannot run, and a Run button per stage", () => {
    const html = panel(folder);
    expect(html).toContain("Stages to run");
    expect(html).toContain("Need it: 3");
    expect(html).toContain("No audio: 1");
    expect(html).toContain("No AI model: 2");
    expect(html).toContain("Run on 3");
    // A stage with no ready meeting has a disabled button.
    expect(html).toMatch(/disabled=""[^>]*>Run on 0/);
  });
  it("says that the folder is done when no stage is needed", () => {
    const none = { ready: 0, blocked: 0 };
    const html = panel({
      ...folder,
      stage_counts: {
        transcribe: none,
        summarize: none,
        enhance: none,
        title: none,
      },
    });
    expect(html).toContain("All meetings in this folder are done.");
    expect(html).not.toContain("Run on");
  });
  it("selects one row, a shift range in both directions, and clears a range", () => {
    const order = ["a", "b", "c", "d", "e"];
    let checked = toggleSelection(order, new Set(), null, "b", false);
    expect([...checked]).toEqual(["b"]);
    checked = toggleSelection(order, checked, "b", "d", true);
    expect([...checked].sort()).toEqual(["b", "c", "d"]);
    checked = toggleSelection(order, checked, "d", "a", true);
    expect([...checked].sort()).toEqual(["a", "b", "c", "d"]);
    // A range click on a checked row clears the range.
    checked = toggleSelection(order, checked, "a", "c", true);
    expect([...checked]).toEqual(["d"]);
    // No anchor: a range click acts on one row.
    expect([...toggleSelection(order, new Set(), null, "e", true)]).toEqual([
      "e",
    ]);
  });
  it("opens the description field from the folder menu action", () => {
    const html = panel(folder, "description");
    expect(html).toContain("textarea");
    expect(html).toContain("Test notes");
    expect(html).toContain('aria-label="Folder description"');
  });
  it("shows the inline name input with a length bound and key hint", () => {
    const html = renderToStaticMarkup(
      createElement(FolderNameInput, {
        onSave: vi.fn(async () => {}),
        onCancel: vi.fn(),
      }),
    );
    expect(html).toContain('aria-label="Folder name"');
    expect(html).toContain('maxLength="60"');
    expect(html).toContain("Enter saves. Esc cancels.");
  });
  it("shows the record target and waits for its data", () => {
    const recorder: ReturnType<typeof useRecorder> = {
      status: "idle",
      starting: false,
      supported: true,
      meetingId: null,
      startedAt: null,
      pausedAt: null,
      error: null,
      devices: null,
      pendingDevices: null,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      confirmDevices: vi.fn(async () => {}),
      dismissDevices: vi.fn(),
    };
    const html = renderToStaticMarkup(
      createElement(RecordingCard, {
        recorder,
        compact: true,
        targetName: "Work",
        targetReady: false,
      }),
    );
    expect(html).toContain("Records into");
    expect(html).toContain("Work");
    expect(html).toContain("disabled");
  });

  it("blocks the delete of a folder with sub-folders and gives both counts", () => {
    const html = panel(
      { ...folder, meeting_count: 3, child_count: 2 },
      "delete",
    );
    expect(html).toContain("You cannot delete this folder.");
    expect(html).toContain(
      "Sub-folders in this folder: 2. Meetings in this folder: 3. Move or delete the sub-folders first.",
    );
    // An empty parent with children is blocked too.
    const empty = panel(
      { ...folder, meeting_count: 0, child_count: 1 },
      "delete",
    );
    expect(empty).toContain("Sub-folders in this folder: 1.");
    expect(empty).not.toContain("No meeting is deleted.");
  });
  it("nests child rows under the parent, above the parent's own meetings", () => {
    const parent = {
      ...folder,
      id: "p",
      name: "Customer calls",
      child_count: 1,
    };
    const child = { ...folder, id: "c", name: "Lumen Labs", parent_id: "p" };
    const other = { ...folder, id: "o", name: "Hiring", parent_id: null };
    const meeting = (id: string, title: string, folderId: string | null) =>
      ({
        id,
        title,
        folder_id: folderId,
        started_at: 1000,
        duration_ms: 60_000,
        status: "summarized",
        job: null,
      }) as unknown as MeetingListItem;
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(FolderTree, {
          folders: [parent, other, child],
          groups: new Map([
            [
              "p",
              {
                // The list of a parent also holds the child meetings.
                meetings: [
                  meeting("m1", "Pilot check-in", "p"),
                  meeting("m2", "Onboarding call", "c"),
                ],
                loading: false,
                failed: false,
              },
            ],
            [
              "c",
              {
                meetings: [meeting("m2", "Onboarding call", "c")],
                loading: false,
                failed: false,
              },
            ],
          ]),
          expanded: { p: true, c: true },
          selectedFolderId: "p",
          activeId: null,
          creating: { parentId: "p" },
          renamingId: null,
          onExpanded: vi.fn(),
          onFolder: vi.fn(),
          onOpen: vi.fn(),
          onCreate: vi.fn(async () => {}),
          onCancelCreate: vi.fn(),
          onNew: vi.fn(),
          onNewChild: vi.fn(),
          onRename: vi.fn(),
          onSaveName: vi.fn(async () => {}),
          onCancelName: vi.fn(),
          onAction: vi.fn(),
          onMoveFolder: vi.fn(),
          onMove: vi.fn(),
          onDrop: vi.fn(),
        }),
      ),
    );
    const at = (text: string) => html.indexOf(text);
    // Order: parent row, new child input, child row, child meeting, parent
    // meeting, the next top-level folder, Unfiled last.
    expect(at('aria-label="Customer calls"')).toBeGreaterThan(-1);
    expect(at('aria-label="Folder name"')).toBeGreaterThan(
      at('aria-label="Customer calls"'),
    );
    expect(at('aria-label="Lumen Labs"')).toBeGreaterThan(
      at('aria-label="Folder name"'),
    );
    expect(at("Onboarding call")).toBeGreaterThan(
      at('aria-label="Lumen Labs"'),
    );
    expect(at("Pilot check-in")).toBeGreaterThan(at("Onboarding call"));
    expect(at('aria-label="Hiring"')).toBeGreaterThan(at("Pilot check-in"));
    expect(at('aria-label="Unfiled"')).toBeGreaterThan(
      at('aria-label="Hiring"'),
    );
    // The child meeting shows once: under the child, not under the parent.
    expect(html.split("Onboarding call").length - 1).toBe(1);
    // The child row has its own chevron.
    expect(html).toContain('aria-label="Collapse Lumen Labs"');
  });
});
