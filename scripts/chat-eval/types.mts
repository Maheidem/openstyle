// types.mts: the data shapes of the chat eval (specs/meeting-chat-agent.md
// section 8). The corpus and the gold set are fictional. Every key is made
// by code from the same facts that make the transcripts, so a key is fixed
// and no LLM judge decides a result (8.1).

export type Lang = "en" | "pt";
export type MeetingLang = "en" | "pt" | "mixed";
export type Intent =
  | "lookup"
  | "who_said"
  | "aggregate"
  | "temporal"
  | "review"
  | "status"
  | "write"
  | "other";
export const INTENTS: readonly Intent[] = [
  "lookup",
  "who_said",
  "aggregate",
  "temporal",
  "review",
  "status",
  "write",
  "other",
];

export interface Person {
  id: string;
  first: string;
  full: string;
  /** Short spelling variants as people write them (initials, nickname). */
  variants: string[];
  /** How an ASR engine spells the full name. Used in ASR-error queries. */
  asr: string;
}

export interface Segment {
  id: string;
  idx: number;
  source: "mic" | "system";
  /** System channel label "1".."4"; null for the mic ("Me"). */
  speakerLabel: string | null;
  /** null = the account owner on the mic. */
  personId: string | null;
  startMs: number;
  endMs: number;
  text: string;
  lang: Lang;
  /** Id of the planted fact this line carries, if any. */
  factId: string | null;
}

export interface ActionItem {
  id: string;
  task: string;
  owner: string | null;
  ownerPersonId: string | null;
  due: string | null;
  done: boolean;
  factId: string;
}

export interface SummaryItem {
  id: string;
  text: string;
  factId: string;
}

export interface Meeting {
  id: string;
  folderId: string | null;
  title: string;
  startedAt: number;
  durationMs: number;
  lang: MeetingLang;
  /** Language of the summary text. */
  summaryLang: Lang;
  tags: string[];
  speakers: { label: string; personId: string; displayName: string }[];
  segments: Segment[];
  overview: string;
  keyPoints: string[];
  decisions: SummaryItem[];
  actionItems: ActionItem[];
  openQuestions: SummaryItem[];
}

export interface Folder {
  id: string;
  name: string;
  description: string;
  teamPersonIds: string[];
}

export interface Fact {
  id: string;
  meetingId: string;
  /** Index of the segment that carries the fact. */
  segmentIdx: number;
  family: string;
  /** Subject key, shared by an older and a newer version (knowledge update). */
  subject: string;
  /** Accepted answer tokens, already normalized (see keys.mts). */
  value: string;
  speakerPersonId: string | null;
  lang: Lang;
  /** True when the transcript line holds the ASR spelling of a name. */
  asrNameLine: boolean;
  /** The raw slot values the line was made from (gold.mts reads them). */
  slots: Record<string, unknown>;
  /** 0 for a first version; 1 for a later version (an update of the first). */
  version: 0 | 1;
}

export interface Corpus {
  seed: number;
  /** The clock of the corpus: "last week" is relative to this day. */
  todayMs: number;
  ownerName: string;
  people: Person[];
  folders: Folder[];
  meetings: Meeting[];
  facts: Fact[];
}

// --- Answer keys ----------------------------------------------------------

/** All groups must match (a group matches when any alternative is in the answer). */
export interface TextKey {
  kind: "text";
  must: string[][];
  mustNot: string[];
}
export interface NotFoundKey {
  kind: "not_found";
}
export interface SetKey {
  kind: "set";
  /** Item ids, meeting ids or person ids. */
  ids: string[];
}
export interface CountKey {
  kind: "count";
  n: number;
}
export interface WriteKey {
  kind: "write";
  change: "action_item" | "retag" | "move" | "merge_people";
  ids: string[];
  /** For move: the target folder id. For retag: tags to add. For action_item: done flag. */
  arg: string | boolean | string[] | null;
}
export type AnswerKey = TextKey | NotFoundKey | SetKey | CountKey | WriteKey;

export type QuestionType =
  | "lookup"
  | "who_said"
  | "aggregation"
  | "count"
  | "temporal"
  | "knowledge_update"
  | "not_answerable"
  | "scope_trap"
  | "follow_up"
  | "long_thread"
  | "write";

export interface Scope {
  kind: "meeting" | "folder" | "all";
  id: string | null;
}

export interface Turn {
  q: string;
  /** The gold answer of an earlier turn (the harness shows it as history). */
  a: string;
}

export interface Question {
  id: string;
  type: QuestionType;
  lang: Lang;
  scope: Scope;
  text: string;
  /** Earlier turns of a follow-up or a long thread. */
  history: Turn[];
  intent: Intent;
  /** Tools the plan table (spec 2.2) must pick for this question, in order. */
  tools: string[];
  /** Gold tool arguments the router/native arms must produce (subset check). */
  args: Record<string, string | string[] | null>;
  key: AnswerKey;
  /** Gold evidence: the segments that carry the answer. */
  gold: { meetingId: string; segmentIdx: number }[];
}

export type RetrievalSlice =
  | "names"
  | "numbers"
  | "concept"
  | "asr_names"
  | "date";

export interface RetrievalQuery {
  id: string;
  slice: RetrievalSlice;
  lang: Lang;
  text: string;
  scope: Scope;
  dateFrom: string | null;
  dateTo: string | null;
  gold: { meetingId: string; segmentIdx: number }[];
}

export interface GoldSet {
  questions: Question[];
  retrieval: RetrievalQuery[];
}
