import { z } from "zod/v3";

export const configureModelSchema = z.object({
  provider: z.string().min(1, "Provider is required"),
  model_id: z.string().min(1, "Model ID is required"),
  model_name: z.string().min(1, "Model name is required"),
  type: z.enum(["voice", "llm"]),
  is_default: z.boolean().optional(),
});

// Body for POST /whisper/server/start and /mlx-asr/server/start. modelId is
// optional — when omitted the route falls back to the configured default voice.
export const serverStartSchema = z.object({
  modelId: z.string().min(1).optional(),
});
