import type {
  LlmParameterPreset,
  LlmTaskAssignment,
  LlmTaskAssignments,
  LlmTaskId,
} from "@openstyle/validations";
import {
  BUILTIN_LLM_PRESET_IDS,
  LLM_PRESET_COUNT_MAX,
  LLM_PRESET_NAME_MAX,
  LLM_PRESET_PARAMS_MAX_BYTES,
  LLM_TASK_IDS,
  llmParameterPresetsSettingSchema,
} from "@openstyle/validations";

// ---------------------------------------------------------------------------
// preset-ops — the pure data half of preset management (edit / rename /
// duplicate / delete) on the Models page (specs/llm-task-profiles.md §4,
// §5, §9.3). No React, no network, no i18n: every function here takes plain
// data and returns plain data, so the sharp edges of this feature — the
// dangling-`presetId` rewrite (§11) and the ROUTE's write-time limits (§4.3)
// — are the part we can actually test (`preset-ops.test.ts`, node env, no
// jsdom). The component layer (`task-profiles-section.tsx`) and the write
// layer (`use-models.ts`) are thin shells over these.
// ---------------------------------------------------------------------------

/** Make a storable id. The `/^user_/` prefix is enforced server-side
 *  (`llmParameterPresetSchema.id`, §4.1) — it is what stops a client from
 *  writing a preset that spoofs a `builtin:*` id, so id construction lives
 *  next to the rule instead of being spelled out at each call site. */
export function makePresetId(uuid: string): string {
  return `user_${uuid}`;
}

/** True for the two code constants merged in at read time (§4.2). Built-ins
 *  are never stored — there is nothing to delete — so the UI must not offer
 *  Delete for them, and must auto-copy before Edit/Rename. */
export function isBuiltinPresetId(id: string): boolean {
  return BUILTIN_LLM_PRESET_IDS.has(id);
}

/** Deep copy of a preset payload. `params` is JSON by construction (§4.3:
 *  "validated as JSON object, nothing else"), so a JSON round-trip is a
 *  complete and faithful clone — nested objects like `chat_template_kwargs`
 *  never alias the source. */
export function clonePresetParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
}

/** Clamp a display name to the bound (§4.1) without an ellipsis — trailing
 *  whitespace from a mid-word cut is trimmed so the UI never shows a name
 *  with a dangling space. */
export function clampPresetName(name: string): string {
  if (name.length <= LLM_PRESET_NAME_MAX) return name;
  return name.slice(0, LLM_PRESET_NAME_MAX).trimEnd();
}

/** Replace the preset with the same id, or append. Order of the rest is
 *  preserved and ids are never duplicated — the stored blob is a list the
 *  segmented control renders directly (§9.3), so a duplicate id would render
 *  two identical options. */
export function upsertPreset(
  presets: readonly LlmParameterPreset[],
  preset: LlmParameterPreset,
): LlmParameterPreset[] {
  const index = presets.findIndex((p) => p.id === preset.id);
  if (index === -1) return [...presets, preset];
  const next = [...presets];
  next[index] = preset;
  return next;
}

/**
 * Copy a preset (built-in or user's own) into a new storable `user_*`
 * preset. `copyName` is composed by the CALLER (`t("…presetCopyName",
 * { name })`) so no English literal lives in this module; it is clamped to
 * `LLM_PRESET_NAME_MAX` here because a `<60-char name> + " copy"` is exactly
 * the arithmetic that overflows the §4.1 bound.
 *
 * `createdAt` AND `updatedAt` are both set to the injected `now`: the server
 * never writes `updatedAt` (settings.ts persists the blob verbatim), so a
 * write path that omits it silently lies about the row's age.
 */
export function duplicatePreset(
  presets: readonly LlmParameterPreset[],
  source: LlmParameterPreset,
  newId: string,
  options: { now: string; copyName: string },
): { presets: LlmParameterPreset[]; copy: LlmParameterPreset } {
  const copy: LlmParameterPreset = {
    id: newId,
    name: clampPresetName(options.copyName),
    params: clonePresetParams(source.params),
    createdAt: options.now,
    updatedAt: options.now,
  };
  return { presets: upsertPreset(presets, copy), copy };
}

/** The task ids currently pinned to `presetId` (§5.1). Read-only — this is
 *  what builds the delete confirm text so the dialog can NAME the affected
 *  tasks before anything is written (§9.3, decision: confirm first). */
export function tasksUsingPreset(
  assignments: LlmTaskAssignments,
  presetId: string,
): LlmTaskId[] {
  const tasks: LlmTaskId[] = [];
  for (const taskId of LLM_TASK_IDS) {
    const assignment = assignments[taskId];
    if (assignment?.mode === "preset" && assignment.presetId === presetId) {
      tasks.push(taskId);
    }
  }
  return tasks;
}

/**
 * Delete one preset AND re-point every task that used it at `auto`, in one
 * pure step (§11). The rewrite preserves each touched task's `modelOverride`
 * (§6.3) — deleting a preset says nothing about which model the user chose —
 * and drops `presetId` with it, since a `mode: "auto"` entry carrying a
 * stale `presetId` is precisely the dangling reference this exists to make
 * structurally impossible. Untouched assignments keep their object identity,
 * so `Object.is` proves nothing else moved.
 *
 * The server would survive the dangling id anyway (`resolveModeParams`
 * warns and falls back to auto, §8.3 — `llm-task-profiles.test.ts:288-302`),
 * but the UI cannot render an honest chip for it; not storing one is the
 * cheaper guarantee.
 */
export function removePresetAndReassign(
  presets: readonly LlmParameterPreset[],
  assignments: LlmTaskAssignments,
  presetId: string,
): {
  presets: LlmParameterPreset[];
  assignments: LlmTaskAssignments;
  reassignedTaskIds: LlmTaskId[];
} {
  const nextAssignments: LlmTaskAssignments = { ...assignments };
  const reassignedTaskIds: LlmTaskId[] = [];

  for (const taskId of tasksUsingPreset(assignments, presetId)) {
    const current = nextAssignments[taskId];
    nextAssignments[taskId] = current?.modelOverride
      ? { mode: "auto", modelOverride: current.modelOverride }
      : { mode: "auto" };
    reassignedTaskIds.push(taskId);
  }

  return {
    presets: presets.filter((p) => p.id !== presetId),
    assignments: nextAssignments,
    reassignedTaskIds,
  };
}

/** Ids assigned by some task that no longer resolve in the merged
 *  built-ins + user list (§4.2's merge). Normally empty — `removePresetAndReassign`
 *  keeps it that way; a non-empty result means the row predates that
 *  guarantee (hand-edited settings, a downgrade, a half-completed write),
 *  which is the state the UI must label instead of printing a raw uuid. */
export function findMissingPresetIds(
  assignments: LlmTaskAssignments,
  mergedPresets: readonly LlmParameterPreset[],
): string[] {
  const known = new Set(mergedPresets.map((p) => p.id));
  const missing: string[] = [];
  for (const taskId of LLM_TASK_IDS) {
    const assignment = assignments[taskId];
    if (assignment?.mode !== "preset" || !assignment.presetId) continue;
    if (
      !known.has(assignment.presetId) &&
      !missing.includes(assignment.presetId)
    ) {
      missing.push(assignment.presetId);
    }
  }
  return missing;
}

/** Per-task form of the same check, used by `TaskRow` to decide between the
 *  preset chip and the explicit "no longer available" state. */
export function isDanglingAssignment(
  assignment: LlmTaskAssignment,
  mergedPresets: readonly LlmParameterPreset[],
): boolean {
  if (assignment.mode !== "preset" || !assignment.presetId) return false;
  return !mergedPresets.some((p) => p.id === assignment.presetId);
}

/**
 * Why a write of the whole presets array would be rejected. Mirrors the
 * ROUTE's rules in the ROUTE's order (§4.3, `settings.ts:208-224`) — the
 * zod schema first (id/name/shape/count), then the per-preset params byte cap
 * the route applies in its own loop — so the user gets an inline message
 * instead of a bare 400. Deliberately reuses `llmParameterPresetsSettingSchema`
 * rather than re-deriving the rules: two hand-written copies of a bound are
 * how a client starts sending what its own server 400s.
 */
export type PresetWriteIssue =
  | { kind: "countMax"; max: number }
  | { kind: "invalidId"; presetId: string }
  | { kind: "invalidName"; presetId: string }
  | { kind: "tooLarge"; presetId: string; name: string; max: number }
  | { kind: "invalidBlob" };

export function checkPresetWrite(
  presets: readonly LlmParameterPreset[],
): PresetWriteIssue | null {
  const parsed = llmParameterPresetsSettingSchema.safeParse({ presets });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path ?? [];
    if (path[0] !== "presets") return { kind: "invalidBlob" };
    const offender = presets[path[1] as number];
    const presetId = offender?.id ?? "";
    if (issue?.code === "too_big" && path.length === 1) {
      return { kind: "countMax", max: LLM_PRESET_COUNT_MAX };
    }
    if (path[2] === "id") return { kind: "invalidId", presetId };
    if (path[2] === "name") return { kind: "invalidName", presetId };
    return { kind: "invalidBlob" };
  }

  for (const preset of parsed.data.presets) {
    if (JSON.stringify(preset.params).length > LLM_PRESET_PARAMS_MAX_BYTES) {
      return {
        kind: "tooLarge",
        presetId: preset.id,
        name: preset.name,
        max: LLM_PRESET_PARAMS_MAX_BYTES,
      };
    }
  }
  return null;
}
