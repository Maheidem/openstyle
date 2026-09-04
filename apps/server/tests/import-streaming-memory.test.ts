/**
 * Memory-shape tests for the streaming import routes
 * (specs/import-streaming.md §4.4).
 *
 * Runs a real @hono/node-server listener and uploads a ~160 MB synthetic WAV
 * through a real `fetch`, streaming the request body from a temp file so the
 * *client* side never holds it either. `process.memoryUsage().arrayBuffers`
 * is the metric: it counts Node Buffer / ArrayBuffer backing stores exactly,
 * which is where the old `formData()` + `arrayBuffer()` + stdout-collection
 * buffering lived (2–3× upload). rss/heapUsed are logged for the record.
 *
 * Two assertion shapes:
 * - **At the live peak** (sampled inside the mocked provider call, while the
 *   request is still being served): the single read-back WAV is live, nothing
 *   bigger may be — < 1.3× upload. The old design held ≥2× live at this
 *   exact instant, so the bound separates the shapes without trusting GC.
 * - **Post-response** for the paths that never allocate anything full-size
 *   (meetings happy path, decode-to-small): < 40 MB delta after a settle.
 *
 * Skipped with OPENSTYLE_SKIP_MEMORY_TESTS=1 (a local-only escape hatch if a
 * CI runner ever reports noisy allocator numbers; see the spec's rollout
 * note).
 */
import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  openAsBlob,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getDb } from "../src/lib/db.js";

const SKIP = process.env.OPENSTYLE_SKIP_MEMORY_TESTS === "1";
/** ~160 MB of 16 kHz mono PCM16 ≈ 83 minutes of audio. */
const BIG_WAV_BYTES = 160 * 1024 * 1024;
/** Post-response delta bound for the no-full-hold paths. */
const FLAT_DELTA_MB = 40;

const mocks = vi.hoisted(() => ({
  transcribe: vi.fn(),
  postProcess: vi.fn(),
  decode: vi.fn(),
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
  return { ...real, decodeFileToWav16kMono: mocks.decode };
});

const { default: createApp } = await import("../src/index.js");
const { serve } = await import("@hono/node-server");

const BOUNDARY = "----openstyle-memory-test";

function buildWav(samples: number): Buffer {
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16_000, 24);
  h.writeUInt32LE(32_000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Write a large canonical WAV incrementally (bounded client memory). */
async function writeBigWav(path: string, totalBytes: number): Promise<void> {
  const dataBytes = totalBytes - 44;
  const h = buildWav(0).subarray(0, 44);
  h.writeUInt32LE(dataBytes, 40); // data chunk size
  h.writeUInt32LE(36 + dataBytes, 4); // riff size
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path);
    out.on("error", reject);
    out.write(h);
    const block = Buffer.alloc(1024 * 1024);
    let remaining = dataBytes;
    while (remaining > 0) {
      const n = Math.min(block.length, remaining);
      out.write(n === block.length ? block : block.subarray(0, n));
      remaining -= n;
    }
    out.end(() => resolve());
  });
}

function multipartHead(filename = "big.wav"): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
      `Content-Type: audio/wav\r\n` +
      `\r\n`,
  );
}

function multipartTail(): Buffer {
  return Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
}

const suite = SKIP ? describe.skip : describe;

suite("import streaming memory shape", () => {
  let server: ReturnType<typeof serve>;
  let port: number;
  let bigWavPath: string;
  let tempRoot: string;

  /** arrayBuffers (MB), for assertions and the report line. */
  const allocMB = () =>
    Math.round(process.memoryUsage().arrayBuffers / (1024 * 1024));

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
    // CI runs vitest with NODE_OPTIONS=--expose-gc (see
    // .github/workflows/build.yml) so this gc() is a real full collection;
    // without the flag the pressure loop below is the fallback that nudges
    // V8's external-memory accounting past a GC threshold so the streaming
    // garbage from the request is collectable before sampling.
    (globalThis as { gc?: () => void }).gc?.();
    for (let i = 0; i < 6; i++) {
      const pressure = Buffer.alloc(32 * 1024 * 1024);
      pressure[0] = i;
      await new Promise((r) => setTimeout(r, 10));
    }
    (globalThis as { gc?: () => void }).gc?.();
    await new Promise((r) => setTimeout(r, 50));
  }

  /**
   * Stream the big WAV from disk, optionally corrupting the first chunk's
   * declared data size (byte 40) so `needsDecodeFile` sends it through the
   * decode seam even though it is named `.m4a`.
   */
  async function* fileChunks(corruptHeader: boolean): AsyncGenerator<Buffer> {
    if (!corruptHeader) {
      yield* createReadStream(bigWavPath);
      return;
    }
    const { open } = await import("node:fs/promises");
    const fh = await open(bigWavPath, "r");
    try {
      const first = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(first, 0, first.length, 0);
      first[40] ^= 0xff; // declared data size no longer matches the file
      yield first.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    yield* createReadStream(bigWavPath, { start: 64 * 1024 });
  }

  /** POST the big WAV as multipart to `route`, streamed from disk (chunked). */
  async function postChunked(
    route: string,
    extraFields: Record<string, string> = {},
    filename = "big.wav",
    opts: { corruptHeader?: boolean } = {},
  ): Promise<Response> {
    const fields = Object.entries(extraFields)
      .map(
        ([k, v]) =>
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      )
      .join("");
    const body = Readable.toWeb(
      Readable.from(
        (async function* () {
          yield Buffer.from(fields);
          yield multipartHead(filename);
          // Stream from disk; never materialize the WAV client-side.
          yield* fileChunks(opts.corruptHeader === true);
          yield multipartTail();
        })(),
      ),
    ) as unknown as ReadableStream<Uint8Array>;
    return fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      body,
      // @ts-expect-error -- duplex is valid for streamed fetch bodies
      duplex: "half",
    });
  }

  beforeAll(async () => {
    vi.useRealTimers();
    tempRoot = mkdtempSync(join(tmpdir(), "import-mem-test-"));
    bigWavPath = join(tempRoot, "big.wav");
    await writeBigWav(bigWavPath, BIG_WAV_BYTES);

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
        resolve(),
      );
    });
    port = (server.address() as AddressInfo).port;

    const db = getDb();
    db.exec("DELETE FROM transcription_history");
    db.exec("DELETE FROM model_configs");
    db.prepare(
      `INSERT INTO model_configs
         (provider, model_id, model_name, type, is_default)
         VALUES (?, ?, ?, 'voice', 1)`,
    ).run("test-provider", "test-model", "Test Model");
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempRoot, { recursive: true, force: true });
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  beforeEach(() => {
    mocks.transcribe.mockReset();
    mocks.postProcess.mockReset();
    mocks.decode.mockReset();
    mocks.transcribe.mockResolvedValue({ text: "raw import text" });
    mocks.postProcess.mockResolvedValue({
      cleaned: "clean import text",
      llmProvider: "test-llm",
      llmModel: "test-cleaner",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    // Default decode seam: small canonical WAV (decode-to-small shapes).
    mocks.decode.mockImplementation(async (_input: string, output: string) => {
      const decoded = buildWav(8_000); // 0.5 s
      writeFileSync(output, decoded);
      return { bytes: decoded.length };
    });
    getDb().exec("DELETE FROM meetings");
  });

  afterEach(async () => {
    await settle();
  });

  it("meetings import never holds the upload (pass-through, chunked)", async () => {
    const id = "aaaa7aaa-aaaa-4aaa-8aaa-aaaaaaa11111";
    const audioDir = join(tempRoot, id);
    await settle();
    const before = allocMB();

    const res = await postChunked("/api/meetings/import", {
      id,
      audio_dir: audioDir,
    });

    if (res.status !== 201)
      process.stdout.write(
        `DEBUG: ${res.status} ${JSON.stringify(await res.json())}\n`,
      );
    expect(res.status).toBe(201);
    expect(statSync(join(audioDir, "system.wav")).size).toBe(BIG_WAV_BYTES);
    await settle();
    const after = allocMB();
    console.log(
      `[mem] meetings pass-through ${BIG_WAV_BYTES >> 20} MB upload: arrayBuffers delta ${after - before} MB (limit ${FLAT_DELTA_MB} MB)`,
    );
    expect(after - before).toBeLessThan(FLAT_DELTA_MB);
  }, 120_000);

  it("dictation import holds ≈1× at the provider call (pass-through, chunked)", async () => {
    let sampledAtProvider = 0;
    mocks.transcribe.mockImplementation(async () => {
      // Settle before sampling: the metric is *reachable* memory at the
      // pipeline's peak (the read-back WAV), not streamed-request garbage
      // V8 hasn't bothered to collect mid-request. On some runners
      // (ubuntu CI, different V8) the upload's chunk buffers sit
      // uncollected in arrayBuffers for the whole request — sampling raw
      // there reads ~2× and fails even though nothing references them.
      // The read-back WAV is still referenced by the caller and survives
      // any settle, which is exactly what this bound asserts.
      await settle();
      sampledAtProvider = allocMB();
      return { text: "raw import text" };
    });
    await settle();
    const before = allocMB();

    const res = await postChunked("/api/transcribe/file");

    expect(res.status).toBe(200);
    const delta = sampledAtProvider - before;
    const uploadMB = BIG_WAV_BYTES >> 20;
    console.log(
      `[mem] dictation pass-through ${uploadMB} MB upload: live at provider = ${delta} MB (limit ${(uploadMB * 1.3) | 0} MB)`,
    );
    // ~1× live (the read-back WAV) is the design; the old buffering held
    // ≥2× live at this exact point.
    expect(delta).toBeLessThan(uploadMB * 1.3);
  }, 120_000);

  it("dictation import with a small decode stays flat", async () => {
    let sampledAtProvider = 0;
    mocks.transcribe.mockImplementation(async () => {
      // Same settle-before-sample as above: reachable memory only.
      await settle();
      sampledAtProvider = allocMB();
      return { text: "raw import text" };
    });
    await settle();
    const before = allocMB();

    const res = await postChunked("/api/transcribe/file", {}, "memo.m4a", {
      corruptHeader: true,
    });

    expect(res.status).toBe(200);
    expect(mocks.decode).toHaveBeenCalledTimes(1);
    const delta = sampledAtProvider - before;
    console.log(
      `[mem] dictation decode-to-small ${BIG_WAV_BYTES >> 20} MB upload: live at provider = ${delta} MB (limit ${FLAT_DELTA_MB} MB)`,
    );
    expect(delta).toBeLessThan(FLAT_DELTA_MB);
  }, 120_000);

  it("meetings import with a small decode stays flat", async () => {
    const id = "bbbb8bbb-bbbb-4bbb-8bbb-bbbbbbb22222";
    const audioDir = join(tempRoot, id);
    await settle();
    const before = allocMB();

    const res = await postChunked(
      "/api/meetings/import",
      { id, audio_dir: audioDir },
      "memo.m4a",
      { corruptHeader: true },
    );

    expect(res.status).toBe(201);
    expect(mocks.decode).toHaveBeenCalledTimes(1);
    await settle();
    const after = allocMB();
    console.log(
      `[mem] meetings decode-to-small ${BIG_WAV_BYTES >> 20} MB upload: arrayBuffers delta ${after - before} MB (limit ${FLAT_DELTA_MB} MB)`,
    );
    expect(after - before).toBeLessThan(FLAT_DELTA_MB);
  }, 120_000);

  it("meetings import with content-length (file-backed blob body)", async () => {
    const id = "cccc9ccc-cccc-4ccc-8ccc-ccccc3333333";
    const audioDir = join(tempRoot, id);
    await settle();
    const before = allocMB();

    // The whole multipart body pre-assembled on disk, then sent as one
    // file-backed blob — undici computes content-length from it, and the
    // client still never holds the audio in memory.
    const fields =
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${id}\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="audio_dir"\r\n\r\n${audioDir}\r\n`;
    const bodyPath = join(tempRoot, "content-length-body.bin");
    await new Promise<void>((resolve, reject) => {
      // head + wav + tail, streamed to disk
      const out = createWriteStream(bodyPath);
      out.on("error", reject);
      out.write(Buffer.from(fields));
      out.write(multipartHead());
      createReadStream(bigWavPath)
        .on("data", (c) => out.write(c))
        .on("end", () => out.write(multipartTail()))
        .on("close", () => out.end(() => resolve()))
        .on("error", reject);
    });
    const blob = await openAsBlob(bodyPath);
    const res = await fetch(`http://127.0.0.1:${port}/api/meetings/import`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      body: blob,
    });

    if (res.status !== 201)
      process.stdout.write(
        `DEBUG: ${res.status} ${JSON.stringify(await res.json())}\n`,
      );
    expect(res.status).toBe(201);
    expect(statSync(join(audioDir, "system.wav")).size).toBe(BIG_WAV_BYTES);
    await settle();
    const after = allocMB();
    // No memory assertion here on purpose: undici's fetch *client*
    // materializes a blob body before sending (measured: a 160 MB
    // file-backed blob costs 160 MB client-side), so a process-wide delta
    // would measure the client, not the server. The server-side bound for
    // this shape is covered by the parser unit tests (1-byte-chunk reads)
    // and the route tests.
    console.log(
      `[mem] meetings pass-through (content-length) ${BIG_WAV_BYTES >> 20} MB upload: 201 OK; process-wide arrayBuffers delta ${after - before} MB is client-dominated (undici materializes the blob) — not asserted`,
    );
  }, 120_000);
});
