import { beforeEach, describe, expect, it, vi } from "vitest";

// Each row of the live-apply table (specs/mcp.md 6.3) calls its function, and
// every change sends data:changed.

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, string> | null,
  scheduleHotkeyRegistration: vi.fn(),
  setHotkeyActivationMode: vi.fn(),
  applyLanguageHotkeySettings: vi.fn(),
  refreshChatHotkey: vi.fn(async () => {}),
  sendOutputModeToPill: vi.fn(),
  sendSoundEnabledToPill: vi.fn(),
  sendPillCancelModeToPill: vi.fn(),
  sendAudioPlaybackModeToPill: vi.fn(),
  sendCleanupContextChangedToPill: vi.fn(),
  broadcastDataChanged: vi.fn(),
}));

vi.mock("./hotkeys/dictation", () => ({
  scheduleHotkeyRegistration: mocks.scheduleHotkeyRegistration,
  setHotkeyActivationMode: mocks.setHotkeyActivationMode,
  applyLanguageHotkeySettings: mocks.applyLanguageHotkeySettings,
}));
vi.mock("./hotkeys/chat", () => ({
  refreshChatHotkey: mocks.refreshChatHotkey,
}));
vi.mock("./pill-settings", () => ({
  sendOutputModeToPill: mocks.sendOutputModeToPill,
  sendSoundEnabledToPill: mocks.sendSoundEnabledToPill,
  sendPillCancelModeToPill: mocks.sendPillCancelModeToPill,
  sendAudioPlaybackModeToPill: mocks.sendAudioPlaybackModeToPill,
  sendCleanupContextChangedToPill: mocks.sendCleanupContextChangedToPill,
}));
vi.mock("./main-state", () => ({
  broadcastDataChanged: mocks.broadcastDataChanged,
}));
vi.mock("./server-target", () => ({
  getServerSettings: async () => mocks.settings,
}));

import { applyAgentChange } from "./agent-changes";

const setting = (keys: string[]) =>
  applyAgentChange({ type: "agent-change", kind: "setting", ids: [], keys });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {};
});

describe("applyAgentChange", () => {
  it("sends data:changed for a change with no live path", async () => {
    await applyAgentChange({
      type: "agent-change",
      kind: "meeting",
      ids: ["m1"],
      keys: [],
    });
    expect(mocks.broadcastDataChanged).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleHotkeyRegistration).not.toHaveBeenCalled();
    expect(mocks.refreshChatHotkey).not.toHaveBeenCalled();
  });

  it("hotkey: registers the saved accelerator", async () => {
    mocks.settings = { hotkey: "Control+Shift+Space" };
    await setting(["hotkey"]);
    expect(mocks.scheduleHotkeyRegistration).toHaveBeenCalledWith(
      "Control+Shift+Space",
    );
    expect(mocks.broadcastDataChanged).toHaveBeenCalledTimes(1);
  });

  it("hotkey_mode: sets the mode", async () => {
    mocks.settings = { hotkey_mode: "toggle" };
    await setting(["hotkey_mode"]);
    expect(mocks.setHotkeyActivationMode).toHaveBeenCalledWith("toggle");
  });

  it("language_hotkeys: applies the map from the settings", async () => {
    mocks.settings = { language_hotkeys: '{"pt":"Control+Alt+P"}' };
    await setting(["language_hotkeys"]);
    expect(mocks.applyLanguageHotkeySettings).toHaveBeenCalledWith(
      mocks.settings,
    );
  });

  it("chat_hotkey and meeting_chat_enabled: refresh the chat hotkey", async () => {
    await setting(["chat_hotkey"]);
    await setting(["meeting_chat_enabled"]);
    expect(mocks.refreshChatHotkey).toHaveBeenCalledTimes(2);
  });

  it("pill settings: send the new values to the pill", async () => {
    mocks.settings = {
      output_mode: "clipboard",
      sound_enabled: "false",
      pill_cancel_button: "always",
      audio_playback_mode: "duck",
    };
    await setting([
      "output_mode",
      "sound_enabled",
      "pill_cancel_button",
      "audio_playback_mode",
    ]);
    expect(mocks.sendOutputModeToPill).toHaveBeenCalledWith("clipboard");
    expect(mocks.sendSoundEnabledToPill).toHaveBeenCalledWith(false);
    expect(mocks.sendPillCancelModeToPill).toHaveBeenCalledWith("always");
    expect(mocks.sendAudioPlaybackModeToPill).toHaveBeenCalledWith("duck");
  });

  it("llm_cleanup and cleanup_*: tell the pill to read the cleanup context again", async () => {
    await setting(["llm_cleanup"]);
    await setting(["cleanup_work_tone"]);
    expect(mocks.sendCleanupContextChangedToPill).toHaveBeenCalledTimes(2);
  });

  it("a key with no live path only sends data:changed", async () => {
    await setting(["history_retention_days"]);
    expect(mocks.broadcastDataChanged).toHaveBeenCalledTimes(1);
    expect(mocks.sendOutputModeToPill).not.toHaveBeenCalled();
    expect(mocks.refreshChatHotkey).not.toHaveBeenCalled();
  });

  it("sends data:changed also when the server does not answer", async () => {
    mocks.settings = null;
    await setting(["hotkey"]);
    expect(mocks.scheduleHotkeyRegistration).not.toHaveBeenCalled();
    expect(mocks.broadcastDataChanged).toHaveBeenCalledTimes(1);
  });

  it("sends data:changed also when a live path throws", async () => {
    mocks.refreshChatHotkey.mockRejectedValueOnce(new Error("listener"));
    await setting(["chat_hotkey"]);
    expect(mocks.broadcastDataChanged).toHaveBeenCalledTimes(1);
  });
});
