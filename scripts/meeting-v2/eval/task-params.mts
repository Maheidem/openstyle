// --task-params for eval.mts: a custom profile for the two meeting tasks of the
// arm model, set the way the Models page sets it (the llm_task_assignments
// setting; the server then writes the link of the model, llm_profile_links).

export const TASK_PARAMS_TASKS = [
  "meetingEnhance",
  "meetingSummarize",
] as const;

/** Parse the flag value: a JSON object, not empty. Throws a usage message. */
export function parseTaskParams(raw: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("--task-params must be a JSON object");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error("--task-params must be a JSON object");
  if (Object.keys(v).length === 0)
    throw new Error("--task-params must not be empty");
  return v as Record<string, unknown>;
}

/** The value of the llm_task_assignments setting for the two meeting tasks. */
export function taskAssignmentsValue(params: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      TASK_PARAMS_TASKS.map((t) => [t, { mode: "custom", params }]),
    ),
  );
}

/**
 * Check the stored llm_profile_links of the arm DB: the model has a custom link
 * with exactly these params for each task, and no other task has a link.
 * Returns an error text, or null when it matches.
 */
export function checkTaskLinks(
  storedLinks: string | undefined,
  modelKey: string,
  params: Record<string, unknown>,
): string | null {
  let links: Record<
    string,
    Record<string, { mode?: string; params?: unknown }>
  >;
  try {
    links = JSON.parse(storedLinks ?? "");
  } catch {
    return "llm_profile_links is not stored";
  }
  const slot = links?.[modelKey];
  if (!slot) return `no link for ${modelKey}`;
  for (const t of TASK_PARAMS_TASKS) {
    const l = slot[t];
    if (
      l?.mode !== "custom" ||
      JSON.stringify(l.params) !== JSON.stringify(params)
    )
      return `link of ${t} differs from --task-params`;
  }
  const extra = Object.keys(slot).filter(
    (t) => !(TASK_PARAMS_TASKS as readonly string[]).includes(t),
  );
  return extra.length ? `unexpected link for ${extra.join(", ")}` : null;
}
