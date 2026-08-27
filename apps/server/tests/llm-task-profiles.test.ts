import {
  BUILTIN_LLM_PRESETS,
  type LlmTaskAssignments,
} from "@openstyle/validations";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import {
  createSamplingFetch,
  groqCleanupProviderOptions,
  mergeSamplingIntoBody,
} from "../src/lib/llm/registry.js";
import {
  LLM_TASK_PROFILES,
  resolveTaskCall,
} from "../src/lib/llm/task-profiles.js";
import { createChatModel } from "../src/lib/providers.js";

function seedDefaultLlm(provider: string, modelId: string): void {
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES (?, ?, ?, 'llm', 1)`,
  ).run(provider, modelId, modelId);
}

function setAssignments(assignments: LlmTaskAssignments): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('llm_task_assignments', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(assignments));
}

function clearSettings(): void {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key = 'llm_task_assignments'").run();
  db.prepare("DELETE FROM settings WHERE key = 'llm_parameter_presets'").run();
  db.prepare("DELETE FROM settings WHERE key = 'cleanup_sampling'").run();
  db.prepare("DELETE FROM api_keys").run();
}

/** Captures anything written to stdout while `fn` runs. Winston's Console
 *  transport writes warn/debug lines via `console._stdout.write(...)`
 *  (Node's internal alias for `process.stdout`), not `console.log` — and
 *  under Vitest's worker pool `console._stdout` is its own forwarding stream,
 *  not literally `process.stdout`, so this spies on the exact object winston
 *  looks up at call time rather than assuming which stream that is. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const target = (console as unknown as { _stdout: NodeJS.WritableStream })
    ._stdout;
  const spy = vi.spyOn(target, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

beforeEach(() => {
  clearSettings();
  seedDefaultLlm("local-llm", "local-llm/Qwen3.8-27B");
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('local_llm_url', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run("http://127.0.0.1:8123");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLM_TASK_PROFILES (§3.2)", () => {
  it("matches the spec table exactly — the day-one no-op claim depends on this", () => {
    expect(LLM_TASK_PROFILES.cleanup).toEqual({
      id: "cleanup",
      reasoningEnabled: false,
      temperature: 0,
      maxOutputTokens: "auto",
      timeoutMs: 20_000,
    });
    expect(LLM_TASK_PROFILES.remix).toEqual({
      id: "remix",
      reasoningEnabled: false,
      temperature: 0,
      maxOutputTokens: "auto",
      timeoutMs: 30_000,
    });
    expect(LLM_TASK_PROFILES.meetingSummarize).toEqual({
      id: "meetingSummarize",
      reasoningEnabled: false,
      temperature: 0,
      maxOutputTokens: 4096,
      timeoutMs: 60_000,
    });
    expect(LLM_TASK_PROFILES.meetingEnhance).toEqual({
      id: "meetingEnhance",
      reasoningEnabled: false,
      temperature: 0,
      maxOutputTokens: "auto",
      timeoutMs: 60_000,
    });
  });

  it("meetingSummarize's flat budget matches summarize.ts's DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS", async () => {
    const { DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS } = await import(
      "../src/lib/meetings/summarize.js"
    );
    expect(LLM_TASK_PROFILES.meetingSummarize.maxOutputTokens).toBe(
      DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
    );
  });
});

describe("resolveTaskCall — mode: auto (§6.1)", () => {
  it("local-llm gets only the reasoning seed, nothing else", async () => {
    const resolved = await resolveTaskCall("cleanup", {
      autoMaxOutputTokens: 512,
    });
    expect(resolved.samplingParams).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(resolved.temperature).toBe(0);
    expect(resolved.reasoningEnabled).toBe(false);
    expect(resolved.cloudPartial).toBe(false);
  });

  it("a mapped-subset provider gets an empty sampling object", async () => {
    seedDefaultLlm("openai", "gpt-4o-mini");
    getDb()
      .prepare("INSERT INTO api_keys (provider, key) VALUES ('openai', 'k')")
      .run();
    const resolved = await resolveTaskCall("cleanup", {
      autoMaxOutputTokens: 512,
    });
    expect(resolved.samplingParams).toEqual({});
    expect(resolved.cloudPartial).toBe(false);
  });

  it("throws when the profile is auto and no autoMaxOutputTokens is supplied", async () => {
    await expect(resolveTaskCall("cleanup")).rejects.toThrow(
      /no autoMaxOutputTokens was supplied/,
    );
  });
});

describe("resolveTaskCall — mode: preset, builtin:qwen-thinking (§6.1, §6.4)", () => {
  beforeEach(() => {
    setAssignments({
      cleanup: { mode: "preset", presetId: "builtin:qwen-thinking" },
    });
  });

  it("on local-llm: every key survives except `stream` (denylisted), and the preset's enable_thinking wins over the task seed", async () => {
    const resolved = await resolveTaskCall("cleanup", {
      autoMaxOutputTokens: 512,
    });
    const preset = BUILTIN_LLM_PRESETS.find(
      (p) => p.id === "builtin:qwen-thinking",
    )!;
    const { stream: _stream, chat_template_kwargs, ...rest } = preset.params;
    expect(resolved.samplingParams).toEqual({
      ...rest,
      chat_template_kwargs,
    });
    // The preset sets `enable_thinking: true`; the task profile's own
    // default (`reasoningEnabled: false`) must not survive the merge.
    expect(
      (resolved.samplingParams.chat_template_kwargs as Record<string, unknown>)
        .enable_thinking,
    ).toBe(true);
    expect(resolved.samplingParams).not.toHaveProperty("stream");
  });

  it("on a mapped-subset provider: only the safe subset survives, floor applies, cloudPartial is set", async () => {
    seedDefaultLlm("openai", "gpt-4o-mini");
    getDb()
      .prepare("INSERT INTO api_keys (provider, key) VALUES ('openai', 'k')")
      .run();
    const resolved = await resolveTaskCall("cleanup", {
      autoMaxOutputTokens: 100,
    });
    expect(resolved.temperature).toBe(1.0);
    // Preset's max_tokens (512) beats the small auto budget (100).
    expect(resolved.maxOutputTokens).toBe(512);
    expect(resolved.samplingParams).toEqual({});
    expect(resolved.cloudPartial).toBe(true);
  });
});

describe("resolveTaskCall — max_tokens is a floor, never a ceiling (§6.2)", () => {
  it("a smaller preset max_tokens never lowers meetingSummarize below its 4096 default", async () => {
    setAssignments({
      meetingSummarize: { mode: "custom", params: { max_tokens: 512 } },
    });
    const resolved = await resolveTaskCall("meetingSummarize");
    expect(resolved.maxOutputTokens).toBe(4096);
  });

  it("a larger preset max_tokens raises the resolved budget", async () => {
    setAssignments({
      meetingSummarize: { mode: "custom", params: { max_tokens: 8000 } },
    });
    const resolved = await resolveTaskCall("meetingSummarize");
    expect(resolved.maxOutputTokens).toBe(8000);
  });
});

describe("resolveTaskCall — denylist (§7.4)", () => {
  it("strips model/stream, keeps temperature, and logs the drop", async () => {
    setAssignments({
      cleanup: {
        mode: "custom",
        params: { stream: true, model: "x", temperature: 0.5 },
      },
    });
    let resolved: Awaited<ReturnType<typeof resolveTaskCall>>;
    const out = await captureStdout(async () => {
      resolved = await resolveTaskCall("cleanup", { autoMaxOutputTokens: 512 });
    });
    expect(resolved!.samplingParams.chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
    expect(resolved!.samplingParams).not.toHaveProperty("stream");
    expect(resolved!.samplingParams).not.toHaveProperty("model");
    expect(out).toMatch(/stream/);
    expect(out).toMatch(/model/);
  });
});

describe("resolveTaskCall — model override (§6.3, §11)", () => {
  it("falls back to the app default and warns when the override provider has no stored key", async () => {
    setAssignments({
      cleanup: {
        mode: "auto",
        modelOverride: { provider: "anthropic", model_id: "claude-x" },
      },
    });
    let resolved: Awaited<ReturnType<typeof resolveTaskCall>>;
    const out = await captureStdout(async () => {
      resolved = await resolveTaskCall("cleanup", { autoMaxOutputTokens: 512 });
    });
    expect(resolved!.provider).toBe("local-llm");
    expect(resolved!.modelId).toBe("local-llm/Qwen3.8-27B");
    expect(out).toMatch(/anthropic/);
  });

  it("uses the override once a key is stored for it", async () => {
    getDb()
      .prepare("INSERT INTO api_keys (provider, key) VALUES ('anthropic', 'k')")
      .run();
    setAssignments({
      cleanup: {
        mode: "auto",
        modelOverride: { provider: "anthropic", model_id: "claude-x" },
      },
    });
    const resolved = await resolveTaskCall("cleanup", {
      autoMaxOutputTokens: 512,
    });
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.modelId).toBe("claude-x");
  });
});

describe("resolveTaskCall — missing presetId (§11)", () => {
  it("falls back to auto for that resolution and warns", async () => {
    setAssignments({
      cleanup: { mode: "preset", presetId: "user_deleted-preset" },
    });
    let resolved: Awaited<ReturnType<typeof resolveTaskCall>>;
    const out = await captureStdout(async () => {
      resolved = await resolveTaskCall("cleanup", { autoMaxOutputTokens: 512 });
    });
    expect(resolved!.samplingParams).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(out).toMatch(/user_deleted-preset/);
  });
});

describe("resolveTaskCall — §12.7 legacy cleanup_sampling fallback", () => {
  // No sentinel, no client migration: an absent `llm_task_assignments.cleanup`
  // row falls back, read-time, to the legacy `cleanup_sampling` setting — the
  // same shape as `getLanguagesSetting()`'s `languages`/`language` fallback.
  it("resolves the legacy cleanup_sampling blob as this task's custom params when no assignment exists", async () => {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('cleanup_sampling', ?, datetime('now'))`,
      )
      .run(JSON.stringify({ temperature: 0.3, top_k: 40 }));
    const resolved = await resolveTaskCall("cleanup", {
      autoMaxOutputTokens: 512,
    });
    expect(resolved.samplingParams).toEqual({
      temperature: 0.3,
      top_k: 40,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("an explicit llm_task_assignments.cleanup entry wins over the legacy fallback", async () => {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('cleanup_sampling', ?, datetime('now'))`,
      )
      .run(JSON.stringify({ temperature: 0.3 }));
    setAssignments({ cleanup: { mode: "auto" } });
    const resolved = await resolveTaskCall("cleanup", {
      autoMaxOutputTokens: 512,
    });
    expect(resolved.samplingParams).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("does not apply the legacy blob to any other task", async () => {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('cleanup_sampling', ?, datetime('now'))`,
      )
      .run(JSON.stringify({ temperature: 0.3 }));
    const resolved = await resolveTaskCall("remix", {
      autoMaxOutputTokens: 512,
    });
    expect(resolved.samplingParams).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});

describe("groqCleanupProviderOptions (§7.3) — per-family reasoningEnabled:false split", () => {
  it("qwen/qwen3-32b: none when off, medium when on", () => {
    expect(groqCleanupProviderOptions("qwen/qwen3-32b", false)).toEqual({
      groq: { reasoningFormat: "hidden", reasoningEffort: "none" },
    });
    expect(groqCleanupProviderOptions("qwen/qwen3-32b", true)).toEqual({
      groq: { reasoningFormat: "hidden", reasoningEffort: "medium" },
    });
  });

  it("openai/gpt-oss-20b and -120b: low when off (not none), medium when on", () => {
    for (const id of ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]) {
      expect(groqCleanupProviderOptions(id, false)).toEqual({
        groq: { reasoningFormat: "hidden", reasoningEffort: "low" },
      });
      expect(groqCleanupProviderOptions(id, true)).toEqual({
        groq: { reasoningFormat: "hidden", reasoningEffort: "medium" },
      });
    }
  });

  it("an unrecognized model id is always undefined, regardless of reasoningEnabled", () => {
    expect(
      groqCleanupProviderOptions("some/other-model", false),
    ).toBeUndefined();
    expect(
      groqCleanupProviderOptions("some/other-model", true),
    ).toBeUndefined();
  });

  it("accepts a groq/-prefixed id the same as the bare one", () => {
    expect(groqCleanupProviderOptions("groq/qwen/qwen3-32b", false)).toEqual({
      groq: { reasoningFormat: "hidden", reasoningEffort: "none" },
    });
  });
});

// Moved from the retired apps/server/tests/cleanup-sampling.test.ts (§15) —
// `mergeSamplingIntoBody`/`createSamplingFetch` are unchanged by this spec,
// just now fed by the resolver instead of a raw settings read.
describe("mergeSamplingIntoBody / createSamplingFetch (moved, unchanged)", () => {
  it("lets the user's temperature win over the hardcoded 0", () => {
    const body = JSON.stringify({ model: "m", temperature: 0, messages: [] });
    const merged = JSON.parse(
      mergeSamplingIntoBody(body, { temperature: 0.7 }),
    );
    expect(merged.temperature).toBe(0.7);
  });

  it("max_tokens is a floor: raises a smaller computed budget, leaves a larger one alone", () => {
    const raised = JSON.parse(
      mergeSamplingIntoBody(JSON.stringify({ model: "m", max_tokens: 64 }), {
        max_tokens: 300,
      }),
    );
    expect(raised.max_tokens).toBe(300);

    const kept = JSON.parse(
      mergeSamplingIntoBody(JSON.stringify({ model: "m", max_tokens: 4096 }), {
        max_tokens: 300,
      }),
    );
    expect(kept.max_tokens).toBe(4096);
  });

  it("rewrites the request body via the installed fetch", async () => {
    const seen: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const wrapped = createSamplingFetch({ temperature: 0.7, top_k: 40 });
      await wrapped("https://example.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0 }),
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual([{ model: "m", temperature: 0.7, top_k: 40 }]);
  });
});

// Rewritten from the retired apps/server/tests/cleanup-sampling.test.ts's
// "local-llm provider wiring" suite: the provider no longer reads
// `cleanup_sampling` from the DB itself (§8.1) — sampling now arrives only
// via the explicit `taskContext` `createChatModel` is called with.
describe("local-llm provider wiring — taskContext, not a direct DB read (§8.1)", () => {
  async function captureBody(taskContext?: {
    task: string;
    sampling: Record<string, unknown>;
  }): Promise<string> {
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
      const model = await createChatModel(
        "local-llm",
        "local-llm/Qwen3.8-27B",
        taskContext,
      );
      await generateText({ model, prompt: "hi", temperature: 0 });
    } finally {
      globalThis.fetch = original;
    }
    return sent;
  }

  it("merges taskContext.sampling into the real request body", async () => {
    const body = JSON.parse(
      await captureBody({
        task: "cleanup",
        sampling: {
          top_k: 40,
          chat_template_kwargs: { enable_thinking: true },
        },
      }),
    );
    expect(body.top_k).toBe(40);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("no longer reads a DB-seeded cleanup_sampling row directly", async () => {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('cleanup_sampling', ?, datetime('now'))`,
      )
      .run(JSON.stringify({ top_k: 99 }));
    const body = JSON.parse(await captureBody());
    expect(body.top_k).toBeUndefined();
  });

  it("leaves the body alone with no taskContext", async () => {
    const body = JSON.parse(await captureBody());
    expect(Object.keys(body).sort()).toEqual([
      "messages",
      "model",
      "temperature",
    ]);
  });
});

// End-to-end: PUT the two new settings keys through the real route.
describe("PUT /api/settings/llm_parameter_presets and llm_task_assignments", () => {
  const app = createApp();

  it("accepts a valid preset list and a valid assignment blob", async () => {
    const presets = JSON.stringify({
      presets: [
        {
          id: "user_abc",
          name: "Mine",
          params: { temperature: 0.4 },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const res1 = await app.request("/api/settings/llm_parameter_presets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: presets }),
    });
    expect(res1.status).toBe(200);

    const assignments = JSON.stringify({
      cleanup: { mode: "preset", presetId: "user_abc" },
    });
    const res2 = await app.request("/api/settings/llm_task_assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: assignments }),
    });
    expect(res2.status).toBe(200);
  });

  it("rejects a builtin:-spoofing id and an out-of-enum mode with 400", async () => {
    const spoofed = JSON.stringify({
      presets: [
        {
          id: "builtin:qwen-thinking",
          name: "spoof",
          params: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const res1 = await app.request("/api/settings/llm_parameter_presets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: spoofed }),
    });
    expect(res1.status).toBe(400);

    const bad = JSON.stringify({ cleanup: { mode: "not-a-mode" } });
    const res2 = await app.request("/api/settings/llm_task_assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: bad }),
    });
    expect(res2.status).toBe(400);
  });

  it("rejects malformed JSON for both keys", async () => {
    const res1 = await app.request("/api/settings/llm_parameter_presets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "{not json" }),
    });
    expect(res1.status).toBe(400);

    const res2 = await app.request("/api/settings/llm_task_assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "{not json" }),
    });
    expect(res2.status).toBe(400);
  });

  it("rejects an oversized preset's params with 400", async () => {
    const oversized = JSON.stringify({
      presets: [
        {
          id: "user_big",
          name: "Big",
          params: { blob: "x".repeat(9000) },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const res = await app.request("/api/settings/llm_parameter_presets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: oversized }),
    });
    expect(res.status).toBe(400);
  });

  it("drops an unknown task-id key on write instead of rejecting the whole assignments blob", async () => {
    const res = await app.request("/api/settings/llm_task_assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: JSON.stringify({
          cleanup: { mode: "auto" },
          someFutureTask: { mode: "auto" },
        }),
      }),
    });
    expect(res.status).toBe(200);
  });
});
