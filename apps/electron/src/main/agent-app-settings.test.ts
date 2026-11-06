// The main side of the app-settings request (specs/mcp.md 6.4). The Electron
// functions are fakes: the test checks that each field calls the same
// function as the Settings IPC handler, and that the answer holds only the
// four app-shell values (never serverToken).
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings: Record<string, unknown> = {};
let loginItem = false;

vi.mock("electron", () => ({ app: { getVersion: () => "3.1.0-alpha.1" } }));
vi.mock("./local-settings", () => ({
  readSettings: () => settings,
  writeSettings: vi.fn((patch: Record<string, unknown>) =>
    Object.assign(settings, patch),
  ),
}));
vi.mock("./app-settings-ipc", () => ({
  isLaunchAtLogin: () => loginItem,
  setLaunchAtLogin: vi.fn((on: boolean) => {
    loginItem = on;
  }),
}));
vi.mock("./ipc/core-ipc", () => ({
  applyPillPosition: vi.fn((position: string) => {
    settings.pillPosition = position;
  }),
}));
vi.mock("./updater", () => ({
  switchUpdateChannel: vi.fn(async (channel: string) => {
    settings.updateChannel = channel;
  }),
}));

const { handleAppSettingsRequest } = await import("./agent-app-settings");
const { writeSettings } = await import("./local-settings");
const { setLaunchAtLogin } = await import("./app-settings-ipc");
const { applyPillPosition } = await import("./ipc/core-ipc");
const { switchUpdateChannel } = await import("./updater");

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(settings, {
    serverToken: "fictional-secret-token",
    serverUrl: "http://example.invalid",
  });
  loginItem = false;
  vi.clearAllMocks();
});

describe("handleAppSettingsRequest", () => {
  it("reads the four values with defaults, and never the token", () => {
    const answer = handleAppSettingsRequest({
      type: "app-settings-request",
      id: 7,
      patch: null,
    });
    expect(answer).toEqual({
      type: "app-settings-result",
      id: 7,
      ok: true,
      settings: {
        pill_position: "bottom-center",
        auto_update: true,
        // An alpha build with no saved channel is on Dev.
        update_channel: "dev",
        launch_at_login: false,
      },
    });
    expect(JSON.stringify(answer)).not.toContain("fictional-secret-token");
    expect(JSON.stringify(answer)).not.toContain("serverUrl");
  });

  it("reads a dragged pill as custom", () => {
    settings.pillPosition = "custom";
    const answer = handleAppSettingsRequest({
      type: "app-settings-request",
      id: 1,
      patch: null,
    });
    expect(answer.ok && answer.settings.pill_position).toBe("custom");
  });

  it("applies each field with the function of its IPC handler", () => {
    const answer = handleAppSettingsRequest({
      type: "app-settings-request",
      id: 2,
      patch: {
        pill_position: "top-right",
        auto_update: false,
        update_channel: "stable",
        launch_at_login: true,
      },
    });
    expect(applyPillPosition).toHaveBeenCalledWith("top-right");
    expect(writeSettings).toHaveBeenCalledWith({ autoUpdate: false });
    expect(setLaunchAtLogin).toHaveBeenCalledWith(true);
    expect(switchUpdateChannel).toHaveBeenCalledWith("stable");
    expect(answer).toEqual({
      type: "app-settings-result",
      id: 2,
      ok: true,
      settings: {
        pill_position: "top-right",
        auto_update: false,
        update_channel: "stable",
        launch_at_login: true,
      },
    });
    expect(settings.serverToken).toBe("fictional-secret-token");
  });

  it("refuses a bad patch and changes nothing", () => {
    for (const patch of [
      { pill_position: "custom" },
      { auto_update: "yes" },
      { update_channel: "beta" },
      { launch_at_login: 1 },
      { serverToken: "x" },
      { auto_update: false, pill_position: "middle" },
    ]) {
      const answer = handleAppSettingsRequest({
        type: "app-settings-request",
        id: 3,
        patch,
      });
      expect(answer.ok, JSON.stringify(patch)).toBe(false);
    }
    expect(writeSettings).not.toHaveBeenCalled();
    expect(applyPillPosition).not.toHaveBeenCalled();
    expect(setLaunchAtLogin).not.toHaveBeenCalled();
    expect(switchUpdateChannel).not.toHaveBeenCalled();
    expect(settings.serverToken).toBe("fictional-secret-token");
  });

  it("answers ok false when a function throws", () => {
    vi.mocked(setLaunchAtLogin).mockImplementationOnce(() => {
      throw new Error("Login items are not available");
    });
    const answer = handleAppSettingsRequest({
      type: "app-settings-request",
      id: 4,
      patch: { launch_at_login: true },
    });
    expect(answer).toEqual({
      type: "app-settings-result",
      id: 4,
      ok: false,
      error: "Login items are not available",
    });
  });
});
