// stage-score.mts: the per-stage scores of the parameter sweep, against the
// gold keys, with the scorers of score.mts. Numbers only: no meeting text
// leaves this module.
//
// Each stage gives flat metrics and one objective (higher is better), the
// value that the search ranks on:
//   correctChunk     100 x (ASR WER - Enhance WER, pooled; normalized WER of
//                    score.mts, SCORER below) + 0.5 x fixes found
//                    - 1 x must-not-change violations - 1 x failed units
//   identifySpeakers correct - 2 x wrong (a wrong name is a hard fail)
//                    - 1 x failed units
//   summarize        matched decisions + matched action items
//                    + 0.5 x (owner correct + due correct)
//                    - 1 x (owner wrong + due wrong) - 3 x mustNotClaim hits
//                    - 0.25 x invented items (output items with no gold match)
//                    - 5 x no summary
//   suggestTags      F1 of precision and recall - 1 x failed units

import type { SegmentRow } from "./checks.mts";
import type { Gold } from "./gold.mts";
import {
  pooled,
  scoreChannel,
  scoreFixes,
  scoreSpeakers,
  scoreSummary,
  scoreTags,
} from "./score.mts";
import type { StageName, StageOutput } from "./stage-replay.mts";

export type Metrics = Record<string, number | null>;

/**
 * The scorer of the objectives. "norm-v1" (2026-10-22): the correctChunk WER
 * is the normalized WER (number words as digits, an exact adjacent repeat
 * counted once). Results without this field used the raw WER.
 */
export const SCORER = "norm-v1";

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Latency, tokens, finish reasons and JSON validity of the stage calls. */
export function callMetrics(out: StageOutput): Metrics {
  const c = out.calls;
  return {
    calls: c.length,
    latencyMs: sum(c.map((x) => x.latencyMs)),
    outputTokens: sum(c.map((x) => x.outputTokens)),
    finishLength: c.filter((x) => x.finish === "length").length,
    finishOther: c.filter((x) => x.finish !== "length" && x.finish !== "stop")
      .length,
    jsonInvalid: c.filter((x) => !x.jsonValid).length,
    failedUnits: out.failedUnits,
  };
}

/** The segment rows with the replayed corrections as enhanced_text (raw rows otherwise). */
export function withCorrections(
  rows: SegmentRow[],
  corrections: Record<string, string>,
): SegmentRow[] {
  return rows.map((s) => ({ ...s, enhanced_text: corrections[s.id] ?? null }));
}

/** The stage metrics of one meeting (gold-scored part and call part). */
export function scoreStage(
  stage: StageName,
  out: StageOutput,
  gold: Gold,
  rows: SegmentRow[],
): Metrics {
  const m: Metrics = callMetrics(out);
  if (stage === "correctChunk") {
    const segs = withCorrections(rows, out.corrections ?? {});
    const asr = ["mic", "system"].map((c) =>
      scoreChannel(gold, c as "mic" | "system", segs, "asr"),
    );
    const enh = ["mic", "system"].map((c) =>
      scoreChannel(gold, c as "mic" | "system", segs, "enhance"),
    );
    const a = pooled(asr, "words");
    const e = pooled(enh, "words");
    const ar = pooled(asr, "wordsRaw");
    const eR = pooled(enh, "wordsRaw");
    const ac = pooled(asr, "chars");
    const ec = pooled(enh, "chars");
    const f = scoreFixes(gold, segs);
    const dropped = out.dropped ?? {};
    Object.assign(m, {
      asrWordErrors: a?.errors ?? null,
      enhWordErrors: e?.errors ?? null,
      refWords: a?.ref ?? null,
      wer: e?.rate ?? null,
      cer: ec?.rate ?? null,
      werDelta: a?.rate != null && e?.rate != null ? r4(a.rate - e.rate) : null,
      asrWordErrorsRaw: ar?.errors ?? null,
      enhWordErrorsRaw: eR?.errors ?? null,
      refWordsRaw: ar?.ref ?? null,
      werRaw: eR?.rate ?? null,
      werDeltaRaw:
        ar?.rate != null && eR?.rate != null ? r4(ar.rate - eR.rate) : null,
      cerDelta:
        ac?.rate != null && ec?.rate != null ? r4(ac.rate - ec.rate) : null,
      applied: Object.keys(out.corrections ?? {}).length,
      droppedByChecks: sum(Object.values(dropped)),
      droppedDeletesWords: dropped.deletes_words ?? 0,
      droppedUnchanged: dropped.unchanged ?? 0,
      fixesFound: f.fixesFound,
      fixesMissed: f.fixesMissed,
      mustNotChangeHits: f.mustNotChangeViolations,
    });
  } else if (stage === "identifySpeakers") {
    const s = scoreSpeakers(gold, out.speakers ?? []);
    Object.assign(m, {
      speakersCorrect: s?.correct ?? null,
      speakersWrong: s?.wrong ?? null,
      speakersMissing: s?.missing ?? null,
      suggestions: (out.speakers ?? []).length,
    });
  } else if (stage === "summarize") {
    const s = scoreSummary(gold, out.summaryJson ?? null);
    Object.assign(m, {
      summaryParsed: s ? (s.parsed ? 1 : 0) : null,
      decisionsMatched: s?.decisions.matched ?? null,
      decisionsGold: s?.decisions.gold ?? null,
      actionItemsMatched: s?.actionItems.matched ?? null,
      actionItemsGold: s?.actionItems.gold ?? null,
      factsMatched: s ? s.decisions.matched + s.actionItems.matched : null,
      ownerCorrect: s?.owner.correct ?? null,
      ownerWrong: s?.owner.wrong ?? null,
      ownerMissing: s?.owner.missing ?? null,
      dueCorrect: s?.due.correct ?? null,
      dueWrong: s?.due.wrong ?? null,
      dueMissing: s?.due.missing ?? null,
      mustNotClaimHits: s?.mustNotClaimHits.length ?? null,
      inventedItems: s
        ? s.decisions.unmatchedOutput.length +
          s.actionItems.unmatchedOutput.length
        : null,
      outputItems: s ? s.decisions.output + s.actionItems.output : null,
      summaryChars: out.summaryJson ? out.summaryJson.length : 0,
      summaryPartial: out.summaryPartial ? 1 : 0,
    });
  } else {
    const t = scoreTags(gold, out.tags ?? []);
    Object.assign(m, {
      tagsOutput: t?.output ?? null,
      tagsPrecision: t?.precision ?? null,
      tagsRecall: t?.recall ?? null,
      tagsMatchedOutput: t?.matchedOutput ?? null,
      tagsMatchedExpected: t?.matchedExpected ?? null,
      tagsExpected: t?.expected ?? null,
    });
  }
  return m;
}

const n = (x: number | null | undefined) => (typeof x === "number" ? x : 0);

/**
 * The objective of a stage over several meetings (higher is better). The
 * correction WER is pooled over the meetings (sum of errors / sum of words).
 */
export function objective(stage: StageName, perMeeting: Metrics[]): number {
  const failed = sum(perMeeting.map((m) => n(m.failedUnits)));
  if (stage === "correctChunk") {
    const ref = sum(perMeeting.map((m) => n(m.refWords)));
    const delta =
      ref > 0
        ? (sum(perMeeting.map((m) => n(m.asrWordErrors))) -
            sum(perMeeting.map((m) => n(m.enhWordErrors)))) /
          ref
        : 0;
    return r4(
      100 * delta +
        0.5 * sum(perMeeting.map((m) => n(m.fixesFound))) -
        sum(perMeeting.map((m) => n(m.mustNotChangeHits))) -
        failed,
    );
  }
  if (stage === "identifySpeakers")
    return r4(
      sum(
        perMeeting.map((m) => n(m.speakersCorrect) - 2 * n(m.speakersWrong)),
      ) - failed,
    );
  if (stage === "summarize")
    return r4(
      sum(
        perMeeting.map(
          (m) =>
            n(m.factsMatched) +
            0.5 * (n(m.ownerCorrect) + n(m.dueCorrect)) -
            (n(m.ownerWrong) + n(m.dueWrong)) -
            3 * n(m.mustNotClaimHits) -
            0.25 * n(m.inventedItems) -
            (m.summaryParsed === 0 ? 5 : 0),
        ),
      ),
    );
  // suggestTags: mean F1 over the meetings.
  const f1 = perMeeting.map((m) => {
    const p = n(m.tagsPrecision);
    const r = n(m.tagsRecall);
    return p + r > 0 ? (2 * p * r) / (p + r) : 0;
  });
  return r4(sum(f1) - failed);
}

/** Sum the metrics of several meetings (rates are averaged). */
export function totals(perMeeting: Metrics[]): Metrics {
  const out: Metrics = {};
  const rate =
    /^(wer|cer|werDelta|cerDelta|werRaw|werDeltaRaw|tagsPrecision|tagsRecall)$/;
  const keys = new Set(perMeeting.flatMap((m) => Object.keys(m)));
  for (const k of keys) {
    const vals = perMeeting
      .map((m) => m[k])
      .filter((v): v is number => typeof v === "number");
    if (vals.length === 0) {
      out[k] = null;
      continue;
    }
    out[k] = rate.test(k) ? r4(sum(vals) / vals.length) : r4(sum(vals));
  }
  return out;
}
