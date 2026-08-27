/**
 * Meeting Enhance: an LLM cleanup pass over a completed meeting transcript
 * (specs/meeting-transcription-quality.md §6). Not Meetily's "enhance" —
 * this is the LLM correction pass dictation already has
 * (`routes/transcribe.ts`'s `postProcess`) and meetings were missing.
 *
 * Strict JSON contract: the model returns only the segments it corrected,
 * keyed by the stable `meeting_segments.id`; `text` is never touched —
 * `enhanced_text` is a separate column, so the raw ASR output is never
 * destroyed. Long transcripts map (not map-reduce) over whole-segment
 * chunks: each chunk's segment ids are disjoint by construction, so
 * per-chunk corrections need no combining step. A parse failure, or a call
 * failure, on one chunk is logged and skipped — never fatal to the rest;
 * every segment the pass couldn't safely correct keeps its raw `text` as
 * authoritative.
 */

import { createAppLogger } from "@openstyle/utils";
import { getDb } from "../db.js";
import {
  buildEnhanceSystemPrompt,
  buildEnhanceUserPrompt,
  formatEnhanceLine,
} from "./enhance-prompt.js";
import { estimateTokens, resolveDefaultChatCall } from "./llm-call.js";
import type { MergedSegment } from "./merge.js";

const log = createAppLogger("meeting-enhance");

/**
 * Auto-run-after-transcribe setting (specs/meeting-transcription-quality.md
 * §6.5). Mirrors `getMeetingDiarizationEnabledSetting()`
 * (`diarize.ts`) exactly — the existing flat settings pattern. Default off:
 * an explicit opt-in until real usage shows the extra LLM call per meeting
 * is worth defaulting on.
 */
export function getMeetingEnhanceAutoRunSetting(): boolean {
  const row = getDb()
    .prepare(
      "SELECT value FROM settings WHERE key = 'meeting_enhance_auto_run'",
    )
    .get() as { value: string } | undefined;
  return row?.value === "true";
}

/** Conservative default transcript-context budget (tokens) per chunk. */
export const DEFAULT_ENHANCE_CONTEXT_BUDGET_TOKENS = 6000;

/** One LLM request issued by the enhancer. */
export interface EnhanceLlmRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
}

/** What an enhance LLM call must return. */
export interface EnhanceLlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Injectable LLM dependency; the default resolves the app's default model. */
export type EnhanceLlmCall = (
  request: EnhanceLlmRequest,
) => Promise<EnhanceLlmResponse>;

export interface EnhanceMeetingOptions {
  /** Transcript token budget per chunk/LLM call. */
  contextBudgetTokens?: number;
  /** Override the LLM call (tests, alternate backends). */
  llmCall?: EnhanceLlmCall;
}

export interface EnhanceMeetingResult {
  correctedCount: number;
}

interface EnhanceSegment {
  id: string;
  speaker: string;
  text: string;
}

function lineTokensOf(s: EnhanceSegment): number {
  return estimateTokens(formatEnhanceLine(s.id, s.speaker, s.text)) + 1; // +1 for the newline
}

/**
 * Split id-bearing segments into whole-segment chunks bounded by
 * `budgetTokens` (a single oversized segment still becomes its own chunk).
 * Unlike `chunkTranscript` (`summarize.ts`), no overlap is carried between
 * chunks — corrections don't need cross-chunk continuity the way
 * summarization does, and carrying one would make a chunk's ids no longer
 * disjoint, breaking the per-chunk `validIds` guard below.
 */
export function chunkForEnhance(
  segments: EnhanceSegment[],
  budgetTokens: number,
): EnhanceSegment[][] {
  const chunks: EnhanceSegment[][] = [];
  let start = 0;
  while (start < segments.length) {
    let used = 0;
    let end = start;
    while (
      end < segments.length &&
      (end === start || used + lineTokensOf(segments[end]) <= budgetTokens)
    ) {
      used += lineTokensOf(segments[end]);
      end++;
    }
    chunks.push(segments.slice(start, end));
    start = end;
  }
  return chunks;
}

function formatChunk(chunk: EnhanceSegment[]): string {
  return chunk
    .map((s) => formatEnhanceLine(s.id, s.speaker, s.text))
    .join("\n");
}

/**
 * Extract a JSON object from a raw LLM response that may wrap it in a
 * markdown code fence or prepend/append prose — real local models routinely
 * do both. Returns `null` (never throws) when no object-shaped substring
 * can be found or parsed, so the caller's per-chunk skip logic handles a
 * malformed response and an unparseable one identically.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Thin wrapper around the shared default chat call (`llm-call.ts`). */
const defaultLlmCall: EnhanceLlmCall = (request) =>
  resolveDefaultChatCall(request);

/**
 * Run the Enhance pass over a meeting's merged transcript and persist
 * corrections to `meeting_segments.enhanced_text`. Only ever `UPDATE`s
 * existing rows by id — never `DELETE`s/`INSERT`s — so a failure mid-pass
 * can't corrupt `text` or a previous Enhance run's corrections.
 */
export async function enhanceMeetingTranscript(
  meetingId: string,
  segments: MergedSegment[],
  language: string | undefined,
  vocabTerms: string[],
  options: EnhanceMeetingOptions = {},
): Promise<EnhanceMeetingResult> {
  const llmCall = options.llmCall ?? defaultLlmCall;
  const contextBudgetTokens =
    options.contextBudgetTokens ?? DEFAULT_ENHANCE_CONTEXT_BUDGET_TOKENS;

  const withIds: EnhanceSegment[] = segments
    .filter((s) => Boolean(s.id) && s.text.trim().length > 0)
    .map((s) => ({ id: s.id as string, speaker: s.speaker, text: s.text }));
  if (withIds.length === 0) return { correctedCount: 0 };

  const system = buildEnhanceSystemPrompt(language, vocabTerms);
  const chunks = chunkForEnhance(withIds, contextBudgetTokens);
  const corrections = new Map<string, string>();

  for (const chunk of chunks) {
    const chunkTokens = chunk.reduce((sum, s) => sum + lineTokensOf(s), 0);
    // Worst case, correcting every segment in the chunk echoes back roughly
    // the chunk's own size (id/speaker overhead included) — size the output
    // budget off that, not a fixed constant, or a large chunk's response
    // gets truncated mid-JSON and becomes unparseable.
    const maxOutputTokens = Math.ceil(chunkTokens * 1.3) + 200;

    let raw: string;
    try {
      raw = (
        await llmCall({
          system,
          prompt: buildEnhanceUserPrompt(formatChunk(chunk)),
          maxOutputTokens,
        })
      ).text;
    } catch (err) {
      log.warn(
        `meeting ${meetingId}: enhance chunk call failed, skipping: ${String(err)}`,
      );
      continue;
    }

    const parsed = extractJsonObject(raw);
    if (parsed === null) {
      log.warn(`meeting ${meetingId}: enhance chunk parse failed, skipping`);
      continue;
    }
    const originalById = new Map(chunk.map((s) => [s.id, s]));
    for (const [id, text] of Object.entries(parsed)) {
      const original = originalById.get(id);
      if (!original || typeof text !== "string") continue;
      let trimmed = text.trim();
      // Real local models sometimes echo the "[id] Speaker:" line-format
      // prefix (formatEnhanceLine, enhance-prompt.ts) from the input back
      // into the corrected-text value, even though the contract only asks
      // for the segment's text — verified against meeting 9df09e73
      // (specs/meeting-transcription-quality.md real E2E). Strip it
      // defensively, mirroring isVocabLeak's boilerplate-prefix strip
      // (merge.ts), rather than persisting a doubled-up speaker label.
      const labelPrefix = `${original.speaker}: `;
      if (trimmed.startsWith(labelPrefix)) {
        trimmed = trimmed.slice(labelPrefix.length).trim();
      }
      if (!trimmed) continue;
      // Real local models also don't always honor "omit unchanged
      // segments" — verified in the same real run, where ~7% of
      // "corrections" echoed the original text byte-for-byte. Storing
      // those would inflate correctedCount and mark an untouched segment
      // "enhanced" for no reason, since the raw/enhanced toggle would
      // render identical text either way.
      if (trimmed === original.text.trim()) continue;
      corrections.set(id, trimmed);
    }
  }

  if (corrections.size > 0) {
    const db = getDb();
    const update = db.prepare(
      "UPDATE meeting_segments SET enhanced_text = ? WHERE id = ?",
    );
    // node:sqlite's DatabaseSync has no `.transaction()` helper (see
    // vocabulary.ts's importVocabularyEntries for the same pattern) —
    // explicit BEGIN/COMMIT/ROLLBACK.
    db.exec("BEGIN");
    try {
      for (const [id, text] of corrections) update.run(text, id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return { correctedCount: corrections.size };
}
