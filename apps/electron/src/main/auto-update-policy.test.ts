import { describe, expect, it } from "vitest";
import { shouldStartAutoDownload } from "./auto-update-policy";

const base = {
  autoUpdateEnabled: true,
  downloadState: "idle",
  selfUpdateUnavailableReason: null,
} as const;

describe("shouldStartAutoDownload", () => {
  it("starts the download when auto-update is on and self-update can run", () => {
    expect(shouldStartAutoDownload(base)).toBe(true);
  });

  it("does not start the download when auto-update is off", () => {
    expect(shouldStartAutoDownload({ ...base, autoUpdateEnabled: false })).toBe(
      false,
    );
  });

  it("does not start a second download while one runs", () => {
    expect(
      shouldStartAutoDownload({ ...base, downloadState: "downloading" }),
    ).toBe(false);
  });

  it("does not download again after the download is done", () => {
    expect(
      shouldStartAutoDownload({ ...base, downloadState: "downloaded" }),
    ).toBe(false);
  });

  it("does not start a background download where only the releases page works", () => {
    expect(
      shouldStartAutoDownload({
        ...base,
        selfUpdateUnavailableReason: "not macOS",
      }),
    ).toBe(false);
  });
});
