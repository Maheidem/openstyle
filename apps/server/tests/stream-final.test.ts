import { beforeEach, describe, expect, it, vi } from "vitest";

// Drives the streaming `onFinal` callback with a fake StreamSession. It pins
// the clean step, the empty-text return, the cleanup fallback and the
// dictation lease. The real sanitize and leak-strip code runs.

const mocks = vi.hoisted(() => ({
  factory: null as null | (() => unknown),
  openStreamingSession: vi.fn(),
  postProcess: vi.fn(),
  beginDictation: vi.fn(),
  endDictation: vi.fn(),
  saveProcessedHistory: vi.fn(),
  saveRawHistory: vi.fn(),
}));

const VOCAB_TERMS = Array.from({ length: 80 }, (_, i) => `Zylotrix${i + 1}`);
const REAL_SPEECH =
  "While you wait, why don't you launch a deep research on the subject about the best practices for this?";

vi.mock("@hono/node-server", () => ({
  upgradeWebSocket: (factory: () => unknown) => {
    mocks.factory = factory;
    return async () => undefined;
  },
}));
vi.mock("../src/lib/providers.js", () => ({
  getDefaultModels: () => ({
    voice: { provider: "groq", model_id: "groq/whisper" },
  }),
}));
vi.mock("../src/lib/language.js", () => ({
  getLanguagesSetting: () => ["en"],
  getTranslateModeSetting: () => false,
  resolveLanguageOverride: (_o: string | null, l: string[]) => l,
}));
vi.mock("../src/lib/post-process.js", () => ({
  postProcess: mocks.postProcess,
  prewarmPostProcess: vi.fn(),
  resolveAppContextForCleanup: (c: string | null) => c,
}));
vi.mock("../src/lib/history-store.js", () => ({
  saveProcessedHistory: mocks.saveProcessedHistory,
  saveRawHistory: mocks.saveRawHistory,
}));
vi.mock("../src/lib/dictation-activity.js", () => ({
  beginDictation: mocks.beginDictation,
  endDictation: mocks.endDictation,
}));
vi.mock("../src/lib/vocabulary-bias.js", () => ({
  resolveAsrVocabularyBias: () => null,
  vocabularyBiasTerms: () => VOCAB_TERMS,
}));
vi.mock("../src/lib/streaming-stt.js", () => ({
  getApiKeyForProvider: () => "key",
  openStreamingSession: mocks.openStreamingSession,
  supportsSessionTransport: () => true,
  supportsStreaming: () => true,
  voiceProviderCategory: () => "cloud",
}));

type Callbacks = { onFinal: (text: string) => Promise<void> | void };
type FakeWs = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
type Handlers = {
  onMessage: (e: { data: string }, ws: FakeWs) => void;
};

function sent(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
}

async function startSession(): Promise<{ callbacks: Callbacks; ws: FakeWs }> {
  let callbacks: Callbacks | undefined;
  mocks.openStreamingSession.mockImplementation((opts) => {
    callbacks = opts.callbacks;
    return { close: vi.fn(), sendAudio: vi.fn(), commit: vi.fn() };
  });
  await import("../src/routes/stream.js");
  const h = mocks.factory!() as Handlers;
  const ws: FakeWs = { send: vi.fn(), close: vi.fn() };
  h.onMessage({ data: JSON.stringify({ type: "start" }) }, ws);
  ws.send.mockClear();
  return { callbacks: callbacks!, ws };
}

const ppResult = (cleaned: string) => ({
  cleaned,
  llmProvider: "p",
  llmModel: "m",
  inputTokens: 1,
  outputTokens: 2,
  costUsd: 0.5,
});

// onFinal may run its cleanup after it returns, so let pending promises settle.
// The test setup uses fake timers, so flush microtasks instead of a timer.
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("stream route onFinal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sends an empty final and releases the lease for empty text", async () => {
    const { callbacks, ws } = await startSession();
    await callbacks.onFinal("   ");
    await settle();
    expect(sent(ws)).toEqual([{ type: "final", text: "" }]);
    expect(mocks.postProcess).not.toHaveBeenCalled();
    expect(mocks.saveProcessedHistory).not.toHaveBeenCalled();
    expect(mocks.beginDictation).toHaveBeenCalledTimes(1);
    expect(mocks.endDictation).toHaveBeenCalledTimes(1);
  });

  it("drops an output that is only a vocabulary-prompt echo", async () => {
    const { callbacks, ws } = await startSession();
    await callbacks.onFinal(`Technical terms: ${VOCAB_TERMS.join(", ")}`);
    await settle();
    expect(sent(ws)).toEqual([{ type: "final", text: "" }]);
    expect(mocks.postProcess).not.toHaveBeenCalled();
    expect(mocks.endDictation).toHaveBeenCalledTimes(1);
  });

  it("strips a trailing vocabulary echo before cleanup", async () => {
    mocks.postProcess.mockResolvedValue(ppResult("cleaned"));
    const { callbacks } = await startSession();
    await callbacks.onFinal(
      `${REAL_SPEECH} Technical terms: ${VOCAB_TERMS.join(", ")}`,
    );
    await settle();
    expect(mocks.postProcess.mock.calls[0][0]).toBe(REAL_SPEECH);
  });

  it("sends the cleaned text, saves history and releases the lease after cleanup", async () => {
    let resolvePp!: (v: unknown) => void;
    mocks.postProcess.mockReturnValue(
      new Promise((r) => {
        resolvePp = r;
      }),
    );
    const { callbacks, ws } = await startSession();
    await callbacks.onFinal("hello world");
    // The lease stays held while cleanup runs.
    expect(mocks.beginDictation).toHaveBeenCalledTimes(1);
    expect(mocks.endDictation).not.toHaveBeenCalled();
    expect(sent(ws)).toEqual([]);
    resolvePp(ppResult("Hello, world."));
    await settle();
    expect(sent(ws)).toEqual([{ type: "final", text: "Hello, world." }]);
    expect(mocks.saveProcessedHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: "hello world",
        cleanedText: "Hello, world.",
        llmProvider: "p",
        llmModel: "m",
      }),
    );
    expect(mocks.saveRawHistory).not.toHaveBeenCalled();
    expect(mocks.endDictation).toHaveBeenCalledTimes(1);
  });

  it("stores no cleaned text when cleanup returns the raw text", async () => {
    mocks.postProcess.mockResolvedValue(ppResult("hello world"));
    const { callbacks } = await startSession();
    await callbacks.onFinal("hello world");
    await settle();
    expect(mocks.saveProcessedHistory).toHaveBeenCalledWith(
      expect.objectContaining({ cleanedText: null }),
    );
  });

  it("falls back to the raw text when cleanup rejects", async () => {
    mocks.postProcess.mockRejectedValue(new Error("llm down"));
    const { callbacks, ws } = await startSession();
    await callbacks.onFinal("hello world");
    await settle();
    expect(sent(ws)).toEqual([{ type: "final", text: "hello world" }]);
    expect(mocks.saveRawHistory).toHaveBeenCalledWith(
      expect.objectContaining({ rawText: "hello world" }),
    );
    expect(mocks.saveProcessedHistory).not.toHaveBeenCalled();
    expect(mocks.endDictation).toHaveBeenCalledTimes(1);
  });
});
