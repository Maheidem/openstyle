import { traceLlmFetch } from "../trace.js";

// llama.cpp only: send one chat request as a raw completion with the JSON
// grammar active from the first token.
//
// Why: on /v1/chat/completions, llama.cpp builds the grammar of a strict
// json_schema answer for Gemma 4 as "an optional thought block, then the
// JSON" (common/parsers/gemma4.cpp, build b11594). The text inside a thought
// block is free. Gemma 4 E2B GGUF opens that block even with enable_thinking
// false, never writes the closing token and fills max_tokens: content stays
// empty and the text goes to reasoning_content. A closed empty thought block
// in the prompt does not stop it, and logit_bias has no effect on that path
// (measured 2026-10-22). On /v1/completions the json_schema becomes a plain
// JSON grammar, so the model cannot open a thought block at all.

/** Chat-body keys that /v1/completions does not take or that change here. */
const CHAT_ONLY_KEYS = [
  "messages",
  "response_format",
  "chat_template_kwargs",
  "stream",
  "stream_options",
  "continue_final_message",
  "add_generation_prompt",
  "reasoning_format",
  "tools",
  "tool_choice",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The JSON Schema of the chat body's response_format, else null. */
function schemaOf(body: Record<string, unknown>): unknown {
  const rf = asRecord(body.response_format);
  if (!rf) return null;
  if (rf.type === "json_schema") {
    return asRecord(rf.json_schema)?.schema ?? { type: "object" };
  }
  if (rf.type === "json_object") return { type: "object" };
  return null;
}

/**
 * The server root of a chat URL: `http://h/v1/chat/completions` gives
 * `http://h`. The template endpoint lives at the root, not under /v1.
 */
function rootOf(chatUrl: string): string {
  return chatUrl.replace(/\/v1\/chat\/completions\/?$/, "");
}

async function postJson(
  url: string,
  body: unknown,
  init: RequestInit | undefined,
): Promise<Response> {
  return traceLlmFetch(url, {
    method: "POST",
    headers: init?.headers ?? { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
}

/**
 * Render the prompt with the server's own chat template. A plain
 * llama-server has `/apply-template` at the root; llama-swap only routes it
 * under `/upstream/<model>/`.
 */
async function applyTemplate(
  root: string,
  body: Record<string, unknown>,
  init: RequestInit | undefined,
): Promise<{ prompt: string } | Response> {
  const req = {
    model: body.model,
    messages: body.messages,
    chat_template_kwargs: asRecord(body.chat_template_kwargs) ?? {},
  };
  const model = encodeURIComponent(String(body.model ?? ""));
  let res = await postJson(`${root}/apply-template`, req, init);
  if (res.status === 404) {
    res = await postJson(`${root}/upstream/${model}/apply-template`, req, init);
  }
  if (!res.ok) return res;
  const json = asRecord(await res.json());
  if (typeof json?.prompt !== "string") {
    return new Response(
      JSON.stringify({ error: { message: "apply-template gave no prompt" } }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  return { prompt: json.prompt };
}

/**
 * Send the chat request in `init.body` (already merged) as template +
 * completion, and answer with a chat.completion body that the AI SDK reads.
 * An HTTP error of a step goes back as it is, so the gateway maps it.
 */
export async function llamaCppCompletionFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit & { body: string },
): Promise<Response> {
  const chatUrl = String(input instanceof Request ? input.url : input);
  const chat = asRecord(JSON.parse(init.body));
  if (!chat || !Array.isArray(chat.messages)) {
    return traceLlmFetch(input, init);
  }
  const root = rootOf(chatUrl);
  const tpl = await applyTemplate(root, chat, init);
  if (tpl instanceof Response) return tpl;

  const completion: Record<string, unknown> = { ...chat };
  for (const key of CHAT_ONLY_KEYS) delete completion[key];
  completion.prompt = tpl.prompt;
  const schema = schemaOf(chat);
  if (schema !== null) completion.json_schema = schema;

  const res = await postJson(`${root}/v1/completions`, completion, init);
  if (!res.ok) return res;
  const out = asRecord(await res.json()) ?? {};
  const choice = asRecord(Array.isArray(out.choices) ? out.choices[0] : null);
  return new Response(
    JSON.stringify({
      ...out,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: typeof choice?.text === "string" ? choice.text : "",
          },
          finish_reason: choice?.finish_reason ?? null,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
