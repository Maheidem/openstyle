// Live chat (issue #375): the reply parser and the route with a cloud model.
// Fictional text only. The model call is a stub.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generate = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generate,
}));

import createApp from "../src/index.js";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { parseChatReply } from "../src/lib/meetings/live/chat-prompt.js";
import { jsonRequest } from "./helpers/http.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";

describe("parseChatReply", () => {
  it("reads the plain JSON form", () => {
    expect(parseChatReply('{"answer":"Dana owns it.","cites":["L1"]}')).toEqual(
      {
        answer: "Dana owns it.",
        cites: ["L1"],
      },
    );
  });

  it("ignores trailing junk after the object (owner sample shape)", () => {
    const raw =
      '{"answer": "Estão discutindo o lançamento [L7, L10, L13].", "cites": ["L7","L10","L13"]}И}';
    const reply = parseChatReply(raw);
    expect(reply?.answer).toBe("Estão discutindo o lançamento.");
    expect(reply?.cites).toEqual(["L7", "L10", "L13"]);
  });

  it("reads an object with junk inside it", () => {
    const reply = parseChatReply(
      '{"answer": "Beta on Friday.", "cites": ["L2"]И}',
    );
    expect(reply).toEqual({ answer: "Beta on Friday.", cites: ["L2"] });
  });

  it("skips text and a code fence before the object", () => {
    const reply = parseChatReply(
      'Here you go:\n```json\n{"answer":"Yes.","cites":[]}\n```',
    );
    expect(reply).toEqual({ answer: "Yes.", cites: [] });
  });

  it("is not fooled by braces inside the answer string", () => {
    const reply = parseChatReply(
      '{"answer":"Use {x} here.","cites":["L1"]} tail }',
    );
    expect(reply).toEqual({ answer: "Use {x} here.", cites: ["L1"] });
  });

  it("moves inline markers into the cites", () => {
    const reply = parseChatReply(
      '{"answer":"Dana owns it [L3] and Lee helps [P1].","cites":["L3"]}',
    );
    expect(reply).toEqual({
      answer: "Dana owns it and Lee helps.",
      cites: ["L3", "P1"],
    });
  });

  it("keeps a plain-text reply as an answer and lifts its markers", () => {
    expect(parseChatReply("Dana owns it [L3].")).toEqual({
      answer: "Dana owns it.",
      cites: ["L3"],
    });
  });

  it("returns null for JSON-like text that has no readable answer", () => {
    expect(parseChatReply('{"answer": "cut off')).toBeNull();
    expect(parseChatReply('{"cites": ["L1"]}')).toBeNull();
    expect(parseChatReply("")).toBeNull();
  });
});

describe("POST /api/meetings/:id/chat with a cloud model", () => {
  const app = createApp();

  beforeEach(async () => {
    generate.mockReset();
    writeSetting("live_chat_enabled", "true");
    writeSetting(
      "llm_task_assignments",
      JSON.stringify({
        liveChat: {
          mode: "auto",
          modelOverride: {
            provider: "openrouter",
            model_id: "openrouter/anthropic/claude-test",
          },
        },
      }),
    );
    await jsonRequest(app, "POST", "/api/keys", {
      provider: "openrouter",
      key: "sk-fictional",
    });
    // A default model must exist, even when the task has its own model.
    await jsonRequest(app, "POST", "/api/models/configured", {
      provider: "openrouter",
      model_id: "openrouter/anthropic/claude-test",
      model_name: "Claude test",
      type: "llm",
      is_default: true,
    });
    await jsonRequest(app, "POST", "/api/meetings/start", {
      id: "m-cloud",
      audio_dir: "/tmp/none",
      started_at: Date.now(),
    });
  });
  afterEach(() => {
    getDb().prepare("DELETE FROM api_keys WHERE provider = 'openrouter'").run();
    getDb()
      .prepare("DELETE FROM model_configs WHERE provider = 'openrouter'")
      .run();
    deleteSetting("live_chat_enabled");
    deleteSetting("llm_task_assignments");
    resetMeetingTables();
  });

  const ask = () =>
    jsonRequest(app, "POST", "/api/meetings/m-cloud/chat", {
      question: "Who owns the beta?",
    });

  it("answers, and names the provider and model that got the text", async () => {
    generate.mockResolvedValue({ text: '{"answer":"Dana.","cites":[]}' });
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      answer: "Dana.",
      provider: "openrouter",
      model: "openrouter/anthropic/claude-test",
    });
  });

  it("GET names the model that gets the live text", async () => {
    const res = await app.request("/api/meetings/m-cloud/chat");
    expect((await res.json()).model).toMatchObject({
      provider: "openrouter",
      local: false,
    });
  });

  it("retries once when the reply is not readable, then answers", async () => {
    generate
      .mockResolvedValueOnce({ text: '{"answer": "cut off' })
      .mockResolvedValueOnce({ text: '{"answer":"Dana.","cites":[]}' });
    const res = await ask();
    expect(res.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(2);
    expect((await res.json()).answer).toBe("Dana.");
  });

  it("gives a short error, not raw JSON, when the retry fails too", async () => {
    generate.mockResolvedValue({ text: '{"answer": "cut off' });
    const res = await ask();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "bad_reply" });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("returns the provider error text", async () => {
    generate.mockRejectedValue(new Error("Provider down"));
    const res = await ask();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      reason: "failed",
      error: "Provider down",
    });
  });

  it("returns an error when the key is missing", async () => {
    getDb().prepare("DELETE FROM api_keys WHERE provider = 'openrouter'").run();
    const res = await ask();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/API key/);
  });

  it("ends with an error when the model never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      generate.mockImplementation(() => new Promise(() => {}));
      const pending = ask();
      // The first call is cold: 120 s, plus 15 s for the lane.
      await vi.advanceTimersByTimeAsync(136_000);
      const res = await pending;
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/No answer within/);
    } finally {
      vi.useRealTimers();
    }
  });
});
