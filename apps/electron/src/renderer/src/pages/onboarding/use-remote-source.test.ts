import type { AvailableModel } from "@renderer/lib/models";
import { describe, expect, it } from "vitest";
import { cloudModelFor } from "./use-remote-source";

const model = (over: Partial<AvailableModel>): AvailableModel => ({
  provider_id: "openai",
  provider_name: "OpenAI",
  model_id: "x",
  model_name: "x",
  family: "x",
  type: "voice",
  ...over,
});

describe("cloudModelFor", () => {
  it("gives the cheapest voice model that is not planned for removal", () => {
    const list = [
      model({ model_id: "openai/gpt-live-transcribe" }),
      model({ model_id: "openai/gpt-transcribe" }),
      model({ model_id: "openai/gpt-4o-transcribe", notice: "Removed 2027" }),
    ];
    expect(cloudModelFor(list, "voice", "openai")?.model_id).toBe(
      "openai/gpt-transcribe",
    );
  });

  it("gives the first line-up model for text, before any other model", () => {
    const list = [
      model({ type: "llm", provider_id: "anthropic", model_id: "other" }),
      model({
        type: "llm",
        provider_id: "anthropic",
        model_id: "fast",
        curated: true,
        lineup_rank: 1,
      }),
      model({
        type: "llm",
        provider_id: "anthropic",
        model_id: "capable",
        curated: true,
        lineup_rank: 0,
      }),
    ];
    expect(cloudModelFor(list, "llm", "anthropic")?.model_id).toBe("capable");
  });

  it("gives nothing for a provider with no model of the role", () => {
    expect(cloudModelFor([model({})], "llm", "openai")).toBeUndefined();
    expect(cloudModelFor([], "voice", "groq")).toBeUndefined();
  });
});
