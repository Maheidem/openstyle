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
  LLM_PRESET_DENYLIST_KEYS,
  llmParameterPresetsSettingSchema,
  parseCleanupSampling,
  parseLlmTaskAssignments,
  SAFE_SUBSET_KEYS,
} from "@openstyle/validations";
import { readSetting } from "../db.js";
import { getApiKeyForProvider } from "../streaming-stt.js";
import { getLlmProvider } from "./registry.js";

const log = createAppLogger("llm-task-profiles");

export interface LlmTaskProfile {
  id: LlmTaskId;
  /** Whether reasoning/thinking is on by default for this task's nature. */
  reasoningEnabled: boolean;
  /** SDK-level default temperature when no preset/custom override wins. */
  temperature: number;
  /**
   * Output budget. A concrete number, or `"auto"` to keep the task's own
   * existing per-call heuristic (cleanup/Remix scale off input length,
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
 * redefine.
 *
 * `meetingSummarize.maxOutputTokens` is `4096` — the same number as
 * `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` (`meetings/summarize.ts:60`), kept as a
 * literal here rather than imported: `summarize.ts` imports `llm-call.ts`,
 * which imports `resolveTaskCall` from this module, so an import in the
 * other direction (this module importing `summarize.ts`) would create a
 * three-module load cycle (`task-profiles.ts` -> `summarize.ts` ->
 * `llm-call.ts` -> `task-profiles.ts`) whose safety depends on module-eval
 * ordering. Both constants are asserted equal in
 * `apps/server/tests/llm-task-profiles.test.ts`, so a future edit to either
 * number without updating the other fails a test instead of drifting
 * silently.
 */
export const LLM_TASK_PROFILES: Record<LlmTaskId, LlmTaskProfile> = {
  cleanup: {
    id: "cleanup",
    reasoningEnabled: false,
    temperature: 0,
    maxOutputTokens: "auto",
    timeoutMs: 20_000,
  },
  remix: {
    id: "remix",
    reasoningEnabled: false,
    temperature: 0,
    maxOutputTokens: "auto",
    timeoutMs: 30_000,
  },
  meetingSummarize: {
    id: "meetingSummarize",
    reasoningEnabled: false,
    temperature: 0,
    maxOutputTokens: 4096,
    timeoutMs: 60_000,
  },
  meetingEnhance: {
    id: "meetingEnhance",
    reasoningEnabled: false,
    temperature: 0,
    maxOutputTokens: "auto",
    timeoutMs: 60_000,
  },
};

export interface ResolvedTaskCall {
  provider: string;
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
  reasoningEnabled: boolean;
  samplingParams: Record<string, unknown>; // {} in "auto" mode
  timeoutMs: number;
  cloudPartial: boolean; // §7.5
}

export interface ResolveTaskCallOptions {
  autoMaxOutputTokens?: number;
}

/** The app-wide default model, as `getDefaultModels().llm` returns it. */
export interface DefaultLlmChoice {
  provider: string;
  model_id: string;
  model_name?: string;
}

/** Read + merge the stored user presets behind the built-ins (§4.2). */
function resolveMergedPresets(): readonly LlmParameterPreset[] {
  const raw = readSetting("llm_parameter_presets");
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
  const legacy = parseCleanupSampling(readSetting("cleanup_sampling"));
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

/** §7.4 — strip denylisted keys before either transport tier sees them,
 *  logging what was dropped. */
function stripDenylistedKeys(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const dropped: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (LLM_PRESET_DENYLIST_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    out[key] = value;
  }
  if (dropped.length > 0) {
    log.debug(`dropped denylisted preset keys: ${dropped.join(", ")}`);
  }
  return out;
}

/** §7.2 — pull out only the universally-safe keys for a mapped-subset-tier
 *  provider. */
function pickSafeSubset(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (SAFE_SUBSET_KEYS.has(key)) {
      out[key] = value;
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    log.debug(
      `mapped-subset provider drops non-safe preset keys: ${dropped.join(", ")}`,
    );
  }
  return out;
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

  const isLocal = provider.local ?? override.provider === "local-llm";
  if (isLocal) {
    if (!readSetting("local_llm_url")) {
      log.warn(
        `resolveTaskCall("${taskId}"): model override's local endpoint is no longer configured, falling back to the app default`,
      );
      return { provider: fallback.provider, modelId: fallback.model_id };
    }
  } else if (!getApiKeyForProvider(override.provider)) {
    log.warn(
      `resolveTaskCall("${taskId}"): no stored API key for model override provider "${override.provider}", falling back to the app default`,
    );
    return { provider: fallback.provider, modelId: fallback.model_id };
  }

  return { provider: override.provider, modelId: override.model_id };
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

  const assignments = parseLlmTaskAssignments(
    readSetting("llm_task_assignments"),
  );
  let assignment = assignments[taskId];
  if (!assignment && taskId === "cleanup") {
    // §12.7 — see resolveCleanupLegacyFallback's own comment.
    assignment = resolveCleanupLegacyFallback() ?? undefined;
  }
  assignment ??= { mode: "auto" };

  const { getDefaultModels } = await import("../providers.js");
  const defaults = getDefaultModels();
  const fallback = defaults.llm;
  if (!fallback) {
    throw new Error(
      "No AI model is set up yet. Pick one in Settings > Models.",
    );
  }
  const { provider, modelId } = resolveEffectiveModel(
    taskId,
    assignment,
    fallback,
  );

  const rawParams = resolveModeParams(taskId, assignment); // §6.1 — {} for "auto"
  const strippedParams = stripDenylistedKeys(rawParams); // §7.4, logs drops

  const isLocal = getLlmProvider(provider)?.local ?? provider === "local-llm";
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

  const safeSubset = isLocal ? {} : pickSafeSubset(strippedParams); // §7.2
  const cloudPartial =
    !isLocal &&
    Object.keys(strippedParams).some((k) => !SAFE_SUBSET_KEYS.has(k));

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

  return {
    provider,
    modelId,
    temperature:
      typeof safeSubset.temperature === "number"
        ? safeSubset.temperature
        : profile.temperature,
    maxOutputTokens: Math.max(taskBudget, presetFloor), // §6.2
    reasoningEnabled: profile.reasoningEnabled,
    samplingParams: isLocal ? samplingParams : {},
    timeoutMs: profile.timeoutMs,
    cloudPartial,
  };
}
