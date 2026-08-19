import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEYS } from "../../electron/src/shared/settings-keys.js";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { OmlxTranscriptionProvider } from "../src/lib/streaming/providers/omlx.js";
import { getApiKeyForProvider } from "../src/lib/streaming-stt.js";

const MODELS_URL = "http://127.0.0.1:8123/v1/models";
const TRANSCRIBE_URL = "http://127.0.0.1:8123/v1/audio/transcriptions";

const opts = {
  audio: new Uint8Array([1, 2, 3, 4]),
  model: "omlx/mlx-community--Qwen3-ASR-1.7B-8bit",
  apiKey: "local",
};

function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function clearOmlxSettings(): void {
  getDb()
    .prepare("DELETE FROM settings WHERE key IN (?, ?)")
    .run(SETTINGS_KEYS.omlxBaseUrl, SETTINGS_KEYS.omlxApiKey);
}

/** Body oMLX returns for a successful transcription. */
function transcriptResponse(text: string): Response {
  return new Response(
    JSON.stringify({ text, language: "English", duration: 1.15, segments: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("oMLX transcription provider", () => {
  beforeEach(() => {
    clearOmlxSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("needs no api_keys row — the provider is keyless", () => {
    getDb().prepare("DELETE FROM api_keys WHERE provider = ?").run("omlx");

    expect(getApiKeyForProvider("omlx")).toBe("local");
  });

  it("posts multipart file + model to the derived endpoint and reads .text", async () => {
    setSetting(SETTINGS_KEYS.omlxBaseUrl, "http://127.0.0.1:8123");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(transcriptResponse("  hello there  "));

    const result = await new OmlxTranscriptionProvider().transcribe(opts);

    expect(result.text).toBe("hello there");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TRANSCRIBE_URL);
    expect(init.method).toBe("POST");

    const form = init.body as FormData;
    // The `omlx/` catalog prefix is stripped — oMLX wants the bare model id.
    expect(form.get("model")).toBe("mlx-community--Qwen3-ASR-1.7B-8bit");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.size).toBe(4);
  });

  it("omits the Authorization header when no key is stored", async () => {
    setSetting(SETTINGS_KEYS.omlxBaseUrl, "http://127.0.0.1:8123");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(transcriptResponse("ok"));

    await new OmlxTranscriptionProvider().transcribe(opts);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({});
  });

  it("sends a bearer token when the optional key is set", async () => {
    setSetting(SETTINGS_KEYS.omlxBaseUrl, "http://127.0.0.1:8123");
    setSetting(SETTINGS_KEYS.omlxApiKey, "proxy-key");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(transcriptResponse("ok"));

    await new OmlxTranscriptionProvider().transcribe(opts);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: "Bearer proxy-key" });
  });

  it("derives the same transcription URL from a root or a /v1 base URL", async () => {
    // A fresh Response per call — a body can only be read once.
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
      setSetting(SETTINGS_KEYS.omlxBaseUrl, input);
      await new OmlxTranscriptionProvider().transcribe(opts);
    }

    expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual(
      Array(5).fill(TRANSCRIBE_URL),
    );
  });

  it("errors clearly when no server URL is configured", async () => {
    await expect(
      new OmlxTranscriptionProvider().transcribe(opts),
    ).rejects.toThrow(/No oMLX server URL configured/);
  });

  it("maps a 404 to a server-URL hint", async () => {
    setSetting(SETTINGS_KEYS.omlxBaseUrl, "http://127.0.0.1:8123");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
    );

    await expect(
      new OmlxTranscriptionProvider().transcribe(opts),
    ).rejects.toThrow(/no transcription endpoint at/i);
  });

  it("surfaces the upstream status for other error responses", async () => {
    setSetting(SETTINGS_KEYS.omlxBaseUrl, "http://127.0.0.1:8123");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("model not loaded", { status: 500 }),
    );

    await expect(
      new OmlxTranscriptionProvider().transcribe(opts),
    ).rejects.toThrow(/HTTP 500 model not loaded/);
  });

  it("rejects a response with no transcript (e.g. a non-ASR model)", async () => {
    setSetting(SETTINGS_KEYS.omlxBaseUrl, "http://127.0.0.1:8123");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unsupported" }), { status: 200 }),
    );

    await expect(
      new OmlxTranscriptionProvider().transcribe(opts),
    ).rejects.toThrow(/returned no transcript/);
  });

  it("does not stream — the whole clip is transcribed in one call", () => {
    expect(
      new OmlxTranscriptionProvider().supportsStreaming("omlx/whatever"),
    ).toBe(false);
  });
});

describe("POST /api/settings/omlx/test", () => {
  const app = createApp();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Answer per URL rather than with a single shared `Response` — the probe
   * makes two calls, and a Response body can only be read once.
   */
  function mockServer(handlers: {
    models?: () => Response;
    transcribe?: () => Response;
  }) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === MODELS_URL) {
          return (
            handlers.models?.() ??
            new Response(
              JSON.stringify({
                data: [{ id: "mlx-community--Qwen3-ASR-1.7B-8bit" }],
              }),
              { status: 200 },
            )
          );
        }
        if (url === TRANSCRIBE_URL) {
          // What oMLX really answers for a field-less POST.
          return (
            handlers.transcribe?.() ??
            new Response(
              JSON.stringify({
                error: {
                  message:
                    "body -> file: Field required; body -> model: Field required",
                },
              }),
              { status: 422 },
            )
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
  }

  function post(body: unknown) {
    return app.request("/api/settings/omlx/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("lists every model id and reports the transcription URL", async () => {
    mockServer({});

    const res = await post({ url: "http://127.0.0.1:8123" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      models: ["mlx-community--Qwen3-ASR-1.7B-8bit"],
      transcribeUrl: TRANSCRIBE_URL,
    });
  });

  it.each([
    ["http://127.0.0.1:8123", "server root"],
    ["http://127.0.0.1:8123/", "trailing slash"],
    ["  http://127.0.0.1:8123/v1  ", "versioned base"],
    ["http://127.0.0.1:8123/v1/", "versioned base with slash"],
    ["http://127.0.0.1:8123/v1/audio/transcriptions", "pasted endpoint"],
  ])("derives both URLs identically from %s (%s)", async (input) => {
    const fetchSpy = mockServer({});

    const res = await post({ url: input });

    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      MODELS_URL,
      TRANSCRIBE_URL,
    ]);
  });

  it("treats a validation error on the transcription route as 'route exists'", async () => {
    mockServer({
      transcribe: () => new Response("{}", { status: 422 }),
    });

    const res = await post({ url: "http://127.0.0.1:8123" });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ok?: boolean }).toMatchObject({ ok: true });
  });

  it("fails when the models leg succeeds but the transcription route 404s", async () => {
    mockServer({
      transcribe: () =>
        new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
    });

    const res = await post({ url: "http://127.0.0.1:8123" });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: `No transcription endpoint at ${TRANSCRIBE_URL}`,
    });
  });

  it("forwards the optional key to both legs when one is set", async () => {
    const fetchSpy = mockServer({});

    await post({ url: "http://127.0.0.1:8123", api_key: "k" });

    for (const call of fetchSpy.mock.calls) {
      expect((call[1] as RequestInit).headers).toEqual({
        Authorization: "Bearer k",
      });
    }
  });

  it("sends no auth header when the key is omitted", async () => {
    const fetchSpy = mockServer({});

    await post({ url: "http://127.0.0.1:8123" });

    for (const call of fetchSpy.mock.calls) {
      expect((call[1] as RequestInit).headers).toEqual({});
    }
  });

  it("returns 502 when the model listing fails", async () => {
    mockServer({
      models: () =>
        new Response("nope", { status: 500, statusText: "Server Error" }),
    });

    const res = await post({ url: "http://127.0.0.1:8123" });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Server returned 500: Server Error",
    });
  });

  it("rejects an invalid URL with a 400", async () => {
    const res = await post({ url: "not-a-url" });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/settings/omlx_base_url", () => {
  const app = createApp();

  function put(value: string) {
    return app.request("/api/settings/omlx_base_url", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  }

  it("accepts an http URL", async () => {
    expect((await put("http://127.0.0.1:8123")).status).toBe(200);
  });

  it("accepts an empty value (disconnects the server)", async () => {
    expect((await put("")).status).toBe(200);
  });

  it("rejects a non-URL value", async () => {
    const res = await put("127.0.0.1:8123");
    expect(res.status).toBe(400);
  });
});
