export interface WavOptions {
  /** Default 16000. */
  sampleRate?: number;
  /** Default 1. */
  channels?: number;
  /** Default 16. */
  bitsPerSample?: number;
  /** Default 1 (PCM). */
  formatTag?: number;
  /** Number of frames of silence when `data` is not set. Default 160. */
  samples?: number;
  /** The exact payload bytes. Wins over `samples`. */
  data?: Buffer;
  /** Fill the silent payload that `samples` creates. Ignored when `data` is set. */
  fill?: (data: Buffer) => void;
  /** Put a 12-byte LIST/INFO chunk between `fmt ` and `data`. */
  listChunk?: boolean;
  /** Write 0xFFFFFFFF in the RIFF and `data` size fields, as a stream does. */
  streamSizes?: boolean;
  /** Override the `data` chunk size field. Wins over `streamSizes`. */
  declaredDataSize?: number;
  /** Override the RIFF size field. Wins over `streamSizes`. */
  declaredRiffSize?: number;
}

/**
 * Build WAV bytes in memory. Written by hand and independent of
 * `src/lib/audio/wav.ts`, so the parser tests do not use the code they check.
 * Without `listChunk` the result is the canonical 44-byte header plus payload.
 */
export function buildWav(opts: WavOptions = {}): Buffer<ArrayBuffer> {
  const sampleRate = opts.sampleRate ?? 16_000;
  const channels = opts.channels ?? 1;
  const bits = opts.bitsPerSample ?? 16;
  const blockAlign = (channels * bits) / 8;

  let data = opts.data;
  if (!data) {
    data = Buffer.alloc((opts.samples ?? 160) * blockAlign);
    opts.fill?.(data);
  }

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
  dataHeader.writeUInt32LE(
    opts.declaredDataSize ?? (opts.streamSizes ? 0xffffffff : data.length),
    4,
  );

  const body = Buffer.concat([fmt, list, dataHeader, data]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(
    opts.declaredRiffSize ?? (opts.streamSizes ? 0xffffffff : 4 + body.length),
    4,
  );
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, body]);
}
