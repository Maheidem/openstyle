/**
 * Pure decision logic for the Settings numeric inputs that must NOT write on
 * every keystroke (`meeting_summary_timeout_seconds`, Settings → Data).
 *
 * Why this exists as a separate module rather than inline in `settings.tsx`:
 * the defect it prevents (D-1/D-2, evidence
 * `openstyle-evidence/summary-timeout/defects.json`) was invisible to
 * `fill()`-driven tests and only appeared under real per-keypress typing —
 * the intermediate prefix of a typed number is a *draft*, never a write. That
 * rule is arithmetic over strings, so it lives here where node vitest can
 * pin it (the app's vitest config is `environment: "node"`, no jsdom, no
 * testing-library — same reasoning as `models/preset-ops.ts`).
 *
 * The contract:
 * - `onChange` produces a DRAFT and writes nothing.
 * - A write happens only on an explicit commit trigger (blur or Enter) with
 *   an in-bounds draft, or on an explicit Reset (which writes empty).
 * - An invalid draft on blur reverts to the saved value; it never writes a
 *   truncated in-range prefix of what the user typed.
 * - A failed write reverts the field to what the server actually holds and
 *   surfaces an error — it never looks like a success.
 */

/** What the renderer dropped from what the user actually typed. */
export interface NumericDraft {
  /** Sanitized input: digits only, capped at `maxLength`. */
  digits: string;
  /**
   * EVERY character the user typed that did not land in the field, in order:
   * non-digits AND digits past the cap (`"-45.7"` → `"-."`, `"99999"` →
   * `"9"`). Non-empty means the field no longer shows what the user typed,
   * which the UI must say out loud instead of staying quiet (D-3/D-4).
   */
  stripped: string;
  /** True when the digit cap alone dropped input (independent of `stripped`). */
  truncated: boolean;
}

/**
 * Sanitize raw input to digits, capped at `maxLength`.
 *
 * `maxLength` is also applied as the input's `maxLength` attribute so the
 * browser refuses the extra digit instead of swallowing it silently after the
 * fact (D-3: 4 digits is the ceiling because the max is 3600).
 */
export function sanitizeDigits(raw: string, maxLength: number): string {
  return raw.replace(/\D/g, "").slice(0, maxLength);
}

/**
 * Inspect a raw edit: what lands in the field, what was dropped, and whether
 * the cap bit off more than the user can chew. Pure — touches no state, so
 * the "silently reinterpreted input" defect classes have one testable site.
 */
export function inspectNumericDraft(
  raw: string,
  maxLength: number,
): NumericDraft {
  let kept = "";
  let dropped = "";
  for (const ch of raw) {
    if (/\d/.test(ch) && kept.length < maxLength) kept += ch;
    else dropped += ch;
  }
  return {
    digits: kept,
    stripped: dropped,
    truncated: raw.replace(/\D/g, "").length > maxLength,
  };
}

/**
 * The outcome of a commit trigger. `write` is the ONLY branch that touches
 * the server; `reset` writes empty (which the resolver reads as "default");
 * `revert` and `noop` write nothing at all.
 */
export type CommitIntent =
  | { kind: "noop" }
  | { kind: "revert" }
  | { kind: "write"; value: string }
  | { kind: "reset" };

/** Explicit commit triggers. There is deliberately no `change` trigger. */
export type CommitTrigger = "blur" | "enter" | "reset";

/**
 * Decide what a commit trigger means.
 *
 * - `reset` always means "write empty" — the server accepts `""` and the
 *   resolver maps it to the default, which is the only way "reset to default"
 *   is reachable from the UI at all (D-5: clearing the field + blur cannot
 *   express it, because an empty draft is invalid and invalid never writes).
 * - A draft that does not parse in bounds reverts without writing (D-2).
 * - An unchanged draft writes nothing — blurring a field you only clicked
 *   into must not issue a PUT.
 */
export function resolveCommitIntent(opts: {
  trigger: CommitTrigger;
  draft: string | null;
  /** The saved value the field is displaying when there is no draft. */
  saved: string;
  parse: (value: string) => number | null;
}): CommitIntent {
  if (opts.trigger === "reset") return { kind: "reset" };
  const { draft } = opts;
  if (draft === null) return { kind: "noop" };
  if (opts.parse(draft) === null) return { kind: "revert" };
  if (draft === opts.saved) return { kind: "noop" };
  return { kind: "write", value: draft };
}

/**
 * Field text for a value read back from the server. Unset/blank/out-of-bounds
 * shows the default — the same posture `meetingSummaryTimeoutMs()` takes, so
 * the field never displays a number that is not in effect. Shared by initial
 * hydration and by the revert-after-failed-write path, which is the point:
 * both must agree or a failed save shows a value nobody asked for.
 */
export function displayValueFor(
  raw: string | null | undefined,
  fallbackSeconds: number,
  parse: (value: string | null | undefined) => number | null,
): string {
  const parsed = parse(raw);
  return String(parsed ?? fallbackSeconds);
}
