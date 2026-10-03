// Locale-aware number formatting.
//
// Passing "default" as the locale makes Intl.NumberFormat follow the user's
// OS/system locale, so grouping matches what the user expects — e.g. an Indian
// locale renders 1234567 as "12,34,567" while a US locale renders "1,234,567".

// Intl.NumberFormat construction is relatively expensive, so cache instances by
// the (locale, options) pair. "default" resolves to the system locale at
// construction time.
const cache = new Map<string, Intl.NumberFormat>();

function getFormatter(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = options ? JSON.stringify(options) : "";
  let formatter = cache.get(key);

  if (!formatter) {
    formatter = new Intl.NumberFormat("default", options);
    cache.set(key, formatter);
  }

  return formatter;
}

/** Format a number using the user's OS/system locale (grouping, digits, etc.). */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return getFormatter(options).format(value);
}

/** Locale-neutral clock format (h:)mm:ss. Rounds to the nearest second. */
export function formatClockDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "0:00";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Short local date and time, for example "Oct 3, 2:15 PM". Empty for no value. */
export function formatTimestamp(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Minutes and seconds as m:ss. Rounds down to the second. */
export function formatClockMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
