import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { traceLog } from "@openstyle/utils";

/**
 * Raw request/response tracing for the two boundaries a dictation crosses: the
 * STT call and the cleanup/Remix LLM call. Entries go to
 * `<logs>/openstyle-trace.log` (see `traceLog`), never to `openstyle.log`.
 *
 * Always on, and structurally incapable of breaking a dictation: every public
 * entry point swallows its own errors, the log sink is a non-blocking write
 * stream, and response bodies are read off a clone so the caller's body is
 * never touched.
 *
 * Format — one entry per logical step, a greppable header line followed by the
 * pretty-printed JSON payload:
 *
 * ```
 * 17:41:02.311 [a1b2c3d4] omlx.stt.request POST http://127.0.0.1:8123/...
 * {
 *   "fields": { ... }
 * }
 * ```
 *
 * Pretty-printed rather than single-line because the payloads are prompts,
 * transcripts and model output: a one-line body is unreadable when tailing.
 */

/** Keys whose values are replaced before anything is written. */
const AUTHORIZATION_KEY = /^authorization$/i;
const API_KEY_KEY = /^api[_-]?key$/i;

const REDACTED_AUTHORIZATION = "Bearer ***";
const REDACTED_VALUE = "***";

/** Guard against a pathological payload turning one entry into a hang. */
const MAX_REDACT_DEPTH = 12;

function redactKey(key: string): string | null {
  if (AUTHORIZATION_KEY.test(key)) return REDACTED_AUTHORIZATION;
  if (API_KEY_KEY.test(key)) return REDACTED_VALUE;
  return null;
}

/**
 * Deep-copy `value`, replacing every `Authorization` / `api_key` / `apiKey`
 * value with a placeholder. Nothing else is touched: transcripts, prompts and
 * model output are traced in full, deliberately.
 */
export function redact(
  value: unknown,
  depth = 0,
  // Ancestors of the current node, not everything visited: an object that
  // legitimately appears twice in different branches (a chat completion's
  // `usage` echoed into a summary, say) is not a cycle and must still be
  // rendered, so entries are removed again on the way back up.
  ancestors = new WeakSet<object>(),
): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[max depth]";
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);

  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => redact(item, depth + 1, ancestors));
  } else {
    const object: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const replacement = redactKey(key);
      object[key] = replacement ?? redact(item, depth + 1, ancestors);
    }
    out = object;
  }

  ancestors.delete(value);
  return out;
}

/**
 * Normalise the three shapes `HeadersInit` can take (a `Headers` instance, an
 * array of tuples, a plain object) into a redacted plain object, so the
 * `Authorization` header is caught whichever shape the caller used. Names are
 * lower-cased — they are case-insensitive on the wire, and a `Headers`
 * instance has already lower-cased them, so this keeps the log greppable.
 */
export function redactHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const put = (rawKey: string, value: string): void => {
    const key = rawKey.toLowerCase();
    out[key] = redactKey(key) ?? value;
  };
  try {
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        put(key, value);
      });
    } else if (Array.isArray(headers)) {
      for (const [key, value] of headers) put(String(key), String(value));
    } else {
      for (const [key, value] of Object.entries(headers)) {
        put(key, String(value));
      }
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Per-dictation correlation id. Seeded by a Hono middleware so every trace
 * entry written while serving one request — the STT call and the cleanup LLM
 * call both happen inside `POST /api/transcribe` — carries the same short id.
 *
 * The id is materialised lazily: a request that never traces anything (most of
 * them) pays nothing for the scope.
 */
const scope = new AsyncLocalStorage<{ id: string | null }>();

/** Run `fn` inside a fresh correlation scope. */
export function runInTraceScope<T>(fn: () => T): T {
  return scope.run({ id: null }, fn);
}

/** The current correlation id, or `-` outside any scope. */
export function currentTraceId(): string {
  const holder = scope.getStore();
  if (!holder) return "-";
  if (!holder.id) holder.id = randomUUID().slice(0, 8);
  return holder.id;
}

function stringify(payload: unknown): string {
  try {
    return JSON.stringify(redact(payload), null, 2) ?? String(payload);
  } catch {
    return `"[unserializable: ${String(payload)}]"`;
  }
}

/** Write one entry under an explicit correlation id. */
export function writeTrace(
  id: string,
  label: string,
  headline: string,
  payload: unknown,
): void {
  try {
    traceLog(`[${id}] ${label} ${headline}\n${stringify(payload)}`);
  } catch {
    // Tracing must never break a dictation.
  }
}

/** Write one entry under the ambient correlation id. */
export function trace(label: string, headline: string, payload: unknown): void {
  writeTrace(currentTraceId(), label, headline, payload);
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function parseJson(text: string): { json: unknown } | null {
  try {
    return { json: JSON.parse(text) };
  } catch {
    return null;
  }
}

/**
 * The fields worth having at a glance when tailing a cleanup response. They are
 * all present in `body` too — this is a reading aid, not a filter.
 */
function summarizeCompletion(
  body: unknown,
): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const choice = (body as { choices?: unknown[] }).choices?.[0] as
    | {
        finish_reason?: unknown;
        message?: { reasoning_content?: unknown; content?: unknown };
      }
    | undefined;
  const usage = (body as { usage?: unknown }).usage;
  if (!choice && usage === undefined) return undefined;
  const reasoning = choice?.message?.reasoning_content;
  return {
    finish_reason: choice?.finish_reason ?? null,
    ...(typeof reasoning === "string"
      ? { reasoning_content_chars: reasoning.length }
      : {}),
    usage: usage ?? null,
  };
}

function traceLlmResponse(
  id: string,
  url: string,
  startedAt: number,
  res: Response,
): void {
  let clone: Response;
  try {
    // Clone *before* returning to the caller, and read only the clone: the
    // caller's response body is left completely untouched.
    clone = res.clone();
  } catch (err) {
    writeTrace(id, "llm.response", `status=${res.status} ${url}`, {
      note: `body not captured: ${String(err)}`,
    });
    return;
  }
  // Detached on purpose. If the caller aborts and never drains its half of the
  // tee this read never settles, and the entry is simply missing — which is
  // strictly better than blocking or failing the request.
  void clone.text().then(
    (text) => {
      const parsed = parseJson(text);
      const summary = parsed ? summarizeCompletion(parsed.json) : undefined;
      writeTrace(
        id,
        "llm.response",
        `status=${res.status} elapsed_ms=${Date.now() - startedAt} ${url}`,
        {
          status: res.status,
          headers: redactHeaders(res.headers),
          ...(summary ? { summary } : {}),
          // Non-JSON bodies (a `streamText` SSE stream, an upstream error page)
          // are traced verbatim rather than dropped.
          ...(parsed ? { body: parsed.json } : { body_text: text }),
        },
      );
    },
    (err: unknown) => {
      writeTrace(id, "llm.response", `status=${res.status} ${url}`, {
        note: `body read failed: ${String(err)}`,
      });
    },
  );
}

/**
 * Trace one chat-completions call and hand the caller back the untouched
 * `Response`. Installed as the `fetch` of the `local-llm` provider, so it sees
 * the body exactly as it goes on the wire — after the sampling merge.
 */
export function traceLlmFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> {
  let id = "-";
  let url = "";
  try {
    id = currentTraceId();
    url = requestUrl(input);
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const parsed = bodyText !== undefined ? parseJson(bodyText) : null;
    writeTrace(id, "llm.request", `${init?.method ?? "POST"} ${url}`, {
      url,
      method: init?.method ?? "POST",
      headers: redactHeaders(init?.headers),
      ...(parsed
        ? { body: parsed.json }
        : bodyText !== undefined
          ? { body_text: bodyText }
          : {}),
    });
  } catch {
    // Tracing the request failed; the request itself still goes out below.
  }

  // Exactly one `fetch`, outside every try/catch above, so no tracing failure
  // can skip it or send it twice.
  const startedAt = Date.now();
  const pending = fetch(input, init);
  try {
    // A second consumer of `pending`, not a replacement: the caller still gets
    // the original promise, and this branch also absorbs the rejection so a
    // failed request never surfaces as an unhandled rejection here.
    pending.then(
      (res) => traceLlmResponse(id, url, startedAt, res),
      (err: unknown) =>
        writeTrace(
          id,
          "llm.error",
          `elapsed_ms=${Date.now() - startedAt} ${url}`,
          { error: String(err) },
        ),
    );
  } catch {
    // Never at the caller's expense.
  }
  return pending;
}
