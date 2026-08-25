import { z } from "zod/v3";

export const settingValueSchema = z.object({
  value: z.string(),
});

export type SettingValueInput = z.infer<typeof settingValueSchema>;

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
export const DEFAULT_CLEANUP_SAMPLING: CleanupSampling = {};

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
export const proxyUrlSettingSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      if (value.trim() === "") return true;
      try {
        const url = new URL(value.trim());
        return ["http:", "https:", "socks:", "socks4:", "socks5:"].includes(
          url.protocol,
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Proxy must be a valid http://, https:// or socks:// URL (or empty to disable)",
    },
  );

/** Filesystem path to a custom CA certificate bundle. Empty string clears it. */
export const caCertPathSettingSchema = z.string().max(4096);

export const HISTORY_RETENTION_DAYS_MAX = 3650;

export function parseRetentionDays(
  value: string | null | undefined,
): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  if (days < 1 || days > HISTORY_RETENTION_DAYS_MAX) return null;
  return days;
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

function parseBoundedInt(
  value: string | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value == null) return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (n < min || n > max) return fallback;
  return n;
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

export type HistoryPreset = z.infer<typeof historyPresetSchema>;

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
