import { createOpenAI } from "@ai-sdk/openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSetting, writeSetting } from "../src/lib/db.js";

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({
    transcription: vi.fn((id: string) => ({ id })),
  })),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    experimental_transcribe: vi.fn(async () => ({
      text: "mock transcript",
      segments: undefined,
      durationInSeconds: undefined,
    })),
  };
});

const { OpenAITranscriptionProvider } = await import(
  "../src/lib/streaming/providers/openai.js"
);

const opts = {
  audio: new Uint8Array([1, 2, 3, 4]),
  model: "whisper-1",
  apiKey: "cloud-openai-key",
};

function createOpenAICallConfig(): unknown {
  return vi.mocked(createOpenAI).mock.calls[0]?.[0];
}

// The OpenAI-compatible URL override moved to own servers (schema 36). The
// cloud provider reads no URL setting any more. A leftover value from an older
// build must change nothing.
describe("OpenAI cloud transcription provider", () => {
  beforeEach(() => {
    deleteSetting("openai_stt_base_url");
    deleteSetting("openai_stt_api_key");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the default provider config", async () => {
    const provider = new OpenAITranscriptionProvider();

    const result = await provider.transcribe(opts);

    expect(result.text).toBe("mock transcript");
    expect(createOpenAICallConfig()).toEqual({ apiKey: "cloud-openai-key" });
  });

  it("ignores a leftover openai_stt_base_url and openai_stt_api_key", async () => {
    writeSetting("openai_stt_base_url", "https://example.com/v1");
    writeSetting("openai_stt_api_key", "stt-endpoint-key");
    const provider = new OpenAITranscriptionProvider();

    await provider.transcribe(opts);

    expect(createOpenAICallConfig()).toEqual({ apiKey: "cloud-openai-key" });
  });
});
