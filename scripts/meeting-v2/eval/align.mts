// align.mts: align two transcriptions of one meeting channel (engine A and
// engine B) by time and words, and find the spans where they differ
// (`pnpm meeting:eval:gold-draft`). Pure functions, no I/O.
//
// Method:
//   1. Each segment gives its words a time: the segment time is split over
//      the words by their length (a word gets length + 1 parts).
//   2. The channel is cut into time blocks: the union of the segments of
//      both engines, with gaps shorter than `gapMs` joined. Words align only
//      inside their block, so a word never pairs with a word far away in time.
//   3. Inside a block the words align with a minimal edit alignment
//      (alignWords of score.mts, on the words() normal form).
//   4. A diff span is a run of steps that are not equal. Two runs with fewer
//      than `mergeEq` equal words between them become one span.

import type { Channel } from "./gold.mts";
import { alignWords, words } from "./score.mts";

export interface Seg {
  startMs: number;
  endMs: number;
  text: string;
}

/** One word of a segment: the normal form, the original-case form, its time. */
export interface Tok {
  w: string;
  o: string;
  startMs: number;
  endMs: number;
  /** The index of its segment in the input array. */
  seg: number;
}

export interface DiffSpan {
  id: string;
  channel: Channel;
  startMs: number;
  endMs: number;
  /** The words of engine A in the span (original case, no punctuation). */
  a: string;
  /** The words of engine B in the span. */
  b: string;
}

export interface AlignedTurn {
  startMs: number;
  endMs: number;
  /** The text of engine A (the segment text). */
  a: string;
  /** The words of engine B that align with this turn. */
  b: string;
  /** The ids of the diff spans that touch this turn. */
  spans: string[];
}

export interface AlignStats {
  aWords: number;
  bWords: number;
  eq: number;
  sub: number;
  del: number;
  ins: number;
  blocks: number;
}

export interface ChannelAlignment {
  turns: AlignedTurn[];
  spans: DiffSpan[];
  stats: AlignStats;
}

/** The words of a text with the original case. Same split rule as words(). */
function rawWords(text: string): string[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
}

/** The words of the segments, each with a time inside its segment. */
export function tokens(segs: Seg[]): Tok[] {
  const out: Tok[] = [];
  segs.forEach((s, seg) => {
    const raw = rawWords(s.text);
    const norm = words(s.text);
    // words() lowercases first; a rare letter can change the split. Keep
    // the two lists equal in length, else use the normal form for both.
    const orig = raw.length === norm.length ? raw : norm;
    const end = Math.max(s.startMs, s.endMs);
    const total = orig.reduce((n, w) => n + w.length + 1, 0);
    let at = 0;
    orig.forEach((o, k) => {
      const from = s.startMs + Math.round(((end - s.startMs) * at) / total);
      at += o.length + 1;
      const to = s.startMs + Math.round(((end - s.startMs) * at) / total);
      out.push({ w: norm[k] as string, o, startMs: from, endMs: to, seg });
    });
  });
  return out;
}

/** The time blocks of a channel: the union of all segments, small gaps joined. */
export function timeBlocks(
  segs: Seg[],
  gapMs: number,
): { startMs: number; endMs: number }[] {
  const all = segs
    .map((s) => ({ startMs: s.startMs, endMs: Math.max(s.startMs, s.endMs) }))
    .sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  const out: { startMs: number; endMs: number }[] = [];
  for (const s of all) {
    const last = out.at(-1);
    if (last && s.startMs <= last.endMs + gapMs)
      last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ ...s });
  }
  return out;
}

/**
 * Align engine A and engine B on one channel. `a` and `b` are the segments
 * of each engine in time order. The turns are the segments of engine A.
 */
export function alignChannel(
  channel: Channel,
  a: Seg[],
  b: Seg[],
  opts: { gapMs?: number; mergeEq?: number } = {},
): ChannelAlignment {
  const gapMs = opts.gapMs ?? 1000;
  const mergeEq = opts.mergeEq ?? 2;
  const ta = tokens(a);
  const tb = tokens(b);
  const blocks = timeBlocks([...a, ...b], gapMs);
  const blockOf = (segStart: number) =>
    blocks.findIndex((k) => segStart >= k.startMs && segStart <= k.endMs);
  const inBlock = (toks: Tok[], segs: Seg[], k: number) =>
    toks.filter((t) => blockOf((segs[t.seg] as Seg).startMs) === k);

  const stats: AlignStats = {
    aWords: ta.length,
    bWords: tb.length,
    eq: 0,
    sub: 0,
    del: 0,
    ins: 0,
    blocks: blocks.length,
  };
  const bOfTurn: string[][] = a.map(() => []);
  const spansOfTurn: Set<string>[] = a.map(() => new Set());
  const spans: DiffSpan[] = [];
  const prefix = channel === "mic" ? "m" : "s";

  for (let k = 0; k < blocks.length; k++) {
    const xa = inBlock(ta, a, k);
    const xb = inBlock(tb, b, k);
    const steps = alignWords(
      xa.map((t) => t.w),
      xb.map((t) => t.w),
    );
    // B words go to the turn of the A word they pair with. An inserted B
    // word goes to the turn of the A word before it (or after it at the
    // start of a block).
    const firstA = xa[0];
    let lastTurn = firstA ? firstA.seg : -1;
    for (const s of steps) {
      stats[s.op]++;
      if (s.r >= 0) lastTurn = (xa[s.r] as Tok).seg;
      if (s.h >= 0 && lastTurn >= 0)
        (bOfTurn[lastTurn] as string[]).push((xb[s.h] as Tok).o);
    }

    // Runs of steps that are not equal, joined across short equal gaps.
    const runs: { from: number; to: number }[] = [];
    let eqSince = Number.POSITIVE_INFINITY;
    steps.forEach((s, i) => {
      if (s.op === "eq") {
        if (eqSince === Number.POSITIVE_INFINITY) eqSince = i;
        return;
      }
      const last = runs.at(-1);
      if (last && i - Math.min(eqSince, i) < mergeEq) last.to = i;
      else runs.push({ from: i, to: i });
      eqSince = Number.POSITIVE_INFINITY;
    });
    for (const run of runs) {
      const part = steps.slice(run.from, run.to + 1);
      const ra = part.filter((s) => s.r >= 0).map((s) => xa[s.r] as Tok);
      const rb = part.filter((s) => s.h >= 0).map((s) => xb[s.h] as Tok);
      // The equal words inside a joined run are in both lists; the span
      // texts show them so that the owner reads whole phrases.
      const used = [...ra, ...rb];
      const id = `${prefix}${spans.length + 1}`;
      spans.push({
        id,
        channel,
        startMs: Math.min(...used.map((t) => t.startMs)),
        endMs: Math.max(...used.map((t) => t.endMs)),
        a: ra.map((t) => t.o).join(" "),
        b: rb.map((t) => t.o).join(" "),
      });
      for (const t of ra) (spansOfTurn[t.seg] as Set<string>).add(id);
      // A span with no A word: mark the A turns that it overlaps in time.
      if (ra.length === 0) {
        const sp = spans.at(-1) as DiffSpan;
        a.forEach((seg, i) => {
          if (seg.startMs <= sp.endMs && seg.endMs >= sp.startMs)
            (spansOfTurn[i] as Set<string>).add(id);
        });
      }
    }
  }

  return {
    turns: a.map((s, i) => ({
      startMs: s.startMs,
      endMs: s.endMs,
      a: s.text,
      b: (bOfTurn[i] as string[]).join(" "),
      spans: [...(spansOfTurn[i] as Set<string>)],
    })),
    spans,
    stats,
  };
}
