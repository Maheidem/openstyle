// Claims and cancel controllers of running workflow runs, by scope and scope
// id (specs/meeting-enhance-agentic.md 3.1). Generic: it knows no consumer.
// The consumer keeps its own job slot and progress blob (a meeting has its own
// job registry). This registry answers one question: which run holds a scope,
// and how to stop it. It is in memory and dies with the process.

export interface RunClaim {
  runId: string;
  /** Soft cancel: the signal every call of the run composes with its timeout. */
  controller: AbortController;
}

export interface RunRegistry {
  /** False, and no change, when the scope is claimed. */
  claim(scope: string, scopeId: string, claim: RunClaim): boolean;
  get(scope: string, scopeId: string): RunClaim | null;
  /** Abort the controller of the claim. False when the scope has no claim. */
  cancel(scope: string, scopeId: string): boolean;
  /** Drops the claim only when `runId` still holds it. */
  release(scope: string, scopeId: string, runId: string): void;
  size(): number;
}

export function createRunRegistry(): RunRegistry {
  const claims = new Map<string, RunClaim>();
  const keyOf = (scope: string, scopeId: string) => `${scope}\u0000${scopeId}`;
  return {
    claim(scope, scopeId, claim) {
      const key = keyOf(scope, scopeId);
      if (claims.has(key)) return false;
      claims.set(key, claim);
      return true;
    },
    get(scope, scopeId) {
      return claims.get(keyOf(scope, scopeId)) ?? null;
    },
    cancel(scope, scopeId) {
      const claim = claims.get(keyOf(scope, scopeId));
      if (!claim) return false;
      claim.controller.abort(new DOMException("Cancelled", "AbortError"));
      return true;
    },
    release(scope, scopeId, runId) {
      const key = keyOf(scope, scopeId);
      if (claims.get(key)?.runId === runId) claims.delete(key);
    },
    size() {
      return claims.size;
    },
  };
}
