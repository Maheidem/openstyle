/**
 * Pure helpers for the live reader (issue #375, specs/live-chat.md section 1).
 *
 * The recorder writes a growing WAV. Its header says "0 bytes of data" until
 * the recording stops, so the header size cannot be used. The reader takes
 * the PCM from byte 44 to the end of the file.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  annotateSpeechEvidence,
  type Segment,
  segmentPcm,
} from "../segmenter.js";

export const LIVE_SAMPLE_RATE = 16_000;
const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
/** A segment is closed when it ended at least this long before "now". */
export const CLOSE_AFTER_MS = 800;
/** An open tail longer than this is cut. */
export const MAX_OPEN_MS = 20_000;
/** The cut goes at the quietest frame at or after this age of the tail. */
export const MIN_CUT_MS = 12_000;
const FRAME_MS = 20;

/**
 * Read the PCM of a growing WAV from `fromMs` to the end of the file. Return
 * null when the file does not exist yet.
 */
export function readPcmFrom(path: string, fromMs: number): Int16Array | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const start =
      WAV_HEADER_BYTES +
      Math.floor((fromMs * LIVE_SAMPLE_RATE) / 1000) * BYTES_PER_SAMPLE;
    const length = Math.max(0, fstatSync(fd).size - start);
    const evenLength = length - (length % BYTES_PER_SAMPLE);
    const buf = Buffer.alloc(evenLength);
    let read = 0;
    while (read < evenLength) {
      const n = readSync(fd, buf, read, evenLength - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return new Int16Array(
      buf.buffer,
      buf.byteOffset,
      Math.floor(read / BYTES_PER_SAMPLE),
    );
  } finally {
    closeSync(fd);
  }
}

export interface TailPlan {
  /** Segments that are complete. Times are from the start of the channel. */
  closed: Segment[];
  /** The segment that still grows, or null. */
  open: Segment | null;
}

/** Index of the quietest 20 ms frame that starts in [fromMs, toMs). */
function quietestFrameMs(pcm: Int16Array, fromMs: number, toMs: number) {
  const frame = (FRAME_MS * LIVE_SAMPLE_RATE) / 1000;
  let best = fromMs;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let ms = fromMs; ms + FRAME_MS <= toMs; ms += FRAME_MS) {
    const first = Math.floor((ms * LIVE_SAMPLE_RATE) / 1000);
    let sum = 0;
    for (let i = first; i < first + frame && i < pcm.length; i++) {
      sum += pcm[i] * pcm[i];
    }
    if (sum < bestEnergy) {
      bestEnergy = sum;
      best = ms;
    }
  }
  return best;
}

/**
 * Split the PCM (which starts at `fromMs` of the channel) into closed
 * segments and one open tail. A segment that ended at least CLOSE_AFTER_MS
 * before the end of the PCM is closed. An open tail that is longer than
 * MAX_OPEN_MS is cut at the quietest frame between MIN_CUT_MS and MAX_OPEN_MS.
 */
export function planTail(pcm: Int16Array, fromMs: number): TailPlan {
  const totalMs = (pcm.length / LIVE_SAMPLE_RATE) * 1000;
  const segments = annotateSpeechEvidence(
    pcm,
    LIVE_SAMPLE_RATE,
    segmentPcm(pcm, LIVE_SAMPLE_RATE),
  );
  const closed: Segment[] = [];
  let open: Segment | null = null;
  for (const seg of segments) {
    if (seg.endMs <= totalMs - CLOSE_AFTER_MS) closed.push(seg);
    else open = seg;
  }
  while (open && open.endMs - open.startMs > MAX_OPEN_MS) {
    const cut = quietestFrameMs(
      pcm,
      open.startMs + MIN_CUT_MS,
      open.startMs + MAX_OPEN_MS,
    );
    closed.push({ ...open, endMs: cut });
    open = { ...open, startMs: cut };
  }
  const shift = (s: Segment): Segment => ({
    ...s,
    startMs: s.startMs + fromMs,
    endMs: s.endMs + fromMs,
  });
  return { closed: closed.map(shift), open: open ? shift(open) : null };
}

/** Cut the PCM of one segment. Times are from the start of the channel. */
export function slicePcm(
  pcm: Int16Array,
  fromMs: number,
  seg: Pick<Segment, "startMs" | "endMs">,
): Uint8Array {
  const toSample = (ms: number) =>
    Math.max(0, Math.floor(((ms - fromMs) * LIVE_SAMPLE_RATE) / 1000));
  const part = pcm.subarray(toSample(seg.startMs), toSample(seg.endMs));
  return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
}
