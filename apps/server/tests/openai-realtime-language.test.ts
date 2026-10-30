import { beforeEach, describe, expect, it, vi } from "vitest";

// The OpenAI Realtime transcription session names the language of the model in
// `session.update`. gpt-live-transcribe and gpt-transcribe take a `languages`
// list; the older models take the single `language` field. The API wants only
// one of the two (platform.openai.com/docs/guides/realtime-transcription).

const sent: string[] = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  send = vi.fn((data: unknown) => {
    sent.push(String(data));
  });
  close = vi.fn();
  on = vi.fn((event: string, handler: () => void) => {
    if (event === "open") queueMicrotask(handler);
  });
}

vi.mock("ws", () => ({ default: FakeSocket }));

const { OpenAITranscriptionProvider } = await import(
  "../src/lib/streaming/providers/openai.js"
);

function transcriptionOf(model: string, language: string | undefined) {
  new OpenAITranscriptionProvider().openStreamingSession({
    apiKey: "k",
    model,
    languages: language ? [language] : [],
    bias: null,
    callbacks: {
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
      onReady: vi.fn(),
      onClose: vi.fn(),
    },
  } as never);
  return new Promise<Record<string, unknown>>((resolve) => {
    queueMicrotask(() =>
      queueMicrotask(() => {
        const update = JSON.parse(sent[0] ?? "{}");
        resolve(update.session.audio.input.transcription);
      }),
    );
  });
}

describe("OpenAI realtime transcription language field", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("sends a languages list for gpt-live-transcribe", async () => {
    expect(await transcriptionOf("openai/gpt-live-transcribe", "es")).toEqual({
      model: "gpt-live-transcribe",
      languages: ["es"],
    });
  });

  it("sends a languages list for gpt-transcribe", async () => {
    expect(await transcriptionOf("openai/gpt-transcribe", "fr")).toEqual({
      model: "gpt-transcribe",
      languages: ["fr"],
    });
  });

  it("sends the single language field for gpt-4o-transcribe", async () => {
    expect(await transcriptionOf("openai/gpt-4o-transcribe", "de")).toEqual({
      model: "gpt-4o-transcribe",
      language: "de",
    });
  });

  it("sends no language when none is set", async () => {
    expect(
      await transcriptionOf("openai/gpt-live-transcribe", undefined),
    ).toEqual({ model: "gpt-live-transcribe" });
  });
});
