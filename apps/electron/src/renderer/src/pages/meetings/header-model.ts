// Pure rules of the compact meeting header (issue #262).

/** The actions of the header toolbar. */
export type HeaderActionKey =
  | "transcribe"
  | "retry"
  | "enhance"
  | "identify"
  | "speakers"
  | "summarize";

/**
 * The next step of a meeting, shown as the primary button. Retry failed
 * chunks first, then Transcribe, then Enhance, then Summarize. A finished
 * meeting (transcript, Enhance and summary done) has no primary button.
 * A missing LLM does not change the step: the button shows, disabled.
 */
export function primaryActionKey(state: {
  failedCount: number;
  transcribing: boolean;
  hasTranscript: boolean;
  hasEnhanced: boolean;
  hasSummary: boolean;
}): HeaderActionKey | null {
  if (state.failedCount > 0 && !state.transcribing) return "retry";
  if (!state.hasTranscript) return "transcribe";
  if (!state.hasEnhanced) return "enhance";
  if (!state.hasSummary) return "summarize";
  return null;
}

/**
 * How many tag chips fit on one line. `widths` are the full chip widths in
 * order, `gap` is the space between items, `available` is the width of the
 * line, and `reserve` is the width that the "+N" chip needs. When fewer than
 * `min` chips fit at full width, the line can still show up to `min` chips,
 * but only when each chip keeps at least `minChip` px (about 6 characters).
 * A tag never shrinks to 1 or 2 letters: then fewer chips show.
 */
export function fitTagCount(
  widths: readonly number[],
  gap: number,
  available: number,
  reserve: number,
  min = 3,
  minChip = 56,
): number {
  const need = (k: number, width: (w: number) => number): number =>
    widths.slice(0, k).reduce((sum, w) => sum + width(w), 0) +
    gap * Math.max(k - 1, 0) +
    (k < widths.length ? reserve : 0);
  let count = 0;
  for (let k = widths.length; k > 0; k--) {
    if (need(k, (w) => w) <= available) {
      count = k;
      break;
    }
  }
  for (let k = Math.min(min, widths.length); k > count; k--) {
    if (need(k, (w) => Math.min(w, minChip)) <= available) return k;
  }
  return count;
}
