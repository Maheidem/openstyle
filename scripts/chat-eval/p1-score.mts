// p1-score.mts: the pure scoring helpers of the P1 eval (no model, no server
// module). The P1 runner (p1-run.mts) feeds them with real turn results.
// Parts: the id mapping between corpus ids and production ids, the Answer
// builder, cite checks, tool and argument checks, route and slot scorers and
// the table of pass bars.

import type {
  ChatBlock,
  ChatCite,
} from "../../packages/validations/src/chat.ts";
import { type Answer, normalize } from "./keys.mts";
import type {
  AnswerKey,
  Corpus,
  Intent,
  Question,
  WriteKey,
} from "./types.mts";

// --- Id mapping ---------------------------------------------------------------

/** Lower case, no accents, single spaces: the person key of the production code. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export interface IdMaps {
  /** Corpus item id (action item, decision, question) to the production key. */
  itemToProd: Map<string, string>;
  /** Production key to the corpus item id. */
  prodToItem: Map<string, string>;
  /** `<meeting id>\n<normalized text>` to the corpus item id. */
  byMeetingText: Map<string, string>;
  /** Corpus item id to its normalized text. */
  textOf: Map<string, string>;
  /** Corpus person id to the production person key (normalized full name). */
  personToProd: Map<string, string>;
  /** A production person key (full name, variant or ASR spelling) to the corpus person id. */
  prodToPerson: Map<string, string>;
}

/**
 * Build the maps. `keyFn` is the production `actionItemKey(meetingId, task)`.
 * A decision and an open question use the same key function on their text.
 */
export function buildIdMaps(
  corpus: Corpus,
  keyFn: (meetingId: string, text: string) => string,
): IdMaps {
  const maps: IdMaps = {
    itemToProd: new Map(),
    prodToItem: new Map(),
    byMeetingText: new Map(),
    textOf: new Map(),
    personToProd: new Map(),
    prodToPerson: new Map(),
  };
  const addItem = (meetingId: string, id: string, text: string) => {
    const key = keyFn(meetingId, text);
    maps.itemToProd.set(id, key);
    if (!maps.prodToItem.has(key)) maps.prodToItem.set(key, id);
    maps.byMeetingText.set(`${meetingId}\n${normalize(text)}`, id);
    maps.textOf.set(id, normalize(text));
  };
  for (const m of corpus.meetings) {
    for (const a of m.actionItems) addItem(m.id, a.id, a.task);
    for (const d of m.decisions) addItem(m.id, d.id, d.text);
    for (const q of m.openQuestions) addItem(m.id, q.id, q.text);
  }
  for (const p of corpus.people) {
    maps.personToProd.set(p.id, normalizeName(p.full));
    for (const name of [p.full, p.asr, ...p.variants]) {
      const k = normalizeName(name);
      if (!maps.prodToPerson.has(k)) maps.prodToPerson.set(k, p.id);
    }
  }
  for (const m of corpus.meetings) {
    for (const s of m.speakers) {
      const k = normalizeName(s.displayName);
      if (!maps.prodToPerson.has(k)) maps.prodToPerson.set(k, s.personId);
    }
  }
  return maps;
}

/** A list item of a block to the corpus item id, or null when it is unknown. */
export function listItemId(
  item: { item_id: string | null; meeting_id: string | null; text: string },
  maps: IdMaps,
): string | null {
  if (item.item_id && maps.prodToItem.has(item.item_id))
    return maps.prodToItem.get(item.item_id) as string;
  if (item.meeting_id) {
    const k = `${item.meeting_id}\n${normalize(item.text)}`;
    if (maps.byMeetingText.has(k)) return maps.byMeetingText.get(k) as string;
  }
  return null;
}

/**
 * The production code groups action items, decisions and questions that say
 * the same thing in several meetings (one group, one id). A group counts as
 * the gold id when any member of the group is a gold id. This replaces an id
 * by a gold id of the same text.
 */
export function creditGroup(
  id: string,
  goldIds: readonly string[],
  maps: IdMaps,
): string {
  if (goldIds.includes(id)) return id;
  const text = maps.textOf.get(id);
  if (text === undefined) return id;
  const sibling = goldIds.find((g) => maps.textOf.get(g) === text);
  return sibling ?? id;
}

/** Map a production person key to a corpus person id (unknown keys stay). */
export function personId(prodKey: string, maps: IdMaps): string {
  return maps.prodToPerson.get(normalizeName(prodKey)) ?? prodKey;
}

// --- The Answer builder ---------------------------------------------------------

export interface TurnLike {
  blocks: ChatBlock[];
  content: string;
  cites: ChatCite[];
  proposal: {
    kind: WriteKey["change"];
    ids: string[];
    arg: WriteKey["arg"];
  } | null;
}

/** The proposal of a turn at the corpus-id level. */
export function mapProposal(
  p: TurnLike["proposal"],
  maps: IdMaps,
): Answer["proposal"] {
  if (!p) return null;
  const ids = p.ids.map((id) => {
    if (p.kind === "action_item") return maps.prodToItem.get(id) ?? id;
    if (p.kind === "merge_people") return personId(id, maps);
    return id;
  });
  return { kind: p.kind, ids: [...new Set(ids)], arg: p.arg };
}

const isMeetingKey = (key: AnswerKey) =>
  key.kind === "set" &&
  key.ids.length > 0 &&
  key.ids.every((i) => !i.includes("#") && i.startsWith("mtg-"));

/**
 * Reduce a TurnResult to the Answer that a key reads.
 * - notFound: the first block is a not_found block.
 * - text: the content, plus the number of a count block.
 * - ids: the items of list blocks (corpus ids). A status block has no ids:
 *   its open_actions number is compared with the size of the gold set (the
 *   only fact it shows). A meeting set without a list block reads the meeting
 *   ids of the shown cites.
 */
export function answerFromTurn(
  turn: TurnLike,
  maps: IdMaps,
  key: AnswerKey,
): Answer {
  const first = turn.blocks[0];
  const notFound = first?.kind === "not_found";
  let text = turn.content;
  const ids: string[] = [];
  const goldIds = key.kind === "set" ? key.ids : [];
  let sawList = false;
  for (const b of turn.blocks) {
    if (b.kind === "count") text += ` ${b.n}`;
    else if (b.kind === "list") {
      sawList = true;
      for (const it of b.items) {
        const id = listItemId(it, maps);
        if (id !== null) ids.push(creditGroup(id, goldIds, maps));
        else if (it.meeting_id) ids.push(it.meeting_id);
      }
    } else if (b.kind === "status" && key.kind === "set") {
      sawList = true;
      if (b.open_actions === key.ids.length) ids.push(...key.ids);
    }
  }
  if (!sawList && isMeetingKey(key) && !notFound) {
    for (const c of turn.cites) ids.push(c.meeting_id);
  }
  return {
    notFound,
    text,
    ids: [...new Set(ids)],
    proposal: mapProposal(turn.proposal, maps),
  };
}

// --- Cites ------------------------------------------------------------------------

export interface GoldSpan {
  meetingId: string;
  startMs: number;
  endMs: number;
}

/** The gold evidence of a question as time spans of the corpus segments. */
export function goldSpans(q: Question, corpus: Corpus): GoldSpan[] {
  const out: GoldSpan[] = [];
  for (const g of q.gold) {
    const m = corpus.meetings.find((x) => x.id === g.meetingId);
    const s = m?.segments.find((x) => x.idx === g.segmentIdx);
    if (m && s)
      out.push({ meetingId: m.id, startMs: s.startMs, endMs: s.endMs });
  }
  return out;
}

export interface CiteSpan {
  meeting_id: string;
  start_ms: number | null;
  /** The end of the chunk of the cite, when known (range mode). */
  end_ms?: number | null;
}

/**
 * Does a cite overlap a gold span?
 * - "start": the start_ms of the cite falls inside the gold segment span.
 * - "range": the span of the cite (start_ms to end_ms) meets the gold span.
 * - "meeting": the cite is in a gold meeting.
 */
export function citeHits(
  c: CiteSpan,
  spans: readonly GoldSpan[],
  mode: "start" | "range" | "meeting",
): boolean {
  return spans.some((s) => {
    if (c.meeting_id !== s.meetingId) return false;
    if (mode === "meeting") return true;
    if (c.start_ms === null) return false;
    if (mode === "start")
      return c.start_ms >= s.startMs && c.start_ms <= s.endMs;
    const end = c.end_ms ?? c.start_ms;
    return c.start_ms <= s.endMs && end >= s.startMs;
  });
}

export interface CitePR {
  shown: number;
  hit: number;
  gold: number;
  covered: number;
}

/** Counts for cite precision (hit / shown) and cite recall (covered / gold). */
export function citeCounts(
  cites: readonly CiteSpan[],
  spans: readonly GoldSpan[],
  mode: "start" | "range" | "meeting",
): CitePR {
  const hit = cites.filter((c) => citeHits(c, spans, mode)).length;
  const covered = spans.filter((s) =>
    cites.some((c) => citeHits(c, [s], mode)),
  ).length;
  return { shown: cites.length, hit, gold: spans.length, covered };
}

export interface CiteCheck {
  /** Cites shown (block text labels plus cites). */
  shown: number;
  /** Labels shown that no cite holds, or cites that do not resolve to real data. */
  invalid: string[];
}

/**
 * Check the cites of a turn against the data, not against themselves:
 * a label in a block must have a cite in `cites`; the meeting of a cite must
 * exist; a cite with a start time must start at a known segment or chunk of
 * its meeting; an item cite must name a known item; a list item label must
 * have a cite.
 */
export function checkCites(
  turn: Pick<TurnLike, "blocks" | "cites">,
  known: {
    meeting: (id: string) => boolean;
    start: (meetingId: string, startMs: number) => boolean;
    item: (itemId: string) => boolean;
  },
): CiteCheck {
  const have = new Set(turn.cites.map((c) => c.label));
  const invalid: string[] = [];
  const labels = new Set<string>();
  for (const b of turn.blocks) {
    if (b.kind === "text") for (const l of b.cites) labels.add(l);
    if (b.kind === "list")
      for (const it of b.items) if (it.label) labels.add(it.label);
  }
  for (const l of labels) {
    if (!have.has(l)) invalid.push(`${l}:no_cite`);
  }
  for (const c of turn.cites) {
    if (!/^S\d+$/.test(c.label)) invalid.push(`${c.label}:bad_label`);
    else if (!known.meeting(c.meeting_id))
      invalid.push(`${c.label}:no_meeting`);
    else if (c.start_ms !== null && !known.start(c.meeting_id, c.start_ms))
      invalid.push(`${c.label}:no_start`);
    else if (c.kind === "item" && (!c.item_id || !known.item(c.item_id)))
      invalid.push(`${c.label}:no_item`);
  }
  return { shown: new Set([...labels, ...have]).size, invalid };
}

// --- Tool and arguments -----------------------------------------------------------

/** The first tool of a turn: the first run tool, else the propose tool of a write. */
export function firstTool(
  toolCalls: readonly { tool: string }[],
  routeStepNames: readonly string[],
  proposalKind: WriteKey["change"] | null,
): string | null {
  if (toolCalls[0]) return toolCalls[0].tool;
  const native = routeStepNames.find((n) => n.startsWith("native:propose_"));
  if (native) return native.slice("native:".length);
  if (proposalKind) return PROPOSE_TOOL[proposalKind];
  return null;
}

export const PROPOSE_TOOL: Record<WriteKey["change"], string> = {
  action_item: "propose_action_item_change",
  retag: "propose_retag",
  move: "propose_move",
  merge_people: "propose_merge_people",
};

type Args = Record<string, unknown>;

/**
 * Score the gold args of a question against the id-level args of the first
 * tool call (read) or the proposal (write). One entry per gold arg key.
 * Dates are not scored for a write question: the ids carry the date range.
 */
export function scoreToolArgs(
  q: Question,
  call: { tool: string; args: unknown } | null,
  proposal: Answer["proposal"],
  maps: IdMaps,
): { pass: boolean; keys: Record<string, boolean> } {
  const keys: Record<string, boolean> = {};
  const a = ((call?.args ?? {}) as Args) || {};
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  for (const [k, gold] of Object.entries(q.args)) {
    switch (k) {
      case "query_any": {
        const got = normalize(str(a.query) ?? "");
        keys[k] = (gold as string[]).some(
          (t) => got.split(" ").includes(t) || got.includes(t),
        );
        break;
      }
      case "person_id":
        keys[k] =
          str(a.person_id) !== null &&
          normalizeName(str(a.person_id) as string) ===
            maps.personToProd.get(gold as string);
        break;
      case "cluster":
        keys[k] =
          proposal?.kind === "merge_people" &&
          proposal.ids.includes(gold as string);
        break;
      case "kind":
        keys[k] = a.kind === gold;
        break;
      case "status":
        keys[k] = a.status === gold;
        break;
      case "date_from":
      case "date_to":
        if (q.intent === "write") break;
        keys[k] =
          ((str(a[k]) ?? null) as string | null) ===
          (gold === "" ? null : gold);
        break;
      case "item":
        keys[k] =
          proposal?.kind === "action_item" &&
          proposal.ids.includes(gold as string);
        break;
      case "meeting":
        keys[k] =
          proposal?.kind === "move"
            ? proposal.ids.includes(gold as string)
            : str(a.meeting_id) === gold ||
              (Array.isArray(a.meeting_ids) && a.meeting_ids.includes(gold));
        break;
      case "folder":
        keys[k] = proposal?.kind === "move" && proposal.arg === gold;
        break;
      case "tag":
        keys[k] =
          proposal?.kind === "retag" &&
          Array.isArray(proposal.arg) &&
          proposal.arg.map(normalize).includes(normalize(String(gold)));
        break;
      default:
        break;
    }
  }
  return { pass: Object.values(keys).every(Boolean), keys };
}

// --- Router and slots --------------------------------------------------------------

export interface Confusion {
  /** gold intent to predicted intent to count. */
  matrix: Record<string, Record<string, number>>;
  accuracy: number;
  n: number;
}

export function confusion(
  rows: readonly { gold: Intent; pred: Intent | null }[],
): Confusion {
  const matrix: Confusion["matrix"] = {};
  let ok = 0;
  for (const r of rows) {
    const row = (matrix[r.gold] ??= {});
    const p = r.pred ?? "invalid";
    row[p] = (row[p] ?? 0) + 1;
    if (r.pred === r.gold) ok++;
  }
  return {
    matrix,
    accuracy: rows.length ? ok / rows.length : 0,
    n: rows.length,
  };
}

/**
 * Score the slot values of a question with the gold intent. `ids` resolves
 * the closed labels of the production choices (A1.., M1..) to ids.
 */
export function scoreProdSlots(
  q: Question,
  v: {
    query?: string | null;
    person?: string | null;
    item?: string | null;
    meeting?: string | null;
    folder?: string | null;
    kind?: string | null;
    change?: string | null;
    tag?: string | null;
  },
  dates: { date_from: string | null; date_to: string | null },
  choices: {
    items: { label: string; id: string }[];
    meetings: { label: string; id: string }[];
  },
  maps: IdMaps,
): { pass: boolean; keys: Record<string, boolean> } {
  const keys: Record<string, boolean> = {};
  const lab = (xs: { label: string; id: string }[], l?: string | null) =>
    xs.find((x) => x.label === l)?.id ?? null;
  for (const [k, gold] of Object.entries(q.args)) {
    switch (k) {
      case "query_any": {
        const got = normalize(v.query ?? "");
        keys[k] = (gold as string[]).some(
          (t) => got.split(" ").includes(t) || got.includes(t),
        );
        break;
      }
      case "person_id":
      case "cluster":
        keys[k] = v.person === maps.personToProd.get(gold as string);
        break;
      case "kind":
        keys[k] = v.kind === gold;
        break;
      case "date_from":
      case "date_to":
        keys[k] = dates[k] === (gold === "" ? null : gold);
        break;
      case "item":
        keys[k] =
          lab(choices.items, v.item) === maps.itemToProd.get(gold as string);
        break;
      case "meeting":
        keys[k] = lab(choices.meetings, v.meeting) === gold;
        break;
      case "folder":
        keys[k] = v.folder === gold;
        break;
      case "tag":
        keys[k] = normalize(v.tag ?? "") === normalize(String(gold));
        break;
      default:
        break;
    }
  }
  if (q.intent === "write") {
    const want = q.key.kind === "write" ? q.key.change : null;
    keys.change = v.change === want;
  }
  return { pass: Object.values(keys).every(Boolean), keys };
}

// --- Native route steps ---------------------------------------------------------------

/** The outcome of the native call of a turn, from the trace steps. */
export function nativeOutcome(
  stepNames: readonly string[],
): "ok" | "invalid" | "none" | "error" | "off" {
  const s = stepNames.find((n) => n.startsWith("native:"));
  if (!s) return "off";
  if (s === "native:invalid") return "invalid";
  if (s === "native:none") return "none";
  if (s === "native:error") return "error";
  return "ok";
}

// --- Bars -------------------------------------------------------------------------------

export type BarDir = "min" | "max" | "eq";
export type BarStatus = "PASS" | "FAIL" | "NOT RUN" | "REPORTED";
export type BarUnit = "pct" | "ratio" | "ms" | "mb" | "count";

export interface BarDef {
  id: string;
  bar: string;
  /** null = no threshold: the number is reported only. */
  threshold: number | null;
  dir: BarDir;
  unit: BarUnit;
  /** The MLflow run name that holds the number. */
  source: string;
  /** Where the bar comes from. */
  origin: string;
}

export interface BarRow {
  id: string;
  bar: string;
  threshold: string;
  measured: string;
  status: BarStatus;
  source: string;
  origin: string;
}

export function formatValue(v: number, unit: BarUnit): string {
  switch (unit) {
    case "pct":
      return `${(v * 100).toFixed(1)}%`;
    case "ratio":
      return v.toFixed(3);
    case "ms":
      return `${Math.round(v)} ms`;
    case "mb":
      return `${Math.round(v)} MB`;
    case "count":
      return String(Math.round(v));
  }
}

/** PASS, FAIL, NOT RUN (no number) or REPORTED (no threshold). */
export function barStatus(
  def: Pick<BarDef, "threshold" | "dir">,
  measured: number | null | undefined,
): BarStatus {
  if (measured === null || measured === undefined || !Number.isFinite(measured))
    return "NOT RUN";
  if (def.threshold === null) return "REPORTED";
  // A small epsilon keeps 0.85 against 0.8500000001 from flipping.
  const eps = 1e-9;
  switch (def.dir) {
    case "min":
      return measured + eps >= def.threshold ? "PASS" : "FAIL";
    case "max":
      return measured - eps <= def.threshold ? "PASS" : "FAIL";
    case "eq":
      return Math.abs(measured - def.threshold) <= eps ? "PASS" : "FAIL";
  }
}

export function barRow(
  def: BarDef,
  measured: number | null | undefined,
): BarRow {
  const sign = def.dir === "min" ? ">= " : def.dir === "max" ? "<= " : "= ";
  return {
    id: def.id,
    bar: def.bar,
    threshold:
      def.threshold === null
        ? "report"
        : sign + formatValue(def.threshold, def.unit),
    measured:
      measured === null || measured === undefined || !Number.isFinite(measured)
        ? "-"
        : formatValue(measured, def.unit),
    status: barStatus(def, measured),
    source: def.source,
    origin: def.origin,
  };
}

export function barsTable(rows: readonly BarRow[]): string {
  const head =
    "| bar | threshold | measured | result | source |\n|---|---|---|---|---|\n";
  return (
    head +
    rows
      .map(
        (r) =>
          `| ${r.bar} | ${r.threshold} | ${r.measured} | ${r.status} | ${r.source} |`,
      )
      .join("\n")
  );
}

/**
 * The bars. Thresholds come from the P0 report section 7 (decided by the
 * owner on 2026-10-31) and from spec 8.7. They are never changed here.
 */
export const BARS: readonly BarDef[] = [
  // --- Ask synthesis (broad questions, 2026-11-01) ---
  {
    id: "broad.cov",
    bar: "Broad: coverage of the must-mention facts (first turns)",
    threshold: 0.5,
    dir: "min",
    unit: "pct",
    source: "p1-broad",
    origin: "Ask synthesis",
  },
  {
    id: "broad.cite_invalid",
    bar: "Broad: invalid or missing cites shown",
    threshold: 0,
    dir: "max",
    unit: "count",
    source: "p1-broad",
    origin: "Ask synthesis, spec 8.7",
  },
  {
    id: "broad.repeats",
    bar: "Broad: repeated answers in a thread",
    threshold: 0,
    dir: "max",
    unit: "count",
    source: "p1-broad",
    origin: "Ask synthesis, #405",
  },
  {
    id: "broad.len_ok",
    bar: "Broad: answer length in range",
    threshold: 0.9,
    dir: "min",
    unit: "pct",
    source: "p1-broad",
    origin: "Ask synthesis",
  },
  {
    id: "broad.not_found",
    bar: "Broad: not found",
    threshold: 0.1,
    dir: "max",
    unit: "pct",
    source: "p1-broad",
    origin: "Ask synthesis",
  },
  {
    id: "broad.fresh",
    bar: "Broad: elaboration turns with new content",
    threshold: 0.7,
    dir: "min",
    unit: "pct",
    source: "p1-broad",
    origin: "Ask synthesis",
  },
  // --- P0 report section 7 ---
  {
    id: "ret.ndcg",
    bar: "Retrieval nDCG@10, hybrid + rerank 15",
    threshold: 0.65,
    dir: "min",
    unit: "ratio",
    source: "p1-retrieval",
    origin: "report 7",
  },
  {
    id: "ret.r10any",
    bar: "Retrieval recall@10 any evidence, hybrid + rerank 15, 147 queries",
    threshold: 0.85,
    dir: "min",
    unit: "pct",
    source: "p1-retrieval",
    origin: "report 7",
  },
  {
    id: "ret.numbers15",
    bar: "Recall@10 numbers slice, hybrid + rerank 15",
    threshold: 0.85,
    dir: "min",
    unit: "pct",
    source: "p1-retrieval",
    origin: "report 7",
  },
  {
    id: "ret.names15",
    bar: "Recall@10 names slice, hybrid + rerank 15",
    threshold: 0.85,
    dir: "min",
    unit: "pct",
    source: "p1-retrieval",
    origin: "report 7",
  },
  {
    id: "ret.numbers30",
    bar: "Recall@10 numbers slice, hybrid + rerank 30",
    threshold: 0.85,
    dir: "min",
    unit: "pct",
    source: "p1-retrieval",
    origin: "report 7",
  },
  {
    id: "ret.names30",
    bar: "Recall@10 names slice, hybrid + rerank 30",
    threshold: 0.85,
    dir: "min",
    unit: "pct",
    source: "p1-retrieval",
    origin: "report 7",
  },
  {
    id: "ret.lat.scale",
    bar: "Hybrid latency p95 warm without reranker, 46,000 rows",
    threshold: 150,
    dir: "max",
    unit: "ms",
    source: "p1-scale",
    origin: "report 7",
  },
  {
    id: "ret.rerank15",
    bar: "Rerank 15: added time p95",
    threshold: 400,
    dir: "max",
    unit: "ms",
    source: "p1-retrieval",
    origin: "report 7",
  },
  {
    id: "ret.rerank30",
    bar: "Rerank 30: added time p95 (switch to 30 only if met)",
    threshold: 400,
    dir: "max",
    unit: "ms",
    source: "p1-retrieval",
    origin: "report 7, decision 3",
  },
  {
    id: "ret.ram",
    bar: "Reranker worker RAM (peak RSS)",
    threshold: 1536,
    dir: "max",
    unit: "mb",
    source: "p1-retrieval",
    origin: "report 7",
  },
  {
    id: "route.blind",
    bar: "Route accuracy, blind set (224)",
    threshold: 0.9,
    dir: "min",
    unit: "pct",
    source: "p1-router",
    origin: "report 7",
  },
  {
    id: "route.gold",
    bar: "Route accuracy, gold set (190, new labels)",
    threshold: 0.85,
    dir: "min",
    unit: "pct",
    source: "p1-router",
    origin: "report 7",
  },
  {
    id: "slots",
    bar: "Slot accuracy with the gold intent, dates by code",
    threshold: 0.9,
    dir: "min",
    unit: "pct",
    source: "p1-slots",
    origin: "report 7",
  },
  {
    id: "toolargs",
    bar: "Tool and args together, end to end (190)",
    threshold: 0.85,
    dir: "min",
    unit: "pct",
    source: "p1-e2e",
    origin: "report 7",
  },
  {
    id: "write",
    bar: "Write proposal match (kind and id set, 25)",
    threshold: 0.9,
    dir: "min",
    unit: "pct",
    source: "p1-e2e",
    origin: "report 7",
  },
  {
    id: "route.lat",
    bar: "Route latency p95, router and slots together",
    threshold: 700,
    dir: "max",
    unit: "ms",
    source: "p1-e2e",
    origin: "report 7",
  },
  {
    id: "a0.22",
    bar: "Answer accuracy lookup + follow-up on the 22 A0 questions",
    threshold: 0.74,
    dir: "min",
    unit: "pct",
    source: "p1-e2e",
    origin: "report 7",
  },
  {
    id: "a0.35",
    bar: "Answer accuracy lookup + follow-up (25 + 10)",
    threshold: 0.85,
    dir: "min",
    unit: "pct",
    source: "p1-e2e",
    origin: "report 7",
  },
  // --- spec 8.7 answer stage ---
  {
    id: "cite.valid",
    bar: "Cite validity",
    threshold: 1,
    dir: "eq",
    unit: "pct",
    source: "p1-e2e",
    origin: "spec 8.7",
  },
  {
    id: "cite.invalid",
    bar: "Invalid cite shown",
    threshold: 0,
    dir: "eq",
    unit: "count",
    source: "p1-e2e",
    origin: "spec 8.7",
  },
  {
    id: "nf.acc",
    bar: "Not-found accuracy (not answerable + scope trap)",
    threshold: 0.9,
    dir: "min",
    unit: "pct",
    source: "p1-e2e",
    origin: "spec 8.7",
  },
  {
    id: "nf.false",
    bar: "False not-found rate",
    threshold: 0.15,
    dir: "max",
    unit: "pct",
    source: "p1-e2e",
    origin: "spec 8.7",
  },
  {
    id: "listf1",
    bar: "List F1 (aggregation)",
    threshold: 0.85,
    dir: "min",
    unit: "ratio",
    source: "p1-e2e",
    origin: "spec 8.7",
  },
  {
    id: "cite.prec",
    bar: "Cite precision (start_ms inside the gold segment)",
    threshold: 0.8,
    dir: "min",
    unit: "ratio",
    source: "p1-e2e",
    origin: "spec 8.7",
  },
  {
    id: "route.spec",
    bar: "Route accuracy, gold set (spec 8.7 wording; report 7 sets 85%)",
    threshold: 0.9,
    dir: "min",
    unit: "pct",
    source: "p1-router",
    origin: "spec 8.7",
  },
  {
    id: "lat.p95",
    bar: "Turn latency p95, warm",
    threshold: 6000,
    dir: "max",
    unit: "ms",
    source: "p1-e2e",
    origin: "spec 8.7",
  },
  {
    id: "writes",
    bar: "Direct writes by the model",
    threshold: 0,
    dir: "eq",
    unit: "count",
    source: "p1-e2e",
    origin: "spec 8.7",
  },
  {
    id: "whosaid",
    bar: "Who-said accuracy",
    threshold: 0.7,
    dir: "min",
    unit: "pct",
    source: "p1-e2e",
    origin: "spec 8.7 (P2)",
  },
  {
    id: "p2.lookup",
    bar: "Answer accuracy, lookup and follow-up (P2 column)",
    threshold: 0.7,
    dir: "min",
    unit: "pct",
    source: "p1-e2e",
    origin: "spec 8.7 (P2)",
  },
  // --- P2 (spec 6.3, 11.6.4): search wider ---
  {
    id: "widen.offer",
    bar: "Search wider: not found at the first scope, with the offer of the next scope",
    threshold: 0.9,
    dir: "min",
    unit: "pct",
    source: "p1-widen",
    origin: "spec 8.7 (not-found accuracy) and 6.3",
  },
  {
    id: "widen.answer",
    bar: "Search wider: right answer after the clicks",
    threshold: 0.7,
    dir: "min",
    unit: "pct",
    source: "p1-widen",
    origin: "spec 8.7 (P2 answer accuracy)",
  },
];

/** Rows for all bars from a map of measured numbers (missing = NOT RUN). */
export function evaluateBars(
  measured: Record<string, number | null | undefined>,
): BarRow[] {
  return BARS.map((b) => barRow(b, measured[b.id]));
}
