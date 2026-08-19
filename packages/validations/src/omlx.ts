import { z } from "zod/v3";

/** Body for `POST /api/settings/omlx/test`. */
export const omlxConfigSchema = z.object({
  url: z.string().min(1, "Server URL is required").url("Must be a valid URL"),
  api_key: z.string().optional(),
});

export type OmlxConfigInput = z.infer<typeof omlxConfigSchema>;

export const omlxBaseUrlSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      if (value.trim() === "") return true;
      try {
        const url = new URL(value.trim());
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    {
      message:
        "oMLX server URL must be a valid http:// or https:// URL (or empty to disable)",
    },
  );

/**
 * The single normalizer for the oMLX server URL — reduce whatever the user
 * typed to the server ROOT.
 *
 * Every oMLX URL is derived from this root ({@link omlxModelsUrl},
 * {@link omlxTranscribeUrl}), so the probe and the transcription request can
 * never disagree about where the server lives. `http://127.0.0.1:8123` and
 * `http://127.0.0.1:8123/v1` (and a pasted `.../v1/audio/transcriptions`) all
 * collapse to the same root.
 */
export function normalizeOmlxRoot(input: string): string {
  return input
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1(?:\/[^?#]*)?$/, "");
}

/** Model discovery endpoint for an oMLX root. */
export function omlxModelsUrl(root: string): string {
  return `${root}/v1/models`;
}

/** Batch transcription endpoint for an oMLX root. */
export function omlxTranscribeUrl(root: string): string {
  return `${root}/v1/audio/transcriptions`;
}

/**
 * Shape for the oMLX connect form in the Models page. The URL may be empty
 * (disconnects the server), so it uses the same relaxed schema the server
 * enforces on `PUT /settings/omlx_base_url`.
 */
export const omlxConnectFormSchema = z.object({
  url: omlxBaseUrlSchema,
  apiKey: z.string().max(2048),
});

export type OmlxConnectForm = z.infer<typeof omlxConnectFormSchema>;
