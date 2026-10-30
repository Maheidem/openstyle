import { describe, expect, it } from "vitest";
import { type AvailableModel, buildVoiceItems, VOICE_META } from "./models";

const voice = (provider: string, name: string, id: string): AvailableModel => ({
  provider_id: provider,
  provider_name: name,
  model_id: id,
  model_name: id,
  family: "x",
  type: "voice",
  curated: true,
});

const CLOUD_IDS = [
  "openai/gpt-live-transcribe",
  "openai/gpt-transcribe",
  "openai/gpt-4o-transcribe",
  "groq/whisper-large-v3-turbo",
  "groq/whisper-large-v3",
  "deepgram/nova-3",
  "elevenlabs/scribe_v2_realtime",
  "soniox/stt-rt-v5",
];

describe("cloud speech models in the picker", () => {
  it("has a speed, quality, cost and note for every cloud model", () => {
    for (const id of CLOUD_IDS) {
      const meta = VOICE_META[id];
      expect(meta, id).toBeDefined();
      expect(meta?.note, id).toBeTruthy();
      expect(meta?.cost, id).toBeGreaterThan(0);
    }
  });

  it("builds a row for each OpenAI model and warns about the legacy one", () => {
    const available = CLOUD_IDS.map((id) => {
      const provider = id.split("/")[0] ?? "";
      return voice(provider, provider, id);
    });
    const items = buildVoiceItems(available, null, null, {
      keyProviders: new Set(["openai"]),
    });
    const keys = items.map((i) => i.modelId);
    expect(keys.slice(0, 3)).toEqual([
      "openai/gpt-live-transcribe",
      "openai/gpt-transcribe",
      "openai/gpt-4o-transcribe",
    ]);
    const legacy = items.find((i) => i.modelId === "openai/gpt-4o-transcribe");
    expect(legacy?.note).toContain("2027-02-26");
    expect(legacy?.hasKey).toBe(true);
    expect(items.find((i) => i.modelId === "deepgram/nova-3")?.hasKey).toBe(
      false,
    );
  });
});
