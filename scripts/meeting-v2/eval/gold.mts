// gold.mts: the gold key v2 of the meeting quality eval (`pnpm meeting:eval
// --gold`): types, validation, the loader, and the adapter from the v1
// answer key (`--answer-key`, checks.mts).
//
// A gold key is private. It holds real meeting text. One file per meeting:
// ~/.openstyle-eval/gold/<id8>.json. The folder must have mode 0700. Never
// put a gold key in the repo or under /tmp.
//
// Format (goldVersion counts the edits of one meeting's gold, from 1):
//
//   {
//     "format": "openstyle-gold",
//     "meeting": "<id8>",
//     "goldVersion": 3,
//     "asrHash": "<hash of the transcription the gold was built on>",
//     "builtAt": "2026-10-21T10:00:00Z",
//     "verifiedSpans": 12,
//     "timeToleranceMs": 2000,
//     "transcript": {
//       "mic":    [{ "startMs": 0, "endMs": 4200, "text": "...", "verified": true }],
//       "system": [...]
//     },
//     "fixes":         [{ "channel": "system", "startMs": 83400, "from": "open style", "to": "Openstyle" }],
//     "mustNotChange": [{ "channel": "mic", "startMs": 15020, "span": "twenty five" }],
//     "summary": {
//       "decisions":   [{ "id": "d1", "keywords": ["ship", "friday"], "owner": null, "due": null }],
//       "actionItems": [{ "id": "a1", "keywords": ["send", "invoice"], "owner": "Ana", "due": "next week" }],
//       "mustNotClaim": [{ "id": "c1", "keywords": ["bruno", "invoice"] }]
//     },
//     "tags": { "expected": [{ "name": "pricing", "synonyms": ["price"] }] },
//     "speakers": { "Them 1": "Ana", "Them 2": null }
//   }
//
// transcript, summary, tags and speakers are optional (null or absent = not
// scored). fixes and mustNotChange may be empty. A fix or a must-not-change
// span applies to the segments of its channel whose start is within
// timeToleranceMs of startMs, so the key survives a new segmentation.
// Ids are short names ([A-Za-z0-9_.-], at most 40 characters): results and
// baselines show them, so an id must never hold meeting text.
//
// Silver keys (a gold built from several engines and checked by a
// verifier, not by ear) add these optional fields:
//
//   "goldKind": "silver-2",
//   "spans": [{ "channel": "mic", "startMs": 15000, "endMs": 16200,
//               "text": "...", "label": "term", "in_vocab": true,
//               "confidence": "high", "witnesses": ["h1", "app"],
//               "verifier_conflict": true }],
//   "witnesses": { ... }, "verification": { ... },
//   transcript turns: "basis": ["h1", "h2"], "wer_eligible": true
//
// A span is a named term, product, person, org or place that the output must
// spell right (score.mts scoreSpans). label is one of SPAN_LABELS,
// confidence one of SPAN_CONFIDENCES. A turn with wer_eligible true counts
// in the eligible WER (score.mts). The scorers do not read witnesses,
// verification or basis; the loader only checks their types.
//
// Errors name the file field, never its text.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AnswerKey } from "./checks.mts";

export const CHANNELS = ["mic", "system"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface GoldTurn {
  startMs: number;
  endMs: number;
  text: string;
  verified: boolean;
  /** Silver keys: the turn counts in the eligible WER. Absent in v1/v2 keys. */
  werEligible?: boolean;
}

export const SPAN_LABELS = [
  "term",
  "product",
  "person",
  "org",
  "place",
  "other",
] as const;
export type SpanLabel = (typeof SPAN_LABELS)[number];
export const SPAN_CONFIDENCES = ["high", "medium", "unsure"] as const;
export type SpanConfidence = (typeof SPAN_CONFIDENCES)[number];

/** A named span of a silver key: a word group the output must spell right. */
export interface GoldSpan {
  channel: Channel;
  startMs: number;
  endMs: number;
  text: string;
  label: SpanLabel;
  inVocab: boolean;
  confidence: SpanConfidence;
  witnesses: string[];
  verifierConflict: boolean;
}
export interface GoldFix {
  channel: Channel;
  startMs: number;
  from: string;
  to: string;
}
export interface GoldMustNotChange {
  channel: Channel;
  startMs: number;
  span: string;
}
export interface GoldItem {
  id: string;
  keywords: string[];
  owner: string | null;
  due: string | null;
}
export interface GoldClaim {
  id: string;
  keywords: string[];
}
export interface GoldTag {
  name: string;
  synonyms: string[];
}
export interface GoldSummary {
  decisions: GoldItem[];
  actionItems: GoldItem[];
  mustNotClaim: GoldClaim[];
}

export type GoldSource = "gold-v2" | "answer-key-v1";

export interface Gold {
  source: GoldSource;
  meeting: string;
  goldVersion: number;
  /** Optional kind of the key, for example "silver-2"; null when absent. */
  goldKind?: string | null;
  asrHash: string | null;
  builtAt: string | null;
  verifiedSpans: number;
  timeToleranceMs: number;
  transcript: Record<Channel, GoldTurn[]> | null;
  fixes: GoldFix[];
  mustNotChange: GoldMustNotChange[];
  summary: GoldSummary | null;
  tags: { expected: GoldTag[] } | null;
  speakers: Record<string, string | null> | null;
  /** Silver keys only; null or absent when the key has no spans field. */
  spans?: GoldSpan[] | null;
  /** sha256 (hex) of the key file; loadGold sets it, absent for a v1 answer key. */
  fileSha256?: string;
}

/** The gold info that results.json and a baseline record (no text). */
export interface GoldInfo {
  source: GoldSource;
  versions: Record<string, number>;
  /** The goldKind values of the keys, sorted; "none" for a key without one. Absent in old files. */
  goldKinds?: string[];
  /**
   * The first 12 hex digits of sha256 over the lines "<id8> <sha256 of the
   * key file>", sorted by id8. null when a key has no file (v1 answer key).
   * Absent in old files.
   */
  goldHash?: string | null;
}

export const DEFAULT_GOLD_DIR = join(homedir(), ".openstyle-eval", "gold");
export const DEFAULT_TIME_TOLERANCE_MS = 2000;
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;

// --- Validation -------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isMs = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
const isChannel = (v: unknown): v is Channel => v === "mic" || v === "system";

function fail(where: string, what: string): never {
  throw new Error(`gold ${where}: ${what}`);
}

function arrayAt(o: Obj, key: string, where: string): unknown[] {
  const v = o[key] ?? [];
  if (!Array.isArray(v)) fail(where, `${key} must be an array`);
  return v;
}

function stringOrNull(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") fail(where, "must be a string or null");
  return v.trim() === "" ? null : v;
}

function keywordsOf(v: unknown, where: string): string[] {
  if (
    !Array.isArray(v) ||
    v.length === 0 ||
    v.some((k) => typeof k !== "string" || k.trim() === "")
  )
    fail(where, "keywords must be a non-empty array of non-empty strings");
  return v as string[];
}

function uniqueIds(items: { id: string }[], where: string): void {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) fail(where, `id ${it.id} is used twice`);
    seen.add(it.id);
  }
}

function parseItems(v: unknown[], where: string): GoldItem[] {
  const items = v.map((x, i): GoldItem => {
    const w = `${where}[${i}]`;
    if (!isObj(x)) fail(w, "must be an object");
    if (typeof x.id !== "string" || !ID_RE.test(x.id))
      fail(w, "id must match [A-Za-z0-9_.-]{1,40}");
    return {
      id: x.id,
      keywords: keywordsOf(x.keywords, w),
      owner: stringOrNull(x.owner, `${w}.owner`),
      due: stringOrNull(x.due, `${w}.due`),
    };
  });
  uniqueIds(items, where);
  return items;
}

/** Parse and validate one gold v2 file. `id8` is the meeting of the file name. */
export function parseGold(json: string, id8: string): Gold {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    fail(id8, "the file is not valid JSON");
  }
  if (!isObj(v)) fail(id8, "the file must hold an object");
  if (v.format !== "openstyle-gold")
    fail(id8, 'format must be "openstyle-gold"');
  if (v.meeting !== id8)
    fail(id8, "meeting must equal the id8 of the file name");
  if (typeof v.goldVersion !== "number" || !Number.isInteger(v.goldVersion))
    fail(id8, "goldVersion must be an integer");
  if (v.goldVersion < 1) fail(id8, "goldVersion must be 1 or more");
  const goldKind = v.goldKind ?? null;
  if (
    goldKind !== null &&
    (typeof goldKind !== "string" || !ID_RE.test(goldKind))
  )
    fail(id8, "goldKind must match [A-Za-z0-9_.-]{1,40}");
  const verifiedSpans = v.verifiedSpans ?? 0;
  if (!isMs(verifiedSpans))
    fail(id8, "verifiedSpans must be an integer of 0 or more");
  const tol = v.timeToleranceMs ?? DEFAULT_TIME_TOLERANCE_MS;
  if (!isMs(tol)) fail(id8, "timeToleranceMs must be an integer of 0 or more");

  let transcript: Gold["transcript"] = null;
  if (v.transcript !== null && v.transcript !== undefined) {
    if (!isObj(v.transcript)) fail(id8, "transcript must be an object");
    const t = v.transcript;
    const out = {} as Record<Channel, GoldTurn[]>;
    for (const ch of CHANNELS) {
      out[ch] = arrayAt(t, ch, `${id8} transcript`)
        .map((x, i): GoldTurn => {
          const w = `${id8} transcript.${ch}[${i}]`;
          if (!isObj(x)) fail(w, "must be an object");
          if (!isMs(x.startMs) || !isMs(x.endMs) || x.endMs < x.startMs)
            fail(w, "needs integer startMs <= endMs");
          if (typeof x.text !== "string") fail(w, "text must be a string");
          if (typeof x.verified !== "boolean")
            fail(w, "verified must be true or false");
          if (x.basis !== undefined && !isStringArray(x.basis))
            fail(w, "basis must be an array of strings");
          if (
            x.wer_eligible !== undefined &&
            typeof x.wer_eligible !== "boolean"
          )
            fail(w, "wer_eligible must be true or false");
          return {
            startMs: x.startMs,
            endMs: x.endMs,
            text: x.text,
            verified: x.verified,
            ...(typeof x.wer_eligible === "boolean"
              ? { werEligible: x.wer_eligible }
              : {}),
          };
        })
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    }
    for (const k of Object.keys(t))
      if (!isChannel(k)) fail(`${id8} transcript`, `unknown channel ${k}`);
    transcript = out;
  }

  const fixes = arrayAt(v, "fixes", id8).map((x, i): GoldFix => {
    const w = `${id8} fixes[${i}]`;
    if (!isObj(x)) fail(w, "must be an object");
    if (!isChannel(x.channel)) fail(w, "channel must be mic or system");
    if (!isMs(x.startMs)) fail(w, "startMs must be an integer of 0 or more");
    if (typeof x.from !== "string") fail(w, "from must be a string");
    if (typeof x.to !== "string" || x.to === "")
      fail(w, "to must be a non-empty string");
    return { channel: x.channel, startMs: x.startMs, from: x.from, to: x.to };
  });
  const mustNotChange = arrayAt(v, "mustNotChange", id8).map(
    (x, i): GoldMustNotChange => {
      const w = `${id8} mustNotChange[${i}]`;
      if (!isObj(x)) fail(w, "must be an object");
      if (!isChannel(x.channel)) fail(w, "channel must be mic or system");
      if (!isMs(x.startMs)) fail(w, "startMs must be an integer of 0 or more");
      if (typeof x.span !== "string" || x.span === "")
        fail(w, "span must be a non-empty string");
      return { channel: x.channel, startMs: x.startMs, span: x.span };
    },
  );

  let summary: GoldSummary | null = null;
  if (v.summary !== null && v.summary !== undefined) {
    if (!isObj(v.summary)) fail(id8, "summary must be an object");
    const s = v.summary;
    const where = `${id8} summary`;
    const mustNotClaim = arrayAt(s, "mustNotClaim", where).map(
      (x, i): GoldClaim => {
        const w = `${where}.mustNotClaim[${i}]`;
        if (!isObj(x)) fail(w, "must be an object");
        if (typeof x.id !== "string" || !ID_RE.test(x.id))
          fail(w, "id must match [A-Za-z0-9_.-]{1,40}");
        return { id: x.id, keywords: keywordsOf(x.keywords, w) };
      },
    );
    uniqueIds(mustNotClaim, `${where}.mustNotClaim`);
    summary = {
      decisions: parseItems(
        arrayAt(s, "decisions", where),
        `${where}.decisions`,
      ),
      actionItems: parseItems(
        arrayAt(s, "actionItems", where),
        `${where}.actionItems`,
      ),
      mustNotClaim,
    };
  }

  let tags: Gold["tags"] = null;
  if (v.tags !== null && v.tags !== undefined) {
    if (!isObj(v.tags)) fail(id8, "tags must be an object");
    tags = {
      expected: arrayAt(v.tags, "expected", `${id8} tags`).map(
        (x, i): GoldTag => {
          const w = `${id8} tags.expected[${i}]`;
          if (!isObj(x)) fail(w, "must be an object");
          if (typeof x.name !== "string" || x.name.trim() === "")
            fail(w, "name must be a non-empty string");
          const syn = x.synonyms ?? [];
          if (!Array.isArray(syn) || syn.some((s) => typeof s !== "string"))
            fail(w, "synonyms must be an array of strings");
          return { name: x.name, synonyms: syn as string[] };
        },
      ),
    };
  }

  for (const k of ["witnesses", "verification"])
    if (v[k] !== undefined && v[k] !== null && !isObj(v[k]))
      fail(id8, `${k} must be an object`);
  let spans: GoldSpan[] | null = null;
  if (v.spans !== null && v.spans !== undefined) {
    if (!Array.isArray(v.spans)) fail(id8, "spans must be an array");
    spans = v.spans.map((x, i) => parseSpan(x, `${id8} spans[${i}]`));
  }

  let speakers: Gold["speakers"] = null;
  if (v.speakers !== null && v.speakers !== undefined) {
    if (!isObj(v.speakers)) fail(id8, "speakers must be an object");
    speakers = {};
    for (const [label, name] of Object.entries(v.speakers))
      speakers[label] = stringOrNull(name, `${id8} speakers.${label}`);
  }

  return {
    source: "gold-v2",
    meeting: id8,
    goldVersion: v.goldVersion,
    goldKind,
    asrHash: typeof v.asrHash === "string" ? v.asrHash : null,
    builtAt: typeof v.builtAt === "string" ? v.builtAt : null,
    verifiedSpans,
    timeToleranceMs: tol,
    transcript,
    fixes,
    mustNotChange,
    summary,
    tags,
    speakers,
    spans,
  };
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

function parseSpan(x: unknown, w: string): GoldSpan {
  if (!isObj(x)) fail(w, "must be an object");
  if (!isChannel(x.channel)) fail(w, "channel must be mic or system");
  if (!isMs(x.startMs) || !isMs(x.endMs) || x.endMs < x.startMs)
    fail(w, "needs integer startMs <= endMs");
  if (typeof x.text !== "string" || x.text.trim() === "")
    fail(w, "text must be a non-empty string");
  if (!SPAN_LABELS.includes(x.label as SpanLabel))
    fail(w, `label must be one of ${SPAN_LABELS.join(", ")}`);
  if (typeof x.in_vocab !== "boolean")
    fail(w, "in_vocab must be true or false");
  if (!SPAN_CONFIDENCES.includes(x.confidence as SpanConfidence))
    fail(w, `confidence must be one of ${SPAN_CONFIDENCES.join(", ")}`);
  if (!isStringArray(x.witnesses))
    fail(w, "witnesses must be an array of strings");
  if (x.verifier_conflict !== undefined && x.verifier_conflict !== true)
    fail(w, "verifier_conflict must be true or absent");
  return {
    channel: x.channel,
    startMs: x.startMs,
    endMs: x.endMs,
    text: x.text,
    label: x.label as SpanLabel,
    inVocab: x.in_vocab,
    confidence: x.confidence as SpanConfidence,
    witnesses: x.witnesses,
    verifierConflict: x.verifier_conflict === true,
  };
}

// --- Loader -----------------------------------------------------------------------

/**
 * Load the gold of each meeting from `dir` (<id8>.json). The folder must
 * have mode 0700: the files hold private meeting text. A missing file fails.
 */
export function loadGold(
  id8s: string[],
  dir: string = DEFAULT_GOLD_DIR,
): Map<string, Gold> {
  let mode: number;
  try {
    mode = statSync(dir).mode;
  } catch {
    throw new Error(`gold folder ${dir} does not exist`);
  }
  if ((mode & 0o077) !== 0)
    throw new Error(
      `gold folder ${dir} must have mode 0700 (chmod 700 ${dir}); it holds private text`,
    );
  const out = new Map<string, Gold>();
  const missing: string[] = [];
  for (const id8 of id8s) {
    const path = join(dir, `${id8}.json`);
    let json: string;
    try {
      json = readFileSync(path, "utf8");
    } catch {
      missing.push(id8);
      continue;
    }
    out.set(id8, {
      ...parseGold(json, id8),
      fileSha256: createHash("sha256").update(json).digest("hex"),
    });
  }
  if (missing.length > 0)
    throw new Error(`no gold file in ${dir} for: ${missing.join(", ")}`);
  return out;
}

// --- Adapter from the v1 answer key ---------------------------------------------------

const V1_KEY = /^(mic|system):\d+@(\d+)$/;

/**
 * The v1 answer key (checks.mts parseAnswerKey) as gold v2: fixes and
 * mustNotChange only. The segment key gives the channel and the start; the
 * time tolerance is 0, so an entry matches the same segment start as in v1.
 */
export function goldFromAnswerKey(key: AnswerKey): Map<string, Gold> {
  const out = new Map<string, Gold>();
  for (const [id8, m] of Object.entries(key)) {
    const at = (k: string, where: string) => {
      const r = V1_KEY.exec(k);
      if (!r)
        throw new Error(
          `answer key ${id8}: ${where} key must be source:idx@start_ms`,
        );
      return { channel: r[1] as Channel, startMs: Number(r[2]) };
    };
    out.set(id8, {
      source: "answer-key-v1",
      meeting: id8,
      goldVersion: 1,
      goldKind: null,
      asrHash: null,
      builtAt: null,
      verifiedSpans: 0,
      timeToleranceMs: 0,
      transcript: null,
      fixes: m.fixes.map((f, i) => ({
        ...at(f.key, `fixes[${i}]`),
        from: f.from,
        to: f.to,
      })),
      mustNotChange: m.mustNotChange.map((f, i) => ({
        ...at(f.key, `mustNotChange[${i}]`),
        span: f.span,
      })),
      summary: null,
      tags: null,
      speakers: null,
      spans: null,
    });
  }
  return out;
}

export function goldInfo(golds: Map<string, Gold>): GoldInfo | null {
  const all = [...golds.values()];
  if (all.length === 0) return null;
  const sorted = [...golds].sort(([a], [b]) => a.localeCompare(b));
  const files = sorted.map(([k, g]) =>
    g.fileSha256 ? `${k} ${g.fileSha256}` : null,
  );
  return {
    source: (all[0] as Gold).source,
    versions: Object.fromEntries(sorted.map(([k, g]) => [k, g.goldVersion])),
    goldKinds: [...new Set(all.map((g) => g.goldKind ?? "none"))].sort(),
    goldHash: files.every((f) => f !== null)
      ? createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12)
      : null,
  };
}

// --- Owner answers and the merge (gold-clips, gold-merge) ------------------------------

/**
 * One answer of the review page (gold-clips review.html): the owner listened
 * to the clip of a span and typed the words. `from` is the text that the
 * gold holds for the span now (the words that the answer replaces). An empty
 * `text` means "no speech here".
 */
export interface GoldAnswer {
  id: string;
  channel: Channel;
  startMs: number;
  endMs: number;
  from: string;
  text: string;
}

/** Parse and validate an answers.json file of the review page. */
export function parseAnswers(json: string, id8: string): GoldAnswer[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    fail(`${id8} answers`, "the file is not valid JSON");
  }
  if (!isObj(v)) fail(`${id8} answers`, "the file must hold an object");
  if (v.format !== "openstyle-gold-answers")
    fail(`${id8} answers`, 'format must be "openstyle-gold-answers"');
  if (v.meeting !== id8)
    fail(`${id8} answers`, "meeting must equal the --meeting id8");
  const list = arrayAt(v, "answers", `${id8} answers`).map(
    (x, i): GoldAnswer => {
      const w = `${id8} answers[${i}]`;
      if (!isObj(x)) fail(w, "must be an object");
      if (typeof x.id !== "string" || !ID_RE.test(x.id))
        fail(w, "id must match [A-Za-z0-9_.-]{1,40}");
      if (!isChannel(x.channel)) fail(w, "channel must be mic or system");
      if (!isMs(x.startMs) || !isMs(x.endMs) || x.endMs < x.startMs)
        fail(w, "needs integer startMs <= endMs");
      if (typeof x.from !== "string") fail(w, "from must be a string");
      if (typeof x.text !== "string") fail(w, "text must be a string");
      return {
        id: x.id,
        channel: x.channel,
        startMs: x.startMs,
        endMs: x.endMs,
        from: x.from,
        text: x.text.trim(),
      };
    },
  );
  uniqueIds(list, `${id8} answers`);
  return list;
}

/** A transcript turn as the file holds it (other fields, such as basis, stay). */
type RawTurn = Omit<GoldTurn, "werEligible"> & Record<string, unknown>;

/** A word of a turn text with its character range (same split rule as words()). */
function wordRanges(text: string) {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    w: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * Fold the owner's answers into a gold file (the raw JSON object, so other
 * fields stay as they are). For each answer, the words of `from` must occur
 * exactly once in the consecutive turns of its channel that overlap the
 * answer time (plus the gold time tolerance). When they occur more than
 * once, the one hit that is a whole turn overlapping the answer time wins
 * (a gold that puts each open span in its own turn). The turns that hold them are
 * split: the text before keeps its turn, the answer becomes a new turn with
 * `verified: true` and the answer time, and the text after keeps the rest.
 * An answer with an empty `from` (engine A had no words there) becomes a new
 * verified turn. The merge is all or nothing: any error leaves the gold as
 * it was. On success goldVersion goes up by 1 and verifiedSpans is the
 * number of verified turns. Errors name answer ids, never text.
 *
 * Turns keep their on-disk fields (for example `basis` and `wer_eligible`
 * of a silver key). A split part (the text before or after the answer)
 * keeps all fields of its source turn: its words did not change. In a key
 * with `wer_eligible`, the answer turn gets `basis: []` and
 * `wer_eligible: false`: no witness vote ran on its new text, and the vote
 * rule (silver README) needs 2 or more witnesses in `basis`.
 */
export function mergeAnswers(
  raw: Record<string, unknown>,
  answers: GoldAnswer[],
): { gold: Record<string, unknown>; merged: number; errors: string[] } {
  const id8 = String(raw.meeting ?? "");
  const gold = parseGold(JSON.stringify(raw), id8);
  if (!gold.transcript)
    return { gold: raw, merged: 0, errors: ["the gold has no transcript"] };
  const tol = gold.timeToleranceMs;
  // The raw turns (parseGold checked them), in the same order as parseGold.
  const rawTurns = raw.transcript as Partial<Record<Channel, RawTurn[]>>;
  const copy = (ch: Channel): RawTurn[] =>
    (rawTurns[ch] ?? [])
      .map((t) => ({ ...t }))
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const transcript: Record<Channel, RawTurn[]> = {
    mic: copy("mic"),
    system: copy("system"),
  };
  const silver = CHANNELS.some((ch) =>
    transcript[ch].some((t) => t.wer_eligible !== undefined),
  );
  const errors: string[] = [];
  const sorted = [...answers].sort(
    (x, y) => x.channel.localeCompare(y.channel) || x.startMs - y.startMs,
  );
  for (const ans of sorted) {
    const turns = transcript[ans.channel];
    const want = ans.from.toLowerCase().match(/[\p{L}\p{N}]+/gu) as
      | string[]
      | null;
    const verifiedTurn: RawTurn = {
      startMs: ans.startMs,
      endMs: ans.endMs,
      text: ans.text,
      verified: true,
      ...(silver ? { basis: [], wer_eligible: false } : {}),
    };
    if (!want) {
      turns.push(verifiedTurn);
      turns.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
      continue;
    }
    // The turns near the answer time, as one word list.
    const near: number[] = [];
    turns.forEach((t, i) => {
      if (t.startMs <= ans.endMs + tol && t.endMs >= ans.startMs - tol)
        near.push(i);
    });
    const list = near.flatMap((ti) =>
      wordRanges((turns[ti] as RawTurn).text).map((r) => ({ ...r, ti })),
    );
    let hits: number[] = [];
    for (let i = 0; i + want.length <= list.length; i++)
      if (want.every((w, k) => list[i + k]?.w === w)) hits.push(i);
    // A short `from` ("the", "to") often occurs more than once near the
    // answer. A gold that puts each open span in its own turn settles it:
    // the one hit that is a whole turn and overlaps the answer time wins.
    if (hits.length > 1) {
      const whole = hits.filter((h) => {
        const ti = (list[h] as (typeof list)[number]).ti;
        const t = turns[ti] as RawTurn;
        return (
          list[h + want.length - 1]?.ti === ti &&
          wordRanges(t.text).length === want.length &&
          t.startMs <= ans.endMs &&
          t.endMs >= ans.startMs
        );
      });
      if (whole.length === 1) hits = whole;
    }
    if (hits.length !== 1) {
      errors.push(
        `answer ${ans.id}: its "from" words occur ${hits.length} times near ${ans.channel} ${ans.startMs} ms (want 1)`,
      );
      continue;
    }
    const first = list[hits[0] as number] as (typeof list)[number];
    const last = list[(hits[0] as number) + want.length - 1] as typeof first;
    const t0 = turns[first.ti] as RawTurn;
    const t1 = turns[last.ti] as RawTurn;
    const before = t0.text.slice(0, first.start).trim();
    const afterText = t1.text.slice(last.end).trim();
    // Times stay in order (the scorers read a channel in start order):
    // before <= answer <= after, inside the turns that held the words.
    // The words lie inside t0..t1, so the answer starts inside them too (a
    // start before t0 sorted the answer in front of the turn before it).
    const vStart = Math.min(Math.max(ans.startMs, t0.startMs), t1.endMs);
    const vEnd = Math.max(vStart, ans.endMs);
    const parts: RawTurn[] = [];
    if (before)
      parts.push({ ...t0, startMs: t0.startMs, endMs: vStart, text: before });
    parts.push({ ...verifiedTurn, startMs: vStart, endMs: vEnd });
    if (afterText) {
      const aStart = Math.max(vStart, Math.min(vEnd, t1.endMs));
      parts.push({
        ...t1,
        startMs: aStart,
        endMs: Math.max(aStart, t1.endMs),
        text: afterText,
      });
    }
    turns.splice(first.ti, last.ti - first.ti + 1, ...parts);
    turns.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  }
  if (errors.length > 0) return { gold: raw, merged: 0, errors };
  const verified = [...transcript.mic, ...transcript.system].filter(
    (t) => t.verified,
  ).length;
  const next = {
    ...raw,
    goldVersion: gold.goldVersion + 1,
    verifiedSpans: verified,
    transcript,
  };
  // The result must pass the same validation as a hand-written file.
  parseGold(JSON.stringify(next), id8);
  return { gold: next, merged: answers.length, errors: [] };
}
