import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
let homeDir = "";
let online = false;

interface Entry {
  provider_id: string;
  model_id: string;
  model_name: string;
  type: string;
  curated?: boolean;
  notice?: string;
  cost_input?: number;
}

// A small models.dev answer: one legacy model the line-up does not hold, and
// one deprecated model that must stay hidden.
const REGISTRY = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        modalities: { input: ["text"], output: ["text"] },
      },
      "gpt-6-luna": {
        id: "gpt-6-luna",
        name: "GPT-6 Luna (registry name)",
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0.1, output: 0.5 },
      },
    },
  },
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-3.1-8b-instant": {
        id: "llama-3.1-8b-instant",
        name: "Llama 3.1 8B",
        status: "deprecated",
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
};

async function available(): Promise<Entry[]> {
  const { default: createApp } = await import("../src/index.js");
  const res = await createApp().request("/api/models/available");
  expect(res.status).toBe(200);
  return (await res.json()) as Entry[];
}

describe("GET /api/models/available, cloud models", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openstyle-cloud-models-"));
    process.env.HOME = homeDir;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!online) throw new Error("offline");
        return new Response(JSON.stringify(REGISTRY), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    process.env.HOME = ORIGINAL_HOME;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("lists the curated line-up with prices when models.dev is offline", async () => {
    const llms = (await available()).filter((m) => m.type === "llm");
    const ids = llms.map((m) => `${m.provider_id}/${m.model_id}`);
    for (const id of [
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-fable-5-1",
      "openai/gpt-6.1-sol",
      "openai/gpt-6-luna",
      "google/gemini-3.8-flash",
      "google/gemini-3.5-flash-lite",
      "groq/openai/gpt-oss-120b",
      "groq/openai/gpt-oss-20b",
      "mistral/mistral-large-4",
      "mistral/mistral-small-latest",
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(llms.every((m) => m.curated === true)).toBe(true);
    const haiku = llms.find((m) => m.model_id === "claude-haiku-5-5");
    expect(haiku?.cost_input).toBe(0.1);
    // The stale Groq entry of the old list is gone.
    expect(ids).not.toContain("groq/mistral-saba-24b");
  });

  it("lists the cloud speech models, newest OpenAI model first", async () => {
    const voice = (await available())
      .filter((m) => m.type === "voice")
      .map((m) => m.model_id);
    expect(voice.slice(0, 3)).toEqual([
      "openai/gpt-live-transcribe",
      "openai/gpt-transcribe",
      "openai/gpt-4o-transcribe",
    ]);
    expect(voice).toContain("soniox/stt-rt-v5");
    expect(voice).toContain("deepgram/nova-3");
  });

  it("keeps registry rows, marks legacy ones, hides deprecated ones", async () => {
    online = true;
    const llms = (await available()).filter((m) => m.type === "llm");

    const legacy = llms.find((m) => m.model_id === "gpt-4o-mini");
    expect(legacy?.curated).toBe(false);
    expect(legacy?.notice).toContain("2027-01-14");

    // The registry row and the line-up row of one model show up once.
    expect(llms.filter((m) => m.model_id === "gpt-6-luna")).toHaveLength(1);
    expect(llms.some((m) => m.model_id === "llama-3.1-8b-instant")).toBe(false);
    expect(llms.find((m) => m.model_id === "gpt-6-luna")?.curated).toBe(true);
  });
});
