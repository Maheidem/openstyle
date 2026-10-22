import type { LlmSkipReason } from "@openstyle/validations";
import { callUnit } from "../../../llm/call-unit.js";
import type { CallProfile } from "../../../llm/model-profiles.js";
import { estimateTokens, formatEnhanceLine } from "../chunking.js";
import type { RunContext, WorkflowDeps } from "../context.js";
import {
  buildIdentifySystemPrompt,
  buildIdentifyUserPrompt,
  promptContextWithFolder,
} from "../prompts.js";
import {
  type IdentifySpeakers,
  identifySpeakersStepSchema,
} from "../schemas.js";
import type { WorkflowStateType } from "../state.js";
import {
  type CandidateStats,
  foldStatus,
  IDENTIFY_ANCHOR_LINES,
  IDENTIFY_FIXED_TOKENS,
  IDENTIFY_MAX_INPUT_TOKENS,
  IDENTIFY_PROPOSAL_TOKENS,
  type IdentifySpeakersResult,
  MIN_SPLIT_TOKENS_IDENTIFY,
  type NodeFailure,
  type NodeStatus,
  type PreparedMeeting,
  type PreparedSegment,
  SAFETY_TOKENS,
  type SpeakerProposal,
} from "../types.js";
import {
  appliesSizeLimits,
  createBreaker,
  fitsContext,
  guardNode,
  type Leaf,
  recordUnitEnd,
  runUnitRoute,
  skippedBecause,
} from "../unit.js";

// Node `identifySpeakers` (specs/meeting-enhance-agentic.md 4.3). One call
// that proposes a name or role for each label that no user confirmed. Each
// proposal carries one transcript quote. `verifyEvidence` checks the quotes.

const UNIT_KEY = "candidates";

function lineOf(s: PreparedSegment): string {
  return formatEnhanceLine(s.id, s.displayLabel, s.text);
}

function tokensOfLines(lines: readonly PreparedSegment[]): number {
  return lines.reduce((sum, s) => sum + estimateTokens(lineOf(s)) + 1, 0);
}

// --- Candidate selection (4.3.2) ------------------------------------------

/** The cue words of 4.4.3. A cue followed by a capitalized word marks a likely name. */
const CUE_PATTERN =
  /(?<![\p{L}\p{N}])(?:this is|i'?m|i am|it'?s|it is|my name'?s|my name is)\s+(\p{L})/giu;

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

function hasCue(text: string): boolean {
  for (const m of text.matchAll(CUE_PATTERN)) {
    // The `i` flag lets \p{L} match any case, so check the real character.
    if (m[1] && isUpper(m[1])) return true;
  }
  return false;
}

/** A capitalized token that does not start its sentence ("Thanks, Ana"). */
function hasNameToken(text: string): boolean {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const tokens = sentence.split(/\s+/).filter(Boolean);
    for (let i = 1; i < tokens.length; i++) {
      const token = (tokens[i] ?? "").replace(/^[^\p{L}]+/u, "");
      const first = token.charAt(0);
      if (!first || !isUpper(first)) continue;
      if (/^I(?:'|’|$)/.test(token)) continue; // the pronoun "I", "I'm"
      return true;
    }
  }
  return false;
}

export function selectCandidates(
  prepared: PreparedMeeting,
  maxInputTokens: number,
): { lines: PreparedSegment[]; stats: CandidateStats } {
  const pool = prepared.segments.filter(
    (s) => s.speaker === "Them" && s.speakerLabel !== null,
  );
  const stats: CandidateStats = {
    poolLines: pool.length,
    selectedLines: 0,
    anchorLines: 0,
    cueLines: 0,
    nameTokenLines: 0,
    droppedByBudget: 0,
  };
  // S1: the pool fits.
  if (tokensOfLines(pool) <= maxInputTokens) {
    stats.selectedLines = pool.length;
    return { lines: pool, stats };
  }
  // S2: anchor lines, then cue lines, then name-token lines, until full.
  const chosen = new Set<string>();
  let used = 0;
  const add = (s: PreparedSegment, kind: "anchor" | "cue" | "nameToken") => {
    if (chosen.has(s.id)) return;
    const cost = estimateTokens(lineOf(s)) + 1;
    if (used + cost > maxInputTokens) {
      stats.droppedByBudget += 1;
      return;
    }
    chosen.add(s.id);
    used += cost;
    if (kind === "anchor") stats.anchorLines += 1;
    else if (kind === "cue") stats.cueLines += 1;
    else stats.nameTokenLines += 1;
  };
  const perLabel = new Map<string, number>();
  for (const s of pool) {
    const label = s.speakerLabel as string;
    if (!prepared.labels.toIdentify.includes(label)) continue;
    const n = perLabel.get(label) ?? 0;
    if (n >= IDENTIFY_ANCHOR_LINES) continue;
    perLabel.set(label, n + 1);
    add(s, "anchor");
  }
  for (const s of pool) if (hasCue(s.text)) add(s, "cue");
  for (const s of pool) if (hasNameToken(s.text)) add(s, "nameToken");
  const lines = pool.filter((s) => chosen.has(s.id));
  stats.selectedLines = lines.length;
  return { lines, stats };
}

// --- The node ---------------------------------------------------------------

const EMPTY_STATS: CandidateStats = {
  poolLines: 0,
  selectedLines: 0,
  anchorLines: 0,
  cueLines: 0,
  nameTokenLines: 0,
  droppedByBudget: 0,
};

function skipped(
  reason: LlmSkipReason,
  candidates: CandidateStats = EMPTY_STATS,
): IdentifySpeakersResult {
  return skippedBecause(
    {
      status: "skipped",
      proposals: [],
      shown: [],
      candidates,
      failures: [],
    },
    reason,
  );
}

export function failedIdentifyResult(
  failure: NodeFailure,
): IdentifySpeakersResult {
  return {
    status: "failed",
    proposals: [],
    shown: [],
    candidates: EMPTY_STATS,
    failures: [failure],
  };
}

/**
 * 4.3.5: the output limit of one unit. With the size limits, one entry is at
 * most about 350 characters (a 46-character id, a 160-character quote, an
 * 80-character name, keys). The 2026-10-20 Gemma 4 E2B runs wrote 2.4 to 3.0
 * characters per token, so a full entry is 117 to 148 tokens. A typical name
 * of 20 characters gives at most 123 tokens, inside IDENTIFY_PROPOSAL_TOKENS.
 */
function maxOutputFor(labelCount: number, profile: CallProfile): number {
  const answer = IDENTIFY_PROPOSAL_TOKENS * labelCount + IDENTIFY_FIXED_TOKENS;
  const reasoningShare = profile.reasoning.countsInMaxOutput
    ? profile.reasoning.budgetTokens
    : 0;
  return Math.min(
    profile.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    answer + reasoningShare,
  );
}

export function makeIdentifySpeakersNode(deps: WorkflowDeps) {
  const breaker = createBreaker();

  async function run(
    state: WorkflowStateType,
    ctx: RunContext,
  ): Promise<IdentifySpeakersResult> {
    const prepared = state.prepared;
    const models = state.models;
    if (!prepared || !models) throw new Error("prepare did not run");
    if (prepared.labels.all.length === 0) return skipped("no_labels");
    if (prepared.labels.toIdentify.length === 0)
      return skipped("all_confirmed");
    if (ctx.isCancelled()) return skipped("cancelled");
    if (ctx.isStopped()) return skipped("stopped");

    const profile = models.identifySpeakers;
    const labels = prepared.labels.toIdentify;
    const system = buildIdentifySystemPrompt({
      labels,
      title: prepared.title,
      context: promptContextWithFolder(prepared),
    });
    const systemTokens = estimateTokens(system);
    const maxOut = maxOutputFor(labels.length, profile);
    const inputBudget = Math.min(
      IDENTIFY_MAX_INPUT_TOKENS,
      profile.contextWindow === null
        ? Number.POSITIVE_INFINITY
        : profile.contextWindow - systemTokens - maxOut - SAFETY_TOKENS,
    );
    const { lines, stats } = selectCandidates(prepared, inputBudget);
    if (lines.length === 0) return skipped("no_labels", stats);

    ctx.progress.addTotal(1);
    const leaves = await runUnitRoute<PreparedSegment, IdentifySpeakers>(
      {
        node: "identifySpeakers",
        ctx,
        profile,
        minSplitTokens: MIN_SPLIT_TOKENS_IDENTIFY,
        tokensOf: tokensOfLines,
        maxOutput: (_members, p) => maxOutputFor(labels.length, p),
        fits: (members, out, p) =>
          fitsContext(p, systemTokens + tokensOfLines(members), out),
        call: (unit) =>
          callUnit(
            {
              step: "identifySpeakers",
              runId: state.runId,
              unitKey: unit.key,
              chunkIndex: null,
              schema: identifySpeakersStepSchema(
                unit.members.map((s) => s.id),
                labels,
                { sizeLimits: appliesSizeLimits(unit.profile) },
              ),
              instructions: system,
              messages: [
                {
                  role: "user",
                  content: buildIdentifyUserPrompt(unit.members.map(lineOf)),
                },
              ],
              profile: unit.profile,
              maxOutputTokens: unit.maxOutputTokens,
              signal: ctx.signal,
              onQueued: (i) => ctx.progress.onQueued(i),
              onHeld: (held) => ctx.progress.callHeld(held),
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
      UNIT_KEY,
      lines,
    );
    recordUnitEnd(breaker, ctx, leaves);
    return resultFromLeaves(leaves, stats);
  }

  const guarded = guardNode<WorkflowStateType, IdentifySpeakersResult>(
    deps,
    {
      id: "identifySpeakers",
      stepKey: () => UNIT_KEY,
      failed: (_state, f) => failedIdentifyResult(f),
      outcome: (r) => ({
        status: r.status,
        failure: r.failures[0] ?? null,
      }),
    },
    run,
  );
  return async (state: WorkflowStateType) => ({
    identify: await guarded(state),
  });
}

function resultFromLeaves(
  leaves: Leaf<PreparedSegment, IdentifySpeakers>[],
  candidates: CandidateStats,
): IdentifySpeakersResult {
  const proposals: SpeakerProposal[] = [];
  const shown: IdentifySpeakersResult["shown"] = [];
  const failures: NodeFailure[] = [];
  const statuses: NodeStatus[] = [];
  for (const leaf of leaves) {
    if (leaf.status === "ok" && leaf.result) {
      statuses.push("ok");
      const callId = leaf.result.callId;
      shown.push({
        unitKey: leaf.key,
        callId,
        segmentIds: leaf.members.map((s) => s.id),
      });
      leaf.result.object.speakers.forEach((p, seq) => {
        proposals.push({
          unitKey: leaf.key,
          llmCallId: callId,
          seq,
          segmentId: p.segmentId,
          quote: p.quote,
          label: p.label,
          kind: p.kind,
          name: p.name,
        });
      });
    } else {
      statuses.push(leaf.status === "ok" ? "failed" : leaf.status);
      if (leaf.status === "failed" && leaf.failure) failures.push(leaf.failure);
    }
  }
  const result: IdentifySpeakersResult = {
    status: foldStatus(statuses),
    proposals,
    shown,
    candidates,
    failures,
  };
  // A unit is skipped only when the run stopped before its call.
  return result.status === "skipped"
    ? skippedBecause(result, "stopped")
    : result;
}
