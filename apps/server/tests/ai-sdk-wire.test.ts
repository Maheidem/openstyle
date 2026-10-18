// Wire-body tests for the AI SDK (specs/meeting-enhance-agentic.md 6.9.2).
// They spy on `globalThis.fetch`, build the real provider through
// `createChatModel`, and snapshot what leaves the process. The snapshot is
// made on SDK v6 and must show no diff on v7. Never run `vitest -u` to fix a
// diff here: a diff means the wire changed.
import { createElevenLabs } from "@ai-sdk/elevenlabs";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { postProcess } from "@openstyle/stt";
import { type LlmTaskAssignments, serverModelId } from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { getLlmProvider } from "../src/lib/llm/registry.js";
import { resolveTaskCall } from "../src/lib/llm/task-profiles.js";
import { insertOwnServer } from "../src/lib/own-servers.js";
import { createChatModel } from "../src/lib/providers.js";
import { transcribeWithAiSdk } from "../src/lib/streaming/utils.js";

const RAW_TEXT = "um so we ship on friday i think";
const CLEANED = "We ship on Friday, I think.";
const SYSTEM = "You edit dictated text.";

interface Captured {
  url: string;
  method: string;
  headerNames: string[];
  contentType: string | null;
  authorization: string | null;
  apiKeyHeaders: Record<string, string>;
  body: unknown;
}

const jsonHeaders = { "content-type": "application/json" };

function openAiReply(): Response {
  return new Response(
    JSON.stringify({
      id: "1",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: CLEANED },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 },
    }),
    { status: 200, headers: jsonHeaders },
  );
}

function anthropicReply(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: CLEANED }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 9 },
    }),
    { status: 200, headers: jsonHeaders },
  );
}

function googleReply(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: CLEANED }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 40,
        candidatesTokenCount: 9,
        totalTokenCount: 49,
      },
    }),
    { status: 200, headers: jsonHeaders },
  );
}

async function describeRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Captured> {
  const headers = new Headers(init?.headers);
  const names = [...headers.keys()].sort();
  const apiKeyHeaders: Record<string, string> = {};
  for (const name of ["x-api-key", "x-goog-api-key"]) {
    const value = headers.get(name);
    if (value !== null) apiKeyHeaders[name] = value;
  }
  const raw = init?.body;
  return {
    url: String(input instanceof Request ? input.url : input),
    method: init?.method ?? "GET",
    headerNames: names,
    contentType: headers.get("content-type"),
    authorization: headers.get("authorization"),
    apiKeyHeaders,
    body: typeof raw === "string" ? JSON.parse(raw) : String(raw),
  };
}

function spyFetch(reply: () => Response): Captured[] {
  const calls: Captured[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push(await describeRequest(input, init));
    return reply();
  });
  return calls;
}

function seedDefaultLlm(provider: string, modelId: string): void {
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES (?, ?, ?, 'llm', 1)`,
  ).run(provider, modelId, modelId);
}

let keyCounter = 0;

/** Runs the production cleanup chain: resolve, build the model, postProcess. */
async function runCleanup(provider: string, modelId: string, apiKey: string) {
  seedDefaultLlm(provider, modelId);
  if (provider !== "server") {
    getDb()
      .prepare("INSERT OR REPLACE INTO api_keys (provider, key) VALUES (?, ?)")
      .run(provider, apiKey);
  }
  const resolved = await resolveTaskCall("cleanup", {
    autoMaxOutputTokens: 512,
  });
  const model = await createChatModel(resolved.provider, resolved.modelId, {
    task: "cleanup",
    sampling: resolved.samplingParams,
  });
  const errors: unknown[] = [];
  const result = await postProcess({
    model,
    text: RAW_TEXT,
    system: SYSTEM,
    temperature: resolved.temperature,
    topP: resolved.topP,
    maxOutputTokens: resolved.maxOutputTokens,
    skipEmptyText: false,
    providerOptions: getLlmProvider(resolved.provider)?.providerOptions?.(
      resolved.modelId,
      resolved.reasoningEnabled,
    ),
    onError: (err) => errors.push(err),
  });
  return { result, errors };
}

let serverId = "";

beforeEach(() => {
  // The provider clients read these variables when no base URL is passed. A
  // value set on the developer machine would change the URLs in the snapshot.
  for (const name of [
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "GROQ_BASE_URL",
    "MISTRAL_BASE_URL",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
  ]) {
    vi.stubEnv(name, undefined);
  }
  deleteSetting("llm_task_assignments");
  deleteSetting("llm_parameter_presets");
  deleteSetting("cleanup_sampling");
  getDb().prepare("DELETE FROM api_keys").run();
  getDb().exec("DELETE FROM own_servers");
  serverId = insertOwnServer({
    baseUrl: "http://127.0.0.1:8123",
    apiKey: null,
    flavor: "omlx",
  }).id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const cleanupCases: Array<{
  id: string;
  provider: string;
  model: () => string;
  reply: () => Response;
}> = [
  {
    id: "WB1 openai",
    provider: "openai",
    model: () => "openai/gpt-4o-mini",
    reply: openAiReply,
  },
  {
    id: "WB2 groq",
    provider: "groq",
    model: () => "groq/qwen/qwen3-32b",
    reply: openAiReply,
  },
  {
    id: "WB3 anthropic",
    provider: "anthropic",
    model: () => "anthropic/claude-haiku-4-5",
    reply: anthropicReply,
  },
  {
    id: "WB4 google",
    provider: "google",
    model: () => "google/gemini-2.5-flash",
    reply: googleReply,
  },
  {
    id: "WB5 mistral",
    provider: "mistral",
    model: () => "mistral/mistral-small-latest",
    reply: openAiReply,
  },
  {
    id: "WB6 openrouter",
    provider: "openrouter",
    model: () => "openrouter/meta-llama/llama-3.1-8b-instruct",
    reply: openAiReply,
  },
  {
    id: "WB7 vercel",
    provider: "vercel",
    model: () => "vercel/anthropic/claude-haiku-4.5",
    reply: openAiReply,
  },
  {
    id: "WB8 server",
    provider: "server",
    model: () => serverModelId(serverId, "Qwen3.8-27B"),
    reply: openAiReply,
  },
];

describe("stt postProcess wire body (WB1-WB8)", () => {
  for (const c of cleanupCases) {
    it(`${c.id}: request and result`, async () => {
      const calls = spyFetch(c.reply);
      keyCounter += 1;
      const { result, errors } = await runCleanup(
        c.provider,
        c.model(),
        `test-key-${keyCounter}`,
      );
      expect(errors).toEqual([]);
      expect(calls).toHaveLength(1);
      const snapshot = {
        request: { ...calls[0] },
        result,
      };
      // The own server id is random: keep the snapshot stable.
      expect(
        JSON.parse(JSON.stringify(snapshot).replaceAll(serverId, "SID")),
      ).toMatchSnapshot();
    });
  }
});

describe("stt postProcess wire body, preset (WB9)", () => {
  it("WB9 server with builtin:qwen-thinking: full body", async () => {
    const assignments: LlmTaskAssignments = {
      cleanup: { mode: "preset", presetId: "builtin:qwen-thinking" },
    };
    writeSetting("llm_task_assignments", JSON.stringify(assignments));
    const calls = spyFetch(openAiReply);
    const { result, errors } = await runCleanup(
      "server",
      serverModelId(serverId, "Qwen3.8-27B"),
      "unused",
    );
    expect(errors).toEqual([]);
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.chat_template_kwargs).toBeDefined();
    expect(body.top_k).toBeDefined();
    expect(body.min_p).toBeDefined();
    expect(
      JSON.parse(
        JSON.stringify({ request: calls[0], result }).replaceAll(
          serverId,
          "SID",
        ),
      ),
    ).toMatchSnapshot();
  });
});

describe("stt transcribe wire body (WB12-WB14)", () => {
  async function describeTranscription(
    createProvider: Parameters<typeof transcribeWithAiSdk>[1],
    providerId: string,
    model: string,
    reply: () => Response,
  ) {
    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      const form = init?.body;
      const fields: Array<[string, string]> = [];
      if (form instanceof FormData) {
        for (const [name, value] of form.entries()) {
          fields.push([
            name,
            typeof value === "string" ? value : `[file ${value.type}]`,
          ]);
        }
      }
      seen.push({
        url: String(input instanceof Request ? input.url : input),
        method: init?.method ?? "GET",
        headerNames: [...headers.keys()].sort(),
        authorization: headers.get("authorization"),
        apiKeyHeader: headers.get("xi-api-key"),
        isForm: form instanceof FormData,
        fields,
      });
      return reply();
    });
    const result = await transcribeWithAiSdk(
      {
        audio: new Uint8Array([1, 2, 3, 4]),
        model,
        apiKey: "cloud-test-key",
        language: "en",
      },
      createProvider,
      providerId,
    );
    return { requests: seen, result };
  }

  const textReply =
    (extra: Record<string, unknown> = {}) =>
    () =>
      new Response(JSON.stringify({ text: " hello world ", ...extra }), {
        status: 200,
        headers: jsonHeaders,
      });

  // 2026-10-18, coordinator decision (spec M7): AI SDK v7 sends response_format
  // before language. Multipart field order has no meaning to the server.
  it("WB12 openai", async () => {
    expect(
      await describeTranscription(
        createOpenAI,
        "openai",
        "openai/whisper-1",
        textReply(),
      ),
    ).toMatchSnapshot();
  });

  it("WB13 groq", async () => {
    expect(
      await describeTranscription(
        createGroq,
        "groq",
        "groq/whisper-large-v3-turbo",
        textReply({ x_groq: { id: "req_1" } }),
      ),
    ).toMatchSnapshot();
  });

  // 2026-10-18, coordinator decision (spec M7): AI SDK v6 sent two
  // contradictory diarize fields (true and false). v7 sends only diarize=true,
  // which is what the app asks for. This removes a duplicate field.
  it("WB14 elevenlabs", async () => {
    expect(
      await describeTranscription(
        createElevenLabs,
        "elevenlabs",
        "elevenlabs/scribe_v1",
        textReply({
          language_code: "en",
          language_probability: 0.9,
          words: [],
        }),
      ),
    ).toMatchSnapshot();
  });
});

describe("stt postProcess error replies (WB15)", () => {
  for (const status of [400, 401]) {
    it(`WB15 ${status}: raw text comes back and onError gets the status`, async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { message: "nope" } }), {
            status,
            headers: jsonHeaders,
          }),
      );
      keyCounter += 1;
      const { result, errors } = await runCleanup(
        "openai",
        "openai/gpt-4o-mini",
        `test-key-${keyCounter}`,
      );
      expect(result).toEqual({
        cleaned: RAW_TEXT,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(errors).toHaveLength(1);
      expect((errors[0] as { statusCode?: number }).statusCode).toBe(status);
    });
  }
});
