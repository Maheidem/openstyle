import { describe, expect, it } from "vitest";
import {
  findServerModel,
  kindFitsRole,
  type ServerView,
  voiceCannotTranscribe,
} from "./server-roles";

const omlx: ServerView = {
  id: "srv_aaaaaaaa",
  name: "oMLX (127.0.0.1:8123)",
  base_url: "http://127.0.0.1:8123",
  has_key: false,
  flavor: "omlx",
  reachable: true,
  models: [
    { id: "Qwen3-ASR", kind: "speech", kind_source: "server" },
    { id: "Qwen3-TTS", kind: "tts", kind_source: "server" },
    { id: "Qwen3.8-27B", kind: "llm", kind_source: "server" },
    { id: "qwen/qwen3-4b", kind: "unknown", kind_source: "name" },
  ],
};

function voice(modelId: string, provider = "server") {
  return {
    id: 1,
    provider,
    model_id: modelId,
    model_name: modelId,
    type: "voice",
    is_default: 1,
  };
}

describe("kindFitsRole", () => {
  it("lets transcription take speech models only", () => {
    expect(kindFitsRole("speech", "voice")).toBe(true);
    for (const kind of [
      "llm",
      "unknown",
      "embedding",
      "rerank",
      "tts",
      "other",
    ] as const) {
      expect(kindFitsRole(kind, "voice")).toBe(false);
    }
  });

  it("lets every LLM role take llm and unknown", () => {
    expect(kindFitsRole("llm", "llm")).toBe(true);
    expect(kindFitsRole("unknown", "llm")).toBe(true);
    for (const kind of [
      "speech",
      "embedding",
      "rerank",
      "tts",
      "other",
    ] as const) {
      expect(kindFitsRole(kind, "llm")).toBe(false);
    }
  });
});

describe("findServerModel", () => {
  it("joins a model id that holds more slashes", () => {
    const found = findServerModel([omlx], "server/srv_aaaaaaaa/qwen/qwen3-4b");
    expect(found?.server.id).toBe("srv_aaaaaaaa");
    expect(found?.kind).toBe("unknown");
  });

  it("gives no kind for a model that the server does not list", () => {
    expect(
      findServerModel([omlx], "server/srv_aaaaaaaa/gone")?.kind,
    ).toBeNull();
  });

  it("gives null for a removed server", () => {
    expect(findServerModel([omlx], "server/srv_bbbbbbbb/Qwen3-ASR")).toBeNull();
  });
});

describe("voiceCannotTranscribe", () => {
  it("warns for the migrated Qwen3-TTS default", () => {
    expect(
      voiceCannotTranscribe(voice("server/srv_aaaaaaaa/Qwen3-TTS"), [omlx]),
    ).toBe(true);
  });

  it("does not warn for a speech model", () => {
    expect(
      voiceCannotTranscribe(voice("server/srv_aaaaaaaa/Qwen3-ASR"), [omlx]),
    ).toBe(false);
  });

  it("does not warn when the server is down, so it gives no kind", () => {
    const down = { ...omlx, reachable: false, models: [] };
    expect(
      voiceCannotTranscribe(voice("server/srv_aaaaaaaa/Qwen3-TTS"), [down]),
    ).toBe(false);
  });

  it("does not warn for a cloud or built-in voice model", () => {
    expect(
      voiceCannotTranscribe(voice("local-whisper/small", "local-whisper"), [
        omlx,
      ]),
    ).toBe(false);
    expect(voiceCannotTranscribe(undefined, [omlx])).toBe(false);
  });
});
