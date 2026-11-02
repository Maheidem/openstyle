// clarify-corpus.mts: the extra fictional data of the `clarify` part (D20).
// It is built by code, with no random numbers, and is loaded into the scratch
// DB ON TOP of the base corpus. The base corpus, its ids and both hashes stay
// as they are. The extra data holds:
//   (a) two folders with similar names, "Harbor Mobile" and "Harbor Web"
//       (the base corpus already has "Harbor Pricing"), 4 meetings each;
//   (b) two people with the same first name, "Marta Reis" (only in Harbor
//       Mobile) and "Marta Lacerda" (only in Harbor Web);
//   (c) the folder "Long Program": 72 meetings with a summary each. Every
//       summary holds 2 or 3 unique facts (a cost, a supplier, a tester count).

import { PEOPLE } from "./corpus.mts";
import type {
  Corpus,
  Folder,
  Lang,
  Meeting,
  Person,
  Segment,
} from "./types.mts";

const DAY = 86_400_000;
const byId = (id: string) => PEOPLE.find((p) => p.id === id) as Person;

export const HARBOR_MOBILE_ID = "fld-harbor-mobile";
export const HARBOR_WEB_ID = "fld-harbor-web";
export const LONG_PROGRAM_ID = "fld-long-program";
export const LONG_COUNT = 72;
/** The number of meetings at each end of the Long Program that count as early and late. */
export const LONG_END = 24;

export const MARTA_REIS: Person = {
  id: "p12",
  first: "Marta",
  full: "Marta Reis",
  variants: ["Marta R."],
  asr: "Marta Reiss",
};
export const MARTA_LACERDA: Person = {
  id: "p13",
  first: "Marta",
  full: "Marta Lacerda",
  variants: ["Marta L."],
  asr: "Marta Lasserda",
};

export interface LongFact {
  meetingId: string;
  /** 0 is the oldest meeting of the folder. */
  index: number;
  kind: "cost" | "supplier" | "testers";
  /** Accepted answer tokens (any one counts). */
  group: string[];
  period: "early" | "mid" | "late";
}

export interface ClarifyAddon {
  people: Person[];
  folders: Folder[];
  meetings: Meeting[];
  longFacts: LongFact[];
}

const ADJ = [
  "Amber",
  "Cobalt",
  "Cedar",
  "Ivory",
  "Marble",
  "Saffron",
  "Willow",
  "Onyx",
  "Coral",
];
const NOUN = [
  "Falcon",
  "Lantern",
  "Harvest",
  "Compass",
  "Meadow",
  "Anchor",
  "Summit",
  "Bridge",
];
const PRE = [
  "Nor",
  "Vel",
  "Kar",
  "Tem",
  "Bra",
  "Ost",
  "Lum",
  "Quo",
  "Dal",
  "Fen",
  "Hex",
  "Ruv",
];
const SUF = ["vex", "mark", "dyne", "lund", "tora", "wick"];
const FILLER = [
  "The team reviewed the open risks and the plan for the next two weeks.",
  "The group checked the schedule against the earlier plan and found no gap.",
  "Everyone agreed to send a short written update before the next review.",
  "The sponsor asked for a clear list of what is done and what is open.",
];

const seg = (
  meetingId: string,
  idx: number,
  startMs: number,
  text: string,
  personId: string | null,
  label: string | null,
): Segment => ({
  id: `${meetingId}-s${idx}`,
  idx,
  source: personId === null ? "mic" : "system",
  speakerLabel: label,
  personId,
  startMs,
  endMs: startMs + 4000 + text.length * 40,
  text,
  lang: "en" as Lang,
  factId: null,
});

/** Lines get consecutive start times and their ids follow the line index. */
export function lines(
  meetingId: string,
  spec: { text: string; personId: string | null; label: string | null }[],
): Segment[] {
  let t = 0;
  return spec.map((x, i) => {
    const s = seg(meetingId, i, t, x.text, x.personId, x.label);
    t = s.endMs + 500;
    return s;
  });
}

interface HarborSpec {
  folderId: string;
  key: string;
  short: string;
  marta: Person;
  mates: Person[];
  rollout: string;
  beta: string;
  /** Day offsets from 2026-09-07 for the 4 meetings. */
  days: number[];
}

function harborMeetings(spec: HarborSpec, prefix: string): Meeting[] {
  const base = Date.UTC(2026, 8, 7, 10, 0, 0);
  const names = ["Kickoff", "Beta plan", "Rollout plan", "Review"];
  return spec.days.map((d, i) => {
    const id = `${prefix}mtg-${spec.key}-${i + 1}`;
    const speakers = [spec.marta, ...spec.mates].map((p, k) => ({
      label: String(k + 1),
      personId: p.id,
      displayName: p.full,
    }));
    const say = (p: Person) =>
      speakers.find((s) => s.personId === p.id)?.label ?? null;
    const mate = spec.mates[0] as Person;
    const keyPoints = [
      `${spec.short} ${names[i]?.toLowerCase()} was discussed with the product team.`,
      ...(i === 1 ? [`The beta of ${spec.short} starts on ${spec.beta}.`] : []),
      ...(i === 2 ? [`The ${spec.short} rollout: ${spec.rollout}.`] : []),
    ];
    const spoken = [
      {
        text: `Welcome. This meeting is about the ${spec.short} ${names[i]?.toLowerCase()}.`,
        personId: mate.id,
        label: say(mate),
      },
      ...(i === 1
        ? [
            {
              text: `The beta of ${spec.short} starts on ${spec.beta}.`,
              personId: spec.marta.id,
              label: say(spec.marta),
            },
          ]
        : []),
      ...(i === 2
        ? [
            {
              text: `The ${spec.short} rollout: ${spec.rollout}.`,
              personId: spec.marta.id,
              label: say(spec.marta),
            },
          ]
        : []),
      {
        text: "We will send the notes after the call.",
        personId: mate.id,
        label: say(mate),
      },
    ];
    return {
      id,
      folderId: spec.folderId,
      title: `${spec.short} - ${names[i]}`,
      startedAt: base + d * DAY,
      durationMs: 1_800_000,
      lang: "en",
      summaryLang: "en",
      tags: ["team"],
      speakers,
      segments: lines(id, spoken),
      overview: `The team met for ${spec.short}. ${keyPoints[0]}`,
      keyPoints,
      decisions:
        i === 2
          ? [
              {
                id: `${id}#d0`,
                text: `Start the ${spec.short} rollout: ${spec.rollout}.`,
                factId: `${id}-f`,
              },
            ]
          : [],
      actionItems: [],
      openQuestions: [],
    } satisfies Meeting;
  });
}

function longMeetings(prefix: string): {
  meetings: Meeting[];
  facts: LongFact[];
} {
  const start = Date.UTC(2026, 0, 5, 9, 0, 0);
  const meetings: Meeting[] = [];
  const facts: LongFact[] = [];
  const period = (i: number): LongFact["period"] =>
    i < LONG_END ? "early" : i >= LONG_COUNT - LONG_END ? "late" : "mid";
  for (let i = 0; i < LONG_COUNT; i++) {
    const id = `${prefix}mtg-long-${String(i + 1).padStart(2, "0")}`;
    const pkg = `${ADJ[i % ADJ.length]} ${NOUN[Math.floor(i / ADJ.length)]}`;
    const cost = 20_000 + i * 173;
    const supplier = `${PRE[i % PRE.length]}${SUF[Math.floor(i / PRE.length)]}`;
    const testers = 400 + i;
    const withTesters = i % 3 === 0;
    const keyPoints = [
      `The work package ${pkg} was costed at ${cost} euros.`,
      ...(withTesters ? [`${testers} testers joined the ${pkg} trial.`] : []),
      FILLER[i % FILLER.length] as string,
    ];
    const decisions = [
      {
        id: `${id}#d0`,
        text: `Chose ${supplier} as the supplier for ${pkg}.`,
        factId: `${id}-f2`,
      },
    ];
    facts.push(
      {
        meetingId: id,
        index: i,
        kind: "cost",
        group: [String(cost)],
        period: period(i),
      },
      {
        meetingId: id,
        index: i,
        kind: "supplier",
        group: [supplier],
        period: period(i),
      },
    );
    if (withTesters)
      facts.push({
        meetingId: id,
        index: i,
        kind: "testers",
        group: [String(testers)],
        period: period(i),
      });
    const sys = MARTA_REIS;
    const spoken = [
      {
        text: `Review ${i + 1} of the long program starts now.`,
        personId: null,
        label: null,
      },
      ...keyPoints.slice(0, 2).map((text) => ({
        text,
        personId: sys.id,
        label: "1",
      })),
      { text: decisions[0]?.text ?? "", personId: sys.id, label: "1" },
    ];
    meetings.push({
      id,
      folderId: LONG_PROGRAM_ID,
      title: `Long Program - Review ${i + 1}`,
      startedAt: start + i * 2 * DAY,
      durationMs: 2_400_000,
      lang: "en",
      summaryLang: "en",
      tags: ["team"],
      speakers: [{ label: "1", personId: sys.id, displayName: sys.full }],
      segments: lines(id, spoken),
      overview: `Review ${i + 1} of the long program. ${keyPoints[0]}`,
      keyPoints,
      decisions,
      actionItems: [
        {
          id: `${id}#a0`,
          task: `Send the notes of review ${i + 1}`,
          owner: null,
          ownerPersonId: null,
          due: null,
          done: false,
          factId: `${id}-f3`,
        },
      ],
      openQuestions: [],
    });
  }
  return { meetings, facts };
}

/**
 * The extra data. `prefix` keeps its ids apart from the base corpus (the base
 * corpus uses the empty prefix and the ids `mtg-<folder>-<n>`).
 */
export function buildClarifyAddon(prefix = "cl-"): ClarifyAddon {
  const folders: Folder[] = [
    {
      id: HARBOR_MOBILE_ID,
      name: "Harbor Mobile",
      description: "The phone app of the Harbor product.",
      teamPersonIds: ["p09", "p10", MARTA_REIS.id],
    },
    {
      id: HARBOR_WEB_ID,
      name: "Harbor Web",
      description: "The web app of the Harbor product.",
      teamPersonIds: ["p07", "p08", MARTA_LACERDA.id],
    },
    {
      id: LONG_PROGRAM_ID,
      name: "Long Program",
      description: "A long running program with many reviews.",
      teamPersonIds: [MARTA_REIS.id],
    },
  ];
  const mobile = harborMeetings(
    {
      folderId: HARBOR_MOBILE_ID,
      key: "hmob",
      short: "Harbor Mobile",
      marta: MARTA_REIS,
      mates: [byId("p09"), byId("p10")],
      rollout: "5 percent of users in the first week",
      beta: "14 November 2026",
      days: [0, 7, 14, 21],
    },
    prefix,
  );
  const web = harborMeetings(
    {
      folderId: HARBOR_WEB_ID,
      key: "hweb",
      short: "Harbor Web",
      marta: MARTA_LACERDA,
      mates: [byId("p07"), byId("p08")],
      rollout: "20 percent of users in the first week",
      beta: "21 November 2026",
      days: [1, 8, 15, 22],
    },
    prefix,
  );
  const long = longMeetings(prefix);
  return {
    people: [MARTA_REIS, MARTA_LACERDA],
    folders,
    meetings: [...mobile, ...web, ...long.meetings],
    longFacts: long.facts,
  };
}

/** The base corpus with only the extra folders and meetings: what `loadCorpus` inserts. */
export function addonAsCorpus(base: Corpus, addon: ClarifyAddon): Corpus {
  return {
    ...base,
    people: [...base.people, ...addon.people],
    folders: addon.folders,
    meetings: addon.meetings,
    facts: [],
  };
}
