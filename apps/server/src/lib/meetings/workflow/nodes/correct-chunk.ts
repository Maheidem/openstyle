import type { CorrectionDropReason } from "@openstyle/validations";
import { callUnit } from "../../../llm/call-unit.js";
import type { CallProfile } from "../../../llm/model-profiles.js";
import { estimateTokens, formatEnhanceLine } from "../chunking.js";
import type { RunContext, WorkflowDeps } from "../context.js";
import {
  buildCorrectSystemPrompt,
  buildCorrectUserPrompt,
} from "../prompts.js";
import { correctChunkStepSchema, normalizeId } from "../schemas.js";
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
  skippedBecause,
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

/**
 * Walks the word alignment of old to new and calls `onGap` once for each gap
 * between matched words (and at the end): the old words it loses and the new
 * words it gains. Returns false as soon as `onGap` returns false.
 */
function everyGap(
  a: string[],
  b: string[],
  onGap: (removed: string[], added: string[]) => boolean,
): boolean {
  const lcs = lcsTable(a, b);
  let i = 0;
  let j = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const closeGap = () => {
    if (removed.length === 0 && added.length === 0) return true;
    const ok = onGap(removed, added);
    removed = [];
    added = [];
    return ok;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (!closeGap()) return false;
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
  return closeGap();
}

/** A correction may add at most this many words net. */
const MAX_NET_ADDED_WORDS = 2;
/** A run of new words with no old word in its place holds at most this many words. */
const MAX_INSERTED_RUN = 1;
/** Share of the original words that must stay, in order. */
const MIN_WORD_OVERLAP = 0.5;

/**
 * True when the new text adds many words, inserts a run of more than one new
 * word where no old word was, or keeps too little of the old text. A speech
 * recognizer seldom drops two words in a row; a model that writes them in
 * invents content.
 */
function tooDifferent(oldWords: string[], newWords: string[]): boolean {
  if (newWords.length - oldWords.length > MAX_NET_ADDED_WORDS) return true;
  if (oldWords.length === 0) return false;
  const kept = lcsTable(oldWords, newWords)[0]![0]!;
  if (kept / oldWords.length < MIN_WORD_OVERLAP) return true;
  return !everyGap(
    oldWords,
    newWords,
    (removed, added) => removed.length > 0 || added.length <= MAX_INSERTED_RUN,
  );
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

/**
 * Grammar words. A speech recognizer seldom drops one of them in a way that
 * the reference transcript keeps; a small model adds them to "fix" the grammar
 * of spoken language. English and Portuguese. Negations are not here: the
 * negation check handles them.
 */
const FUNCTION_WORDS = new Set([
  // English: articles, prepositions, particles, pronouns, auxiliaries, conjunctions.
  ..."a an the to of in on at for with from by about as into onto up out off over".split(
    " ",
  ),
  ..."i you he she it we they me him her us them my your his its our their this that these those there".split(
    " ",
  ),
  ..."is are was were be been am do does did have has had will would can could should shall may might must".split(
    " ",
  ),
  ..."and or but so if then than just".split(" "),
  // Portuguese.
  ..."o os as ao aos à às um uma uns umas de do da dos das em no na nos nas num numa para pra pro por pelo pela com e ou que se".split(
    " ",
  ),
  ..."eu ele ela nós eles elas me te lhe é foi ser está estar tá".split(" "),
]);

/**
 * Spoken (informal) forms and their written form. A change from one to the
 * other changes the register, not a recognition error. English and Portuguese.
 */
const REGISTER_FORMS: ReadonlyMap<string, string[]> = new Map([
  ["gonna", ["going", "to"]],
  ["wanna", ["want", "to"]],
  ["gotta", ["got", "to"]],
  ["hafta", ["have", "to"]],
  ["kinda", ["kind", "of"]],
  ["sorta", ["sort", "of"]],
  ["outta", ["out", "of"]],
  ["lotta", ["lot", "of"]],
  ["gimme", ["give", "me"]],
  ["lemme", ["let", "me"]],
  ["cause", ["because"]],
  ["cuz", ["because"]],
  ["cos", ["because"]],
  ["ya", ["you"]],
  ["yeah", ["yes"]],
  ["yep", ["yes"]],
  ["tá", ["está"]],
  ["tô", ["estou"]],
  ["tava", ["estava"]],
  ["pra", ["para"]],
  ["pro", ["para", "o"]],
  ["cê", ["você"]],
  ["vc", ["você"]],
  ["né", ["não", "é"]],
]);

/** The words with every spoken form replaced by its written form. */
function writtenForms(words: string[]): string[] {
  return words.flatMap((w) => REGISTER_FORMS.get(w) ?? [w]);
}

/**
 * True when the two texts differ only in grammar or register: after the
 * repeat collapse and the spoken-form expansion, every gap of the word
 * alignment is either a run of old words that match the same number of new
 * words one for one, each pair an inflection, or a pure insertion of grammar
 * words ("look" to "look at"). A change of a spoken form only ("gonna" to
 * "going to") is also grammar only. Any other change (a different word, a
 * lost word, a split or joined word) makes the correction a real fix, and the
 * whole correction stays.
 */
function grammarOnly(oldWords: string[], newWords: string[]): boolean {
  const a0 = collapseRepeats(oldWords);
  const b0 = collapseRepeats(newWords);
  const a = writtenForms(a0);
  const b = writtenForms(b0);
  let gaps = 0;
  const ok = everyGap(a, b, (removed, added) => {
    gaps++;
    if (removed.length === 0) return added.every((w) => FUNCTION_WORDS.has(w));
    return (
      removed.length === added.length &&
      removed.every((w, k) => isInflection(w, added[k]!))
    );
  });
  if (!ok) return false;
  // No gap after the expansion: only a spoken form changed (or nothing did).
  return gaps > 0 || a0.join(" ") !== b0.join(" ");
}

/**
 * True when the correction lowercases a word that the original has with an
 * uppercase letter inside a sentence (a name or an acronym), for example
 * "Tableau" to "tableau" or "RAG" to "rag". The first word of a sentence is
 * not checked. The rule applies only when the new text has the word in lower
 * case and does not have the original form.
 */
function lowercasesName(oldText: string, newText: string): boolean {
  const strip = (w: string) => w.replace(/[\p{P}\p{S}]/gu, "");
  const newForms = new Set(newText.split(/\s+/).map(strip).filter(Boolean));
  const oldTokens = oldText.split(/\s+/).filter(Boolean);
  return oldTokens.some((token, k) => {
    const word = strip(token);
    if (!word || word === word.toLowerCase()) return false;
    const sentenceStart = k === 0 || /[.!?…]["')\]]*$/u.test(oldTokens[k - 1]!);
    if (sentenceStart) return false;
    return !newForms.has(word) && newForms.has(word.toLowerCase());
  });
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Removes one speaker label at the start of a correction: "Me:", "Them:",
 * "Them 7:" or the display label of the segment (for example a confirmed
 * name), in any case, with optional spaces. A label later in the text is
 * not touched. Returns the trimmed text.
 */
export function stripSpeakerLabel(text: string, displayLabel: string): string {
  const own = displayLabel.trim();
  const labels = ["me", "them(?:\\s*\\d+)?"];
  if (own) labels.push(escapeRegExp(own).replace(/\s+/g, "\\s+"));
  const label = new RegExp(`^\\s*(?:${labels.join("|")})\\s*:`, "iu");
  return text.replace(label, "").trim();
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
  raw.forEach((rawEntry, seq) => {
    // The per-call enum makes this a no-op for strict providers. Keep it for
    // providers that only read the schema in the prompt.
    const entry = { ...rawEntry, id: normalizeId(rawEntry.id) };
    const drop = (reason: CorrectionDropReason) => {
      dropped.push({ id: entry.id, reason, seq, callId });
    };
    const original = byId.get(entry.id);
    if (!original) {
      drop("unknown_id");
      return;
    }
    // The first entry that passes every check wins. An id is seen only when
    // its entry is accepted, so a dropped echo does not block a later fix.
    if (seen.has(entry.id)) {
      drop("duplicate_id");
      return;
    }
    // A local model sometimes echoes the "Speaker: " prefix of the line format,
    // or writes a speaker label only. The code removes one label.
    const text = stripSpeakerLabel(entry.text, original.displayLabel);
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
    // A change of grammar or register only (verb agreement, tense, plural,
    // an added grammar word, "gonna" to "going to") is not a fix.
    if (grammarOnly(oldWords, newWords)) {
      drop("inflection_only");
      return;
    }
    // A name or an acronym must keep its capital letters.
    if (lowercasesName(original.text, text)) {
      drop("lowercases_name");
      return;
    }
    seen.add(entry.id);
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
    ctx.progress.chunkStarted(input.chunkIndex, input.segments[0]?.text ?? "");
    try {
      return await correctChunk(input, ctx, system, systemTokens);
    } finally {
      ctx.progress.chunkEnded(input.chunkIndex);
    }
  }

  async function correctChunk(
    input: CorrectChunkInput,
    ctx: RunContext,
    system: string,
    systemTokens: number,
  ): Promise<CorrectChunkResult> {
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
              schema: correctChunkStepSchema(unit.members.map((s) => s.id)),
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
              onHeld: (held) => ctx.progress.callHeld(held),
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
    const result: CorrectChunkResult = {
      chunkIndex: input.chunkIndex,
      status: foldStatus(units.map((u) => u.status)),
      units,
    };
    if (result.status !== "skipped") return result;
    // No unit: the chunk has no text. A skipped unit: the run stopped first.
    return skippedBecause(
      result,
      units.length === 0 ? "empty_transcript" : "stopped",
    );
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
