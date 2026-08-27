import { z } from "zod/v3";

/**
 * The four LLM call sites this app has today (specs/llm-task-profiles.md §2).
 * A task id is an engineering identity, not something a preset assignment can
 * redefine — the code-defined nature (reasoning on/off, output budget shape)
 * lives in `apps/server/src/lib/llm/task-profiles.ts`'s `LLM_TASK_PROFILES`.
 */
export const LLM_TASK_IDS = [
  "cleanup",
  "remix",
  "meetingSummarize",
  "meetingEnhance",
] as const;

export type LlmTaskId = (typeof LLM_TASK_IDS)[number];

// ---------------------------------------------------------------------------
// Parameter presets (§4)
// ---------------------------------------------------------------------------

/** Display name bound (§4.1). */
export const LLM_PRESET_NAME_MAX = 60;

/**
 * Upper bound on a preset's serialized `params`. Matches
 * `CLEANUP_CUSTOM_PROMPT_MAX`'s role (settings.ts) — a generous bound that
 * stops an unbounded blob from being re-parsed on every request
 * (`registry.ts:236` re-reads settings per call; this generalizes to
 * per-task resolution, §8.3, at the same frequency).
 */
export const LLM_PRESET_PARAMS_MAX_BYTES = 8192;

/** Upper bound on the number of user-created presets a settings row can hold. */
export const LLM_PRESET_COUNT_MAX = 50;

export interface LlmParameterPreset {
  /** `user_<uuid>` for user-created presets. Built-ins use fixed `builtin:*`
   *  ids (§4.2) that never appear in this stored list. */
  id: string;
  /** Display name, 1-60 chars. */
  name: string;
  /** Arbitrary JSON object, passed through per §7. No schema beyond
   *  "valid JSON, top-level object" (§4.3). */
  params: Record<string, unknown>;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface LlmParameterPresetsSetting {
  presets: LlmParameterPreset[];
}

// `id` is required to match `/^user_/` at the validation boundary — this is
// what stops a client from writing a preset that collides with (or spoofs) a
// `builtin:` id, since built-ins are never stored, only merged in at read
// time (§4.1).
export const llmParameterPresetSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^user_/),
  name: z.string().min(1).max(LLM_PRESET_NAME_MAX),
  params: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const llmParameterPresetsSettingSchema = z.object({
  presets: z.array(llmParameterPresetSchema).max(LLM_PRESET_COUNT_MAX),
});

/**
 * Built-in starter presets — code constants, never written to the
 * `llm_parameter_presets` setting row (§4.2). Payloads copied verbatim from
 * the approved spec, byte for byte — not re-derived. `stream: false` is kept
 * even though it's on the resolver's denylist (§7.4) and gets stripped at
 * resolution time for every task; it's shown in the raw editor exactly as
 * approved and simply never reaches the wire.
 */
export const BUILTIN_LLM_PRESETS: readonly LlmParameterPreset[] = [
  {
    id: "builtin:qwen-thinking",
    name: "Qwen thinking",
    params: {
      temperature: 1.0,
      max_tokens: 512,
      stream: false,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.0,
      presence_penalty: 0.0,
      repeat_penalty: 1.0,
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: false,
        reasoning_effort: "xhigh",
      },
    },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  },
  {
    id: "builtin:qwen-fast",
    name: "Qwen fast",
    params: {
      temperature: 0.7,
      max_tokens: 512,
      stream: false,
      top_p: 0.8,
      top_k: 20,
      min_p: 0.0,
      presence_penalty: 1.5,
      repeat_penalty: 1.0,
      chat_template_kwargs: { enable_thinking: false },
    },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  },
] as const;

export const BUILTIN_LLM_PRESET_IDS = new Set(
  BUILTIN_LLM_PRESETS.map((p) => p.id),
);

// ---------------------------------------------------------------------------
// Task assignment storage (§5)
// ---------------------------------------------------------------------------

export type LlmTaskAssignmentMode = "auto" | "preset" | "custom";

export interface LlmTaskAssignment {
  mode: LlmTaskAssignmentMode;
  /** Required when mode === "preset". A builtin:* or user_* id (§4). */
  presetId?: string;
  /** Required when mode === "custom". Same shape/validation as a preset's
   *  `params` (§4.1, §4.3) — this task's own unsaved-as-a-preset raw JSON. */
  params?: Record<string, unknown>;
  /** Optional per-task model override (§6.3). Absent = use the app-wide
   *  default LLM (`getDefaultModels().llm`). */
  modelOverride?: { provider: string; model_id: string };
}

export type LlmTaskAssignments = Partial<Record<LlmTaskId, LlmTaskAssignment>>;

export const llmTaskAssignmentSchema = z.object({
  mode: z.enum(["auto", "preset", "custom"]),
  presetId: z.string().min(1).max(80).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  modelOverride: z
    .object({ provider: z.string().min(1), model_id: z.string().min(1) })
    .optional(),
});

/**
 * Parse a persisted `llm_task_assignments` value. Unknown task-id keys are
 * silently dropped, not a 400 — mirrors `parseCleanupSampling`'s "never
 * throws, degrade to no-overrides" philosophy at the per-key level: a future
 * rename or removal of a task id (or a downgrade to an older build that
 * doesn't know a newer task id) must not corrupt or reject the whole
 * assignments blob over one stale key.
 */
export function parseLlmTaskAssignments(
  value: string | null | undefined,
): LlmTaskAssignments {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const out: LlmTaskAssignments = {};
    for (const [key, entry] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!(LLM_TASK_IDS as readonly string[]).includes(key)) continue;
      const result = llmTaskAssignmentSchema.safeParse(entry);
      if (result.success) out[key as LlmTaskId] = result.data;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Provider mapping (§7)
// ---------------------------------------------------------------------------

/**
 * Keys a preset can never put on the wire, at any transport tier (§7.4).
 * These would either collide with what the resolver itself controls (model,
 * messages) or silently break a call shape the resolver depends on (stream,
 * tools, tool_choice, n).
 */
export const LLM_PRESET_DENYLIST_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "n",
]);

/**
 * The safe subset of preset keys mapped onto an ordinary `generateText`/
 * `streamText` call for every mapped-subset-tier provider (`openai`,
 * `anthropic`, `google`, `mistral`, `openrouter`, `vercel`, `groq`) — §7.1,
 * §7.2. Lives here (not in the server-only
 * `apps/server/src/lib/llm/task-profiles.ts`) specifically so the renderer's
 * client-side `cloudPartial` computation (§7.5) and the server resolver
 * (§8.3) import the exact same set instead of two independently-maintained
 * copies.
 */
export const SAFE_SUBSET_KEYS = new Set(["temperature", "max_tokens", "top_p"]);
