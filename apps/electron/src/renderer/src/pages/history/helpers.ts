export function formatClock(iso: string): string {
  return new Date(`${iso}Z`)
    .toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toLowerCase();
}

export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function shortModel(model: string | null | undefined): string {
  if (!model) return "";
  return model.includes("/") ? (model.split("/").pop() ?? "") : model;
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

export function formatRangeDate(value: string): string {
  if (!value) return "Select";
  const date = parseLocalDate(value);
  if (!date) return "Select";
  const day = date.getDate();
  const month = date.toLocaleDateString(undefined, { month: "short" });
  const year = date.getFullYear();
  return `${day} ${month}, ${year}`;
}

export function formatRangeLabel(start: string, end: string): string {
  return `${formatRangeDate(start)} - ${formatRangeDate(end)}`;
}

/** Get a date key for grouping: "Today", "Yesterday", or "Day, Mon DD" */
export function getDateGroup(iso: string): string {
  const d = new Date(`${iso}Z`);
  const now = new Date();
  const entryDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor(
    (today.getTime() - entryDate.getTime()) / 86400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
