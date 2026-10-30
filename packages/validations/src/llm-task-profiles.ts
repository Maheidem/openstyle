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

export type BuiltinProfileMode =
  | "instruct"
  | "thinking"
  | "thinking-medium"
  | "thinking-low";

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
 * The two starter presets of the first release ("Qwen thinking", "Qwen fast")
 * are retired (owner decision 2026-10-30). Their ids stay reserved, and a
 * stored link to one is read as the matching Qwen 3.8 built-in profile.
 */
export const RETIRED_BUILTIN_PRESETS: Readonly<Record<string, string>> = {
  "builtin:qwen-thinking": "builtin:model:qwen3.8:thinking",
  "builtin:qwen-fast": "builtin:model:qwen3.8:instruct",
};

/** The id of a stored profile link, with a retired id replaced. */
export function remapRetiredPresetId(id: string): string {
  return RETIRED_BUILTIN_PRESETS[id] ?? id;
}

/**
 * The built-in profiles are data: one parameter set for each (family key,
 * mode). A family is one built-in MLX model (Gemma 4, Nemotron: the key is its
 * catalog id) or one Qwen generation and size (the key is `qwen3.8`,
 * `qwen3.6-27b`, `qwen3.6-35b-a3b`, `qwen3.5`). Each family has an Instruct
 * and a Thinking profile. The app uses the Instruct profile for a task when
 * the user linked no profile to that model and task. A user link always wins.
 *
 * Values: the validated table of 2026-10-30 (Unsloth and the vendor card; the
 * sources are in the PR body). Every profile sends `enable_thinking`
 * explicitly. No profile sets `max_tokens`: it stays derived from the task,
 * so a profile cannot lift a call past the context window. No task overrides
 * the temperature of a profile (owner decision: pure values).
 */
interface BuiltinFamilyDef {
  key: string;
  name: string;
  instruct: Record<string, unknown>;
  thinking: Record<string, unknown>;
  /** Other thinking levels of the family (Qwen 3.8: medium and low). */
  levels?: Partial<
    Record<"thinking-medium" | "thinking-low", Record<string, unknown>>
  >;
}

const think = (on: boolean, more: Record<string, unknown> = {}) => ({
  chat_template_kwargs: { enable_thinking: on, ...more },
});

const gemma = (key: string, name: string): BuiltinFamilyDef => {
  const sampling = {
    temperature: 1.0,
    top_p: 0.95,
    top_k: 64,
    repetition_penalty: 1.0,
  };
  return {
    key,
    name,
    instruct: { ...sampling, ...think(false) },
    thinking: { ...sampling, ...think(true) },
  };
};

const NEMOTRON_SAMPLING = { temperature: 1.0, top_p: 0.95, top_k: 64 };

const QWEN_BASE = { top_k: 20, min_p: 0.0, repetition_penalty: 1.0 };
const QWEN_INSTRUCT = {
  ...QWEN_BASE,
  temperature: 0.7,
  top_p: 0.8,
  presence_penalty: 1.5,
  ...think(false),
};
const qwenThinking = (
  presence: number,
  more: Record<string, unknown> = {},
) => ({
  ...QWEN_BASE,
  temperature: 1.0,
  top_p: 0.95,
  presence_penalty: presence,
  ...think(true, more),
});

const BUILTIN_FAMILY_DEFS: readonly BuiltinFamilyDef[] = [
  gemma("gemma-4-e2b-qat-4bit", "Gemma 4 E2B"),
  gemma("gemma-4-e4b-qat-4bit", "Gemma 4 E4B"),
  gemma("gemma-4-26b-a4b-qat-4bit", "Gemma 4 26B-A4B"),
  {
    key: "nemotron-3.5-bolt-e4b-4bit",
    name: "Nemotron 3.5 Bolt E4B",
    instruct: { ...NEMOTRON_SAMPLING, ...think(false) },
    thinking: { ...NEMOTRON_SAMPLING, ...think(true) },
  },
  {
    key: "qwen3.8",
    name: "Qwen 3.8",
    instruct: QWEN_INSTRUCT,
    // The 3.8 template accepts reasoning_effort xhigh, medium and low only,
    // and only with thinking on. The Instruct profile does not send it.
    thinking: qwenThinking(0.0, {
      preserve_thinking: false,
      reasoning_effort: "xhigh",
    }),
    // The 3.8 chat template accepts xhigh (default), medium and low.
    levels: {
      "thinking-medium": qwenThinking(0.0, {
        preserve_thinking: false,
        reasoning_effort: "medium",
      }),
      "thinking-low": qwenThinking(0.0, {
        preserve_thinking: false,
        reasoning_effort: "low",
      }),
    },
  },
  {
    key: "qwen3.6-27b",
    name: "Qwen 3.6 27B",
    instruct: QWEN_INSTRUCT,
    thinking: qwenThinking(0.0, { preserve_thinking: false }),
  },
  {
    key: "qwen3.6-35b-a3b",
    name: "Qwen 3.6 35B-A3B",
    instruct: QWEN_INSTRUCT,
    thinking: qwenThinking(1.5, { preserve_thinking: false }),
  },
  {
    key: "qwen3.5",
    name: "Qwen 3.5",
    instruct: QWEN_INSTRUCT,
    thinking: qwenThinking(1.5),
  },
];

const MODE_LABEL: Record<BuiltinProfileMode, string> = {
  instruct: "Instruct",
  thinking: "Thinking",
  "thinking-medium": "Thinking (medium)",
  "thinking-low": "Thinking (low)",
};

export const BUILTIN_MODEL_PRESETS: readonly LlmParameterPreset[] =
  BUILTIN_FAMILY_DEFS.flatMap((d) => {
    const modes: [BuiltinProfileMode, Record<string, unknown>][] = [
      ["instruct", d.instruct],
      ["thinking", d.thinking],
      ...(Object.entries(d.levels ?? {}) as [
        BuiltinProfileMode,
        Record<string, unknown>,
      ][]),
    ];
    return modes.map(([mode, params]): LlmParameterPreset => {
      // A family with levels names its default thinking level: xhigh.
      const label =
        mode === "thinking" && d.levels ? "Thinking (xhigh)" : MODE_LABEL[mode];
      return {
        id: `builtin:model:${d.key}:${mode}`,
        name: `${d.name} \u2013 ${label}`,
        params,
        model: d.key,
        mode,
        createdAt: "2026-10-30T00:00:00.000Z",
        updatedAt: "2026-10-30T00:00:00.000Z",
      };
    });
  });

/** Words in a model id that mean a different model from the plain chat model. */
const QWEN_REJECT =
  /coder|embed|rerank|(?:^|[-_ .])vl(?:$|[-_ .])|audio|asr|omni|math|base/;

/** Sizes (after the version) that the Qwen profiles cover, per generation. */
const QWEN_FAMILIES: Record<string, Record<string, string>> = {
  "3.8": { "27b": "qwen3.8", flash: "qwen3.8", "flash-next": "qwen3.8" },
  "3.6": { "27b": "qwen3.6-27b", "35b-a3b": "qwen3.6-35b-a3b" },
  "3.5": Object.fromEntries(
    ["0.8b", "2b", "4b", "9b", "27b", "35b-a3b", "122b-a10b"].map((z) => [
      z,
      "qwen3.5",
    ]),
  ),
};

/**
 * The Qwen family key of a model id (an own server, a cloud or an MLX id), or
 * null. Conservative: the id must name the version AND a covered size right
 * after it, for example `Qwen3.6-35B-A3B`, `qwen3.5-27b`,
 * `mlx-community/Qwen3.6-27B-4bit`, `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`. A quant
 * or format suffix is fine. A coder, vision, base, audio, embedding or
 * reranker variant, an unknown size (`397B-A17B`) or an unknown version gives
 * null: no match means no automatic profile.
 */
export function qwenFamilyKey(modelId: string): string | null {
  const id = modelId.toLowerCase();
  const m =
    /(?:^|[^a-z0-9])qwen[-_ ]?3[._]([568])[-_ ]?([a-z0-9.]+(?:[-_ ]a\d+(?:\.\d+)?b)?)/.exec(
      id,
    );
  if (!m) return null;
  if (QWEN_REJECT.test(id)) return null;
  const size = (m[2] ?? "").replace(/_/g, "-").replace(/ /g, "-");
  // "35b-a3b", "27b", "flash-next" ... the size token ends at the first quant
  // or format word; try the longest covered size that the token starts with.
  const sizes = QWEN_FAMILIES[`3.${m[1]}`] ?? {};
  const hit = Object.keys(sizes)
    .sort((a, b) => b.length - a.length)
    .find((z) => size === z || size.startsWith(`${z}-`));
  return hit ? (sizes[hit] ?? null) : null;
}

/**
 * The family key of the built-in profile of a model, or null. A built-in MLX
 * model matches by its catalog id (Gemma, Nemotron) or by the Qwen rule. Any
 * other model (own server, cloud) matches by the Qwen rule only.
 */
export function builtinProfileKey(
  modelId: string,
  native: boolean,
): string | null {
  if (native && BUILTIN_FAMILY_DEFS.some((d) => d.key === modelId)) {
    return modelId;
  }
  return qwenFamilyKey(modelId);
}

/** The built-in profile for a family key and mode. */
export function builtinProfile(
  key: string,
  mode: BuiltinProfileMode = "instruct",
): LlmParameterPreset | undefined {
  return BUILTIN_MODEL_PRESETS.find((p) => p.model === key && p.mode === mode);
}

export const BUILTIN_LLM_PRESETS: readonly LlmParameterPreset[] =
  BUILTIN_MODEL_PRESETS;

/** Built-in ids, the retired ones too: a user preset may not take them. */
export const BUILTIN_LLM_PRESET_IDS = new Set([
  ...BUILTIN_LLM_PRESETS.map((p) => p.id),
  ...Object.keys(RETIRED_BUILTIN_PRESETS),
]);

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
      if (result.success) {
        out[key as LlmTaskId] = {
          ...result.data,
          ...(result.data.presetId
            ? { presetId: remapRetiredPresetId(result.data.presetId) }
            : {}),
        };
      }
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
        if (r.success) {
          (out[model] ??= {})[task as LlmTaskId] = {
            ...r.data,
            ...(r.data.presetId
              ? { presetId: remapRetiredPresetId(r.data.presetId) }
              : {}),
          };
        }
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
