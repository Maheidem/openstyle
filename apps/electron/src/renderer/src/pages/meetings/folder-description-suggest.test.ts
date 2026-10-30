import { describe, expect, it } from "vitest";
import { suggestErrorKey } from "./folder-description-suggest";

describe("suggestErrorKey", () => {
  it("maps each server code to its message", () => {
    const key = (code: string) => suggestErrorKey({ error: "x", code });
    expect(key("no_summaries")).toBe("meetings.folderSuggest.noSummaries");
    expect(key("no_llm")).toBe("meetings.folderSuggest.noModel");
    expect(key("llm_failed")).toBe("meetings.folderSuggest.failed");
    expect(key("folder_not_found")).toBe("meetings.folders.notFound");
  });

  it("gives the general message for an unknown body", () => {
    expect(suggestErrorKey({ error: "x", code: "other" })).toBe(
      "meetings.folderSuggest.failed",
    );
    expect(suggestErrorKey("Internal Server Error")).toBe(
      "meetings.folderSuggest.failed",
    );
  });
});
