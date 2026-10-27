// The admission rule of the local LLM model pool (specs/llm-runtime-tuning.md
// section 6, owner decision 2026-10-26, section 9 item 3). Pure code: the
// pool in server.ts gives the facts, this file decides which workers stop.

/** One loaded (or starting) worker of the pool. */
export interface PoolMember {
  modelId: string;
  /** P(model): the MLX peak of the model (catalog `peakBytes`), not the RSS. */
  peakBytes: number;
  /** The last time a task used this worker (ms). */
  lastUsedAt: number;
  /** A request is in flight, or the worker is starting. Never evicted. */
  busy: boolean;
  /** The dictation model while dictation uses a local LLM. Never evicted. */
  pinned: boolean;
  /** A task with "Keep ready" uses this model. Evicted last. */
  keepReady: boolean;
}

export type PoolPlan =
  | { ok: true; evict: string[] }
  | {
      ok: false;
      /** The sum of P(model) of the workers that stay plus the new model. */
      neededBytes: number;
      limitBytes: number;
      /** The workers that cannot stop (pinned or busy). */
      blockers: string[];
    };

/**
 * Plan the start of `incoming`. The sum of P(model) of all workers must stay
 * at or under `limitBytes`. While it is over, stop the least recently used
 * worker that is not pinned and not busy. Workers without "Keep ready" go
 * first, then the "Keep ready" workers, each group in LRU order. When the
 * sum is still over the limit and pinned or busy workers stay, the plan
 * fails: the caller throws `MlxLlmPoolNoRoomError` (no swap).
 *
 * A model that is the only worker always starts, also when it is over the
 * limit alone. This keeps the one-worker behavior of a small Mac, where the
 * fit label already says "Tight fit" (Gemma 4 E2B on 8 GiB, section 5.2).
 */
export function planPoolStart(
  loaded: readonly PoolMember[],
  incoming: { modelId: string; peakBytes: number },
  limitBytes: number,
): PoolPlan {
  const others = loaded.filter((m) => m.modelId !== incoming.modelId);
  if (others.length < loaded.length) return { ok: true, evict: [] };

  const order = others
    .filter((m) => !m.pinned && !m.busy)
    .sort(
      (a, b) =>
        Number(a.keepReady) - Number(b.keepReady) ||
        a.lastUsedAt - b.lastUsedAt,
    );
  const evict: string[] = [];
  let staying = others.slice();
  const sum = () =>
    staying.reduce((acc, m) => acc + m.peakBytes, incoming.peakBytes);

  for (const victim of order) {
    if (sum() <= limitBytes) break;
    evict.push(victim.modelId);
    staying = staying.filter((m) => m.modelId !== victim.modelId);
  }
  if (sum() <= limitBytes || staying.length === 0) return { ok: true, evict };
  return {
    ok: false,
    neededBytes: sum(),
    limitBytes,
    blockers: staying.map((m) => m.modelId),
  };
}

/**
 * The new model does not fit next to the workers that must stay (pinned or
 * busy). Typed, so the meeting run can show a clear state (see
 * `modelUnavailableFrom`). The message has no user text.
 */
export class MlxLlmPoolNoRoomError extends Error {
  readonly code = "llm-pool-no-room";
  readonly modelId: string;
  readonly neededBytes: number;
  readonly limitBytes: number;
  readonly blockers: readonly string[];

  constructor(a: {
    modelId: string;
    neededBytes: number;
    limitBytes: number;
    blockers: readonly string[];
  }) {
    const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
    super(
      `Not enough memory to load the local model ${a.modelId}: ${gib(a.neededBytes)} GiB needed, ${gib(a.limitBytes)} GiB budget. These models are in use: ${a.blockers.join(", ")}.`,
    );
    this.name = "MlxLlmPoolNoRoomError";
    this.modelId = a.modelId;
    this.neededBytes = a.neededBytes;
    this.limitBytes = a.limitBytes;
    this.blockers = a.blockers;
  }
}
