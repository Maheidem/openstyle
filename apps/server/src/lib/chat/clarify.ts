import type { DatabaseSync } from "node:sqlite";
import type { ChatBlock } from "@openstyle/validations";
import { normalizeText } from "./cites.js";
import { listPeopleInScope } from "./tools.js";
import type { TurnScope } from "./types.js";

// The clarifying question (specs/meeting-chat-agent.md 11.8, D20). CODE finds
// the ambiguity; no LLM call is made. At most one clarify for each question,
// never two in a row, and never when the page fixes the scope and the question
// is answerable. Recall is limited on purpose: a wrong question costs more
// than a missed one.

export type ClarifyBlock = Extract<ChatBlock, { kind: "clarify" }>;

/** Chips of one clarify block, at most (the schema allows 6). */
const MAX_OPTIONS = 5;

/** Words that carry no topic. English, plus the few that are the same in PT and ES. */
const STOP = new Set(
  (
    "a an the of for in on at to is are was were be been do does did can could would should will " +
    "what whats who whom when where which how why and or but so if it its this that these those " +
    "me my we our us you your they them their i he she his her about with from by as up out " +
    "o a os as de da do em um uma que e el la los las un una y con por para"
  ).split(" "),
);
/** Words that ask "how are things" and name no topic and no intent. */
const VAGUE = new Set(
  (
    "status update updates news going happening happened new anything something nothing everything " +
    "stuff thing things more else tell show give say said please just now latest recent lately " +
    "current currently so far today next one ones any all"
  ).split(" "),
);

const words = (q: string): string[] =>
  normalizeText(q)
    .split(" ")
    .filter((w) => w.length > 0);

/** The words of a question that name a topic. */
export function topicWords(q: string): string[] {
  return words(q).filter((w) => !STOP.has(w) && !VAGUE.has(w) && w.length > 1);
}

interface FolderRow {
  id: string;
  name: string;
  meetings: number;
}

function folderRows(db: DatabaseSync): FolderRow[] {
  return db
    .prepare(
      `SELECT f.id, f.name, COUNT(m.id) AS meetings
         FROM meeting_folders f LEFT JOIN meetings m ON m.folder_id = f.id
        GROUP BY f.id ORDER BY f.name`,
    )
    .all() as unknown as FolderRow[];
}

const INTENT_OPTIONS: ClarifyBlock["options"] = [
  {
    label: "Summary",
    key: "summary",
    ask: "Give me a summary of my recent meetings.",
  },
  {
    label: "Decisions",
    key: "decisions",
    ask: "What decisions were made in my recent meetings?",
  },
  {
    label: "Next steps",
    key: "next_steps",
    ask: "What are the next steps from my recent meetings?",
  },
  {
    label: "Open questions",
    key: "open_questions",
    ask: "What questions are still open in my recent meetings?",
  },
];

/** (a) The scope is Everything and the question names a word that several folders share. */
function folderAmbiguity(
  db: DatabaseSync,
  question: string,
): ClarifyBlock | null {
  const qNorm = ` ${normalizeText(question)} `;
  const qTopic = new Set(topicWords(question));
  if (qTopic.size === 0) return null;
  const folders = folderRows(db).filter((f) => f.meetings > 0);
  if (folders.length < 2) return null;
  const toks = (f: FolderRow) => [...new Set(topicWords(f.name))];
  // A word in more than half of the folder names ("project") says nothing.
  const df = new Map<string, number>();
  for (const f of folders)
    for (const w of toks(f)) df.set(w, (df.get(w) ?? 0) + 1);
  const generic = (w: string) =>
    folders.length >= 4 && (df.get(w) ?? 0) * 2 > folders.length;
  const scored = folders
    .map((f) => {
      const shared = toks(f).filter((w) => qTopic.has(w) && !generic(w));
      return {
        f,
        shared,
        full: qNorm.includes(` ${normalizeText(f.name)} `),
      };
    })
    .filter((x) => x.shared.length > 0);
  if (scored.length < 2) return null;
  // The question names one folder in full: not ambiguous.
  if (scored.some((x) => x.full)) return null;
  const best = Math.max(...scored.map((x) => x.shared.length));
  const top = scored.filter((x) => x.shared.length === best);
  // A folder that matches more words than the others is the clear pick.
  if (top.length < 2) return null;
  const subject = top[0]?.shared[0] ?? null;
  return {
    kind: "clarify",
    why: "scope",
    subject,
    options: top.slice(0, MAX_OPTIONS).map((x) => ({
      label: x.f.name,
      key: null,
      ask: `${question.trim()} (in the folder "${x.f.name}")`.slice(0, 1000),
    })),
  };
}

/** (c) A first name matches several people and no full name is in the question. */
function personAmbiguity(
  db: DatabaseSync,
  scope: TurnScope,
  question: string,
): ClarifyBlock | null {
  const qNorm = ` ${normalizeText(question)} `;
  const people = listPeopleInScope(db, scope).filter(
    (p) => p.name.trim().split(/\s+/).length >= 2,
  );
  const byFirst = new Map<string, string[]>();
  for (const p of people) {
    const first = normalizeText(p.name).split(" ")[0] ?? "";
    if (first.length < 3 || STOP.has(first) || VAGUE.has(first)) continue;
    byFirst.set(first, [...(byFirst.get(first) ?? []), p.name]);
  }
  for (const [first, names] of byFirst) {
    if (names.length < 2 || !qNorm.includes(` ${first} `)) continue;
    // A full name in the question settles it.
    if (names.some((n) => qNorm.includes(` ${normalizeText(n)} `))) continue;
    const re = new RegExp(`\\b${first}\\b`, "iu");
    return {
      kind: "clarify",
      why: "person",
      subject: first.charAt(0).toUpperCase() + first.slice(1),
      options: names.slice(0, MAX_OPTIONS).map((n) => ({
        label: n,
        key: null,
        ask: (re.test(question)
          ? question.trim().replace(re, n)
          : `${question.trim()} (${n})`
        ).slice(0, 1000),
      })),
    };
  }
  return null;
}

/** (b) No topic and no intent, with no earlier question in the thread. */
function intentAmbiguity(question: string): ClarifyBlock | null {
  if (topicWords(question).length > 0) return null;
  return {
    kind: "clarify",
    why: "intent",
    subject: null,
    options: INTENT_OPTIONS,
  };
}

export interface ClarifyInput {
  db: DatabaseSync;
  scope: TurnScope;
  question: string;
  /** The stored blocks of the last assistant message, and whether the thread has an earlier user question. */
  lastAssistantBlocks: readonly ChatBlock[];
  hasEarlierQuestion: boolean;
}

/**
 * The first rule that fires wins: person (c), folder (a), intent (b). The
 * folder and intent rules need scope Everything: a page that fixes the scope
 * has answerable questions.
 */
export function detectClarify(i: ClarifyInput): ClarifyBlock | null {
  if (i.lastAssistantBlocks.some((b) => b.kind === "clarify")) return null;
  const person = personAmbiguity(i.db, i.scope, i.question);
  if (person) return person;
  if (i.scope.kind !== "all") return null;
  const folder = folderAmbiguity(i.db, i.question);
  if (folder) return folder;
  if (!i.hasEarlierQuestion) return intentAmbiguity(i.question);
  return null;
}

/** Words of a broad question that name no topic ("an overview of everything"). */
const GLOBAL_WORDS = new Set(
  (
    "overview summary summarize summarise story history recap everything across projects project " +
    "meetings meeting happened happening details detail background onboarding catch tell " +
    "decisions decided discussed talked"
  ).split(" "),
);

/** A broad question over Everything with no topic word: the digest reads every meeting. */
export function isGlobalQuestion(q: string): boolean {
  const t = topicWords(q);
  return t.every((w) => GLOBAL_WORDS.has(w));
}
