// Change hints for the search indexer (specs/local-semantic-search.md 6.2).
// A hint is not the truth: the indexer compares the source hash, so it is
// correct with no hint at all. This module has no imports, so any writer of
// meeting text can call it without an import cycle.

const pending = new Set<string>();
let wake: (() => void) | null = null;

/** Queue a meeting for the indexer and wake its loop. */
export function notifyMeetingChanged(meetingId: string): void {
  pending.add(meetingId);
  wake?.();
}

/** Take every queued id (in insert order) and clear the set. */
export function takePendingMeetings(): string[] {
  const ids = [...pending];
  pending.clear();
  return ids;
}

export function pendingMeetingCount(): number {
  return pending.size;
}

/** The indexer sets its wake function here. null removes it. */
export function setIndexerWake(fn: (() => void) | null): void {
  wake = fn;
}
