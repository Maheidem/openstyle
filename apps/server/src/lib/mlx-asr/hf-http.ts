/**
 * The Hugging Face HTTP rules for the custom model code (specs/custom-mlx-models.md
 * sections 7 and 14): only huggingface.co over https, no token, a timeout on
 * every request, and a limit on the size of every body.
 */

export const HF_HOST = "huggingface.co";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type CustomModelErrorCode =
  | "invalid_input"
  | "offline"
  | "hf_error"
  | "not_found"
  | "gated"
  | "no_config"
  | "unsupported_family"
  | "not_transcriber"
  | "remote_code"
  | "no_weights"
  | "missing_files"
  | "too_large"
  | "no_disk"
  | "already_added";

type CustomModelErrorStatus = 400 | 404 | 409 | 422 | 502 | 503;

const ERROR_STATUS: Record<CustomModelErrorCode, CustomModelErrorStatus> = {
  invalid_input: 400,
  not_found: 404,
  already_added: 409,
  offline: 503,
  hf_error: 502,
  gated: 422,
  no_config: 422,
  unsupported_family: 422,
  not_transcriber: 422,
  remote_code: 422,
  no_weights: 422,
  missing_files: 422,
  too_large: 422,
  no_disk: 422,
};

/**
 * A failed validation or search. The renderer maps `code` to text, so the
 * message is for logs only. `extra` carries the values a text needs.
 */
export class CustomModelError extends Error {
  readonly status: CustomModelErrorStatus;

  constructor(
    readonly code: CustomModelErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CustomModelError";
    this.status = ERROR_STATUS[code];
  }
}

/**
 * GET with a timeout. Redirects are followed by hand, and only to
 * huggingface.co over https, for at most 3 hops. `signal` also stops the
 * request, for a caller that can be cancelled.
 */
export async function hfGet(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new CustomModelError("hf_error", "Hugging Face timed out");
      }
      throw new CustomModelError("offline", "Cannot reach Hugging Face");
    }
    if (!REDIRECT_STATUSES.has(res.status)) return res;

    await res.body?.cancel();
    const location = res.headers.get("location");
    const next = location ? new URL(location, current) : null;
    if (!next || next.protocol !== "https:" || next.hostname !== HF_HOST) {
      throw new CustomModelError("hf_error", "Unexpected redirect");
    }
    current = next.href;
  }
  throw new CustomModelError("hf_error", "Too many redirects");
}

/** The body of a response, read with a size limit. */
export async function readBody(
  res: Response,
  maxBytes: number,
): Promise<Buffer> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    // The request timeout also covers the body. A stalled body is a timeout.
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new CustomModelError("hf_error", "Hugging Face timed out");
      }
      throw new CustomModelError("offline", "Cannot reach Hugging Face");
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CustomModelError("hf_error", "Response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
