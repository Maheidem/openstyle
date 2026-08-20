import type { OutputMode } from "./output.js";

/**
 * The kinds of events emitted across the Openstyle dictation pipeline. A const
 * object (not a TS `enum`) so it has both a runtime value and a derived type,
 * stays tree-shakeable, and matches the convention used elsewhere in the
 * workspace (see {@link OutputMode}). Plugins may match either the constant
 * (`OpenstyleEventType.Transcribed`) or the literal (`"transcribed"`).
 */
export const OpenstyleEventType = {
  RecordingStarted: "recordingStarted",
  RecordingCommitted: "recordingCommitted",
  RecordingCancelled: "recordingCancelled",
  Transcribed: "transcribed",
  Cleaned: "cleaned",
  OutputDelivered: "outputDelivered",
  PipelineError: "pipelineError",
} as const;

export type OpenstyleEventType =
  (typeof OpenstyleEventType)[keyof typeof OpenstyleEventType];

/**
 * The pipeline stage a {@link OpenstyleEventType.PipelineError} occurred in.
 * A const object for the same reasons as {@link OpenstyleEventType}.
 */
export const PipelineStage = {
  Capture: "capture",
  Transcribe: "transcribe",
  Cleanup: "cleanup",
  Transform: "transform",
  Output: "output",
} as const;

export type PipelineStage = (typeof PipelineStage)[keyof typeof PipelineStage];

/**
 * Discriminated union of events emitted across the Openstyle dictation
 * pipeline. Plugins observe these through the read-only `event` hook; they
 * cannot influence behavior here — use the mutating hooks for that.
 *
 * Each event type is emitted by exactly one process — `recording*` and
 * `output*` fire in the Electron main process; `transcribed`/`cleaned` fire in
 * the server — so an `event` handler is delivered each event exactly once even
 * when the plugin is loaded in both processes.
 */
export type OpenstyleEvent =
  | { type: typeof OpenstyleEventType.RecordingStarted }
  | { type: typeof OpenstyleEventType.RecordingCommitted }
  | { type: typeof OpenstyleEventType.RecordingCancelled }
  | {
      type: typeof OpenstyleEventType.Transcribed;
      text: string;
      durationInSeconds?: number;
    }
  | { type: typeof OpenstyleEventType.Cleaned; before: string; after: string }
  | {
      type: typeof OpenstyleEventType.OutputDelivered;
      text: string;
      mode: OutputMode;
    }
  | {
      type: typeof OpenstyleEventType.PipelineError;
      stage: PipelineStage;
      message: string;
    };

/**
 * Best-effort description of the application the user was dictating into,
 * captured per-recording. Used for app-aware logic in hooks. Every field is
 * optional because OS introspection can fail or be unavailable.
 */
export interface AppContext {
  appName?: string;
  windowTitle?: string;
  url?: string;
  bundleId?: string;
}
