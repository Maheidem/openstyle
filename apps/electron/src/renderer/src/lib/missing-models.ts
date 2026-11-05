import type {
  LocalModelRef,
  MissingModel,
  ModelMissingTask,
} from "@openstyle/validations";

// Pure helpers for the "model is not downloaded" cue. No React, no i18n.

/** The Models page, open at one model that must be downloaded. */
export function modelsPathFor(
  ref: Pick<LocalModelRef, "engine" | "defId">,
): string {
  return `/settings/models?missing=${encodeURIComponent(`${ref.engine}:${ref.defId}`)}`;
}

/** The `engine:defId` of a `?missing=` parameter, or null. */
export function parseMissingParam(
  value: string | null,
): Pick<LocalModelRef, "engine" | "defId"> | null {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) return null;
  return {
    engine: value.slice(0, at) as LocalModelRef["engine"],
    defId: value.slice(at + 1),
  };
}

/** The missing models that at least one of `tasks` uses. */
export function missingForTasks(
  missing: readonly MissingModel[] | undefined,
  tasks: readonly ModelMissingTask[],
): MissingModel[] {
  return (missing ?? []).filter((m) => m.tasks.some((t) => tasks.includes(t)));
}

/** The first missing model of one task, or undefined. */
export function missingForTask(
  missing: readonly MissingModel[] | undefined,
  task: ModelMissingTask,
): MissingModel | undefined {
  return (missing ?? []).find((m) => m.tasks.includes(task));
}
