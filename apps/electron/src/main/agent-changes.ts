// Live apply of a change that an agent made through MCP (specs/mcp.md 6.3).
// The server process sends one message for each write tool
// (apps/server/src/mcp/emit.ts): { type: "agent-change", kind, ids, keys }.
// A setting change goes to the same main-process path that the Settings page
// uses. Then every window gets `data:changed` and reads its data again.
import { createAppLogger } from "@openstyle/utils";
import { normalizeAudioPlaybackMode } from "../shared/audio-playback";
import { SETTINGS_KEYS } from "../shared/settings-keys";
import { hotkeyFromSettings, hotkeyModeFromSettings } from "./hotkey-utils";
import { refreshChatHotkey } from "./hotkeys/chat";
import {
  applyLanguageHotkeySettings,
  scheduleHotkeyRegistration,
  setHotkeyActivationMode,
} from "./hotkeys/dictation";
import { broadcastDataChanged } from "./main-state";
import {
  sendAudioPlaybackModeToPill,
  sendCleanupContextChangedToPill,
  sendOutputModeToPill,
  sendPillCancelModeToPill,
  sendSoundEnabledToPill,
} from "./pill-settings";
import { getServerSettings } from "./server-target";

const log = createAppLogger("mcp");

/** The message of apps/server/src/mcp/emit.ts. */
export interface AgentChangeMessage {
  type: "agent-change";
  /** For example "meeting", "folder" or "setting". */
  kind: string;
  ids: string[];
  /** The changed settings keys (kind "setting" only). */
  keys: string[];
}

type Settings = Record<string, string>;

/** The keys whose live path needs the new value from the server. */
const VALUE_KEYS = new Set<string>([
  SETTINGS_KEYS.hotkey,
  SETTINGS_KEYS.hotkeyMode,
  SETTINGS_KEYS.languageHotkeys,
  SETTINGS_KEYS.outputMode,
  SETTINGS_KEYS.soundEnabled,
  SETTINGS_KEYS.pillCancelButton,
  SETTINGS_KEYS.audioPlaybackMode,
]);

function isCleanupKey(key: string): boolean {
  return key === SETTINGS_KEYS.llmCleanup || key.startsWith("cleanup_");
}

/** Apply the changed settings keys. The table of specs/mcp.md 6.3. */
async function applySettingKeys(keys: string[]): Promise<void> {
  const changed = new Set(keys);
  const needsValues = keys.some((key) => VALUE_KEYS.has(key));
  const settings: Settings | null = needsValues
    ? await getServerSettings()
    : {};
  if (settings && needsValues) {
    if (changed.has(SETTINGS_KEYS.hotkeyMode)) {
      // setHotkeyActivationMode also registers the hotkey again.
      setHotkeyActivationMode(hotkeyModeFromSettings(settings));
    }
    if (changed.has(SETTINGS_KEYS.hotkey)) {
      scheduleHotkeyRegistration(hotkeyFromSettings(settings));
    }
    if (changed.has(SETTINGS_KEYS.languageHotkeys)) {
      applyLanguageHotkeySettings(settings);
    }
    const outputMode = settings[SETTINGS_KEYS.outputMode];
    if (changed.has(SETTINGS_KEYS.outputMode) && outputMode !== undefined) {
      sendOutputModeToPill(outputMode);
    }
    if (changed.has(SETTINGS_KEYS.soundEnabled)) {
      // A missing row means on. Only "false" turns the sound off.
      sendSoundEnabledToPill(settings[SETTINGS_KEYS.soundEnabled] !== "false");
    }
    if (changed.has(SETTINGS_KEYS.pillCancelButton)) {
      sendPillCancelModeToPill(settings[SETTINGS_KEYS.pillCancelButton]);
    }
    if (changed.has(SETTINGS_KEYS.audioPlaybackMode)) {
      sendAudioPlaybackModeToPill(
        normalizeAudioPlaybackMode(settings[SETTINGS_KEYS.audioPlaybackMode]),
      );
    }
  } else if (needsValues) {
    log.warn("Agent change: the server did not give the settings.");
  }
  if (
    changed.has(SETTINGS_KEYS.chatHotkey) ||
    changed.has(SETTINGS_KEYS.meetingChatEnabled)
  ) {
    await refreshChatHotkey();
  }
  if (keys.some(isCleanupKey)) sendCleanupContextChangedToPill();
}

/**
 * Apply one agent change. Every change, also a failed live apply, ends with
 * `data:changed` to every window.
 */
export async function applyAgentChange(
  change: AgentChangeMessage,
): Promise<void> {
  try {
    if (change.kind === "setting") await applySettingKeys(change.keys ?? []);
  } catch (err) {
    log.error(`Agent change (${change.kind}) failed: ${String(err)}`);
  } finally {
    broadcastDataChanged();
  }
}
