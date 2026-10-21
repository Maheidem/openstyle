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
 * How many tag chips fit on one line. `widths` are the chip widths in
 * order, `gap` is the space between items, `available` is the width of the
 * line, and `reserve` is the width that the "+N" chip needs. The line shows
 * at least `min` chips (when the meeting has that many), also when they do
 * not fit: those chips then truncate.
 */
export function fitTagCount(
  widths: readonly number[],
  gap: number,
  available: number,
  reserve: number,
  min = 3,
): number {
  let used = 0;
  let count = 0;
  for (let i = 0; i < widths.length; i++) {
    const next = used + (i > 0 ? gap : 0) + widths[i];
    // The last chip needs no room for "+N".
    const room = i === widths.length - 1 ? available : available - reserve;
    if (next > room) break;
    used = next;
    count = i + 1;
  }
  return Math.max(count, Math.min(min, widths.length));
}
