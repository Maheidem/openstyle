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
  /**
   * The coarse phase of a transcribe job (specs/meeting-transcription-v2.md
   * §3.4): `"diarizing"` while the diarizer runs before the first chunk,
   * so the UI does not show 0 of 0 with no explanation. Absent (or
   * anything else) means the chunk-transcription phase, whose `done`/
   * `total` are the chunk counters.
   *
   * A workflow run (Enhance, Summarize) sets the other values
   * (specs/meeting-enhance-agentic.md 3.4.4). Its `done`/`total` count
   * work steps: one per chunk, then one per later phase.
   */
  phase?: MeetingJobPhase;
  /** Workflow run: the 1-based chunk or summary part in work, or null. */
  step?: number | null;
  /** Workflow run: the count of chunks or summary parts, or null. */
  steps?: number | null;
  /** Workflow run: the start of the chunk text in work, or null. */
  detail?: string | null;
}

export type MeetingJobPhase =
  | "diarizing"
  | "transcribing"
  | "preparing"
  | "reading"
  | "speakers"
  | "summarizing"
  | "combining"
  | "saving"
  | "tags";

/** What kind of job holds a meeting's slot. Transcription jobs (a full
 * re-transcribe or a retry-failed pass) and the workflow runs (Enhance, which
 * chains into Summarize, and Summarize alone; both from the button and the
 * auto-run after the status flip) are cancellable via
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

/** The soft-cancel controller of the job that passed one to `claimJob`. The
 * workflow runner passes it so a cancel also stops an in-flight model call
 * (specs/meeting-enhance-agentic.md 3.4.5). */
const controllers = new Map<string, AbortController>();

/** True when a job holds the slot for this meeting. */
export function hasJob(id: string): boolean {
  return jobs.has(id);
}

/** Take the slot. Returns false, and changes nothing, when it is taken. */
export function claimJob(
  id: string,
  kind: MeetingJobKind,
  progress: MeetingJobProgress,
  controller?: AbortController,
): boolean {
  if (jobs.has(id)) return false;
  jobs.set(id, progress);
  jobKinds.set(id, kind);
  if (controller) controllers.set(id, controller);
  return true;
}

/** Free the slot with its kind, its cancel flag and its controller. */
export function releaseJob(id: string): void {
  jobs.delete(id);
  jobKinds.delete(id);
  cancellations.delete(id);
  controllers.delete(id);
}

/** Change the kind of the job that holds the slot. A chained run starts as
 * `enhance` and becomes `summarize` when its Summarize stage starts (3.6).
 * No-op when no job holds the slot. */
export function setJobKind(id: string, kind: MeetingJobKind): void {
  if (jobs.has(id)) jobKinds.set(id, kind);
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
  controllers.get(id)?.abort(new DOMException("Cancelled", "AbortError"));
  return true;
}

export function isCancelRequested(id: string): boolean {
  return cancellations.has(id);
}
