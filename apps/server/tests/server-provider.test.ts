import { serverModelId } from "@openstyle/validations";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiKey } from "../src/lib/api-keys.js";
import { getDb } from "../src/lib/db.js";
import { isLocalProvider } from "../src/lib/llm/registry.js";
import { isCleanupModelSupported } from "../src/lib/model-registry.js";
import { insertOwnServer } from "../src/lib/own-servers.js";
import { createChatModel } from "../src/lib/providers.js";
import { ServerTranscriptionProvider } from "../src/lib/streaming/providers/server.js";

const TRANSCRIBE_URL = "http://127.0.0.1:8123/v1/audio/transcriptions";

let serverId = "";

function addServer(apiKey: string | null = null): string {
  getDb().exec("DELETE FROM own_servers");
  return insertOwnServer({
    baseUrl: "http://127.0.0.1:8123",
    apiKey,
    flavor: "omlx",
  }).id;
}

function opts(model = "Qwen3-ASR", extra: Record<string, unknown> = {}) {
  return {
    audio: new Uint8Array([1, 2, 3, 4]),
    model: serverModelId(serverId, model),
    apiKey: "local",
    ...extra,
  };
}

/** Body that oMLX returns for a successful transcription. */
function transcriptResponse(text: string): Response {
  return new Response(
    JSON.stringify({ text, language: "English", duration: 1.15, segments: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  serverId = addServer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server transcription provider", () => {
  it("needs no api_keys row, because the server row holds the key", () => {
    getDb().prepare("DELETE FROM api_keys WHERE provider = ?").run("server");

    expect(getApiKey("server")).toBe("local");
  });

  it("posts multipart file + model to the derived endpoint and reads .text", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(transcriptResponse("  hello there  "));

    const result = await new ServerTranscriptionProvider().transcribe(opts());

    expect(result.text).toBe("hello there");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TRANSCRIBE_URL);
    expect(init.method).toBe("POST");

    const form = init.body as FormData;
    // The `server/<id>/` part is stripped. The server wants the bare model id.
    expect(form.get("model")).toBe("Qwen3-ASR");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.size).toBe(4);
  });

  it("keeps a slash inside the model id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(transcriptResponse("ok"));

    await new ServerTranscriptionProvider().transcribe(
      opts("openai/whisper-large-v3"),
    );

    const form = (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as FormData;
    expect(form.get("model")).toBe("openai/whisper-large-v3");
  });

  it("sends the language and the vocabulary prompt itself", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(transcriptResponse("ok"));

    await new ServerTranscriptionProvider().transcribe(
      opts("Qwen3-ASR", {
        language: "pt",
        bias: { kind: "prompt", text: "Technical terms: Openstyle" },
      }),
    );

    const form = (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as FormData;
    expect(form.get("language")).toBe("pt");
    expect(form.get("prompt")).toBe("Technical terms: Openstyle");
  });

  it("omits the Authorization header when the server has no key", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(transcriptResponse("ok"));

    await new ServerTranscriptionProvider().transcribe(opts());

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({});
  });

  it("sends the key of the server that the model id names", async () => {
    serverId = addServer("proxy-key");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(transcriptResponse("ok"));

    await new ServerTranscriptionProvider().transcribe(opts());

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: "Bearer proxy-key" });
  });

  it("derives the same transcription URL from a root or a /v1 base URL", async () => {
    // A fresh Response per call. A body can only be read once.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => transcriptResponse("ok"));

    for (const input of [
      "http://127.0.0.1:8123",
      "http://127.0.0.1:8123/",
      "  http://127.0.0.1:8123/v1  ",
      "http://127.0.0.1:8123/v1/",
      "http://127.0.0.1:8123/v1/audio/transcriptions",
    ]) {
      getDb()
        .prepare("UPDATE own_servers SET base_url = ? WHERE id = ?")
        .run(input, serverId);
      await new ServerTranscriptionProvider().transcribe(opts());
    }

    expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual(
      Array(5).fill(TRANSCRIBE_URL),
    );
  });

  it("errors clearly when the server is not in the list", async () => {
    await expect(
      new ServerTranscriptionProvider().transcribe({
        ...opts(),
        model: "server/srv_gone0000/Qwen3-ASR",
      }),
    ).rejects.toThrow(/not in your list/);
  });

  it("errors clearly when the model id has no server part", async () => {
    await expect(
      new ServerTranscriptionProvider().transcribe({
        ...opts(),
        model: "Qwen3-ASR",
      }),
    ).rejects.toThrow(/not in your list/);
  });

  it("maps a 404 to a server-URL hint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
    );

    await expect(
      new ServerTranscriptionProvider().transcribe(opts()),
    ).rejects.toThrow(/no transcription endpoint at/i);
  });

  it("surfaces the upstream status for other error responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("model not loaded", { status: 500 }),
    );

    await expect(
      new ServerTranscriptionProvider().transcribe(opts()),
    ).rejects.toThrow(/HTTP 500 model not loaded/);
  });

  it("rejects a response with no transcript (for example a non-ASR model)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unsupported" }), { status: 200 }),
    );

    await expect(
      new ServerTranscriptionProvider().transcribe(opts()),
    ).rejects.toThrow(/returned no transcript/);
  });

  it("does not stream, because the whole clip is transcribed in one call", () => {
    expect(
      new ServerTranscriptionProvider().supportsStreaming("server/x/whatever"),
    ).toBe(false);
  });
});

describe("server chat provider", () => {
  function mockCompletion() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            object: "chat.completion",
            created: 0,
            model: "m",
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
        ),
    );
  }

  it("is a local provider", () => {
    expect(isLocalProvider("server")).toBe(true);
  });

  it("sends the chat call to the server of the model id, with its key and the bare model", async () => {
    serverId = addServer("lm-key");
    const fetchSpy = mockCompletion();

    const model = await createChatModel(
      "server",
      serverModelId(serverId, "qwen/qwen3-4b"),
    );
    await generateText({ model, prompt: "hi" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8123/v1/chat/completions");
    expect(
      (init.headers as Record<string, string>).authorization ??
        (init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer lm-key");
    expect(JSON.parse(String(init.body)).model).toBe("qwen/qwen3-4b");
  });

  it("throws a clear error when the server was removed", async () => {
    await expect(
      createChatModel("server", "server/srv_gone0000/m").then((model) =>
        generateText({ model, prompt: "hi" }),
      ),
    ).rejects.toThrow(/not in your list/);
  });
});

describe("isCleanupModelSupported for provider server", () => {
  it("passes the default llm of an own server", async () => {
    await expect(
      isCleanupModelSupported(
        "server",
        serverModelId("srv_00000000", "Qwen3.8-27B"),
      ),
    ).resolves.toBe(true);
  });
});
