// A local model that a task needs is not on the disk. Shared by the server
// (typed error, status route) and the renderer (cue, Enhance card action).

/** Which on-device engine runs the model. The values match the Models page. */
export const LOCAL_MODEL_ENGINES = [
  "mlx-llm",
  "mlx",
  "mlx-embed",
  "mlx-rerank",
  "whisper",
] as const;
export type LocalModelEngine = (typeof LOCAL_MODEL_ENGINES)[number];

/** The tasks that can need a model that is not on the disk. */
export const MODEL_MISSING_TASKS = [
  "dictation",
  "meetingTranscribe",
  "cleanup",
  "meetingEnhance",
  "meetingSummarize",
  "ask",
  "search",
] as const;
export type ModelMissingTask = (typeof MODEL_MISSING_TASKS)[number];

/** One local model and the catalog id that the Models page uses for it. */
export interface LocalModelRef {
  engine: LocalModelEngine;
  /** The catalog id (`gemma-4-e2b-qat-4bit`), not the Hugging Face id. */
  defId: string;
  /** The name a person reads (`Gemma 4 E2B`). */
  name: string;
}

/** One selected model that is not on the disk, with the tasks that use it. */
export interface MissingModel extends LocalModelRef {
  tasks: ModelMissingTask[];
}

const DETAIL_TAG = "model_missing";

/**
 * The text that a failed run step stores as `error_detail` when its model is
 * not on the disk. The renderer reads the model back from it with
 * `parseModelMissingDetail`.
 */
export function formatModelMissingDetail(ref: LocalModelRef): string {
  return [DETAIL_TAG, ref.engine, ref.defId, ref.name].join("|");
}

/** The model named by `formatModelMissingDetail`, or null for any other text. */
export function parseModelMissingDetail(
  detail: string | null | undefined,
): LocalModelRef | null {
  if (!detail) return null;
  const [tag, engine, defId, ...name] = detail.split("|");
  if (tag !== DETAIL_TAG || !defId || name.length === 0) return null;
  if (!(LOCAL_MODEL_ENGINES as readonly string[]).includes(engine ?? "")) {
    return null;
  }
  return {
    engine: engine as LocalModelEngine,
    defId,
    name: name.join("|"),
  };
}
