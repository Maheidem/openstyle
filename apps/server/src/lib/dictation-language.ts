// The language of each saved dictation, for the per-language stats of the
// Transcriptions page (issue #443). Order of the sources:
//   1. the hotkey pin, 2. the language that the ASR detected (both written by
//   the save, lib/history-store.ts), 3. a tinyld text check, 4. an LLM check
//   when the text check is unsure.
// Steps 3 and 4 run here, in one background job, after the row is saved, so
// a dictation result never waits for them. The same job is the backfill of
// old rows: it takes every row that has no result yet, so it is resumable
// and has nothing to do after it ran once.
//
// Stored values of `transcription_history.language` (schema v60):
//   ISO-639-1 code or "mixed": the result.
//   ""  : checked, not known. The stats show it as Unknown.
//   "?" : the text check was unsure. The LLM check is next.
//   NULL: not checked yet.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createAppLogger } from "@openstyle/utils";
import { z } from "zod";
import { getDb, withTransaction } from "./db.js";
import { getLanguagesSetting, ISO_LANGUAGE_NAMES } from "./language.js";
import { type CallUnitDeps, callUnit } from "./llm/call-unit.js";
import {
  type CreateModel,
  callStructured,
  type StepSchema,
} from "./llm/gateway.js";
import { type CallProfile, resolveCallProfile } from "./llm/model-profiles.js";
import { createLlmRecorder } from "./llm/recorder.js";
import type { DetectAllFn } from "./meetings/language.js";

const log = createAppLogger("dictation-language");

export const LANGUAGE_MIXED = "mixed";
export const LANGUAGE_UNKNOWN = "";
export const LANGUAGE_PENDING_LLM = "?";

/** A text with fewer words than this is too short for the text check. */
export const MIN_WORDS = 3;
/**
 * The top set language must have at least this many times the score of the
 * next set language. tinyld scores are not normalized, so a ratio is used.
 */
export const MIN_LEAD_RATIO = 2;
/** The LLM reads at most this many characters of the text. */
const LLM_TEXT_MAX_CHARS = 1000;
/** Rows read per text-check batch. */
const TEXT_BATCH = 500;

const STEP = "dictationLanguage";

/** The retry wait of `callUnit`. Rejects when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
const UNIT_KEY = "language";

export interface TextCheck {
  /** The ISO code, or null when the check is unsure. */
  language: string | null;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * The tinyld check (step 3). `languages` is the user's set; an empty set
 * means auto-detect, and then every tinyld language counts. Unsure (null):
 *   - fewer than MIN_WORDS words;
 *   - no candidate from the set;
 *   - a second set language with more than 1/MIN_LEAD_RATIO of the top score.
 */
export function checkTextLanguage(
  text: string,
  languages: string[],
  detectAll: DetectAllFn,
): TextCheck {
  if (wordCount(text) < MIN_WORDS) return { language: null };
  const ranked = detectAll(text)
    .filter((c) => c.accuracy > 0)
    .filter((c) => languages.length === 0 || languages.includes(c.lang));
  const [top, second] = ranked;
  if (!top) return { language: null };
  if (second && second.accuracy * MIN_LEAD_RATIO > top.accuracy) {
    return { language: null };
  }
  return { language: top.lang };
}

/**
 * The language that the save can write at once (steps 1 and 2): the pin,
 * else the ASR language. null: the background check decides.
 */
export function knownLanguage(input: {
  pin?: string | null;
  asr?: string | null;
}): string | null {
  return input.pin || input.asr || null;
}

// ---------------------------------------------------------------------------
// The LLM check (step 4)
// ---------------------------------------------------------------------------

export type LlmLanguageAnswer = { language: string };

/** One of the set codes, "mixed" or "unknown". Any code with an empty set. */
export function languageStepSchema(
  languages: string[],
): StepSchema<LlmLanguageAnswer> {
  const answer =
    languages.length > 0
      ? z.enum(
          languages.concat(LANGUAGE_MIXED, "unknown") as [string, ...string[]],
        )
      : z.string();
  return {
    name: "dictation_language",
    version: 1,
    zod: z.object({ language: answer }),
  };
}

function nameOf(code: string): string {
  return ISO_LANGUAGE_NAMES[code] ?? code;
}

export function buildLanguageSystemPrompt(languages: string[]): string {
  const choices =
    languages.length > 0
      ? languages.map((c) => `"${c}" (${nameOf(c)})`).join(", ")
      : 'the ISO-639-1 code of the language (for example "en")';
  return [
    "You name the language of one dictated text.",
    `Answer with one value: ${choices}, "mixed" or "unknown".`,
    'Answer "mixed" only when full sentences or clauses are in two or more languages.',
    "Names, product names, code words and borrowed technical words do not make a text mixed.",
    'Answer "unknown" when the text is in no listed language or you cannot tell.',
  ].join("\n");
}

/** The value to store from the LLM answer. */
export function storedFromAnswer(answer: string, languages: string[]): string {
  const a = answer.trim().toLowerCase();
  if (a === LANGUAGE_MIXED) return LANGUAGE_MIXED;
  if (languages.length > 0) {
    return languages.includes(a) ? a : LANGUAGE_UNKNOWN;
  }
  return /^[a-z]{2}$/.test(a) ? a : LANGUAGE_UNKNOWN;
}

export interface LanguageCheckDeps {
  db?: DatabaseSync;
  detectAll?: DetectAllFn;
  callStructured?: CallUnitDeps["callStructured"];
  createModel?: CreateModel;
  /** Default: the user's one model, through the Summarize task. */
  resolveProfile?: () => Promise<CallProfile>;
  sleep?: CallUnitDeps["sleep"];
  now?: () => number;
}

async function askLlm(
  db: DatabaseSync,
  rowId: number,
  text: string,
  languages: string[],
  profile: CallProfile,
  deps: LanguageCheckDeps,
): Promise<string> {
  const now = deps.now ?? Date.now;
  const recorder = createLlmRecorder(db);
  const runId = randomUUID();
  recorder.startRun({
    id: runId,
    scope: "dictation",
    scopeId: String(rowId),
    kind: "dictationLanguage",
    startedBy: "auto",
    graphVersion: 1,
    startedAt: now(),
  });
  recorder.startStep(runId, { key: UNIT_KEY, node: STEP });
  const signal = new AbortController().signal;
  try {
    const result = await callUnit(
      {
        step: STEP,
        runId,
        unitKey: UNIT_KEY,
        chunkIndex: null,
        schema: languageStepSchema(languages),
        instructions: buildLanguageSystemPrompt(languages),
        messages: [
          { role: "user", content: text.slice(0, LLM_TEXT_MAX_CHARS) },
        ],
        profile,
        maxOutputTokens: Math.min(profile.maxOutputTokens ?? 64, 64),
        signal,
      },
      { signal, isStopped: () => false },
      {
        recorder,
        callStructured: deps.callStructured ?? callStructured,
        sleep: deps.sleep ?? sleep,
        ...(deps.createModel ? { createModel: deps.createModel } : {}),
      },
    );
    const stored = storedFromAnswer(result.object.language, languages);
    recorder.finishStep(runId, UNIT_KEY, "succeeded");
    recorder.finishRun(runId, "succeeded", {
      errorKind: null,
      errorDetail: null,
      result: { language: stored },
      lostRecords: 0,
      finishedAt: now(),
    });
    return stored;
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
      finishedAt: now(),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The background job
// ---------------------------------------------------------------------------

export interface LanguageCheckCounts {
  /** Rows that the text check decided. */
  text: number;
  /** Rows that the text check sent to the LLM check. */
  unsure: number;
  /** Rows that the LLM check decided (a language or "mixed"). */
  llm: number;
  /** Rows that ended as unknown. */
  unknown: number;
}

interface TodoRow {
  id: number;
  raw_text: string;
  cleaned_text: string | null;
}

function textOf(row: TodoRow): string {
  return row.cleaned_text ?? row.raw_text;
}

/**
 * One pass of the job: the text check of every NULL row, then the LLM check
 * of every "?" row, one at a time. Each row is written when it is done, so a
 * stop at any point loses no work.
 */
export async function runLanguageCheck(
  deps: LanguageCheckDeps = {},
): Promise<LanguageCheckCounts> {
  const db = deps.db ?? getDb();
  const languages = getLanguagesSetting();
  const counts: LanguageCheckCounts = {
    text: 0,
    unsure: 0,
    llm: 0,
    unknown: 0,
  };
  const update = db.prepare(
    "UPDATE transcription_history SET language = ? WHERE id = ?",
  );

  const selectNull = db.prepare(
    `SELECT id, raw_text, cleaned_text FROM transcription_history
      WHERE language IS NULL ORDER BY id LIMIT ?`,
  );
  let detectAll = deps.detectAll;
  for (;;) {
    const rows = selectNull.all(TEXT_BATCH) as unknown as TodoRow[];
    if (rows.length === 0) break;
    detectAll ??= (await import("tinyld")).detectAll;
    const detect = detectAll;
    withTransaction(db, () => {
      for (const row of rows) {
        const { language } = checkTextLanguage(textOf(row), languages, detect);
        update.run(language ?? LANGUAGE_PENDING_LLM, row.id);
        if (language) counts.text += 1;
        else counts.unsure += 1;
      }
    });
    // Give the event loop a turn between batches.
    await new Promise((r) => setImmediate(r));
  }

  const selectPending = db.prepare(
    `SELECT id, raw_text, cleaned_text FROM transcription_history
      WHERE language = '${LANGUAGE_PENDING_LLM}' ORDER BY id DESC LIMIT 1`,
  );
  let profile: CallProfile | null = null;
  for (;;) {
    const row = selectPending.get() as unknown as TodoRow | undefined;
    if (!row) break;
    if (!profile) {
      try {
        profile = await (
          deps.resolveProfile ??
          (() =>
            resolveCallProfile({
              // The user's one model (one model per user). The Summarize
              // task is the same choice as the meeting title and the
              // folder description.
              taskId: "meetingSummarize",
              step: STEP,
              maxReasoningTokens: 0,
            }))
        )();
      } catch (err) {
        // No LLM: every unsure row stays unknown.
        const n = Number(
          db
            .prepare(
              `UPDATE transcription_history SET language = '${LANGUAGE_UNKNOWN}'
                WHERE language = '${LANGUAGE_PENDING_LLM}'`,
            )
            .run().changes,
        );
        counts.unknown += n;
        log.info(
          `no LLM for the language check (${String(err)}): ${n} rows unknown`,
        );
        break;
      }
    }
    let stored = LANGUAGE_UNKNOWN;
    try {
      stored = await askLlm(db, row.id, textOf(row), languages, profile, deps);
    } catch (err) {
      log.warn(`row ${row.id}: LLM language check failed: ${String(err)}`);
    }
    update.run(stored, row.id);
    if (stored === LANGUAGE_UNKNOWN) counts.unknown += 1;
    else counts.llm += 1;
  }

  if (counts.text + counts.unsure + counts.llm + counts.unknown > 0) {
    log.info(
      `language check: text ${counts.text}, unsure ${counts.unsure}, llm ${counts.llm}, unknown ${counts.unknown}`,
    );
  }
  return counts;
}

let started = false;
let running = false;
let again = false;
let jobDeps: LanguageCheckDeps = {};

function kick(): void {
  if (running) {
    again = true;
    return;
  }
  running = true;
  void (async () => {
    try {
      do {
        again = false;
        await runLanguageCheck(jobDeps);
      } while (again);
    } catch (err) {
      log.warn(`language check stopped: ${String(err)}`);
    } finally {
      running = false;
    }
  })();
}

/**
 * Start the job at server start (it does not block the start). The first
 * pass is the backfill of old rows.
 */
export function startDictationLanguageCheck(
  deps: LanguageCheckDeps = {},
): void {
  started = true;
  jobDeps = deps;
  kick();
}

/** Run the job again for a new row. A no-op before the server started it. */
export function kickDictationLanguageCheck(): void {
  if (started) kick();
}
