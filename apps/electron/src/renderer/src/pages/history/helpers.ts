/**
 * Clock time of `date` in the given app language. The language decides the
 * 12/24 hour style. The history rows and the tray popover use it.
 */
export function formatTimeOfDay(date: Date | number, lang?: string): string {
  return new Date(date)
    .toLocaleTimeString(lang, {
      hour: "numeric",
      minute: "2-digit",
    })
    .toLowerCase();
}

/** Clock time of a server timestamp (UTC, no zone suffix). */
export function formatClock(iso: string, lang?: string): string {
  return formatTimeOfDay(new Date(`${iso}Z`), lang);
}

export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function shortModel(model: string | null | undefined): string {
  if (!model) return "";
  return model.includes("/") ? (model.split("/").pop() ?? "") : model;
}

/** Model id prefixes of the built-in local models (MLX speech and MLX LLM). */
const BUILTIN_MODEL_PREFIXES = ["local-mlx/", "local-mlx-llm/"];

/**
 * The label of a history model id. A built-in id shows its catalog name
 * ("Qwen3 Fast", "Gemma 4 E2B") from `names` (model id to model name). Any
 * other id, and a built-in id that `names` does not have yet, shows
 * `shortModel`.
 */
export function resolveModelLabel(
  model: string | null | undefined,
  names: ReadonlyMap<string, string>,
): string {
  if (!model) return "";
  if (BUILTIN_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) {
    const name = names.get(model);
    if (name) return name;
  }
  return shortModel(model);
}

export function formatCost(cost: number): string {
  if (cost === 0) return "$0.000";
  if (cost < 0.001) return "<$0.001";
  return `$${cost.toFixed(3)}`;
}

export function getLocalDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(value: string): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

export function formatRangeDate(
  value: string,
  placeholder: string,
  lang?: string,
): string {
  if (!value) return placeholder;
  const date = parseLocalDate(value);
  if (!date) return placeholder;
  const day = date.getDate();
  const month = date.toLocaleDateString(lang, { month: "short" });
  const year = date.getFullYear();
  return `${day} ${month}, ${year}`;
}

export function formatRangeLabel(
  start: string,
  end: string,
  placeholder: string,
  lang?: string,
): string {
  return `${formatRangeDate(start, placeholder, lang)} - ${formatRangeDate(end, placeholder, lang)}`;
}

/** Get a date key for grouping: "Today", "Yesterday", or "Day, Mon DD" */
export function getDateGroup(iso: string, lang?: string): string {
  const d = new Date(`${iso}Z`);
  const now = new Date();
  const entryDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Both dates are local midnights. A clock change makes a day 23 or 25 hours, so round.
  const diffDays = Math.round(
    (today.getTime() - entryDate.getTime()) / 86400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(lang, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
