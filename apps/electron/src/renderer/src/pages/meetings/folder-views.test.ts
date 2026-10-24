import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../locales/en.json";
import { FolderNameInput } from "./folder-controls";
import { FolderPanel } from "./folder-panel";
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
};
function panel(value: MeetingFolder, action?: "description" | "delete") {
  return renderToStaticMarkup(
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
    }),
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
});
