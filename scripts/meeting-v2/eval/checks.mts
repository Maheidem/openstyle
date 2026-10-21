// checks.mts: the deterministic hard-fail checks, the run metrics and the
// v1 answer-key parser of the meeting Enhance eval (`pnpm meeting:eval`).
//
// The functions are pure. They take plain database rows and return counts
// and keys. A segment key is `source:idx@start_ms`. A key never holds
// transcript text, so the console and results.md can show it.
//
// Hard-fail checks (one Finding each, per model and meeting):
//   1 segments     a segment lost, added or moved (raw keys vs enhanced
//                  keys), or the raw `text` column changed
//   2 numbers      a number or time token changed, lost or added
//   3 names        a capitalized name of the raw text or of the meeting
//                  metadata removed, lowercased or replaced by a different
//                  name (a change of case, spacing or punctuation, a
//                  spelling fix, or a fix to a known form is not a fail)
//   4 negations    a negation added or removed
//   5 labels       the enhanced text starts with a speaker label ("Me:",
//                  "Them:", "Them 7:") and the raw text does not
//   6 chunks       a failed chunk, or a step whose last attempt ended with
//                  finish "length"
//   7 summary      check-summary did not pass, or an owner or due value is
//                  a placeholder word such as "null"
//   8 speakers     a speaker suggestion that only repeats a diarized label,
//                  or a name with a word that the transcript, the title, the
//                  user context and the attendee names do not hold
// Checks 2 to 5 compare the raw text with the enhanced text of each
// segment that has an enhanced text different from the raw text. The number
// and negation words are English (the reference meetings are English).

export interface SegmentRow {
  id: string;
  source: string;
  idx: number;
  start_ms: number | null;
  text: string | null;
  enhanced_text: string | null;
}

export interface Finding {
  count: number;
  keys: string[];
}

export const segmentKey = (s: {
  source: string;
  idx: number;
  start_ms: number | null;
}): string => `${s.source}:${s.idx}@${s.start_ms ?? ""}`;

const effective = (s: SegmentRow): string => s.enhanced_text ?? s.text ?? "";

/** The segments whose enhanced text differs from the raw text. */
function changedPairs(
  rows: SegmentRow[],
): { key: string; a: string; b: string }[] {
  return rows
    .filter((s) => s.enhanced_text !== null && s.enhanced_text !== s.text)
    .map((s) => ({ key: segmentKey(s), a: s.text ?? "", b: effective(s) }));
}

const finding = (keys: string[]): Finding => ({ count: keys.length, keys });

// --- 1. Segments -------------------------------------------------------------

export function checkSegments(
  raw: SegmentRow[],
  enhanced: SegmentRow[],
): Finding & {
  lost: number;
  added: number;
  moved: number;
  textChanged: number;
} {
  const counts = (rows: SegmentRow[]) => {
    const m = new Map<string, number>();
    for (const s of rows) m.set(segmentKey(s), (m.get(segmentKey(s)) ?? 0) + 1);
    return m;
  };
  const rawCounts = counts(raw);
  const enhCounts = counts(enhanced);
  const lost: string[] = [];
  const added: string[] = [];
  for (const [k, n] of rawCounts)
    for (let i = enhCounts.get(k) ?? 0; i < n; i++) lost.push(k);
  for (const [k, n] of enhCounts)
    for (let i = rawCounts.get(k) ?? 0; i < n; i++) added.push(k);
  const rawById = new Map(raw.map((s) => [s.id, s]));
  const moved: string[] = [];
  const textChanged: string[] = [];
  for (const s of enhanced) {
    const r = rawById.get(s.id);
    if (!r) continue;
    if (segmentKey(r) !== segmentKey(s)) moved.push(segmentKey(r));
    if (r.text !== s.text) textChanged.push(segmentKey(r));
  }
  const keys = [...lost, ...added, ...moved, ...textChanged];
  return {
    ...finding(keys),
    lost: lost.length,
    added: added.length,
    moved: moved.length,
    textChanged: textChanged.length,
  };
}

// --- 2. Numbers --------------------------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
  billion: 1_000_000_000,
};
const isNumberWord = (w: string) => w in UNITS || w in TENS || w in SCALES;

/**
 * The number values of a text, as strings, in text order. Digits keep their
 * digits ("1,000" and "1000" give "1000"). A time gives one value per part
 * ("5:20" gives "5" and "20"). Number words make one value per group
 * ("twenty five" gives "25", "five twenty" gives "5" and "20", the same as
 * "5:20").
 */
export function numberValues(text: string): string[] {
  const tokens = text.toLowerCase().match(/\d+(?:[.,:]\d+)*|[a-z]+/g) ?? [];
  const out: string[] = [];
  let active = false;
  let total = 0;
  let group = 0;
  let last = 0;
  const flush = () => {
    if (active) out.push(String(total + group));
    active = false;
    total = 0;
    group = 0;
    last = 0;
  };
  const start = (v: number) => {
    flush();
    active = true;
    group = v;
    last = v;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (/^\d/.test(t)) {
      flush();
      const parts = t.includes(":") ? t.split(":") : [t.replace(/[.,]/g, "")];
      for (const p of parts) out.push(p.replace(/^0+(?=\d)/, ""));
      continue;
    }
    if (t === "and" && active && isNumberWord(tokens[i + 1] ?? "")) continue;
    if (t in SCALES) {
      const scale = SCALES[t] as number;
      if (!active) {
        active = true;
        group = 1;
      }
      if (scale === 100) group = (group || 1) * 100;
      else {
        total += (group || 1) * scale;
        group = 0;
      }
      last = scale;
      continue;
    }
    if (t in TENS) {
      const v = TENS[t] as number;
      if (active && last >= 100) {
        group += v;
        last = v;
      } else start(v);
      continue;
    }
    if (t in UNITS) {
      const v = UNITS[t] as number;
      if (
        active &&
        ((last >= 20 && last < 100 && last % 10 === 0 && v < 10) || last >= 100)
      ) {
        group += v;
        last = v;
      } else start(v);
      continue;
    }
    flush();
  }
  flush();
  return out;
}

const sameMultiset = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function checkNumbers(rows: SegmentRow[]): Finding {
  return finding(
    changedPairs(rows)
      .filter((p) => !sameMultiset(numberValues(p.a), numberValues(p.b)))
      .map((p) => p.key),
  );
}

// --- 3. Names ----------------------------------------------------------------

/** Words that are capitalized but are no names. */
const NOT_NAMES = new Set(["I", "I'm", "I'll", "I've", "I'd", "OK", "Okay"]);

const stripWord = (w: string): string =>
  w
    .replace(/[‘’ʼ]/g, "'")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .replace(/'s$/i, "");
const isCapitalized = (w: string) => /^\p{Lu}/u.test(w);
const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The edit distance of two sequences: characters of a string, or the items
 * of an array (for example word tokens). Items are compared with ===.
 */
export function levenshtein<T>(a: ArrayLike<T>, b: ArrayLike<T>): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length] as number;
}

/** The folded capitalized words of the meeting metadata (title, attendees, ...). */
export function metadataNames(
  metadata: (string | null | undefined)[],
): Set<string> {
  const set = new Set<string>();
  for (const m of metadata) {
    for (const w of (m ?? "").split(/[\s,;:()[\]{}"<>@/|]+/)) {
      const word = stripWord(w);
      if (word.length >= 2 && isCapitalized(word)) set.add(fold(word));
    }
  }
  return set;
}

/** A folded word with no punctuation inside ("Falkor-DB" gives "falkordb"). */
const squash = (s: string) => fold(s).replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The known forms of a meeting: every word of the meeting text, the metadata
 * and the vocabulary, and each vocabulary term with no spaces. A name fix to
 * a known form may differ more than a small spelling fix ("Kias" to "Kiosks"
 * when the meeting says "kiosks" elsewhere).
 */
export function knownForms(
  texts: (string | null | undefined)[],
  terms: string[] = [],
): Set<string> {
  const set = new Set<string>();
  for (const t of [...texts, ...terms])
    for (const w of (t ?? "").split(/\s+/)) {
      const q = squash(w);
      if (q.length >= 2) set.add(q);
    }
  for (const t of terms) if (squash(t).length >= 2) set.add(squash(t));
  return set;
}

/** A small spelling fix: an edit distance of at most half the length (minimum 2). */
const smallFix = (a: string, b: string) =>
  levenshtein(a, b) <= Math.max(2, Math.ceil(a.length / 2));
/** A fix to a known form: an edit distance of at most half the longer length. */
const knownFix = (a: string, b: string) =>
  levenshtein(a, b) <= Math.ceil(Math.max(a.length, b.length) / 2);

/**
 * A name of the raw text is kept when the enhanced text has the same word,
 * the same word with other case or punctuation inside ("DataBricks" to
 * "Databricks"), or a new capitalized word that is a fix of it or of the name
 * joined with a word next to it ("Puppy Graph" to "PuppyGraph"). A fix is a
 * metadata name, a join or split ("Style" to "OpenStyle"), a small spelling
 * fix, or a known form of the meeting or the vocabulary with an edit distance
 * of at most half the longer word. A name removed, lowercased, or replaced by
 * a different name fails.
 */
export function checkNames(
  rows: SegmentRow[],
  names: Set<string>,
  known: Set<string> = new Set(),
): Finding {
  const keys: string[] = [];
  for (const p of changedPairs(rows)) {
    const oldTokens = p.a.split(/\s+/).filter(Boolean);
    const oldWords = oldTokens.map(stripWord);
    const oldFolded = new Set(oldWords.map(squash));
    const newWords = p.b.split(/\s+/).map(stripWord).filter(Boolean);
    const newSet = new Set(newWords);
    const newFolded = new Set(newWords.map(squash));
    const candidates = new Map<string, number>();
    oldTokens.forEach((token, k) => {
      const w = stripWord(token);
      if (w.length < 2 || NOT_NAMES.has(w)) return;
      const sentenceStart =
        k === 0 || /[.!?…]["')\]]*$/u.test(oldTokens[k - 1] as string);
      if (names.has(fold(w)) || (isCapitalized(w) && !sentenceStart))
        candidates.set(w, k);
    });
    const broken = [...candidates].some(([w, k]) => {
      if (newSet.has(w)) return false;
      const fw = squash(w);
      // A metadata name in lower case in the raw text: any case is kept.
      if (!isCapitalized(w) && newFolded.has(fw)) return false;
      // Only the case or the punctuation inside changed, the name stays capitalized.
      if (newWords.some((t) => isCapitalized(t) && squash(t) === fw))
        return false;
      if (isCapitalized(w) && newFolded.has(fw)) return true; // lowercased
      // The name, and the name joined with the word before or after it.
      const forms = [
        fw,
        squash(`${oldWords[k - 1] ?? ""}${w}`),
        squash(`${w}${oldWords[k + 1] ?? ""}`),
      ].filter((f, i) => i === 0 || f !== fw);
      return !newWords.some((t) => {
        const ft = squash(t);
        // A word of the raw text is no fix (a sentence start can be new).
        if (!isCapitalized(t) || oldFolded.has(ft)) return false;
        if (names.has(ft) || ft.includes(fw) || fw.includes(ft)) return true;
        // A joined form allows only 2 edits, unless the fix is a known form.
        return forms.some(
          (f, i) =>
            (i === 0 ? smallFix(f, ft) : levenshtein(f, ft) <= 2) ||
            (known.has(ft) && knownFix(f, ft)),
        );
      });
    });
    if (broken) keys.push(p.key);
  }
  return finding(keys);
}

// --- 4. Negations ------------------------------------------------------------

/** The negation words of the app's meaning_flip rule (correct-chunk.ts). */
const NEGATIONS = new Set(["not", "no", "never", "nothing", "none", "nobody"]);

export function negationCount(text: string): number {
  const words =
    text
      .toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      .match(/[\p{L}']+/gu) ?? [];
  return words.filter((w) => NEGATIONS.has(w) || w.endsWith("n't")).length;
}

export function checkNegations(rows: SegmentRow[]): Finding {
  return finding(
    changedPairs(rows)
      .filter((p) => negationCount(p.a) !== negationCount(p.b))
      .map((p) => p.key),
  );
}

// --- 5. Speaker label in the text --------------------------------------------

/**
 * A speaker label at the start of a text, in any case, with optional
 * spaces. The same pattern as the app's stripSpeakerLabel (correct-chunk.ts)
 * without the display label, which the segment rows do not have.
 */
const SPEAKER_LABEL = /^\s*(?:me|them(?:\s*\d+)?)\s*:/iu;

export function checkLabels(rows: SegmentRow[]): Finding {
  return finding(
    changedPairs(rows)
      .filter((p) => SPEAKER_LABEL.test(p.b) && !SPEAKER_LABEL.test(p.a))
      .map((p) => p.key),
  );
}

// --- 6. Chunks and finish ------------------------------------------------------

export interface CallRow {
  run_id: string;
  step_key: string;
  schema_name: string;
  attempt: number;
  finish_unified: string | null;
}

export function checkChunks(
  failedChunks: number[],
  chunksFailed: number,
  calls: CallRow[],
): Finding & { failedChunks: number; unrecoveredLength: number } {
  const lastAttempt = new Map<string, CallRow>();
  for (const c of calls) {
    const k = `${c.run_id}|${c.step_key}`;
    const prev = lastAttempt.get(k);
    if (!prev || c.attempt >= prev.attempt) lastAttempt.set(k, c);
  }
  const length = [...lastAttempt.values()]
    .filter((c) => c.finish_unified === "length")
    .map((c) => `step:${c.step_key}`);
  const chunkKeys = failedChunks.map((n) => `chunk:${n}`);
  // A failed chunk with no number still counts.
  for (let i = chunkKeys.length; i < chunksFailed; i++)
    chunkKeys.push("chunk:?");
  return {
    ...finding([...chunkKeys, ...length]),
    failedChunks: chunkKeys.length,
    unrecoveredLength: length.length,
  };
}

// --- 7. Summary ----------------------------------------------------------------

/** The placeholder words of the app's valueOrNull (workflow/schemas.ts). */
const PLACEHOLDERS = new Set(["", "null", "none", "n/a", "unknown"]);

export function checkSummary(
  checkSummaryPass: boolean | null | undefined,
  summaryJson: string | null,
  markdown: string | null,
): Finding & { placeholders: number } {
  const keys: string[] = [];
  if (checkSummaryPass !== true) keys.push("check-summary");
  let placeholders = 0;
  try {
    const items = (JSON.parse(summaryJson ?? "null")?.actionItems ?? []) as {
      owner?: unknown;
      due?: unknown;
    }[];
    items.forEach((a, i) => {
      for (const f of ["owner", "due"] as const) {
        const v = a?.[f];
        if (typeof v === "string" && PLACEHOLDERS.has(v.trim().toLowerCase())) {
          keys.push(`actionItems[${i}].${f}`);
          placeholders += 1;
        }
      }
    });
  } catch {
    // check-summary already fails an unparsable summary_json.
  }
  (markdown ?? "").split("\n").forEach((line, i) => {
    if (/\b(?:Owner|Due): (?:null|none|n\/a|unknown)\b/i.test(line)) {
      keys.push(`markdown:line${i + 1}`);
      placeholders += 1;
    }
  });
  return { ...finding(keys), placeholders };
}

// --- 8. Speaker names ------------------------------------------------------------

/** A suggestion that only repeats a diarized label ("Them 1", "Me", "Speaker 2"). */
const LABEL_AS_NAME = /^\s*(?:me|them(?:\s*\d+)?|speaker\s*\d+)\s*$/iu;

/**
 * The attendee names of a calendar_attendees JSON value, as the app reads them
 * (parseAttendees in store.ts; names only, never emails).
 */
export function attendeeNames(json: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(json ?? "[]");
    if (!Array.isArray(v)) return [];
    return v
      .map((a) =>
        a && typeof a === "object" ? (a as { name?: unknown }).name : "",
      )
      .filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * A suggestion fails when it only repeats a diarized label, or when it is a
 * name (kind "name", or no kind) with a word that the support texts do not
 * hold. The support texts are the ones the app uses for a surname
 * (supportTexts in verify-evidence.ts): the transcript, the meeting title,
 * the user context and the attendee names. A role ("the client") is no name,
 * so only the label rule applies to it.
 */
export function checkSpeakerNames(
  speakers: {
    label: string;
    suggested_name: string | null;
    suggested_kind?: string | null;
  }[],
  texts: (string | null | undefined)[],
): Finding {
  const words = new Set<string>();
  for (const t of texts)
    for (const w of fold(t ?? "").match(/[\p{L}\p{N}]+/gu) ?? []) words.add(w);
  return finding(
    speakers
      .filter((s) => s.suggested_name?.trim())
      .filter((s) => {
        const name = s.suggested_name as string;
        if (LABEL_AS_NAME.test(name)) return true;
        if (s.suggested_kind === "role") return false;
        return (fold(name).match(/[\p{L}\p{N}]+/gu) ?? []).some(
          (w) => !words.has(w),
        );
      })
      .map((s) => `speaker:${s.label}`),
  );
}

// --- Metrics -------------------------------------------------------------------

export interface LinkRow {
  target_type: string;
  outcome: string;
  reason: string | null;
}

export interface RunMetrics {
  applied: number;
  correctionEntries: number;
  unchanged: number;
  echoRate: number | null;
  dropsCorrection: Record<string, number>;
  dropsSpeaker: Record<string, number>;
  finish: Record<string, { stop: number; length: number; other: number }>;
  suggestions: number;
}

export function runMetrics(
  links: LinkRow[],
  calls: CallRow[],
  speakers: { suggested_name: string | null }[],
): RunMetrics {
  const seg = links.filter((l) => l.target_type === "segment");
  const tally = (rows: LinkRow[]) => {
    const out: Record<string, number> = {};
    for (const l of rows) {
      const r = l.reason ?? "none";
      out[r] = (out[r] ?? 0) + 1;
    }
    return Object.fromEntries(
      Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
    );
  };
  const unchanged = seg.filter(
    (l) => l.outcome === "dropped" && l.reason === "unchanged",
  ).length;
  const finish: RunMetrics["finish"] = {};
  for (const c of calls) {
    finish[c.schema_name] ??= { stop: 0, length: 0, other: 0 };
    const f = finish[c.schema_name] as {
      stop: number;
      length: number;
      other: number;
    };
    if (c.finish_unified === "stop") f.stop += 1;
    else if (c.finish_unified === "length") f.length += 1;
    else f.other += 1;
  }
  return {
    applied: seg.filter((l) => l.outcome === "applied").length,
    correctionEntries: seg.length,
    unchanged,
    echoRate: seg.length
      ? Math.round((unchanged / seg.length) * 1000) / 1000
      : null,
    dropsCorrection: tally(seg.filter((l) => l.outcome === "dropped")),
    dropsSpeaker: tally(
      links.filter(
        (l) => l.target_type === "speaker" && l.outcome === "dropped",
      ),
    ),
    finish,
    suggestions: speakers.filter((s) => s.suggested_name?.trim()).length,
  };
}

// --- Answer key ------------------------------------------------------------------
//
// An answer key is a local, private JSON file. Never commit one: it holds
// meeting text. Format (version 1):
//
//   {
//     "version": 1,
//     "meetings": {
//       "<id8>": {
//         "fixes": [{ "key": "system:12@83400", "from": "open style", "to": "Openstyle" }],
//         "mustNotChange": [{ "key": "mic:3@15020", "span": "twenty five" }]
//       }
//     }
//   }
//
// key: a segment key (source:idx@start_ms), as results.md and the compare
// files show it. gold.mts goldFromAnswerKey turns a v1 key into a gold v2
// key (fixes and mustNotChange only), and score.mts scoreFixes scores it: a
// fix is found when the enhanced text of the segment holds `to` and no
// longer holds `from` (`from` may be ""); a must-not-change span is violated
// when the raw text holds it and the enhanced text does not.

export interface AnswerKeyMeeting {
  fixes: { key: string; from: string; to: string }[];
  mustNotChange: { key: string; span: string }[];
}
export type AnswerKey = Record<string, AnswerKeyMeeting>;

/** Parse and validate an answer key. Errors name the field, never its text. */
export function parseAnswerKey(json: string): AnswerKey {
  const v = JSON.parse(json) as { version?: unknown; meetings?: unknown };
  if (v?.version !== 1) throw new Error("answer key: version must be 1");
  if (typeof v.meetings !== "object" || v.meetings === null)
    throw new Error("answer key: meetings must be an object");
  const out: AnswerKey = {};
  for (const [id8, m] of Object.entries(
    v.meetings as Record<string, unknown>,
  )) {
    const e = m as { fixes?: unknown; mustNotChange?: unknown };
    const fixes = e?.fixes ?? [];
    const mnc = e?.mustNotChange ?? [];
    if (!Array.isArray(fixes) || !Array.isArray(mnc))
      throw new Error(
        `answer key ${id8}: fixes and mustNotChange must be arrays`,
      );
    fixes.forEach((f, i) => {
      if (
        typeof f?.key !== "string" ||
        typeof f?.from !== "string" ||
        typeof f?.to !== "string" ||
        f.to === ""
      )
        throw new Error(
          `answer key ${id8}: fixes[${i}] needs key, from and a non-empty to`,
        );
    });
    mnc.forEach((f, i) => {
      if (
        typeof f?.key !== "string" ||
        typeof f?.span !== "string" ||
        f.span === ""
      )
        throw new Error(
          `answer key ${id8}: mustNotChange[${i}] needs key and a non-empty span`,
        );
    });
    out[id8.slice(0, 8)] = { fixes, mustNotChange: mnc };
  }
  return out;
}
