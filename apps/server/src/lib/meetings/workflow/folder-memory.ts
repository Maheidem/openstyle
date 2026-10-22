import type { DatabaseSync } from "node:sqlite";
import { createAppLogger } from "@openstyle/utils";
import {
  hitText as defaultHitText,
  retrieve as defaultRetrieve,
  type RetrievalHit,
} from "../../search/retrieve.js";
import { searchState as defaultSearchState } from "../../search/state.js";

const log = createAppLogger("meeting-workflow");

// Folder-scoped retrieval, "project memory" (issue #234,
// specs/local-semantic-search.md 8.3). `prepare` calls `loadFolderMemory`
// once for a meeting in a folder. The result gives:
// - Summary: one separate, labeled block of short snippets from the other
//   meetings of the folder. It is never mixed into the transcript.
// - Enhance: names and terms only, through the vocabulary of the correct
//   prompt. No chunk text reaches the correct prompt.
// - The run record: the model id, meeting ids and chunk ids. No text.
// Search off, an error or no hit gives null: the run is the same as before.

/** The label of the Summary block. */
export const FOLDER_MEMORY_LABEL =
  "Earlier meetings in this folder (for context only; do not copy; facts of THIS meeting come only from its transcript):";

/** Hits that `retrieve` returns. Meta hits are dropped after the call. */
export const FOLDER_MEMORY_RETRIEVE_K = 12;
/** Snippets in the Summary block, at most. */
export const FOLDER_MEMORY_SNIPPETS_MAX = 6;
/** Characters of one snippet, at most. */
export const FOLDER_MEMORY_SNIPPET_CHARS = 320;
/** Characters of the whole Summary block with its label, at most. */
export const FOLDER_MEMORY_BLOCK_MAX_CHARS = 2000;
/** Names and terms added to the vocabulary of the correct prompt, at most. */
export const FOLDER_TERMS_MAX = 20;
/** The retrieval can start the embedding worker. It never waits longer. */
export const FOLDER_MEMORY_TIMEOUT_MS = 60_000;

/** The kinds that project memory uses (MEM decision on #234, 2026-10-21). */
const MEMORY_KINDS = new Set<RetrievalHit["kind"]>(["summary", "transcript"]);

export interface FolderMemory {
  /** The embedding model of the index. */
  modelId: string;
  /** The meetings of the used chunks, distinct, in score order. */
  meetingIds: string[];
  /** The used chunks, in score order. */
  chunkIds: number[];
  /** The labeled Summary block. */
  summaryBlock: string;
  /** Names and terms for the vocabulary of the correct prompt. */
  terms: string[];
}

/** The record of a run: ids only (D13). */
export type FolderMemoryRecord = Pick<
  FolderMemory,
  "modelId" | "meetingIds" | "chunkIds"
>;

export interface FolderMemoryDeps {
  searchState: typeof defaultSearchState;
  retrieve: typeof defaultRetrieve;
  hitText: typeof defaultHitText;
}

const productionMemoryDeps: FolderMemoryDeps = {
  searchState: defaultSearchState,
  retrieve: defaultRetrieve,
  hitText: defaultHitText,
};

// ---------------------------------------------------------------------------
// Names and terms (Enhance)
// ---------------------------------------------------------------------------

/**
 * Capitalized words that are not names or terms. Day and month names are
 * dates, not spellings to fix. A lowercase compare.
 */
const NOT_TERMS = new Set([
  "i",
  "i'm",
  "i've",
  "i'll",
  "i'd",
  "ok",
  "okay",
  "yeah",
  "yes",
  "no",
  "mr",
  "mrs",
  "ms",
  "dr",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
  "domingo",
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
]);

/**
 * Common first words of a sentence. A capitalized first word that is not one
 * of them starts a name when a term word follows it ("Ana Souza said ...").
 * A lowercase compare.
 */
const SENTENCE_STARTERS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "then",
  "and",
  "but",
  "so",
  "or",
  "if",
  "when",
  "also",
  "we",
  "you",
  "he",
  "she",
  "they",
  "it",
  "our",
  "my",
  "your",
  "their",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "to",
  "after",
  "before",
  "o",
  "os",
  "as",
  "um",
  "uma",
  "e",
  "mas",
  "então",
  "nós",
  "eu",
  "ele",
  "ela",
  "eles",
  "no",
  "na",
  "em",
  "para",
  "com",
]);

/** Words of at most this many tokens make one term ("Ana Souza"). */
const TERM_WORDS_MAX = 3;

const WORD = /\p{L}[\p{L}\p{N}'’-]*/gu;

function isTermWord(word: string, sentenceStart: boolean): boolean {
  if (NOT_TERMS.has(word.toLowerCase())) return false;
  // Mixed case ("ecoATM", "iPhone") or an acronym ("CRM"): a term anywhere.
  if (/\p{Ll}/u.test(word.slice(0, 1)) && /\p{Lu}/u.test(word.slice(1))) {
    return true;
  }
  if (word.length >= 2 && !/\p{Ll}/u.test(word)) return true;
  // A capitalized word is a name, except as the first word of a sentence.
  return !sentenceStart && /^\p{Lu}/u.test(word);
}

/**
 * Proper nouns and product or project terms of the texts: capitalized words
 * that do not start a sentence, mixed-case words and acronyms. Consecutive
 * words make one term (up to 3 words). Deduplicated without case, most
 * frequent first, capped at `max`. The result holds words only, never a
 * sentence of the texts.
 */
export function extractFolderTerms(
  texts: readonly string[],
  max = FOLDER_TERMS_MAX,
): string[] {
  const counts = new Map<string, { term: string; n: number; first: number }>();
  let order = 0;
  const add = (words: string[]) => {
    for (let i = 0; i < words.length; i += TERM_WORDS_MAX) {
      const term = words.slice(i, i + TERM_WORDS_MAX).join(" ");
      if (term.length < 2) continue;
      const key = term.toLowerCase();
      const old = counts.get(key);
      if (old) old.n += 1;
      else counts.set(key, { term, n: 1, first: order++ });
    }
  };
  for (const text of texts) {
    // Sentences: an end mark, a line break, or a Markdown bullet.
    for (const sentence of text.split(/[.!?…:;]+\s+|\n+|\s[-*•]\s/)) {
      let run: string[] = [];
      const words = sentence.match(WORD) ?? [];
      words.forEach((word, i) => {
        const nameStart =
          i === 0 &&
          /^\p{Lu}/u.test(word) &&
          !SENTENCE_STARTERS.has(word.toLowerCase()) &&
          !NOT_TERMS.has(word.toLowerCase()) &&
          words[1] !== undefined &&
          isTermWord(words[1], false);
        if (nameStart || isTermWord(word, i === 0)) {
          run.push(word);
        } else {
          if (run.length > 0) add(run);
          run = [];
        }
      });
      if (run.length > 0) add(run);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.first - b.first)
    .slice(0, max)
    .map((c) => c.term);
}

/** Vocabulary of the correct prompt: own terms first, then new folder terms. */
export function mergeTerms(
  own: readonly string[],
  folder: readonly string[],
): string[] {
  const seen = new Set(own.map((t) => t.toLowerCase()));
  const out = [...own];
  for (const t of folder) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Summary block
// ---------------------------------------------------------------------------

/** YYYY-MM-DD in local time, or "unknown date". */
function dateOf(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown date";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface MemorySnippet {
  chunkId: number;
  meetingId: string;
  kind: "summary" | "transcript";
  /** Epoch ms of the meeting, or null. */
  at: number | null;
  text: string;
}

/**
 * The labeled block: one line for each snippet, oldest meeting first,
 * `- <date> (earlier summary|earlier transcript): <text>`. Lines that do not
 * fit FOLDER_MEMORY_BLOCK_MAX_CHARS are left out. Returns the block and the
 * snippets that it holds, or null when none fits.
 */
export function buildFolderMemoryBlock(
  snippets: readonly MemorySnippet[],
): { block: string; used: MemorySnippet[] } | null {
  const used: MemorySnippet[] = [];
  let size = FOLDER_MEMORY_LABEL.length;
  const lineOf = (s: MemorySnippet) =>
    `- ${dateOf(s.at)} (earlier ${s.kind}): ${s.text}`;
  for (const s of snippets) {
    const add = 1 + lineOf(s).length;
    if (size + add > FOLDER_MEMORY_BLOCK_MAX_CHARS) continue;
    used.push(s);
    size += add;
  }
  if (used.length === 0) return null;
  const lines = [...used]
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.chunkId - b.chunkId)
    .map(lineOf);
  return { block: [FOLDER_MEMORY_LABEL, ...lines].join("\n"), used };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * The other meetings of the folder, split by time. A meeting that started
 * after this one is "later": its facts did not exist yet, and the block label
 * says "Earlier meetings". A meeting with no time, or a run on a meeting with
 * no time, counts as earlier.
 */
function folderMeetingsByTime(
  db: DatabaseSync,
  folderId: string,
  meetingId: string,
): { earlier: string[]; later: string[] } {
  const self = meetingTime(db, meetingId);
  const rows = db
    .prepare(
      `SELECT id, COALESCE(started_at, created_at) AS at FROM meetings
        WHERE folder_id = ? AND id <> ? ORDER BY id`,
    )
    .all(folderId, meetingId) as { id: string; at: number | null }[];
  const earlier: string[] = [];
  const later: string[] = [];
  for (const r of rows) {
    if (self !== null && r.at !== null && r.at > self) later.push(r.id);
    else earlier.push(r.id);
  }
  return { earlier, later };
}

/** One index row of a used kind for one of the meetings. */
function hasIndexRows(
  db: DatabaseSync,
  meetingIds: readonly string[],
  modelId: string,
): boolean {
  if (meetingIds.length === 0) return false;
  const slots = meetingIds.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `SELECT 1 FROM meeting_chunks
          WHERE meeting_id IN (${slots}) AND model_id = ?
            AND kind IN ('summary', 'transcript')
          LIMIT 1`,
      )
      .get(...meetingIds, modelId) !== undefined
  );
}

function meetingTime(db: DatabaseSync, meetingId: string): number | null {
  const row = db
    .prepare(
      "SELECT COALESCE(started_at, created_at) AS at FROM meetings WHERE id = ?",
    )
    .get(meetingId) as { at: number | null } | undefined;
  return row?.at ?? null;
}

/**
 * Project memory of one meeting in a folder (8.3). One `retrieve` call with
 * the meeting as the query, scoped to its folder, its own chunks and the
 * chunks of later meetings excluded. Only when search is on and an earlier
 * meeting of the folder has index rows.
 * Never throws: an off state, an error or no hit gives null.
 */
export async function loadFolderMemory(
  db: DatabaseSync,
  input: { meetingId: string; folderId: string; signal?: AbortSignal },
  deps: FolderMemoryDeps = productionMemoryDeps,
): Promise<FolderMemory | null> {
  try {
    const st = deps.searchState();
    if (st.state !== "on") return null;
    const { earlier, later } = folderMeetingsByTime(
      db,
      input.folderId,
      input.meetingId,
    );
    if (!hasIndexRows(db, earlier, st.modelId)) return null;
    const timeout = AbortSignal.timeout(FOLDER_MEMORY_TIMEOUT_MS);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    const result = await deps.retrieve({
      query: { kind: "meeting", meetingId: input.meetingId },
      scope: { kind: "folder", folderId: input.folderId },
      k: FOLDER_MEMORY_RETRIEVE_K,
      excludeMeetingIds: [input.meetingId, ...later],
      signal,
    });
    if (result.status !== "ok") {
      log.info(
        `meeting ${input.meetingId}: folder memory skipped (${result.status === "off" ? result.reason : result.kind})`,
      );
      return null;
    }
    const snippets: MemorySnippet[] = [];
    for (const hit of result.hits) {
      if (snippets.length >= FOLDER_MEMORY_SNIPPETS_MAX) break;
      if (!MEMORY_KINDS.has(hit.kind)) continue;
      if (hit.meetingId === input.meetingId) continue;
      if (later.includes(hit.meetingId)) continue;
      const text = deps
        .hitText(hit, FOLDER_MEMORY_SNIPPET_CHARS)
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      snippets.push({
        chunkId: hit.chunkId,
        meetingId: hit.meetingId,
        kind: hit.kind as MemorySnippet["kind"],
        at: meetingTime(db, hit.meetingId),
        text,
      });
    }
    const built = buildFolderMemoryBlock(snippets);
    if (!built) return null;
    const memory: FolderMemory = {
      modelId: result.modelId,
      meetingIds: [...new Set(built.used.map((s) => s.meetingId))],
      chunkIds: built.used.map((s) => s.chunkId),
      summaryBlock: built.block,
      terms: extractFolderTerms(built.used.map((s) => s.text)),
    };
    log.info(
      `meeting ${input.meetingId}: folder memory ${memory.chunkIds.length} chunks from ${memory.meetingIds.length} meetings, ${memory.terms.length} terms`,
    );
    return memory;
  } catch (err) {
    log.warn(
      `meeting ${input.meetingId}: folder memory failed: ${(err as Error)?.name ?? "error"}`,
    );
    return null;
  }
}

/** The ids of a run's memory for the run record, or null. */
export function folderMemoryRecord(
  memory: FolderMemory | null | undefined,
): FolderMemoryRecord | null {
  if (!memory) return null;
  return {
    modelId: memory.modelId,
    meetingIds: memory.meetingIds,
    chunkIds: memory.chunkIds,
  };
}
