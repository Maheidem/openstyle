// Code-owned citations of the Ask tool loop (owner decision 2026-11-04, spec
// 11.10.6). The answer step writes plain sentences and no cite. After it, code
// attributes each sentence to the blocks that a tool of THIS turn showed: a
// search hit, a read span, a list item. The reranker scores the sentence
// against each block (a segment for a transcript hit). The best block above a
// threshold is the cite. When the reranker is absent, the share of the words
// of the sentence in the block does the same job. A sentence with no block
// above the threshold gets no cite; the cite check then removes it.
//
// Native citations of a provider (Anthropic) do not apply here: the SDK offers
// them for document parts and for its own web tools, not for the text of a
// tool result, and the answer is a structured call.

import {
  type AnswerSentence,
  expandThousands,
  foldWords,
  type Ranker,
} from "../cites.js";
import type { Source, SourceMap } from "../types.js";

/**
 * The reranker score from which a block supports a sentence. The score is a
 * probability that saturates: on the dig dev set and the gold set, 284 of 286
 * best scores are above 0.9 and 2 are below 0.2 (E2B, 2026-11-04). A threshold
 * from 0.2 to 0.85 gave the same answers, so the value is a middle of the gap.
 */
export const CITE_MIN = 0.5;
/** The share of the words of a sentence in a block, from which the block supports it (no reranker). */
export const CITE_MIN_LEXICAL = 0.5;
/** The most blocks one reranker call scores (the worker limit is 64). */
const MAX_CANDIDATES = 48;

/** How code picks the block among the supporting blocks (eval can change it). */
export interface AttributeOptions {
  /** The score from which a block supports a sentence. */
  min?: number;
  /** The most cites of one sentence. */
  max?: number;
  /** The weight of the word share in the rank. The reranker saturates, so the share breaks ties. */
  mix?: number;
  /**
   * Added to the rank of a spoken block. At 1 or more a spoken block that
   * supports the sentence always wins: the chip then opens the meeting at the line.
   */
  spoken?: number;
}
export const CITE_DEFAULTS = { max: 1, mix: 0.5, spoken: 2 } as const;

interface Candidate {
  label: string;
  text: string;
  spoken: boolean;
}

export interface AttributeStats {
  /** Sentences that got at least one cite. */
  cited: number;
  /** Sentences with no block above the threshold. */
  uncited: number;
  /** The reranker scored the blocks. False: the word share did. */
  reranked: boolean;
  /** The best score of each sentence, in order. */
  best: number[];
}

/** The blocks of the turn: a transcript hit is one block for each segment. */
export function candidatesOf(
  ranked: readonly Source[],
  sources: SourceMap,
): Candidate[] {
  const out: Candidate[] = [];
  for (const src of ranked) {
    if (src.kind === "folder") continue;
    const segs = sources.segments.get(src.label);
    const spoken = src.kind === "transcript" || src.kind === "window";
    if (segs && segs.length > 1) {
      // The text of a labelled hit holds one line for each segment, with the speaker.
      const lines = src.text.split("\n");
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i] as { text: string };
        out.push({
          label: src.label,
          text: lines.length === segs.length ? (lines[i] as string) : seg.text,
          spoken,
        });
      }
    } else {
      out.push({ label: src.label, text: src.text, spoken });
    }
  }
  return out;
}

/** The words of a text. "180k" counts as 180000, as in the fact check of the loop. */
const wordsOf = (text: string): string[] => foldWords(expandThousands(text));

const share = (words: Set<string>, text: string): number => {
  if (words.size === 0) return 0;
  const have = new Set(wordsOf(text));
  let hit = 0;
  for (const w of words) if (have.has(w)) hit++;
  return hit / words.size;
};

/**
 * Sets `cites` of each sentence. Returns the numbers for the trace.
 * `rank` is the reranker, or null when it is not available.
 */
export async function attributeCites(
  sentences: AnswerSentence[],
  ranked: readonly Source[],
  sources: SourceMap,
  rank: Ranker | null,
  opts: AttributeOptions = {},
): Promise<AttributeStats> {
  const min = opts.min ?? CITE_MIN;
  const max = opts.max ?? CITE_DEFAULTS.max;
  const mix = opts.mix ?? CITE_DEFAULTS.mix;
  const spokenBonus = opts.spoken ?? CITE_DEFAULTS.spoken;
  const all = candidatesOf(ranked, sources);
  const stats: AttributeStats = {
    cited: 0,
    uncited: 0,
    reranked: false,
    best: [],
  };
  for (const sentence of sentences) {
    sentence.cites = [];
    const words = new Set(wordsOf(sentence.text));
    // Many blocks: the reranker scores the 48 with the most shared words.
    let pool = all;
    if (all.length > MAX_CANDIDATES) {
      pool = all
        .map((c, i) => ({ c, i, s: share(words, c.text) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, MAX_CANDIDATES)
        .map((x) => x.c);
    }
    let scores: number[] | null = null;
    if (rank && pool.length > 0) {
      scores = await rank(
        sentence.text,
        pool.map((c) => c.text),
      );
    }
    const threshold = scores ? min : CITE_MIN_LEXICAL;
    if (scores) stats.reranked = true;
    // One entry for each label: the best score, and the best rank of its blocks.
    const byLabel = new Map<string, { score: number; rank: number }>();
    pool.forEach((c, i) => {
      const score = scores ? (scores[i] as number) : share(words, c.text);
      // The rank breaks the ties of a saturated score: word share, then a spoken block.
      const rank =
        score +
        (scores ? mix * share(words, c.text) : 0) +
        (c.spoken ? spokenBonus : 0);
      const e = byLabel.get(c.label);
      if (!e) byLabel.set(c.label, { score, rank });
      else {
        e.score = Math.max(e.score, score);
        e.rank = Math.max(e.rank, rank);
      }
    });
    const best = Math.max(0, ...[...byLabel.values()].map((e) => e.score));
    stats.best.push(best);
    if (best < threshold) {
      stats.uncited++;
      continue;
    }
    sentence.cites = [...byLabel.entries()]
      .filter(([, e]) => e.score >= threshold)
      .sort((a, b) => b[1].rank - a[1].rank)
      .slice(0, max)
      .map(([l]) => l);
    stats.cited++;
  }
  return stats;
}
