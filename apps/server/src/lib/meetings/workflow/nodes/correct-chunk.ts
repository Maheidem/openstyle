import type { CorrectionDropReason } from "@openstyle/validations";
import { callUnit } from "../../../llm/call-unit.js";
import type { CallProfile } from "../../../llm/model-profiles.js";
import { estimateTokens, formatEnhanceLine } from "../chunking.js";
import type { RunContext, WorkflowDeps } from "../context.js";
import {
  buildCorrectSystemPrompt,
  buildCorrectUserPrompt,
} from "../prompts.js";
import { CORRECT_CHUNK_STEP_SCHEMA } from "../schemas.js";
import {
  CORRECT_ANSWER_FACTOR,
  CORRECT_ANSWER_FIXED,
  type CorrectChunkInput,
  type CorrectChunkResult,
  type CorrectUnitResult,
  foldStatus,
  MIN_SPLIT_TOKENS_CORRECT,
  type NodeFailure,
  type PreparedSegment,
} from "../types.js";
import {
  createBreaker,
  fitsContext,
  guardNode,
  type Leaf,
  recordUnitEnd,
  runUnitRoute,
} from "../unit.js";

// Node `correctChunk` (specs/meeting-enhance-agentic.md 4.2). One task for each
// chunk. It fixes clear speech-to-text errors and nothing else. It writes no
// meeting data: `save` does.

function lineOf(s: PreparedSegment): string {
  return formatEnhanceLine(s.id, s.displayLabel, s.text);
}

function tokensOfSegments(segments: readonly PreparedSegment[]): number {
  return segments.reduce((sum, s) => sum + estimateTokens(lineOf(s)) + 1, 0);
}

/** 4.2.4: the output limit of one unit. */
function maxOutputFor(
  segments: readonly PreparedSegment[],
  profile: CallProfile,
): number {
  const answer =
    Math.ceil(tokensOfSegments(segments) * CORRECT_ANSWER_FACTOR) +
    CORRECT_ANSWER_FIXED;
  const reasoningShare = profile.reasoning.countsInMaxOutput
    ? profile.reasoning.budgetTokens
    : 0;
  return Math.min(
    profile.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    answer + reasoningShare,
  );
}

/** A `failed` result with one failed unit (guardNode and the error handler). */
export function failedCorrectResult(
  state: Pick<CorrectChunkInput, "chunkIndex" | "segments">,
  failure: NodeFailure,
): CorrectChunkResult {
  return {
    chunkIndex: state.chunkIndex,
    status: "failed",
    units: [
      {
        unitKey: `chunk:${state.chunkIndex}`,
        segmentIds: state.segments.map((s) => s.id),
        status: "failed",
        corrections: [],
        dropped: [],
        failure,
      },
    ],
  };
}

/** 4.2.3: the code checks after the parse. */
function checkCorrections(
  raw: { id: string; text: string }[],
  segments: readonly PreparedSegment[],
  callId: number | null,
): Pick<CorrectUnitResult, "corrections" | "dropped"> {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const corrections: CorrectUnitResult["corrections"] = [];
  const dropped: CorrectUnitResult["dropped"] = [];
  raw.forEach((entry, seq) => {
    const drop = (reason: CorrectionDropReason) => {
      dropped.push({ id: entry.id, reason, seq, callId });
    };
    const original = byId.get(entry.id);
    if (!original) {
      drop("unknown_id");
      return;
    }
    if (seen.has(entry.id)) {
      drop("duplicate_id");
      return;
    }
    seen.add(entry.id);
    let text = entry.text.trim();
    // A local model sometimes echoes the "Speaker: " prefix of the line format.
    const prefix = `${original.displayLabel}: `;
    if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
    if (!text) {
      drop("empty_text");
      return;
    }
    if (text === original.text.trim()) {
      drop("unchanged");
      return;
    }
    corrections.push({ id: entry.id, text, seq, callId });
  });
  return { corrections, dropped };
}

function toUnit(
  leaf: Leaf<PreparedSegment, { corrections: { id: string; text: string }[] }>,
): CorrectUnitResult {
  const segmentIds = leaf.members.map((s) => s.id);
  if (leaf.status !== "ok" || !leaf.result) {
    return {
      unitKey: leaf.key,
      segmentIds,
      status: leaf.status === "ok" ? "failed" : leaf.status,
      corrections: [],
      dropped: [],
      failure: leaf.failure,
    };
  }
  return {
    unitKey: leaf.key,
    segmentIds,
    status: "ok",
    ...checkCorrections(
      leaf.result.object.corrections,
      leaf.members,
      leaf.result.callId,
    ),
    failure: null,
  };
}

export function makeCorrectChunkNode(deps: WorkflowDeps) {
  const breaker = createBreaker();

  async function run(
    input: CorrectChunkInput,
    ctx: RunContext,
  ): Promise<CorrectChunkResult> {
    const system = buildCorrectSystemPrompt({
      language: input.language,
      vocabTerms: input.vocabTerms,
    });
    const systemTokens = estimateTokens(system);
    ctx.progress.addTotal(1);
    const leaves = await runUnitRoute(
      {
        node: "correctChunk",
        ctx,
        profile: input.profile,
        minSplitTokens: MIN_SPLIT_TOKENS_CORRECT,
        tokensOf: tokensOfSegments,
        maxOutput: maxOutputFor,
        fits: (members, maxOut, profile) =>
          fitsContext(
            profile,
            systemTokens + tokensOfSegments(members),
            maxOut,
          ),
        call: (unit) =>
          callUnit(
            {
              step: "correctChunk",
              runId: input.runId,
              unitKey: unit.key,
              chunkIndex: input.chunkIndex,
              schema: CORRECT_CHUNK_STEP_SCHEMA,
              instructions: system,
              messages: [
                {
                  role: "user",
                  content: buildCorrectUserPrompt(unit.members.map(lineOf)),
                },
              ],
              profile: unit.profile,
              maxOutputTokens: unit.maxOutputTokens,
              signal: ctx.signal,
              onQueued: (i) => ctx.progress.onQueued(i),
            },
            ctx,
            deps,
          ),
        onSplit: () => ctx.progress.addTotal(1),
        onLeafEnd: (leaf) => {
          if (leaf.status === "ok") ctx.progress.callEnded("ok");
          else if (leaf.status === "failed") ctx.progress.callEnded("failed");
        },
      },
      `chunk:${input.chunkIndex}`,
      input.segments,
    );
    recordUnitEnd(breaker, ctx, leaves);
    const units = leaves.map(toUnit);
    return {
      chunkIndex: input.chunkIndex,
      status: foldStatus(units.map((u) => u.status)),
      units,
    };
  }

  const guarded = guardNode<CorrectChunkInput, CorrectChunkResult>(
    deps,
    {
      id: "correctChunk",
      stepKey: (s) => `chunk:${s.chunkIndex}`,
      failed: failedCorrectResult,
      outcome: (r) => ({
        status: r.status,
        failure: r.units.find((u) => u.status === "failed")?.failure ?? null,
      }),
    },
    run,
  );
  return async (input: CorrectChunkInput) => ({
    corrections: [await guarded(input)],
  });
}
