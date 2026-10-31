import { CHAT_SETTING_LIMITS, SETTINGS_KEYS } from "@openstyle/validations";
import { readSetting } from "../db.js";

// The Ask page settings (specs/meeting-chat-agent.md 2.9). The code reads each
// value at the moment of use, not at start, so a change applies to the next
// turn. A test pins that each knob is read (rule 1: no phantom knob).

export interface ChatSettings {
  /** Tool rounds, 1 to 5. */
  rounds: number;
  /** Answer source budget in estimated tokens. */
  sourceBudget: number;
  /** Retrieval k. */
  k: number;
  /** Turn deadline in ms. */
  deadlineMs: number;
  /** The "search wider" offer. */
  searchWider: boolean;
  /** The router uses native tool calls first. */
  nativeTools: boolean;
  /** The switch of the Ask tab. */
  enabled: boolean;
}

/** An integer in the range, the default for a missing or bad value. */
function clampedInt(
  raw: string | undefined,
  limits: { min: number; max: number; default: number },
): number {
  if (raw === undefined || raw.trim() === "") return limits.default;
  const n = Number(raw);
  if (!Number.isFinite(n)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, Math.round(n)));
}

export function readChatSettings(): ChatSettings {
  const L = CHAT_SETTING_LIMITS;
  return {
    rounds: clampedInt(readSetting(SETTINGS_KEYS.chatRounds), L.rounds),
    sourceBudget: clampedInt(
      readSetting(SETTINGS_KEYS.chatSourceBudget),
      L.sourceBudget,
    ),
    k: clampedInt(readSetting(SETTINGS_KEYS.chatRetrievalK), L.k),
    deadlineMs:
      clampedInt(
        readSetting(SETTINGS_KEYS.chatDeadlineSeconds),
        L.deadlineSeconds,
      ) * 1000,
    searchWider: readSetting(SETTINGS_KEYS.chatSearchWider) !== "false",
    nativeTools: readSetting(SETTINGS_KEYS.chatNativeTools) !== "false",
    enabled: readSetting(SETTINGS_KEYS.meetingChatEnabled) === "true",
  };
}
