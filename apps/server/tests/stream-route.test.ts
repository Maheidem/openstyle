import { beforeEach, describe, expect, it, vi } from "vitest";

// The WS route keeps its logic in closures inside the `upgradeWebSocket`
// factory. The test captures that factory and drives it with a fake socket.

const mocks = vi.hoisted(() => ({
  factory: null as null | (() => unknown),
  openStreamingSession: vi.fn(),
  supportsSessionTransport: vi.fn(),
  getApiKey: vi.fn(),
}));

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
  postProcess: vi.fn(),
  prewarmPostProcess: vi.fn(),
  resolveAppContextForCleanup: (c: string | null) => c,
}));
vi.mock("../src/lib/history-store.js", () => ({
  saveProcessedHistory: vi.fn(),
  saveRawHistory: vi.fn(),
}));
vi.mock("../src/lib/vocabulary-bias.js", () => ({
  resolveAsrVocabularyBias: () => null,
  vocabularyBiasTerms: () => [],
}));
vi.mock("../src/lib/api-keys.js", () => ({
  getApiKey: mocks.getApiKey,
}));
vi.mock("../src/lib/streaming/registry.js", () => ({
  openStreamingSession: mocks.openStreamingSession,
  supportsSessionTransport: mocks.supportsSessionTransport,
  supportsStreaming: () => true,
}));
vi.mock("../src/lib/streaming/local-providers.js", () => ({
  voiceProviderCategory: () => "cloud",
}));

type Handlers = {
  onOpen: (e: unknown, ws: FakeWs) => void;
  onMessage: (e: { data: string }, ws: FakeWs) => void;
  onClose: () => void;
  onError: () => void;
};
type FakeWs = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function sent(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
}

async function connect(): Promise<{ h: Handlers; ws: FakeWs }> {
  await import("../src/routes/stream.js");
  const h = mocks.factory!() as Handlers;
  const ws: FakeWs = { send: vi.fn(), close: vi.fn() };
  return { h, ws };
}

const start = (h: Handlers, ws: FakeWs) =>
  h.onMessage({ data: JSON.stringify({ type: "start" }) }, ws);

function fakeSession() {
  return {
    close: vi.fn(),
    sendAudio: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("stream route upstream errors", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.supportsSessionTransport.mockReturnValue(true);
    mocks.getApiKey.mockReturnValue("key");
  });

  it("reports a throw from the session open on start", async () => {
    mocks.openStreamingSession.mockImplementation(() => {
      throw new Error("no streaming support");
    });
    const { h, ws } = await connect();
    start(h, ws);
    expect(sent(ws)).toContainEqual({
      type: "error",
      message: "no streaming support",
    });
  });

  it("sends the real error when the transport fails while it opens", async () => {
    // MlxLocalSessionTransport calls onError inside its constructor when the
    // model is not downloaded. The route has no session object at that time.
    const session = fakeSession();
    mocks.openStreamingSession.mockImplementation((opts) => {
      opts.callbacks.onError("MLX ASR model is not downloaded yet.", "E_MLX");
      return session;
    });
    const { h, ws } = await connect();
    start(h, ws);
    expect(sent(ws).map((m) => m.type)).toEqual(["config", "config", "error"]);
    expect(sent(ws)[1]).toMatchObject({
      streaming: false,
      sessionTransport: false,
    });
    expect(sent(ws)[2]).toEqual({
      type: "error",
      code: "E_MLX",
      message: "MLX ASR model is not downloaded yet.",
    });
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("reports a throw from the reconnect after an upstream close", async () => {
    const first = fakeSession();
    let callbacks: { onClose: () => void } | undefined;
    mocks.openStreamingSession.mockImplementationOnce((opts) => {
      callbacks = opts.callbacks;
      return first;
    });
    const { h, ws } = await connect();
    start(h, ws);
    mocks.openStreamingSession.mockImplementationOnce(() => {
      throw new Error("reconnect failed");
    });
    callbacks!.onClose();
    expect(sent(ws)).toContainEqual({
      type: "error",
      message: "reconnect failed",
    });
  });

  it("does not throw when the socket is already closed", async () => {
    const first = fakeSession();
    let callbacks: { onClose: () => void } | undefined;
    mocks.openStreamingSession.mockImplementationOnce((opts) => {
      callbacks = opts.callbacks;
      return first;
    });
    const { h, ws } = await connect();
    start(h, ws);
    mocks.openStreamingSession.mockImplementationOnce(() => {
      throw new Error("reconnect failed");
    });
    ws.send.mockImplementation(() => {
      throw new Error("socket closed");
    });
    expect(() => callbacks!.onClose()).not.toThrow();
  });
});

describe("stream route teardown", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.supportsSessionTransport.mockReturnValue(true);
    mocks.getApiKey.mockReturnValue("key");
  });

  it.each([
    "onClose",
    "onError",
  ] as const)("%s closes the upstream session and stops reconnects", async (name) => {
    const session = fakeSession();
    let callbacks: { onClose: () => void } | undefined;
    mocks.openStreamingSession.mockImplementation((opts) => {
      callbacks = opts.callbacks;
      return session;
    });
    const { h, ws } = await connect();
    start(h, ws);
    expect(mocks.openStreamingSession).toHaveBeenCalledTimes(1);
    h[name]();
    expect(session.close).toHaveBeenCalledTimes(1);
    callbacks!.onClose();
    expect(mocks.openStreamingSession).toHaveBeenCalledTimes(1);
  });

  it("sends session.ready at once when the provider has no session transport", async () => {
    mocks.supportsSessionTransport.mockReturnValue(false);
    const { h, ws } = await connect();
    h.onOpen({}, ws);
    expect(sent(ws).map((m) => m.type)).toEqual(["config", "session.ready"]);
    expect(mocks.openStreamingSession).not.toHaveBeenCalled();
  });

  it("sends config, then error, then closes the session on an upstream error", async () => {
    const session = fakeSession();
    let callbacks:
      | { onError: (message: string, code?: string) => void }
      | undefined;
    mocks.openStreamingSession.mockImplementation((opts) => {
      callbacks = opts.callbacks;
      return session;
    });
    const { h, ws } = await connect();
    start(h, ws);
    ws.send.mockClear();
    callbacks!.onError("boom", "E1");
    expect(sent(ws).map((m) => m.type)).toEqual(["config", "error"]);
    expect(sent(ws)[1]).toMatchObject({ code: "E1", message: "boom" });
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});
