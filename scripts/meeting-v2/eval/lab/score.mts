// score.mts: the scores of one Eval Lab ASR run, from its run DB.
//
// Span recall (scoreSpans, the #360 rule), WER (scoreChannel, normal words
// and the wer_eligible turns) and the possible insertions (insertions.mts),
// pooled and per meeting. The per-span items hold keys and flags only:
// meeting id8, channel, start and end ms, label, confidence, in-vocab, hit.
// Never text.

import { DatabaseSync } from "node:sqlite";
import type { SegmentRow } from "../checks.mts";
import { CHANNELS, type Gold } from "../gold.mts";
import {
  addSpanScores,
  type ChannelScore,
  pooled,
  type SpanCount,
  type SpanScore,
  scoreChannel,
  scoreSpanItems,
  scoreSpans,
  spanText,
} from "../score.mts";
import {
  addPrec,
  normWords,
  type Prec,
  possibleInsertions,
} from "../silver/score/insertions.mts";

export type Metrics = Record<string, number>;

/** One scored span: keys and flags only. */
export interface SpanItem {
  m: string;
  ch: string;
  s: number;
  e: number;
  l: string;
  c: string;
  iv: boolean;
  hit: boolean;
}

export interface MeetingScore {
  m: string;
  metrics: Metrics;
}

export interface RunScore {
  metrics: Metrics;
  meetings: MeetingScore[];
  items: SpanItem[];
}

const pct = (c: SpanCount) =>
  c.rate === null ? Number.NaN : Math.round(c.rate * 10000) / 100;
const pctOf = (e: number, r: number) =>
  r === 0 ? Number.NaN : Math.round((e / r) * 10000) / 100;

/** The span metrics: recall in percent, hits and n per group. */
function spanMetrics(s: SpanScore, noOwner: SpanScore): Metrics {
  const out: Metrics = {};
  const put = (name: string, c: SpanCount) => {
    out[`spans_${name}`] = pct(c);
    out[`spans_${name}_hits`] = c.hits;
    out[`spans_${name}_n`] = c.n;
  };
  put("all", s.all);
  put("high", s.high);
  put("person", s.byLabel.person);
  put("term", s.byLabel.term);
  put("other", s.byLabel.other);
  put("in_vocab", s.byVocab.inVocab);
  put("not_in_vocab", s.byVocab.notInVocab);
  put("person_no_owner", noOwner.byLabel.person);
  // Verified spans (the owner's ear check): the rate only when n > 0, so
  // the ledger never gets a rate of 0 for "no verified span".
  const v = s.verified ?? { hits: 0, n: 0, rate: null };
  out.spans_verified_n = v.n;
  if (v.n > 0) put("verified", v);
  out.spans_verified_unsure = s.verifiedUnsure ?? 0;
  out.spans_unsure_skipped = s.unsure;
  out.spans_empty_skipped = s.empty;
  return out;
}

function werMetrics(ch: (ChannelScore | null)[]): Metrics {
  const out: Metrics = {};
  const w = pooled(ch, "words");
  const e = pooled(ch, "wordsEligible");
  if (w) {
    out.wer = pctOf(w.errors, w.ref);
    out.wer_errors = w.errors;
    out.wer_ref = w.ref;
  }
  if (e) {
    out.wer_eligible = pctOf(e.errors, e.ref);
    out.wer_eligible_errors = e.errors;
    out.wer_eligible_ref = e.ref;
  }
  const sum = (f: (c: ChannelScore) => number) =>
    ch.reduce((a, c) => a + (c ? f(c) : 0), 0);
  out.wer_substitutions = sum((c) => c.substitutions);
  out.wer_deletions = sum((c) => c.deletions);
  out.wer_insertions = sum((c) => c.insertions);
  return out;
}

function precMetrics(p: Prec): Metrics {
  return {
    possible_insertions: p.vocabUnsup + p.nameUnsup,
    ins_vocab_occ: p.vocabOcc,
    ins_vocab_unsup: p.vocabUnsup,
    ins_name_occ: p.nameOcc,
    ins_name_unsup: p.nameUnsup,
    ins_owner_occ: p.ownerOcc,
    ins_owner_unsup: p.ownerUnsup,
  };
}

/**
 * Score the meetings `ids` (full ids) of a run DB against their gold
 * (by id8). The owner name for the insertion count is the owner_name
 * setting of the run DB.
 */
export function scoreRunDb(
  dbPath: string,
  ids: string[],
  golds: Map<string, Gold>,
): RunScore {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const vocab = (
      db.prepare("SELECT term FROM vocabulary").all() as { term: string }[]
    )
      .map((r) => normWords(r.term))
      .filter((w) => w.length > 0);
    const ownerRaw = (
      (
        db
          .prepare("SELECT value FROM settings WHERE key = 'owner_name'")
          .get() as { value?: string } | undefined
      )?.value ?? ""
    ).trim();
    const owner = ownerRaw ? normWords(ownerRaw) : [];
    const per: {
      m: string;
      spans: SpanScore;
      noOwner: SpanScore;
      ch: (ChannelScore | null)[];
      prec: Prec;
      segments: number;
    }[] = [];
    const items: SpanItem[] = [];
    for (const id of ids) {
      const id8 = id.slice(0, 8);
      const gold = golds.get(id8);
      if (!gold) throw new Error(`no gold for ${id8}`);
      const m = db
        .prepare("SELECT calendar_attendees FROM meetings WHERE id = ?")
        .get(id) as { calendar_attendees: string | null } | undefined;
      if (!m) throw new Error(`meeting ${id8} is not in the run DB`);
      const rows = db
        .prepare(
          "SELECT id, source, idx, start_ms, end_ms, text, enhanced_text FROM meeting_segments WHERE meeting_id = ? ORDER BY source, idx, start_ms",
        )
        .all(id) as unknown as SegmentRow[];
      const spans = gold.spans ?? [];
      const ownerKey = owner.join(" ");
      per.push({
        m: id8,
        spans: scoreSpans(spans, rows, "asr"),
        noOwner: scoreSpans(
          spans.filter(
            (sp) =>
              owner.length === 0 ||
              normWords(spanText(sp)).join(" ") !== ownerKey,
          ),
          rows,
          "asr",
        ),
        ch: CHANNELS.map((c) => scoreChannel(gold, c, rows, "asr")),
        prec: possibleInsertions(
          rows,
          spans,
          vocab,
          owner,
          m.calendar_attendees,
        ),
        segments: rows.length,
      });
      for (const { sp, hit } of scoreSpanItems(spans, rows, "asr").scored)
        items.push({
          m: id8,
          ch: sp.channel,
          s: sp.startMs,
          e: sp.endMs,
          l: sp.label,
          c: sp.confidence,
          iv: sp.inVocab,
          hit,
        });
    }
    const metricsOf = (
      s: SpanScore,
      no: SpanScore,
      ch: (ChannelScore | null)[],
      p: Prec,
      segments: number,
    ): Metrics => ({
      ...spanMetrics(s, no),
      ...werMetrics(ch),
      ...precMetrics(p),
      segments,
    });
    return {
      metrics: metricsOf(
        addSpanScores(per.map((p) => p.spans)),
        addSpanScores(per.map((p) => p.noOwner)),
        per.flatMap((p) => p.ch),
        addPrec(per.map((p) => p.prec)),
        per.reduce((a, p) => a + p.segments, 0),
      ),
      meetings: per.map((p) => ({
        m: p.m,
        metrics: metricsOf(p.spans, p.noOwner, p.ch, p.prec, p.segments),
      })),
      items,
    };
  } finally {
    db.close();
  }
}

/** The per-meeting metrics that the ledger logs (prefix m.<id8>.). */
export const MEETING_LEDGER_METRICS = [
  "spans_all",
  "spans_all_hits",
  "spans_all_n",
  "spans_person",
  "spans_term",
  "wer",
  "wer_eligible",
  "possible_insertions",
  "segments",
  "asr_wall_s",
];
