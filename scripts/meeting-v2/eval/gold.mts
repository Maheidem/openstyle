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
// Errors name the file field, never its text.

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
}

/** The gold info that results.json and a baseline record (no text). */
export interface GoldInfo {
  source: GoldSource;
  versions: Record<string, number>;
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
          return {
            startMs: x.startMs,
            endMs: x.endMs,
            text: x.text,
            verified: x.verified,
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
    out.set(id8, parseGold(json, id8));
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
    });
  }
  return out;
}

export function goldInfo(golds: Map<string, Gold>): GoldInfo | null {
  const all = [...golds.values()];
  if (all.length === 0) return null;
  return {
    source: (all[0] as Gold).source,
    versions: Object.fromEntries(
      [...golds]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, g]) => [k, g.goldVersion]),
    ),
  };
}
