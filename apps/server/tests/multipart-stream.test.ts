/**
 * Unit tests for the streaming multipart parser
 * (src/lib/audio/multipart-stream.ts, specs/import-streaming.md).
 *
 * The parser is fed synthetic bodies — mostly via `chunked()` so every
 * delimiter/line boundary straddles read boundaries, which is the case that
 * breaks naive parsers.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractBoundary,
  MAX_FIELD_BYTES,
  MAX_HEADER_BYTES,
  MultipartStreamError,
  requestBodyTooLarge,
  type StreamedForm,
  streamMultipartForm,
} from "../src/lib/audio/multipart-stream.js";

const BOUNDARY = "----openstyle-test-boundary";

let tempRoots: string[] = [];

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "multipart-test-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

/** Build a canonical 16 kHz mono PCM16 WAV (content is irrelevant here). */
function wav(samples = 4): Buffer {
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

/** Serialize parts the way undici's FormData does. */
function multipart(
  parts: Array<Record<string, unknown>>,
  boundary = BOUNDARY,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let disposition = `form-data; name="${part.name as string}"`;
    if (typeof part.filename === "string") {
      disposition += `; filename="${part.filename}"`;
    }
    chunks.push(Buffer.from(`Content-Disposition: ${disposition}\r\n`));
    if (part.contentType) {
      chunks.push(
        Buffer.from(`Content-Type: ${part.contentType as string}\r\n`),
      );
    }
    chunks.push(Buffer.from("\r\n"));
    chunks.push(Buffer.from(part.body as Buffer));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/** A ReadableStream that yields the body in `size`-byte chunks. */
function chunked(body: Buffer, size = 1): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    Readable.from(
      (function* () {
        for (let i = 0; i < body.length; i += size) {
          yield body.subarray(i, Math.min(body.length, i + size));
        }
      })(),
    ),
  ) as ReadableStream<Uint8Array>;
}

async function parse(
  body: Buffer | ReadableStream<Uint8Array>,
  opts: { boundary?: string | null; maxTotalBytes?: number } = {},
): Promise<StreamedForm> {
  return streamMultipartForm(
    body instanceof Buffer ? chunked(body) : body,
    opts.boundary === undefined ? BOUNDARY : opts.boundary,
    {
      maxTotalBytes: opts.maxTotalBytes ?? 1024 * 1024 * 1024,
      tempDir: newTempDir(),
    },
  );
}

async function expectMalformed(
  p: Promise<unknown>,
): Promise<MultipartStreamError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MultipartStreamError);
    expect((err as MultipartStreamError).kind).toBe("malformed");
    return err as MultipartStreamError;
  }
  throw new Error("expected streamMultipartForm to reject");
}

async function expectTooLarge(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MultipartStreamError);
    expect((err as MultipartStreamError).kind).toBe("too_large");
    return;
  }
  throw new Error("expected streamMultipartForm to reject with too_large");
}

// ---------------------------------------------------------------------------
// extractBoundary / requestBodyTooLarge
// ---------------------------------------------------------------------------

describe("extractBoundary", () => {
  it("reads bare and quoted parameters", () => {
    expect(extractBoundary("multipart/form-data; boundary=abc123")).toBe(
      "abc123",
    );
    expect(extractBoundary('multipart/form-data; boundary="a; b\\c"')).toBe(
      "a; b\\c",
    );
  });

  it("is case-insensitive about the parameter name", () => {
    expect(extractBoundary("multipart/form-data; BOUNDARY=x")).toBe("x");
  });

  it("rejects missing, empty, oversized, or line-breaking values", () => {
    expect(extractBoundary("multipart/form-data")).toBeNull();
    expect(extractBoundary("multipart/form-data; boundary=")).toBeNull();
    expect(
      extractBoundary(`multipart/form-data; boundary=${"a".repeat(201)}`),
    ).toBeNull();
    expect(
      extractBoundary('multipart/form-data; boundary="a\r\nb"'),
    ).toBeNull();
  });
});

describe("requestBodyTooLarge", () => {
  it("rejects on a known content-length over the cap", () => {
    expect(requestBodyTooLarge("2000", undefined, 1000)).toBe(true);
    expect(requestBodyTooLarge("1000", undefined, 1000)).toBe(false);
    expect(requestBodyTooLarge(undefined, undefined, 1000)).toBe(false);
    expect(requestBodyTooLarge("garbage", undefined, 1000)).toBe(false);
  });

  it("ignores the header when transfer-encoding is present", () => {
    expect(requestBodyTooLarge("9999999", "chunked", 1000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("streamMultipartForm", () => {
  it("streams one file part to disk with its filename and byte count", async () => {
    const audio = wav(160);
    const form = await parse(
      multipart([{ name: "audio", filename: "memo.m4a", body: audio }]),
    );

    expect(form.fields.size).toBe(0);
    const file = form.files.get("audio")!;
    expect(file).toBeDefined();
    expect(file.filename).toBe("memo.m4a");
    expect(file.bytes).toBe(audio.length);
    expect(readFileSync(file.path).equals(audio)).toBe(true);
    // Server-chosen temp names, never the client filename.
    expect(file.path).toMatch(/\/p0$/);
  });

  it("classifies parts by the presence of a filename parameter", async () => {
    const form = await parse(
      multipart([
        { name: "audio", filename: "a.wav", body: wav() },
        {
          name: "id",
          body: Buffer.from("11111111-1111-4111-8111-111111111111"),
        },
        {
          name: "audio_dir",
          body: Buffer.from("/tmp/11111111-1111-4111-8111-111111111111"),
        },
        { name: "started_at", body: Buffer.from("1700000000000") },
      ]),
    );

    expect(form.files.has("id")).toBe(false);
    expect(form.fields.get("id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(form.fields.get("started_at")).toBe("1700000000000");
    expect(form.files.size).toBe(1);
  });

  it("treats an empty filename as a file part (FormData.get semantics)", async () => {
    const form = await parse(
      multipart([{ name: "audio", filename: "", body: wav() }]),
    );
    expect(form.files.get("audio")!.filename).toBe("");
  });

  it("keeps only the first occurrence of a name, like FormData.get", async () => {
    const first = wav(10);
    const second = wav(20);
    const dir = newTempDir();
    const form = await streamMultipartForm(
      chunked(
        multipart([
          { name: "audio", filename: "first.wav", body: first },
          { name: "audio", filename: "second.wav", body: second },
          { name: "id", body: Buffer.from("one") },
          { name: "id", body: Buffer.from("two") },
        ]),
      ),
      BOUNDARY,
      { maxTotalBytes: 1024 * 1024, tempDir: dir },
    );

    expect(form.files.get("audio")!.filename).toBe("first.wav");
    expect(readFileSync(form.files.get("audio")!.path).equals(first)).toBe(
      true,
    );
    expect(form.fields.get("id")).toBe("one");
    // The dropped duplicate left no file behind.
    expect(readdirSync(dir)).toEqual([
      form.files.get("audio")!.path.split("/").pop(),
    ]);
  });

  it("decodes quoted-string escapes in filenames", async () => {
    const form = await parse(
      multipart([
        {
          name: "audio",
          // undici percent-encodes; other producers may backslash-escape —
          // both must arrive verbatim.
          filename: 'weird \\" quote',
          body: wav(),
        },
      ]),
    );
    expect(form.files.get("audio")!.filename).toBe('weird " quote');
  });

  it("tolerates a preamble and an epilogue around the parts", async () => {
    const body = Buffer.concat([
      Buffer.from("this is a preamble, ignored\r\n"),
      multipart([{ name: "audio", filename: "a.wav", body: wav() }]),
      Buffer.from("epilogue junk -- almost a boundary"),
    ]);
    const form = await parse(body);
    expect(form.files.get("audio")!.bytes).toBe(wav().length);
  });

  it("tolerates transport padding and a missing final CRLF", async () => {
    const audio = wav();
    const body = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}  \r\n` +
          `Content-Disposition: form-data; name="audio"; filename="a.wav"\r\n` +
          `\r\n`,
      ),
      audio,
      Buffer.from(`\r\n--${BOUNDARY}--`),
    ]);
    const form = await parse(body);
    expect(form.files.get("audio")!.bytes).toBe(audio.length);
  });

  it("survives 1-byte reads (every boundary straddles chunks)", async () => {
    const audio = wav(1000);
    const body = multipart([
      { name: "audio", filename: "a.wav", body: audio },
      { name: "id", body: Buffer.from("x".repeat(50)) },
    ]);
    const form = await parse(body); // chunked(body, 1)
    expect(readFileSync(form.files.get("audio")!.path).equals(audio)).toBe(
      true,
    );
    expect(form.fields.get("id")).toBe("x".repeat(50));
  });

  it("passes delimiter lookalikes through as part data", async () => {
    // Data that contains the boundary WITHOUT the leading CRLF, a partial
    // delimiter, and a boundary followed by garbage — all literal data.
    const data = Buffer.concat([
      Buffer.from(`--${BOUNDARY}not-a-delimiter\r\n--${BOUNDARY.slice(0, 5)}`),
      wav(5),
      Buffer.from(`\r\n--${BOUNDARY.slice(0, -1)}x`),
    ]);
    const form = await parse(
      multipart([{ name: "audio", filename: "a.wav", body: data }]),
    );
    expect(readFileSync(form.files.get("audio")!.path).equals(data)).toBe(true);
  });

  it("handles an empty file part (zero bytes)", async () => {
    const form = await parse(
      multipart([{ name: "audio", filename: "a.wav", body: Buffer.alloc(0) }]),
    );
    expect(form.files.get("audio")!.bytes).toBe(0);
    expect(statSync(form.files.get("audio")!.path).size).toBe(0);
  });

  it("decodes field values as UTF-8", async () => {
    const form = await parse(
      multipart([{ name: "title", body: Buffer.from("réunion", "utf8") }]),
    );
    expect(form.fields.get("title")).toBe("réunion");
  });

  it("ignores parts without a name and junk header lines", async () => {
    const body = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Type: text/plain\r\n` + // no Content-Disposition
          `junk-line-without-colon-would-be-ignored-anyway\r\n` +
          `X-Custom: 1\r\n` +
          `\r\n` +
          `ignored body\r\n` +
          `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="audio"; filename="a.wav"\r\n` +
          `\r\n`,
      ),
      wav(),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    const form = await parse(body);
    expect(form.files.size).toBe(1);
    expect(form.fields.size).toBe(0);
  });

  it("counts total body bytes including framing (epilogue unread)", async () => {
    const body = multipart([
      { name: "audio", filename: "a.wav", body: wav() },
      { name: "id", body: Buffer.from("abc") },
    ]);
    const form = await parse(body);
    // The final `--` ends the body; the trailing CRLF epilogue is never read.
    expect(form.totalBytes).toBe(body.length - 2);
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("streamMultipartForm failures", () => {
  it("rejects a body with no boundary at all", async () => {
    await expectMalformed(
      parse(Buffer.from("just some bytes, no delimiter in here")),
    );
  });

  it("rejects an unterminated part (EOF mid-data)", async () => {
    const body = multipart([
      { name: "audio", filename: "a.wav", body: wav() },
    ]).subarray(0, -BOUNDARY.length - 6); // chop off the close delimiter
    await expectMalformed(parse(body));
  });

  it("yields an empty form for bare-LF framing (routes answer the same 400)", async () => {
    // undici's `formData()` rejects bare-LF; this parser simply finds no
    // parts (the only CRLF-terminated line is the final delimiter), which
    // lands the request in the same "missing audio part" 400 at the route.
    const body = Buffer.from(
      `--${BOUNDARY}\n` +
        `Content-Disposition: form-data; name="audio"; filename="a.wav"\n\n` +
        `${wav().toString("binary")}\n--${BOUNDARY}--\n`,
    );
    const form = await parse(Buffer.from(body, "binary"));
    expect(form.files.size).toBe(0);
    expect(form.fields.size).toBe(0);
  });

  it("rejects a missing boundary parameter", async () => {
    await expectMalformed(parse(wav(), { boundary: null }));
  });

  it("rejects a null body", async () => {
    await expectMalformed(
      streamMultipartForm(null, BOUNDARY, {
        maxTotalBytes: 1024,
        tempDir: newTempDir(),
      }),
    );
  });

  it("rejects an oversized text part", async () => {
    await expectMalformed(
      parse(
        multipart([{ name: "title", body: Buffer.alloc(MAX_FIELD_BYTES + 1) }]),
      ),
    );
  });

  it("rejects an oversized header block", async () => {
    const body = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\n`),
      Buffer.from(`X-Big: ${"a".repeat(MAX_HEADER_BYTES + 1)}\r\n\r\n`),
      wav(),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    await expectMalformed(parse(body));
  });

  it("rejects mid-stream once total body bytes pass the cap", async () => {
    const body = multipart([
      { name: "audio", filename: "a.wav", body: wav(600) },
    ]);
    await expectTooLarge(parse(body, { maxTotalBytes: 100 }));
  });

  it("rejects a lying content-length mid-stream the same way (chunked shape)", async () => {
    // Same body, fed in 7-byte chunks: the cap must trip regardless of how
    // the reads land.
    const body = multipart([
      { name: "audio", filename: "a.wav", body: wav(600) },
    ]);
    const stream = chunked(body, 7);
    await expectTooLarge(
      streamMultipartForm(stream, BOUNDARY, {
        maxTotalBytes: 100,
        tempDir: newTempDir(),
      }),
    );
  });

  it("leaves no temp files behind on any failure path", async () => {
    const dir = newTempDir();
    const attempts: Array<Promise<unknown>> = [
      // Cap trips mid-data, after the part's temp file already exists.
      streamMultipartForm(
        chunked(
          multipart([{ name: "audio", filename: "a.wav", body: wav(600) }]),
        ),
        BOUNDARY,
        { maxTotalBytes: 150, tempDir: dir },
      ).catch((e) => e),
      streamMultipartForm(chunked(Buffer.from("no boundary here")), BOUNDARY, {
        maxTotalBytes: 1024,
        tempDir: dir,
      }).catch((e) => e),
      streamMultipartForm(
        chunked(
          Buffer.concat([
            Buffer.from(`--${BOUNDARY}\r\n`),
            Buffer.from(
              `Content-Disposition: form-data; name="audio"; filename="a.wav"\r\n\r\n`,
            ),
            wav(5000),
            // EOF mid-part
          ]),
        ),
        BOUNDARY,
        { maxTotalBytes: 1024, tempDir: dir },
      ).catch((e) => e),
    ];
    for (const p of attempts) await p;
    expect(readdirSync(dir)).toEqual([]);
  });
});
