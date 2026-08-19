import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableFileLogging } from "@openstyle/utils";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createSamplingFetch } from "../src/lib/llm/registry.js";
import {
  currentTraceId,
  redact,
  redactHeaders,
  runInTraceScope,
  traceLlmFetch,
} from "../src/lib/trace.js";

/**
 * The trace log is a real winston File transport, so these tests point it at a
 * temp directory and read the file back. That also proves the sink itself
 * works end to end — `enableFileLogging` resolving the directory, the separate
 * `openstyle-trace.log` file, and the entry format.
 */
let logDir: string;

beforeAll(() => {
  // The shared setup installs fake timers; the polling helper below and
  // winston's write stream both need real ones.
  vi.useRealTimers();
  logDir = mkdtempSync(join(tmpdir(), "openstyle-trace-"));
  enableFileLogging(logDir);
});

afterAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function readTraceFile(): string {
  try {
    return readFileSync(join(logDir, "openstyle-trace.log"), "utf8");
  } catch {
    return "";
  }
}

/** Wait for an entry matching `label` to land, since writes are streamed. */
async function waitForTrace(label: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const text = readTraceFile();
    if (text.includes(label)) return text;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no trace entry containing ${label} after 2s`);
}

/** Swap in a stub `fetch` for the duration of `fn`. */
async function withFetch<T>(
  impl: (url: unknown, init: RequestInit | undefined) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "Qwen3.8-27B",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Hello there.",
        reasoning_content: "thinking about it",
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
};

describe("redact", () => {
  it("replaces Authorization and api_key/apiKey anywhere in the payload", () => {
    expect(
      redact({
        url: "http://127.0.0.1:8123/v1/chat/completions",
        api_key: "sk-secret",
        apiKey: "sk-secret",
        headers: { Authorization: "Bearer sk-secret" },
        nested: [{ deeper: { API_KEY: "sk-secret" } }],
      }),
    ).toEqual({
      url: "http://127.0.0.1:8123/v1/chat/completions",
      api_key: "***",
      apiKey: "***",
      headers: { Authorization: "Bearer ***" },
      nested: [{ deeper: { API_KEY: "***" } }],
    });
  });

  it("leaves transcripts and model output untouched — full bodies are the point", () => {
    const body = {
      messages: [{ role: "user", content: "my transcript, verbatim" }],
      temperature: 0.7,
      chat_template_kwargs: { enable_thinking: true },
    };
    expect(redact(body)).toEqual(body);
  });

  it("survives a circular payload instead of throwing", () => {
    const cyclic: Record<string, unknown> = { api_key: "sk-secret" };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ api_key: "***", self: "[circular]" });
  });
});

describe("redactHeaders", () => {
  // Mixed case on purpose: a `Headers` instance lower-cases for us, the other
  // two shapes do not, and the redaction must not depend on which one arrives.
  it("catches Authorization in all three HeadersInit shapes", () => {
    const expected = {
      authorization: "Bearer ***",
      accept: "application/json",
    };
    expect(
      redactHeaders(
        new Headers({
          Authorization: "Bearer sk-secret",
          Accept: "application/json",
        }),
      ),
    ).toEqual(expected);
    expect(
      redactHeaders([
        ["Authorization", "Bearer sk-secret"],
        ["Accept", "application/json"],
      ]),
    ).toEqual(expected);
    expect(
      redactHeaders({
        Authorization: "Bearer sk-secret",
        Accept: "application/json",
      }),
    ).toEqual(expected);
  });

  it("returns an empty object for no headers", () => {
    expect(redactHeaders(undefined)).toEqual({});
  });
});

describe("correlation id", () => {
  it("shares one id across a scope and reports `-` outside any scope", () => {
    expect(currentTraceId()).toBe("-");
    const [first, second] = runInTraceScope(() => [
      currentTraceId(),
      currentTraceId(),
    ]);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(runInTraceScope(() => currentTraceId())).not.toBe(first);
  });
});

describe("traceLlmFetch response cloning", () => {
  it("hands the caller an intact, unread body while tracing it in full", async () => {
    const res = await withFetch(
      async () =>
        new Response(JSON.stringify(COMPLETION), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        traceLlmFetch("http://127.0.0.1:8123/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer sk-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "Qwen3.8-27B",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
    );

    // The caller's own body must be untouched: not disturbed, fully readable.
    expect(res.bodyUsed).toBe(false);
    expect(await res.json()).toEqual(COMPLETION);

    const trace = await waitForTrace("llm.response");
    expect(trace).toContain(
      "llm.request POST http://127.0.0.1:8123/v1/chat/completions",
    );
    // Request: full body, Authorization redacted.
    expect(trace).toContain('"Qwen3.8-27B"');
    expect(trace).toContain('"authorization": "Bearer ***"');
    expect(trace).not.toContain("sk-secret");
    // Response: status, the full body, and the fields worth scanning for.
    expect(trace).toContain("llm.response status=200 elapsed_ms=");
    expect(trace).toContain('"finish_reason": "stop"');
    expect(trace).toContain('"reasoning_content": "thinking about it"');
    expect(trace).toContain('"total_tokens": 16');
  });

  it("still returns a readable body when the response is not JSON", async () => {
    const res = await withFetch(
      async () =>
        new Response("data: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      () => traceLlmFetch("http://127.0.0.1:8123/v1/chat/completions", {}),
    );
    expect(await res.text()).toBe("data: {}\n\n");
  });

  it("returns the rejection to the caller and traces the failure", async () => {
    const boom = new Error("connect ECONNREFUSED");
    await expect(
      withFetch(
        () => Promise.reject(boom),
        () => traceLlmFetch("http://127.0.0.1:9/v1/chat/completions", {}),
      ),
    ).rejects.toThrow("connect ECONNREFUSED");
    const trace = await waitForTrace("llm.error");
    expect(trace).toContain("connect ECONNREFUSED");
  });
});

describe("oMLX STT boundary", () => {
  it("traces every multipart field but only the audio's byte length", async () => {
    const { getDb } = await import("../src/lib/db.js");
    const { OmlxTranscriptionProvider } = await import(
      "../src/lib/streaming/providers/omlx.js"
    );
    getDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("omlx_base_url", "http://127.0.0.1:8123");

    await withFetch(
      async () =>
        new Response(
          JSON.stringify({ text: "hi", language: "English", duration: 1.1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      () =>
        new OmlxTranscriptionProvider().transcribe({
          audio: new Uint8Array(2048),
          model: "omlx/mlx-community--Qwen3-ASR-1.7B-8bit",
          apiKey: "local",
          language: "en",
          bias: { kind: "prompt", text: "Openstyle, oMLX" },
        }),
    );

    const trace = await waitForTrace("omlx.stt.response");
    expect(trace).toContain("omlx.stt.request POST");
    expect(trace).toContain('"prompt": "Openstyle, oMLX"');
    expect(trace).toContain('"model": "mlx-community--Qwen3-ASR-1.7B-8bit"');
    expect(trace).toContain('"language": "en"');
    // The audio is a size, not 2 KB of inlined PCM.
    expect(trace).toContain('"bytes": 2048');
    expect(trace).toContain('"filename": "a.wav"');
    expect(trace).toContain('"text": "hi"');
  });
});

describe("createSamplingFetch tracing", () => {
  it("traces the post-merge body and leaves the caller's response intact", async () => {
    const wrapped = createSamplingFetch({ top_k: 40, min_p: 0.05 });
    const res = await withFetch(
      async () =>
        new Response(JSON.stringify(COMPLETION), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        wrapped("http://127.0.0.1:8123/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "Qwen3.8-27B", temperature: 0 }),
        }),
    );

    expect(await res.json()).toEqual(COMPLETION);
    const trace = await waitForTrace('"top_k": 40');
    expect(trace).toContain('"min_p": 0.05');
  });

  // The riskiest thing the trace could break: Remix streams through this same
  // fetch, and the clone tees the body. Drive a real `streamText` through the
  // real provider wiring and assert the SDK still assembles the whole stream.
  it("does not break the SDK's consumption of a streamed response", async () => {
    const { getDb } = await import("../src/lib/db.js");
    const { createChatModel } = await import("../src/lib/providers.js");
    const { streamText } = await import("ai");
    getDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("local_llm_url", "http://127.0.0.1:8123");

    const frames = ["Hel", "lo ", "there."].map(
      (delta) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-2",
          object: "chat.completion.chunk",
          created: 0,
          model: "Qwen3.8-27B",
          choices: [{ index: 0, delta: { content: delta } }],
        })}\n\n`,
    );

    const text = await withFetch(
      async () =>
        new Response(`${frames.join("")}data: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      async () => {
        const model = await createChatModel(
          "local-llm",
          "local-llm/Qwen3.8-27B",
        );
        const result = streamText({ model, prompt: "hi" });
        let out = "";
        for await (const chunk of result.textStream) out += chunk;
        return out;
      },
    );

    expect(text).toBe("Hello there.");
    // ...and the trace still captured the raw frames it could not parse as JSON.
    const trace = await waitForTrace("data: [DONE]");
    expect(trace).toContain("body_text");
  });
});
