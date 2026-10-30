// What the app puts on the wire for the cloud line-up of 2026-10-30. The real
// AI SDK builds each request, a stub fetch records it. No network, no key.
// Each rule below comes from the provider docs named in lib/cloud-models.ts:
// Claude 4.7+ and Gemini 3.5+ take no sampling parameters, Claude 5.5 models
// reject some thinking switches, Mistral Large 4 has no "none" effort.
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import {
  type CallProfile,
  reasoningWire,
  resolveCallProfile,
} from "../src/lib/llm/model-profiles.js";
import { getLlmProvider } from "../src/lib/llm/registry.js";
import { fetchModelsFromRegistry } from "../src/lib/model-registry.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn(),
}));

type Body = Record<string, unknown>;
let seen: { url: string; body: Body }[] = [];

const replies: Record<string, unknown> = {
  anthropic: {
    id: "m1",
    type: "message",
    role: "assistant",
    model: "x",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  google: {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "ok" }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  },
  openai: {
    id: "c1",
    object: "chat.completion",
    model: "x",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
};

beforeEach(() => {
  seen = [];
  vi.mocked(fetchModelsFromRegistry).mockRejectedValue(new Error("offline"));
  __resetLlmLanesForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const url = String(
        typeof input === "object" && input && "url" in input
          ? (input as { url: string }).url
          : input,
      );
      seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      const kind = url.includes("anthropic")
        ? "anthropic"
        : url.includes("googleapis")
          ? "google"
          : "openai";
      return new Response(JSON.stringify(replies[kind]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function profile(provider: string, id: string): Promise<CallProfile> {
  getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
  getDb()
    .prepare("INSERT OR REPLACE INTO api_keys (provider, key) VALUES (?, 'k')")
    .run(provider);
  getDb()
    .prepare(
      "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, 'llm', 1)",
    )
    .run(provider, `${provider}/${id}`, id);
  return resolveCallProfile({
    taskId: "meetingEnhance",
    step: "identifySpeakers",
    maxReasoningTokens: 1024,
  });
}

/** One call the way the gateway makes it: temperature 0, reasoning off. */
async function call(provider: string, id: string): Promise<Body> {
  const p = await profile(provider, id);
  const model = await getLlmProvider(provider)?.createModel(id, "k");
  if (!model) throw new Error("no model");
  await generateText({
    model,
    prompt: "hi",
    temperature: 0,
    topP: 1,
    maxOutputTokens: 256,
    providerOptions: reasoningWire(p).providerOptions as never,
    maxRetries: 0,
  });
  const last = seen.at(-1);
  if (!last) throw new Error("no request");
  return last.body;
}

describe("Anthropic Claude 5.5 line-up", () => {
  it.each([
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ])("%s: no temperature, top_p or top_k", async (id) => {
    const body = await call("anthropic", id);
    expect(body.model).toBe(id);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
  });

  it("never sends thinking disabled to a model that rejects it", async () => {
    for (const id of ["claude-fable-5-1", "claude-opus-5-5"]) {
      const body = await call("anthropic", id);
      expect(body.thinking, id).toBeUndefined();
      expect((body.output_config as Body)?.effort, id).toBe("low");
    }
    expect((await call("anthropic", "claude-sonnet-5-5")).thinking).toEqual({
      type: "between_tools",
    });
    expect((await call("anthropic", "claude-haiku-5-5")).thinking).toEqual({
      type: "disabled",
    });
  });
});

describe("Google Gemini line-up", () => {
  it.each([
    "gemini-4-argon",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
  ])("%s: no sampling parameters, thinking level low", async (id) => {
    const body = await call("google", id);
    const config = (body.generationConfig ?? {}) as Body;
    expect(config).not.toHaveProperty("temperature");
    expect(config).not.toHaveProperty("topP");
    expect(config).not.toHaveProperty("topK");
    expect((config.thinkingConfig as Body)?.thinkingLevel).toBe("low");
  });

  it("an older Gemini 3 model keeps the sampling it had", async () => {
    const config = (await call("google", "gemini-3.1-flash-lite"))
      .generationConfig as Body;
    expect(config.temperature).toBe(0);
  });
});

describe("OpenAI GPT-6 line-up", () => {
  it.each([
    "gpt-6.1-sol",
    "gpt-6-astra",
  ])("%s: no temperature while reasoning is on (effort low)", async (id) => {
    const body = await call("openai", id);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body.model).toBe(id);
  });
});
