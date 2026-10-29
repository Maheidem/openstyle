// Possible insertions of one meeting (score_arms.mts and the Eval Lab).
// Each occurrence in the ASR text of (a) a vocabulary term or (b) an
// attendee name token (3+ letters) is "supported" when a gold span of any
// confidence on the same channel, within +-3 s, holds the same normal
// words (a span with verified_none supports nothing: the owner hears no
// named entity there). An unsupported occurrence is a possible insertion. The owner name
// is a name token too; its own count is reported apart. Numbers only.
import type { GoldSpan } from "../../gold.mts";
import { normalizeWords, scoreWords, spanText } from "../../score.mts";
import { attendeeTokens, countRun as count, hasRun as has } from "./names.mts";

export const INSERTION_TOL_MS = 3000;
export const normWords = (t: string) => normalizeWords(scoreWords(t)).words;

export type Prec = {
  vocabOcc: number;
  vocabUnsup: number;
  nameOcc: number;
  nameUnsup: number;
  ownerOcc: number;
  ownerUnsup: number;
};

export const addPrec = (xs: Prec[]): Prec => ({
  vocabOcc: xs.reduce((a, x) => a + x.vocabOcc, 0),
  vocabUnsup: xs.reduce((a, x) => a + x.vocabUnsup, 0),
  nameOcc: xs.reduce((a, x) => a + x.nameOcc, 0),
  nameUnsup: xs.reduce((a, x) => a + x.nameUnsup, 0),
  ownerOcc: xs.reduce((a, x) => a + x.ownerOcc, 0),
  ownerUnsup: xs.reduce((a, x) => a + x.ownerUnsup, 0),
});

export interface InsertionRow {
  source: string;
  start_ms: number | null;
  end_ms: number | null;
  text: string | null;
}

/**
 * The possible insertions of one meeting. `vocab` holds the normal words
 * of each vocabulary term, `owner` the normal words of the owner name
 * (empty when unset), `attendeesJson` the calendar_attendees column.
 */
export function possibleInsertions(
  rows: InsertionRow[],
  spans: GoldSpan[],
  vocab: string[][],
  owner: string[],
  attendeesJson: string | null,
): Prec {
  const gs = spans
    .filter((sp) => !sp.verifiedNone)
    .map((sp) => ({ ...sp, words: normWords(spanText(sp)) }));
  const nameKeys = new Set<string>();
  const names = [...attendeeTokens(attendeesJson).map(normWords), owner].filter(
    (w) =>
      w.length > 0 && !nameKeys.has(w.join(" ")) && nameKeys.add(w.join(" ")),
  );
  const prec: Prec = {
    vocabOcc: 0,
    vocabUnsup: 0,
    nameOcc: 0,
    nameUnsup: 0,
    ownerOcc: 0,
    ownerUnsup: 0,
  };
  for (const s of rows) {
    if (s.start_ms === null) continue;
    const words = normWords(s.text ?? "");
    const start = s.start_ms;
    const end = Math.max(start, s.end_ms ?? start);
    const near = gs.filter(
      (sp) =>
        sp.channel === s.source &&
        sp.endMs >= start - INSERTION_TOL_MS &&
        sp.startMs <= end + INSERTION_TOL_MS,
    );
    for (const [terms, kind] of [
      [vocab, "vocab"],
      [names, "name"],
    ] as const)
      for (const t of terms) {
        const n = count(words, t);
        if (n === 0) continue;
        const ok = near.some((sp) => has(sp.words, t));
        if (kind === "vocab") {
          prec.vocabOcc += n;
          if (!ok) prec.vocabUnsup += n;
        } else {
          prec.nameOcc += n;
          if (!ok) prec.nameUnsup += n;
        }
        if (
          kind === "name" &&
          owner.length > 0 &&
          t.join(" ") === owner.join(" ")
        ) {
          prec.ownerOcc += n;
          if (!ok) prec.ownerUnsup += n;
        }
      }
  }
  return prec;
}
