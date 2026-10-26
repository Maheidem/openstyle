import type {
  CorrectionDropReason,
  EvidenceType,
  SpeakerVerdict,
} from "@openstyle/validations";
import type { GatewayErrorKind } from "../../llm/call-record.js";
import type { CallProfile } from "../../llm/model-profiles.js";
import type { FolderMemory, FolderMemoryRecord } from "./folder-memory.js";
import type { MeetingSummary } from "./schemas.js";

// Types and pure functions of the Enhance workflow (specs/meeting-enhance-agentic.md
// 3.3, 3.4.3, 4.0.7, 4.1 to 4.6). No database, no clock, no LangGraph.

/**
 * Bump it by 1 in the PR that changes the nodes or edges, a state field or
 * node result type, a node schema, a prompt, a constant below, the unit key
 * grammar, or the model or reasoning choice (3.4.7, "Graph version").
 */
export const WORKFLOW_GRAPH_VERSION = 9;

// ---------------------------------------------------------------------------
// Constants of 4.0.5. Names are names of this spec. Values marked "new" in the
// spec are starting values that the benchmark tunes (D12, N7).
// ---------------------------------------------------------------------------

export const CHUNK_TOKENS_MAX = 1200;
export const CORRECT_ANSWER_FACTOR = 2;
export const CORRECT_ANSWER_FIXED = 200;
export const SAFETY_TOKENS = 256;
export const MIN_SPLIT_TOKENS_CORRECT = 300;
export const MIN_SPLIT_TOKENS_IDENTIFY = 1500;
export const IDENTIFY_MAX_INPUT_TOKENS = 6000;
export const IDENTIFY_ANCHOR_LINES = 8;
export const IDENTIFY_PROPOSAL_TOKENS = 140;
export const IDENTIFY_FIXED_TOKENS = 64;
export const IDENTIFY_REASONING_MAX = 2048;
export const QUOTE_MAX_CHARS = 160;
export const NAME_MAX_CHARS = 80;
/** Consecutive final failures of one kind in one node that stop the run (3.4.5). */
export const BREAKER_N = 3;
/** suggestTags (issue #231): the input budget and the answer size. */
export const TAGS_MAX_INPUT_TOKENS = 6000;
export const TAGS_ANSWER_TOKENS = 200;
/** The most existing tag names that go in the prompt (the most used first). */
export const TAGS_PROMPT_MAX_EXISTING = 200;

// ---------------------------------------------------------------------------
// Failure and status (4.0.7)
// ---------------------------------------------------------------------------

export type NodeId =
  | "prepare"
  | "correctChunk"
  | "identifySpeakers"
  | "verifyEvidence"
  | "summarize"
  | "save"
  | "suggestTags";

export type FailureKind =
  | GatewayErrorKind
  | "budget_exceeded"
  | "empty_input"
  | "save_failed"
  | "internal"
  | "transcript_changed";

/** One per failed unit. Stored by section 7, shown by section 8. */
export interface NodeFailure {
  node: NodeId;
  /** "chunk:3", "chunk:3/0" (half), "candidates", "single", "map:2", "reduce:1:0". */
  unitKey: string | null;
  kind: FailureKind;
  finishReason: string | null;
  rawFinishReason: string | null;
  attempt: number | null;
  /** null: the record write failed (7.7). */
  llmCallIds: (number | null)[];
  /** One line, no prompt text. */
  message: string;
}

export type NodeStatus = "ok" | "partial" | "failed" | "skipped" | "cancelled";

/** Node "ok" is stored as "succeeded" (3.4.3). */
export type RunStatus =
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "meeting_deleted";

/**
 * One pure function for both folds (4.0.7): unit statuses give a step status,
 * chunk statuses give the status of `correctChunk`. A `partial` entry counts
 * as one `ok` and one `failed`. The first matching row wins.
 */
export function foldStatus(list: readonly NodeStatus[]): NodeStatus {
  const hasFailed = list.some((s) => s === "failed" || s === "partial");
  const hasOk = list.some((s) => s === "ok" || s === "partial");
  if (hasFailed && hasOk) return "partial";
  if (list.includes("failed")) return "failed";
  if (list.includes("cancelled")) return "cancelled";
  if (list.length === 0 || list.includes("skipped")) return "skipped";
  return "ok";
}

// ---------------------------------------------------------------------------
// prepare (4.1)
// ---------------------------------------------------------------------------

export type RunStage = "enhance" | "summarize";

export interface PreparedSegment {
  /** meeting_segments.id */
  id: string;
  speaker: "Me" | "Them";
  startMs: number;
  /** "2" for "Them 2". null for Me and undiarized Them. */
  speakerLabel: string | null;
  /** "Me", "Them 2", or a confirmed name. */
  displayLabel: string;
  /** The raw text, never an earlier correction. */
  text: string;
  /** Stored `enhanced_text` when `prepare` ran. Only `summarize` reads it. */
  enhancedText: string | null;
  /** Confirmed name after merges. Only `summarize` reads it. */
  speakerName: string | null;
}

export interface PreparedMeeting {
  meetingId: string;
  language: string | null;
  title: string | null;
  /** The meeting's own context. Of the context fields, `summarize` reads only this (P8b). */
  context: string | null;
  /**
   * The meeting context, then the folder block (buildPromptContext).
   * `identifySpeakers`, `verifyEvidence` and `suggestTags` read it (P8b).
   * Absent in a checkpoint from before issue #230: read it with
   * `promptContextWithFolder`.
   */
  contextWithFolder?: string | null;
  vocabTerms: string[];
  /** For verifyEvidence only. Never in a prompt. */
  attendeeNames: string[];
  /** Time order. */
  segments: PreparedSegment[];
  /** Segment ids per chunk. Whole segments. No overlap. */
  chunks: string[][];
  labels: { all: string[]; confirmed: string[]; toIdentify: string[] };
  /** Chunk size used. */
  chunkTokens: number;
  /** The two settings that `summarize` reads, read once. */
  summary: { instructions: string; contextBudget: number };
  /** sha256 hex from `inputHash(loadHashRows(...), hashVariantOf(stages))`. */
  inputHash: string;
  /**
   * Project memory (issue #234). Absent when the meeting is unfiled, search
   * is off, or nothing was found. `summarize` reads `summaryBlock`. Its
   * `terms` are already in `vocabTerms`. The run record keeps the ids only.
   */
  folderMemory?: FolderMemory;
}

// ---------------------------------------------------------------------------
// correctChunk (4.2)
// ---------------------------------------------------------------------------

/** The payload of one Send. A Send branch gets only this object. */
export interface CorrectChunkInput {
  runId: string;
  meetingId: string;
  /** Index in prepared.chunks, from 0. Unit key `chunk:<chunkIndex>`. */
  chunkIndex: number;
  /** The whole segments of this chunk, in time order. */
  segments: PreparedSegment[];
  language: string | null;
  vocabTerms: string[];
  /** models.correctChunk */
  profile: CallProfile;
}

/** One LLM unit: the chunk, or a half after a split (4.0.6). */
export interface CorrectUnitResult {
  /** "chunk:3", "chunk:3/0" */
  unitKey: string;
  /** The segments this unit covered. */
  segmentIds: string[];
  status: "ok" | "failed" | "cancelled" | "skipped";
  /**
   * `seq` is the index of the entry in the `corrections` array of the model
   * output of call `callId` (before any drop). A dropped entry keeps its own
   * index, so an applied entry and a dropped entry never share a link key.
   */
  corrections: {
    id: string;
    text: string;
    seq: number;
    callId: number | null;
  }[];
  dropped: {
    id: string;
    reason: CorrectionDropReason;
    seq: number;
    callId: number | null;
  }[];
  failure: NodeFailure | null;
}

export interface CorrectChunkResult {
  chunkIndex: number;
  /** foldStatus over `units`. */
  status: NodeStatus;
  units: CorrectUnitResult[];
}

// ---------------------------------------------------------------------------
// identifySpeakers (4.3)
// ---------------------------------------------------------------------------

export interface SpeakerProposal {
  unitKey: string;
  llmCallId: number | null;
  /** Index of the entry in the `speakers` array of the output of call `llmCallId`. */
  seq: number;
  segmentId: string;
  quote: string;
  label: string;
  kind: "name" | "role";
  name: string;
}

export interface CandidateStats {
  poolLines: number;
  selectedLines: number;
  anchorLines: number;
  cueLines: number;
  nameTokenLines: number;
  droppedByBudget: number;
}

export interface IdentifySpeakersResult {
  /** foldStatus over its units. partial: some halves failed (4.3.6). */
  status: NodeStatus;
  /** From the units that succeeded. */
  proposals: SpeakerProposal[];
  /** The lines each call showed (4.4.2 check 2). */
  shown: { unitKey: string; callId: number | null; segmentIds: string[] }[];
  candidates: CandidateStats;
  /** One per failed unit. */
  failures: NodeFailure[];
}

// ---------------------------------------------------------------------------
// verifyEvidence (4.4)
// ---------------------------------------------------------------------------

export interface SpeakerSuggestion {
  label: string;
  kind: "name" | "role";
  /** finalName */
  name: string;
  /** The quote. */
  evidence: string;
  evidenceType: EvidenceType;
  segmentId: string;
}

export interface VerifyResult {
  /**
   * `ok`; `skipped` when `identifySpeakers` was skipped or failed (4.4.6);
   * `failed` only when `guardNode` caught an `internal` fault (4.0.2).
   */
  status: NodeStatus;
  failure: NodeFailure | null;
  verdicts: SpeakerVerdict[];
  /** At most one winner per label. */
  suggestions: SpeakerSuggestion[];
}

// ---------------------------------------------------------------------------
// summarize (4.5). The body arrives in WP6.
// ---------------------------------------------------------------------------

export interface SummarizeResult {
  /**
   * Never `partial`: a summary that omits content must not look complete. A
   * summary repaired from a cut answer is `ok` with `partial` true: save
   * stores the flag and the UI shows a notice (PR #258).
   */
  status: NodeStatus;
  summary: MeetingSummary | null;
  /** Rendered by code. */
  markdown: string;
  llmProvider: string | null;
  llmModel: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  callCount: number;
  failure: NodeFailure | null;
  llmCallIds: (number | null)[];
  /**
   * True when a call hit the output limit and its cut answer was repaired:
   * the summary can miss the last items (PR #258, graph version 7).
   */
  partial: boolean;
}

// ---------------------------------------------------------------------------
// save (4.6)
// ---------------------------------------------------------------------------

export type WriteOutcome = "ok" | "failed" | "none";

export interface SaveResult {
  sw1: WriteOutcome;
  sw2: WriteOutcome;
  sw3: WriteOutcome;
  /** At least one SW1, SW2 or SW3 transaction committed. */
  wroteAny: boolean;
  /** Segments that SW1 gave a non-NULL `enhanced_text` in this run. */
  correctedCount: number;
  /**
   * Entries that the model returned and the 4.2.3 checks dropped, in the units
   * that SW1 saved. An `unchanged` echo is not a suggested change and does not
   * count.
   */
  droppedCount: number;
  /** `meeting_speakers` rows that SW2 wrote in this run. */
  suggestionCount: number;
  /** `save_failed` per write that failed twice, and `internal` from `guardNode`. */
  failures: NodeFailure[];
  /** The meeting row is gone (4.6.4). */
  meetingGone: boolean;
}

// ---------------------------------------------------------------------------
// suggestTags (issue #231). It runs after `save` and never changes the run
// status: deriveRunStatus does not read it.
// ---------------------------------------------------------------------------

export interface SuggestTagsResult {
  status: NodeStatus;
  /** The normalized names the model gave, at most MAX_SUGGESTED_TAGS. */
  suggested: string[];
  /** The names that this run added to the meeting. */
  added: string[];
  failure: NodeFailure | null;
}

// ---------------------------------------------------------------------------
// Run status (3.4.3)
// ---------------------------------------------------------------------------

/** The graph state fields that `deriveRunStatus` reads. */
export interface FinalState {
  stages: RunStage[];
  corrections: CorrectChunkResult[];
  identify: IdentifySpeakersResult | null;
  verify: VerifyResult | null;
  summary: SummarizeResult | null;
  saved: SaveResult | null;
  /** The ids of the project memory that `prepare` found (issue #234). */
  retrieval?: FolderMemoryRecord | null;
}

export interface RunEnd {
  /** Soft-cancel flag set. A hard stop sets it first (3.4.5). */
  cancelled: boolean;
  /** `prepare` threw, or another graph error (saver fault, escaped bug). */
  fault: "none" | "prepare" | "graph";
  /** The thread has a checkpoint. */
  hasCheckpoint: boolean;
}

/** The first matching rule of the table in 3.4.3 wins. */
export function deriveRunStatus(
  s: FinalState,
  end: RunEnd,
): RunStatus | "interrupted" {
  if (s.saved?.meetingGone) return "meeting_deleted";
  if (end.cancelled) return "cancelled";
  if (end.fault === "prepare") return "failed";
  if (end.fault === "graph")
    return end.hasCheckpoint ? "interrupted" : "failed";

  const nodes: NodeStatus[] = [];
  if (s.stages.includes("enhance")) {
    nodes.push(foldStatus(s.corrections.map((c) => c.status)));
    nodes.push(s.identify?.status ?? "skipped");
    nodes.push(s.verify?.status ?? "skipped");
  }
  if (s.stages.includes("summarize"))
    nodes.push(s.summary?.status ?? "skipped");

  if (
    nodes.every((n) => n === "ok" || n === "skipped") &&
    s.saved !== null &&
    s.saved.failures.length === 0
  ) {
    return "succeeded";
  }
  if (s.saved?.wroteAny) return "partial";
  return "failed";
}

/**
 * A fault of `prepare` that carries its failure kind. `guardNode` rethrows it
 * and the runner ends the run with that typed code (3.4.6).
 */
export class PrepareFailure extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = "PrepareFailure";
    this.kind = kind;
  }
}
