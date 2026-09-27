/**
 * Per-endpoint LLM lane (specs/meeting-llm-queue.md §5.1–§5.3).
 *
 * The user's inference engine is one server hosted outside openstyle behind
 * `local_llm_url` — effectively one worker slot. Before this module nothing in
 * the repo arbitrated between the four LLM call sites that all hit it
 * (spec §3): a background meeting Summarize could occupy the engine for its
 * whole per-call window while the interactive dictation cleanup queued behind
 * it, which the user experiences as "the app got slow".
 *
 * The design in one sentence: **any waiting `interactive` call takes the next
 * free slot ahead of every `background` call, and a `background` call may not
 * start while dictation is live.**
 *
 * Three properties that are easy to get wrong and are load-bearing here:
 *
 * 1. **The lane key is the ENDPOINT, not the config key.** `local_llm_url`
 *    and an oMLX base URL that both resolve to `127.0.0.1:8123` are one
 *    physical box and must collapse into ONE lane. Keying on a setting name
 *    or a provider id would silently create two lanes and one GPU (§5.1).
 * 2. **Acquired and released PER CALL, never per job.** A Summarize run is
 *    N map calls plus a reduce, executed sequentially in `summarize.ts`; held
 *    per job it would block an interactive cleanup for the entire run. Held
 *    per call, the queue drains between chunks (§5.2).
 * 3. **No mid-call preemption.** Once a background call is on the wire it
 *    finishes. Spec §8 states that residual worst case numerically — it is
 *    bounded and explainable, not eliminated.
 *
 * The lane sits ALONGSIDE `lib/dictation-activity.ts` (it consumes that
 * module and shares its module-level `lastActiveAt` deliberately — spec §6
 * constraint 2) and ALONGSIDE `routes/meetings.ts`'s claim-before-await on
 * `activeJobs`, including the diarize rationale at `meetings.ts:963-973`.
 * Neither is replaced or "simplified" by this file.
 */

import { createAppLogger } from "@openstyle/utils";
import type { LlmTaskId } from "@openstyle/validations";
import { normalizeOmlxRoot } from "@openstyle/validations";
import {
  isDictationActive as isDictationActiveDefault,
  waitForDictationIdle,
} from "../dictation-activity.js";

const log = createAppLogger("llm-lane");

export type LlmLaneClass = "interactive" | "background";

/** Held for exactly one LLM request. `release()` is idempotent. */
export interface LaneLease {
  release(): void;
  readonly released: boolean;
}

/** Thrown when a call is cancelled while still QUEUED — the request never
 *  fired, so nothing downstream was touched (spec §7, "cancelled while
 *  queued": lease released unacquired, row unchanged). */
export class LlmLaneCancelledError extends Error {
  constructor(taskId: string) {
    super(`LLM call cancelled before it started (${taskId})`);
    this.name = "LlmLaneCancelledError";
  }
}

export interface AcquireLlmLaneArgs {
  /** Normalized `host:port` — see {@link llmLaneKey}. Two config keys pointed
   *  at one box MUST produce the same value or the queue is decorative. */
  lane: string;
  cls: LlmLaneClass;
  taskId: LlmTaskId;
  /** Polled on every queue tick — the existing cancel seam
   *  (`routes/meetings.ts` `activeJobCancellations`). */
  shouldStop?: () => boolean;
  /** Fired when the call actually had to wait, so the job blob can surface
   *  "queued" without inventing a second progress path. */
  onQueued?: (info: { waitedMs: number; ahead: number }) => void;
  /** Aborting this signal cancels a queued call (and is honoured by nothing
   *  else here — the in-flight call's own timeout stays its own boundary). */
  signal?: AbortSignal;
  /** Queue poll interval (ms). Small by default: this is handoff latency,
   *  and the poll does no I/O. */
  pollMs?: number;
  /** Sustained-idle window a background call waits out before it may start
   *  (ms). Defaults to `waitForDictationIdle`'s 15 s (§5.3) — deliberately
   *  the same number the STT callers use, exposed only so a test can pin the
   *  gate without simulating fifteen seconds. */
  idleMs?: number;
  /** Test seams. The dictation seam defaults to the REAL
   *  `dictation-activity.isDictationActive`, so production has no
   *  seam-omitted path — see {@link gateBackground}. */
  isDictationActive?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Concurrency per lane, by endpoint class. Not new numbers: these are the
 * ones already proven for STT at `meetings/transcriber.ts:175-178` ("parallel
 * requests just queue (or thrash), so keep it serial. Cloud providers take 2
 * in flight"), applied to the LLM endpoint for the same reason.
 */
export const LLM_LANE_CONCURRENCY_LOCAL = 1;
export const LLM_LANE_CONCURRENCY_CLOUD = 2;

/** The settings key holding the local engine's base URL (`llm/registry.ts`). */
const LOCAL_LLM_URL_SETTING = "local_llm_url";

/** Known cloud endpoints, so a cloud lane key is still a normalized
 *  `host:port` under the same identity rule as a local one. */
const CLOUD_HOSTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  vercel: "https://ai-gateway.vercel.sh/v1",
};

/** Loopback / private / `.local` → a box the user owns → concurrency 1. */
export function isLocalLaneHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return true;
  }
  if (h === "::1" || h === "[::1]" || h === "0.0.0.0") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 127 || a === 10 || a === 192 || (a === 172 && b >= 16 && b <= 31)
  );
}

/**
 * The lane key: normalized `host:port`.
 *
 * Every normalization here is necessary — `new URL().host` alone is not enough
 * (spec §5.1):
 *  - trailing path and `/v1` are not lane identity. Reuses
 *    `normalizeOmlxRoot()` (`packages/validations/src/omlx.ts:40-44`) rather
 *    than writing a third regex — the same precedent the local-llm provider
 *    follows at `llm/registry.ts:261`;
 *  - `localhost`, `127.0.0.1` and `[::1]` are the same socket → fold;
 *  - an omitted port folds to the scheme default, so `https://engine` and
 *    `https://engine:443` are one lane.
 *
 * Unparseable input gets a lane of its own (`lane:<input>`): a lane that
 * cannot be folded still serialises its own traffic, which is the fail-closed
 * direction, and the call itself fails at the provider layer anyway.
 */
export function llmLaneKey(input: string | null | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw) return "lane:unconfigured";
  const root = normalizeOmlxRoot(raw);
  let url: URL;
  try {
    url = new URL(root.includes("://") ? root : `http://${root}`);
  } catch {
    return `lane:${raw}`;
  }
  let host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    host = "127.0.0.1";
  }
  const secure = url.protocol === "https:";
  const port = url.port || (secure ? "443" : "80");
  return `${host}:${port}`;
}

/**
 * Lane key for a provider id. Local providers resolve through `local_llm_url`
 * — that IS the point: the endpoint, never the setting name. Known cloud
 * providers use {@link CLOUD_HOSTS}; anything else gets a lane of its own.
 */
export async function llmLaneKeyForProvider(
  providerId: string,
): Promise<string> {
  try {
    const { getLlmProvider } = await import("./registry.js");
    if (getLlmProvider(providerId)?.local) {
      const { readSetting } = await import("../db.js");
      return llmLaneKey(readSetting(LOCAL_LLM_URL_SETTING));
    }
  } catch {
    // DB/registry unavailable: fall through to a provider-identity lane. The
    // real call fails on the same missing row, and a lane that still
    // serialises is the safe direction.
  }
  const known = CLOUD_HOSTS[providerId];
  return known ? llmLaneKey(known) : `lane:${providerId}`;
}

// ---------------------------------------------------------------------------
// Queue state — module-level, in-memory, per-process (spec §4: no durable
// queue, no migration; a restart drops the queue and the meeting survives).
// ---------------------------------------------------------------------------

interface Waiter {
  cls: LlmLaneClass;
  taskId: LlmTaskId;
  since: number;
  /** The acquisition's clock, so a handoff from `drain()` — a different stack
   *  frame than the one that queued — reports the same clock it queued on. */
  now: () => number;
  settled: boolean;
  notified: boolean;
  onQueued?: (info: { waitedMs: number; ahead: number }) => void;
  resolve: (lease: LaneLease) => void;
  reject: (err: unknown) => void;
}

interface Lane {
  key: string;
  limit: number;
  inFlight: number;
  interactive: Waiter[];
  background: Waiter[];
}

const lanes = new Map<string, Lane>();

function laneFor(key: string): Lane {
  const existing = lanes.get(key);
  if (existing) return existing;
  const host = key.split(":")[0] ?? "";
  const lane: Lane = {
    key,
    limit: isLocalLaneHost(host)
      ? LLM_LANE_CONCURRENCY_LOCAL
      : LLM_LANE_CONCURRENCY_CLOUD,
    inFlight: 0,
    interactive: [],
    background: [],
  };
  lanes.set(key, lane);
  return lane;
}

function queueOf(lane: Lane, cls: LlmLaneClass): Waiter[] {
  return cls === "interactive" ? lane.interactive : lane.background;
}

/** How many callers would be served ahead of a `cls` arrival, counting the
 *  strict `interactive > background` precedence (§5.3). */
function aheadOf(lane: Lane, cls: LlmLaneClass): number {
  const higher = cls === "background" ? lane.interactive.length : 0;
  return higher + queueOf(lane, cls).length;
}

function removeWaiter(lane: Lane, w: Waiter): void {
  const q = queueOf(lane, w.cls);
  const i = q.indexOf(w);
  if (i >= 0) q.splice(i, 1);
}

function notifyQueued(w: Waiter, ahead: number): void {
  if (w.notified || !w.onQueued) return;
  w.notified = true;
  try {
    w.onQueued({ waitedMs: Math.max(0, w.now() - w.since), ahead });
  } catch {
    // Reporting only — a throwing progress callback must never cost a slot.
  }
}

function makeLease(lane: Lane): LaneLease {
  let released = false;
  return {
    get released(): boolean {
      return released;
    },
    release(): void {
      if (released) return;
      released = true;
      lane.inFlight = Math.max(0, lane.inFlight - 1);
      // Hand the slot straight to the head of the strict-priority queue
      // instead of burning a poll tick: this is the release-between-chunks
      // path the spec's timeline proof measures — an interactive cleanup has
      // to land in the gap between two background map calls.
      drain(lane);
    },
  };
}

/** Hand free slots to the heads of the queues, `interactive` first. */
function drain(lane: Lane): void {
  for (;;) {
    if (lane.inFlight >= lane.limit) return;
    // Strict priority: `interactive` is only skipped when it is empty.
    const q = lane.interactive.length > 0 ? lane.interactive : lane.background;
    let w: Waiter | undefined;
    while (q.length > 0) {
      const next = q.shift() as Waiter;
      if (!next.settled) {
        w = next;
        break;
      }
    }
    if (!w) return;
    lane.inFlight++;
    w.settled = true;
    notifyQueued(w, 0);
    w.resolve(makeLease(lane));
  }
}

/**
 * Background start gate (§5.3): dictation must be idle — and idle for the
 * sustained window — before a background call may even join the queue.
 *
 * **Fails closed**, deliberately NOT inheriting `waitForDictationIdle`'s
 * fail-open default: that helper returns immediately when the
 * `isDictationActive` seam is omitted (`dictation-activity.ts:74-75`), which
 * is right for its STT callers and wrong here, where a missing seam would
 * silently mean "no gate". The lane binds the REAL primitive by default
 * (`isDictationActiveDefault`), so production has no seam-omitted path at
 * all; a *throwing* seam is treated as "assume dictation is live", `warn`ed
 * once, retried.
 *
 * The shared lease is reused verbatim — same 15 s sustained-idle resume
 * window (`dictation-activity.ts:76`), same module-level `lastActiveAt` the
 * STT callers cooperate on (spec §6 constraint 2). Cancellation stays
 * responsive *inside* the wait by injecting a cancel-aware `sleep`: the
 * helper's own poll loop is the cancel check, so a cancelled caller exits the
 * gate instead of leaving a dangling 50 ms poller behind.
 */
async function gateBackground(
  isActive: () => boolean,
  cancelled: () => boolean,
  taskId: string,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  idleMs: number | undefined,
): Promise<void> {
  const cancelAwareSleep = async (ms: number): Promise<void> => {
    await sleep(ms);
    if (cancelled()) throw new LlmLaneCancelledError(taskId);
  };
  let warned = false;
  for (;;) {
    if (cancelled()) throw new LlmLaneCancelledError(taskId);
    try {
      await waitForDictationIdle({
        isDictationActive: isActive,
        pollMs,
        ...(idleMs === undefined ? {} : { idleMs }),
        sleep: cancelAwareSleep,
        // Threaded so the sustained-idle window runs on the caller's clock:
        // a test injecting a fake `now` must not busy-spin 15 real seconds
        // against a `sleep` that resolves immediately.
        now,
      });
      return;
    } catch (err) {
      if (err instanceof LlmLaneCancelledError) throw err;
      if (!warned) {
        log.warn(
          `llm lane: dictation state unreadable, holding background work: ${String(err)}`,
        );
        warned = true;
      }
      await cancelAwareSleep(pollMs);
    }
  }
}

/**
 * Acquire one slot on `lane` for exactly one LLM call.
 *
 * Resolves with a lease, or rejects with {@link LlmLaneCancelledError} if the
 * caller cancelled while queued (the request never fired). Never rejects for
 * saturation — saturation is a wait, not a failure; the call's own
 * `AbortSignal.timeout` stays the failure boundary.
 */
export async function acquireLlmLane(
  a: AcquireLlmLaneArgs,
): Promise<LaneLease> {
  const lane = laneFor(a.lane);
  const now = a.now ?? Date.now;
  const sleep = a.sleep ?? defaultSleep;
  const isActive = a.isDictationActive ?? isDictationActiveDefault;
  const pollMs = a.pollMs ?? 50;

  const cancelled = (): boolean => {
    try {
      if (a.shouldStop?.()) return true;
    } catch {
      // A throwing cancel seam reads as "not cancelled" — the call's own
      // timeout still bounds it, and failing a live call on a bookkeeping
      // error is the wrong direction.
    }
    return a.signal?.aborted === true;
  };

  if (a.cls === "background") {
    await gateBackground(
      isActive,
      cancelled,
      a.taskId,
      pollMs,
      sleep,
      now,
      a.idleMs,
    );
  }
  if (cancelled()) throw new LlmLaneCancelledError(a.taskId);

  // Fast path: slot free, nobody ahead. Every other handoff goes through
  // `drain`, and both the check and the increment are synchronous, so two
  // callers cannot both walk this path past `limit`.
  if (lane.inFlight < lane.limit && aheadOf(lane, a.cls) === 0) {
    lane.inFlight++;
    return makeLease(lane);
  }

  const since = now();
  return await new Promise<LaneLease>((resolve, reject) => {
    const w: Waiter = {
      cls: a.cls,
      taskId: a.taskId,
      since,
      now,
      settled: false,
      notified: false,
      ...(a.onQueued ? { onQueued: a.onQueued } : {}),
      resolve,
      reject,
    };
    queueOf(lane, a.cls).push(w);
    // The lane may have drained between the fast-path check and the push.
    drain(lane);
    if (w.settled) return;
    notifyQueued(w, aheadOf(lane, a.cls));

    const tick = (): void => {
      if (w.settled) return;
      if (cancelled()) {
        w.settled = true;
        removeWaiter(lane, w);
        w.reject(new LlmLaneCancelledError(a.taskId));
        return;
      }
      // Strict priority: an interactive caller that arrived after us goes
      // first. Background also stands aside if dictation went live again
      // while we were queued — cheap and synchronous; the sustained-idle
      // window was already honoured at the gate above.
      const blockedByPriority =
        a.cls === "background" && lane.interactive.length > 0;
      const blockedByDictation = a.cls === "background" && safeActive(isActive);
      if (
        blockedByPriority ||
        blockedByDictation ||
        lane.inFlight >= lane.limit
      ) {
        notifyQueued(w, aheadOf(lane, a.cls));
        void sleep(pollMs).then(tick, tick);
        return;
      }
      removeWaiter(lane, w);
      w.settled = true;
      lane.inFlight++;
      notifyQueued(w, 0);
      w.resolve(makeLease(lane));
    };

    void sleep(pollMs).then(tick, tick);
  });
}

function safeActive(isActive: () => boolean): boolean {
  try {
    return isActive();
  } catch {
    return true; // fail closed
  }
}

/**
 * Release `lease` exactly when `response`'s body is done — consumed, errored,
 * or cancelled — and hand back an otherwise identical Response.
 *
 * Exists for the Remix agent loop (spec §5.2's honest cost): the SDK owns the
 * tool loop there (`stopWhen: stepCountIs(REMIX_MAX_STEPS)`,
 * `remix-agent.ts:24`, `:97`), so "per call" is unavoidably one lease across
 * up to 16 model round-trips. Releasing the moment `toUIMessageStreamResponse`
 * returns would be a lie — nothing has been generated yet — and wiring the
 * SDK's `onFinish`/`onAbort` is weaker than watching the byte stream, because
 * a client that hangs up is exactly the case that must not leak the slot.
 * Coarse hurts background latency, not typing latency: Remix is `interactive`
 * and wins the queue anyway.
 */
export function releaseLeaseOnResponseBodyEnd(
  response: Response,
  lease: LaneLease,
): Response {
  if (!response.body) {
    lease.release();
    return response;
  }
  const reader = response.body.getReader();
  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    lease.release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          done();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (err) {
        done();
        controller.error(err);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Test seam: forget every lane's occupancy between cases. */
export function __resetLlmLanesForTests(): void {
  lanes.clear();
}

/** Diagnostic snapshot of one lane — used by the runtime evidence capture to
 *  quote real occupancy, and by tests to prove exactly-once release. */
export function llmLaneSnapshot(lane: string): {
  inFlight: number;
  limit: number;
  interactive: number;
  background: number;
} {
  // `laneFor` creates on read, so a never-used lane still reports the limit it
  // WOULD have — the number a caller needs to know before it enqueues.
  const l = laneFor(lane);
  return {
    inFlight: l.inFlight,
    limit: l.limit,
    interactive: l.interactive.length,
    background: l.background.length,
  };
}
