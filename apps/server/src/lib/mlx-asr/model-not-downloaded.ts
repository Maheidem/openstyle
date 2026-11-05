import type { LocalModelRef } from "@openstyle/validations";

/**
 * A local model is selected for a task, but its files are not on the disk.
 * Typed, so every caller can show a clear cue and not an "internal error"
 * (`modelUnavailableFrom` maps it to the gateway kind `model_missing`). The
 * message has no user text.
 */
export class ModelNotDownloadedError extends Error {
  readonly code = "model-not-downloaded";
  readonly model: LocalModelRef;

  constructor(model: LocalModelRef, message?: string) {
    super(
      message ??
        `The local model ${model.name} is not downloaded. Download it under Models.`,
    );
    this.name = "ModelNotDownloadedError";
    this.model = model;
  }
}

export function isModelNotDownloadedError(
  err: unknown,
): err is ModelNotDownloadedError {
  return (
    err instanceof ModelNotDownloadedError ||
    (err as { code?: unknown } | null)?.code === "model-not-downloaded"
  );
}
