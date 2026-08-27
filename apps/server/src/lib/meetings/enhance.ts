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
  /** Distinct labels for which a name suggestion was persisted this run
   *  (specs/meeting-speaker-naming.md §5.3). */
  speakerSuggestions: number;
}

interface EnhanceSegment {
  id: string;
  speaker: string;
  text: string;
  /** Structured diarization label, kept alongside the formatted `speaker`
   *  display string (specs/meeting-speaker-naming.md §5.1/§5.3) — reading
   *  the label count for the maxOutputTokens bump below, or the phantom-
   *  label allowlist, must never re-parse `speaker`'s formatted text: once
   *  a speaker has a confirmed name, `speaker` renders as e.g. "Ana", not
   *  "Them 3". Undefined for "Me" segments and undiarized "Them" segments. */
  speakerLabel?: string;
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
  resolveDefaultChatCall({ ...request, taskId: "meetingEnhance" });

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
  meetingTitle: string | undefined,
  meetingContext: string | undefined,
  options: EnhanceMeetingOptions = {},
): Promise<EnhanceMeetingResult> {
  const llmCall = options.llmCall ?? defaultLlmCall;
  const contextBudgetTokens =
    options.contextBudgetTokens ?? DEFAULT_ENHANCE_CONTEXT_BUDGET_TOKENS;

  // Prerequisite fix (specs/meeting-speaker-naming.md §5.1): the transcript
  // the model actually sees must distinguish `Them 1` from `Them 2` — bare
  // `s.speaker` ("Me"/"Them") gives it no way to tell speakers apart at
  // all. Prefer a confirmed `speakerName` over the numbered fallback (free
  // improvement to correction quality for already-named meetings, not just
  // an enabler for naming); a "Them" segment with no `speakerLabel` at all
  // stays plain "Them" here — the "Unidentified" rendering fallback is a
  // *display* concept (§3.3/§4), not something the LLM's own transcript
  // view needs.
  const withIds: EnhanceSegment[] = segments
    .filter((s) => Boolean(s.id) && s.text.trim().length > 0)
    .map((s) => ({
      id: s.id as string,
      speaker:
        s.speaker === "Them"
          ? (s.speakerName ??
            (s.speakerLabel ? `Them ${s.speakerLabel}` : "Them"))
          : s.speaker,
      text: s.text,
      ...(s.speaker === "Them" && s.speakerLabel
        ? { speakerLabel: s.speakerLabel }
        : {}),
    }));
  if (withIds.length === 0) return { correctedCount: 0, speakerSuggestions: 0 };

  // Real label set for the naming prompt/parse (§5.3): derived from the
  // structured `speakerLabel` field, never by re-parsing `withIds[].speaker`
  // — once a speaker is named, that string renders as e.g. "Ana", not
  // "Them 3", so a `Them (\d+)` regex would silently drop them from both
  // the prompt's label list and the phantom-label allowlist, and would
  // falsely match a user who happened to name someone literally "Them 5".
  const speakerLabels = [
    ...new Set(
      segments
        .filter(
          (s) =>
            s.speaker === "Them" && s.speakerLabel && s.id && s.text.trim(),
        )
        .map((s) => s.speakerLabel as string),
    ),
  ];

  const system = buildEnhanceSystemPrompt(
    language,
    vocabTerms,
    speakerLabels,
    meetingTitle,
    meetingContext,
  );
  const chunks = chunkForEnhance(withIds, contextBudgetTokens);
  const corrections = new Map<string, string>();
  const nameProposals = new Map<
    string,
    { name: string; evidence: string; chunkIndex: number }
  >();

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const chunkTokens = chunk.reduce((sum, s) => sum + lineTokensOf(s), 0);
    // Worst case, correcting every segment in the chunk echoes back roughly
    // the chunk's own size (id/speaker overhead included) — size the output
    // budget off that, not a fixed constant, or a large chunk's response
    // gets truncated mid-JSON and becomes unparseable. Speaker suggestions
    // add a small amount to a chunk's expected output (a handful of
    // {name, evidence} pairs) — bumped by a per-chunk-distinct-label term
    // (specs/meeting-speaker-naming.md §12; llm-task-profiles.md §8.2 lists
    // this line as otherwise unchanged by that spec's own work).
    const speakerLabelsInChunk = new Set(
      chunk.filter((s) => s.speakerLabel).map((s) => s.speakerLabel as string),
    ).size;
    const maxOutputTokens =
      Math.ceil(chunkTokens * 1.3) + 200 + 60 * speakerLabelsInChunk;

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

    // Speaker name suggestions (specs/meeting-speaker-naming.md §5.3): a
    // top-level "speakers" key alongside the text corrections above — the
    // existing correction loop is unaffected by construction, since its
    // value is an object, not a string, and `typeof text !== "string"`
    // already skips it.
    if (speakerLabels.length > 0) {
      const block = parsed.speakers;
      if (block && typeof block === "object" && !Array.isArray(block)) {
        for (const [label, entry] of Object.entries(
          block as Record<string, unknown>,
        )) {
          if (!speakerLabels.includes(label)) continue; // phantom label
          if (!entry || typeof entry !== "object") continue;
          const name = (entry as Record<string, unknown>).name;
          if (typeof name !== "string" || !name.trim()) continue;
          const cleanName = name.trim().slice(0, 80);
          const evidenceRaw = (entry as Record<string, unknown>).evidence;
          const cleanEvidence =
            typeof evidenceRaw === "string"
              ? evidenceRaw.trim().slice(0, 240)
              : "";
          const existing = nameProposals.get(label);
          if (!existing) {
            nameProposals.set(label, {
              name: cleanName,
              evidence: cleanEvidence,
              chunkIndex,
            });
          } else if (existing.name.toLowerCase() !== cleanName.toLowerCase()) {
            // Cross-chunk conflict on the same label — earlier chunk wins,
            // deterministic, no scoring heuristic (same "stable, no
            // randomness" posture as meeting-diarization.md §7's tie-break
            // rule).
            log.debug(
              `meeting ${meetingId}: chunk ${chunkIndex} suggested "${cleanName}" for Them ${label}, keeping chunk ${existing.chunkIndex}'s "${existing.name}"`,
            );
          }
          // Same name from a later chunk: no-op — already recorded.
        }
      } else if (block !== undefined) {
        log.debug(
          `meeting ${meetingId}: chunk ${chunkIndex}'s 'speakers' block was malformed, ignoring`,
        );
      }
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

  // Persisted in a separate BEGIN/COMMIT block from the corrections above —
  // a name-suggestion write failure must never roll back already-committed
  // text corrections or vice versa (independent failure domains).
  if (nameProposals.size > 0) {
    const db = getDb();
    const now = Date.now();
    const upsert = db.prepare(`
      INSERT INTO meeting_speakers
        (meeting_id, speaker_label, suggested_name, suggested_evidence, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET
        suggested_name = excluded.suggested_name,
        suggested_evidence = excluded.suggested_evidence,
        updated_at = excluded.updated_at
    `);
    db.exec("BEGIN");
    try {
      for (const [label, p] of nameProposals) {
        upsert.run(meetingId, label, p.name, p.evidence, now);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    correctedCount: corrections.size,
    speakerSuggestions: nameProposals.size,
  };
}
