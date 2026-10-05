import {
  caCertPathSettingSchema,
  cleanupAppAssignmentsSchema,
  cleanupCustomPromptSchema,
  cleanupEmailToneSchema,
  cleanupIntensitySchema,
  cleanupOverallToneSchema,
  cleanupPersonalToneSchema,
  cleanupWorkToneSchema,
  historyRetentionDaysSettingSchema,
  LLM_PRESET_PARAMS_MAX_BYTES,
  LLM_TASK_IDS,
  llmParameterPresetsSettingSchema,
  llmTaskAssignmentSchema,
  MEETING_ENHANCE_TIMEOUT_SETTING_KEY,
  MEETING_SUMMARY_TIMEOUT_SETTING_KEY,
  meetingEnhanceTimeoutSecondsSettingSchema,
  meetingSummaryInstructionsSchema,
  meetingSummaryTimeoutSecondsSettingSchema,
  proxyUrlSettingSchema,
} from "@openstyle/validations";
import { HISTORY_RETENTION_SETTING_KEY } from "./history-store.js";
import { CA_CERT_PATH_SETTING, PROXY_URL_SETTING } from "./network.js";

/** A check returns an error message for a bad value, or null for a good one. */
type SettingCheck = (value: string) => string | null;

/** The part of a zod schema that these checks use. */
interface Schema<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { message: string }[] } };
}

/**
 * Check a string value against a schema.
 * `{ message }` always returns that message.
 * `{ fallback }` returns the first schema issue message, or the fallback.
 */
function schemaCheck(
  schema: Schema<unknown>,
  mode: { message: string } | { fallback: string },
): SettingCheck {
  return (value) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return null;
    return "message" in mode
      ? mode.message
      : (parsed.error.issues[0]?.message ?? mode.fallback);
  };
}

function parseJson(value: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

/**
 * Parse the value as JSON, then check it against a schema. Bad JSON and a
 * schema failure both return `message`. `extra` runs on the parsed data.
 */
function jsonCheck<T>(
  schema: Schema<T>,
  message: string,
  extra?: (data: T) => string | null,
): SettingCheck {
  return (value) => {
    const json = parseJson(value);
    if (!json.ok) return message;
    const parsed = schema.safeParse(json.data);
    if (!parsed.success) return message;
    return extra?.(parsed.data) ?? null;
  };
}

const TASK_ASSIGNMENTS_MESSAGE = "Invalid task assignments setting";

// The PUT must reject a body that is not a JSON object. It must also reject a
// known task whose entry fails its schema. Unknown task keys are ignored. The
// UI could otherwise save an entry that it cannot read back.
const checkTaskAssignments: SettingCheck = (value) => {
  const json = parseJson(value);
  if (!json.ok) return TASK_ASSIGNMENTS_MESSAGE;
  const data = json.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return TASK_ASSIGNMENTS_MESSAGE;
  }
  for (const [taskKey, entry] of Object.entries(data)) {
    if (!(LLM_TASK_IDS as readonly string[]).includes(taskKey)) continue;
    if (!llmTaskAssignmentSchema.safeParse(entry).success) {
      return `Invalid assignment for task "${taskKey}"`;
    }
  }
  return null;
};

// A Map, not an object: a key such as "constructor" must have no validator.
const SETTING_VALIDATORS: ReadonlyMap<string, SettingCheck> = new Map([
  [
    "cleanup_intensity",
    schemaCheck(cleanupIntensitySchema, {
      message: "Invalid cleanup intensity",
    }),
  ],
  [
    "cleanup_custom_prompt",
    schemaCheck(cleanupCustomPromptSchema, {
      message: "Custom prompt is too long",
    }),
  ],
  [
    "meeting_summary_instructions",
    schemaCheck(meetingSummaryInstructionsSchema, {
      message: "Summary instructions are too long",
    }),
  ],
  [
    "cleanup_personal_tone",
    schemaCheck(cleanupPersonalToneSchema, {
      message: "Invalid personal tone",
    }),
  ],
  [
    "cleanup_work_tone",
    schemaCheck(cleanupWorkToneSchema, { message: "Invalid work tone" }),
  ],
  [
    "cleanup_email_tone",
    schemaCheck(cleanupEmailToneSchema, { message: "Invalid email tone" }),
  ],
  [
    "cleanup_overall_tone",
    schemaCheck(cleanupOverallToneSchema, { message: "Invalid overall tone" }),
  ],
  [
    "cleanup_app_assignments",
    jsonCheck(cleanupAppAssignmentsSchema, "Invalid app assignments setting"),
  ],
  [
    "llm_parameter_presets",
    jsonCheck(
      llmParameterPresetsSettingSchema,
      "Invalid parameter presets setting",
      (data) => {
        for (const preset of data.presets) {
          if (
            JSON.stringify(preset.params).length > LLM_PRESET_PARAMS_MAX_BYTES
          ) {
            return `Preset "${preset.name}" is too large`;
          }
        }
        return null;
      },
    ),
  ],
  ["llm_task_assignments", checkTaskAssignments],
  [
    PROXY_URL_SETTING,
    schemaCheck(proxyUrlSettingSchema, { fallback: "Invalid proxy URL" }),
  ],
  [
    CA_CERT_PATH_SETTING,
    schemaCheck(caCertPathSettingSchema, {
      message: "Invalid CA certificate path",
    }),
  ],
  [
    HISTORY_RETENTION_SETTING_KEY,
    schemaCheck(historyRetentionDaysSettingSchema, {
      fallback: "Invalid history retention",
    }),
  ],
  // The two timeout keys are in seconds, from 30 to 3600. The bounds live in
  // `packages/validations/src/settings.ts`. An empty value is valid and means
  // "no preference". Any other bad value is a 400, so the UI can name the bound.
  [
    MEETING_SUMMARY_TIMEOUT_SETTING_KEY,
    schemaCheck(meetingSummaryTimeoutSecondsSettingSchema, {
      fallback: "Invalid summary timeout",
    }),
  ],
  [
    MEETING_ENHANCE_TIMEOUT_SETTING_KEY,
    schemaCheck(meetingEnhanceTimeoutSecondsSettingSchema, {
      fallback: "Invalid enhance timeout",
    }),
  ],
]);

/**
 * Validate a settings value for its key. Returns an error message, or null
 * when the value is valid or the key has no validator.
 */
export function validateSetting(key: string, value: string): string | null {
  return SETTING_VALIDATORS.get(key)?.(value) ?? null;
}
