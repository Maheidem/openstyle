import { collapseAsrLineBreaks } from "@openstyle/stt";
import { createAppLogger } from "@openstyle/utils";
import { normalizeOmlxRoot, omlxTranscribeUrl } from "@openstyle/validations";
import { readSetting } from "../../db.js";
import type {
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../types.js";
import { CLOUD_TRANSCRIBE_TIMEOUT_MS, stripProviderPrefix } from "../types.js";

export const OMLX_PROVIDER_ID = "omlx";
export const OMLX_PROVIDER_NAME = "oMLX";
export const OMLX_BASE_URL_SETTING = "omlx_base_url";
export const OMLX_API_KEY_SETTING = "omlx_api_key";

const log = createAppLogger("omlx");

/**
 * Batch transcription against a user-run oMLX server (an MLX inference server
 * the user already has speech models loaded into).
 *
 * Deliberately a direct `fetch` rather than the AI SDK: we own the URL
 * convention, so both the `/v1/models` probe and this request derive from the
 * same {@link normalizeOmlxRoot} root and cannot disagree about the endpoint.
 */
export class OmlxTranscriptionProvider implements TranscriptionProvider {
  readonly providerId = OMLX_PROVIDER_ID;

  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const root = normalizeOmlxRoot(readSetting(OMLX_BASE_URL_SETTING) ?? "");
    if (!root) {
      throw new Error(
        "No oMLX server URL configured — set one under Models → Transcription → On-device.",
      );
    }

    const url = omlxTranscribeUrl(root);
    const form = new FormData();
    // The audio is always ArrayBuffer-backed (it comes from the HTTP body).
    const audio = opts.audio as Uint8Array<ArrayBuffer>;
    form.append("file", new Blob([audio], { type: "audio/wav" }), "a.wav");
    form.append("model", stripProviderPrefix(opts.model));
    form.append("response_format", "json");
    if (opts.language && opts.language !== "auto") {
      form.append("language", opts.language);
    }
    if (opts.bias?.kind === "prompt") {
      form.append("prompt", opts.bias.text);
    }

    // oMLX ignores auth entirely, so the key stays optional — only send the
    // header when the user stored one (e.g. a reverse proxy in front of it).
    const apiKey = (readSetting(OMLX_API_KEY_SETTING) ?? "").trim();

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(CLOUD_TRANSCRIBE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `oMLX server unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 404) {
        throw new Error(
          `oMLX has no transcription endpoint at ${url} — check the server URL.`,
        );
      }
      throw new Error(
        `oMLX transcription failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`,
      );
    }

    const data = (await res.json().catch(() => null)) as {
      text?: string;
    } | null;
    if (typeof data?.text !== "string") {
      throw new Error("oMLX returned no transcript — is this an ASR model?");
    }

    log.debug(`inference took ${Date.now() - t0}ms`);

    return { text: collapseAsrLineBreaks(data.text).trim() };
  }

  /** Batch only — the whole clip is transcribed, then handed to cleanup. */
  supportsStreaming(_modelId: string): boolean {
    return false;
  }
}
