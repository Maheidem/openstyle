import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";

// ---------------------------------------------------------------------------
// Mocks (hoisted so the route modules see them at import time)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  transcribe: vi.fn(),
  postProcess: vi.fn(),
  decode: vi.fn(),
  beginDictation: vi.fn(),
  endDictation: vi.fn(),
}));

vi.mock("../src/lib/streaming/registry.js", () => ({
  getProvider: () => ({ transcribe: mocks.transcribe }),
}));

vi.mock("../src/lib/streaming-stt.js", () => ({
  getApiKeyForProvider: () => "test-key",
  voiceProviderCategory: () => "byok",
}));

vi.mock("../src/lib/post-process.js", () => ({
  postProcess: mocks.postProcess,
  resolveAppContextForCleanup: (appContext: string | null) => appContext,
  getCleanupAppAssignments: () => [],
  prewarmPostProcess: () => {},
}));

vi.mock("../src/lib/audio/decode.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/lib/audio/decode.js")>();
  return { ...real, decodeToWav16kMono: mocks.decode };
});

vi.mock("../src/lib/dictation-activity.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/lib/dictation-activity.js")>();
  return {
    ...real,
    beginDictation: mocks.beginDictation,
    endDictation: mocks.endDictation,
  };
});

const { AudioDecodeError } = await import("../src/lib/audio/decode.js");
const { createTranscribeFileRoute } = await import(
  "../src/routes/transcribe-file.js"
);
const { default: createApp } = await import("../src/index.js");
const app = createApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WavOpts {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  formatTag?: number;
  samples?: number;
  listChunk?: boolean;
  streamSizes?: boolean;
}

function buildWav(opts: WavOpts = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 16_000;
  const channels = opts.channels ?? 1;
  const bits = opts.bitsPerSample ?? 16;
  const blockAlign = (channels * bits) / 8;
  const samples = opts.samples ?? 160;
  const data = Buffer.alloc(samples * blockAlign);
  for (let i = 0; i + 1 < data.length; i += 2) data.writeInt16LE(i % 1000, i);

  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(opts.formatTag ?? 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * blockAlign, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(bits, 22);

  let list = Buffer.alloc(0);
  if (opts.listChunk) {
    list = Buffer.alloc(12);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(4, 4);
    list.write("INFO", 8, "ascii");
  }
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(opts.streamSizes ? 0xffffffff : data.length, 4);

  const body = Buffer.concat([fmt, list, dataHeader, data]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(opts.streamSizes ? 0xffffffff : 4 + body.length, 4);
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, body]);
}

function formWith(name: string, bytes: Uint8Array, field = "audio"): FormData {
  const form = new FormData();
  form.append(field, new File([bytes], name));
  return form;
}

function postFile(
  form: FormData | BodyInit,
  headers: Record<string, string> = {},
  target: { request: typeof app.request } = app,
): Promise<Response> {
  return target.request("/api/transcribe/file", {
    method: "POST",
    headers,
    body: form,
  });
}

function postDictation(
  headers: Record<string, string> = {},
  body: Uint8Array = new Uint8Array([1, 2, 3, 4]),
): Promise<Response> {
  return app.request("/api/transcribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      ...headers,
    },
    body,
  });
}

function historyRows(): Array<{
  voice_provider: string;
  voice_model: string;
  audio_duration_ms: number | null;
  raw_text: string;
  cleaned_text: string | null;
}> {
  return getDb()
    .prepare(
      "SELECT voice_provider, voice_model, audio_duration_ms, raw_text, cleaned_text FROM transcription_history",
    )
    .all() as ReturnType<typeof historyRows>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/transcribe/file", () => {
  beforeEach(() => {
    // Real timers: the route awaits real async I/O (formData, arrayBuffer).
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.transcribe.mockResolvedValue({ text: "raw import text" });
    mocks.postProcess.mockResolvedValue({
      cleaned: "clean import text",
      llmProvider: "test-llm",
      llmModel: "test-cleaner",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });

    const db = getDb();
    db.exec("DELETE FROM transcription_history");
    db.exec("DELETE FROM model_configs");
    db.prepare(
      `INSERT INTO model_configs
         (provider, model_id, model_name, type, is_default)
         VALUES (?, ?, ?, 'voice', 1)`,
    ).run("test-provider", "test-model", "Test Model");
  });

  afterEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  it("415 for an unsupported extension, before decode or transcribe", async () => {
    const res = await postFile(formWith("notes.txt", buildWav()));

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      error: "Unsupported file type",
      detail: "Accepted extensions: wav, mp3, m4a, aac, ogg, mp4",
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(historyRows()).toHaveLength(0);
  });

  it("400 when the audio part is missing", async () => {
    const res = await postFile(formWith("clip.wav", buildWav(), "other"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "audio field missing or not a file",
    });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("400 for a non-multipart body", async () => {
    const res = await postFile(buildWav(), {
      "Content-Type": "application/octet-stream",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Expected multipart/form-data",
    });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("400 for a malformed multipart body", async () => {
    const res = await postFile("--nope\r\ngarbage", {
      "Content-Type": "multipart/form-data; boundary=nope",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "audio field missing or not a file",
    });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("413 with PAYLOAD_TOO_LARGE when the body exceeds the limit", async () => {
    const mini = new Hono().route(
      "/api/transcribe",
      createTranscribeFileRoute({ maxBytes: 1024 }),
    );
    // 2 KiB of samples → well over a 1 KiB body limit.
    const res = await postFile(
      formWith("big.wav", buildWav({ samples: 1024 })),
      {},
      mini,
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "File too large",
      detail: "Maximum upload size is 1 KiB",
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("422 with a fixed detail (no ffmpeg stderr) when decoding fails, and persists no row", async () => {
    mocks.decode.mockRejectedValue(
      new AudioDecodeError(
        "ffmpeg exited with code 1: /var/tmp/openstyle-decode-abc/input: Invalid data",
        "decode_failed",
      ),
    );
    const res = await postFile(
      formWith("song.mp3", new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0])),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "Audio decode failed",
      detail: "ffmpeg could not decode the file",
      code: "AUDIO_DECODE_FAILED",
      reason: "decode_failed",
    });
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(historyRows()).toHaveLength(0);
  });

  it("500 when STT fails, and persists no row", async () => {
    mocks.transcribe.mockRejectedValue(new Error("stt down"));
    const res = await postFile(formWith("clip.wav", buildWav()));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Transcription failed",
      detail: "stt down",
    });
    expect(historyRows()).toHaveLength(0);
  });

  it("200 for a canonical 16 kHz WAV: no decode, full body, one history row", async () => {
    const wav = buildWav({ samples: 16_000 }); // exactly 1 s
    const res = await postFile(formWith("clip.wav", wav));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      raw: "raw import text",
      cleaned: "clean import text",
      model: "test-model",
      provider_category: "byok",
      audioDurationMs: 1000,
      llmModel: "test-cleaner",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });
    expect(typeof body.durationMs).toBe("number");

    expect(mocks.decode).not.toHaveBeenCalled();
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    const sent = mocks.transcribe.mock.calls[0][0];
    expect(sent.model).toBe("test-model");
    expect(Buffer.from(sent.audio).equals(wav)).toBe(true);
    expect(mocks.postProcess).toHaveBeenCalledTimes(1);

    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      voice_provider: "test-provider",
      voice_model: "test-model",
      audio_duration_ms: 1000,
      raw_text: "raw import text",
      cleaned_text: "clean import text",
    });
  });

  it("200 for an .m4a: decodes the original bytes, duration from the decoded WAV", async () => {
    const input = new Uint8Array(512);
    for (let i = 0; i < input.length; i++) input[i] = (i * 31) & 0xff;
    const decoded = buildWav({ samples: 8_000 }); // 0.5 s
    mocks.decode.mockResolvedValue(decoded);

    const res = await postFile(formWith("memo.m4a", input));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audioDurationMs).toBe(500);

    expect(mocks.decode).toHaveBeenCalledTimes(1);
    expect(
      Buffer.from(mocks.decode.mock.calls[0][0] as Uint8Array).equals(
        Buffer.from(input),
      ),
    ).toBe(true);
    const sent = mocks.transcribe.mock.calls[0][0];
    expect(Buffer.from(sent.audio).equals(decoded)).toBe(true);

    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].audio_duration_ms).toBe(500);
  });

  it("ignores x-skip-post-process on /file: cleanup always runs", async () => {
    const res = await postFile(formWith("clip.wav", buildWav()), {
      "x-skip-post-process": "true",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mocks.postProcess).toHaveBeenCalledTimes(1);
    expect(body.audioDurationMs).toBe(10);
    expect(body.cleaned).toBe("clean import text");
    expect(historyRows()[0].cleaned_text).toBe("clean import text");
  });

  it("takes and releases the dictation lease once per /file request", async () => {
    await postFile(formWith("clip.wav", buildWav()));

    expect(mocks.beginDictation).toHaveBeenCalledTimes(1);
    expect(mocks.endDictation).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/transcribe (dictation regression)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.transcribe.mockResolvedValue({ text: "raw route text" });
    mocks.postProcess.mockResolvedValue({
      cleaned: "clean route text",
      llmProvider: "test-llm",
      llmModel: "test-cleaner",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });

    const db = getDb();
    db.exec("DELETE FROM transcription_history");
    db.exec("DELETE FROM model_configs");
    db.prepare(
      `INSERT INTO model_configs
         (provider, model_id, model_name, type, is_default)
         VALUES (?, ?, ?, 'voice', 1)`,
    ).run("test-provider", "test-model", "Test Model");
  });

  afterEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  it("raw body + x-audio-duration-ms → same success fields as before", async () => {
    const res = await postDictation({ "x-audio-duration-ms": "1000" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      raw: "raw route text",
      cleaned: "clean route text",
      model: "test-model",
      provider_category: "byok",
      audioDurationMs: 1000,
      llmModel: "test-cleaner",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });
    expect(typeof body.durationMs).toBe("number");
    expect(historyRows()).toHaveLength(1);
  });

  it("x-skip-post-process → raw history row, no audioDurationMs, has provider_category", async () => {
    const res = await postDictation({
      "x-audio-duration-ms": "1000",
      "x-skip-post-process": "true",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      raw: "raw route text",
      cleaned: "raw route text",
      model: "test-model",
      provider_category: "byok",
      durationMs: expect.any(Number),
    });
    expect(body).not.toHaveProperty("audioDurationMs");
    expect(mocks.postProcess).not.toHaveBeenCalled();

    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].cleaned_text).toBeNull();
    expect(rows[0].raw_text).toBe("raw route text");
  });
});
