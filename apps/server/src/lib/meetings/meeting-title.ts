import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createAppLogger } from "@openstyle/utils";
import {
  type LlmSkipReason,
  type MeetingTitleSource,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { type CallUnitDeps, callUnit } from "../llm/call-unit.js";
import type { CreateModel } from "../llm/gateway.js";
import { type CallProfile, resolveCallProfile } from "../llm/model-profiles.js";
import { createLlmRecorder } from "../llm/recorder.js";
import { notifyMeetingChanged } from "../search/notify.js";
import { markdownParts } from "./folder-description.js";
import {
  buildTitleSystemPrompt,
  buildTitleUserPrompt,
} from "./workflow/prompts.js";
import { meetingTitleStepSchema } from "./workflow/schemas.js";
import {
  TITLE_ANSWER_TOKENS,
  TITLE_MAX_CHARS,
  WORKFLOW_GRAPH_VERSION,
} from "./workflow/types.js";
import { appliesSizeLimits } from "./workflow/unit.js";

// Auto title: one narrow LLM job that writes a short title from the summary
// overview. The graph node `suggestTitle` (after Summarize) and the Generate
// title button with the batch (`generateMeetingTitle`) share this module.
// The title is stored without a date: the app shows the date next to it.

const log = createAppLogger("meeting-title");

/** The longest title that the prompt asks for, in words. */
export const TITLE_MAX_WORDS = 8;
/** The overview text that goes in the prompt, at most, in characters. */
const OVERVIEW_MAX_CHARS = 1500;
/** The title sources that the AI may write over (owner decision 2). */
const AI_WRITABLE: readonly MeetingTitleSource[] = ["default", "file"];

const STEP = "suggestTitle";
const UNIT_KEY = "title";

/** On by default: only "false" turns the Auto title off. */
export function autoTitleOn(db: DatabaseSync): boolean {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(SETTINGS_KEYS.meetingAutoTitle) as { value: string } | undefined;
    return row?.value !== "false";
  } catch {
    return true;
  }
}

/** True when the AI may write the title of a meeting with this source. */
export function aiMayWriteTitle(source: string | null): boolean {
  // NULL: a row that an old build wrote after the migration. Treat it as
  // the user's, so the AI never writes over a title it cannot place.
  return source !== null && AI_WRITABLE.includes(source as MeetingTitleSource);
}

/**
 * Why the auto title step does not run, or null when it runs. Pure: the
 * graph edge and the node use it with what they read.
 */
export function titleSkipReason(input: {
  settingOn: boolean;
  source: string | null;
  overview: string;
}): LlmSkipReason | null {
  if (!input.settingOn) return "auto_title_off";
  if (!aiMayWriteTitle(input.source)) return "title_kept";
  if (!input.overview.trim()) return "no_summary";
  return null;
}

/**
 * The title to store from the model answer: one line, no surrounding quotes,
 * no trailing period, at most TITLE_MAX_CHARS. Empty when nothing is left.
 */
export function cleanTitle(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  // A model can copy the "Title:" label of its own habit.
  t = t.replace(/^title\s*:\s*/i, "");
  for (let i = 0; i < 2; i++) {
    t = t
      .replace(/^["'“”‘’«»`*]+|["'“”‘’«»`*]+$/g, "")
      .replace(/[.。]+$/u, "")
      .trim();
  }
  if (t.length <= TITLE_MAX_CHARS) return t;
  const head = t.slice(0, TITLE_MAX_CHARS);
  const space = head.lastIndexOf(" ");
  return (space > TITLE_MAX_CHARS / 2 ? head.slice(0, space) : head).trim();
}

/** The text of a stored summary that the title prompt reads. */
export function overviewOf(
  summaryJson: string | null,
  markdown: string | null,
): string {
  let overview = "";
  if (summaryJson) {
    try {
      const parsed = JSON.parse(summaryJson) as { overview?: unknown };
      if (typeof parsed.overview === "string") overview = parsed.overview;
    } catch {
      // An unreadable object falls back to the markdown.
    }
  }
  if (!overview.trim() && markdown)
    overview = markdownParts(markdown).join(" ");
  const flat = overview.replace(/\s+/g, " ").trim();
  return flat.length <= OVERVIEW_MAX_CHARS
    ? flat
    : flat.slice(0, OVERVIEW_MAX_CHARS);
}

export interface TitleInput {
  title: string | null;
  source: string | null;
  language: string | null;
  overview: string;
}

/** The meeting fields and the stored summary that the title job reads. */
export function readTitleInput(
  db: DatabaseSync,
  meetingId: string,
): TitleInput | null {
  const row = db
    .prepare(
      `SELECT m.title, m.title_source, m.language, s.summary_json, s.markdown
         FROM meetings m
         LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
        WHERE m.id = ?`,
    )
    .get(meetingId) as
    | {
        title: string | null;
        title_source: string | null;
        language: string | null;
        summary_json: string | null;
        markdown: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    title: row.title,
    source: row.title_source,
    language: row.language,
    overview: overviewOf(row.summary_json, row.markdown),
  };
}

/**
 * Write an AI title with one conditional UPDATE. Without `force`, it writes
 * only while the source is still `default` or `file`: a rename during the run
 * wins. Returns true when the row changed.
 */
export function writeAiTitle(
  db: DatabaseSync,
  meetingId: string,
  title: string,
  opts: { force: boolean },
): boolean {
  const result = opts.force
    ? db
        .prepare(
          "UPDATE meetings SET title = ?, title_source = 'ai' WHERE id = ?",
        )
        .run(title, meetingId)
    : db
        .prepare(
          `UPDATE meetings SET title = ?, title_source = 'ai'
            WHERE id = ? AND title_source IN ('default', 'file')`,
        )
        .run(title, meetingId);
  const written = Number(result.changes) > 0;
  // The title is in the meta chunk of the search index.
  if (written) notifyMeetingChanged(meetingId);
  return written;
}

/** The output budget of the title call: the answer and the reasoning share. */
export function titleMaxOutput(profile: CallProfile): number {
  const reasoningShare = profile.reasoning.countsInMaxOutput
    ? profile.reasoning.budgetTokens
    : 0;
  return Math.min(
    profile.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    TITLE_ANSWER_TOKENS + reasoningShare,
  );
}

/** The system prompt, the user prompt and the schema of one title call. */
export function titleCall(input: TitleInput, profile: CallProfile) {
  return {
    schema: meetingTitleStepSchema(appliesSizeLimits(profile), TITLE_MAX_CHARS),
    instructions: buildTitleSystemPrompt({
      language: input.language,
      maxWords: TITLE_MAX_WORDS,
    }),
    user: buildTitleUserPrompt({
      overview: input.overview,
      currentTitle: input.title,
    }),
  };
}

// ---------------------------------------------------------------------------
// Generate title (the button and the batch)
// ---------------------------------------------------------------------------

export interface GenerateTitleDeps
  extends Omit<CallUnitDeps, "recorder" | "createModel"> {
  db: DatabaseSync;
  createModel?: CreateModel;
  /** Default: the Summarize profile (task `meetingSummarize`). */
  resolveProfile?: () => Promise<CallProfile>;
  now: () => number;
}

export type GenerateTitleResult =
  | { status: "ok"; title: string; written: boolean }
  | { status: "gone" }
  | { status: "no_summary" }
  | { status: "title_kept" };

/**
 * Write an AI title for one meeting now, as a `title` run in the call record.
 * `force` (the button) writes over any title; without it (the batch) only
 * `default` and `file` titles change. Throws the typed gateway error of a
 * failed call (`ModelUnavailableError` when no model is set up).
 */
export async function generateMeetingTitle(
  meetingId: string,
  deps: GenerateTitleDeps,
  opts: { force: boolean; startedBy: "button" | "auto"; signal: AbortSignal },
): Promise<GenerateTitleResult> {
  const input = readTitleInput(deps.db, meetingId);
  if (!input) return { status: "gone" };
  if (!opts.force && !aiMayWriteTitle(input.source)) {
    return { status: "title_kept" };
  }
  if (!input.overview) return { status: "no_summary" };

  const profile = await (
    deps.resolveProfile ??
    (() =>
      resolveCallProfile({
        taskId: "meetingSummarize",
        step: STEP,
        maxReasoningTokens: 0,
      }))
  )();
  const call = titleCall(input, profile);
  const recorder = createLlmRecorder(deps.db);
  const runId = randomUUID();
  recorder.startRun({
    id: runId,
    scope: "meeting",
    scopeId: meetingId,
    kind: "title",
    startedBy: opts.startedBy,
    graphVersion: WORKFLOW_GRAPH_VERSION,
    startedAt: deps.now(),
  });
  recorder.startStep(runId, { key: UNIT_KEY, node: STEP });
  const unitDeps: CallUnitDeps = {
    recorder,
    callStructured: deps.callStructured,
    sleep: deps.sleep,
    ...(deps.createModel ? { createModel: deps.createModel } : {}),
  };
  try {
    const result = await callUnit(
      {
        step: STEP,
        runId,
        unitKey: UNIT_KEY,
        chunkIndex: null,
        schema: call.schema,
        instructions: call.instructions,
        messages: [{ role: "user", content: call.user }],
        profile,
        maxOutputTokens: titleMaxOutput(profile),
        signal: opts.signal,
      },
      { signal: opts.signal, isStopped: () => opts.signal.aborted },
      unitDeps,
    );
    const title = cleanTitle(result.object.title);
    if (!title) throw new Error("The model wrote an empty title");
    const written = writeAiTitle(deps.db, meetingId, title, {
      force: opts.force,
    });
    recorder.finishStep(runId, UNIT_KEY, "succeeded");
    recorder.finishRun(runId, "succeeded", {
      errorKind: null,
      errorDetail: null,
      result: { written },
      lostRecords: 0,
      finishedAt: deps.now(),
    });
    return { status: "ok", title, written };
  } catch (err) {
    const kind =
      typeof (err as { kind?: unknown }).kind === "string"
        ? (err as { kind: string }).kind
        : "unknown";
    recorder.finishStep(runId, UNIT_KEY, "failed", {
      kind,
      detail: String(err),
    });
    recorder.finishRun(runId, "failed", {
      errorKind: kind,
      errorDetail: String(err),
      result: null,
      lostRecords: 0,
      finishedAt: deps.now(),
    });
    log.warn(`meeting ${meetingId}: title failed (${kind})`);
    throw err;
  }
}
