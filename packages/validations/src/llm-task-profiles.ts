import { z } from "zod/v3";

/**
 * The three LLM call sites this app has today (specs/llm-task-profiles.md §2).
 * A task id is an engineering identity, not something a preset assignment can
 * redefine — the code-defined nature (reasoning on/off, output budget shape)
 * lives in `apps/server/src/lib/llm/task-profiles.ts`'s `LLM_TASK_PROFILES`.
 */
export const LLM_TASK_IDS = [
  "cleanup",
  "meetingSummarize",
  "meetingEnhance",
  // Live chat during a recording (issue #375, specs/live-chat.md).
  "liveChat",
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

export type BuiltinProfileMode = "instruct" | "thinking";

export interface LlmParameterPreset {
  /** `user_<uuid>` for user-created presets. Built-ins use fixed `builtin:*`
   *  ids (§4.2) that never appear in this stored list. */
  id: string;
  /** Display name, 1-60 chars. */
  name: string;
  /** Arbitrary JSON object, passed through per §7. No schema beyond
   *  "valid JSON, top-level object" (§4.3). */
  params: Record<string, unknown>;
  /** Built-in model profile only: the catalog id of the model it is for. */
  model?: string;
  /** Built-in model profile only: the mode of the profile. */
  mode?: BuiltinProfileMode;
  /** Built-in model profile only: values of one task, over the values above. */
  taskParams?: Partial<Record<LlmTaskId, Record<string, unknown>>>;
  createdAt: string; // ISO
  updatedAt: string; // ISO
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
 *
 * Amendment, 2026-08-27 (spec §4.2 amendment note, §12 item 6 resolved):
 * the field is `repetition_penalty`, not `repeat_penalty` — user-verified
 * against oMLX's own `openapi.json`, which is the wire target for both
 * presets on `local-llm`. This also matches every other spelling of this
 * knob already in this codebase (`cleanupSamplingSchema.repetition_penalty`,
 * `settings.ts`). Values unchanged (`1.0` for both presets).
 */
const QWEN_STARTER_PRESETS: readonly LlmParameterPreset[] = [
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
      repetition_penalty: 1.0,
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
      repetition_penalty: 1.0,
      chat_template_kwargs: { enable_thinking: false },
    },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  },
];

/**
 * The built-in profiles are data: one parameter set for each (model id, mode).
 * Each built-in MLX model has two, Instruct and Thinking (catalog ids of
 * `apps/server/src/lib/mlx-llm/constants.ts`; a server test keeps the two
 * lists equal). The app uses the Instruct profile of the model for a task
 * when the user linked no profile to that model and task. The user can link
 * the Thinking profile (or any other) per model and task.
 *
 * The values are PLACEHOLDERS until the validated table is added (owner
 * decision 2026-10-30: pure values, temperature included, no task override).
 * `max_tokens` is never in a profile: it stays derived from the task, so a
 * profile cannot lift a call past the context window.
 */
interface BuiltinModelDef {
  model: string;
  name: string;
  instruct: Record<string, unknown>;
  thinking: Record<string, unknown>;
}

const GEMMA_SAMPLING = {
  temperature: 1.0,
  top_p: 0.95,
  top_k: 64,
  repetition_penalty: 1.0,
};
const gemma = (model: string, name: string): BuiltinModelDef => ({
  model,
  name,
  instruct: {
    ...GEMMA_SAMPLING,
    chat_template_kwargs: { enable_thinking: false },
  },
  thinking: {
    ...GEMMA_SAMPLING,
    chat_template_kwargs: { enable_thinking: true },
  },
});

const BUILTIN_MODEL_DEFS: readonly BuiltinModelDef[] = [
  gemma("gemma-4-e2b-qat-4bit", "Gemma 4 E2B"),
  gemma("gemma-4-e4b-qat-4bit", "Gemma 4 E4B"),
  gemma("nemotron-3.5-bolt-e4b-4bit", "Nemotron 3.5 Bolt E4B"),
  gemma("gemma-4-26b-a4b-qat-4bit", "Gemma 4 26B-A4B"),
  {
    model: "qwen3.8-27b-4bit",
    name: "Qwen3.8 27B",
    instruct: {
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      min_p: 0.0,
      repetition_penalty: 1.0,
      presence_penalty: 1.5,
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: false,
        reasoning_effort: "none",
      },
    },
    thinking: {
      temperature: 1.0,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.0,
      repetition_penalty: 1.0,
      presence_penalty: 0.0,
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: false,
        reasoning_effort: "xhigh",
      },
    },
  },
];

const MODE_LABEL: Record<BuiltinProfileMode, string> = {
  instruct: "Instruct",
  thinking: "Thinking",
};

export const BUILTIN_MODEL_PRESETS: readonly LlmParameterPreset[] =
  BUILTIN_MODEL_DEFS.flatMap((d) =>
    (["instruct", "thinking"] as const).map(
      (mode): LlmParameterPreset => ({
        id: `builtin:model:${d.model}:${mode}`,
        name: `${d.name} \u2013 ${MODE_LABEL[mode]}`,
        params: d[mode],
        model: d.model,
        mode,
        createdAt: "2026-10-30T00:00:00.000Z",
        updatedAt: "2026-10-30T00:00:00.000Z",
      }),
    ),
  );

export const BUILTIN_LLM_PRESETS: readonly LlmParameterPreset[] = [
  ...QWEN_STARTER_PRESETS,
  ...BUILTIN_MODEL_PRESETS,
];

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
// Profile links: (model, task) -> profile
// ---------------------------------------------------------------------------

/**
 * A profile linked to one model for one task. The link belongs to that model
 * only: a task that runs on another model does not see it, and sees it again
 * when it runs on the first model again.
 */
export interface LlmProfileLink {
  mode: "preset" | "custom";
  presetId?: string;
  params?: Record<string, unknown>;
}

/** Key = `profileLinkKey(provider, model_id)`. */
export type LlmProfileLinks = Record<
  string,
  Partial<Record<LlmTaskId, LlmProfileLink>>
>;

/** The key of a model in the link map. A leading `<provider>/` is not part of it. */
export function profileLinkKey(provider: string, modelId: string): string {
  const prefix = `${provider}/`;
  return `${provider}::${modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId}`;
}

const llmProfileLinkSchema = z.object({
  mode: z.enum(["preset", "custom"]),
  presetId: z.string().min(1).max(80).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** Parse the stored link map. Never throws; bad entries are dropped. */
export function parseLlmProfileLinks(
  value: string | null | undefined,
): LlmProfileLinks {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const out: LlmProfileLinks = {};
    for (const [model, tasks] of Object.entries(parsed)) {
      if (typeof tasks !== "object" || tasks === null) continue;
      for (const [task, entry] of Object.entries(tasks)) {
        if (!(LLM_TASK_IDS as readonly string[]).includes(task)) continue;
        const r = llmProfileLinkSchema.safeParse(entry);
        if (r.success) (out[model] ??= {})[task as LlmTaskId] = r.data;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * What the Models page shows for one task: the model override of the stored
 * assignment, and the link of the model the task runs on (auto when it has
 * none, which means the built-in profile of a built-in model).
 */
export function viewTaskAssignment(
  stored: LlmTaskAssignment | undefined,
  links: LlmProfileLinks,
  modelKey: string | null,
  task: LlmTaskId,
): LlmTaskAssignment {
  const link = modelKey ? links[modelKey]?.[task] : undefined;
  return {
    ...(link ?? { mode: "auto" as const }),
    ...(stored?.modelOverride ? { modelOverride: stored.modelOverride } : {}),
  };
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
 * Keys a preset can never put on the wire for the two meeting tasks
 * (`meetingEnhance`, `meetingSummarize`) (specs/meeting-enhance-agentic.md
 * 5.5.3). They would replace the gateway schema or cut the JSON. A separate
 * set: a change to `LLM_PRESET_DENYLIST_KEYS` would also change dictation
 * cleanup, where `stop` stays allowed.
 */
export const LLM_MEETING_DENYLIST_KEYS = new Set([
  "response_format",
  "stop",
  "guided_json",
  "guided_regex",
  "guided_choice",
  "guided_grammar",
  "structured_outputs",
  "grammar",
  "json_schema",
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

// ---------------------------------------------------------------------------
// "Keep ready" of the built-in local LLM (specs/llm-runtime-tuning.md 6 item 4)
// ---------------------------------------------------------------------------

/**
 * Per task: the built-in local model of this task stays loaded after its
 * idle time. Stored as JSON in `mlx_llm_keep_ready`. A missing task key uses
 * the default. Owner decision 2026-10-26: on by default for `cleanup` only.
 */
export type MlxLlmKeepReady = Record<LlmTaskId, boolean>;

export const MLX_LLM_KEEP_READY_DEFAULT: Readonly<MlxLlmKeepReady> = {
  cleanup: true,
  meetingSummarize: false,
  meetingEnhance: false,
  liveChat: false,
};

export const mlxLlmKeepReadySchema = z
  .object({
    cleanup: z.boolean().optional(),
    meetingSummarize: z.boolean().optional(),
    meetingEnhance: z.boolean().optional(),
    liveChat: z.boolean().optional(),
  })
  .strict();

/** Parse a stored `mlx_llm_keep_ready` value. It never throws: a bad value gives the defaults. */
export function parseMlxLlmKeepReady(
  value: string | null | undefined,
): MlxLlmKeepReady {
  const out: MlxLlmKeepReady = { ...MLX_LLM_KEEP_READY_DEFAULT };
  if (!value) return out;
  try {
    const parsed = mlxLlmKeepReadySchema.safeParse(JSON.parse(value));
    if (!parsed.success) return out;
    for (const task of LLM_TASK_IDS) {
      const v = parsed.data[task];
      if (typeof v === "boolean") out[task] = v;
    }
  } catch {
    // Bad JSON: the defaults.
  }
  return out;
}
