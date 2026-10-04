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

// Body for POST /mlx-asr/custom-models and /mlx-asr/custom-models/validate.
// The server checks the shape (URL or org/name). This schema only bounds it.
export const addCustomMlxModelSchema = z.object({
  model: z.string().trim().min(1).max(300),
});

// Query for GET /mlx-asr/search.
export const mlxSearchQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
});
