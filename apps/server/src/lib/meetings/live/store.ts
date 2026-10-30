/**
 * Live transcript store (issue #375, specs/live-chat.md section 1).
 *
 * It lives in memory only. One entry exists for each recording that has live
 * chat on. The entry goes away when the recording stops. The final transcript
 * of the meeting then replaces it. Nothing here is merged with the final
 * transcript.
 */

export type LiveSource = "mic" | "system";

export interface LiveLine {
  source: LiveSource;
  /** Milliseconds from the start of the channel. */
  startMs: number;
  endMs: number;
  text: string;
  /** False for the partial text of the open tail. */
  final: boolean;
}

/**
 * `starting`: the loop has not read audio yet.
 * `warming`: the ASR model loads for the first time.
 * `ready`: the loop runs.
 * `unavailable`: live chat cannot run for this meeting (see `reason`).
 */
export type LiveStatus = "starting" | "warming" | "ready" | "unavailable";

export interface LiveSnapshot {
  status: LiveStatus;
  reason?: string;
  /** Final lines first in time order, then one partial for each channel. */
  lines: LiveLine[];
}

interface LiveEntry {
  status: LiveStatus;
  reason?: string;
  finals: LiveLine[];
  partials: Partial<Record<LiveSource, LiveLine>>;
}

const entries = new Map<string, LiveEntry>();

export function openLive(meetingId: string): void {
  entries.set(meetingId, { status: "starting", finals: [], partials: {} });
}

export function hasLive(meetingId: string): boolean {
  return entries.has(meetingId);
}

export function setLiveStatus(
  meetingId: string,
  status: LiveStatus,
  reason?: string,
): void {
  const entry = entries.get(meetingId);
  if (!entry) return;
  entry.status = status;
  entry.reason = reason;
}

export function addFinalLine(meetingId: string, line: LiveLine): void {
  const entry = entries.get(meetingId);
  if (!entry) return;
  entry.finals.push({ ...line, final: true });
  // A final line for a channel replaces the partial of that channel.
  delete entry.partials[line.source];
}

/** Set the partial of a channel, or clear it with null. */
export function setPartialLine(
  meetingId: string,
  source: LiveSource,
  line: Omit<LiveLine, "final"> | null,
): void {
  const entry = entries.get(meetingId);
  if (!entry) return;
  if (line) entry.partials[source] = { ...line, final: false };
  else delete entry.partials[source];
}

export function getLive(meetingId: string): LiveSnapshot | null {
  const entry = entries.get(meetingId);
  if (!entry) return null;
  const byTime = (a: LiveLine, b: LiveLine) => a.startMs - b.startMs;
  const partials = Object.values(entry.partials) as LiveLine[];
  return {
    status: entry.status,
    ...(entry.reason ? { reason: entry.reason } : {}),
    lines: [...[...entry.finals].sort(byTime), ...partials.sort(byTime)],
  };
}

export function dropLive(meetingId: string): void {
  entries.delete(meetingId);
}
