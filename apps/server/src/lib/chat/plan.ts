import { z } from "zod";
import {
  type Choices,
  datesFromQuestion,
  hasDateArgs,
  parseToolArgs,
  QUERY_MAX_CHARS,
  queryFor,
  type ToolCall,
  type ToolName,
} from "./choices.js";
import { normalizeText } from "./cites.js";
import { asksForList } from "./prompts.js";
import type { Intent, TurnScope } from "./types.js";

// Stage 2 (plan) and the structured fallback of stage 2b (specs/
// meeting-chat-agent.md 2.3). Code only, except the slot schema that the
// pipeline gives to the model. Dates always come from code.

// ---------------------------------------------------------------------------
// Plan table
// ---------------------------------------------------------------------------

type ScopeKind = TurnScope["kind"];

/**
 * The tools of the plan for an intent and a scope (spec 2.3 stage 2). The
 * scope "all" uses the "A" column. `other` acts as `lookup`.
 * Differences from the table, on purpose:
 * - temporal in scope M adds `search_chunks`: `get_transcript_window` alone
 *   needs a time window that nobody has yet ("When is the cutover?").
 * - aggregate in scope F and A adds `list_meetings`, for "how many meetings".
 * - write lists the 4 propose tools, as the T1 arm of P0 showed them.
 */
export function planFor(intent: Intent, scopeKind: ScopeKind): ToolName[] {
  const m = scopeKind === "meeting";
  const f = scopeKind === "folder";
  switch (intent) {
    case "who_said":
      return ["search_chunks", "get_transcript_window"];
    case "aggregate":
      return m
        ? ["list_action_items", "search_chunks"]
        : [
            "list_action_items",
            "list_people",
            "list_meetings",
            "search_chunks",
          ];
    case "temporal":
      return m
        ? ["search_chunks", "get_transcript_window", "get_meeting_summary"]
        : ["list_meetings", "get_meeting_summary", "search_chunks"];
    case "review":
      return ["list_decisions_questions", "list_action_items"];
    case "status":
      return m
        ? ["get_meeting_summary"]
        : f
          ? ["folder_status"]
          : ["list_meetings", "list_action_items"];
    case "write":
      return [
        "propose_action_item_change",
        "propose_retag",
        "propose_move",
        "propose_merge_people",
      ];
    default:
      return m ? ["search_chunks", "get_meeting_summary"] : ["search_chunks"];
  }
}

// ---------------------------------------------------------------------------
// Question words
// ---------------------------------------------------------------------------

const COUNT_WORDS = [
  "how many",
  "number of",
  "quantas",
  "quantos",
  "quantidade de",
  "cuantos",
  "cuantas",
  "wie viele",
  "combien",
  "quanti",
  "quante",
];

/** True when the question asks for a count (EN, PT, ES, DE, FR, IT). */
export function asksForCount(question: string): boolean {
  const t = ` ${normalizeText(question)} `;
  return COUNT_WORDS.some((w) => t.includes(` ${w} `));
}

const HOW_MANY_MEETINGS =
  /\b(how many|quantas?|quantos|cuantas?|cuantos|wie viele|combien de|quant[ei]) (\w+ )?(meetings?|reunioes|reuniones|besprechungen|reunions|riunioni)\b/;
const MENTION_VERB =
  /\b(named|mentioned|cited|citad[ao]s?|mencionad[ao]s?|nombrad[ao]s?|erwahnt|cite[es]?|nomm[eé]e?s?|menzionat[ae]|nominat[ae])\b/;

/**
 * "In how many meetings was Kestrel Hosting named?" gives the name. Else null.
 * Only a count of meetings with a mention verb counts: "How many meetings do
 * we have in Atlas?" names a project, not a mention.
 */
export function mentionPhrase(question: string): string | null {
  const t = normalizeText(question);
  if (!HOW_MANY_MEETINGS.test(t) || !MENTION_VERB.test(t)) return null;
  const toks = question.match(/[\p{L}\p{N}][\p{L}\p{N}.&'-]*/gu) ?? [];
  let best: string[] = [];
  let run: string[] = [];
  toks.forEach((w, i) => {
    if (i > 0 && /^\p{Lu}/u.test(w)) run.push(w);
    else {
      if (run.length > best.length) best = run;
      run = [];
    }
  });
  if (run.length > best.length) best = run;
  const phrase = best.join(" ");
  return phrase.length >= 3 ? phrase : null;
}

/** "when" in the 7 UI languages. */
const WHEN_RE = /\b(when|quando|cuando|wann|quand)\b|いつ/u;
/** A question about the speaker: "who" or a verb of speech, in the 7 UI languages. */
const WHO_RE =
  /\b(who|whom|quem|qui|wer|wen|quien|chi|say|said|says|disse|dijo|dito|gesagt|sagt|dit|detto|diceva|von wem)\b|誰|だれ|言って|言った/u;

/**
 * Code corrects three habits of a small router (P1.1, #402; the gold labels
 * follow the same rules):
 * - a lookup that names a day is temporal ("What did we decide in the
 *   meeting on August 25?"),
 * - a temporal with no date and no "when" is a lookup ("What is the current
 *   date for the launch?"),
 * - who_said with no "who" word is a lookup ("And which company confirmed
 *   that?").
 */
export function refineIntent(
  question: string,
  intent: Intent,
  todayMs: number,
): Intent {
  const q = fold(question);
  switch (intent) {
    case "lookup":
      // A day with a number ("on August 25"); "yesterday" alone stays a lookup.
      return /\d/.test(question) &&
        datesFromQuestion(question, todayMs).date_from
        ? "temporal"
        : intent;
    case "temporal":
      return !datesFromQuestion(question, todayMs).date_from &&
        !WHEN_RE.test(q) &&
        !MEETING_WORDS.test(q)
        ? "lookup"
        : intent;
    case "who_said":
      return WHO_RE.test(q) ? intent : "lookup";
    default:
      return intent;
  }
}

const MEETING_WORDS =
  /\b(meetings?|reunioes|reuniao|reuniones?|besprechung\w*|reunions?|riunion[ei])\b/;
const QUESTION_WORDS =
  /\b(questions?|perguntas?|preguntas?|fragen?|domand[ae])\b|質問|疑問|未解決/u;
const DONE_WORDS =
  /\b(done|completed|closed|concluidas?|concluidos?|feitas?|terminad[ao]s?|hechas?|erledigt\w*|terminees?|completat[ae])\b/;
const REOPEN_WORDS =
  /\b(reopen|reabr\w*|reabre|reabrir|wieder\s+offnen|rouvr\w*|riapr\w*)\b/;

const fold = (t: string) =>
  t
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export interface SlotValues {
  query?: string | null;
  /** A person id from the choices, or "none". */
  person?: string | null;
  /** An item label A1..A8, or "none". */
  item?: string | null;
  /** A meeting label M1..M12, or "none". */
  meeting?: string | null;
  /** A folder id, or "none". */
  folder?: string | null;
  kind?: "decision" | "open_question" | null;
  change?: "action_item" | "retag" | "move" | "merge_people" | null;
  tag?: string | null;
}

/** An earlier turn, as far as the slots need it. */
export interface PriorTurn {
  question: string;
  answer: string;
}

const FIRST_RE =
  /\b(first|primeira|primeiro|primera|primero|erste[nr]?|premi[eè]re|premier|prima|primo)\b|最初/iu;
/** Short answers that describe no topic. */
const EMPTY_ANSWER = /^(gave no answer|found nothing)$/i;

/**
 * The search query of a follow-up (spec 2.8 point 4). A follow-up has no topic
 * of its own ("and when is that due?"). The topic is in the earlier question,
 * and the earlier answer names the person or thing. Code builds the query from
 * both. "my first question" points to the first turn, else the last turn.
 */
export function followUpQuery(
  question: string,
  turns: readonly PriorTurn[],
  base?: string | null,
): string {
  const now = (base ?? "").trim() || question.trim();
  const ref = FIRST_RE.test(question) ? turns[0] : turns.at(-1);
  if (!ref) return queryFor(now, question);
  const answer = EMPTY_ANSWER.test(ref.answer.trim()) ? "" : ref.answer;
  const parts = [ref.question, answer, now].filter(
    (x): x is string => !!x && x.trim() !== "",
  );
  return [...new Set(parts)].join(" ").slice(0, QUERY_MAX_CHARS).trim();
}

/**
 * "decision" or "open_question" from the words of the question. Code decides:
 * a small model got it wrong for "Show all decisions" (P1.1 eval).
 */
export function reviewKind(question: string): "decision" | "open_question" {
  return QUESTION_WORDS.test(fold(question)) ? "open_question" : "decision";
}

/**
 * The slots that code fills with no model call: the query (the question, plus
 * the earlier turn of a follow-up) and the kind of a review. The model only
 * fills what a closed list holds (person, item, meeting, folder).
 */
export function defaultSlots(
  question: string,
  turns: readonly PriorTurn[] = [],
  intent?: Intent,
): SlotValues {
  return {
    query:
      turns.length > 0
        ? followUpQuery(question, turns)
        : queryFor(null, question),
    person: "none",
    item: "none",
    meeting: "none",
    folder: "none",
    kind: intent === "review" ? reviewKind(question) : null,
    change: null,
    tag: null,
  };
}

const oneOf = (values: string[]) =>
  z.enum(["none", ...values] as [string, ...string[]]);

/**
 * The zod schema of the slot fill for one intent, or null when the intent has
 * no slots (status). The fields are closed choices where code built a list.
 * There are NO date fields: code reads the dates from the question.
 */
export function slotZod(
  intent: Intent,
  ch: Choices,
): z.ZodType<SlotValues> | null {
  const person = oneOf(ch.people.map((p) => p.id));
  let shape: Record<string, z.ZodType>;
  switch (intent) {
    case "status":
      return null;
    case "aggregate":
      shape = { person };
      break;
    case "temporal":
      return null;
    case "review":
      // The kind comes from the words of the question (`reviewKind`).
      return null;
    case "write":
      shape = {
        change: z.enum(["action_item", "retag", "move", "merge_people"]),
        item: oneOf(ch.items.map((i) => i.label)),
        meeting: oneOf(ch.meetings.map((m) => m.label)),
        folder: oneOf(ch.folders.map((f) => f.id)),
        person,
        tag: z.string().max(40).nullable(),
      };
      break;
    default:
      // lookup, who_said: no model field. The search query is the question
      // (plus the earlier questions of a follow-up), made by code. In the P1
      // eval a model-written query was right in 66% of the slot calls and a
      // copy of the question in all of them.
      return null;
  }
  return z.object(shape).strict() as unknown as z.ZodType<SlotValues>;
}

const FIELD_HELP: Record<string, string> = {
  query:
    "query: the search words for the question (the topic, names and numbers, from the question itself)",
  person: "person: one id from the list, or none",
  item: "item: one label from the list, or none",
  meeting: "meeting: one label from the list, or none",
  folder: "folder: one id from the list, or none",
  change: "change: action_item (done or reopen), retag, move or merge_people",
  tag: "tag: the tag name to add, or null",
};

function choiceText(intent: Intent, ch: Choices): string {
  const out: string[] = [];
  if (["aggregate", "write"].includes(intent) && ch.people.length)
    out.push(`person: ${ch.people.map((p) => `${p.id}=${p.name}`).join("; ")}`);
  if (intent === "write") {
    if (ch.items.length)
      out.push(
        `item: ${ch.items.map((i) => `${i.label}="${i.text}"`).join("; ")}`,
      );
    if (ch.meetings.length)
      out.push(
        `meeting: ${ch.meetings.map((m) => `${m.label}=${m.text}`).join("; ")}`,
      );
    if (ch.folders.length)
      out.push(
        `folder: ${ch.folders.map((f) => `${f.id}=${f.name}`).join("; ")}`,
      );
  }
  return out.join("\n");
}

/** The system prompt of the slot fill. It names no date field. */
export function slotSystem(
  intent: Intent,
  ch: Choices,
  todayIso: string,
): string {
  const shape = slotZod(intent, ch);
  const keys = shape
    ? Object.keys((shape as unknown as z.ZodObject<z.ZodRawShape>).shape)
    : [];
  return [
    `Fill the fields for a question about meeting notes. Intent: ${intent}.`,
    `Today is ${todayIso}. Do not write dates: code reads them from the question.`,
    ...keys.map((k) => FIELD_HELP[k]),
    choiceText(intent, ch),
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Planned calls (structured fallback path)
// ---------------------------------------------------------------------------

const none = (v: string | null | undefined): string | undefined =>
  v && v !== "none" ? v : undefined;

/** The 3 longest words of a query, in their order. Round 3 uses it. */
function longestWords(query: string): string {
  const words = query.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  if (words.length <= 3) return query;
  const top = new Set(
    words
      .map((w, i) => ({ w, i }))
      .sort((a, b) => b.w.length - a.w.length || a.i - b.i)
      .slice(0, 3)
      .map((x) => x.i),
  );
  return words.filter((_, i) => top.has(i)).join(" ");
}

/**
 * The tool calls of one round for the structured path (spec 2.3, fallback
 * chain). Round 1 uses the dates of the question. Round 2 raises k to 20 and
 * drops the dates. Round 3 is round 2 with the query cut to its 3 longest
 * words. No call is returned when a required slot is missing.
 * `aggregate` gives `list_action_items`, or `list_meetings` when the question
 * asks how many meetings. The pipeline turns a list into a count block when
 * `asksForCount` is true.
 */
export function plannedCalls(
  intent: Intent,
  scope: TurnScope,
  slots: SlotValues,
  choices: Choices,
  question: string,
  todayMs: number,
  round: number,
): ToolCall[] {
  const r = Math.min(Math.max(round, 1), 3);
  const q = fold(question);
  const dates = r === 1 ? datesFromQuestion(question, todayMs) : null;
  const meetingId =
    scope.kind === "meeting"
      ? (scope.id ?? undefined)
      : choices.meetings.find((m) => m.label === none(slots.meeting))?.id;

  const calls: { tool: ToolName; args: Record<string, unknown> }[] = [];
  const search = () => {
    let query = queryFor(slots.query, question);
    if (r === 3) query = longestWords(query);
    calls.push({
      tool: "search_chunks",
      args: {
        query,
        ...(meetingId ? { meeting_ids: [meetingId] } : {}),
        ...(r >= 2 ? { k: 20 } : {}),
      },
    });
  };

  switch (intent) {
    case "who_said":
    case "lookup":
    case "other":
      search();
      break;
    case "temporal":
      // A list of meetings in a range. A question about one topic on a date reads text.
      if (
        scope.kind !== "meeting" &&
        dates?.date_from &&
        asksForList(question) &&
        MEETING_WORDS.test(q)
      ) {
        calls.push({ tool: "list_meetings", args: { limit: 50 } });
      } else search();
      break;
    case "aggregate":
      if (
        scope.kind !== "meeting" &&
        MEETING_WORDS.test(q) &&
        asksForCount(question)
      ) {
        calls.push({ tool: "list_meetings", args: { limit: 50 } });
      } else {
        calls.push({
          tool: "list_action_items",
          args: {
            status: DONE_WORDS.test(q) ? "done" : "open",
            ...(none(slots.person) &&
            choices.people.some((p) => p.id === slots.person)
              ? { person_id: slots.person }
              : {}),
            ...(meetingId ? { meeting_id: meetingId } : {}),
          },
        });
      }
      break;
    case "review":
      calls.push({
        tool: "list_decisions_questions",
        args: {
          kind: slots.kind ?? reviewKind(question),
          ...(meetingId ? { meeting_id: meetingId } : {}),
          limit: 50,
        },
      });
      break;
    case "status":
      if (scope.kind === "meeting" && scope.id) {
        calls.push({
          tool: "get_meeting_summary",
          args: { meeting_id: scope.id },
        });
      } else if (scope.kind === "folder") {
        calls.push({ tool: "folder_status", args: {} });
      } else {
        calls.push({ tool: "list_meetings", args: { limit: 20 } });
        calls.push({ tool: "list_action_items", args: { status: "open" } });
      }
      break;
    case "write":
      if (r === 1)
        calls.push(...writeCalls(slots, choices, q, question, todayMs));
      break;
  }

  const out: ToolCall[] = [];
  for (const c of calls) {
    const args = { ...c.args };
    if (dates && hasDateArgs(c.tool)) {
      if (dates.date_from) args.date_from = dates.date_from;
      if (dates.date_to) args.date_to = dates.date_to;
    }
    const checked = parseToolArgs(c.tool, args);
    if (checked.ok) out.push({ tool: c.tool, args: checked.args });
  }
  return out;
}

function writeCalls(
  slots: SlotValues,
  ch: Choices,
  folded: string,
  question: string,
  todayMs: number,
): { tool: ToolName; args: Record<string, unknown> }[] {
  switch (slots.change) {
    case "action_item": {
      const id = ch.items.find((i) => i.label === none(slots.item))?.id;
      return id
        ? [
            {
              tool: "propose_action_item_change",
              args: { item_id: id, done: !REOPEN_WORDS.test(folded) },
            },
          ]
        : [];
    }
    case "retag": {
      const tag = (slots.tag ?? "").trim();
      let ids: string[] = ch.meetings
        .filter((m) => m.label === none(slots.meeting))
        .map((m) => m.id);
      if (ids.length === 0) {
        const d = datesFromQuestion(question, todayMs);
        if (d.date_from && d.date_to) {
          ids = ch.meetings
            .filter((m) => {
              const day = /\((\d{4}-\d{2}-\d{2})\)$/.exec(m.text)?.[1];
              return (
                day !== undefined &&
                day >= (d.date_from as string) &&
                day <= (d.date_to as string)
              );
            })
            .map((m) => m.id);
        }
      }
      return tag && ids.length
        ? [{ tool: "propose_retag", args: { meeting_ids: ids, tag } }]
        : [];
    }
    case "move": {
      const meeting = ch.meetings.find((m) => m.label === none(slots.meeting));
      const folder = ch.folders.find((f) => f.id === none(slots.folder));
      return meeting && folder
        ? [
            {
              tool: "propose_move",
              args: { meeting_id: meeting.id, folder_id: folder.id },
            },
          ]
        : [];
    }
    case "merge_people": {
      const p = ch.people.find((x) => x.id === none(slots.person));
      return p
        ? [{ tool: "propose_merge_people", args: { person_ids: [p.id] } }]
        : [];
    }
    default:
      return [];
  }
}
