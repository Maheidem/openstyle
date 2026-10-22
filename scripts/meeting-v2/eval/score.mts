// score.mts: the gold scorers of the meeting quality eval. Pure functions:
// they take a gold key (gold.mts) and plain database rows, and return
// counts, rates and keys. A key is a channel and a start
// ("system@83400"), a gold id, an output index ("actionItems[2]") or a
// speaker label. A score never holds meeting text.
//
// Stages:
//   asr       WER and CER per channel of the raw segment text vs the gold
//             transcript, for all text and for verified text only
//   enhance   the same for the enhanced text, the Enhance delta (ASR WER -
//             Enhance WER), fixes found and missed, must-not-change
//             violations
//   summary   gold decisions and action items matched by keywords, owner
//             and due correct / wrong / missing, unmatched output items,
//             must-not-claim hits (a hit is a hard fail)
//   tags      precision and recall against the expected tags and synonyms
//   speakers  suggested names vs the gold map (a wrong name is a hard fail)

import { normalizeTagName } from "../../../packages/validations/src/meeting-tags.ts";
import { levenshtein, type SegmentRow } from "./checks.mts";
import { CHANNELS, type Channel, type Gold, type GoldItem } from "./gold.mts";

// --- Text normalization ----------------------------------------------------------

/**
 * The words of a text: lower case, every character that is not a letter or
 * a digit is a space. The same rule as `words()` in metrics.mjs and
 * `normalizeText` in packages/stt/src/text.ts.
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const round = (v: number, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const rate = (errors: number, ref: number): number | null =>
  ref === 0 ? null : round(errors / ref);

// --- Word alignment, WER and CER ------------------------------------------------------

type Op = "eq" | "sub" | "del" | "ins";
interface Step {
  op: Op;
  /** Index into the reference, or -1 for an insertion. */
  r: number;
  /** Index into the hypothesis, or -1 for a deletion. */
  h: number;
}

/** The largest alignment matrix (reference words x hypothesis words). */
const MAX_CELLS = 400_000_000;

/**
 * A minimal edit alignment of two word arrays (Levenshtein with a
 * backtrace). Ties prefer a match or a substitution, then a deletion, then
 * an insertion, so the result is deterministic.
 */
export function alignWords(ref: string[], hyp: string[]): Step[] {
  const n = ref.length;
  const m = hyp.length;
  if ((n + 1) * (m + 1) > MAX_CELLS)
    throw new Error(
      `alignment too large (${n} x ${m} words); split the channel`,
    );
  // dir: 0 diagonal, 1 up (deletion), 2 left (insertion).
  const dir = new Uint8Array((n + 1) * (m + 1));
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    dir[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    dir[i * (m + 1)] = 1;
    const ri = ref[i - 1];
    for (let j = 1; j <= m; j++) {
      const diag = (prev[j - 1] as number) + (ri === hyp[j - 1] ? 0 : 1);
      const up = (prev[j] as number) + 1;
      const left = (cur[j - 1] as number) + 1;
      let best = diag;
      let d = 0;
      if (up < best) {
        best = up;
        d = 1;
      }
      if (left < best) {
        best = left;
        d = 2;
      }
      cur[j] = best;
      dir[i * (m + 1) + j] = d;
    }
    [prev, cur] = [cur, prev];
  }
  const steps: Step[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const d = i === 0 ? 2 : j === 0 ? 1 : (dir[i * (m + 1) + j] as number);
    if (d === 0) {
      steps.push({
        op: ref[i - 1] === hyp[j - 1] ? "eq" : "sub",
        r: i - 1,
        h: j - 1,
      });
      i--;
      j--;
    } else if (d === 1) {
      steps.push({ op: "del", r: i - 1, h: -1 });
      i--;
    } else {
      steps.push({ op: "ins", r: -1, h: j - 1 });
      j--;
    }
  }
  return steps.reverse();
}

export interface ErrorRate {
  errors: number;
  ref: number;
  rate: number | null;
}

export interface ChannelScore {
  words: ErrorRate;
  chars: ErrorRate;
  wordsVerified: ErrorRate;
  charsVerified: ErrorRate;
  substitutions: number;
  deletions: number;
  insertions: number;
}

const er = (errors: number, ref: number): ErrorRate => ({
  errors,
  ref,
  rate: rate(errors, ref),
});

/** The characters of words joined by one space, with a verified flag per word. */
function charCount(ws: string[], flags: boolean[], onlyVerified: boolean) {
  let n = 0;
  for (let k = 0; k < ws.length; k++) {
    if (onlyVerified && !flags[k]) continue;
    n += Array.from(ws[k] as string).length;
    // One separator to the next word (both verified for the verified count).
    if (k + 1 < ws.length && (!onlyVerified || flags[k + 1])) n += 1;
  }
  return n;
}

/**
 * WER and CER of a hypothesis against a reference. `verified` holds one
 * flag per reference word. An error counts as verified when its reference
 * word is verified; an insertion takes the flag of the reference word
 * before it (or the first word at the start).
 *
 * WER = (substitutions + deletions + insertions) / reference words.
 * CER is computed on the word alignment: the character edit distance of
 * each span between two equal words, over the characters of the reference
 * joined by single spaces. A span with words on one side only also counts
 * the one space that goes with it.
 */
export function errorRates(
  ref: string[],
  hyp: string[],
  verified: boolean[] = ref.map(() => true),
): ChannelScore {
  const steps = alignWords(ref, hyp);
  const flagAt = (r: number) => (r < 0 ? false : (verified[r] ?? false));
  let lastRef = -1;
  let sub = 0;
  let del = 0;
  let ins = 0;
  let werV = 0;
  const anchors: number[] = [];
  for (const s of steps) {
    const anchor = s.r >= 0 ? s.r : lastRef >= 0 ? lastRef : 0;
    anchors.push(anchor);
    if (s.r >= 0) lastRef = s.r;
    if (s.op === "eq") continue;
    if (s.op === "sub") sub++;
    else if (s.op === "del") del++;
    else ins++;
    if (flagAt(anchor)) werV++;
  }
  let charErr = 0;
  let charErrV = 0;
  for (let k = 0; k < steps.length; ) {
    if ((steps[k] as Step).op === "eq") {
      k++;
      continue;
    }
    const start = k;
    const r: string[] = [];
    const h: string[] = [];
    while (k < steps.length && (steps[k] as Step).op !== "eq") {
      const s = steps[k] as Step;
      if (s.r >= 0) r.push(ref[s.r] as string);
      if (s.h >= 0) h.push(hyp[s.h] as string);
      k++;
    }
    let d = levenshtein(Array.from(r.join(" ")), Array.from(h.join(" ")));
    if (r.length === 0 && ref.length > 0) d += 1;
    if (h.length === 0 && hyp.length > 0) d += 1;
    charErr += d;
    if (flagAt(anchors[start] as number)) charErrV += d;
  }
  const nV = verified.filter(Boolean).length;
  return {
    words: er(sub + del + ins, ref.length),
    chars: er(charErr, charCount(ref, verified, false)),
    wordsVerified: er(werV, nV),
    charsVerified: er(charErrV, charCount(ref, verified, true)),
    substitutions: sub,
    deletions: del,
    insertions: ins,
  };
}

const effective = (s: SegmentRow) => s.enhanced_text ?? s.text ?? "";
const byStart = (a: SegmentRow, b: SegmentRow) =>
  (a.start_ms ?? 0) - (b.start_ms ?? 0) || a.idx - b.idx;

/**
 * Score one channel at meeting level: the words of all gold turns in time
 * order vs the words of all segments of the channel in time order. A new
 * segmentation does not change the score.
 */
export function scoreChannel(
  gold: Gold,
  channel: Channel,
  rows: SegmentRow[],
  stage: "asr" | "enhance",
): ChannelScore | null {
  const turns = gold.transcript?.[channel];
  if (!turns) return null;
  const ref: string[] = [];
  const flags: boolean[] = [];
  for (const t of turns)
    for (const w of words(t.text)) {
      ref.push(w);
      flags.push(t.verified);
    }
  const hyp = rows
    .filter((s) => s.source === channel)
    .sort(byStart)
    .flatMap((s) => words(stage === "asr" ? (s.text ?? "") : effective(s)));
  return errorRates(ref, hyp, flags);
}

/** WER or CER of several channels together (sum of errors / sum of words). */
export function pooled(
  scores: (ChannelScore | null)[],
  field: keyof Pick<
    ChannelScore,
    "words" | "chars" | "wordsVerified" | "charsVerified"
  >,
): ErrorRate | null {
  const own = scores.filter((s): s is ChannelScore => s !== null);
  if (own.length === 0) return null;
  const e = own.reduce((a, s) => a + s[field].errors, 0);
  const r = own.reduce((a, s) => a + s[field].ref, 0);
  return er(e, r);
}

// --- Fixes and must-not-change spans (gold v2 keys) ------------------------------------

export interface FixScore {
  fixesFound: number;
  fixesMissed: number;
  missedKeys: string[];
  mustNotChangeViolations: number;
  violationKeys: string[];
  /** Entries with no segment within the tolerance, or a span not in the raw text. */
  badEntries: number;
}

/**
 * A fix is found when a segment of its channel within the time tolerance
 * holds `to` in the enhanced text and no longer holds `from` (`from` may be
 * ""). A must-not-change span is violated when the segments that hold it in
 * the raw text do not hold it in the enhanced text.
 */
export function scoreFixes(gold: Gold, rows: SegmentRow[]): FixScore {
  const near = (channel: Channel, startMs: number) =>
    rows.filter(
      (s) =>
        s.source === channel &&
        s.start_ms !== null &&
        Math.abs(s.start_ms - startMs) <= gold.timeToleranceMs,
    );
  const out: FixScore = {
    fixesFound: 0,
    fixesMissed: 0,
    missedKeys: [],
    mustNotChangeViolations: 0,
    violationKeys: [],
    badEntries: 0,
  };
  for (const f of gold.fixes) {
    const cands = near(f.channel, f.startMs);
    if (cands.length === 0) {
      out.badEntries++;
      continue;
    }
    const found = cands.some((s) => {
      const t = effective(s);
      const gone =
        f.from === "" || f.to.includes(f.from) || !t.includes(f.from);
      return t.includes(f.to) && gone;
    });
    if (found) out.fixesFound++;
    else {
      out.fixesMissed++;
      out.missedKeys.push(`${f.channel}@${f.startMs}`);
    }
  }
  for (const m of gold.mustNotChange) {
    const holders = near(m.channel, m.startMs).filter((s) =>
      (s.text ?? "").includes(m.span),
    );
    if (holders.length === 0) {
      out.badEntries++;
      continue;
    }
    if (!holders.every((s) => effective(s).includes(m.span))) {
      out.mustNotChangeViolations++;
      out.violationKeys.push(`${m.channel}@${m.startMs}`);
    }
  }
  return out;
}

// --- Summary ------------------------------------------------------------------------

/** True when the words of `phrase` appear in order, next to each other, in `text`. */
function holds(textWords: string[], phrase: string): boolean {
  const p = words(phrase);
  if (p.length === 0) return false;
  outer: for (let i = 0; i + p.length <= textWords.length; i++) {
    for (let k = 0; k < p.length; k++)
      if (textWords[i + k] !== p[k]) continue outer;
    return true;
  }
  return false;
}
const holdsAll = (text: string, keywords: string[]) => {
  const w = words(text);
  return keywords.every((k) => holds(w, k));
};

/** Two names or times are the same when the words of one hold all words of the other. */
function sameWords(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const sa = new Set(wa);
  const sb = new Set(wb);
  return wa.every((w) => sb.has(w)) || wb.every((w) => sa.has(w));
}

/**
 * The output value is the gold value. A gold value "A (B)" names one person
 * or time in two forms, for example "Ana (Them 2)" or "Me (Ana)". The output
 * can use either form, so it is compared with the whole value, with A and
 * with B. Issue #273: the output "Ana Lima" for the gold "Ana (Them 2)" was
 * scored wrong, because neither word set held the other.
 */
function sameValue(gold: string, output: string): boolean {
  const forms = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(gold);
  const alternatives = forms ? [gold, forms[1] ?? "", forms[2] ?? ""] : [gold];
  return alternatives.some((g) => sameWords(g, output));
}

export interface ValueScore {
  correct: number;
  wrong: number;
  missing: number;
  /** Gold ids with a wrong value. */
  wrongIds: string[];
}

export interface KindScore {
  gold: number;
  output: number;
  matched: number;
  recall: number | null;
  precision: number | null;
  /** Gold ids that no output item matched. */
  missedIds: string[];
  /** Output items that match no gold item, by index ("actionItems[2]"). */
  unmatchedOutput: string[];
}

export interface SummaryScore {
  /** false when summary_json is missing or not a summary object. */
  parsed: boolean;
  decisions: KindScore;
  actionItems: KindScore;
  owner: ValueScore;
  due: ValueScore;
  /** Must-not-claim ids that the output holds (each one is a hard fail). */
  mustNotClaimHits: string[];
}

interface OutItem {
  text: string;
  owner: string | null;
  due: string | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v : null;

function parseSummary(json: string | null) {
  try {
    const v = JSON.parse(json ?? "null");
    if (typeof v !== "object" || v === null) return null;
    const list = (x: unknown) => (Array.isArray(x) ? x : []);
    return {
      decisions: list(v.decisions).map(
        (d): OutItem => ({ text: str(d), owner: null, due: null }),
      ),
      actionItems: list(v.actionItems).map(
        (a): OutItem => ({
          text: str(a?.task),
          owner: strOrNull(a?.owner),
          due: strOrNull(a?.due),
        }),
      ),
      other: [str(v.overview), ...list(v.keyPoints), ...list(v.openQuestions)]
        .map(str)
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

function matchKind(
  kind: "decisions" | "actionItems",
  gold: GoldItem[],
  out: OutItem[],
  owner: ValueScore,
  due: ValueScore,
): KindScore {
  const used = new Set<number>();
  const missedIds: string[] = [];
  const value = (
    s: ValueScore,
    id: string,
    g: string | null,
    o: string | null,
  ) => {
    if (g === null && o === null) s.correct++;
    else if (g === null || (o !== null && !sameValue(g, o))) {
      s.wrong++;
      s.wrongIds.push(id);
    } else if (o === null) s.missing++;
    else s.correct++;
  };
  for (const g of gold) {
    const k = out.findIndex(
      (o, i) => !used.has(i) && holdsAll(o.text, g.keywords),
    );
    if (k < 0) {
      missedIds.push(g.id);
      continue;
    }
    used.add(k);
    const o = out[k] as OutItem;
    value(owner, g.id, g.owner, o.owner);
    value(due, g.id, g.due, o.due);
  }
  const matched = used.size;
  return {
    gold: gold.length,
    output: out.length,
    matched,
    recall: rate(matched, gold.length),
    precision: rate(matched, out.length),
    missedIds,
    unmatchedOutput: out.flatMap((_, i) =>
      used.has(i) ? [] : [`${kind}[${i}]`],
    ),
  };
}

/**
 * Score the summary_json of a run against the gold summary. An output item
 * matches a gold item when its text holds every keyword of the gold item
 * (each keyword as a word sequence). Each output item matches one gold item
 * at most (first match in gold order). Owner and due are scored on the
 * matched items only: a value where the gold has none is wrong (an invented
 * owner or date). A must-not-claim entry is hit when one output text (an
 * action item with its owner and due, a decision, a key point, an open
 * question or the overview) holds all its keywords.
 */
export function scoreSummary(
  gold: Gold,
  summaryJson: string | null,
): SummaryScore | null {
  const g = gold.summary;
  if (!g) return null;
  const parsed = parseSummary(summaryJson);
  const out = parsed ?? { decisions: [], actionItems: [], other: [] };
  const owner: ValueScore = { correct: 0, wrong: 0, missing: 0, wrongIds: [] };
  const due: ValueScore = { correct: 0, wrong: 0, missing: 0, wrongIds: [] };
  const decisions = matchKind(
    "decisions",
    g.decisions,
    out.decisions,
    owner,
    due,
  );
  const actionItems = matchKind(
    "actionItems",
    g.actionItems,
    out.actionItems,
    owner,
    due,
  );
  const texts = [
    ...out.decisions.map((d) => d.text),
    ...out.actionItems.map((a) =>
      [a.text, a.owner ?? "", a.due ?? ""].join(" "),
    ),
    ...out.other,
  ];
  return {
    parsed: parsed !== null,
    decisions,
    actionItems,
    owner,
    due,
    mustNotClaimHits: g.mustNotClaim
      .filter((c) => texts.some((t) => holdsAll(t, c.keywords)))
      .map((c) => c.id),
  };
}

// --- Tags ---------------------------------------------------------------------------

export interface TagScore {
  output: number;
  expected: number;
  /** Output tags that equal an expected tag or a synonym. */
  matchedOutput: number;
  /** Expected tags that an output tag names (by name or synonym). */
  matchedExpected: number;
  precision: number | null;
  recall: number | null;
  /** By index only ("tags[3]", "expected[1]"). */
  unmatchedOutput: string[];
  missedExpected: string[];
}

/** Tag names are compared after normalizeTagName (the app's rule, meeting-tags.ts). */
export function scoreTags(gold: Gold, outputTags: string[]): TagScore | null {
  const g = gold.tags;
  if (!g) return null;
  const forms = g.expected.map(
    (e) =>
      new Set([e.name, ...e.synonyms].map(normalizeTagName).filter(Boolean)),
  );
  const out = outputTags.map(normalizeTagName);
  const outHit = out.map((t) => forms.some((f) => f.has(t)));
  const expHit = forms.map((f) => out.some((t) => f.has(t)));
  const mo = outHit.filter(Boolean).length;
  const me = expHit.filter(Boolean).length;
  return {
    output: out.length,
    expected: forms.length,
    matchedOutput: mo,
    matchedExpected: me,
    precision: rate(mo, out.length),
    recall: rate(me, forms.length),
    unmatchedOutput: outHit.flatMap((h, i) => (h ? [] : [`tags[${i}]`])),
    missedExpected: expHit.flatMap((h, i) => (h ? [] : [`expected[${i}]`])),
  };
}

// --- Speakers -----------------------------------------------------------------------

export interface SpeakerRow {
  label: string;
  suggested_name: string | null;
  suggested_kind?: string | null;
}

export interface SpeakerScore {
  correct: number;
  /** A name that differs from the gold name, or a name where the gold has none. */
  wrong: number;
  missing: number;
  wrongLabels: string[];
  missingLabels: string[];
}

/**
 * Score the speaker suggestions against the gold map (label -> name or
 * null). A suggestion of kind "role" is no name. A gold name with no
 * suggestion is missing. A suggested name that is not the gold name, or a
 * name for a label whose gold is null, is wrong (a hard fail). Labels that
 * the gold does not list are not scored.
 */
export function scoreSpeakers(
  gold: Gold,
  rows: SpeakerRow[],
): SpeakerScore | null {
  const g = gold.speakers;
  if (!g) return null;
  const s: SpeakerScore = {
    correct: 0,
    wrong: 0,
    missing: 0,
    wrongLabels: [],
    missingLabels: [],
  };
  for (const [label, name] of Object.entries(g).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const row = rows.find((r) => r.label === label);
    const said =
      row && row.suggested_kind !== "role"
        ? strOrNull(row.suggested_name)
        : null;
    if (name === null && said === null) s.correct++;
    else if (said === null) {
      s.missing++;
      s.missingLabels.push(label);
    } else if (name !== null && sameValue(name, said)) s.correct++;
    else {
      s.wrong++;
      s.wrongLabels.push(label);
    }
  }
  return s;
}

// --- Scorecard ----------------------------------------------------------------------

export interface Scorecard {
  goldVersion: number;
  /** null when the gold has no asrHash. */
  asrHashMatch: boolean | null;
  asr: Record<Channel, ChannelScore | null> | null;
  enhance: {
    channels: Record<Channel, ChannelScore | null> | null;
    /** ASR WER - Enhance WER per channel and pooled. Positive = Enhance helped. */
    delta: Record<Channel | "all", number | null> | null;
    fixes: FixScore;
  };
  summary: SummaryScore | null;
  tags: TagScore | null;
  speakers: SpeakerScore | null;
  /** Gold hard fails: "claim:<id>" and "speaker:<label>". */
  hardFails: string[];
}

export interface RunInput {
  segments: SegmentRow[];
  summaryJson: string | null;
  tags: string[];
  speakers: SpeakerRow[];
}

export function scoreRun(
  gold: Gold,
  run: RunInput,
  asrHash: string | null,
): Scorecard {
  const channels = (stage: "asr" | "enhance") =>
    gold.transcript
      ? (Object.fromEntries(
          CHANNELS.map((c) => [c, scoreChannel(gold, c, run.segments, stage)]),
        ) as Record<Channel, ChannelScore | null>)
      : null;
  const asr = channels("asr");
  const enh = channels("enhance");
  const diff = (
    a: ErrorRate | null | undefined,
    b: ErrorRate | null | undefined,
  ) => (a?.rate == null || b?.rate == null ? null : round(a.rate - b.rate));
  const delta =
    asr && enh
      ? {
          mic: diff(asr.mic?.words, enh.mic?.words),
          system: diff(asr.system?.words, enh.system?.words),
          all: diff(
            pooled(Object.values(asr), "words"),
            pooled(Object.values(enh), "words"),
          ),
        }
      : null;
  const summary = scoreSummary(gold, run.summaryJson);
  const speakers = scoreSpeakers(gold, run.speakers);
  return {
    goldVersion: gold.goldVersion,
    asrHashMatch:
      gold.asrHash === null || asrHash === null
        ? null
        : gold.asrHash === asrHash,
    asr,
    enhance: { channels: enh, delta, fixes: scoreFixes(gold, run.segments) },
    summary,
    tags: scoreTags(gold, run.tags),
    speakers,
    hardFails: [
      ...(summary?.mustNotClaimHits ?? []).map((id) => `claim:${id}`),
      ...(speakers?.wrongLabels ?? []).map((l) => `speaker:${l}`),
    ],
  };
}

// --- Stage metrics (numbers only; report and baseline) -----------------------------------

export const STAGES = [
  "asr",
  "enhance",
  "summary",
  "tags",
  "speakers",
] as const;
export type Stage = (typeof STAGES)[number];
export type StageMetrics = Record<string, number | null>;

function channelMetrics(
  ch: Record<Channel, ChannelScore | null> | null,
): StageMetrics {
  if (!ch) return {};
  const out: StageMetrics = {
    wer: pooled(Object.values(ch), "words")?.rate ?? null,
    cer: pooled(Object.values(ch), "chars")?.rate ?? null,
    werVerified: pooled(Object.values(ch), "wordsVerified")?.rate ?? null,
    cerVerified: pooled(Object.values(ch), "charsVerified")?.rate ?? null,
  };
  for (const c of CHANNELS) {
    const s = ch[c];
    out[`wer.${c}`] = s?.words.rate ?? null;
    out[`cer.${c}`] = s?.chars.rate ?? null;
    out[`werVerified.${c}`] = s?.wordsVerified.rate ?? null;
    out[`cerVerified.${c}`] = s?.charsVerified.rate ?? null;
  }
  return out;
}

/** The flat metrics of a scorecard, per stage. A stage with no gold has no metrics. */
export function stageMetrics(sc: Scorecard): Record<Stage, StageMetrics> {
  const s = sc.summary;
  const t = sc.tags;
  const sp = sc.speakers;
  const f = sc.enhance.fixes;
  return {
    asr: channelMetrics(sc.asr),
    enhance: {
      ...channelMetrics(sc.enhance.channels),
      ...(sc.enhance.delta ? { delta: sc.enhance.delta.all } : {}),
      fixesFound: f.fixesFound,
      fixesMissed: f.fixesMissed,
      mustNotChangeViolations: f.mustNotChangeViolations,
    },
    summary: s
      ? {
          decisionsRecall: s.decisions.recall,
          decisionsPrecision: s.decisions.precision,
          actionItemsRecall: s.actionItems.recall,
          actionItemsPrecision: s.actionItems.precision,
          ownerCorrect: s.owner.correct,
          ownerWrong: s.owner.wrong,
          ownerMissing: s.owner.missing,
          dueCorrect: s.due.correct,
          dueWrong: s.due.wrong,
          dueMissing: s.due.missing,
          mustNotClaimHits: s.mustNotClaimHits.length,
        }
      : {},
    tags: t ? { precision: t.precision, recall: t.recall } : {},
    speakers: sp
      ? { correct: sp.correct, wrong: sp.wrong, missing: sp.missing }
      : {},
  };
}
