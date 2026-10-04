import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  defaultLlm: null as { provider: string; model_id: string } | null,
  resolved: { provider: "test-provider", modelId: "good-model" },
  createChatModel: vi.fn(),
}));

vi.mock("../src/lib/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/providers.js")>()),
  getDefaultModels: () => ({ llm: mocks.defaultLlm }),
  createChatModel: mocks.createChatModel,
}));

vi.mock("../src/lib/llm/task-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/llm/task-profiles.js")>()),
  resolveTaskCall: async () => ({
    ...mocks.resolved,
    reasoningEnabled: false,
    samplingParams: {},
    timeoutMs: 1000,
  }),
}));

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  isCleanupModelSupported: async (_provider: string, modelId: string) =>
    modelId !== "bad-model",
}));

const { default: transformRoute } = await import(
  "../src/routes/remix/transform.js"
);
const { default: agentRoute } = await import("../src/routes/remix/agent.js");

const lanes = [
  {
    name: "transform",
    app: transformRoute,
    body: { text: "hello", instruction: "make it formal" },
    remixWord: "remix",
  },
  {
    name: "agent",
    app: agentRoute,
    body: {
      messages: [{}],
      context: {
        selection: null,
        appName: null,
        windowTitle: null,
        capturedAt: 0,
      },
    },
    remixWord: "Remix",
  },
] as const;

describe.each(lanes)("remix model pre-flight ($name lane)", (lane) => {
  const post = () =>
    lane.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lane.body),
    });

  beforeEach(() => {
    mocks.defaultLlm = { provider: "test-provider", model_id: "good-model" };
    mocks.resolved = { provider: "test-provider", modelId: "good-model" };
    // Stops the run after the pre-flight. A 502 "stop" proves it passed.
    mocks.createChatModel.mockReset();
    mocks.createChatModel.mockRejectedValue(new Error("stop"));
  });

  it("returns 400 no-model when no default model is set", async () => {
    mocks.defaultLlm = null;
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no-model" });
  });

  it("allows a valid override when the default model is unsupported", async () => {
    mocks.defaultLlm = { provider: "test-provider", model_id: "bad-model" };
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "failed", detail: "stop" });
  });

  it("returns 400 unsupported-model when the override is unsupported", async () => {
    mocks.resolved = { provider: "test-provider", modelId: "bad-model" };
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "unsupported-model",
      detail: `bad-model can't run ${lane.remixWord}. Pick a different model in Settings > Models.`,
    });
    expect(mocks.createChatModel).not.toHaveBeenCalled();
  });
});
