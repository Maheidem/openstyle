/**
 * The paused flag of a running recording (specs/meeting-mode.md, "Pause and
 * resume"). It lives in memory only. The recorder sets it through
 * `PUT /api/meetings/:id/paused`. While it is set, the live loop reads no
 * audio, because the recorder writes none.
 */

const paused = new Set<string>();

export function setRecordingPaused(meetingId: string, value: boolean): void {
  if (value) paused.add(meetingId);
  else paused.delete(meetingId);
}

export function isRecordingPaused(meetingId: string): boolean {
  return paused.has(meetingId);
}
