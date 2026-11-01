// The Ask routes (routes/chat.ts). The pipeline is a stub: its own tests are
// elsewhere. The real gate, store and recorder run. Fictional data only.
import {
  chatAskReplySchema,
  chatGateErrorSchema,
  chatThreadDetailSchema,
  chatThreadSchema,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "./helpers/http.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";
import { seedTestModel } from "./helpers/workflow-harness.js";

const pipeline = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("../src/lib/chat/pipeline.js", () => ({
  runChatTurn: pipeline.run,
}));

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

import createApp from "../src/index.js";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";

const app = createApp();
const db = () => getDb();

function turnResult(over: Record<string, unknown> = {}) {
  return {
    blocks: [
      { kind: "text", text: "The harbor theme won [S1].", cites: ["S1"] },
    ],
    content: "The harbor theme won [S1].",
    cites: [
      {
        label: "S1",
        kind: "summary",
        meeting_id: "m1",
        title: "Launch review",
        started_at: 1000,
        start_ms: null,
        item_id: null,
        text: "The team picked the harbor theme.",
      },
    ],
    trace: {
      intent: "lookup",
      router: "structured",
      steps: [],
      calls: 2,
      sources_dropped: [],
      history_turns_dropped: 0,
      source_tokens: 80,
    },
    proposal: null,
    toolCalls: [],
    modelId: "fake-model",
    provider: "server",
    runId: "run-from-pipeline",
    ms: 321,
    ...over,
  };
}

function seedMeeting(id = "m1") {
  db()
    .prepare(
      `INSERT INTO meetings (id, title, status, started_at, created_at)
       VALUES (?, 'Launch review', 'summarized', 1000, 1000)`,
    )
    .run(id);
}

async function newThread(meetingId = "m1"): Promise<string> {
  const res = await jsonRequest(app, "POST", "/api/chat/threads", {
    scope: { kind: "meeting", id: meetingId },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { thread: { id: string } }).thread.id;
}

const ask = (threadId: string, question: string, init: RequestInit = {}) =>
  app.request(`/api/chat/threads/${threadId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    ...init,
  });

beforeEach(() => {
  db().exec("DELETE FROM chat_threads");
  db().exec("DELETE FROM llm_runs WHERE scope = 'chat'");
  resetMeetingTables();
  deleteSetting(SETTINGS_KEYS.meetingChatEnabled);
  pipeline.run.mockReset();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
  seedMeeting();
});

describe("threads", () => {
  it("creates a thread, lists it and reads its detail", async () => {
    const id = await newThread();
    const list = await app.request("/api/chat/threads?meeting_id=m1");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { threads: unknown[] };
    expect(body.threads).toHaveLength(1);
    expect(chatThreadSchema.parse(body.threads[0]).id).toBe(id);
    const detail = await app.request(`/api/chat/threads/${id}`);
    expect(detail.status).toBe(200);
    const parsed = chatThreadDetailSchema.parse(await detail.json());
    expect(parsed.thread.id).toBe(id);
    expect(parsed.messages).toEqual([]);
  });

  it("lists the threads of a folder and allows a folder scope", async () => {
    db()
      .prepare(
        "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES ('f1','Harbor',NULL,1,1)",
      )
      .run();
    const res = await jsonRequest(app, "POST", "/api/chat/threads", {
      scope: { kind: "folder", id: "f1" },
    });
    expect(res.status).toBe(200);
    const list = await app.request("/api/chat/threads?folder_id=f1");
    expect(
      ((await list.json()) as { threads: unknown[] }).threads,
    ).toHaveLength(1);
  });

  it("answers 404 for a meeting, a folder or a thread that does not exist", async () => {
    for (const kind of ["meeting", "folder"] as const) {
      const res = await jsonRequest(app, "POST", "/api/chat/threads", {
        scope: { kind, id: "nope" },
      });
      expect(res.status).toBe(404);
    }
    expect((await app.request("/api/chat/threads/nope")).status).toBe(404);
    expect((await ask("nope", "hi")).status).toBe(404);
  });

  it("rejects the scope all and a list without a scope", async () => {
    const res = await jsonRequest(app, "POST", "/api/chat/threads", {
      scope: { kind: "all", id: "x" },
    });
    expect(res.status).toBe(400);
    expect((await app.request("/api/chat/threads")).status).toBe(400);
    expect(
      (await app.request("/api/chat/threads?meeting_id=a&folder_id=b")).status,
    ).toBe(400);
  });

  it("the GET routes need no setting", async () => {
    const id = await newThread();
    expect((await app.request(`/api/chat/threads/${id}`)).status).toBe(200);
  });
});

describe("POST /threads/:id/messages", () => {
  it("answers 409 off when the switch is off, and stores nothing", async () => {
    const id = await newThread();
    const res = await ask(id, "What did we decide?");
    expect(res.status).toBe(409);
    const body = chatGateErrorSchema.parse(await res.json());
    expect(body.reason).toBe("off");
    expect(pipeline.run).not.toHaveBeenCalled();
    const detail = chatThreadDetailSchema.parse(
      await (await app.request(`/api/chat/threads/${id}`)).json(),
    );
    expect(detail.messages).toEqual([]);
  });

  it("answers 409 no_model and keeps the user message", async () => {
    writeSetting(SETTINGS_KEYS.meetingChatEnabled, "true");
    db().exec("DELETE FROM model_configs WHERE type = 'llm'");
    const id = await newThread();
    const res = await ask(id, "What did we decide?");
    expect(res.status).toBe(409);
    expect(chatGateErrorSchema.parse(await res.json()).reason).toBe("no_model");
    const detail = chatThreadDetailSchema.parse(
      await (await app.request(`/api/chat/threads/${id}`)).json(),
    );
    expect(detail.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "What did we decide?"],
    ]);
    expect(pipeline.run).not.toHaveBeenCalled();
  });

  it("answers 409 provider_not_ready", async () => {
    writeSetting(SETTINGS_KEYS.meetingChatEnabled, "true");
    db().exec("DELETE FROM model_configs WHERE type = 'llm'");
    db()
      .prepare(
        `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
         VALUES ('openai', 'gpt-5-mini', 'gpt-5-mini', 'llm', 1)`,
      )
      .run();
    const id = await newThread();
    const res = await ask(id, "q");
    expect(res.status).toBe(409);
    expect(chatGateErrorSchema.parse(await res.json()).reason).toBe(
      "provider_not_ready",
    );
  });

  it("stores the question and the answer and returns both (happy path)", async () => {
    writeSetting(SETTINGS_KEYS.meetingChatEnabled, "true");
    writeSetting(SETTINGS_KEYS.chatRounds, "2");
    pipeline.run.mockResolvedValue(turnResult());
    const id = await newThread();
    const res = await ask(id, "Which theme won?");
    expect(res.status).toBe(200);
    const reply = chatAskReplySchema.parse(await res.json());
    expect(reply.user.role).toBe("user");
    expect(reply.user.content).toBe("Which theme won?");
    expect(reply.assistant.content).toBe("The harbor theme won [S1].");
    expect(reply.assistant.cites).toHaveLength(1);
    expect(reply.assistant.trace?.calls).toBe(2);
    expect(reply.assistant.model_id).toBe("fake-model");
    expect(reply.assistant.ms).toBe(321);

    // The pipeline got the scope, the question, the settings and an empty history.
    const input = pipeline.run.mock.calls[0]?.[0];
    expect(input.scope).toEqual({ kind: "meeting", id: "m1" });
    expect(input.question).toBe("Which theme won?");
    expect(input.history).toEqual([]);
    expect(input.settings.rounds).toBe(2);
    expect(input.llm.runId).toEqual(expect.any(String));
    expect(input.signal).toBeInstanceOf(AbortSignal);

    // The run is closed and the thread has a title.
    const run = db()
      .prepare("SELECT status, scope, scope_id FROM llm_runs WHERE id = ?")
      .get(input.llm.runId);
    expect(run).toEqual({ status: "succeeded", scope: "chat", scope_id: id });
    const detail = chatThreadDetailSchema.parse(
      await (await app.request(`/api/chat/threads/${id}`)).json(),
    );
    expect(detail.thread.title).toBe("Which theme won?");
    expect(detail.messages).toHaveLength(2);

    // The second question sees the first pair as history.
    pipeline.run.mockResolvedValue(turnResult({ content: "second" }));
    await ask(id, "And who said it?");
    const second = pipeline.run.mock.calls[1]?.[0];
    expect(second.history.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("a thrown error stores no answer, closes the run failed and answers 502", async () => {
    writeSetting(SETTINGS_KEYS.meetingChatEnabled, "true");
    pipeline.run.mockRejectedValue(
      Object.assign(new Error("model fell over"), {
        kind: "provider_unavailable",
      }),
    );
    const id = await newThread();
    const res = await ask(id, "q");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "model fell over",
      reason: "failed",
    });
    const messages = db()
      .prepare("SELECT role FROM chat_messages WHERE thread_id = ?")
      .all(id);
    expect(messages).toEqual([{ role: "user" }]);
    const run = db()
      .prepare("SELECT status, error_kind FROM llm_runs WHERE scope_id = ?")
      .get(id);
    expect(run).toEqual({
      status: "failed",
      error_kind: "provider_unavailable",
    });
  });

  it("a second question on a running thread answers 409 busy", async () => {
    writeSetting(SETTINGS_KEYS.meetingChatEnabled, "true");
    let release: () => void = () => {};
    pipeline.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(turnResult());
        }),
    );
    const id = await newThread();
    const first = ask(id, "first");
    await vi.waitFor(() => expect(pipeline.run).toHaveBeenCalledTimes(1));
    const second = await ask(id, "second");
    expect(second.status).toBe(409);
    expect(((await second.json()) as { reason: string }).reason).toBe("busy");
    release();
    expect((await first).status).toBe(200);
    // The thread is free again.
    pipeline.run.mockResolvedValue(turnResult());
    expect((await ask(id, "third")).status).toBe(200);
    // The busy question stored nothing.
    const users = db()
      .prepare(
        "SELECT content FROM chat_messages WHERE thread_id = ? AND role = 'user' ORDER BY id",
      )
      .all(id);
    expect(users).toEqual([{ content: "first" }, { content: "third" }]);
  });

  it("a client that leaves does not cancel the turn: the answer is stored (P1.2)", async () => {
    writeSetting(SETTINGS_KEYS.meetingChatEnabled, "true");
    let release: () => void = () => {};
    pipeline.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(turnResult());
        }),
    );
    const id = await newThread();
    const controller = new AbortController();
    const pending = ask(id, "q", { signal: controller.signal });
    await vi.waitFor(() => expect(pipeline.run).toHaveBeenCalledTimes(1));
    controller.abort();
    // The client is gone. The thread shows the question and a running turn.
    const mid = chatThreadDetailSchema.parse(
      await (await app.request(`/api/chat/threads/${id}`)).json(),
    );
    expect(mid.pending).toBe(true);
    expect(mid.messages.map((m) => m.role)).toEqual(["user"]);
    // The turn ends. The answer is saved and the run is closed as succeeded.
    release();
    await Promise.resolve(pending).catch(() => {});
    await vi.waitFor(() => {
      const roles = db()
        .prepare(
          "SELECT role FROM chat_messages WHERE thread_id = ? ORDER BY id",
        )
        .all(id);
      expect(roles).toEqual([{ role: "user" }, { role: "assistant" }]);
    });
    await vi.waitFor(() => {
      const run = db()
        .prepare("SELECT status FROM llm_runs WHERE scope_id = ?")
        .get(id) as { status: string } | undefined;
      expect(run?.status).toBe("succeeded");
    });
    const done = chatThreadDetailSchema.parse(
      await (await app.request(`/api/chat/threads/${id}`)).json(),
    );
    expect(done.pending).toBe(false);
    expect(done.failure).toBeNull();
  });

  it("a failed turn of a client that left shows as a failure in the detail (P1.2)", async () => {
    writeSetting(SETTINGS_KEYS.meetingChatEnabled, "true");
    pipeline.run.mockRejectedValue(new Error("boom"));
    const id = await newThread();
    expect((await ask(id, "q")).status).toBe(502);
    const detail = chatThreadDetailSchema.parse(
      await (await app.request(`/api/chat/threads/${id}`)).json(),
    );
    expect(detail.pending).toBe(false);
    expect(detail.failure).toEqual({ reason: "failed" });
    // The next question clears the failure.
    pipeline.run.mockResolvedValue(turnResult());
    expect((await ask(id, "again")).status).toBe(200);
    const after = chatThreadDetailSchema.parse(
      await (await app.request(`/api/chat/threads/${id}`)).json(),
    );
    expect(after.failure).toBeNull();
  });

  it("rejects an empty or too long question with 400", async () => {
    writeSetting(SETTINGS_KEYS.meetingChatEnabled, "true");
    const id = await newThread();
    expect((await ask(id, "   ")).status).toBe(400);
    expect((await ask(id, "x".repeat(1001))).status).toBe(400);
  });
});
