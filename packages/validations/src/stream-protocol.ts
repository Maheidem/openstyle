/**
 * Types for the JSON messages on the `/api/stream` WebSocket.
 * The server (`apps/server/src/routes/stream.ts`) and the renderer
 * (`apps/electron/src/renderer/src/lib/streamer.ts`) share them.
 * This file has types only. It adds no code to any bundle.
 * Audio frames are binary and are not part of these types.
 */

/** Messages that the renderer sends to the server. */
export type StreamClientMessage =
  | {
      type: "start";
      context: string | null;
      /** Language pin from a language hotkey. Null for the default hotkey. */
      language: string | null;
    }
  | { type: "context"; context: string | null }
  | {
      type: "commit";
      audioDurationMs: number;
      context: string | null;
    }
  | { type: "cancel" };

/** Messages that the server sends to the renderer. */
export type StreamServerMessage =
  | {
      type: "config";
      model: string;
      streaming: boolean;
      sessionTransport: boolean;
      /** Absent when the server resends the config after an upstream error. */
      providerCategory?: "local" | "byok";
    }
  | { type: "session.ready"; model: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string; code?: string };
