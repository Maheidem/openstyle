import { z } from "zod/v3";
import { httpUrlOrEmpty } from "./http-url-or-empty.js";

export const openaiSttConfigSchema = z.object({
  url: z.string().min(1, "Endpoint URL is required").url("Must be a valid URL"),
  api_key: z.string().optional(),
});

export type OpenaiSttConfigInput = z.infer<typeof openaiSttConfigSchema>;

export const openaiSttBaseUrlSchema = httpUrlOrEmpty(
  ["http:", "https:"],
  "OpenAI STT base URL must be a valid http:// or https:// URL (or empty to disable)",
);

export function sanitizeSttBaseUrl(input: string): string | undefined {
  const trimmed = input.trim().replace(/\/+$/, "");
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Shape for the STT connect form in the Models page. The URL may be empty
 * (disables the custom endpoint), so it uses the same relaxed schema the
 * server enforces on `PUT /settings/openai_stt_base_url`.
 */
export const openaiSttConnectFormSchema = z.object({
  url: openaiSttBaseUrlSchema,
  apiKey: z.string().max(2048),
});

export type OpenaiSttConnectForm = z.infer<typeof openaiSttConnectFormSchema>;

/** Shared shape for both endpoint connect forms (local LLM + custom STT). */
export type EndpointConnectFormValues = { url: string; apiKey: string };
