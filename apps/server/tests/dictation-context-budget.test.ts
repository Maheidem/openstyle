// The context guard of dictation cleanup (specs/llm-runtime-tuning.md 9
// item 5). The real server `postProcess` runs with an own server as the
// cleanup model. Only `fetch` is mocked, and the context window of the model
// is set by a test seam. Fictional text only.
import { serverModelId } from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { insertOwnServer } from "../src/lib/own-servers.js";

let windowTokens: number | null = null;

vi.mock("../src/lib/llm/token-budget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/llm/token-budget.js")>()),
  contextWindowFor: () => windowTokens,
}));

const { postProcess } = await import("../src/lib/post-process.js");
const { estimateCallTokens } = await import("../src/lib/llm/token-budget.js");

interface Sent {
  system: string;
  user: string;
  maxTokens: number;
}

const jsonHeaders = { "content-type": "application/json" };

function okReply(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "1",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 },
    }),
    { status: 200, headers: jsonHeaders },
  );
}

function refusal(): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "The prompt and max_tokens do not fit the context.",
        prompt_tokens: 40_000,
        max_tokens: 8192,
        context_tokens: 32_768,
      },
    }),
    { status: 400, headers: jsonHeaders },
  );
}

/** Spy on fetch. `answer(n, sent)` gives the reply of call n (0-based). */
function spyFetch(answer: (n: number, sent: Sent) => Response): Sent[] {
  const calls: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: string }[];
      max_tokens?: number;
      max_completion_tokens?: number;
    };
    const sent: Sent = {
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
      maxTokens: body.max_tokens ?? body.max_completion_tokens ?? 0,
    };
    calls.push(sent);
    return answer(calls.length - 1, sent);
  });
  return calls;
}

/** A fictional dictation of `n` sentences. */
function dictation(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      `item ${i} the riverside team ships the beta adapter to the tacoma depot on friday and dana checks the vendor list again.`,
    );
  }
  return out.join(" ");
}

function promptTokensOf(s: Sent): number {
  return estimateCallTokens({
    instructions: s.system,
    messages: [{ content: s.user }],
  });
}

beforeEach(() => {
  windowTokens = null;
  deleteSetting("llm_task_assignments");
  deleteSetting("llm_parameter_presets");
  deleteSetting("cleanup_sampling");
  writeSetting("llm_cleanup", "true");
  const db = getDb();
  db.exec("DELETE FROM own_servers");
  const serverId = insertOwnServer({
    baseUrl: "http://127.0.0.1:1",
    apiKey: null,
    flavor: "omlx",
  }).id;
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  const modelId = serverModelId(serverId, "cleanup-model");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES (?, ?, ?, 'llm', 1)`,
  ).run("server", modelId, modelId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dictation cleanup keeps prompt + max_tokens inside the window", () => {
  it("DB1: a text that fits is one call, the same as with no window", async () => {
    const text = dictation(3);
    const noWindow = spyFetch(() => okReply("Clean."));
    const a = await postProcess(text, null);
    vi.restoreAllMocks();
    windowTokens = 32_768;
    const withWindow = spyFetch(() => okReply("Clean."));
    const b = await postProcess(text, null);
    expect(noWindow).toHaveLength(1);
    expect(withWindow).toEqual(noWindow);
    expect(a.cleaned).toBe("Clean.");
    expect(b.cleaned).toBe("Clean.");
  });

  it("DB2: a text over the window is split; each call fits; the answers join in order", async () => {
    windowTokens = 12_000;
    const text = dictation(400); // about 48k characters
    const calls = spyFetch((n) => okReply(`Part ${n}.`));
    const r = await postProcess(text, null);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(promptTokensOf(c) + c.maxTokens).toBeLessThanOrEqual(12_000);
      // Each answer budget is under the cap, so the answer can end.
      expect(c.maxTokens).toBeLessThan(8192);
    }
    expect(r.cleaned).toBe(calls.map((_, n) => `Part ${n}.`).join(" "));
    expect(r.llmModel).not.toBeNull();
  });

  it("DB3: a refusal from the model splits the text in two and tries once more", async () => {
    windowTokens = null; // no window known: only the refusal can start a split
    const text = dictation(40);
    const calls = spyFetch((n) =>
      n === 0 ? refusal() : okReply(`Half ${n}.`),
    );
    const r = await postProcess(text, null);
    expect(calls).toHaveLength(3);
    expect(r.cleaned).toBe("Half 1. Half 2.");
    expect(r.llmModel).not.toBeNull();
  });

  it("DB4: a piece that is refused again gives its raw text, never an error", async () => {
    const text = dictation(40);
    const calls = spyFetch((n) => (n === 2 ? okReply("Half two.") : refusal()));
    const r = await postProcess(text, null);
    expect(calls).toHaveLength(3);
    expect(r.cleaned.endsWith("Half two.")).toBe(true);
    expect(r.cleaned.startsWith("item 0 the riverside team")).toBe(true);
  });
});
