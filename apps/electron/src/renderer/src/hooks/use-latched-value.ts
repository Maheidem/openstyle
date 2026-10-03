import { useEffect, useState } from "react";

/**
 * Holds the last non-null `value` for `ms` after it turns null. A card that
 * animates out can then keep its old content until the exit finishes. The
 * latch updates during render, so the new value shows on the same frame.
 */
export function useLatchedValue<T>(value: T | null, ms: number): T | null {
  const [latched, setLatched] = useState<T | null>(null);
  if (value && value !== latched) setLatched(value);
  useEffect(() => {
    if (value || !latched) return;
    const timer = setTimeout(() => setLatched(null), ms);
    return () => clearTimeout(timer);
  }, [value, latched, ms]);
  return latched;
}
