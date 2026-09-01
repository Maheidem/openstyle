/**
 * Shared RIFF/WAVE parsing and header building.
 *
 * Dependency-free byte code used both by the meeting transcriber (fd-backed,
 * streamed reads of large `mic.wav` / `system.wav`) and by the ffmpeg decode
 * helper (in-memory buffers). Kept out of `lib/meetings/transcriber.ts` so
 * `lib/audio/decode.ts` never pulls in the meeting-worker imports.
 */

import { fstatSync, readSync } from "node:fs";

export interface WavInfo {
  /** `fmt ` format tag: 1 = PCM, 3 = IEEE float, 0xFFFE = extensible. */
  formatTag: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset of the first PCM sample. */
  dataOffset: number;
  /**
   * Byte length of the data chunk, clamped to the bytes actually present
   * after the chunk header (never larger than the source, never negative).
   */
  dataLength: number;
}

/** Minimal random-access reader over an fd or an in-memory buffer. */
interface Reader {
  size: number;
  /** Read up to `len` bytes at `offset`; returns the bytes actually read. */
  read(offset: number, len: number): Buffer;
}

function readerFor(src: number | Uint8Array): Reader {
  if (typeof src === "number") {
    const fd = src;
    return {
      size: fstatSync(fd).size,
      read(offset, len) {
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, offset);
        return buf.subarray(0, n);
      },
    };
  }
  const buf = Buffer.from(src.buffer, src.byteOffset, src.byteLength);
  return {
    size: buf.length,
    read(offset, len) {
      if (offset >= buf.length) return Buffer.alloc(0);
      return buf.subarray(offset, Math.min(buf.length, offset + len));
    },
  };
}

/**
 * Parse a RIFF/WAVE header by walking chunks to find `fmt ` and `data`.
 * The canonical 44-byte layout is the common case, but chunk order and
 * extra chunks (LIST, fact) are handled properly.
 *
 * Accepts an open file descriptor or an in-memory buffer.
 */
export function parseWavHeader(src: number | Uint8Array): WavInfo {
  const reader = readerFor(src);
  const riff = reader.read(0, 12);
  if (riff.length !== 12) {
    throw new Error("WAV too short for RIFF header");
  }
  if (
    riff.toString("ascii", 0, 4) !== "RIFF" ||
    riff.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE file");
  }

  let offset = 12;
  let fmt: {
    formatTag: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
  } | null = null;
  for (;;) {
    const header = reader.read(offset, 8);
    if (header.length !== 8) break;
    const id = header.toString("ascii", 0, 4);
    const size = header.readUInt32LE(4);
    if (id === "fmt ") {
      const body = Buffer.alloc(Math.min(size, 16));
      reader.read(offset + 8, body.length).copy(body);
      fmt = {
        formatTag: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before fmt chunk");
      const dataOffset = offset + 8;
      // Streaming writers (ffmpeg → pipe) emit 0xFFFFFFFF because they can't
      // seek back; truncated files declare more than they hold. Clamp to what
      // is actually there so callers can `Buffer.alloc(dataLength)` safely.
      const available = Math.max(0, reader.size - dataOffset);
      return {
        formatTag: fmt.formatTag,
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bitsPerSample,
        dataOffset,
        dataLength: Math.min(size, available),
      };
    }
    // Chunks are word-aligned: odd sizes carry a pad byte.
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV data chunk not found");
}

/** Duration of the data chunk in milliseconds; 0 when the byte rate is 0. */
export function wavDurationMs(info: WavInfo): number {
  const byteRate = (info.sampleRate * info.channels * info.bitsPerSample) / 8;
  if (!(byteRate > 0)) return 0;
  return (info.dataLength / byteRate) * 1000;
}

/** Build a canonical 44-byte WAV header for a mono/whatever PCM slice. */
export function wavHeader(
  info: Pick<WavInfo, "sampleRate" | "channels" | "bitsPerSample">,
  dataBytes: number,
): Buffer {
  const h = Buffer.alloc(44);
  const byteRate = (info.sampleRate * info.channels * info.bitsPerSample) / 8;
  const blockAlign = (info.channels * info.bitsPerSample) / 8;
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(info.channels, 22);
  h.writeUInt32LE(info.sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(info.bitsPerSample, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * Slice `[startMs, endMs)` from an open WAV file into standalone in-memory
 * WAV bytes. Reads only the slice's bytes at a computed offset.
 */
export function sliceWav(
  fd: number,
  info: WavInfo,
  startMs: number,
  endMs: number,
): Uint8Array {
  const bytesPerSample = (info.channels * info.bitsPerSample) / 8;
  const clampFrame = (ms: number) =>
    Math.max(
      0,
      Math.min(
        Math.floor((ms / 1000) * info.sampleRate),
        Math.floor(info.dataLength / bytesPerSample),
      ),
    );
  const startFrame = clampFrame(startMs);
  const endFrame = clampFrame(endMs);
  const byteStart = startFrame * bytesPerSample;
  const byteLen = Math.max(0, (endFrame - startFrame) * bytesPerSample);

  const data = Buffer.alloc(byteLen);
  let read = 0;
  // Streamed reads in 64 KiB blocks keep memory flat regardless of file size.
  const BLOCK = 64 * 1024;
  while (read < byteLen) {
    const n = readSync(
      fd,
      data,
      read,
      Math.min(BLOCK, byteLen - read),
      info.dataOffset + byteStart + read,
    );
    if (n <= 0) break;
    read += n;
  }
  return Buffer.concat([wavHeader(info, read), data.subarray(0, read)]);
}
