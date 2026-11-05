import type { LocalModelRef } from "@openstyle/validations";

// Dictation cleanup keeps the raw text when its model is not on the disk. The
// server cannot show a message. A host (the desktop app) listens here and tells
// the user. No listener: the skip is only logged and saved in the history row.

type CleanupSkippedListener = (model: LocalModelRef) => void;

const listeners = new Set<CleanupSkippedListener>();

/** Listen for a cleanup that was skipped because its model is missing. */
export function onCleanupSkipped(listener: CleanupSkippedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitCleanupSkipped(model: LocalModelRef): void {
  for (const listener of listeners) {
    try {
      listener(model);
    } catch {
      // A broken listener must not break a dictation.
    }
  }
}
