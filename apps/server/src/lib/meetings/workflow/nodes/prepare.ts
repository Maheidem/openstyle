import {
  parseMeetingSummaryContextBudget,
  parseMeetingSummaryInstructions,
} from "@openstyle/validations";
import {
  type ResolvedModels,
  resolveModels,
} from "../../../llm/model-profiles.js";
import { loadVocabularyTerms } from "../../../vocabulary.js";
import { hashVariantOf, inputHash, loadHashRows } from "../../input-hash.js";
import { speakerDisplayLabel } from "../../merge.js";
import { type MeetingRow, parseAttendees } from "../../store.js";
import { chunkForEnhance, estimateTokens } from "../chunking.js";
import type { WorkflowDeps } from "../context.js";
import { buildCorrectSystemPrompt } from "../prompts.js";
import type { WorkflowStateType } from "../state.js";
import {
  CHUNK_TOKENS_MAX,
  CORRECT_ANSWER_FACTOR,
  CORRECT_ANSWER_FIXED,
  IDENTIFY_REASONING_MAX,
  type NodeStatus,
  type PreparedMeeting,
  type PreparedSegment,
  PrepareFailure,
  SAFETY_TOKENS,
} from "../types.js";
import { guardNode } from "../unit.js";

// Node `prepare` (specs/meeting-enhance-agentic.md 4.1). Code only, no LLM
// call. It loads the meeting once, builds every later input, and fixes the
// model of each LLM node for the run.

function readSettingFrom(deps: WorkflowDeps, key: string): string | undefined {
  try {
    const row = deps.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

/** P6: the chunk size from the correctChunk profile. */
function chunkSizeFor(
  contextWindow: number | null,
  systemTokens: number,
): number {
  if (contextWindow === null) return CHUNK_TOKENS_MAX;
  const fit = Math.floor(
    (contextWindow - systemTokens - SAFETY_TOKENS - CORRECT_ANSWER_FIXED) /
      (1 + CORRECT_ANSWER_FACTOR),
  );
  return Math.max(1, Math.min(CHUNK_TOKENS_MAX, fit));
}

export function makePrepareNode(deps: WorkflowDeps) {
  const guarded = guardNode<
    WorkflowStateType,
    { prepared: PreparedMeeting; models: ResolvedModels }
  >(
    deps,
    {
      id: "prepare",
      stepKey: () => "prepare",
      failed: null,
      outcome: () => ({ status: "ok" as NodeStatus, failure: null }),
    },
    async (state, ctx) => {
      const row = deps.db
        .prepare("SELECT * FROM meetings WHERE id = ?")
        .get(state.meetingId) as MeetingRow | undefined;
      if (!row) {
        throw new PrepareFailure("internal", "The meeting row is gone.");
      }

      // P1, P2: the loader and the hash read one database state, in one
      // synchronous block (P11).
      const merged = deps
        .loadTranscript(state.meetingId, row.audio_dir, deps.db)
        .filter((s) => Boolean(s.id) && s.text.trim().length > 0);
      const hash = inputHash(
        loadHashRows(deps.db, state.meetingId),
        hashVariantOf(state.stages),
      );
      ctx.setInputHash(hash);

      // P10: no segment left.
      if (merged.length === 0) {
        throw new PrepareFailure(
          "empty_input",
          "The transcript has no segments to process.",
        );
      }

      // P9: the model and profile of each LLM node, once.
      const models = await resolveModels({
        maxReasoningTokens: {
          correctChunk: 0,
          identifySpeakers: IDENTIFY_REASONING_MAX,
          summarize: 0,
          suggestTags: 0,
        },
        ...(deps.reasoningSteps ? { reasoningSteps: deps.reasoningSteps } : {}),
      });

      const vocabTerms = loadVocabularyTerms();
      const language = row.language ?? null;

      const segments: PreparedSegment[] = merged.map((s) => ({
        id: s.id as string,
        speaker: s.speaker,
        startMs: s.startMs,
        speakerLabel:
          s.speaker === "Them" && s.speakerLabel ? s.speakerLabel : null,
        displayLabel: speakerDisplayLabel(s, "Them"),
        text: s.text,
        enhancedText: s.enhancedText ?? null,
        speakerName: s.speakerName ?? null,
      }));

      // P7: label sets from the structured label, not display text.
      const all: string[] = [];
      const confirmed = new Set<string>();
      for (const s of merged) {
        if (s.speaker !== "Them" || !s.speakerLabel) continue;
        if (!all.includes(s.speakerLabel)) all.push(s.speakerLabel);
        if (s.speakerName) confirmed.add(s.speakerLabel);
      }
      const labels = {
        all,
        confirmed: all.filter((l) => confirmed.has(l)),
        toIdentify: all.filter((l) => !confirmed.has(l)),
      };

      // P5, P6: whole segments, no overlap.
      const systemTokens = estimateTokens(
        buildCorrectSystemPrompt({ language, vocabTerms }),
      );
      const chunkTokens = chunkSizeFor(
        models.correctChunk.contextWindow,
        systemTokens,
      );
      const chunks = chunkForEnhance(
        segments.map((s) => ({
          id: s.id,
          speaker: s.displayLabel,
          text: s.text,
          ...(s.speakerLabel ? { speakerLabel: s.speakerLabel } : {}),
        })),
        chunkTokens,
      ).map((chunk) => chunk.map((s) => s.id));
      ctx.progress.setPlan(chunks.length, state.stages);

      const prepared: PreparedMeeting = {
        meetingId: state.meetingId,
        language,
        title: row.title,
        context: row.context,
        vocabTerms,
        // P8: names only, never emails.
        attendeeNames: parseAttendees(row)
          .map((a) => a.name)
          .filter((n) => n.trim().length > 0),
        segments,
        chunks,
        labels,
        chunkTokens,
        summary: {
          instructions: parseMeetingSummaryInstructions(
            readSettingFrom(deps, "meeting_summary_instructions"),
          ),
          contextBudget: parseMeetingSummaryContextBudget(
            readSettingFrom(deps, "meeting_summary_context_budget"),
          ),
        },
        inputHash: hash,
      };
      return { prepared, models };
    },
  );
  return guarded;
}
