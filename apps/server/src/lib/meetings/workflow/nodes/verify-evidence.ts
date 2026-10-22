import type {
  DropReason,
  EvidenceType,
  LlmSkipReason,
  SpeakerVerdict,
} from "@openstyle/validations";
import {
  distanceAtMostOne,
  fixNameSpelling,
  MIN_FUZZY_FIRST_NAME,
} from "../../speaker-spelling.js";
import type { WorkflowDeps } from "../context.js";
import { promptContextWithFolder } from "../prompts.js";
import type { WorkflowStateType } from "../state.js";
import {
  NAME_MAX_CHARS,
  type NodeFailure,
  type PreparedMeeting,
  QUOTE_MAX_CHARS,
  type SpeakerProposal,
  type SpeakerSuggestion,
  type VerifyResult,
} from "../types.js";
import { guardNode, skippedBecause } from "../unit.js";

// Node `verifyEvidence` (specs/meeting-enhance-agentic.md 4.4). Code only. It
// checks every proposal against the real transcript, picks one winner for each
// label, fixes the spelling of a winning name, and stores a verdict with a
// reason for each proposal. It writes nothing to the database: `save` does.

// --- 4.4.1 Normalization ----------------------------------------------------

export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’ʼ]/g, "'") // curly apostrophes
    .replace(/[“”]/g, '"') // curly quotes
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const B = "(?<![\\p{L}\\p{N}])"; // not after a letter or digit
const E = "(?![\\p{L}\\p{N}])"; // not before a letter or digit

export function containsWord(textNorm: string, wordNorm: string): boolean {
  return new RegExp(`${B}${escapeRegExp(wordNorm)}${E}`, "u").test(textNorm);
}

// --- 4.4.3 Self-introduction patterns ---------------------------------------

// Cues, English. Lowercase. The name is already normalized.
const SELF_INTRO_CUES_EN =
  "this is|i'?m|i am|it'?s|it is|my name'?s|my name is";

// A name that starts a clause and is followed by a comma and a job title:
// "So Tom, SVP of kiosks here". A greeting before the name ("Hello, Mike")
// is not a start, and a name without a title after the comma is not accepted.
const CLAUSE_START =
  "(?:^|[.!?]\\s+)(?:(?:so|ok|okay|alright|well|yeah|and)[,\\s]+)?";
const TITLE_WORDS =
  "(?:svp|evp|vp|ceo|cto|cfo|coo|cio|cpo|vice president|president|director|manager|founder|co-founder|chief|engineer|architect|head of|lead of|principal|partner|consultant|analyst|recruiter)";

export function looksSelfIdentifying(
  quoteNorm: string,
  nameNorm: string,
): boolean {
  if (!nameNorm) return false;
  const n = escapeRegExp(nameNorm);
  return new RegExp(
    `${B}(${SELF_INTRO_CUES_EN})\\s+${n}${E}|${B}${n}\\s+(here|speaking)${E}|${CLAUSE_START}${n},\\s*${TITLE_WORDS}${E}`,
    "u",
  ).test(quoteNorm);
}

/**
 * The part of a proposed name that the quote holds, or null. The calendar lists
 * full names, but people say only the first name. So the full name, the name
 * with the attendee spelling, or the first name alone (at a word boundary)
 * passes. A first name of 4 letters or more also passes with one letter off
 * ("Harris" in the quote for a proposed "Haris"). Returns the text as written
 * in the quote.
 */
export function nameMatchInQuote(
  quoteNorm: string,
  nameNorm: string,
  attendeeNames: readonly string[],
): string | null {
  const fixedNorm = normalizeForMatch(
    fixNameSpelling(nameNorm, [...attendeeNames]),
  );
  const variants = [...new Set([nameNorm, fixedNorm])];
  for (const v of variants) if (containsWord(quoteNorm, v)) return v;
  for (const v of variants) {
    const first = v.split(" ")[0] ?? "";
    if (first && containsWord(quoteNorm, first)) return first;
  }
  const first = nameNorm.split(" ")[0] ?? "";
  if (first.length >= MIN_FUZZY_FIRST_NAME) {
    for (const w of quoteNorm.match(/[\p{L}\p{N}']+/gu) ?? []) {
      if (w.length >= MIN_FUZZY_FIRST_NAME && distanceAtMostOne(first, w) === 1)
        return w;
    }
  }
  return null;
}

// --- 4.4.2 Per-proposal checks ----------------------------------------------

/**
 * A text that only repeats a diarized label: "Me", "Them", "Them 2",
 * "Speaker 2", "Label 2" or the label number alone ("2"). Trimmed, any case.
 */
const LABEL_ECHO = /^(?:me|them(?:\s*\d+)?|speaker\s*\d+|label\s*\d+|\d+)$/iu;

export function isLabelEcho(text: string): boolean {
  return LABEL_ECHO.test(text.trim());
}

interface Judged {
  proposal: SpeakerProposal;
  name: string;
  evidenceType: EvidenceType | null;
  startMs: number;
  reason: DropReason | null;
  detail: string | null;
  /** The part of the name that the quote holds (normalized), for a kept name. */
  matched?: string;
}

function drop(
  p: SpeakerProposal,
  name: string,
  evidenceType: EvidenceType | null,
  startMs: number,
  reason: DropReason,
  detail: string,
): Judged {
  return {
    proposal: p,
    name,
    evidenceType,
    startMs,
    reason,
    detail: detail.slice(0, 200),
  };
}

/** Run the nine checks in order. The first failure decides the verdict. */
function judge(
  p: SpeakerProposal,
  prepared: PreparedMeeting,
  shown: Map<string, Set<string>>,
  byId: Map<string, PreparedMeeting["segments"][number]>,
): Judged {
  const name = p.name.trim().slice(0, NAME_MAX_CHARS);
  // 1
  if (!prepared.labels.toIdentify.includes(p.label)) {
    return drop(
      p,
      name,
      null,
      0,
      "unknown_label",
      "The label is not open for a suggestion.",
    );
  }
  // 2
  const seg = byId.get(p.segmentId);
  if (!seg || !shown.get(p.unitKey)?.has(p.segmentId)) {
    return drop(
      p,
      name,
      null,
      0,
      "unknown_segment",
      "The line was not shown to the model.",
    );
  }
  const startMs = seg.startMs;
  // 3
  const quoteNorm = normalizeForMatch(p.quote);
  if (!quoteNorm)
    return drop(p, name, null, startMs, "no_quote", "The quote is empty.");
  // 4
  if (p.quote.trim().length > QUOTE_MAX_CHARS) {
    return drop(
      p,
      name,
      null,
      startMs,
      "quote_too_long",
      `The quote is longer than ${QUOTE_MAX_CHARS} characters.`,
    );
  }
  // 5
  if (!normalizeForMatch(seg.text).includes(quoteNorm)) {
    return drop(
      p,
      name,
      null,
      startMs,
      "quote_not_in_segment",
      "The quote is not in the cited line.",
    );
  }
  // The evidence type comes from the cited line, not from the model.
  const evidenceType: EvidenceType =
    p.kind === "role"
      ? "role_detail"
      : seg.speakerLabel === p.label
        ? "self_introduction"
        : "addressed_as";
  // 6
  if (!name)
    return drop(
      p,
      name,
      evidenceType,
      startMs,
      "empty_name",
      "The name is empty.",
    );
  // 6b: a name or a role that only repeats a diarized label.
  if (isLabelEcho(name)) {
    return drop(
      p,
      name,
      evidenceType,
      startMs,
      "label_echo",
      "The suggestion only repeats a speaker label.",
    );
  }
  let matched: string | null = null;
  if (p.kind === "name") {
    const nameNorm = normalizeForMatch(name);
    // 7
    matched = nameMatchInQuote(quoteNorm, nameNorm, prepared.attendeeNames);
    if (!matched) {
      return drop(
        p,
        name,
        evidenceType,
        startMs,
        "name_not_in_quote",
        "The name is not in the quote.",
      );
    }
    // 8
    if (
      evidenceType === "self_introduction" &&
      !looksSelfIdentifying(quoteNorm, matched)
    ) {
      return drop(
        p,
        name,
        evidenceType,
        startMs,
        "not_self_introduction",
        "The quote does not read as a self-introduction.",
      );
    }
  }
  return {
    proposal: p,
    name,
    evidenceType,
    startMs,
    reason: null,
    detail: null,
    ...(matched ? { matched } : {}),
  };
}

// --- Surname support ---------------------------------------------------------

/**
 * The normalized text that can support the words after a spoken first name:
 * the attendee names, the meeting title, the identify prompt context (the
 * meeting context and the folder block) and the transcript. The identify
 * prompt holds the title and that context, so a model can take a surname from
 * them.
 */
function supportTexts(prepared: PreparedMeeting): string[] {
  return [
    ...prepared.attendeeNames,
    prepared.title ?? "",
    promptContextWithFolder(prepared) ?? "",
    ...prepared.segments.map((s) => s.text),
  ]
    .map(normalizeForMatch)
    .filter((t) => t.length > 0);
}

/**
 * The name to store when the quote holds only the first name. The words after
 * the first name stay only when a support text holds them. Otherwise the model
 * invented them, and only the first name stays.
 */
function supportedName(name: string, support: readonly string[]): string {
  const [first = "", ...rest] = name.trim().split(/\s+/);
  if (rest.length === 0) return name;
  const restNorm = normalizeForMatch(rest.join(" "));
  return support.some((t) => containsWord(t, restNorm)) ? name : first;
}

// --- 4.4.5 Conflict policy --------------------------------------------------

const EVIDENCE_RANK: Record<EvidenceType, number> = {
  self_introduction: 0,
  addressed_as: 1,
  role_detail: 2,
};

function compareRank(
  a: Judged & { finalName: string },
  b: Judged & { finalName: string },
): number {
  const kindA = a.proposal.kind === "name" ? 0 : 1;
  const kindB = b.proposal.kind === "name" ? 0 : 1;
  if (kindA !== kindB) return kindA - kindB;
  const evA = EVIDENCE_RANK[a.evidenceType as EvidenceType];
  const evB = EVIDENCE_RANK[b.evidenceType as EvidenceType];
  if (evA !== evB) return evA - evB;
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  if (a.proposal.segmentId !== b.proposal.segmentId) {
    return a.proposal.segmentId < b.proposal.segmentId ? -1 : 1;
  }
  // Stable last resort: proposal order.
  if (a.proposal.unitKey !== b.proposal.unitKey) {
    return a.proposal.unitKey < b.proposal.unitKey ? -1 : 1;
  }
  return a.proposal.seq - b.proposal.seq;
}

function verdictOf(
  j: Judged,
  fields: Partial<SpeakerVerdict> & Pick<SpeakerVerdict, "status">,
): SpeakerVerdict {
  const p = j.proposal;
  return {
    unitKey: p.unitKey,
    llmCallId: p.llmCallId,
    seq: p.seq,
    label: p.label,
    proposedKind: p.kind,
    proposedName: p.name,
    segmentId: p.segmentId,
    quote: p.quote,
    evidenceType: j.evidenceType,
    reason: j.reason,
    detail: j.detail,
    finalName: null,
    respelledFrom: null,
    winnerCallId: null,
    ...fields,
  };
}

/** The whole node as a pure function. */
export function verifyEvidence(
  prepared: PreparedMeeting,
  proposals: readonly SpeakerProposal[],
  shownEntries: readonly { unitKey: string; segmentIds: readonly string[] }[],
): Pick<VerifyResult, "verdicts" | "suggestions"> {
  const shown = new Map<string, Set<string>>();
  for (const s of shownEntries) shown.set(s.unitKey, new Set(s.segmentIds));
  const byId = new Map(prepared.segments.map((s) => [s.id, s]));

  const judged = proposals.map((p) => judge(p, prepared, shown, byId));

  // 4.4.4: the spelling fix runs before the conflict policy (N8).
  const passed: (Judged & {
    finalName: string;
    respelledFrom: string | null;
  })[] = [];
  let support: string[] | null = null;
  for (const j of judged) {
    if (j.reason !== null) continue;
    let finalName = j.name;
    let respelledFrom: string | null = null;
    let detail = j.detail;
    if (j.proposal.kind === "name") {
      const fixed = fixNameSpelling(j.name, prepared.attendeeNames);
      if (fixed !== j.name) {
        respelledFrom = j.name;
        finalName = fixed;
      }
      // The quote holds only the first name: drop words that no support
      // text holds, so an invented surname is not stored.
      if (j.matched && !j.matched.includes(" ")) {
        support ??= supportTexts(prepared);
        const kept = supportedName(finalName, support);
        if (kept !== finalName) {
          detail =
            `Kept the first name only. The meeting does not hold: ${finalName}`.slice(
              0,
              200,
            );
          finalName = kept;
        }
      }
    }
    passed.push({ ...j, finalName, respelledFrom, detail });
  }

  // 4.4.5: one winner for each label.
  const outcome = new Map<Judged, SpeakerVerdict>();
  const suggestions: SpeakerSuggestion[] = [];
  const byLabel = new Map<string, typeof passed>();
  for (const j of passed) {
    const list = byLabel.get(j.proposal.label) ?? [];
    list.push(j);
    byLabel.set(j.proposal.label, list);
  }
  for (const list of byLabel.values()) {
    list.sort(compareRank);
    const winner = list[0];
    if (!winner) continue;
    outcome.set(
      winner,
      verdictOf(winner, {
        status: "kept",
        finalName: winner.finalName,
        respelledFrom: winner.respelledFrom,
      }),
    );
    suggestions.push({
      label: winner.proposal.label,
      kind: winner.proposal.kind,
      name: winner.finalName,
      evidence: winner.proposal.quote,
      evidenceType: winner.evidenceType as EvidenceType,
      segmentId: winner.proposal.segmentId,
    });
    for (const loser of list.slice(1)) {
      const same =
        loser.finalName.toLowerCase() === winner.finalName.toLowerCase();
      outcome.set(
        loser,
        verdictOf(loser, {
          status: "dropped",
          reason: same ? "duplicate_same_name" : "conflict_lost",
          detail: same
            ? `Same name as the winner: ${winner.finalName}`.slice(0, 200)
            : `Lost to: ${winner.finalName}`.slice(0, 200),
          winnerCallId: winner.proposal.llmCallId,
        }),
      );
    }
  }

  const verdicts = judged.map((j) => {
    if (j.reason !== null) return verdictOf(j, { status: "dropped" });
    const passedEntry = passed.find((x) => x.proposal === j.proposal);
    const v = passedEntry ? outcome.get(passedEntry) : undefined;
    return v ?? verdictOf(j, { status: "dropped" });
  });
  suggestions.sort((a, b) =>
    a.label.localeCompare(b.label, "en", { numeric: true }),
  );
  return { verdicts, suggestions };
}

function failedVerify(failure: NodeFailure): VerifyResult {
  return { status: "failed", failure, verdicts: [], suggestions: [] };
}

export function makeVerifyEvidenceNode(deps: WorkflowDeps) {
  const guarded = guardNode<WorkflowStateType, VerifyResult>(
    deps,
    {
      id: "verifyEvidence",
      stepKey: () => "verify",
      failed: (_state, f) => failedVerify(f),
      outcome: (r) => ({ status: r.status, failure: r.failure }),
    },
    async (state) => {
      const prepared = state.prepared;
      const identify = state.identify;
      if (
        !prepared ||
        !identify ||
        identify.status === "skipped" ||
        identify.status === "failed" ||
        identify.status === "cancelled"
      ) {
        const reason: LlmSkipReason =
          identify?.status === "failed"
            ? "speakers_failed"
            : identify?.status === "cancelled"
              ? "cancelled"
              : "speakers_skipped";
        return skippedBecause(
          {
            status: "skipped",
            failure: null,
            verdicts: [],
            suggestions: [],
          },
          reason,
        );
      }
      const { verdicts, suggestions } = verifyEvidence(
        prepared,
        identify.proposals,
        identify.shown,
      );
      return { status: "ok", failure: null, verdicts, suggestions };
    },
  );
  return async (state: WorkflowStateType) => ({ verify: await guarded(state) });
}
