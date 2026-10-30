import { createAppLogger } from "@openstyle/utils";
import type { LlmTaskId } from "@openstyle/validations";
import { getMlxLlmModel, MLX_LLM_PROVIDER_ID } from "../mlx-llm/constants.js";
import { stripModelPrefix } from "../model-id.js";
import { fetchModelsFromRegistry } from "../model-registry.js";
import type { LlmStepId, StructuredMode } from "./call-record.js";
import { blankFacts, modelUnavailableFrom } from "./gateway-errors.js";
import {
  type GatewayOverrides,
  groqCleanupProviderOptions,
  isLocalProvider,
} from "./registry.js";
import { resolveTaskModel } from "./task-profiles.js";

// Model profiles (specs/meeting-enhance-agentic.md 5.1, 5.4, 5.5). A profile
// says which model a step uses, how it returns structured output and how to
// switch reasoning off or bound it. It is plain data (no API key). Nothing here
// knows a consumer: the step ids and the task of each step are the only names.

const log = createAppLogger("llm-model-profiles");

export type MeetingLlmTaskId = Extract<
  LlmTaskId,
  "meetingEnhance" | "meetingSummarize"
>;

/** The task each step runs under. A later consumer adds its steps here. */
export const STEP_TASK: Record<LlmStepId, MeetingLlmTaskId> = {
  correctChunk: "meetingEnhance",
  identifySpeakers: "meetingEnhance",
  summarize: "meetingSummarize",
  suggestTags: "meetingEnhance",
};

export interface ReasoningPlan {
  mode: "off" | "bounded";
  /** 0 when off. */
  budgetTokens: number;
  /** Reasoning tokens use the output limit. */
  countsInMaxOutput: boolean;
  /** null: no token budget for this provider. */
  maxBudgetTokens: number | null;
  boundedLevel: "minimal" | "low" | "medium" | "high" | null;
  control: "none" | "effort" | "toggle" | "budget_tokens" | "template_kwargs";
  /** Beats a user preset. Only the length route sets it. */
  force: boolean;
  /**
   * The wire value that turns reasoning off, read from models.dev at resolve
   * time (OpenAI `reasoningEffort`). null: none listed, so nothing is sent.
   * An optional addition to the shape of 5.1, so a call never reads the registry again.
   */
  offValue?: string | null;
}

/** Plain data, no API key. Lives in the graph state. */
export interface CallProfile {
  taskId: MeetingLlmTaskId;
  provider: string;
  modelId: string;
  /**
   * models.dev `limit.context` and `limit.output`, or the catalog limits of a
   * local MLX LLM. null for `server` and when the read fails.
   */
  contextWindow: number | null;
  maxOutputTokens: number | null;
  structured: StructuredMode;
  reasoning: ReasoningPlan;
  /** One line each, no prompt text. Copied into the ledger. */
  warnings: string[];
}

export type ReasoningSteps = Partial<Record<LlmStepId, "bounded">>;

/** Steps where reasoning may be on. Empty until the benchmark shows a gain (D12). */
export const reasoningSteps: ReasoningSteps = {};

export type ResolvedModels = Record<LlmStepId, CallProfile>;

export interface ResolveCallProfileArgs {
  taskId: MeetingLlmTaskId;
  step: LlmStepId;
  maxReasoningTokens: number;
  pin?: { provider: string; modelId: string };
  /** Test hook. Replaces the table for this call. Production never passes it. */
  reasoningSteps?: ReasoningSteps;
}

// ---------------------------------------------------------------------------
// models.dev facts
// ---------------------------------------------------------------------------

interface RegistryFacts {
  structuredOutput: boolean | undefined;
  reasoning: boolean | undefined;
  contextWindow: number | null;
  maxOutput: number | null;
  /** Reasoning efforts the entry lists, lowest first as listed. null: unknown. */
  efforts: string[] | null;
}

type RegistryRead =
  | { kind: "skipped" }
  | { kind: "failed" }
  | { kind: "ok"; data: Record<string, unknown> };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function readEfforts(entry: Record<string, unknown>): string[] | null {
  const options = entry.reasoning_options;
  const candidates: unknown[] = [options];
  const record = asRecord(options);
  if (record) {
    candidates.push(record.efforts, record.effort, record.levels);
  }
  for (const c of candidates) {
    if (Array.isArray(c) && c.every((v) => typeof v === "string")) {
      return c as string[];
    }
  }
  return null;
}

function registryFacts(
  read: RegistryRead,
  provider: string,
  modelId: string,
): RegistryFacts | null {
  if (read.kind !== "ok") return null;
  const providerEntry = asRecord(read.data[provider]);
  const models = asRecord(providerEntry?.models);
  if (!models) return null;
  const shortId = stripModelPrefix(provider, modelId);
  const entry = asRecord(models[modelId] ?? models[shortId]);
  if (!entry) return null;
  const limit = asRecord(entry.limit);
  return {
    structuredOutput:
      typeof entry.structured_output === "boolean"
        ? entry.structured_output
        : undefined,
    reasoning:
      typeof entry.reasoning === "boolean" ? entry.reasoning : undefined,
    contextWindow: positiveInt(limit?.context),
    maxOutput: positiveInt(limit?.output),
    efforts: readEfforts(entry),
  };
}

/** The read is best effort (5.1): a failure becomes a warning, never an error. */
async function readRegistry(providers: string[]): Promise<RegistryRead> {
  if (providers.every((p) => isLocalProvider(p))) return { kind: "skipped" };
  try {
    return { kind: "ok", data: await fetchModelsFromRegistry() };
  } catch (err) {
    log.warn(
      `models.dev read failed, using the hand tables: ${err instanceof Error ? err.name : "error"}`,
    );
    return { kind: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Structured-output mode (5.4)
// ---------------------------------------------------------------------------

/** Groq models with strict `json_schema` (a code constant, UNVERIFIED over time). */
const GROQ_STRICT_MODELS = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-safeguard-20b",
  "qwen/qwen3.8-27b",
  "meta-models/muse-spark-open",
]);

/** The ladder of one provider, first mode first. A call moves down on a 400. */
export function modeLadder(provider: string): StructuredMode[] {
  switch (provider) {
    case "groq":
    case "openai":
    case "openrouter":
    case "vercel":
      return ["json_schema_strict", "json_object", "prompt_only"];
    case "anthropic":
      return ["json_schema", "json_tool", "prompt_only"];
    case "google":
    case "mistral":
      return ["json_schema", "json_object", "prompt_only"];
    case "server":
    case MLX_LLM_PROVIDER_ID:
      return ["json_schema_strict", "prompt_only"];
    default:
      return ["prompt_only"];
  }
}

function lowerOnce(provider: string, mode: StructuredMode): StructuredMode {
  const ladder = modeLadder(provider);
  const i = ladder.indexOf(mode);
  return ladder[Math.min(Math.max(i, 0) + 1, ladder.length - 1)] ?? mode;
}

/** The next mode below `mode`, or null when none is left. */
export function lowerMode(
  provider: string,
  mode: StructuredMode,
): StructuredMode | null {
  const ladder = modeLadder(provider);
  const i = ladder.indexOf(mode);
  const next = i >= 0 ? ladder[i + 1] : undefined;
  return next ?? null;
}

/** Anthropic models with `output_config.format` (UNVERIFIED for newer ids). */
function anthropicSupportsOutputFormat(shortId: string): boolean {
  return /^claude-(?:opus|sonnet|haiku|fable)-[4-9]/.test(shortId);
}

function startMode(
  provider: string,
  shortId: string,
  facts: RegistryFacts | null,
): StructuredMode {
  const off = facts?.structuredOutput === false;
  switch (provider) {
    case "groq":
      return GROQ_STRICT_MODELS.has(shortId) && !off
        ? "json_schema_strict"
        : "json_object";
    case "anthropic":
      return anthropicSupportsOutputFormat(shortId) && !off
        ? "json_schema"
        : "json_tool";
    case "google":
    case "mistral":
      return off ? lowerOnce(provider, "json_schema") : "json_schema";
    case "server":
    case MLX_LLM_PROVIDER_ID:
      return "json_schema_strict";
    default:
      return off
        ? lowerOnce(provider, "json_schema_strict")
        : (modeLadder(provider)[0] ?? "prompt_only");
  }
}

/** In memory. A restart costs one fast 400 for each server and model (5.4). */
const modeCache = new Map<string, StructuredMode>();

function modeKey(provider: string, modelId: string): string {
  return `${provider}|${modelId}`;
}

/** The mode to send: the profile mode, or a lower one learned from a 400. */
export function effectiveMode(profile: CallProfile): StructuredMode {
  const cached = modeCache.get(modeKey(profile.provider, profile.modelId));
  if (!cached) return profile.structured;
  const ladder = modeLadder(profile.provider);
  return ladder.indexOf(cached) > ladder.indexOf(profile.structured)
    ? cached
    : profile.structured;
}

/** Remember that `mode` was rejected, so the next call uses the one below. */
export function rememberRejectedMode(
  profile: CallProfile,
  rejected: StructuredMode,
): StructuredMode | null {
  const lower = lowerMode(profile.provider, rejected);
  if (lower) modeCache.set(modeKey(profile.provider, profile.modelId), lower);
  return lower;
}

/** Test seam: a new process starts with an empty cache. */
export function __clearModeCacheForTests(): void {
  modeCache.clear();
}

// ---------------------------------------------------------------------------
// Reasoning profile (5.5)
// ---------------------------------------------------------------------------

function boundedLevelFor(tokens: number): "low" | "medium" | "high" {
  if (tokens <= 1024) return "low";
  if (tokens <= 4096) return "medium";
  return "high";
}

/** Claude 4.7 and later use adaptive thinking; earlier ones a token budget. */
function anthropicAdaptive(shortId: string): boolean {
  const m = /^claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?/.exec(
    shortId,
  );
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 7);
}

/** Gemini 3 and Gemini 4 control thinking with `thinkingLevel`. */
function isGemini3(shortId: string): boolean {
  return /^gemini-[34]/.test(shortId);
}

/**
 * Claude models that reject `thinking: disabled` (Fable 5, Fable 5.1, Opus 5.5
 * and Mythos): adaptive thinking is always on. Sonnet 5.5 rejects it too, but
 * the AI SDK sends its lowest setting `between_tools`. Source: the thinking
 * table in platform.claude.com/docs/en/build-with-claude/thinking.
 */
function anthropicThinkingAlwaysOn(shortId: string): boolean {
  return /^claude-(?:fable-5|mythos-5|opus-5-5)/.test(shortId);
}

/**
 * Mistral `reasoning_effort` for "no reasoning". Small 4 and Medium 3.5 take
 * `none`; Large 4 and GLM 5.3 do not (their lowest level is `low`). Source:
 * docs.mistral.ai/studio/conversations/reasoning (llms-full.txt, 2026-10-30).
 */
function mistralOffEffort(shortId: string): "none" | "low" {
  return /^(?:mistral-large-4|zai-glm-5-3)/.test(shortId) ? "low" : "none";
}

const OPENAI_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high"];

function openAiOffEffort(facts: RegistryFacts | null): string | null {
  if (facts?.reasoning === false) return null;
  const listed = facts?.efforts;
  if (!listed || listed.length === 0) return null;
  if (listed.includes("none")) return "none";
  const sorted = [...listed].sort(
    (a, b) => OPENAI_EFFORT_ORDER.indexOf(a) - OPENAI_EFFORT_ORDER.indexOf(b),
  );
  return sorted[0] ?? null;
}

function buildReasoning(
  provider: string,
  modelId: string,
  mode: "off" | "bounded",
  maxReasoningTokens: number,
  facts: RegistryFacts | null,
): ReasoningPlan {
  const shortId = stripModelPrefix(provider, modelId);
  const plan = (
    p: Partial<ReasoningPlan> &
      Pick<ReasoningPlan, "control"> & { minBudgetTokens?: number },
  ) => {
    const bounded = mode === "bounded" && p.control !== "none";
    const level = bounded
      ? (p.boundedLevel ?? boundedLevelFor(maxReasoningTokens))
      : null;
    return {
      mode: bounded ? "bounded" : "off",
      budgetTokens: bounded
        ? Math.max(p.minBudgetTokens ?? 0, maxReasoningTokens)
        : 0,
      countsInMaxOutput: p.countsInMaxOutput ?? true,
      maxBudgetTokens: p.maxBudgetTokens ?? null,
      boundedLevel:
        p.control === "effort" || p.control === "toggle" ? level : null,
      control: p.control,
      force: false,
      offValue: provider === "openai" ? openAiOffEffort(facts) : null,
    } satisfies ReasoningPlan;
  };

  switch (provider) {
    case "server":
    case MLX_LLM_PROVIDER_ID:
      return plan({ control: "template_kwargs" });
    case "openai":
    case "openrouter":
      return plan({ control: "effort" });
    case "anthropic":
      return anthropicAdaptive(shortId)
        ? plan({ control: "effort", countsInMaxOutput: false })
        : // The wire budget has a floor of 1024; the plan must equal the wire.
          plan({
            control: "budget_tokens",
            countsInMaxOutput: false,
            minBudgetTokens: 1024,
          });
    case "google":
      return isGemini3(shortId)
        ? plan({ control: "effort" })
        : plan({ control: "budget_tokens" });
    case "groq":
      return groqCleanupProviderOptions(modelId, false)
        ? plan({ control: "effort" })
        : plan({ control: "none" });
    case "mistral":
      return plan({ control: "effort" });
    default:
      return plan({ control: "none" });
  }
}

/** The same profile with reasoning off and forced (the length route, 4.0.6). */
export function withReasoningOff(p: CallProfile): CallProfile {
  return {
    ...p,
    reasoning: {
      ...p.reasoning,
      mode: "off",
      budgetTokens: 0,
      boundedLevel: null,
      force: true,
    },
  };
}

/** What a profile puts on the wire for reasoning. */
export interface ReasoningWire {
  providerOptions: Record<string, Record<string, unknown>>;
  /** Top-level body keys for the OpenRouter wrapper. */
  bodyExtra: Record<string, unknown>;
  /** `server` and `local-mlx-llm` only: the gateway keys of rank 1 (5.5.2). */
  overrides: GatewayOverrides;
  /** True when the provider has no documented control, so nothing is sent. */
  noControl: boolean;
  /** Ledger warnings. */
  warnings: string[];
}

export function reasoningWire(profile: CallProfile): ReasoningWire {
  const { provider, reasoning } = profile;
  const shortId = stripModelPrefix(provider, profile.modelId);
  const wire: ReasoningWire = {
    providerOptions: {},
    bodyExtra: {},
    overrides: {},
    noControl: false,
    warnings: [],
  };
  const bounded = reasoning.mode === "bounded";

  switch (provider) {
    case "server":
    case MLX_LLM_PROVIDER_ID: {
      if (reasoning.force) {
        wire.overrides.force = {
          chatTemplateKwargs: { enable_thinking: false },
          removeChatTemplateKwargs: ["reasoning_effort"],
          remove: ["reasoning_effort", "thinking_budget"],
        };
      } else if (bounded) {
        wire.overrides.bounded = {
          chatTemplateKwargs: { enable_thinking: true },
          set: { thinking_budget: reasoning.budgetTokens },
        };
      }
      return wire;
    }
    case "openai": {
      if (bounded) {
        wire.providerOptions.openai = {
          reasoningEffort: reasoning.boundedLevel ?? "low",
        };
        return wire;
      }
      if (reasoning.offValue) {
        wire.providerOptions.openai = { reasoningEffort: reasoning.offValue };
      } else wire.noControl = true;
      return wire;
    }
    case "anthropic": {
      const adaptive = anthropicAdaptive(shortId);
      if (bounded) {
        wire.providerOptions.anthropic = adaptive
          ? {
              thinking: { type: "adaptive" },
              effort: reasoning.boundedLevel ?? "low",
            }
          : {
              thinking: {
                type: "enabled",
                budgetTokens: Math.max(1024, reasoning.budgetTokens),
              },
            };
      } else {
        wire.providerOptions.anthropic = {
          thinking: { type: "disabled" },
          // The model cannot stop thinking, so ask for the least of it.
          ...(anthropicThinkingAlwaysOn(shortId) ? { effort: "low" } : {}),
        };
      }
      return wire;
    }
    case "google": {
      const gemini3 = isGemini3(shortId);
      if (bounded) {
        wire.providerOptions.google = {
          thinkingConfig: gemini3
            ? { thinkingLevel: reasoning.boundedLevel ?? "low" }
            : { thinkingBudget: reasoning.budgetTokens },
        };
      } else if (gemini3) {
        // Gemini 3.1 Pro cannot turn thinking off: send the lowest level.
        wire.providerOptions.google = {
          thinkingConfig: { thinkingLevel: "low" },
        };
        wire.warnings.push("reasoning cannot be turned off: thinkingLevel low");
      } else {
        wire.providerOptions.google = { thinkingConfig: { thinkingBudget: 0 } };
      }
      return wire;
    }
    case "groq": {
      const options = groqCleanupProviderOptions(profile.modelId, bounded);
      if (options) {
        wire.providerOptions.groq = { ...options.groq };
      } else {
        wire.noControl = true;
      }
      return wire;
    }
    case "mistral": {
      wire.providerOptions.mistral = {
        reasoningEffort: bounded ? "high" : mistralOffEffort(shortId),
      };
      return wire;
    }
    case "openrouter": {
      wire.bodyExtra.reasoning = bounded
        ? { effort: reasoning.boundedLevel ?? "low" }
        : { effort: "none" };
      return wire;
    }
    default: {
      // vercel and unknown providers: no documented control.
      wire.noControl = true;
      return wire;
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async function resolveBase(
  taskId: MeetingLlmTaskId,
  step: LlmStepId,
  pin: { provider: string; modelId: string } | undefined,
): Promise<{ provider: string; modelId: string }> {
  try {
    return await resolveTaskModel(taskId, pin);
  } catch (err) {
    throw modelUnavailableFrom(
      err,
      blankFacts({
        step,
        unitKey: "prepare",
        modelRequested: pin?.modelId ?? "",
      }),
    );
  }
}

function buildProfile(
  a: ResolveCallProfileArgs,
  base: { provider: string; modelId: string },
  read: RegistryRead,
): CallProfile {
  const table = a.reasoningSteps ?? reasoningSteps;
  const facts = registryFacts(read, base.provider, base.modelId);
  const shortId = stripModelPrefix(base.provider, base.modelId);
  const warnings: string[] = [];
  if (read.kind === "failed") warnings.push("registry_unavailable");
  const mode = table[a.step] === "bounded" ? "bounded" : "off";
  // The local MLX LLM has no models.dev entry. Its catalog has the limits.
  const localDef =
    base.provider === MLX_LLM_PROVIDER_ID ? getMlxLlmModel(shortId) : undefined;
  return {
    taskId: a.taskId,
    provider: base.provider,
    modelId: base.modelId,
    contextWindow: facts?.contextWindow ?? localDef?.contextTokens ?? null,
    maxOutputTokens: facts?.maxOutput ?? localDef?.maxOutputTokens ?? null,
    structured: startMode(base.provider, shortId, facts),
    reasoning: buildReasoning(
      base.provider,
      base.modelId,
      mode,
      a.maxReasoningTokens,
      facts,
    ),
    warnings,
  };
}

/**
 * The profile of one step. `resolveModels` is the normal entry (one registry
 * read for all steps); this one reads the registry for its own provider.
 * A setup fault becomes `ModelUnavailableError`. A failed models.dev read does not.
 */
export async function resolveCallProfile(
  a: ResolveCallProfileArgs,
): Promise<CallProfile> {
  const base = await resolveBase(a.taskId, a.step, a.pin);
  const read = await readRegistry([base.provider]);
  return buildProfile(a, base, read);
}

/** The three profiles of a run. Reads models.dev once (5.1 rule 2). */
export async function resolveModels(a: {
  maxReasoningTokens: Record<LlmStepId, number>;
  reasoningSteps?: ReasoningSteps;
}): Promise<ResolvedModels> {
  const steps = Object.keys(STEP_TASK) as LlmStepId[];
  const bases = new Map<LlmStepId, { provider: string; modelId: string }>();
  for (const step of steps) {
    bases.set(step, await resolveBase(STEP_TASK[step], step, undefined));
  }
  const providers = [...bases.values()].map((b) => b.provider);
  const read = await readRegistry(providers);
  const out = {} as ResolvedModels;
  for (const step of steps) {
    out[step] = buildProfile(
      {
        taskId: STEP_TASK[step],
        step,
        maxReasoningTokens: a.maxReasoningTokens[step],
        ...(a.reasoningSteps ? { reasoningSteps: a.reasoningSteps } : {}),
      },
      bases.get(step) as { provider: string; modelId: string },
      read,
    );
  }
  return out;
}
