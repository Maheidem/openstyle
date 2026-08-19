import { z } from "zod/v3";

// Crash/error reports from the renderer. Only message/stack/source/context are
// accepted — callers must never include transcript or clipboard text.
export const clientErrorSchema = z.object({
  message: z.string().min(1, "message required"),
  stack: z.string().optional(),
  source: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});

export type ClientErrorInput = z.infer<typeof clientErrorSchema>;
