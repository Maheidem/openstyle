import { beforeEach, describe, expect, it } from "vitest";
import {
  readMeetingsSelection,
  rememberMeetingsSelection,
  resetMeetingsSelection,
  validateSelection,
} from "./selection-memory";

describe("meetings selection memory", () => {
  beforeEach(resetMeetingsSelection);

  it("starts with nothing selected", () => {
    expect(readMeetingsSelection()).toEqual({
      selectedId: null,
      selectedFolderId: null,
      expanded: { none: true },
    });
  });

  it("returns the last remembered selection after a page switch", () => {
    rememberMeetingsSelection({
      selectedId: "b2",
      selectedFolderId: null,
      expanded: { none: true, b: true },
    });
    expect(readMeetingsSelection().selectedId).toBe("b2");
    expect(readMeetingsSelection().expanded).toEqual({ none: true, b: true });
  });

  it("keeps a remembered meeting and folder that still exist", () => {
    expect(
      validateSelection(
        { selectedId: "m1", selectedFolderId: "f1" },
        new Set(["m1"]),
        new Set(["f1"]),
      ),
    ).toEqual({ selectedId: "m1", selectedFolderId: "f1" });
  });

  it("drops a remembered meeting or folder that no longer exists", () => {
    expect(
      validateSelection(
        { selectedId: "gone", selectedFolderId: "gone" },
        new Set(["m1"]),
        new Set(["f1"]),
      ),
    ).toEqual({ selectedId: null, selectedFolderId: null });
  });
});
