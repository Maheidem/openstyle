// gpu-queue.mts: the order rule of the shared GPU lock queue
// (/tmp/openstyle-gpu.queue, owner rule 2026-10-20). Pure functions; the
// lock itself is in runtime.mts.

/** A queue line older than this is skipped (never deleted): its job likely died. */
const STALE_QUEUE_MS = 2 * 3600_000;

/**
 * The time of a queue line in ms: an ISO time, else an HH:MM[:SS] time of
 * today (of yesterday when that is in the future), else null.
 */
export function queueLineTime(line: string, now: number): number | null {
  const iso =
    /\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?/.exec(
      line,
    );
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t)) return t;
  }
  const hm = /(?:^|\s)(\d{1,2}):(\d\d)(?::(\d\d))?(?=\s|$)/.exec(line);
  if (!hm) return null;
  const d = new Date(now);
  d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0), 0);
  let t = d.getTime();
  if (t > now + 5 * 60_000) t -= 24 * 3600_000;
  return t;
}

/**
 * True when it is our turn: our line is the first queue line that is not
 * stale. A line's age is its own time, or (with no time in it) the time
 * this process first saw it (`seen`). The GPU lock rule (2026-10-21): the
 * first live line in the queue goes first.
 */
export function isOurTurn(
  lines: string[],
  ours: string,
  now: number,
  seen: Map<string, number>,
  staleMs = STALE_QUEUE_MS,
): boolean {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === ours) return true;
    if (!seen.has(line)) seen.set(line, now);
    const t = queueLineTime(line, now) ?? (seen.get(line) as number);
    if (now - t <= staleMs) return false;
  }
  // Our line is missing (someone removed it): it is not our turn.
  return false;
}
