// The settings that an agent can read and change through MCP. This is an
// allowlist over SETTINGS_KEYS. Each key of SETTINGS_KEYS is either here or
// in SETTINGS_EXCLUDED with a reason; tests/mcp.test.ts fails otherwise.
// No credential keys (API keys, tokens, secrets) are here: those live in the
// keys table, and SETTINGS_KEYS holds none of them.
import { SETTINGS_KEYS } from "@openstyle/validations";

export type SettingType = "boolean" | "integer" | "enum" | "string" | "json";

export interface SettingEntry {
  type: SettingType;
  description: string;
  /** The allowed values of an "enum" setting. */
  values?: readonly string[];
}

const K = SETTINGS_KEYS;

export const SETTINGS_CATALOG: Readonly<Record<string, SettingEntry>> = {
  [K.advancedMode]: {
    type: "boolean",
    description: "Show the advanced settings in the app.",
  },
  [K.audioPlaybackMode]: {
    type: "enum",
    values: ["off", "duck", "pause"],
    description:
      "What other audio does while you dictate: off, duck (lower it) or pause.",
  },
  [K.cleanupAppAssignments]: {
    type: "json",
    description: "JSON map of apps to cleanup tones.",
  },
  [K.cleanupCustomPrompt]: {
    type: "string",
    description: "The custom prompt of the dictation cleanup.",
  },
  [K.cleanupEmailTone]: {
    type: "string",
    description: "The cleanup tone for email apps.",
  },
  [K.cleanupIntensity]: {
    type: "enum",
    values: ["low", "medium", "high", "custom"],
    description: "How much the AI cleanup changes the dictated text.",
  },
  [K.cleanupOverallTone]: {
    type: "string",
    description: "The default cleanup tone.",
  },
  [K.cleanupPersonalTone]: {
    type: "string",
    description: "The cleanup tone for personal chat apps.",
  },
  [K.cleanupSampling]: {
    type: "json",
    description: "JSON sampling parameters of the cleanup model.",
  },
  [K.cleanupWorkTone]: {
    type: "string",
    description: "The cleanup tone for work chat apps.",
  },
  [K.hotkey]: {
    type: "string",
    description: "The dictation hotkey, for example Alt+Space.",
  },
  [K.hotkeyMode]: {
    type: "enum",
    values: ["hold", "toggle"],
    description:
      "hold: dictate while the key is down. toggle: press to start and stop.",
  },
  [K.historyPaused]: {
    type: "boolean",
    description: "When true, the app does not save new dictations.",
  },
  [K.historyRetentionDays]: {
    type: "string",
    description:
      "How many days the app keeps dictations. Empty means keep them all.",
  },
  [K.languageHotkeys]: {
    type: "json",
    description: "JSON map of hotkeys to dictation languages.",
  },
  [K.languages]: {
    type: "json",
    description: 'JSON array of ISO language codes, for example ["en","pt"].',
  },
  [K.llmCleanup]: {
    type: "boolean",
    description: "Turn the AI cleanup of dictated text on or off.",
  },
  [K.llmParameterPresets]: {
    type: "json",
    description: "JSON list of the LLM parameter presets.",
  },
  [K.llmTaskAssignments]: {
    type: "json",
    description:
      "JSON map of LLM tasks (cleanup, enhance, summarize, chat) to models.",
  },
  [K.meetingAsrContext]: {
    type: "boolean",
    description:
      "Give the previous chunk text to meeting transcription as context.",
  },
  [K.calendarEnabled]: {
    type: "boolean",
    description: "Link meetings to calendar events.",
  },
  [K.meetingDiarizationEnabled]: {
    type: "boolean",
    description: "Find the speakers after a meeting transcription.",
  },
  [K.meetingEnhanceAutoRun]: {
    type: "boolean",
    description: "Run Enhance and Summarize after each meeting transcription.",
  },
  [K.meetingProjectMemory]: {
    type: "boolean",
    description:
      "Summary and Enhance of a filed meeting use earlier meetings of its folder.",
  },
  [K.meetingAutoTitle]: {
    type: "boolean",
    description:
      "After Summarize, give a meeting with no title or a file name a short AI title.",
  },
  [K.liveChatEnabled]: {
    type: "boolean",
    description:
      "Live transcript during a recording. It starts with the next recording.",
  },
  [K.meetingChatEnabled]: {
    type: "boolean",
    description: "Show the Ask tab (questions about your meetings).",
  },
  [K.chatRounds]: {
    type: "integer",
    description: "Ask: tool rounds per answer, 1 to 5. Empty means 3.",
  },
  [K.chatSourceBudget]: {
    type: "integer",
    description: "Ask: source budget in tokens. Empty means 6000.",
  },
  [K.chatRetrievalK]: {
    type: "integer",
    description: "Ask: search results per query, 3 to 20. Empty means 8.",
  },
  [K.chatDeadlineSeconds]: {
    type: "integer",
    description: "Ask: answer deadline in seconds, 20 to 180. Empty means 60.",
  },
  [K.chatSearchWider]: {
    type: "boolean",
    description: "Ask: offer a wider search when the answer is weak.",
  },
  [K.chatClarify]: {
    type: "boolean",
    description: "Ask: ask a question back when the question is not clear.",
  },
  [K.chatResearch]: {
    type: "boolean",
    description: "Ask: use the research mode for broad questions.",
  },
  [K.chatEngine]: {
    type: "enum",
    values: ["loop", "pipeline"],
    description: "Ask: the answer engine. loop is the default.",
  },
  [K.chatNativeTools]: {
    type: "boolean",
    description: "Ask: use the native tool calls of the local model.",
  },
  [K.chatHotkey]: {
    type: "string",
    description:
      "The hotkey of the Ask bubble, for example Control+Alt+K. Empty means the default.",
  },
  [K.liveCaptionsPill]: {
    type: "boolean",
    description: "Show the last live lines as captions in the recording pill.",
  },
  [K.meetingEnhanceTimeoutSeconds]: {
    type: "integer",
    description:
      "Time limit of one Enhance LLM call in seconds, 30 to 3600. Empty means the default.",
  },
  [K.meetingMaxDurationHours]: {
    type: "integer",
    description: "The recording stops after this many hours.",
  },
  [K.meetingRetentionDays]: {
    type: "integer",
    description: "The app deletes meeting audio after this many days.",
  },
  [K.meetingSttModel]: {
    type: "json",
    description:
      "JSON model pair for meeting transcription. Empty means the dictation model.",
  },
  [K.meetingSummaryContextBudget]: {
    type: "integer",
    description: "The context budget of the summary in tokens.",
  },
  [K.meetingSummaryInstructions]: {
    type: "string",
    description: "Extra instructions for the meeting summary.",
  },
  [K.meetingSummaryTimeoutSeconds]: {
    type: "integer",
    description:
      "Time limit of one Summarize LLM call in seconds, 30 to 3600. Empty means the default.",
  },
  [K.mlxAsrKeepAliveMinutes]: {
    type: "integer",
    description: "Minutes the built-in speech model stays loaded after use.",
  },
  [K.mlxLlmKeepAliveMinutes]: {
    type: "integer",
    description: "Minutes the built-in LLM stays loaded after use.",
  },
  [K.mlxLlmKeepReady]: {
    type: "json",
    description: "JSON map of tasks that keep the built-in LLM loaded.",
  },
  [K.outputMode]: {
    type: "enum",
    values: ["paste", "clipboard"],
    description: "paste: type the text into the app. clipboard: copy it only.",
  },
  [K.ownerName]: {
    type: "string",
    description:
      "The name of the user. Meeting transcription uses it to spell the name correctly.",
  },
  [K.pillCancelButton]: {
    type: "enum",
    values: ["hover", "always"],
    description: "When the recording pill shows its cancel button.",
  },
  [K.soundEnabled]: {
    type: "boolean",
    description: "Play a sound when dictation starts and stops.",
  },
  [K.theme]: {
    type: "enum",
    values: ["light", "dark", "system"],
    description: "The app theme.",
  },
  [K.translateMode]: {
    type: "boolean",
    description: "Translate dictated speech to English.",
  },
  [K.whisperKeepAliveMinutes]: {
    type: "integer",
    description: "Minutes the local Whisper model stays loaded after use.",
  },
};

/** SETTINGS_KEYS values that agents cannot see or change, with the reason. */
export const SETTINGS_EXCLUDED: Readonly<Record<string, string>> = {
  [K.audioDuckingEnabled]: "Legacy. audio_playback_mode replaces it.",
  [K.pausePlaybackWhileRecording]: "Legacy. audio_playback_mode replaces it.",
  [K.language]: "Legacy. languages replaces it.",
  [K.llmProfileLinks]: "Internal map that the Models page writes.",
  [K.llmProfileLinksMigrated]: "Internal migration flag.",
  [K.meetingAudioDevices]: "Internal device memory of the main process.",
  [K.meetingEnhancePromptSeen]: "Internal flag of a one-time prompt.",
  [K.micDeviceId]: "A device id of this Mac. Change it in the app.",
  [K.networkCaCertPath]: "Network trust. Change it in the app only.",
  [K.networkProxyUrl]: "Can hold proxy credentials. Change it in the app only.",
  [K.searchEmbeddingModel]: "Set through the search model in the app.",
  [K.mcpEnabled]: "Agent access. Only the user changes it, in the app.",
};

/** Check a value against the catalog type. Returns an error or null. */
export function checkSettingValue(
  entry: SettingEntry,
  value: string,
): string | null {
  switch (entry.type) {
    case "boolean":
      return value === "true" || value === "false"
        ? null
        : 'Value must be "true" or "false"';
    case "integer":
      return value.trim() === "" || /^-?\d+$/.test(value.trim())
        ? null
        : "Value must be a whole number, or empty for the default";
    case "enum":
      return entry.values?.includes(value)
        ? null
        : `Value must be one of: ${entry.values?.join(", ")}`;
    case "json":
      if (value === "") return null;
      try {
        JSON.parse(value);
        return null;
      } catch {
        return "Value must be valid JSON text";
      }
    case "string":
      return null;
  }
}
