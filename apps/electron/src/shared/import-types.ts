// Import-audio result type shared by the main process and the preload bridge.
// This file has no runtime code. Use `import type` to read it.

/** Result of an import-audio upload (`POST /api/transcribe/file`). */
export type ImportAudioResult =
  | {
      ok: true;
      raw: string;
      cleaned: string;
      model: string;
      audioDurationMs?: number;
      durationMs?: number;
    }
  | {
      ok: false;
      status?: number;
      error: string;
      detail?: string;
      code?: string;
      reason?: string;
    };
