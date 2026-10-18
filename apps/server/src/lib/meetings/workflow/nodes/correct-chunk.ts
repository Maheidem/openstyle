import type { CorrectionDropReason } from "@openstyle/validations";
import { callUnit } from "../../../llm/call-unit.js";
import type { CallProfile } from "../../../llm/model-profiles.js";
import { estimateTokens, formatEnhanceLine } from "../chunking.js";
import type { RunContext, WorkflowDeps } from "../context.js";
import {
  buildCorrectSystemPrompt,
  buildCorrectUserPrompt,
} from "../prompts.js";
import { CORRECT_CHUNK_STEP_SCHEMA } from "../schemas.js";
import {
  CORRECT_ANSWER_FACTOR,
  CORRECT_ANSWER_FIXED,
  type CorrectChunkInput,
  type CorrectChunkResult,
  type CorrectUnitResult,
  foldStatus,
  MIN_SPLIT_TOKENS_CORRECT,
  type NodeFailure,
  type PreparedSegment,
} from "../types.js";
import {
  createBreaker,
  fitsContext,
  guardNode,
  type Leaf,
  recordUnitEnd,
  runUnitRoute,
} from "../unit.js";

// Node `correctChunk` (specs/meeting-enhance-agentic.md 4.2). One task for each
// chunk. It fixes clear speech-to-text errors and nothing else. It writes no
// meeting data: `save` does.

function lineOf(s: PreparedSegment): string {
  return formatEnhanceLine(s.id, s.displayLabel, s.text);
}

function tokensOfSegments(segments: readonly PreparedSegment[]): number {
  return segments.reduce((sum, s) => sum + estimateTokens(lineOf(s)) + 1, 0);
}

/** 4.2.4: the output limit of one unit. */
function maxOutputFor(
  segments: readonly PreparedSegment[],
  profile: CallProfile,
): number {
  const answer =
    Math.ceil(tokensOfSegments(segments) * CORRECT_ANSWER_FACTOR) +
    CORRECT_ANSWER_FIXED;
  const reasoningShare = profile.reasoning.countsInMaxOutput
    ? profile.reasoning.budgetTokens
    : 0;
  return Math.min(
    profile.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    answer + reasoningShare,
  );
}

/** A `failed` result with one failed unit (guardNode and the error handler). */
export function failedCorrectResult(
  state: Pick<CorrectChunkInput, "chunkIndex" | "segments">,
  failure: NodeFailure,
): CorrectChunkResult {
  return {
    chunkIndex: state.chunkIndex,
    status: "failed",
    units: [
      {
        unitKey: `chunk:${state.chunkIndex}`,
        segmentIds: state.segments.map((s) => s.id),
        status: "failed",
        corrections: [],
        dropped: [],
        failure,
      },
    ],
  };
}

/** Lowercase words without punctuation: the unit of the 4.2.3 word checks. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

/** lcs[i][j]: length of the longest common subsequence of the two suffixes. */
function lcsTable(a: string[], b: string[]): number[][] {
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  return lcs;
}

/**
 * True when the word diff of old to new has a pure deletion of a word that is
 * not an exact repeat: a gap between two matched words (or the text ends) that
 * loses old words and gains no new word. N old words that become M new words is
 * a replacement and is not a deletion. A deleted word that equals the word
 * right before or after it in the original is an immediate duplicate ("the the"
 * to "the") and is allowed.
 */
function deletesWords(oldWords: string[], newWords: string[]): boolean {
  const n = oldWords.length;
  const m = newWords.length;
  const lcs = lcsTable(oldWords, newWords);
  let i = 0;
  let j = 0;
  let removed: number[] = [];
  let added = 0;
  const isRepeat = (k: number) =>
    oldWords[k] === oldWords[k - 1] || oldWords[k] === oldWords[k + 1];
  const closeGap = () => {
    const pure = removed.length > 0 && added === 0 && !removed.every(isRepeat);
    removed = [];
    added = 0;
    return pure;
  };
  while (i < n || j < m) {
    if (i < n && j < m && oldWords[i] === newWords[j]) {
      if (closeGap()) return true;
      i++;
      j++;
    } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      removed.push(i);
      i++;
    } else {
      added++;
      j++;
    }
  }
  return closeGap();
}

/** A correction may add at most this many words net. */
const MAX_NET_ADDED_WORDS = 3;
/** Share of the original words that must stay, in order. */
const MIN_WORD_OVERLAP = 0.5;

/** True when the new text adds many words or keeps too little of the old text. */
function tooDifferent(oldWords: string[], newWords: string[]): boolean {
  if (newWords.length - oldWords.length > MAX_NET_ADDED_WORDS) return true;
  if (oldWords.length === 0) return false;
  const kept = lcsTable(oldWords, newWords)[0]![0]!;
  return kept / oldWords.length < MIN_WORD_OVERLAP;
}

/** Negation words: not, no, never, nothing, none, nobody, and any n't word. */
const NEGATION_WORDS = new Set([
  "not",
  "no",
  "never",
  "nothing",
  "none",
  "nobody",
]);

function negationCount(text: string): number {
  const words = text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .match(/[\p{L}']+/gu);
  return (words ?? []).filter((w) => NEGATION_WORDS.has(w) || w.endsWith("n't"))
    .length;
}

/** Irregular inflection groups. Each group is one word in all its forms. */
const IRREGULAR_GROUPS: ReadonlySet<string>[] = [
  new Set(["is", "are", "was", "were", "am", "be", "been"]),
  new Set(["has", "have", "had"]),
  new Set(["does", "do", "did"]),
];

const SUFFIXES = ["es", "ed", "ing", "s", "d"];
/** A stem must keep at least this many letters after a suffix strip. */
const MIN_STEM_LENGTH = 3;

function stemsOf(word: string): Set<string> {
  const stems = new Set([word]);
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM_LENGTH)
      stems.add(word.slice(0, -suffix.length));
  }
  return stems;
}

/** True when two different words are forms of the same word. */
function isInflection(a: string, b: string): boolean {
  if (a === b) return false;
  if (IRREGULAR_GROUPS.some((g) => g.has(a) && g.has(b))) return true;
  const stemsB = stemsOf(b);
  for (const stem of stemsOf(a)) if (stemsB.has(stem)) return true;
  return false;
}

/** Collapse exact immediate repeats ("the the" to "the"). */
function collapseRepeats(words: string[]): string[] {
  return words.filter((w, i) => w !== words[i - 1]);
}

/** One difference of a word alignment: old words that became new words. */
interface WordGap {
  removed: string[];
  added: string[];
}

/** The gaps between the matched words, after the exact-repeat collapse. */
function alignGaps(oldWords: string[], newWords: string[]): WordGap[] {
  const a = collapseRepeats(oldWords);
  const b = collapseRepeats(newWords);
  const lcs = lcsTable(a, b);
  const gaps: WordGap[] = [];
  let i = 0;
  let j = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const closeGap = () => {
    if (removed.length > 0 || added.length > 0) gaps.push({ removed, added });
    removed = [];
    added = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      closeGap();
      i++;
      j++;
    } else if (
      j >= b.length ||
      (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)
    ) {
      removed.push(a[i]!);
      i++;
    } else {
      added.push(b[j]!);
      j++;
    }
  }
  closeGap();
  return gaps;
}

/**
 * True when the two texts differ only in inflections: after the repeat
 * collapse, every gap of the word alignment is a run of old words that match
 * the same number of new words one for one, each pair an inflection. Any other
 * change (a different word, an added or lost word, a split or joined word)
 * makes the correction a real fix, and the whole correction stays.
 */
function inflectionOnly(oldWords: string[], newWords: string[]): boolean {
  const gaps = alignGaps(oldWords, newWords);
  return (
    gaps.length > 0 &&
    gaps.every(
      (g) =>
        g.removed.length === g.added.length &&
        g.removed.every((w, k) => isInflection(w, g.added[k]!)),
    )
  );
}

/** Articles, pronouns and auxiliaries: a closed set. */
const FUNCTION_WORDS = new Set([
  "a",
  "an",
  "the",
  "it",
  "its",
  "we",
  "i",
  "you",
  "he",
  "she",
  "they",
  "is",
  "are",
  "was",
  "were",
  "be",
  "am",
  "this",
  "that",
  "these",
  "those",
]);

/** Prepositions: a lost one is a real fix ("look" to "look at"). */
const PREPOSITIONS = new Set([
  "at",
  "to",
  "on",
  "in",
  "of",
  "for",
  "with",
  "about",
  "from",
]);

/**
 * True when every new word of the correction (inserted or substituted) is in
 * the closed function-word set. Such a change is a grammar edit, not a fix.
 */
function functionWordOnly(oldWords: string[], newWords: string[]): boolean {
  const added = alignGaps(oldWords, newWords).flatMap((g) => g.added);
  return added.length > 0 && added.every((w) => FUNCTION_WORDS.has(w));
}

/**
 * True when a run of new words has no old word replaced and holds a content
 * word (not a function word, not a preposition): the model invented it.
 */
function inventsWords(oldWords: string[], newWords: string[]): boolean {
  return alignGaps(oldWords, newWords).some(
    (g) =>
      g.removed.length === 0 &&
      g.added.some((w) => !FUNCTION_WORDS.has(w) && !PREPOSITIONS.has(w)),
  );
}

/** 4.2.3: the code checks after the parse. */
export function checkCorrections(
  raw: { id: string; text: string }[],
  segments: readonly PreparedSegment[],
  callId: number | null,
): Pick<CorrectUnitResult, "corrections" | "dropped"> {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const corrections: CorrectUnitResult["corrections"] = [];
  const dropped: CorrectUnitResult["dropped"] = [];
  raw.forEach((entry, seq) => {
    const drop = (reason: CorrectionDropReason) => {
      dropped.push({ id: entry.id, reason, seq, callId });
    };
    const original = byId.get(entry.id);
    if (!original) {
      drop("unknown_id");
      return;
    }
    if (seen.has(entry.id)) {
      drop("duplicate_id");
      return;
    }
    seen.add(entry.id);
    let text = entry.text.trim();
    // A local model sometimes echoes the "Speaker: " prefix of the line format.
    const prefix = `${original.displayLabel}: `;
    if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
    if (!text) {
      drop("empty_text");
      return;
    }
    if (text === original.text.trim()) {
      drop("unchanged");
      return;
    }
    // 4.2.2 policy: a case or punctuation change is a fix. A lost word is not,
    // except an exact repeat of its neighbour.
    const oldWords = wordsOf(original.text);
    const newWords = wordsOf(text);
    if (deletesWords(oldWords, newWords)) {
      drop("deletes_words");
      return;
    }
    // Text copied in from a neighbour segment, or a rewrite.
    if (tooDifferent(oldWords, newWords)) {
      drop("too_different");
      return;
    }
    // A fix must not turn a statement into its opposite.
    if (negationCount(original.text) !== negationCount(text)) {
      drop("meaning_flip");
      return;
    }
    // A change of grammar only (verb agreement, tense, plural) is not a fix.
    if (inflectionOnly(oldWords, newWords)) {
      drop("inflection_only");
      return;
    }
    // Only articles, pronouns or auxiliaries changed: grammar, not a fix.
    if (functionWordOnly(oldWords, newWords)) {
      drop("function_word_only");
      return;
    }
    // A run of content words inserted where no old word was replaced.
    if (inventsWords(oldWords, newWords)) {
      drop("invented_words");
      return;
    }
    corrections.push({ id: entry.id, text, seq, callId });
  });
  return { corrections, dropped };
}

function toUnit(
  leaf: Leaf<PreparedSegment, { corrections: { id: string; text: string }[] }>,
): CorrectUnitResult {
  const segmentIds = leaf.members.map((s) => s.id);
  if (leaf.status !== "ok" || !leaf.result) {
    return {
      unitKey: leaf.key,
      segmentIds,
      status: leaf.status === "ok" ? "failed" : leaf.status,
      corrections: [],
      dropped: [],
      failure: leaf.failure,
    };
  }
  return {
    unitKey: leaf.key,
    segmentIds,
    status: "ok",
    ...checkCorrections(
      leaf.result.object.corrections,
      leaf.members,
      leaf.result.callId,
    ),
    failure: null,
  };
}

export function makeCorrectChunkNode(deps: WorkflowDeps) {
  const breaker = createBreaker();

  async function run(
    input: CorrectChunkInput,
    ctx: RunContext,
  ): Promise<CorrectChunkResult> {
    const system = buildCorrectSystemPrompt({
      language: input.language,
      vocabTerms: input.vocabTerms,
    });
    const systemTokens = estimateTokens(system);
    ctx.progress.addTotal(1);
    const leaves = await runUnitRoute(
      {
        node: "correctChunk",
        ctx,
        profile: input.profile,
        minSplitTokens: MIN_SPLIT_TOKENS_CORRECT,
        tokensOf: tokensOfSegments,
        maxOutput: maxOutputFor,
        fits: (members, maxOut, profile) =>
          fitsContext(
            profile,
            systemTokens + tokensOfSegments(members),
            maxOut,
          ),
        call: (unit) =>
          callUnit(
            {
              step: "correctChunk",
              runId: input.runId,
              unitKey: unit.key,
              chunkIndex: input.chunkIndex,
              schema: CORRECT_CHUNK_STEP_SCHEMA,
              instructions: system,
              messages: [
                {
                  role: "user",
                  content: buildCorrectUserPrompt(unit.members.map(lineOf)),
                },
              ],
              profile: unit.profile,
              maxOutputTokens: unit.maxOutputTokens,
              signal: ctx.signal,
              onQueued: (i) => ctx.progress.onQueued(i),
            },
            ctx,
            deps,
          ),
        onSplit: () => ctx.progress.addTotal(1),
        onLeafEnd: (leaf) => {
          if (leaf.status === "ok") ctx.progress.callEnded("ok");
          else if (leaf.status === "failed") ctx.progress.callEnded("failed");
        },
      },
      `chunk:${input.chunkIndex}`,
      input.segments,
    );
    recordUnitEnd(breaker, ctx, leaves);
    const units = leaves.map(toUnit);
    return {
      chunkIndex: input.chunkIndex,
      status: foldStatus(units.map((u) => u.status)),
      units,
    };
  }

  const guarded = guardNode<CorrectChunkInput, CorrectChunkResult>(
    deps,
    {
      id: "correctChunk",
      stepKey: (s) => `chunk:${s.chunkIndex}`,
      failed: failedCorrectResult,
      outcome: (r) => ({
        status: r.status,
        failure: r.units.find((u) => u.status === "failed")?.failure ?? null,
      }),
    },
    run,
  );
  return async (input: CorrectChunkInput) => ({
    corrections: [await guarded(input)],
  });
}
