/**
 * Live transcript store (issue #375, specs/live-chat.md section 1).
 *
 * It lives in memory only. One entry exists for each recording that has live
 * chat on. The entry goes away when the recording stops. At Stop, the route
 * reads the final lines and saves them as the transcript of the meeting
 * (`finish.ts`). A full transcription replaces them later. Nothing here is
 * merged with a full transcript.
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
  /** Ticks that the loop skipped because a dictation ran. */
  skippedTicks: number;
}

interface LiveEntry {
  status: LiveStatus;
  reason?: string;
  finals: LiveLine[];
  partials: Partial<Record<LiveSource, LiveLine>>;
  skippedTicks: number;
}

const entries = new Map<string, LiveEntry>();

export function openLive(meetingId: string): void {
  entries.set(meetingId, {
    status: "starting",
    finals: [],
    partials: {},
    skippedTicks: 0,
  });
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

export function countSkippedTick(meetingId: string): void {
  const entry = entries.get(meetingId);
  if (entry) entry.skippedTicks++;
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
    skippedTicks: entry.skippedTicks,
  };
}

/** The final lines in time order, or [] for an unknown meeting. */
export function getFinalLines(meetingId: string): LiveLine[] {
  const entry = entries.get(meetingId);
  if (!entry) return [];
  return [...entry.finals].sort((a, b) => a.startMs - b.startMs);
}

/**
 * Replace the text of one final line, or remove the line when `text` is empty.
 * The loop uses it when the language lock reads the first lines again.
 */
export function setFinalText(
  meetingId: string,
  source: LiveSource,
  startMs: number,
  text: string,
): void {
  const entry = entries.get(meetingId);
  if (!entry) return;
  const i = entry.finals.findIndex(
    (l) => l.source === source && l.startMs === startMs,
  );
  if (i < 0) return;
  if (text) entry.finals[i] = { ...entry.finals[i], text };
  else entry.finals.splice(i, 1);
}

export function dropLive(meetingId: string): void {
  entries.delete(meetingId);
}
