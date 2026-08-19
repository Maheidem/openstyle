import { maxOutputTokensForCleanup } from "@openstyle/stt";
import {
  CLEANUP_SAMPLING_MAX_TOKENS_LIMIT,
  cleanupSamplingSchema,
  parseCleanupSampling,
} from "@openstyle/validations";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import {
  createSamplingFetch,
  mergeSamplingIntoBody,
} from "../src/lib/llm/registry.js";
import { createChatModel } from "../src/lib/providers.js";

describe("parseCleanupSampling", () => {
  it("keeps a fully specified sampling config", () => {
    const value = JSON.stringify({
      temperature: 0.3,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.05,
      presence_penalty: 0,
      max_tokens: 1024,
      thinking_budget: 256,
      reasoning_effort: "low",
      chat_template_kwargs: {
        enable_thinking: false,
        reasoning_effort: "low",
        preserve_thinking: false,
      },
    });
    expect(parseCleanupSampling(value)).toEqual({
      temperature: 0.3,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.05,
      presence_penalty: 0,
      max_tokens: 1024,
      thinking_budget: 256,
      reasoning_effort: "low",
      chat_template_kwargs: {
        enable_thinking: false,
        reasoning_effort: "low",
        preserve_thinking: false,
      },
    });
  });

  it("keeps a partial config without inventing the other fields", () => {
    expect(parseCleanupSampling('{"min_p":0.05}')).toEqual({ min_p: 0.05 });
  });

  it("treats missing, empty and `{}` settings as no overrides", () => {
    expect(parseCleanupSampling(undefined)).toEqual({});
    expect(parseCleanupSampling(null)).toEqual({});
    expect(parseCleanupSampling("")).toEqual({});
    expect(parseCleanupSampling("{}")).toEqual({});
  });

  it("falls back to no overrides on malformed JSON", () => {
    expect(parseCleanupSampling("{not json")).toEqual({});
    expect(parseCleanupSampling("[1,2,3]")).toEqual({});
    expect(parseCleanupSampling("null")).toEqual({});
  });

  it("rejects the whole object when any field is out of bounds", () => {
    expect(parseCleanupSampling('{"temperature":9}')).toEqual({});
    expect(parseCleanupSampling('{"min_p":0.9}')).toEqual({});
    expect(parseCleanupSampling('{"repetition_penalty":0.5}')).toEqual({});
    expect(parseCleanupSampling('{"presence_penalty":-5}')).toEqual({});
    expect(parseCleanupSampling('{"top_k":1.5}')).toEqual({});
    expect(parseCleanupSampling('{"max_tokens":0}')).toEqual({});
    // A good field alongside a bad one goes down with it.
    expect(parseCleanupSampling('{"top_p":0.9,"min_p":42}')).toEqual({});
  });

  // The dialog fills unset fields with these before saving, so "open the
  // dialog, nudge one slider, change nothing else" only holds if they parse.
  it("accepts the object the dialog builds from its display defaults", () => {
    const displayDefaults = {
      temperature: 0,
      top_p: 1,
      top_k: 0,
      min_p: 0,
      repetition_penalty: 1,
      presence_penalty: 0,
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: false,
      },
    };
    expect(cleanupSamplingSchema.safeParse(displayDefaults).success).toBe(true);
  });

  // The dialog clamps its number inputs to exactly these bounds.
  it("bounds the number fields the dialog has to clamp to", () => {
    expect(cleanupSamplingSchema.safeParse({ top_k: 500 }).success).toBe(true);
    expect(cleanupSamplingSchema.safeParse({ top_k: 501 }).success).toBe(false);
    expect(cleanupSamplingSchema.safeParse({ max_tokens: 1 }).success).toBe(
      true,
    );
    expect(cleanupSamplingSchema.safeParse({ max_tokens: 0 }).success).toBe(
      false,
    );
    expect(
      cleanupSamplingSchema.safeParse({
        thinking_budget: CLEANUP_SAMPLING_MAX_TOKENS_LIMIT,
      }).success,
    ).toBe(true);
    expect(
      cleanupSamplingSchema.safeParse({
        thinking_budget: CLEANUP_SAMPLING_MAX_TOKENS_LIMIT + 1,
      }).success,
    ).toBe(false);
  });

  it("drops unknown keys rather than putting them on the wire", () => {
    expect(parseCleanupSampling('{"top_p":0.9,"nonsense":true}')).toEqual({
      top_p: 0.9,
    });
  });
});

describe("mergeSamplingIntoBody", () => {
  // `postProcess` hardcodes `temperature: params.temperature ?? 0`, so the
  // user's value only survives if the sampling params are spread last.
  it("lets the user's temperature win over the hardcoded 0", () => {
    const body = JSON.stringify({ model: "m", temperature: 0, messages: [] });
    const merged = JSON.parse(
      mergeSamplingIntoBody(body, { temperature: 0.7 }),
    );
    expect(merged.temperature).toBe(0.7);
  });

  // `maxOutputTokensForCleanup` scales the budget off the *input*, which is
  // too tight once the model also has to emit reasoning.
  it("lets the user's max_tokens win over the scaled default", () => {
    const scaled = maxOutputTokensForCleanup("a short dictated sentence");
    expect(scaled).toBe(512);
    const body = JSON.stringify({ model: "m", max_tokens: scaled });
    const merged = JSON.parse(
      mergeSamplingIntoBody(body, { max_tokens: 2048 }),
    );
    expect(merged.max_tokens).toBe(2048);
  });

  it("adds the params the AI SDK cannot express, keeping the rest intact", () => {
    const body = JSON.stringify({
      model: "Qwen3.8-27B",
      temperature: 0,
      messages: [{ role: "user", content: "hi" }],
    });
    const merged = JSON.parse(
      mergeSamplingIntoBody(body, {
        top_k: 40,
        min_p: 0.05,
        repetition_penalty: 1.05,
        thinking_budget: 80,
        reasoning_effort: "low",
        chat_template_kwargs: { enable_thinking: false },
      }),
    );
    expect(merged).toEqual({
      model: "Qwen3.8-27B",
      temperature: 0,
      messages: [{ role: "user", content: "hi" }],
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.05,
      thinking_budget: 80,
      reasoning_effort: "low",
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("leaves the body untouched when there is nothing to merge", () => {
    const body = JSON.stringify({ model: "m", temperature: 0 });
    expect(mergeSamplingIntoBody(body, {})).toBe(body);
  });

  it("returns a non-JSON-object body as-is instead of throwing", () => {
    expect(mergeSamplingIntoBody("not json at all", { top_k: 40 })).toBe(
      "not json at all",
    );
    expect(mergeSamplingIntoBody("[1,2]", { top_k: 40 })).toBe("[1,2]");
    expect(mergeSamplingIntoBody("null", { top_k: 40 })).toBe("null");
  });
});

describe("createSamplingFetch", () => {
  it("rewrites a string body and leaves headers and URL alone", async () => {
    const seen: { url: string; body: unknown; headers: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: init.body, headers: init.headers });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const wrapped = createSamplingFetch({ temperature: 0.7, top_k: 40 });
      await wrapped("https://example.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", temperature: 0 }),
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://example.test/v1/chat/completions");
    expect(seen[0]!.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(seen[0]!.body as string)).toEqual({
      model: "m",
      temperature: 0.7,
      top_k: 40,
    });
  });

  it("passes a non-string body straight through", async () => {
    const seen: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(init?.body);
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const wrapped = createSamplingFetch({ top_k: 40 });
      await wrapped("https://example.test/v1/models");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual([undefined]);
  });
});

describe("PUT /api/settings/cleanup_sampling", () => {
  const app = createApp();

  function put(value: string) {
    return app.request("/api/settings/cleanup_sampling", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  }

  it("accepts a valid config and stores it verbatim", async () => {
    const value = JSON.stringify({ temperature: 0.3, top_k: 40 });
    expect((await put(value)).status).toBe(200);
    const res = await app.request("/api/settings/cleanup_sampling");
    expect(await res.json()).toEqual({ key: "cleanup_sampling", value });
  });

  it("accepts `{}` so the user can clear every override", async () => {
    expect((await put("{}")).status).toBe(200);
  });

  it("rejects malformed JSON and out-of-bounds values with 400", async () => {
    expect((await put("{not json")).status).toBe(400);
    expect((await put(JSON.stringify({ min_p: 42 }))).status).toBe(400);
    expect((await put(JSON.stringify({ temperature: -1 }))).status).toBe(400);
  });
});

// Closes the last unexercised seam: DB row -> parseCleanupSampling ->
// hasSampling -> createOpenAI({fetch}) -> the bytes actually sent.
describe("local-llm provider wiring", () => {
  function seed(sampling: string | null) {
    const db = getDb();
    const put = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    put.run("local_llm_url", "http://127.0.0.1:8123");
    put.run("cleanup_sampling", sampling ?? "");
  }

  async function captureBody(sampling: string | null): Promise<string> {
    seed(sampling);
    const original = globalThis.fetch;
    let sent = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          created: 0,
          model: "Qwen3.8-27B",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    try {
      const model = await createChatModel("local-llm", "local-llm/Qwen3.8-27B");
      await generateText({ model, prompt: "hi", temperature: 0 });
    } finally {
      globalThis.fetch = original;
    }
    return sent;
  }

  it("merges the stored sampling params into the real request body", async () => {
    const body = JSON.parse(
      await captureBody(
        JSON.stringify({
          temperature: 0.7,
          top_k: 40,
          min_p: 0.05,
          thinking_budget: 80,
          chat_template_kwargs: { enable_thinking: true },
        }),
      ),
    );
    expect(body.temperature).toBe(0.7);
    expect(body.top_k).toBe(40);
    expect(body.min_p).toBe(0.05);
    expect(body.thinking_budget).toBe(80);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("installs the fetch for a chat_template_kwargs-only config", async () => {
    const body = JSON.parse(
      await captureBody(
        JSON.stringify({ chat_template_kwargs: { enable_thinking: false } }),
      ),
    );
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("leaves the body alone when the setting is empty or malformed", async () => {
    for (const value of ["", "{}", "{not json", '{"min_p":42}']) {
      const body = JSON.parse(await captureBody(value));
      expect(Object.keys(body).sort()).toEqual([
        "messages",
        "model",
        "temperature",
      ]);
      expect(body.temperature).toBe(0);
    }
  });
});

describe("max_tokens is a floor, not a cap", () => {
  // Every local-llm path shares one fetch. Remix computes a larger budget than
  // cleanup and has no truncation fallback, so a literal override tuned for
  // cleanup would silently cut its rewrites short.
  it("raises a budget that is smaller than the user's value", () => {
    const out = JSON.parse(
      mergeSamplingIntoBody(
        JSON.stringify({ model: "m", max_tokens: 64 }),
        { max_tokens: 300 },
      ),
    );
    expect(out.max_tokens).toBe(300);
  });

  it("leaves a budget that is already larger alone", () => {
    const out = JSON.parse(
      mergeSamplingIntoBody(
        JSON.stringify({ model: "m", max_tokens: 4096 }),
        { max_tokens: 300 },
      ),
    );
    expect(out.max_tokens).toBe(4096);
  });

  it("uses the user's value when the caller computed none", () => {
    const out = JSON.parse(
      mergeSamplingIntoBody(JSON.stringify({ model: "m" }), {
        max_tokens: 300,
      }),
    );
    expect(out.max_tokens).toBe(300);
  });

  it("does not touch max_tokens when the user set none", () => {
    const out = JSON.parse(
      mergeSamplingIntoBody(
        JSON.stringify({ model: "m", max_tokens: 64 }),
        { temperature: 0.7 },
      ),
    );
    expect(out.max_tokens).toBe(64);
    expect(out.temperature).toBe(0.7);
  });
});
