import { collapseAsrLineBreaks } from "@openstyle/stt";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  normalizeOmlxRoot,
  omlxTranscribeUrl,
  parseServerModelId,
  SERVER_PROVIDER_ID,
} from "@openstyle/validations";
import { getOwnServer } from "../../own-servers.js";
import { redactHeaders, trace } from "../../trace.js";
import type {
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../types.js";
import { CLOUD_TRANSCRIBE_TIMEOUT_MS } from "../types.js";

const log = createAppLogger("server-stt");

/**
 * Every multipart field as it goes on the wire, with the audio reduced to its
 * byte length — the point of the trace is the vocabulary `prompt`, `model` and
 * `language`, and inlining megabytes of PCM would make the file useless.
 */
function traceableFields(form: FormData): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
      continue;
    }
    fields[key] = {
      filename: value.name,
      type: value.type,
      bytes: value.size,
    };
  }
  return fields;
}

/**
 * Batch transcription against a server the user runs (oMLX, vLLM, LiteLLM, or
 * any OpenAI-compatible address). The configured model id is
 * `server/<serverId>/<model>`. The server row holds the address and the key.
 *
 * Deliberately a direct `fetch` rather than the AI SDK: we own the URL
 * convention, so both the `/v1/models` probe and this request derive from the
 * same {@link normalizeOmlxRoot} root and cannot disagree about the endpoint.
 * It also sends the vocabulary `prompt` field itself. The AI SDK path passes
 * that field for `openai` and `groq` only.
 */
export class ServerTranscriptionProvider implements TranscriptionProvider {
  readonly providerId = SERVER_PROVIDER_ID;

  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const target = parseServerModelId(opts.model);
    const server = target ? getOwnServer(target.serverId) : null;
    const root = normalizeOmlxRoot(server?.base_url ?? "");
    if (!target || !server || !root) {
      throw new Error(
        "This server is not in your list any more. Add it again under Models, then pick a model.",
      );
    }

    const url = omlxTranscribeUrl(root);
    const form = new FormData();
    // The audio is always ArrayBuffer-backed (it comes from the HTTP body).
    const audio = opts.audio as Uint8Array<ArrayBuffer>;
    form.append("file", new Blob([audio], { type: "audio/wav" }), "a.wav");
    form.append("model", target.model);
    form.append("response_format", "json");
    if (opts.language && opts.language !== "auto") {
      form.append("language", opts.language);
    }
    if (opts.bias?.kind === "prompt") {
      form.append("prompt", opts.bias.text);
    }

    // The key is optional. Send the header only when the user stored one.
    const apiKey = (server.api_key ?? "").trim();

    const headers: Record<string, string> = apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : {};

    trace("server.stt.request", `POST ${url}`, {
      url,
      method: "POST",
      headers: redactHeaders(headers),
      fields: traceableFields(form),
    });

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(CLOUD_TRANSCRIBE_TIMEOUT_MS),
      });
    } catch (err) {
      trace("server.stt.error", `elapsed_ms=${Date.now() - t0} ${url}`, {
        error: errorMessage(err),
      });
      throw new Error(`Server unreachable at ${url}: ${errorMessage(err)}`);
    }

    // Read the body once, up front, so the trace carries the full payload on
    // both the success and the error path (the error path used to re-read it).
    const bodyText = await res.text().catch(() => "");
    let data: { text?: string } | null = null;
    try {
      data = JSON.parse(bodyText) as { text?: string };
    } catch {
      data = null;
    }

    trace(
      "server.stt.response",
      `status=${res.status} elapsed_ms=${Date.now() - t0} ${url}`,
      {
        status: res.status,
        headers: redactHeaders(res.headers),
        ...(data !== null ? { body: data } : { body_text: bodyText }),
      },
    );

    if (!res.ok) {
      const detail = bodyText.slice(0, 300);
      if (res.status === 404) {
        throw new Error(
          `Server has no transcription endpoint at ${url}. Check that it supports speech-to-text.`,
        );
      }
      throw new Error(
        `Server transcription failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`,
      );
    }

    if (typeof data?.text !== "string") {
      throw new Error(
        "Server returned no transcript. This model may not be a speech-to-text model.",
      );
    }

    log.debug(`inference took ${Date.now() - t0}ms`);

    return { text: collapseAsrLineBreaks(data.text).trim() };
  }

  /** Batch only — the whole clip is transcribed, then handed to cleanup. */
  supportsStreaming(_modelId: string): boolean {
    return false;
  }
}
