import type { ChatBlock, ChatCite } from "@openstyle/validations";
import { z } from "zod";
import {
  DIG_ITEM_SCHEMA,
  DIG_ITEM_SYSTEM,
  DIG_MAX_TOKENS,
  DIG_MEETING_SCHEMA,
  DIG_MEETING_SYSTEM,
  digItemUser,
  digMeetingUser,
} from "../prompts.js";
import { HARD_CAP_CALLS, SCORE_FLOOR, type Turn } from "../turn.js";
import type { Source } from "../types.js";
import { ANSWER_RESERVE, type Lead } from "./research.js";

// The workers of the research mode (specs/meeting-chat-agent.md 11.9.16). The
// graph sends one worker for each open item ("why are these open?") or for
// each relevant meeting ("who pushed for it, and why?"), the orchestrator-
// worker pattern of LangGraph. A worker searches, makes ONE structured model
// call, and returns a record. Code checks the record against the sources it
// was given: a reason that no source holds is dropped, never shown.

/** Sources one worker shows to the model. */
const WORKER_SOURCES = 5;
const SOURCE_CHARS = 520;

export const recordSchema = z.object({
  /** The lead (item worker) or the meeting (meeting worker) that this record answers. */
  key: z.string(),
  kind: z.enum(["item", "meeting"]),
  /** The text of the item, or the title of the meeting. */
  subject: z.string(),
  who: z.string(),
  what: z.string(),
  /** The reason. Empty when no source shows one. */
  why: z.string(),
  /** Label of the source that shows it (checked), else empty. */
  source: z.string(),
  /** An item can have several reasons, each with its own checked source. */
  reasons: z.array(z.object({ why: z.string(), source: z.string() })),
  /** Label of the cite for the subject itself (the item's own meeting summary), else empty. */
  subjectSource: z.string(),
  startedAt: z.number().nullable(),
  meetingId: z.string().nullable(),
});
export type WorkerRecord = z.infer<typeof recordSchema>;

const fold = (q: string): string =>
  q
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

const wordList = (q: string): string[] =>
  fold(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 || /\d/.test(w));

const numbersOf = (q: string): string[] => fold(q).match(/\d[\d.,]*/gu) ?? [];

/**
 * The record is supported by the source: the label is one the worker was
 * given, most words of the quote are in the source, and every number of the
 * reason or the quote is in the source.
 */
export function supported(
  given: ReadonlyMap<string, string>,
  label: string,
  quote: string,
  claim: string,
): boolean {
  const text = given.get(label.trim());
  if (!text) return false;
  const src = fold(text);
  const q = wordList(quote);
  if (q.length < 3) return false;
  const srcWords = new Set(wordList(text));
  const hit = q.filter((w) => srcWords.has(w)).length;
  if (hit / q.length < 0.6) return false;
  return [...numbersOf(claim), ...numbersOf(quote)].every((n) =>
    src.includes(n.replace(/[.,]+$/u, "")),
  );
}

/** Words that name nothing: they do not tie a reason to an item. */
const GENERIC = new Set(
  "the and for with that this from have has had are was were not but still will would should could need needs needed about into over under than then them they what when where which who why how our your their there been being also only more most some such very just get got make made take took send sent pay paid book update follow plan confirm check review fix get give start finish run set use add open done item items task tasks que para com uma uns umas dos das nos nas por mais ainda sobre como foi ser tem ter fazer precisa los las una unos con por para pero sobre est".split(
    " ",
  ),
);

const contentWords = (q: string): Set<string> =>
  new Set(wordList(q).filter((w) => w.length >= 4 && !GENERIC.has(w)));

/**
 * The reason is about THIS item and is not a restatement of it: the quote or
 * the reason shares a content word with the item, and the reason has at least
 * one content word that the item does not have.
 */
export function aboutItem(
  item: string,
  reason: string,
  quote: string,
): boolean {
  const it = contentWords(item);
  const r = contentWords(reason);
  const q = contentWords(quote);
  const shared = [...it].some((w) => r.has(w) || q.has(w));
  const fresh = [...r].filter((w) => !it.has(w)).length;
  return shared && fresh >= 1;
}

const sourceLines = (picked: readonly Source[]): string =>
  picked
    .map((s) => {
      const day =
        s.startedAt === null
          ? ""
          : ` (${new Date(s.startedAt).toISOString().slice(0, 10)})`;
      return `[${s.label}] ${s.title ?? "meeting"}${day}: ${s.text.replace(/\s+/g, " ").slice(0, SOURCE_CHARS)}`;
    })
    .join("\n");

/** Sources of a search for the worker: transcript first, then the rest, best first. */
function pick(
  t: Turn,
  labels: readonly string[],
  skip: (s: Source) => boolean = () => false,
): Source[] {
  const all = labels
    .map((l) => t.sources.get(l))
    .filter((s): s is Source => !!s && s.kind !== "folder" && !skip(s));
  return [
    ...all.filter((s) => s.kind === "transcript"),
    ...all.filter((s) => s.kind !== "transcript"),
  ].slice(0, WORKER_SOURCES);
}

/** True when the call cap leaves no room for another worker call. */
const noRoom = (t: Turn): boolean =>
  t.input.llm.calls() >= HARD_CAP_CALLS - ANSWER_RESERVE;

/** The cite of the item itself: the summary line of its meeting that holds its words. */
async function itemSource(t: Turn, lead: Lead): Promise<string> {
  if (!lead.meetingId) return "";
  const r = await t.run({
    tool: "get_meeting_summary",
    args: { meeting_id: lead.meetingId },
  });
  if (!r) return "";
  const want = new Set(wordList(lead.text));
  let best = { label: "", score: 0 };
  for (const l of r.labels) {
    const s = t.sources.get(l);
    if (!s || s.kind !== "item") continue;
    const w = wordList(s.text);
    const score = w.filter((x) => want.has(x)).length / Math.max(1, want.size);
    if (score > best.score) best = { label: l, score };
  }
  return best.score >= 0.5 ? best.label : "";
}

/** Item worker: why is THIS item open? */
export async function itemWorker(t: Turn, lead: Lead): Promise<WorkerRecord> {
  const started = Date.now();
  const base: WorkerRecord = {
    key: lead.id,
    kind: "item",
    subject: lead.text,
    who: "",
    what: "",
    why: "",
    source: "",
    reasons: [],
    subjectSource: "",
    startedAt: null,
    meetingId: lead.meetingId,
  };
  const subjectSource = await itemSource(t, lead);
  const search = await t.run({
    tool: "search_chunks",
    args: { query: lead.text.slice(0, 200) },
  });
  const floor = t.input.scoreFloor ?? SCORE_FLOOR;
  const strong =
    search &&
    (floor <= 0 || search.topScore === null || search.topScore >= floor);
  // The summary line of the item itself shows no reason: it stays out.
  const picked = strong
    ? pick(t, search.labels, (s) => s.kind === "item" && s.itemId !== null)
    : [];
  // An item with no summary line of its own cites the closest excerpt.
  let rec = {
    ...base,
    subjectSource: subjectSource || (picked[0]?.label ?? ""),
  };
  if (picked.length > 0 && !noRoom(t)) {
    try {
      const r = await t.input.llm.structured({
        step: "chatDig",
        unitKey: `dig-${lead.id}`,
        schema: DIG_ITEM_SCHEMA,
        system: DIG_ITEM_SYSTEM,
        messages: [
          {
            role: "user",
            content: digItemUser(lead.text, sourceLines(picked)),
          },
        ],
        maxOutputTokens: DIG_MAX_TOKENS,
      });
      const given = new Map(picked.map((s) => [s.label, s.text]));
      const seen = new Set<string>();
      const reasons: { why: string; source: string }[] = [];
      for (const o of r.object.reasons) {
        const why = o.reason.trim();
        const src = o.source.trim();
        if (
          why === "" ||
          seen.has(src) ||
          !supported(given, src, o.quote, why) ||
          !aboutItem(lead.text, why, o.quote)
        ) {
          continue;
        }
        seen.add(src);
        reasons.push({ why, source: src });
      }
      if (reasons.length > 0) {
        const s = t.sources.get(reasons[0]?.source ?? "") as Source;
        rec = {
          ...rec,
          why: reasons.map((x) => x.why).join("; "),
          source: s.label,
          reasons,
          startedAt: s.startedAt,
          meetingId: s.meetingId,
        };
      }
    } catch (e) {
      if (t.input.signal.aborted) throw e;
    }
  }
  t.step(
    "research",
    `worker:item:${rec.why === "" ? "none" : "reason"}`,
    started,
    picked.length,
    lead.id,
  );
  return rec;
}

/** Meeting worker: what does THIS meeting say about the question? */
export async function meetingWorker(
  t: Turn,
  key: string,
  meetingId: string,
  title: string,
  question: string,
  query: string,
): Promise<WorkerRecord> {
  const started = Date.now();
  const base: WorkerRecord = {
    key,
    kind: "meeting",
    subject: title,
    who: "",
    what: "",
    why: "",
    source: "",
    reasons: [],
    subjectSource: "",
    startedAt: null,
    meetingId,
  };
  const search = await t.run({
    tool: "search_chunks",
    args: { query: query.slice(0, 200), meeting_ids: [meetingId], k: 3 },
  });
  const picked = search ? pick(t, search.labels) : [];
  let rec = base;
  if (picked.length > 0 && !noRoom(t)) {
    try {
      const r = await t.input.llm.structured({
        step: "chatDig",
        unitKey: `dig-${key}`,
        schema: DIG_MEETING_SCHEMA,
        system: DIG_MEETING_SYSTEM,
        messages: [
          {
            role: "user",
            content: digMeetingUser(
              question.slice(0, 300),
              sourceLines(picked),
            ),
          },
        ],
        maxOutputTokens: DIG_MAX_TOKENS,
      });
      const o = r.object;
      const given = new Map(picked.map((s) => [s.label, s.text]));
      const claim = `${o.what} ${o.why}`;
      if (
        (o.what.trim() !== "" || o.why.trim() !== "") &&
        supported(given, o.source, o.quote, claim)
      ) {
        const s = t.sources.get(o.source.trim()) as Source;
        rec = {
          ...rec,
          who: o.who.trim(),
          what: o.what.trim(),
          why: o.why.trim(),
          source: s.label,
          startedAt: s.startedAt,
        };
      }
    } catch (e) {
      if (t.input.signal.aborted) throw e;
    }
  }
  t.step(
    "research",
    `worker:meeting:${rec.source === "" ? "none" : "record"}`,
    started,
    picked.length,
    meetingId,
  );
  return rec;
}

// ---- Compose (code, no model) ----

/** "No reason found for this item", in the 6 languages that code can tell apart. */
const NO_REASON: Record<string, string> = {
  en: "no reason found in the meetings",
  pt: "nenhum motivo encontrado nas reuniões",
  es: "no se encontró ningún motivo en las reuniones",
  fr: "aucune raison trouvée dans les réunions",
  de: "kein Grund in den Meetings gefunden",
  it: "nessun motivo trovato nelle riunioni",
};

const LANG_WORDS: [string, RegExp][] = [
  [
    "pt",
    /\b(?:que|nao|uma|para|com|dos|das|esta|sao|ainda|reuniao|voce|por que)\b/u,
  ],
  [
    "es",
    /\b(?:que|una|para|con|los|las|esta|son|todavia|reunion|porque|sin)\b/u,
  ],
  ["fr", /\b(?:les|des|une|pour|avec|est|sont|pas|encore|reunion|pourquoi)\b/u],
  ["de", /\b(?:und|der|die|das|nicht|ein|eine|mit|noch|warum|ist)\b/u],
  ["it", /\b(?:che|non|una|per|con|gli|sono|ancora|riunione|perche)\b/u],
];

/** The language of a text, by common words. English when no other language wins. */
export function langOf(text: string): string {
  const f = fold(text);
  let best = { lang: "en", n: 0 };
  for (const [lang, re] of LANG_WORDS) {
    const n = f.match(new RegExp(re.source, "gu"))?.length ?? 0;
    if (n > best.n) best = { lang, n };
  }
  const en =
    f.match(/\b(?:the|and|is|are|was|for|with|not|still|why|that)\b/gu)
      ?.length ?? 0;
  return best.n > en ? best.lang : "en";
}

/** The bullets of a "why are these open?" answer, one for each item. */
export function composeReasons(
  t: Turn,
  records: readonly WorkerRecord[],
  lang: string,
): { blocks: ChatBlock[]; cites: ChatCite[] } {
  const none = NO_REASON[lang] ?? NO_REASON.en;
  const cites = new Map<string, ChatCite>();
  const blocks: ChatBlock[] = [];
  // A record with no cite of its own takes the first cite that any record has.
  const spare = records
    .flatMap((r) => [r.source, r.subjectSource])
    .find((l) => l !== "" && t.sources.get(l));
  for (const r of records) {
    const labels = [
      ...(r.reasons.length > 0 ? r.reasons.map((x) => x.source) : [r.source]),
      r.subjectSource,
    ].filter((l, i, a) => l !== "" && a.indexOf(l) === i);
    if (labels.length === 0 && spare) labels.push(spare);
    for (const l of labels) {
      const c = t.sources.toCite(l);
      if (c) cites.set(l, c);
    }
    const kept = labels.filter((l) => cites.has(l));
    if (kept.length === 0) continue;
    const item = r.subject.replace(/[.\s]+$/u, "");
    blocks.push({
      kind: "text",
      text: `${item}: ${r.why !== "" ? r.why : none}`,
      cites: kept,
      bullet: true,
    });
  }
  return { blocks, cites: [...cites.values()] };
}
