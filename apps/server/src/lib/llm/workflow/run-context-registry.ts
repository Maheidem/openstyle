// A map from a run id to the in-memory context of that run (cancel signal,
// progress counters). It never holds job claims (specs/meeting-enhance-agentic.md
// 3.1). Generic: it knows no consumer.

export interface RunContextRegistry<C extends { runId: string }> {
  /** Throws when the run id is already registered. */
  register(ctx: C): void;
  /** Throws when no context exists for the run id. */
  get(runId: string): C;
  drop(runId: string): void;
  size(): number;
}

export function createRunContextRegistry<
  C extends { runId: string },
>(): RunContextRegistry<C> {
  const contexts = new Map<string, C>();
  return {
    register(ctx) {
      if (contexts.has(ctx.runId)) {
        throw new Error(`Run context already registered: ${ctx.runId}`);
      }
      contexts.set(ctx.runId, ctx);
    },
    get(runId) {
      const ctx = contexts.get(runId);
      if (!ctx) throw new Error(`No run context for run ${runId}`);
      return ctx;
    },
    drop(runId) {
      contexts.delete(runId);
    },
    size() {
      return contexts.size;
    },
  };
}
