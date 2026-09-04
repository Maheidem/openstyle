/**
 * Streaming `multipart/form-data` parser for the two file-import routes
 * (specs/import-streaming.md).
 *
 * `c.req.formData()` / `arrayBuffer()` buffer the *entire* upload in memory;
 * with `MAX_IMPORT_BYTES` = 1 GiB that is 2–3× the upload in RSS inside the
 * Electron main process (the server is embedded in-process), where an OOM
 * kills the whole app. This parser consumes the request body as a
 * `ReadableStream`, writes every *file* part straight to a temp file and
 * keeps only bounded chunks in memory. It also enforces the upload ceiling
 * **while streaming**, replacing `hono/body-limit` (whose no-content-length
 * path buffers the whole body itself).
 *
 * Accepted grammar — the RFC 2046 subset undici's FormData serializer (the
 * only producer, via Electron main's `fetch`) emits. Strict CRLF framing;
 * preamble and epilogue tolerated; bare-LF bodies are malformed (the same
 * verdict undici's own parser reaches). `filename*=` (RFC 5987) is not
 * decoded — no producer emits it, and undici percent-encodes rather than
 * backslash-escapes names, which this parser passes through uninterpreted
 * exactly like `FormData` does.
 *
 * Nothing in here imports Hono, the DB, or electron.
 */

import { type FileHandle, open, unlink } from "node:fs/promises";

export type MultipartStreamFailure = "malformed" | "too_large";

/** Parser failure. `kind` maps 1:1 onto the routes' pre-existing envelopes. */
export class MultipartStreamError extends Error {
  constructor(
    readonly kind: MultipartStreamFailure,
    message: string,
  ) {
    super(message);
    this.name = "MultipartStreamError";
  }
}

/** Cap on one text part (hardening; real fields are tiny). Over → malformed. */
export const MAX_FIELD_BYTES = 64 * 1024;
/** Cap on one part's header block. Over → malformed. */
export const MAX_HEADER_BYTES = 16 * 1024;
/** Longest boundary accepted (RFC 2046 suggests ≤ 70 chars). */
export const MAX_BOUNDARY_CHARS = 200;

/** A file part streamed to disk under the caller-provided temp dir. */
export interface StreamedFilePart {
  /** Temp file path (caller-owned dir; route removes the whole dir). */
  path: string;
  /** Filename from `Content-Disposition` (may be ""; never null here). */
  filename: string;
  /** Bytes written. */
  bytes: number;
}

export interface StreamedForm {
  /** Parts that carried a `filename` (a `File` to `FormData.get`), by field name. */
  files: Map<string, StreamedFilePart>;
  /** Text parts by field name. */
  fields: Map<string, string>;
  /** Total request-body bytes consumed (framing included, bodyLimit semantics). */
  totalBytes: number;
}

export interface StreamMultipartOptions {
  /** Reject once this many body bytes have been read (413 at the route). */
  maxTotalBytes: number;
  /** Directory for streamed file parts. Caller creates and removes it. */
  tempDir: string;
}

/**
 * `boundary=` parameter of a `multipart/form-data` content-type — quoted or
 * bare token — or null when absent/oversized/containing line breaks.
 */
export function extractBoundary(contentType: string): string | null {
  const m = /;\s*boundary=(?:"([^"]*)"|([^";\s]+))/i.exec(contentType) ?? null;
  const boundary = m?.[1] ?? m?.[2] ?? null;
  if (
    !boundary ||
    boundary.length === 0 ||
    boundary.length > MAX_BOUNDARY_CHARS ||
    /[\r\n]/.test(boundary)
  ) {
    return null;
  }
  return boundary;
}

/**
 * Today's `bodyLimit` behavior for requests with a known size: reject on the
 * `content-length` header alone, before any parsing. (Chunked requests get
 * the streaming bound inside `streamMultipartForm` instead.)
 */
export function requestBodyTooLarge(
  contentLength: string | undefined,
  transferEncoding: string | undefined,
  maxBytes: number,
): boolean {
  if (contentLength === undefined || transferEncoding !== undefined) {
    return false;
  }
  const n = Number(contentLength);
  return Number.isFinite(n) && n > maxBytes;
}

interface PartState {
  name: string | null;
  filename: string | null;
  /** File part: open handle + written bytes. */
  handle: FileHandle | null;
  path: string | null;
  bytes: number;
  /** Field part: accumulated chunks + cap accounting. */
  chunks: Buffer[];
  fieldBytes: number;
}

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const SP = 0x20;
const HT = 0x09;
const CRLF = Buffer.from("\r\n");

/**
 * Parse `body` incrementally. File parts are written into `opts.tempDir`
 * (each as `p<n>`, a server-chosen name — client filenames are never used as
 * paths); text parts are decoded UTF-8. First occurrence of a field name
 * wins, matching `FormData.get()`; duplicate files' temp files are removed.
 *
 * On failure the parser closes its open handle and unlinks every temp file
 * it created (the dir itself stays — the caller owns it).
 */
export async function streamMultipartForm(
  body: ReadableStream<Uint8Array> | null | undefined,
  boundary: string | null,
  opts: StreamMultipartOptions,
): Promise<StreamedForm> {
  if (!boundary) {
    throw new MultipartStreamError("malformed", "missing boundary parameter");
  }
  if (!body) {
    throw new MultipartStreamError("malformed", "no request body");
  }
  const dash = Buffer.from(`--${boundary}`);
  const crlfDash = Buffer.concat([CRLF, dash]);

  const files = new Map<string, StreamedFilePart>();
  const fields = new Map<string, string>();
  const createdPaths: string[] = [];
  const reader = body.getReader();

  let buf: Buffer = Buffer.alloc(0);
  let totalBytes = 0;
  let part: PartState | null = null;
  let partCounter = 0;
  let headerBytes = 0;
  /** True once the first real part has opened (vs still scanning a preamble). */
  let inBody = false;
  let state: "preamble" | "afterDash" | "headers" | "data" | "done" =
    "preamble";

  const newPart = (): PartState => ({
    name: null,
    filename: null,
    handle: null,
    path: null,
    bytes: 0,
    chunks: [],
    fieldBytes: 0,
  });

  const emit = async (chunk: Buffer): Promise<void> => {
    if (chunk.length === 0) return;
    const p = part;
    if (!p) {
      throw new MultipartStreamError("malformed", "part data outside a part");
    }
    if (p.filename !== null) {
      let off = 0;
      while (off < chunk.length) {
        const { bytesWritten } = await p.handle!.write(
          chunk,
          off,
          chunk.length - off,
        );
        if (bytesWritten <= 0) {
          throw new MultipartStreamError(
            "malformed",
            "short write to temp file",
          );
        }
        off += bytesWritten;
      }
      p.bytes += chunk.length;
    } else {
      p.fieldBytes += chunk.length;
      if (p.fieldBytes > MAX_FIELD_BYTES) {
        throw new MultipartStreamError(
          "malformed",
          "text part exceeds the field cap",
        );
      }
      p.chunks.push(chunk);
    }
  };

  const finishPart = async (): Promise<void> => {
    const p = part;
    part = null;
    if (!p) return;
    if (p.handle) {
      await p.handle.close();
      p.handle = null;
    }
    if (p.filename !== null) {
      if (p.name !== null && !files.has(p.name)) {
        files.set(p.name, {
          path: p.path!,
          filename: p.filename,
          bytes: p.bytes,
        });
        return;
      }
    } else if (p.name !== null && !fields.has(p.name)) {
      fields.set(p.name, Buffer.concat(p.chunks).toString("utf8"));
      return;
    }
    // Unnamed part, or a duplicate of a name already recorded: drop it.
    if (p.path) {
      await unlink(p.path).catch(() => {});
      const i = createdPaths.indexOf(p.path);
      if (i !== -1) createdPaths.splice(i, 1);
    }
  };

  try {
    readLoop: for (;;) {
      // Consume as much of `buf` as the current state allows.
      advance: for (;;) {
        switch (state) {
          case "done":
            break readLoop;
          case "preamble": {
            const idx = buf.indexOf(dash);
            if (idx === -1) {
              // Nothing usable: keep only a partial-boundary tail.
              buf = buf.subarray(Math.max(0, buf.length - dash.length + 1));
              break advance;
            }
            buf = buf.subarray(idx + dash.length);
            state = "afterDash";
            continue;
          }
          case "afterDash": {
            // The bytes after `--boundary` decide: `--` (final), padding then
            // CRLF (next part), or anything else (the dash sequence was just
            // part of the data/preamble — RFC 2046 padding, then decide).
            let p = 0;
            while (p < buf.length && (buf[p] === SP || buf[p] === HT)) {
              p++;
            }
            if (p === buf.length || buf.length < p + 2) break advance;
            if (buf[p] === DASH && buf[p + 1] === DASH) {
              buf = buf.subarray(p + 2);
              state = "done";
              continue;
            }
            if (buf[p] === CR && buf[p + 1] === LF) {
              // The part before this delimiter (if any) was already
              // finished by the data-state scan.
              part = newPart();
              headerBytes = 0;
              inBody = true;
              buf = buf.subarray(p + 2);
              state = "headers";
              continue;
            }
            // False delimiter: `--boundary` followed by ordinary bytes. In
            // the body it is literal part data; in the preamble, discarded.
            if (inBody) {
              await emit(buf.subarray(0, p + 2));
              buf = buf.subarray(p + 2);
              state = "data";
            } else {
              buf = buf.subarray(p + 2);
              state = "preamble";
            }
            continue;
          }
          case "headers": {
            const idx = buf.indexOf(CRLF);
            if (idx === -1) {
              if (buf.length > MAX_HEADER_BYTES) {
                throw new MultipartStreamError(
                  "malformed",
                  "part header block exceeds the size cap",
                );
              }
              break advance;
            }
            headerBytes += idx + 2;
            if (headerBytes > MAX_HEADER_BYTES) {
              throw new MultipartStreamError(
                "malformed",
                "part header block exceeds the size cap",
              );
            }
            const line = buf.subarray(0, idx).toString("utf8");
            buf = buf.subarray(idx + 2);
            if (line === "") {
              // End of the header block: open the sink if this is a file.
              if (part!.filename !== null) {
                part!.path = `${opts.tempDir}/p${partCounter++}`;
                createdPaths.push(part!.path);
                part!.handle = await open(part!.path, "wx");
              }
              state = "data";
              continue;
            }
            parseHeaderLine(line, part!);
            continue;
          }
          case "data": {
            const idx = buf.indexOf(crlfDash);
            if (idx === -1) {
              // Emit everything a delimiter cannot start within.
              const keep = Math.min(buf.length, crlfDash.length - 1);
              const cut = buf.length - keep;
              if (cut > 0) await emit(buf.subarray(0, cut));
              buf = buf.subarray(cut);
              break advance;
            }
            await emit(buf.subarray(0, idx));
            await finishPart();
            buf = buf.subarray(idx + crlfDash.length);
            state = "afterDash";
            continue;
          }
        }
      }
      // Need more input. (Unreachable in the "done" state: the loop above
      // only falls through to here when a state needed more bytes.)
      const read = await reader.read();
      if (read.done) {
        throw new MultipartStreamError(
          "malformed",
          "unexpected end of multipart body",
        );
      }
      totalBytes += read.value.byteLength;
      if (totalBytes > opts.maxTotalBytes) {
        throw new MultipartStreamError(
          "too_large",
          `multipart body exceeds ${opts.maxTotalBytes} bytes`,
        );
      }
      buf =
        buf.length === 0
          ? Buffer.from(read.value)
          : Buffer.concat([buf, Buffer.from(read.value)]);
    }

    return { files, fields, totalBytes };
  } catch (err) {
    // Own cleanup: never leave a temp file behind on a failure path. The
    // open handle must close first on Windows (EBUSY otherwise).
    try {
      await part?.handle?.close();
    } catch {}
    for (const p of createdPaths) {
      await unlink(p).catch(() => {});
    }
    throw err;
  }
}

/**
 * One `Name: value` line. Only `Content-Disposition` matters: its `name`
 * parameter selects the field, and the *presence* of a `filename` parameter
 * (even empty) makes the part a file — the same distinction
 * `FormData.get()` makes between `File` and `string`.
 */
function parseHeaderLine(line: string, part: PartState): void {
  const colon = line.indexOf(":");
  if (colon === -1) return; // tolerate junk header lines
  const name = line.slice(0, colon).trim().toLowerCase();
  if (name !== "content-disposition") return;
  for (const [k, v] of dispositionParams(line.slice(colon + 1))) {
    if (k === "name") part.name = v;
    else if (k === "filename") part.filename = v;
  }
}

/**
 * `;`-separated parameters of a Content-Disposition value, honoring
 * quoted-string escapes so `;`/`"` inside quotes cannot split a parameter.
 */
function dispositionParams(value: string): Map<string, string> {
  const segments: string[] = [];
  let cur = "";
  let inQuotes = false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      cur += ch;
      escaped = false;
    } else if (inQuotes && ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ";" && !inQuotes) {
      segments.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  segments.push(cur);

  const params = new Map<string, string>();
  // segments[0] is the disposition type ("form-data"); the rest are params.
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i].indexOf("=");
    if (eq === -1) continue;
    params.set(
      segments[i].slice(0, eq).trim().toLowerCase(),
      segments[i].slice(eq + 1).trim(),
    );
  }
  return params;
}
