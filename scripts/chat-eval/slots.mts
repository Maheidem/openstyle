// slots.mts: stage 2b of the pipeline (spec 2.3): the closed choices that code
// builds, the slot schemas per intent, the prompt, and the scoring of the slot
// values against the gold args. The same choices go to the native-tools arm T1,
// so the two arms see the same facts.

import { normalize } from "./keys.mts";
import type { Corpus, Intent, Meeting, Question } from "./types.mts";

export const TODAY_ISO = "2026-10-26";
export const TODAY_NAME = "Monday";
const MONTHS_EN = [
  "",
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
];
const MONTHS_PT = [
  "",
  "janeiro",
  "fevereiro",
  "marco",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

export interface Choices {
  people: { id: string; name: string }[];
  items: { label: string; id: string; text: string }[];
  meetings: { label: string; id: string; text: string }[];
  folders: { id: string; name: string }[];
}

const words = (t: string) =>
  new Set(
    normalize(t)
      .split(" ")
      .filter((w) => w.length > 2),
  );
const overlap = (a: Set<string>, b: Set<string>) =>
  [...a].filter((w) => b.has(w)).length;

/** Meetings in the scope of a question. */
export function scopeMeetings(c: Corpus, q: Question): Meeting[] {
  if (q.scope.kind === "meeting")
    return c.meetings.filter((m) => m.id === q.scope.id);
  if (q.scope.kind === "folder")
    return c.meetings.filter((m) => m.folderId === q.scope.id);
  return c.meetings;
}

/** The closed choices of one question (spec 2.3, slot table): ranked by string match. */
export function buildChoices(c: Corpus, q: Question): Choices {
  const qw = words(`${q.text} ${q.history.map((h) => h.q).join(" ")}`);
  const ms = scopeMeetings(c, q);
  const inScope = new Set(ms.flatMap((m) => m.speakers.map((s) => s.personId)));
  const people = c.people
    .filter((p) => p.id !== "p00")
    .filter((p) => inScope.has(p.id) || q.scope.kind === "all")
    .map((p) => ({
      p,
      score: overlap(qw, words(`${p.full} ${p.variants.join(" ")} ${p.asr}`)),
    }))
    .sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id))
    .slice(0, 30)
    .map((x) => ({ id: x.p.id, name: x.p.full }));
  const items = ms
    .flatMap((m) =>
      m.actionItems.map((a) => ({
        id: a.id,
        text: a.task,
        score: overlap(qw, words(a.task)),
      })),
    )
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 8)
    .map((x, i) => ({ label: `A${i + 1}`, id: x.id, text: x.text }));
  const meetings = ms
    .map((m) => {
      const d = new Date(m.startedAt);
      const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const dateWords = `${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth() + 1]} ${MONTHS_PT[d.getUTCMonth() + 1]} ${d.getUTCDate()}`;
      return { m, date, score: overlap(qw, words(`${m.title} ${dateWords}`)) };
    })
    .sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id))
    .slice(0, 12)
    .map((x, i) => ({
      label: `M${i + 1}`,
      id: x.m.id,
      text: `${x.m.title} (${x.date})`,
    }));
  return {
    people,
    items,
    meetings,
    folders: c.folders.map((f) => ({ id: f.id, name: f.name })),
  };
}

export interface SlotValues {
  query?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  person?: string | null;
  item?: string | null;
  meeting?: string | null;
  folder?: string | null;
  kind?: string | null;
  change?: string | null;
  tag?: string | null;
  period?: string | null;
  month?: number | null;
  day?: number | null;
}

const dateField = { type: ["string", "null"], maxLength: 10 };

/**
 * How the model gives a date range. "iso": date_from and date_to as YYYY-MM-DD
 * (spec 2.3, slot table). "closed": a closed period, a month and a day; code
 * turns them into the range (rule-like work stays in code, spec 2.1 point 5).
 */
export type DatesMode = "iso" | "closed";
const PERIODS = [
  "none",
  "last_week",
  "this_week",
  "last_month",
  "this_month",
  "month",
];

function addDates(props: Record<string, unknown>, mode: DatesMode): void {
  if (mode === "iso") {
    props.date_from = dateField;
    props.date_to = dateField;
    return;
  }
  props.period = { enum: PERIODS };
  props.month = { type: ["integer", "null"], minimum: 1, maximum: 12 };
  props.day = { type: ["integer", "null"], minimum: 1, maximum: 31 };
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/** The date range of a closed period (relative to TODAY_ISO), or nulls. */
export function resolvePeriod(v: SlotValues): {
  date_from: string | null;
  date_to: string | null;
} {
  const today = Date.parse(`${TODAY_ISO}T00:00:00Z`);
  const dow = (new Date(today).getUTCDay() + 6) % 7; // Monday = 0
  const monday = today - dow * DAY_MS;
  const [y, m] = TODAY_ISO.split("-").map(Number) as [number, number];
  const monthRange = (yy: number, mm: number) => ({
    date_from: iso(Date.UTC(yy, mm - 1, 1)),
    date_to: iso(Date.UTC(yy, mm, 0)),
  });
  switch (v.period) {
    case "last_week":
      return {
        date_from: iso(monday - 7 * DAY_MS),
        date_to: iso(monday - DAY_MS),
      };
    case "this_week":
      return { date_from: iso(monday), date_to: iso(monday + 6 * DAY_MS) };
    case "last_month":
      return m === 1 ? monthRange(y - 1, 12) : monthRange(y, m - 1);
    case "this_month":
      return { date_from: iso(Date.UTC(y, m - 1, 1)), date_to: TODAY_ISO };
    case "month":
      if (v.month && v.month >= 1 && v.month <= 12) {
        if (v.day && v.day >= 1 && v.day <= 31) {
          const d = iso(Date.UTC(y, v.month - 1, v.day));
          return { date_from: d, date_to: d };
        }
        return monthRange(y, v.month);
      }
      return { date_from: null, date_to: null };
    default:
      return { date_from: null, date_to: null };
  }
}
const textField = { type: "string", maxLength: 200 };

/** The strict JSON schema of the slot fill for one intent. */
export function slotSchema(
  intent: Intent,
  ch: Choices,
  dates: DatesMode = "iso",
): Record<string, unknown> | null {
  const none = <T extends string>(xs: T[]) => [...xs, "none"];
  const props: Record<string, unknown> = {};
  switch (intent) {
    case "status":
      return null;
    case "aggregate":
      props.person = { enum: none(ch.people.map((p) => p.id)) };
      props.query = textField;
      addDates(props, dates);
      break;
    case "temporal":
      props.query = textField;
      addDates(props, dates);
      break;
    case "review":
      props.kind = { enum: ["decision", "open_question"] };
      addDates(props, dates);
      break;
    case "write":
      props.change = { enum: ["action_item", "retag", "move", "merge_people"] };
      props.item = { enum: none(ch.items.map((i) => i.label)) };
      props.meeting = { enum: none(ch.meetings.map((m) => m.label)) };
      props.folder = { enum: none(ch.folders.map((f) => f.id)) };
      props.person = { enum: none(ch.people.map((p) => p.id)) };
      props.tag = { type: ["string", "null"], maxLength: 40 };
      addDates(props, dates);
      break;
    default:
      props.query = textField;
      addDates(props, dates);
  }
  return {
    type: "object",
    required: Object.keys(props),
    additionalProperties: false,
    properties: props,
  };
}

export function choiceText(intent: Intent, ch: Choices): string {
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
    out.push(
      `folder: ${ch.folders.map((f) => `${f.id}=${f.name}`).join("; ")}`,
    );
  }
  return out.join("\n");
}

const FIELD_HELP: Record<string, string> = {
  query: "query: short standalone search text, in the language of the question",
  date_from:
    "date_from: first day as YYYY-MM-DD, or null when the question has no date",
  date_to:
    "date_to: last day as YYYY-MM-DD, or null when the question has no date",
  person: "person: one id from the list, or none",
  item: "item: one label from the list, or none",
  meeting: "meeting: one label from the list, or none",
  folder: "folder: one id from the list, or none",
  kind: "kind: decision or open_question",
  change: "change: action_item (done or reopen), retag, move or merge_people",
  tag: "tag: the tag name to add, or null",
};

export function slotSystem(
  intent: Intent,
  ch: Choices,
  dates: DatesMode = "iso",
): string {
  const schema = slotSchema(intent, ch, dates) as {
    properties: Record<string, unknown>;
  } | null;
  const fields = Object.keys(schema?.properties ?? {}).map(
    (k) => FIELD_HELP[k],
  );
  return [
    `Fill the fields for a question about meeting notes. Intent: ${intent}.`,
    `Today is ${TODAY_ISO} (${TODAY_NAME}). A week starts on Monday.`,
    ...fields,
    choiceText(intent, ch),
  ]
    .filter(Boolean)
    .join("\n");
}

// --- Scoring -------------------------------------------------------------------------------

export interface SlotScore {
  /** Every gold arg matched. */
  pass: boolean;
  /** One entry per gold arg key. */
  keys: Record<string, boolean>;
}

export function scoreSlots(q: Question, v: SlotValues, ch: Choices): SlotScore {
  const keys: Record<string, boolean> = {};
  const lab = <T extends { label: string; id: string }>(
    xs: T[],
    label: string | null | undefined,
  ) => xs.find((x) => x.label === label)?.id ?? null;
  for (const [k, gold] of Object.entries(q.args)) {
    switch (k) {
      case "query_any": {
        const got = normalize(v.query ?? "");
        keys[k] = (gold as string[]).some(
          (t) => got.split(" ").includes(t) || got.includes(t),
        );
        break;
      }
      case "person_id":
        keys[k] = v.person === gold;
        break;
      case "cluster":
        keys[k] = v.person === gold;
        break;
      case "kind":
        keys[k] = v.kind === gold;
        break;
      case "date_from":
        keys[k] = (v.date_from ?? null) === (gold === "" ? null : gold);
        break;
      case "date_to":
        keys[k] = (v.date_to ?? null) === (gold === "" ? null : gold);
        break;
      case "item":
        keys[k] = lab(ch.items, v.item) === gold;
        break;
      case "meeting":
        keys[k] = lab(ch.meetings, v.meeting) === gold;
        break;
      case "folder":
        keys[k] = v.folder === gold;
        break;
      case "tag":
        keys[k] = normalize(v.tag ?? "") === normalize(String(gold));
        break;
      default:
        break; // status: not a slot
    }
  }
  if (q.intent === "write") {
    const want = q.key.kind === "write" ? q.key.change : null;
    keys.change = v.change === want;
  }
  return { pass: Object.values(keys).every(Boolean), keys };
}

/** The default slots of arm A5: query = the question, nothing else. */
export function defaultSlots(q: Question): SlotValues {
  return {
    query: q.text,
    date_from: null,
    date_to: null,
    person: "none",
    item: "none",
    meeting: "none",
    folder: "none",
    kind: null,
    change: null,
    tag: null,
  };
}
