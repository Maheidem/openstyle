/**
 * In-memory registry of the running meeting jobs. One job per meeting at a
 * time. Same shape as the whisper model-download precedent
 * (lib/whisper/models.ts `activeDownloads`): state keyed by meeting id, jobs
 * kicked fire-and-forget from the route, progress polled via GET /:id.
 *
 * `claimJob` is synchronous on purpose. Each route calls it after its guards
 * and before its first await, so no second request can slip in between the
 * busy check and the claim (see the diarize rationale in routes/meetings.ts).
 * Nothing here is durable: the state dies with the process, like the queue.
 */

export interface MeetingJobProgress {
  done: number;
  total: number;
  failed: number;
  /** Set while one of the job's LLM calls is waiting for its lane
   * (specs/meeting-llm-queue.md §5.5). Only ever written by the summarize
   * job, which owns its blob outright — a transcribe job's blob is replaced
   * wholesale by `TranscriberDeps.onProgress`, so it never carries this. */
  queued?: { ahead: number; sinceMs: number } | null;
}

/** What kind of job holds a meeting's slot. Transcription jobs (a full
 * re-transcribe or a retry-failed pass), the async Summarize job and the
 * Enhance passes (the in-request /enhance and the auto-run job behind the
 * status flip, specs/meeting-transcription-v2.md §3.2) are cancellable via
 * POST /:id/cancel-transcribe; the diarize pass claims the same concurrency
 * slot (shared-ANE-resource exclusion) but is a bounded, in-request
 * local-model run that ignores the cancellation flag. */
export type MeetingJobKind =
  | "transcribe"
  | "retry-failed"
  | "diarize"
  | "summarize"
  | "enhance";

const CANCELLABLE_KINDS: ReadonlySet<MeetingJobKind> = new Set([
  "transcribe",
  "retry-failed",
  "summarize",
  "enhance",
]);

const jobs = new Map<string, MeetingJobProgress>();

/** Kind of the job holding each slot (set and cleared with the slot). */
const jobKinds = new Map<string, MeetingJobKind>();

/** Meetings whose running job was asked to stop via
 * POST /:id/cancel-transcribe. Polled between chunk tasks via the
 * transcriber's shouldStop seam (in-flight chunks are allowed to finish);
 * cleared together with the slot when the job releases it. */
const cancellations = new Set<string>();

/** Which kind of job last failed for a meeting, and why. It lives beside the
 * slot because the job blob is deleted in the `finally` of the job. A renderer
 * that polls every second can miss a final `job.error` in the gap between the
 * last running poll and the deletion. The `meetings.error` column is not
 * available for these failures (spec §6 constraint 3), because it is the
 * *chunk-failure* banner. The entry stays until the next claim of the same
 * slot or until a successful run clears it. Because of this, a re-summarize
 * never shows an old failure. The map size is at most the number of meetings
 * that failed to summarize in this process. */
const failures = new Map<string, string>();

/** True when a job holds the slot for this meeting. */
export function hasJob(id: string): boolean {
  return jobs.has(id);
}

/** Take the slot. Returns false, and changes nothing, when it is taken. */
export function claimJob(
  id: string,
  kind: MeetingJobKind,
  progress: MeetingJobProgress,
): boolean {
  if (jobs.has(id)) return false;
  jobs.set(id, progress);
  jobKinds.set(id, kind);
  return true;
}

/** Free the slot with its kind and its cancel flag. */
export function releaseJob(id: string): void {
  jobs.delete(id);
  jobKinds.delete(id);
  cancellations.delete(id);
}

/** Replace the progress blob wholesale. */
export function setProgress(id: string, progress: MeetingJobProgress): void {
  jobs.set(id, progress);
}

/** Merge fields into the progress blob. No-op when no job holds the slot. */
export function updateProgress(
  id: string,
  patch: Partial<MeetingJobProgress>,
): void {
  const cur = jobs.get(id);
  if (!cur) return;
  jobs.set(id, { ...cur, ...patch });
}

/** The kind of the job holding the slot, or null when the slot is free.
 * (Set and cleared together with the slot, so `hasJob(id)` implies a kind.) */
export function getJobKind(id: string): MeetingJobKind | null {
  return jobKinds.get(id) ?? null;
}

/** The job blob with its kind, or null when no job holds the slot. */
export function getJob(
  id: string,
): (MeetingJobProgress & { kind: MeetingJobKind | null }) | null {
  const progress = jobs.get(id);
  if (!progress) return null;
  return { ...progress, kind: jobKinds.get(id) ?? null };
}

/** Ask the running job to stop. Returns false when no cancellable job holds
 * the slot (none, or a diarize pass). */
export function requestCancel(id: string): boolean {
  const kind = jobKinds.get(id);
  if (!kind || !CANCELLABLE_KINDS.has(kind)) return false;
  cancellations.add(id);
  return true;
}

export function isCancelRequested(id: string): boolean {
  return cancellations.has(id);
}

export function setJobFailure(id: string, text: string): void {
  failures.set(id, text);
}

export function getJobFailure(id: string): string | undefined {
  return failures.get(id);
}

export function clearJobFailure(id: string): void {
  failures.delete(id);
}
