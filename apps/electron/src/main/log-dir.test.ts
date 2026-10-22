import { describe, expect, it } from "vitest";
import { resolveLogsDir } from "./log-dir";

const DEFAULT = "/Users/me/Library/Logs/Openstyle";

describe("resolveLogsDir", () => {
  it("uses the default folder when no override is set", () => {
    expect(resolveLogsDir({}, DEFAULT)).toBe(DEFAULT);
  });

  it("uses <OPENSTYLE_USER_DATA>/logs for an isolated profile", () => {
    expect(
      resolveLogsDir({ OPENSTYLE_USER_DATA: "/tmp/run/profile" }, DEFAULT),
    ).toBe("/tmp/run/profile/logs");
  });

  it("prefers OPENSTYLE_LOG_DIR over the profile folder", () => {
    expect(
      resolveLogsDir(
        {
          OPENSTYLE_LOG_DIR: "/tmp/run/logs",
          OPENSTYLE_USER_DATA: "/tmp/run/profile",
        },
        DEFAULT,
      ),
    ).toBe("/tmp/run/logs");
  });

  it("reads the legacy FREESTYLE_* names", () => {
    expect(resolveLogsDir({ FREESTYLE_LOG_DIR: "/tmp/a" }, DEFAULT)).toBe(
      "/tmp/a",
    );
    expect(resolveLogsDir({ FREESTYLE_USER_DATA: "/tmp/b" }, DEFAULT)).toBe(
      "/tmp/b/logs",
    );
  });

  it("ignores an empty OPENSTYLE_LOG_DIR", () => {
    expect(resolveLogsDir({ OPENSTYLE_LOG_DIR: "" }, DEFAULT)).toBe(DEFAULT);
  });
});
