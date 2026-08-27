import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";

// Route-level regression test for the 2026-08-27 dictation incident
// (specs/meeting-transcription-quality.md Phase A's vocab-leak filter had
// only ever guarded the meeting pipeline; the REST /api/transcribe path had
// no equivalent guard). Drives the real route — real vocabulary bias
// resolution, real leak-stripping — with only the ASR provider's network
// call mocked, mirroring history-pause-transcribe.test.ts's pattern.

let sttText = "";

vi.mock("../src/lib/streaming/registry.js", () => ({
  getProvider: () => ({
    transcribe: vi.fn().mockImplementation(async () => ({ text: sttText })),
  }),
}));

vi.mock("../src/lib/streaming-stt.js", () => ({
  getApiKeyForProvider: () => "test-key",
  voiceProviderCategory: () => "local",
}));

vi.mock("../src/lib/post-process.js", () => ({
  // Identity cleanup — isolates the assertions to the leak filter, not the
  // (separately tested, and separately mocked in other suites) LLM cleanup
  // pass. Mirrors the real incident's finding: cleanup does not remove a
  // leak on its own, so the filter has to run before it regardless.
  postProcess: vi.fn().mockImplementation(async (rawText: string) => ({
    cleaned: rawText,
    llmProvider: "test-llm",
    llmModel: "test-cleaner",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  })),
  resolveAppContextForCleanup: (appContext: string | null) => appContext,
  getCleanupAppAssignments: () => [],
}));

const { default: createApp } = await import("../src/index.js");
const app = createApp();

const VOCAB_TERMS = Array.from({ length: 80 }, (_, i) => `Zylotrix${i + 1}`);
const REAL_SPEECH =
  "While you wait, why don't you launch a deep research on the subject about the best practices for this?";

function transcribe(headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/api/transcribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-audio-duration-ms": "1000",
      ...headers,
    },
    body: new Uint8Array([1, 2, 3, 4]),
  });
}

describe("dictation vocabulary-leak filter (REST /api/transcribe)", () => {
  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM transcription_history");
    db.exec("DELETE FROM model_configs");
    db.exec("DELETE FROM vocabulary");
    // omlx: the provider from the confirmed incident — resolves to the
    // "Technical terms: ..." prompt-bias shape (vocabulary-bias.ts).
    db.prepare(
      `INSERT INTO model_configs
         (provider, model_id, model_name, type, is_default)
         VALUES (?, ?, ?, 'voice', 1)`,
    ).run("omlx", "omlx/Qwen3-ASR", "Qwen3-ASR");
    for (const term of VOCAB_TERMS) {
      db.prepare("INSERT INTO vocabulary (term) VALUES (?)").run(term);
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty output when the ASR response is entirely the vocabulary-prompt echo (the confirmed incident)", async () => {
    sttText = `Technical terms: ${VOCAB_TERMS.join(", ")}`;

    const res = await transcribe({ "x-dictation-language": "en" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { raw: string; cleaned: string };
    expect(body.raw).toBe("");
    expect(body.cleaned).toBe("");
  });

  it("strips the leak and keeps the real speech when the echo trails real speech", async () => {
    sttText = `${REAL_SPEECH} Technical terms: ${VOCAB_TERMS.join(", ")}`;

    const res = await transcribe({ "x-dictation-language": "en" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { raw: string; cleaned: string };
    expect(body.raw).toBe(REAL_SPEECH);
    expect(body.cleaned).toBe(REAL_SPEECH);
  });

  it("passes ordinary speech through unchanged", async () => {
    sttText = REAL_SPEECH;

    const res = await transcribe({ "x-dictation-language": "en" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { raw: string; cleaned: string };
    expect(body.raw).toBe(REAL_SPEECH);
    expect(body.cleaned).toBe(REAL_SPEECH);
  });

  it("does not flag speech that merely mentions one vocabulary term", async () => {
    sttText = `so the plan is to ship ${VOCAB_TERMS[0]} next week once qa signs off`;

    const res = await transcribe({ "x-dictation-language": "en" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { raw: string; cleaned: string };
    expect(body.raw).toBe(sttText);
  });
});
