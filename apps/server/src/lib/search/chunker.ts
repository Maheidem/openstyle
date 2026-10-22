import { createHash } from "node:crypto";
import { EMBED_DOC_PROMPT } from "../mlx-embed/constants.js";

// The search chunker (specs/local-semantic-search.md section 4). A pure
// function: whole segments in transcript order, about 300 estimated tokens
// per chunk, 45 tokens of overlap (D11). A segment above 300 tokens is split
// by sentences (4.4). No speaker label goes into the text (S7).

export const CHUNK_TARGET_TOKENS = 300;
export const CHUNK_MAX_TOKENS = 400;
export const CHUNK_OVERLAP_TOKENS = 45;
/** A tail chunk below this joins the previous chunk (4.3 rule 4). */
const TAIL_MIN_TOKENS = 40;
/** A change re-embeds every chunk, as a model change does (4.5). */
export const CHUNKER_VERSION = 1;

/** One input segment (4.1): `enhancedText ?? text` is already applied. */
export interface ChunkSegment {
  id: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
}

export interface Chunk {
  ordinal: number;
  segmentIds: string[];
  /** Offset in the text of the first segment. */
  charStart: number;
  /** End offset in the text of the last segment. null = to the end. */
  charEnd: number | null;
  startMs: number | null;
  endMs: number | null;
  /** Never stored (3.4). */
  text: string;
  tokenEstimate: number;
  /** sha256 of JSON [CHUNKER_VERSION, DOC_PROMPT, text] (4.5). */
  textHash: string;
}

// CJK ideographs, kana and Hangul: 1 token each (4.2).
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯ᄀ-ᇿ㄰-㆏]/gu;

/** Estimated embedding tokens without the Gemma tokenizer (4.2). */
export function estimateEmbedTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** What a chunk holds (3.2): transcript text, title and tags, or summary. */
export type ChunkKind = "transcript" | "meta" | "summary";

/**
 * The text hash of a chunk (4.5). A meta or summary chunk also hashes its
 * kind; a transcript chunk keeps the hash of CHUNKER_VERSION 1.
 */
export function chunkTextHash(
  text: string,
  kind: ChunkKind = "transcript",
): string {
  return sha256Json(
    kind === "transcript"
      ? [CHUNKER_VERSION, EMBED_DOC_PROMPT, text]
      : [CHUNKER_VERSION, EMBED_DOC_PROMPT, kind, text],
  );
}

/** A part of one segment: the whole text, or a piece of a long segment. */
interface Unit {
  seg: number;
  start: number;
  /** null = to the end of the segment text. */
  end: number | null;
  tokens: number;
}

function segmenter(
  language: string,
  granularity: "sentence" | "word",
): Intl.Segmenter {
  try {
    return new Intl.Segmenter(language, { granularity });
  } catch {
    return new Intl.Segmenter("en", { granularity });
  }
}

/** Cut [start, end) of `text` at word edges into parts of at most `max` tokens. */
function cutAtWords(
  text: string,
  start: number,
  end: number,
  language: string,
  max: number,
): [number, number][] {
  const parts: [number, number][] = [];
  let partStart = start;
  let last = start;
  for (const w of segmenter(language, "word").segment(text.slice(start, end))) {
    const wEnd = start + w.index + w.segment.length;
    if (
      last > partStart &&
      estimateEmbedTokens(text.slice(partStart, wEnd)) > max
    ) {
      parts.push([partStart, last]);
      partStart = last;
    }
    last = wEnd;
  }
  if (last > partStart) parts.push([partStart, last]);
  // A single "word" above the cap (no word edges): cut by characters.
  return parts.flatMap(([s, e]) => {
    if (estimateEmbedTokens(text.slice(s, e)) <= CHUNK_MAX_TOKENS)
      return [[s, e] as [number, number]];
    const out: [number, number][] = [];
    for (let i = s; i < e; i += max) out.push([i, Math.min(e, i + max)]);
    return out;
  });
}

/** Split a long segment into pieces of up to 300 tokens with overlap (4.4). */
function splitLongSegment(text: string, seg: number, language: string): Unit[] {
  const sentences: [number, number][] = [];
  for (const s of segmenter(language, "sentence").segment(text)) {
    const start = s.index;
    const end = s.index + s.segment.length;
    if (estimateEmbedTokens(s.segment) > CHUNK_MAX_TOKENS) {
      sentences.push(
        ...cutAtWords(text, start, end, language, CHUNK_TARGET_TOKENS),
      );
    } else {
      sentences.push([start, end]);
    }
  }
  const tokens = sentences.map(([s, e]) =>
    estimateEmbedTokens(text.slice(s, e)),
  );
  const pieces: Unit[] = [];
  let i = 0;
  while (i < sentences.length) {
    let j = i;
    let sum = 0;
    while (
      j < sentences.length &&
      (j === i || sum + (tokens[j] ?? 0) <= CHUNK_TARGET_TOKENS)
    ) {
      sum += tokens[j] ?? 0;
      j++;
    }
    const first = sentences[i] as [number, number];
    const last = sentences[j - 1] as [number, number];
    pieces.push({
      seg,
      start: first[0],
      end: j === sentences.length ? null : last[1],
      tokens: sum,
    });
    if (j >= sentences.length) break;
    // Overlap: start the next piece with the last sentences, up to 45 tokens.
    let back = j;
    let overlap = 0;
    while (
      back - 1 > i &&
      overlap + (tokens[back - 1] ?? 0) <= CHUNK_OVERLAP_TOKENS
    ) {
      back--;
      overlap += tokens[back] ?? 0;
    }
    i = back;
  }
  return pieces;
}

/**
 * The text of a span (also the snippet rule of 7.3): every segment in order,
 * the first one cut from `charStart`, the last one cut at `charEnd`, joined
 * with one space.
 */
export function spanText(
  texts: readonly string[],
  charStart: number,
  charEnd: number | null,
): string {
  return texts
    .map((t, i) => {
      const from = i === 0 ? charStart : 0;
      const to =
        i === texts.length - 1 && charEnd !== null ? charEnd : t.length;
      return t.slice(from, to).trim();
    })
    .filter((t) => t.length > 0)
    .join(" ");
}

function buildChunk(
  units: readonly Unit[],
  segments: readonly ChunkSegment[],
  ordinal: number,
): Chunk {
  const first = units[0] as Unit;
  const last = units[units.length - 1] as Unit;
  const segIdx: number[] = [];
  for (const u of units) if (!segIdx.includes(u.seg)) segIdx.push(u.seg);
  const segs = segIdx.map((i) => segments[i] as ChunkSegment);
  const text = spanText(
    segs.map((s) => s.text),
    first.start,
    last.end,
  );
  return {
    ordinal,
    segmentIds: segs.map((s) => s.id),
    charStart: first.start,
    charEnd: last.end,
    startMs: segs[0]?.startMs ?? null,
    endMs: segs[segs.length - 1]?.endMs ?? null,
    text,
    tokenEstimate: estimateEmbedTokens(text),
    textHash: chunkTextHash(text),
  };
}

/**
 * Build the chunks of one meeting (4.3). `segments` are in transcript order.
 * Segments with no id or blank text are skipped. No text gives no chunks.
 */
export function buildChunks(
  input: readonly ChunkSegment[],
  language: string | null,
): Chunk[] {
  const lang = language && language !== "auto" ? language : "en";
  const segments = input.filter((s) => s.id && s.text.trim().length > 0);
  const units: Unit[] = [];
  segments.forEach((s, seg) => {
    const tokens = estimateEmbedTokens(s.text);
    if (tokens > CHUNK_TARGET_TOKENS) {
      units.push(...splitLongSegment(s.text, seg, lang));
    } else {
      units.push({ seg, start: 0, end: null, tokens });
    }
  });

  // Pack whole units; the next chunk starts with the last units of the
  // previous one, up to 45 tokens (the shape of chunkTranscript).
  const groups: { from: number; to: number; tokens: number }[] = [];
  let i = 0;
  while (i < units.length) {
    let j = i;
    let sum = 0;
    while (
      j < units.length &&
      (j === i || sum + (units[j]?.tokens ?? 0) <= CHUNK_TARGET_TOKENS)
    ) {
      sum += units[j]?.tokens ?? 0;
      j++;
    }
    groups.push({ from: i, to: j, tokens: sum });
    if (j >= units.length) break;
    let back = j;
    let overlap = 0;
    while (
      back - 1 > i &&
      overlap + (units[back - 1]?.tokens ?? 0) <= CHUNK_OVERLAP_TOKENS
    ) {
      back--;
      overlap += units[back]?.tokens ?? 0;
    }
    i = back;
  }

  // Rule 4: a short tail joins the previous chunk when the result fits.
  if (groups.length >= 2) {
    const tail = groups[groups.length - 1] as (typeof groups)[number];
    const prev = groups[groups.length - 2] as (typeof groups)[number];
    let added = 0;
    for (let u = prev.to; u < tail.to; u++) added += units[u]?.tokens ?? 0;
    if (
      tail.tokens < TAIL_MIN_TOKENS &&
      prev.tokens + added <= CHUNK_MAX_TOKENS
    ) {
      prev.to = tail.to;
      prev.tokens += added;
      groups.pop();
    }
  }

  return groups.map((g, ordinal) =>
    buildChunk(units.slice(g.from, g.to), segments, ordinal),
  );
}
