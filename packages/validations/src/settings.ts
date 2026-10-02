import { z } from "zod/v3";
import { httpUrlOrEmpty } from "./http-url-or-empty.js";

export const settingValueSchema = z.object({
  value: z.string(),
});

/** Post-processing (AI cleanup) intensity levels. */
export const cleanupIntensitySchema = z.enum([
  "low",
  "medium",
  "high",
  "custom",
]);

export type CleanupIntensity = z.infer<typeof cleanupIntensitySchema>;

// Default cleanup strength for new users and missing settings.
export const DEFAULT_CLEANUP_INTENSITY: CleanupIntensity = "medium";

/**
 * Upper bound on a user-authored custom cleanup prompt. Comfortably above the
 * longest built-in preset (~8k chars) so users can seed Custom from any preset
 * and still have room to build on top of it.
 */
export const CLEANUP_CUSTOM_PROMPT_MAX = 20000;

export const cleanupCustomPromptSchema = z
  .string()
  .max(CLEANUP_CUSTOM_PROMPT_MAX);

/**
 * Coerce an arbitrary persisted value into a valid {@link CleanupIntensity},
 * falling back to the default when missing or malformed.
 */
export function parseCleanupIntensity(
  value: string | null | undefined,
): CleanupIntensity {
  const result = cleanupIntensitySchema.safeParse(value);
  return result.success ? result.data : DEFAULT_CLEANUP_INTENSITY;
}

/**
 * Sampling parameters sent to a local, OpenAI-compatible cleanup server
 * (oMLX, llama.cpp, vLLM). Field names are snake_case because they go straight
 * onto the wire — the AI SDK cannot carry `top_k`, `min_p` or
 * `chat_template_kwargs`, so these are merged into the request body by a custom
 * `fetch` on the `local-llm` provider entry.
 *
 * Every field is optional and none has a `.default()`: an empty object means
 * "send nothing extra", which keeps the request body identical to what the SDK
 * builds on its own. An out-of-bounds field rejects the whole object (see
 * {@link parseCleanupSampling}) rather than being silently dropped.
 */
export const CLEANUP_SAMPLING_MAX_TOKENS_LIMIT = 32768;

export const cleanupSamplingSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).max(500).optional(),
  min_p: z.number().min(0).max(0.5).optional(),
  repetition_penalty: z.number().min(1).max(1.5).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  /**
   * Replaces the input-scaled budget from `maxOutputTokensForCleanup`. That
   * heuristic sizes the output off the *input*, which holds for a plain edit
   * but not with thinking on, where the output is reasoning plus answer — a
   * one-sentence cleanup at high effort measured 437 output tokens against a
   * 512-token floor. Raise this to give thinking room.
   */
  max_tokens: z
    .number()
    .int()
    .min(1)
    .max(CLEANUP_SAMPLING_MAX_TOKENS_LIMIT)
    .optional(),
  /**
   * Caps reasoning independently of `max_tokens`, so the answer always has
   * room left. This is what makes thinking safe to leave on.
   */
  thinking_budget: z
    .number()
    .int()
    .min(0)
    .max(CLEANUP_SAMPLING_MAX_TOKENS_LIMIT)
    .optional(),
  /**
   * Top-level reasoning effort. Distinct from the `chat_template_kwargs` field
   * of the same name — oMLX accepts both and they are not the same knob. Left
   * as a free string so a server-specific value isn't rejected here; the
   * server is the authority on which values it takes.
   */
  reasoning_effort: z.string().min(1).max(32).optional(),
  chat_template_kwargs: z
    .object({
      enable_thinking: z.boolean().optional(),
      reasoning_effort: z.string().min(1).max(32).optional(),
      preserve_thinking: z.boolean().optional(),
    })
    .optional(),
});

export type CleanupSampling = z.infer<typeof cleanupSamplingSchema>;

/** No overrides — the request body stays exactly as the AI SDK built it. */
const DEFAULT_CLEANUP_SAMPLING: CleanupSampling = {};

/**
 * Coerce an arbitrary persisted value into a valid {@link CleanupSampling},
 * falling back to "no overrides" when missing, unparseable or out of bounds.
 * Never throws — a malformed setting must degrade to today's behaviour rather
 * than break cleanup.
 */
export function parseCleanupSampling(
  value: string | null | undefined,
): CleanupSampling {
  if (!value) return DEFAULT_CLEANUP_SAMPLING;
  try {
    const parsed = cleanupSamplingSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : DEFAULT_CLEANUP_SAMPLING;
  } catch {
    return DEFAULT_CLEANUP_SAMPLING;
  }
}

/**
 * Enterprise network proxy URL. Empty string clears it. Must be an http(s)
 * (or socks) URL when set — this is what downloads are routed through on
 * managed corporate networks.
 */
export const proxyUrlSettingSchema = httpUrlOrEmpty(
  ["http:", "https:", "socks:", "socks4:", "socks5:"],
  "Proxy must be a valid http://, https:// or socks:// URL (or empty to disable)",
);

/** Filesystem path to a custom CA certificate bundle. Empty string clears it. */
export const caCertPathSettingSchema = z.string().max(4096);

/**
 * Strict parse of a whole number inside [min, max]. Returns `null` when the
 * value is missing, not a whole number, or out of bounds.
 */
function parseBoundedIntStrict(
  value: string | null | undefined,
  min: number,
  max: number,
): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (n < min || n > max) return null;
  return n;
}

export const HISTORY_RETENTION_DAYS_MAX = 3650;

export function parseRetentionDays(
  value: string | null | undefined,
): number | null {
  return parseBoundedIntStrict(value, 1, HISTORY_RETENTION_DAYS_MAX);
}

export const historyRetentionDaysSettingSchema = z
  .string()
  .refine(
    (value) => value.trim() === "" || parseRetentionDays(value) !== null,
    {
      message: `Retention must be a whole number of days between 1 and ${HISTORY_RETENTION_DAYS_MAX} (or empty to disable)`,
    },
  );

// --- Meeting Mode settings ---------------------------------------------------

/** Days recorded meeting audio is kept before the retention sweep deletes it. */
export const DEFAULT_MEETING_RETENTION_DAYS = 30;
export const MEETING_RETENTION_DAYS_MAX = 3650;

/** Auto-stop ceiling for a single meeting recording, in hours. */
export const DEFAULT_MEETING_MAX_DURATION_HOURS = 4;
export const MEETING_MAX_DURATION_HOURS_MAX = 24;

/** Token budget for the transcript context fed to the summary LLM. */
export const DEFAULT_MEETING_SUMMARY_CONTEXT_BUDGET = 8000;
export const MEETING_SUMMARY_CONTEXT_BUDGET_MAX = 200000;

/**
 * Upper bound on the user-authored meeting-summary instructions profile.
 * Comfortably smaller than the cleanup custom prompt — this text is appended
 * to every summary system prompt, so it also eats into the transcript
 * context budget.
 */
export const MEETING_SUMMARY_INSTRUCTIONS_MAX = 4000;

export const meetingSummaryInstructionsSchema = z
  .string()
  .max(MEETING_SUMMARY_INSTRUCTIONS_MAX);

/**
 * Coerce the persisted `meeting_summary_instructions` setting into a
 * trimmed string, falling back to "" when missing, malformed, or over the
 * length cap.
 */
export function parseMeetingSummaryInstructions(
  value: string | null | undefined,
): string {
  if (value == null) return "";
  const trimmed = value.trim();
  if (trimmed.length > MEETING_SUMMARY_INSTRUCTIONS_MAX) return "";
  return trimmed;
}

function parseBoundedInt(
  value: string | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  return parseBoundedIntStrict(value, min, max) ?? fallback;
}

/**
 * Coerce the persisted `meeting_retention_days` setting into a valid day
 * count, falling back to the default when missing or malformed.
 */
export function parseMeetingRetentionDays(
  value: string | null | undefined,
): number {
  return parseBoundedInt(
    value,
    1,
    MEETING_RETENTION_DAYS_MAX,
    DEFAULT_MEETING_RETENTION_DAYS,
  );
}

/**
 * Coerce the persisted `meeting_max_duration_hours` setting into a valid hour
 * count, falling back to the default when missing or malformed.
 */
export function parseMeetingMaxDurationHours(
  value: string | null | undefined,
): number {
  return parseBoundedInt(
    value,
    1,
    MEETING_MAX_DURATION_HOURS_MAX,
    DEFAULT_MEETING_MAX_DURATION_HOURS,
  );
}

/**
 * Coerce the persisted `meeting_summary_context_budget` setting into a valid
 * token budget, falling back to the default when missing or malformed.
 */
export function parseMeetingSummaryContextBudget(
  value: string | null | undefined,
): number {
  return parseBoundedInt(
    value,
    100,
    MEETING_SUMMARY_CONTEXT_BUDGET_MAX,
    DEFAULT_MEETING_SUMMARY_CONTEXT_BUDGET,
  );
}

// --- Meeting summary timeout -----------------------------------------------

/**
 * Settings key for the meeting-summary LLM timeout. Stored in **seconds**,
 * because that is the unit a user can reason about; `meetingSummaryTimeoutMs()`
 * is the single place it becomes milliseconds (read site:
 * `apps/server/src/lib/llm/task-profiles.ts` → `taskTimeoutMs()`). Counterpart
 * in the renderer: `SETTINGS_KEYS.meetingSummaryTimeoutSeconds`
 * (`apps/electron/src/shared/settings-keys.ts`).
 */
export const MEETING_SUMMARY_TIMEOUT_SETTING_KEY =
  "meeting_summary_timeout_seconds";

/**
 * Bounds, with the arithmetic (see also the token-budget note at
 * `apps/server/src/lib/meetings/summarize.ts:40-61`).
 *
 * Every summarize call — single, map, or reduce — asks for
 * `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` = 4096 tokens and is *non-streaming*
 * (`llm-call.ts` → `postProcess` → `generateText`), so the whole generation,
 * plus prompt prefill, has to land inside this window. Decode throughput for
 * the local engines this app targets (llama.cpp / oMLX-class on Apple
 * Silicon) runs roughly 5-40 tok/s depending on model size and quant; the
 * repo's own measurement of a reasoning local model is ~300-400 hidden
 * chain-of-thought tokens burned *before* the visible summary starts.
 *
 *   window               tokens deliverable @ 40 / 20 / 10 / 5 tok/s
 *     60 s (old)            2400 /  1200 /   600 /  300  → fails any
 *                                                            full-budget call
 *    300 s                 12000 /  6000 /  3000 / 1500   → 3000 < 4096
 *    600 s (default)      24000 / 12000 /  6000 / 3000
 *   3600 s (max)         144000 / 72000 / 36000 / 18000
 *
 * - **default 600 s** covers a full 4096-token generation down to
 *   4096 / 600 = **6.8 tok/s**. At the slow end of the realistic band
 *   (10 tok/s) such a call needs 410 s, so 600 s carries ~190 s — 46 % — of
 *   slack; at 20 tok/s it needs 205 s. 300 s, the obvious "5 minutes", only
 *   reaches 3000 tokens at 10 tok/s, so the reported failure would have
 *   survived it. The cost of 600 s is worst-case patience, and this bounds
 *   one call, not the meeting (that is what the UI's helper copy says).
 * - **min 30 s** still writes 300 tokens at 10 tok/s — roughly the shortest
 *   summary worth keeping, and enough to cover the ~300-400 reasoning tokens
 *   this repo measured before a visible token appears. It exists to reject
 *   nonsense entries (1, 5, 0) that would reproduce the very timeout this knob
 *   is here to remove.
 * - **max 3600 s** covers 4096 tokens down to 1.1 tok/s. Slower than that an
 *   engine is not generating, it is hung — a longer ceiling only delays the
 *   error the user needs. Note this is per call: map-reduce makes one call
 *   per chunk plus a reduce, so total wall clock is calls × this value.
 */
export const MEETING_SUMMARY_TIMEOUT_SECONDS_MIN = 30;
export const MEETING_SUMMARY_TIMEOUT_SECONDS_MAX = 3600;
export const DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS = 600;

/**
 * Strict parse of a persisted timeout value: a whole number of seconds inside
 * [{@link MEETING_SUMMARY_TIMEOUT_SECONDS_MIN},
 *  {@link MEETING_SUMMARY_TIMEOUT_SECONDS_MAX}], else `null` — the shape
 * `parseRetentionDays` uses, so the settings route can answer 400 with the
 * bound in the message instead of silently storing a value that is ignored.
 */
export function parseMeetingSummaryTimeoutSeconds(
  value: string | null | undefined,
): number | null {
  return parseBoundedIntStrict(
    value,
    MEETING_SUMMARY_TIMEOUT_SECONDS_MIN,
    MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
  );
}

/**
 * Milliseconds for one summarize call. The one and only seconds→ms site.
 * Unset, blank, non-numeric or out-of-bounds falls back to the default
 * rather than clamping — same posture as `parseMeetingRetentionDays` — so a
 * value written behind this API (direct DB write, downgraded build) degrades
 * to a known-good 10 minutes instead of an unbounded wait.
 */
export function meetingSummaryTimeoutMs(
  value: string | null | undefined,
): number {
  const seconds = parseMeetingSummaryTimeoutSeconds(value);
  return (seconds ?? DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS) * 1000;
}

/**
 * Route-level validator for `PUT /api/settings/meeting_summary_timeout_seconds`.
 * Empty string is accepted and means "no preference" — the resolver then uses
 * {@link DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS}.
 */
export const meetingSummaryTimeoutSecondsSettingSchema = z
  .string()
  .refine(
    (value) =>
      value.trim() === "" || parseMeetingSummaryTimeoutSeconds(value) !== null,
    {
      message: `Timeout must be a whole number of seconds between ${MEETING_SUMMARY_TIMEOUT_SECONDS_MIN} and ${MEETING_SUMMARY_TIMEOUT_SECONDS_MAX} (or empty for ${DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS})`,
    },
  );

// --- Meeting enhance timeout ----------------------------------------------

/**
 * Settings key for the meeting-**Enhance** LLM timeout. The exact sibling of
 * `meeting_summary_timeout_seconds` above, and it exists because that knob did
 * not cover this task: Enhance is the same shape of call — non-streaming,
 * per chunk, through the same `resolveDefaultChatCall` → `postProcess` →
 * `generateText` path (`meetings/enhance.ts` → `meetings/llm-call.ts`) — and
 * was still pinned at a code-defined 60 s while Summarize moved to 600 s.
 * The asymmetry was recorded in-code (`llm/task-profiles.ts`, "Known
 * asymmetry, deliberately unchanged") and is the bug this knob closes: on one
 * local worker slot, a slow engine times Enhance out while Summarize
 * succeeds, which reads to the user as "half the meeting features work".
 *
 * Stored in **seconds**; `meetingEnhanceTimeoutMs()` is the single place it
 * becomes milliseconds (read site: `apps/server/src/lib/llm/task-profiles.ts`
 * → `taskTimeoutMs()`). Counterpart in the renderer:
 * `SETTINGS_KEYS.meetingEnhanceTimeoutSeconds`.
 */
export const MEETING_ENHANCE_TIMEOUT_SETTING_KEY =
  "meeting_enhance_timeout_seconds";

/**
 * Same bounds and same default as the summarize knob, deliberately:
 * Enhance's per-call output budget is computed off the chunk's actual token
 * count (`chunkTokens * 1.3 + 200 + 60 * labels`, `enhance.ts`) so it can
 * legitimately be LARGER than a summary's flat 4096 — a 8,000-token chunk asks
 * for ~10,800 output tokens. If anything this task needs the wide window more
 * than Summarize does, which is why the default is 600 s and not the old
 * 60 s. See {@link MEETING_SUMMARY_TIMEOUT_SECONDS_MAX}'s tok/s table; the
 * arithmetic is identical, only the numerator changes.
 */
export const MEETING_ENHANCE_TIMEOUT_SECONDS_MIN = 30;
export const MEETING_ENHANCE_TIMEOUT_SECONDS_MAX = 3600;
export const DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS = 600;

/** Strict parse — whole number of seconds inside the bounds, else `null`.
 *  Mirrors {@link parseMeetingSummaryTimeoutSeconds} exactly. */
export function parseMeetingEnhanceTimeoutSeconds(
  value: string | null | undefined,
): number | null {
  return parseBoundedIntStrict(
    value,
    MEETING_ENHANCE_TIMEOUT_SECONDS_MIN,
    MEETING_ENHANCE_TIMEOUT_SECONDS_MAX,
  );
}

/** Milliseconds for one Enhance call. The one and only seconds→ms site —
 *  unset / blank / non-numeric / out-of-bounds falls back to the default
 *  rather than clamping, same posture as {@link meetingSummaryTimeoutMs}. */
export function meetingEnhanceTimeoutMs(
  value: string | null | undefined,
): number {
  const seconds = parseMeetingEnhanceTimeoutSeconds(value);
  return (seconds ?? DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS) * 1000;
}

/** Route-level validator for `PUT /api/settings/meeting_enhance_timeout_seconds`. */
export const meetingEnhanceTimeoutSecondsSettingSchema = z
  .string()
  .refine(
    (value) =>
      value.trim() === "" || parseMeetingEnhanceTimeoutSeconds(value) !== null,
    {
      message: `Timeout must be a whole number of seconds between ${MEETING_ENHANCE_TIMEOUT_SECONDS_MIN} and ${MEETING_ENHANCE_TIMEOUT_SECONDS_MAX} (or empty for ${DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS})`,
    },
  );

/**
 * Combined shape for the Network settings form. The renderer drives a
 * react-hook-form with this schema so its inline validation matches exactly
 * what the server enforces per-key on `PUT /settings/:key`.
 */
export const networkSettingsFormSchema = z.object({
  proxyUrl: proxyUrlSettingSchema,
  caCertPath: caCertPathSettingSchema,
});

export type NetworkSettingsForm = z.infer<typeof networkSettingsFormSchema>;

/** Date-range preset shown on the History page filter panel. */
export const historyPresetSchema = z.enum([
  "today",
  "weekly",
  "monthly",
  "all-time",
  "custom",
]);

/**
 * Persisted History-page filter + view state, stored as a single JSON blob in
 * the renderer's `localStorage` (key `history.filters`) so a user's date range
 * and view toggles survive navigating away and back (and app restarts). It's a
 * UI-only preference, so it lives client-side rather than in the settings store.
 */
export const historyFiltersSettingSchema = z.object({
  preset: historyPresetSchema,
  customStartDate: z.string().max(32),
  customEndDate: z.string().max(32),
  filterOpen: z.boolean(),
  diffMode: z.boolean(),
  showAiEdits: z.boolean(),
  nerdMode: z.boolean(),
});

export type HistoryFiltersSetting = z.infer<typeof historyFiltersSettingSchema>;

/** Initial defaults for the History filter panel (matches the page's state). */
export const DEFAULT_HISTORY_FILTERS: HistoryFiltersSetting = {
  preset: "today",
  customStartDate: "",
  customEndDate: "",
  filterOpen: false,
  diffMode: false,
  showAiEdits: true,
  nerdMode: false,
};

/**
 * Coerce an arbitrary persisted value into a valid {@link HistoryFiltersSetting},
 * falling back to defaults for any missing or malformed fields.
 */
export function parseHistoryFilters(
  value: string | null | undefined,
): HistoryFiltersSetting {
  if (!value) return DEFAULT_HISTORY_FILTERS;
  try {
    const parsed = historyFiltersSettingSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : DEFAULT_HISTORY_FILTERS;
  } catch {
    return DEFAULT_HISTORY_FILTERS;
  }
}
