import { describe, expect, it } from "vitest";
import { buildTranscribeHeaders } from "./transcribe-client";

describe("buildTranscribeHeaders", () => {
  it("always sets the content type and the duration", () => {
    expect(buildTranscribeHeaders({ durationMs: 1234 })).toEqual({
      "Content-Type": "audio/wav",
      "x-audio-duration-ms": "1234",
    });
  });

  it("adds the optional headers only when they have a value", () => {
    expect(
      buildTranscribeHeaders({
        durationMs: 10,
        language: "pt",
        appContext: null,
        skipPostProcess: false,
      }),
    ).toEqual({
      "Content-Type": "audio/wav",
      "x-audio-duration-ms": "10",
      "x-dictation-language": "pt",
    });
    expect(
      buildTranscribeHeaders({ durationMs: 10, skipPostProcess: true }),
    ).toMatchObject({ "x-skip-post-process": "true" });
  });

  it("percent-encodes the app context so the header is byte-safe", () => {
    const headers = buildTranscribeHeaders({
      durationMs: 10,
      appContext: '{"title":"Блокнот"}',
    });
    expect(headers["x-app-context"]).toBe(
      encodeURIComponent('{"title":"Блокнот"}'),
    );
    expect(headers["x-app-context"]).toMatch(/^[\x20-\x7e]+$/);
  });
});
