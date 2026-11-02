// dig-heldout.mts: the BLIND held-out dig set (D21 follow-up, spec 11.9.16).
// The data in dig-heldout.json was written by a separate author who had not
// seen the research code or the dig questions of `dig-corpus.mts` and
// `p1-dig.mts`. It has other people, topics, seeds and reasons. Use it with
// `CHAT_EVAL_DIG_SET=heldout pnpm chat-eval p1 --only dig`. Never tune the
// research code on these questions: they exist to catch overfitting.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lines } from "./clarify-corpus.mts";
import type { DigAddon } from "./dig-corpus.mts";
import type { DigKind, DigQ, DigTurn } from "./p1-dig.mts";
import type { Folder, Lang, Meeting, Person } from "./types.mts";

const DAY = 86_400_000;

interface Raw {
  people: { key: string; first: string; last: string; asr: string }[];
  projects: { key: string; name: string; lang: Lang }[];
  meetings: {
    key: string;
    project: string;
    n: number;
    day: number;
    title: string;
    lang: Lang;
    overview: string;
    keyPoints: string[];
    decisions: string[];
    actions: {
      task: string;
      owner: string;
      due: string;
      done?: boolean;
    }[];
    openQuestions: string[];
    say: { who: string; text: string }[];
  }[];
  questions: {
    id: string;
    scope: { kind: string; project?: string; key?: string };
    control: boolean;
    lang: Lang;
    turns: {
      kind: string;
      text: string;
      groups: string[][];
      mustNot: string[];
      meetings: string[];
      minCov: number;
    }[];
  }[];
}

/**
 * The blind sets. `heldout` is the first one (it was read for fixes, so it
 * counts as a dev set now); `dev` may be read and used for decisions; `final`
 * is read only for the last measure and never tuned on.
 */
export const DIG_SETS = {
  heldout: { file: "dig-heldout.json", prefix: "hd", qid: "hd" },
  dev: { file: "dig-dev.json", prefix: "hv", qid: "hv" },
  final: { file: "dig-final.json", prefix: "hf", qid: "hf" },
} as const;
export type DigSetName = keyof typeof DIG_SETS;

const cache = new Map<string, Raw>();
function load(set: DigSetName): Raw {
  const file = DIG_SETS[set].file;
  let raw = cache.get(file);
  if (!raw) {
    raw = JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        "utf8",
      ),
    ) as Raw;
    cache.set(file, raw);
  }
  return raw;
}

const ids = (set: DigSetName) => {
  const px = DIG_SETS[set].prefix;
  return {
    folderId: (project: string) => `fld-${px}-${project.toLowerCase()}`,
    meetingId: (key: string) => `${px}-${key}`,
    personId: (key: string) => `${px}-${key}`,
  };
};
const START: Record<string, number> = {
  A: Date.UTC(2026, 9, 1, 10, 0, 0),
  B: Date.UTC(2026, 9, 8, 10, 0, 0),
  C: Date.UTC(2026, 9, 12, 10, 0, 0),
};

export function buildHeldoutAddon(set: DigSetName = "heldout"): DigAddon {
  const raw = load(set);
  const { folderId, meetingId, personId } = ids(set);
  const people: Person[] = raw.people.map((p) => ({
    id: personId(p.key),
    first: p.first,
    full: `${p.first} ${p.last}`,
    variants: [`${p.first} ${p.last.charAt(0)}.`],
    asr: p.asr,
  }));
  const byProject = (k: string) =>
    new Set(
      raw.meetings
        .filter((m) => m.project === k)
        .flatMap((m) => [
          ...m.say.map((s) => s.who),
          ...m.actions.map((a) => a.owner),
        ]),
    );
  const folders: Folder[] = raw.projects.map((p) => ({
    id: folderId(p.key),
    name: p.name,
    description: p.name,
    teamPersonIds: [...byProject(p.key)].map(personId),
  }));
  const meetings: Meeting[] = raw.meetings.map((s) => {
    const id = meetingId(s.key);
    const team = [...byProject(s.project)];
    const speakers = team.map((k, i) => ({
      label: String(i + 1),
      personId: personId(k),
      displayName: people.find((p) => p.id === personId(k))?.full ?? k,
    }));
    const name = (k: string) => people.find((p) => p.id === personId(k));
    return {
      id,
      folderId: folderId(s.project),
      title: s.title,
      startedAt: (START[s.project] ?? START.A) + s.day * DAY,
      durationMs: 2_400_000,
      lang: s.lang,
      summaryLang: s.lang,
      tags: ["team"],
      speakers,
      segments: lines(
        id,
        s.say.map((x) => ({
          text: x.text,
          personId: personId(x.who),
          label:
            speakers.find((p) => p.personId === personId(x.who))?.label ?? null,
        })),
      ),
      overview: s.overview,
      keyPoints: s.keyPoints,
      decisions: s.decisions.map((text, i) => ({
        id: `${id}#d${i}`,
        text,
        factId: `${id}-fd${i}`,
      })),
      actionItems: s.actions.map((a, i) => ({
        id: `${id}#a${i}`,
        task: a.task,
        owner: name(a.owner)?.full ?? a.owner,
        ownerPersonId: personId(a.owner),
        due: a.due,
        done: a.done ?? false,
        factId: `${id}-fa${i}`,
      })),
      openQuestions: s.openQuestions.map((text, i) => ({
        id: `${id}#q${i}`,
        text,
        factId: `${id}-fq${i}`,
      })),
    } satisfies Meeting;
  });
  return { people, folders, meetings };
}

export function buildHeldoutDig(set: DigSetName = "heldout"): DigQ[] {
  const raw = load(set);
  const { folderId, meetingId } = ids(set);
  const qid = DIG_SETS[set].qid;
  return raw.questions.map((q) => ({
    id: set === "heldout" ? q.id : q.id.replace(/^q/, qid),
    lang: q.lang,
    control: q.control,
    scope:
      q.scope.kind === "folder"
        ? { kind: "folder", id: folderId(q.scope.project ?? "A") }
        : q.scope.kind === "meeting"
          ? { kind: "meeting", id: meetingId(q.scope.key ?? "") }
          : { kind: "all", id: null },
    turns: q.turns.map(
      (t): DigTurn => ({
        kind: t.kind as DigKind,
        text: t.text,
        groups: t.groups,
        mustNot: t.mustNot,
        meetings: t.meetings.map(meetingId),
        minCov: t.minCov,
      }),
    ),
  }));
}
