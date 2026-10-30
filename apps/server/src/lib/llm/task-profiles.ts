/**
 * Task profile registry and resolver (specs/llm-task-profiles.md §3, §8.3).
 *
 * Every LLM call site in this codebase declares which of four named tasks it
 * is and gets that task's built-in defaults (reasoning on/off, temperature,
 * output budget, timeout) instead of building its own inline numbers. A
 * user-defined parameter preset can be layered on top per task (§4-§7); this
 * module resolves those two layers, fresh, on every call.
 */

import { createAppLogger } from "@openstyle/utils";
import type {
  LlmParameterPreset,
  LlmTaskAssignment,
  LlmTaskId,
} from "@openstyle/validations";
import {
  BUILTIN_LLM_PRESETS,
  DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
  DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
  LLM_MEETING_DENYLIST_KEYS,
  LLM_PRESET_DENYLIST_KEYS,
  llmParameterPresetsSettingSchema,
  MEETING_ENHANCE_TIMEOUT_SETTING_KEY,
  MEETING_SUMMARY_TIMEOUT_SETTING_KEY,
  meetingEnhanceTimeoutMs,
  meetingSummaryTimeoutMs,
  parseCleanupSampling,
  parseLlmTaskAssignments,
  parseServerModelId,
  profileLinkKey,
  SAFE_SUBSET_KEYS,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { getApiKey } from "../api-keys.js";
import { readSetting } from "../db.js";
import { getMlxLlmModel, MLX_LLM_PROVIDER_ID } from "../mlx-llm/constants.js";
import { stripModelPrefix } from "../model-id.js";
import { getOwnServer } from "../own-servers.js";
import { builtinProfileFor, readProfileLinks } from "./profile-links.js";
import { getLlmProvider, isLocalProvider } from "./registry.js";

const log = createAppLogger("llm-task-profiles");

/**
 * Temperature of the Auto path of a stage (no user link). Gold eval, Gemma 4
 * E2B, fixed worker, 3 runs each: the vendor Instruct temperature 1.0 gave hard
 * fails in 4 of 6 meeting runs and 6.0 of 13 summary items; 0 gave no hard
 * fail and 8 of 13.
 */
export const AUTO_TEMPERATURE = 0;

export interface LlmTaskProfile {
  id: LlmTaskId;
  /** Whether reasoning/thinking is on by default for this task's nature. */
  reasoningEnabled: boolean;
  /** SDK-level default temperature when no preset/custom override wins. */
  temperature: number;
  /**
   * Output budget. A concrete number, or `"auto"` to keep the task's own
   * existing per-call heuristic (cleanup scales off input length,
   * Enhance scales off chunk size) instead of a fixed constant.
   */
  maxOutputTokens: number | "auto";
  /** Wall-clock timeout for one LLM call in this task (§8.4). */
  timeoutMs: number;
}

/**
 * Built-in defaults, per task nature (§3.2). This is a code constant, not a
 * settings row — task *identity* and its *nature* are an engineering
 * decision, not something a preset assignment should be able to silently
 * redefine. Two exceptions, by explicit product decision: the two meeting
 * tasks' `timeoutMs` are the *defaults* behind the user-facing
 * `meeting_summary_timeout_seconds` and `meeting_enhance_timeout_seconds`
 * settings and are overridden per call by `taskTimeoutMs()` below — a local
 * inference engine has to be able to widen the window without a rebuild.
 * Enhance's default was 60_000 for the same reason Summarize's moved off it:
 * a non-streaming, per-chunk generation on one worker slot cannot be bounded by
 * a 60 s guess (real-world symptom: every enhance chunk timing out 60 s apart
 * while Summarize succeeded on the same engine).
 *
 * `meetingSummarize.maxOutputTokens` is the literal `4096`. It is the
 * `SUMMARY_ANSWER_TOKENS` budget of the Summarize node (specs/
 * meeting-enhance-agentic.md 4.0.5). The node body is still a stub (WP6), so
 * the constant does not exist in code yet. `llm-task-profiles.test.ts` pins
 * the literal. WP6 must keep the node constant equal to it.
 */
export const LLM_TASK_PROFILES: Record<LlmTaskId, LlmTaskProfile> = {
  cleanup: {
    id: "cleanup",
    reasoningEnabled: false,
    temperature: 0,
    maxOutputTokens: "auto",
    timeoutMs: 20_000,
  },
  meetingSummarize: {
    id: "meetingSummarize",
    reasoningEnabled: false,
    temperature: 0,
    maxOutputTokens: 4096,
    /**
     * Was 60_000, which a local engine cannot meet: the summary call is
     * non-streaming with a 4096-token output budget (`llm-call.ts`), so 60 s
     * only covers 600 tokens at 10 tok/s or 2400 at 40 tok/s — i.e. every
     * real summary timed out. Now the shared default behind the user-facing
     * `meeting_summary_timeout_seconds` setting; `taskTimeoutMs()` below reads
     * that setting fresh per call, and this constant is only what "unset" means.
     */
    timeoutMs: DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS * 1000,
  },
  meetingEnhance: {
    id: "meetingEnhance",
    reasoningEnabled: false,
    temperature: 0,
    maxOutputTokens: "auto",
    /**
     * Same shape as `meetingSummarize` above, and the same history: this was
     * a hard-coded 60_000 while its sibling moved to 600 s, and the setting
     * that was supposed to widen it (`meeting_enhance_timeout_seconds`) was
     * never read here — so on a slow local engine every chunk timed out and
     * the route reported "No segments needed correction". Now the constant is
     * only what "unset" means; `taskTimeoutMs()` below reads
     * `meeting_enhance_timeout_seconds` fresh per call.
     */
    timeoutMs: DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS * 1000,
  },
  // Live chat (issue #375): one short JSON answer for a person who waits.
  // Interactive like cleanup, so it keeps a code-defined timeout.
  liveChat: {
    id: "liveChat",
    reasoningEnabled: false,
    temperature: 0,
    maxOutputTokens: 300,
    timeoutMs: 30_000,
  },
};

/**
 * Timeout for one call of `taskId`, read fresh (specs/llm-task-profiles.md
 * §8.3 — nothing here is cached across requests).
 *
 * The two meeting tasks are the tasks a user can bound: a local engine hosted
 * outside openstyle (llama.cpp / oMLX) needs minutes, not seconds, for a
 * non-streaming generation, so each profile value is a *default* and
 * `meeting_summary_timeout_seconds` / `meeting_enhance_timeout_seconds`
 * override it — read here, on the same per-call `readSetting` path as every
 * other setting this resolver touches. Seconds on disk, milliseconds on the
 * wire: `meetingSummaryTimeoutMs()` / `meetingEnhanceTimeoutMs()`
 * (`packages/validations/src/settings.ts`) are the single conversion sites for
 * their own task, and fold out-of-bounds or unset values back to the default
 * defensively.
 *
 * `cleanup` deliberately keeps its code-defined timeout: it is interactive
 * (dictation cleanup), where a long window is a worse failure than a fast
 * error.
 *
 * Adding a third meeting task? It needs a branch here AND its key in
 * `apps/electron/src/shared/settings-keys.ts` AND a route branch in
 * `routes/settings.ts` — the enhance knob shipped as a phantom precisely
 * because the validator existed and this function did not read it. Pinned by
 * `apps/server/tests/meeting-llm-timeouts.test.ts`.
 */
function taskTimeoutMs(taskId: LlmTaskId, profileTimeoutMs: number): number {
  if (taskId === "meetingEnhance") {
    return meetingEnhanceTimeoutMs(
      readSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY),
    );
  }
  if (taskId !== "meetingSummarize") return profileTimeoutMs;
  return meetingSummaryTimeoutMs(
    readSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY),
  );
}

/** A preset key that the resolver did not put on the wire. */
export interface DroppedPresetKey {
  name: string;
  value: unknown;
  /** "denylist": never allowed. "not_in_safe_subset": a cloud provider takes only the safe subset. */
  reason: "denylist" | "not_in_safe_subset";
}

export interface ResolvedTaskCall {
  provider: string;
  modelId: string;
  temperature: number;
  topP?: number; // preset `top_p`; mapped-subset providers only
  maxOutputTokens: number;
  reasoningEnabled: boolean;
  samplingParams: Record<string, unknown>; // {} in "auto" mode
  timeoutMs: number;
  /** Preset keys asked for and not sent, for the LLM call ledger. */
  droppedKeys: DroppedPresetKey[];
  /** Which assignment mode gave the params. */
  source: { mode: LlmTaskAssignment["mode"]; presetId?: string };
  /** Keys the mode-selected params set themselves (after the denylist). */
  presetKeys: { topLevel: string[]; chatTemplateKwargs: string[] };
}

export interface ResolveTaskCallOptions {
  autoMaxOutputTokens?: number;
  /**
   * Use this model and ignore the task assignment and the app default. A
   * workflow run pins the model once in `prepare` (specs/meeting-enhance-agentic.md 4.1 P9).
   */
  pin?: { provider: string; modelId: string };
}

/** The app-wide default model, as `getDefaultModels().llm` returns it. */
export interface DefaultLlmChoice {
  provider: string;
  model_id: string;
  model_name?: string;
}

/** Read + merge the stored user presets behind the built-ins (§4.2). */
function resolveMergedPresets(): readonly LlmParameterPreset[] {
  const raw = readSetting(SETTINGS_KEYS.llmParameterPresets);
  if (!raw) return BUILTIN_LLM_PRESETS;
  try {
    const parsed = llmParameterPresetsSettingSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return BUILTIN_LLM_PRESETS;
    return [...BUILTIN_LLM_PRESETS, ...parsed.data.presets];
  } catch {
    return BUILTIN_LLM_PRESETS;
  }
}

/**
 * §12.7 (applied per review sign-off, deviating from §10 as literally
 * written): rather than a one-time client-side migration writing
 * `llm_task_assignments.cleanup` behind a sentinel flag — which §11's last
 * failure-matrix row shows silently drops a user's tuned `cleanup_sampling`
 * for as long as Settings > Models stays unvisited after upgrade — the
 * `cleanup` task falls back to a stateless, read-time resolution of the
 * legacy `cleanup_sampling` setting when no `llm_task_assignments.cleanup`
 * row exists yet. Mirrors `getLanguagesSetting()`
 * (`apps/server/src/lib/language.ts:43-55`): the new setting is authoritative
 * once present, an absent row falls back to the legacy key, computed fresh on
 * every read, no flag, nothing to race.
 */
function resolveCleanupLegacyFallback(): LlmTaskAssignment | null {
  const legacy = parseCleanupSampling(
    readSetting(SETTINGS_KEYS.cleanupSampling),
  );
  if (Object.keys(legacy).length === 0) return null;
  return { mode: "custom", params: legacy as Record<string, unknown> };
}

/** §6.1 — resolve the raw params object a task's mode selects, before the
 *  denylist (§7.4) strips anything. `{}` for "auto". An unresolvable
 *  `presetId` (deleted preset) degrades to "auto" for this resolution only,
 *  `warn`-logged (§11). */
function resolveModeParams(
  taskId: LlmTaskId,
  assignment: LlmTaskAssignment,
): Record<string, unknown> {
  if (assignment.mode === "custom") {
    return assignment.params ?? {};
  }
  if (assignment.mode === "preset") {
    const presets = resolveMergedPresets();
    const preset = presets.find((p) => p.id === assignment.presetId);
    if (!preset) {
      log.warn(
        `resolveTaskCall("${taskId}"): assigned preset "${assignment.presetId}" no longer exists, falling back to auto`,
      );
      return {};
    }
    return preset.params;
  }
  return {};
}

/**
 * The raw sampling values of one model for one task, before the denylist.
 * Order: the link of (model, task); the built-in profile of a built-in MLX
 * model; the old `cleanup_sampling` setting (cleanup only); else `{}` (auto). A link whose preset is gone gives auto.
 */
function resolveProfileParams(
  taskId: LlmTaskId,
  provider: string,
  modelId: string,
): {
  params: Record<string, unknown>;
  source: ResolvedTaskCall["source"];
  /** The default built-in profile: the user chose none of its keys. */
  soft?: boolean;
} {
  const link = readProfileLinks()[profileLinkKey(provider, modelId)]?.[taskId];
  if (link) {
    return {
      params: resolveModeParams(taskId, link),
      source: {
        mode: link.mode,
        ...(link.presetId ? { presetId: link.presetId } : {}),
      },
    };
  }
  const builtin = builtinProfileFor(provider, modelId);
  if (builtin) {
    // The Auto path (no link): the Instruct profile of the model with the
    // validated vendor values, except the temperature, which is 0 for every
    // stage (owner decision 2026-10-30, specs/llm-runtime-tuning.md section 13).
    // The stored profile keeps the vendor temperature: a profile that the
    // user links is used as stored (the branch above). mergeSamplingIntoBody
    // lets these values win. The output limit stays task-derived.
    return {
      params: {
        ...builtin.params,
        ...builtin.taskParams?.[taskId],
        temperature: AUTO_TEMPERATURE,
      },
      source: { mode: "preset", presetId: builtin.id },
      soft: true,
    };
  }
  if (
    taskId === "cleanup" &&
    parseLlmTaskAssignments(readSetting(SETTINGS_KEYS.llmTaskAssignments))
      .cleanup === undefined
  ) {
    const legacy = resolveCleanupLegacyFallback();
    if (legacy)
      return { params: legacy.params ?? {}, source: { mode: "custom" } };
  }
  return { params: {}, source: { mode: "auto" } };
}

/** §7.4 — strip denylisted keys before either transport tier sees them,
 *  logging what was dropped. The meeting tasks also lose the keys of
 *  `LLM_MEETING_DENYLIST_KEYS` (5.5.3); dictation cleanup keeps them. */
function stripDenylistedKeys(
  taskId: LlmTaskId,
  params: Record<string, unknown>,
): { kept: Record<string, unknown>; dropped: DroppedPresetKey[] } {
  const meeting = taskId === "meetingEnhance" || taskId === "meetingSummarize";
  const dropped: DroppedPresetKey[] = [];
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (
      LLM_PRESET_DENYLIST_KEYS.has(key) ||
      (meeting && LLM_MEETING_DENYLIST_KEYS.has(key))
    ) {
      dropped.push({ name: key, value, reason: "denylist" });
      continue;
    }
    kept[key] = value;
  }
  if (dropped.length > 0) {
    log.debug(
      `dropped denylisted preset keys: ${dropped.map((d) => d.name).join(", ")}`,
    );
  }
  return { kept, dropped };
}

/** §6.3 — resolve the effective provider/model for a task, validating a
 *  model override and falling back to the app-wide default (with a `warn`
 *  log) when the override is no longer servable. */
function resolveEffectiveModel(
  taskId: LlmTaskId,
  assignment: LlmTaskAssignment,
  fallback: DefaultLlmChoice,
): { provider: string; modelId: string } {
  const override = assignment.modelOverride;
  if (!override) {
    return { provider: fallback.provider, modelId: fallback.model_id };
  }

  const provider = getLlmProvider(override.provider);
  if (!provider) {
    log.warn(
      `resolveTaskCall("${taskId}"): model override provider "${override.provider}" is unknown, falling back to the app default`,
    );
    return { provider: fallback.provider, modelId: fallback.model_id };
  }

  if (provider.ownServer) {
    const target = parseServerModelId(override.model_id);
    if (!target || !getOwnServer(target.serverId)) {
      log.warn(
        `resolveTaskCall("${taskId}"): model override's server is no longer in the list, falling back to the app default`,
      );
      return { provider: fallback.provider, modelId: fallback.model_id };
    }
  } else if (!provider.local && !getApiKey(override.provider)) {
    log.warn(
      `resolveTaskCall("${taskId}"): no stored API key for model override provider "${override.provider}", falling back to the app default`,
    );
    return { provider: fallback.provider, modelId: fallback.model_id };
  }

  if (
    provider.providerId === MLX_LLM_PROVIDER_ID &&
    !getMlxLlmModel(stripModelPrefix(MLX_LLM_PROVIDER_ID, override.model_id))
  ) {
    log.warn(
      `resolveTaskCall("${taskId}"): model override is a local model that is no longer in the catalog, falling back to the app default`,
    );
    return { provider: fallback.provider, modelId: fallback.model_id };
  }

  return { provider: override.provider, modelId: override.model_id };
}

function readTaskAssignment(taskId: LlmTaskId): LlmTaskAssignment {
  const assignments = parseLlmTaskAssignments(
    readSetting(SETTINGS_KEYS.llmTaskAssignments),
  );
  let assignment = assignments[taskId];
  if (!assignment && taskId === "cleanup") {
    // §12.7 — see resolveCleanupLegacyFallback's own comment.
    assignment = resolveCleanupLegacyFallback() ?? undefined;
  }
  return assignment ?? { mode: "auto" };
}

async function resolveModelFor(
  taskId: LlmTaskId,
  assignment: LlmTaskAssignment,
  pin: { provider: string; modelId: string } | undefined,
): Promise<{ provider: string; modelId: string }> {
  if (pin) return { provider: pin.provider, modelId: pin.modelId };
  const { getDefaultModels } = await import("../providers.js");
  const fallback = getDefaultModels().llm;
  if (!fallback) {
    throw new Error(
      "No AI model is set up yet. Pick one in Settings > Models.",
    );
  }
  return resolveEffectiveModel(taskId, assignment, fallback);
}

/**
 * The provider and model one call for `taskId` would use, with no sampling and
 * no budget. The model profile (`model-profiles.ts`) calls it once for each
 * step, in `prepare`, to learn which model to pin.
 */
export async function resolveTaskModel(
  taskId: LlmTaskId,
  pin?: { provider: string; modelId: string },
): Promise<{ provider: string; modelId: string }> {
  return resolveModelFor(taskId, readTaskAssignment(taskId), pin);
}

/**
 * Resolve everything one LLM call for `taskId` needs: which model, what
 * sampling params (and in what shape for the resolved provider's transport
 * tier), whether reasoning is on, the output budget (task floor vs. preset
 * ceiling, §6.2), and the timeout. Never cached across requests — settings
 * are read fresh on every call, matching the existing "read settings fresh
 * on every call" comment at `registry.ts`.
 */
export async function resolveTaskCall(
  taskId: LlmTaskId,
  opts: ResolveTaskCallOptions = {},
): Promise<ResolvedTaskCall> {
  const profile = LLM_TASK_PROFILES[taskId];

  const assignment = readTaskAssignment(taskId);
  const { provider, modelId } = await resolveModelFor(
    taskId,
    assignment,
    opts.pin,
  );

  // The profile of this model for this task: the link the user made for this
  // model and task, else the built-in profile of a built-in model, else auto.
  // A link made for another model never applies (profile-links.ts).
  const {
    params: rawParams,
    source,
    soft,
  } = resolveProfileParams(taskId, provider, modelId); // §6.1 — {} for "auto"
  const { kept: strippedParams, dropped: deniedKeys } = stripDenylistedKeys(
    taskId,
    rawParams,
  ); // §7.4, logs drops

  const isLocal = isLocalProvider(provider);
  // §6.4 — the reasoning seed and a mode-selected `chat_template_kwargs` are
  // merged key-by-key, not swapped wholesale: a plain `...strippedParams`
  // spread after the seed would let a preset/custom object that touches
  // `chat_template_kwargs` for an unrelated reason (e.g. only
  // `reasoning_effort`) silently replace the *entire* nested object and drop
  // `enable_thinking` — reopening the exact gap this profile is meant to
  // close (§2.2, §6.4). The task's `enable_thinking` seed only yields when
  // the mode-selected params set that key themselves.
  const { chat_template_kwargs: presetChatTemplateKwargs, ...restParams } =
    strippedParams;
  const samplingParams = isLocal
    ? {
        ...restParams,
        chat_template_kwargs: {
          enable_thinking: profile.reasoningEnabled,
          ...(typeof presetChatTemplateKwargs === "object" &&
          presetChatTemplateKwargs !== null
            ? presetChatTemplateKwargs
            : {}),
        },
      }
    : {}; // mapped-subset providers never get the verbatim object at all

  // §7.2: only `temperature`, `top_p` and `max_tokens` from the preset reach a
  // mapped-subset provider. Local providers get them in `samplingParams`.
  const presetTemperature =
    !isLocal && typeof strippedParams.temperature === "number"
      ? strippedParams.temperature
      : undefined;
  const presetTopP =
    !isLocal && typeof strippedParams.top_p === "number"
      ? strippedParams.top_p
      : undefined;

  // profile.maxOutputTokens === "auto" requires the caller to supply
  // opts.autoMaxOutputTokens (every §8.5 call site for an "auto"-profiled
  // task does) — fail loudly on a missing budget instead of falling through
  // to an unsafe cast that could silently resolve to NaN.
  const taskBudget =
    profile.maxOutputTokens === "auto"
      ? (opts.autoMaxOutputTokens ??
        (() => {
          throw new Error(
            `resolveTaskCall("${taskId}"): task profile is "auto" but no autoMaxOutputTokens was supplied`,
          );
        })())
      : profile.maxOutputTokens;
  const presetFloor =
    typeof strippedParams.max_tokens === "number"
      ? strippedParams.max_tokens
      : 0;

  // A cloud provider takes only the safe subset; the rest of the preset is
  // asked for and not sent. The ledger records each key.
  const droppedKeys: DroppedPresetKey[] = [...deniedKeys];
  if (!isLocal) {
    for (const [key, value] of Object.entries(strippedParams)) {
      if (!SAFE_SUBSET_KEYS.has(key)) {
        droppedKeys.push({ name: key, value, reason: "not_in_safe_subset" });
      }
    }
  }
  // The keys that the user set. The default built-in profile sets none: the
  // gateway plan (a bounded reasoning step) may still change its keys.
  const presetKeys = soft
    ? { topLevel: [], chatTemplateKwargs: [] }
    : {
        topLevel: Object.keys(restParams),
        chatTemplateKwargs:
          typeof presetChatTemplateKwargs === "object" &&
          presetChatTemplateKwargs !== null
            ? Object.keys(presetChatTemplateKwargs)
            : [],
      };

  return {
    provider,
    modelId,
    temperature: presetTemperature ?? profile.temperature,
    ...(presetTopP !== undefined ? { topP: presetTopP } : {}),
    maxOutputTokens: Math.max(taskBudget, presetFloor), // §6.2
    reasoningEnabled: profile.reasoningEnabled,
    samplingParams,
    timeoutMs: taskTimeoutMs(taskId, profile.timeoutMs),
    droppedKeys,
    source,
    presetKeys,
  };
}
