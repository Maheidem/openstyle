import { createAppLogger } from "@openstyle/utils";
import {
  BUILTIN_MODEL_PRESETS,
  builtinProfile,
  builtinProfileKey,
  type LlmParameterPreset,
  type LlmProfileLinks,
  type LlmTaskAssignments,
  type LlmTaskId,
  parseLlmProfileLinks,
  parseLlmTaskAssignments,
  profileLinkKey,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { getDb, readSetting, writeSetting } from "../db.js";
import { MLX_LLM_MODELS, MLX_LLM_PROVIDER_ID } from "../mlx-llm/constants.js";

const log = createAppLogger("llm-profile-links");

// (model, task) -> profile. The owner design of 2026-10-30: a profile that the
// user links to a task is stored for the model that the task runs on, and it
// does not follow the task to another model. A built-in model has a built-in
// profile that the app uses when no link exists.

/**
 * The built-in profile of a model, or undefined. A built-in MLX model has one
 * by its catalog id, and a model of any provider has one when its id clearly
 * names a Qwen version and size (`builtinProfileKey`). The default of every
 * stage is the Instruct profile.
 */
export function builtinProfileFor(
  provider: string,
  modelId: string,
  mode: "instruct" | "thinking" = "instruct",
): LlmParameterPreset | undefined {
  const short = modelId.startsWith(`${provider}/`)
    ? modelId.slice(provider.length + 1)
    : modelId;
  const key = builtinProfileKey(short, provider === MLX_LLM_PROVIDER_ID);
  return key ? builtinProfile(key, mode) : undefined;
}

/**
 * Words of a profile name that point to one built-in model. A name that holds
 * none of them gives no binding (the link stays unbound).
 */
const NAME_HINTS: readonly [RegExp, string][] = [
  [/qwen/i, "qwen3.8-27b-4bit"],
  [/nemotron/i, "nemotron-3.5-bolt-e4b-4bit"],
  [/26b/i, "gemma-4-26b-a4b-qat-4bit"],
  [/e4b/i, "gemma-4-e4b-qat-4bit"],
  [/e2b/i, "gemma-4-e2b-qat-4bit"],
];

/**
 * One time: bind each old task assignment (preset or custom values, with no
 * model) to the model it was made for. Rule, in order:
 * 1. The model override of the task, when the assignment has one.
 * 2. A built-in model whose family word is in the name of the preset.
 * 3. Else the link stays unbound. It is ignored, and one log line names it.
 */
function migrateOldAssignments(): LlmProfileLinks {
  const links = parseLlmProfileLinks(
    readSetting(SETTINGS_KEYS.llmProfileLinks),
  );
  const assignments = parseLlmTaskAssignments(
    readSetting(SETTINGS_KEYS.llmTaskAssignments),
  );
  let presets: { id: string; name: string }[] = [];
  try {
    const raw = readSetting(SETTINGS_KEYS.llmParameterPresets);
    presets = raw ? (JSON.parse(raw).presets ?? []) : [];
  } catch {
    presets = [];
  }
  for (const [task, a] of Object.entries(assignments) as [
    LlmTaskId,
    NonNullable<LlmTaskAssignments[LlmTaskId]>,
  ][]) {
    if (a.mode === "auto") continue;
    let key: string | null = null;
    if (a.modelOverride) {
      key = profileLinkKey(a.modelOverride.provider, a.modelOverride.model_id);
    } else {
      const name =
        [...presets, ...BUILTIN_MODEL_PRESETS].find((p) => p.id === a.presetId)
          ?.name ?? "";
      const hit = NAME_HINTS.find(([re]) => re.test(name));
      const def = hit ? MLX_LLM_MODELS.find((m) => m.id === hit[1]) : undefined;
      if (def) key = profileLinkKey(MLX_LLM_PROVIDER_ID, def.id);
    }
    if (!key) {
      log.info(
        `profile link of task ${task} (${a.presetId ?? "custom values"}) has no model; it stays unbound and is ignored`,
      );
      continue;
    }
    (links[key] ??= {})[task] = {
      mode: a.mode,
      ...(a.presetId ? { presetId: a.presetId } : {}),
      ...(a.params ? { params: a.params } : {}),
    };
    log.info(`profile link of task ${task} bound to ${key}`);
  }
  return links;
}

/** The link map. The first read binds the old assignments (once). */
export function readProfileLinks(): LlmProfileLinks {
  if (readSetting(SETTINGS_KEYS.llmProfileLinksMigrated) !== "1") {
    // A database with no old assignment has nothing to bind and writes nothing.
    const old = parseLlmTaskAssignments(
      readSetting(SETTINGS_KEYS.llmTaskAssignments),
    );
    if (!Object.values(old).some((a) => a && a.mode !== "auto")) {
      return parseLlmProfileLinks(readSetting(SETTINGS_KEYS.llmProfileLinks));
    }
    const migrated = migrateOldAssignments();
    writeSetting(SETTINGS_KEYS.llmProfileLinks, JSON.stringify(migrated));
    writeSetting(SETTINGS_KEYS.llmProfileLinksMigrated, "1");
    return migrated;
  }
  return parseLlmProfileLinks(readSetting(SETTINGS_KEYS.llmProfileLinks));
}

function defaultLlmKey(): string | null {
  const row = getDb()
    .prepare(
      "SELECT provider, model_id FROM model_configs WHERE type = 'llm' AND is_default = 1",
    )
    .get() as { provider: string; model_id: string } | undefined;
  return row ? profileLinkKey(row.provider, row.model_id) : null;
}

/** The link key of the model a stored assignment runs on. */
export function assignmentModelKey(
  a: { modelOverride?: { provider: string; model_id: string } } | undefined,
): string | null {
  return a?.modelOverride
    ? profileLinkKey(a.modelOverride.provider, a.modelOverride.model_id)
    : defaultLlmKey();
}

/**
 * Called when the Models page saves `llm_task_assignments`. A task whose
 * profile fields changed, with the same model override as before, links that
 * profile to the model the task runs on. A change of the model override only
 * records the new model: the profile fields of that entry are what the page
 * showed for the old model, and they do not move to the new one.
 */
export function recordAssignmentWrite(nextRaw: string): void {
  const links = readProfileLinks();
  const before = parseLlmTaskAssignments(
    readSetting(SETTINGS_KEYS.llmTaskAssignments),
  );
  const after = parseLlmTaskAssignments(nextRaw);
  let changed = false;
  for (const task of Object.keys(after) as LlmTaskId[]) {
    const next = after[task];
    if (!next) continue;
    const prev = before[task];
    const prevKey = assignmentModelKey(prev);
    const nextKey = assignmentModelKey(next);
    if (!nextKey || prevKey !== nextKey) continue;
    const same =
      (prev?.mode ?? "auto") === next.mode &&
      prev?.presetId === next.presetId &&
      JSON.stringify(prev?.params ?? null) ===
        JSON.stringify(next.params ?? null);
    if (same) continue;
    const slot = (links[nextKey] ??= {});
    if (next.mode === "auto") delete slot[task];
    else {
      slot[task] = {
        mode: next.mode,
        ...(next.presetId ? { presetId: next.presetId } : {}),
        ...(next.params ? { params: next.params } : {}),
      };
    }
    changed = true;
  }
  if (changed)
    writeSetting(SETTINGS_KEYS.llmProfileLinks, JSON.stringify(links));
}
