import { afterEach, describe, expect, it, vi } from "vitest";
import {
  kindFromName,
  probeServer,
  ServerProbeError,
} from "../src/lib/server-models.js";

const ROOT = "http://127.0.0.1:8123";

/** What the real oMLX 0.7.0 answered on 2026-10-05 (trimmed to used fields). */
const MODELS = [
  "Qwen3-ASR",
  "Qwen3-Embedding",
  "Qwen3.8-27B",
  "Qwen3-Reranker",
  "Qwen3-TTS",
  "MarkItDown",
];
const STATUS = {
  models: [
    {
      id: "Qwen3-ASR-1.7B-8bit",
      model_alias: "Qwen3-ASR",
      model_type: "audio_stt",
    },
    {
      id: "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
      model_alias: "Qwen3-TTS",
      model_type: "audio_tts",
    },
    {
      id: "Qwen3-Embedding-8B-MLX-oQ4",
      model_alias: "Qwen3-Embedding",
      model_type: "embedding",
    },
    {
      id: "Qwen3-Reranker-0.6B-mlx-8Bit",
      model_alias: "Qwen3-Reranker",
      model_type: "reranker",
    },
    {
      id: "Qwen3.8-27B-AWQ-5.0bpw",
      model_alias: "Qwen3.8-27B",
      model_type: "vlm",
    },
    { id: "MarkItDown", model_type: "markitdown" },
    // Hidden by the server: not in /v1/models, so never listed.
    { id: "bge-m3-mlx-fp16", model_alias: "bge-m3", model_type: "embedding" },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kindFromName (the name rules, section 4.3)", () => {
  // The user's real ids from the table in section 4.4. The "name" rows.
  it.each([
    ["Qwen3-ASR-1.7B-8bit", "speech"],
    ["Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", "tts"],
    ["Qwen3-Embedding-8B-MLX-oQ4", "embedding"],
    ["Qwen3-Reranker-0.6B-mlx-8Bit", "rerank"],
    ["Qwen3.8-27B", "unknown"],
    ["bge-m3", "embedding"],
    ["openai/whisper-large-v3", "speech"],
    ["qwen/qwen3-4b", "unknown"],
    ["MarkItDown", "other"],
  ])("%s is %s", (id, kind) => {
    expect(kindFromName(id)).toBe(kind);
  });

  it.each([
    ["Qwen3-ASR", "speech"],
    ["Qwen3-TTS", "tts"],
    ["Qwen3-Embedding", "embedding"],
    ["Qwen3-Reranker", "rerank"],
  ])("also reads the oMLX alias %s as %s", (id, kind) => {
    expect(kindFromName(id)).toBe(kind);
  });

  it.each([
    ["nomic-embed-text", "embedding"],
    ["text-embedding-3-small", "embedding"],
    ["all-MiniLM-L6-v2", "embedding"],
    ["e5-large", "embedding"],
    ["jina-reranker-v2", "rerank"],
    ["kokoro-82m", "tts"],
    ["Orpheus-3b", "tts"],
    ["tts-1", "tts"],
    ["suno/bark", "tts"],
    ["parakeet-tdt-0.6b", "speech"],
    ["nvidia/canary-1b", "speech"],
    ["facebook/wav2vec2-base", "speech"],
    ["gpt-4o-transcribe", "speech"],
    ["acme/speech-to-text-1", "speech"],
    ["acme/text-to-speech-1", "tts"],
  ])("%s is %s", (id, kind) => {
    expect(kindFromName(id)).toBe(kind);
  });

  it("matches tokens, not substrings, for the short names", () => {
    // "bge" and "e5" are tokens. They must not match inside a longer word.
    expect(kindFromName("Qwen3-Bridge-7B")).toBe("unknown");
    expect(kindFromName("llama-3.1-8b")).toBe("unknown");
    expect(kindFromName("pre5-chat")).toBe("unknown");
  });
});

/** Answer `/v1/models` and `/v1/models/status` per URL. */
function mockServer(handlers: {
  models?: () => Response | Promise<Response>;
  status?: () => Response | Promise<Response>;
}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${ROOT}/v1/models`) {
        return (
          handlers.models?.() ??
          new Response(JSON.stringify({ data: MODELS.map((id) => ({ id })) }), {
            status: 200,
          })
        );
      }
      if (url === `${ROOT}/v1/models/status`) {
        return (
          handlers.status?.() ??
          new Response(JSON.stringify(STATUS), { status: 200 })
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
}

describe("probeServer with server data (oMLX)", () => {
  it("joins /v1/models and /v1/models/status by alias and sets the oMLX flavor", async () => {
    mockServer({});

    const result = await probeServer(ROOT, null);

    expect(result.flavor).toBe("omlx");
    expect(result.models).toEqual([
      { id: "Qwen3-ASR", kind: "speech", kind_source: "server" },
      { id: "Qwen3-Embedding", kind: "embedding", kind_source: "server" },
      { id: "Qwen3.8-27B", kind: "llm", kind_source: "server" },
      { id: "Qwen3-Reranker", kind: "rerank", kind_source: "server" },
      { id: "Qwen3-TTS", kind: "tts", kind_source: "server" },
      { id: "MarkItDown", kind: "other", kind_source: "server" },
    ]);
  });

  it("joins by id when the model has no alias", async () => {
    mockServer({
      models: () =>
        new Response(JSON.stringify({ data: [{ id: "Qwen3.5-2B-bf16" }] }), {
          status: 200,
        }),
      status: () =>
        new Response(
          JSON.stringify({
            models: [{ id: "Qwen3.5-2B-bf16", model_type: "vlm" }],
          }),
          { status: 200 },
        ),
    });

    const result = await probeServer(ROOT, null);

    expect(result.models).toEqual([
      { id: "Qwen3.5-2B-bf16", kind: "llm", kind_source: "server" },
    ]);
  });

  it("prefers server data over the name: a vlm named like a speech model stays llm", async () => {
    mockServer({
      models: () =>
        new Response(JSON.stringify({ data: [{ id: "asr-helper" }] }), {
          status: 200,
        }),
      status: () =>
        new Response(
          JSON.stringify({
            models: [{ id: "x", model_alias: "asr-helper", model_type: "llm" }],
          }),
          { status: 200 },
        ),
    });

    const result = await probeServer(ROOT, null);

    expect(result.models[0]).toEqual({
      id: "asr-helper",
      kind: "llm",
      kind_source: "server",
    });
  });

  it("maps audio_sts to other", async () => {
    mockServer({
      models: () =>
        new Response(JSON.stringify({ data: [{ id: "sts" }] }), {
          status: 200,
        }),
      status: () =>
        new Response(
          JSON.stringify({
            models: [{ id: "sts", model_type: "audio_sts" }],
          }),
          { status: 200 },
        ),
    });

    expect((await probeServer(ROOT, null)).models[0]?.kind).toBe("other");
  });

  it("sends the key as a Bearer header on both calls", async () => {
    const spy = mockServer({});

    await probeServer(ROOT, "secret");

    expect(spy.mock.calls).toHaveLength(2);
    for (const call of spy.mock.calls) {
      expect((call[1] as RequestInit).headers).toEqual({
        Authorization: "Bearer secret",
      });
    }
  });
});

describe("probeServer with name rules only", () => {
  it.each([
    [
      "the status call is missing (404)",
      () => new Response("", { status: 404 }),
    ],
    ["the status call answers 401", () => new Response("", { status: 401 })],
    [
      "the status reply has no models array",
      () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }),
    ],
    [
      "the status reply is not JSON",
      () => new Response("<html>", { status: 200 }),
    ],
  ])("falls back when %s", async (_label, status) => {
    mockServer({ status });

    const result = await probeServer(ROOT, null);

    expect(result.flavor).toBe("openai");
    expect(result.models).toEqual([
      { id: "Qwen3-ASR", kind: "speech", kind_source: "name" },
      { id: "Qwen3-Embedding", kind: "embedding", kind_source: "name" },
      { id: "Qwen3.8-27B", kind: "unknown", kind_source: "name" },
      { id: "Qwen3-Reranker", kind: "rerank", kind_source: "name" },
      { id: "Qwen3-TTS", kind: "tts", kind_source: "name" },
      { id: "MarkItDown", kind: "other", kind_source: "name" },
    ]);
  });

  it("falls back when the status call fails on the network", async () => {
    mockServer({
      status: () => {
        throw new Error("timeout");
      },
    });

    const result = await probeServer(ROOT, null);

    expect(result.flavor).toBe("openai");
  });

  it("uses the name rules for a type that this app does not know", async () => {
    mockServer({
      models: () =>
        new Response(JSON.stringify({ data: [{ id: "whisper-x" }] }), {
          status: 200,
        }),
      status: () =>
        new Response(
          JSON.stringify({
            models: [{ id: "whisper-x", model_type: "future_type" }],
          }),
          { status: 200 },
        ),
    });

    const result = await probeServer(ROOT, null);

    expect(result.models[0]).toEqual({
      id: "whisper-x",
      kind: "speech",
      kind_source: "name",
    });
  });
});

describe("probeServer errors (section 3.4)", () => {
  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof ServerProbeError) return err.code;
      throw err;
    }
    throw new Error("expected a probe error");
  }

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_openai"],
    [500, "unreachable"],
  ])("maps /v1/models status %i to %s", async (status, code) => {
    mockServer({ models: () => new Response("", { status }) });

    expect(await codeOf(probeServer(ROOT, null))).toBe(code);
  });

  it("maps a network failure to unreachable", async () => {
    mockServer({
      models: () => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    expect(await codeOf(probeServer(ROOT, null))).toBe("unreachable");
  });

  it.each([
    ["a body that is not JSON", "<html>hello</html>"],
    ["a body with no data array", JSON.stringify({ models: [] })],
  ])("maps %s to not_openai", async (_label, body) => {
    mockServer({ models: () => new Response(body, { status: 200 }) });

    expect(await codeOf(probeServer(ROOT, null))).toBe("not_openai");
  });

  it("does not call the status endpoint when the model list fails", async () => {
    const spy = mockServer({ models: () => new Response("", { status: 401 }) });

    await codeOf(probeServer(ROOT, null));

    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
      `${ROOT}/v1/models`,
    ]);
  });
});
