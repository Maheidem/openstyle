import { describe, expect, it } from "vitest";
import { standingErrorKey } from "./folder-standing";

describe("standingErrorKey", () => {
  it("maps each server code to its message", () => {
    const key = (code: string) => standingErrorKey({ error: "x", code });
    expect(key("no_content")).toBe("meetings.folderStanding.noContent");
    expect(key("no_llm")).toBe("meetings.folderStanding.noModel");
    expect(key("llm_failed")).toBe("meetings.folderStanding.failed");
    expect(key("folder_not_found")).toBe("meetings.folders.notFound");
  });

  it("gives the general message for an unknown body", () => {
    expect(standingErrorKey({ error: "x", code: "other" })).toBe(
      "meetings.folderStanding.failed",
    );
    expect(standingErrorKey("Internal Server Error")).toBe(
      "meetings.folderStanding.failed",
    );
  });
});
