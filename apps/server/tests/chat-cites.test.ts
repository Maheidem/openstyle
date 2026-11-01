// Answer validation in code (specs/meeting-chat-agent.md 6.2). No model.
// All text is fictional.
import { describe, expect, it } from "vitest";
import {
  assignMissingCites,
  checkAnswer,
  citeFromSentences,
  extractFacts,
  failureNote,
  normalizeText,
  pickCiteTimes,
} from "../src/lib/chat/cites.js";
import { SourceMap } from "../src/lib/chat/types.js";

const D = Date.UTC(2026, 8, 15, 12);

function build() {
  const map = new SourceMap();
  const add = (
    meetingId: string,
    title: string,
    text: string,
    startedAt: number | null = D,
    startMs: number | null = 61_000,
  ) =>
    map.add({
      kind: "transcript",
      meetingId,
      title,
      startedAt,
      startMs,
      endMs: null,
      itemId: null,
      text,
    });
  add(
    "m1",
    "Harbor Sync",
    "The quote for the storage cluster is 41,500 dollars.",
  );
  add(
    "m1",
    "Harbor Sync",
    "Ana will write the rollback plan before the cutover.",
  );
  add(
    "m2",
    "Pier Review",
    "Bruno approved the pilot on 2026-09-22. Cost was 12.000 reais.",
  );
  add(
    "m1",
    "Harbor Sync",
    "A orcamento do cluster foi de 41500 reais, disse Carla.",
  );
  add(
    "m1",
    "Harbor Sync",
    "O lançamento é em 15 de setembro. Zoë cuidou da migração.",
  );
  return map;
}
const NAMES = ["Ana", "Bruno", "Carla", "Zoë", "Harbor Sync", "Pier Review"];

interface Case {
  name: string;
  text: string;
  cites: string[];
  scope?: string[] | "all";
  question?: string;
  ok: boolean;
  unsupported?: string[];
  bad?: string[];
  repaired?: number;
  removed?: number;
}

const CASES: Case[] = [
  {
    name: "plain fact, valid cite",
    text: "The quote is 41,500 dollars.",
    cites: ["S1"],
    ok: true,
  },
  {
    name: "thousands: 41500 vs 41,500",
    text: "The quote is 41500 dollars.",
    cites: ["S1"],
    ok: true,
  },
  {
    name: "thousands: 41.500 vs 41,500",
    text: "It costs 41.500 dollars.",
    cites: ["S1"],
    ok: true,
  },
  {
    name: "wrong number",
    text: "The quote is 51,500 dollars.",
    cites: ["S1"],
    ok: false,
    unsupported: ["51,500"],
  },
  {
    name: "number in other source is repaired",
    text: "The quote is 41,500 dollars.",
    cites: ["S2"],
    ok: true,
    repaired: 1,
  },
  {
    name: "number missing everywhere",
    text: "The quote is 99 dollars.",
    cites: ["S1"],
    ok: false,
    unsupported: ["99"],
  },
  {
    name: "name in source",
    text: "Ana will write the rollback plan.",
    cites: ["S2"],
    ok: true,
  },
  {
    name: "name not in the cited source, in another: repair",
    text: "Ana will write the plan.",
    cites: ["S1"],
    ok: true,
    repaired: 1,
  },
  {
    name: "name that no source holds",
    text: "Bruno will write the plan.",
    cites: ["S2"],
    ok: false,
    unsupported: ["Bruno"],
    scope: ["m1"],
    bad: [],
  },
  {
    name: "name accent folded",
    text: "Zoe handled the migration.",
    cites: ["S5"],
    ok: true,
    question: "x",
  },
  {
    name: "name with accent in answer",
    text: "Zoë handled the migration.",
    cites: ["S5"],
    ok: true,
  },
  {
    name: "name in the question is supported",
    text: "Dana did it.",
    cites: ["S2"],
    ok: true,
    question: "Who is Dana?",
  },
  {
    name: "ISO date vs month name",
    text: "Bruno approved the pilot on September 22.",
    cites: ["S3"],
    ok: true,
  },
  {
    name: "ISO date vs PT date",
    text: "Bruno aprovou o piloto em 22 de setembro.",
    cites: ["S3"],
    ok: true,
  },
  {
    name: "PT date vs English date",
    text: "The launch is on September 15.",
    cites: ["S5"],
    ok: true,
  },
  {
    name: "15 de setembro vs September 15 (answer PT)",
    text: "O lançamento é em 15 de setembro.",
    cites: ["S5"],
    ok: true,
  },
  {
    name: "wrong day",
    text: "The launch is on September 16.",
    cites: ["S5"],
    ok: false,
    unsupported: ["september 16"],
  },
  {
    name: "date from the metadata of the source",
    text: "The sync was on 2026-09-15.",
    cites: ["S1"],
    ok: true,
  },
  {
    name: "year from the metadata",
    text: "It happened in 2026.",
    cites: ["S1"],
    ok: true,
  },
  {
    name: "time from the metadata",
    text: "It was said at 01:01.",
    cites: ["S1"],
    ok: true,
  },
  {
    name: "title token",
    text: "In Pier Review the pilot was approved.",
    cites: ["S3"],
    ok: true,
  },
  {
    name: "title of another meeting: repair",
    text: "In Pier Review the pilot was approved.",
    cites: ["S1"],
    ok: true,
    repaired: 1,
  },
  {
    name: "quoted string present",
    text: 'She said "rollback plan".',
    cites: ["S2"],
    ok: true,
    question: "x",
  },
  {
    name: "quoted string missing",
    text: 'She said "go live friday".',
    cites: ["S2"],
    ok: false,
    unsupported: ["go live friday"],
  },
  {
    name: "no cite: sentence removed",
    text: "The quote is 41,500 dollars.",
    cites: [],
    ok: false,
    removed: 1,
  },
  {
    name: "unknown label: dropped and reported",
    text: "The quote is 41,500 dollars.",
    cites: ["S77"],
    ok: false,
    bad: ["S77"],
    removed: 1,
  },
  {
    name: "label of another meeting outside the scope",
    text: "Bruno approved the pilot.",
    cites: ["S3"],
    scope: ["m1"],
    ok: false,
    bad: ["S3"],
    removed: 1,
  },
  {
    name: "valid label plus out-of-scope label: keeps the valid one",
    text: "Ana will write the plan.",
    cites: ["S2", "S3"],
    scope: ["m1"],
    ok: true,
    bad: ["S3"],
  },
  {
    name: "scope all accepts every meeting",
    text: "Bruno approved the pilot.",
    cites: ["S3"],
    scope: "all",
    ok: true,
  },
  {
    name: "PT: cost in PT with decimal separator",
    text: "O custo foi de 12.000 reais.",
    cites: ["S3"],
    ok: true,
  },
  {
    name: "list marker is not a fact",
    text: "1. Ana will write the plan.",
    cites: ["S2"],
    ok: true,
  },
];

describe("checkAnswer property cases", () => {
  it("has at least 30 cases", () =>
    expect(CASES.length).toBeGreaterThanOrEqual(30));

  it.each(CASES)("$name", (c) => {
    const sources = build();
    const check = checkAnswer({
      sentences: [{ text: c.text, cites: c.cites }],
      sources,
      question: c.question ?? "What do the notes say?",
      allowedMeetingIds:
        c.scope === "all" ? "all" : new Set(c.scope ?? ["m1", "m2"]),
      knownNames: NAMES,
    });
    expect(check.ok).toBe(c.ok);
    if (c.unsupported) {
      expect(check.unsupportedTokens.map((t) => normalizeText(t))).toEqual(
        c.unsupported.map((t) => normalizeText(t)),
      );
    } else {
      expect(check.unsupportedTokens).toEqual([]);
    }
    expect(check.badLabels).toEqual(c.bad ?? []);
    expect(check.repairedCites).toBe(c.repaired ?? 0);
    expect(check.removedSentences).toBe(c.removed ?? 0);
  });
});

describe("checkAnswer details", () => {
  it("removes only the sentence without a cite and keeps the rest", () => {
    const sources = build();
    const check = checkAnswer({
      sentences: [
        { text: "Ana will write the plan.", cites: ["S2"] },
        { text: "Everything is fine.", cites: [] },
      ],
      sources,
      question: "q",
      allowedMeetingIds: "all",
      knownNames: NAMES,
    });
    expect(check.sentences).toHaveLength(1);
    expect(check.removedSentences).toBe(1);
    expect(check.ok).toBe(true);
  });

  it("repair adds the label to the cleaned sentence", () => {
    const check = checkAnswer({
      sentences: [{ text: "The quote is 41,500 dollars.", cites: ["S2"] }],
      sources: build(),
      question: "q",
      allowedMeetingIds: "all",
      knownNames: NAMES,
    });
    expect(check.sentences[0]?.cites).toEqual(["S2", "S1"]);
  });

  it("an empty answer is not ok", () => {
    const check = checkAnswer({
      sentences: [],
      sources: build(),
      question: "q",
      allowedMeetingIds: "all",
      knownNames: NAMES,
    });
    expect(check.ok).toBe(false);
  });

  it("a Portuguese article is not read as the number 1", () => {
    expect(extractFacts("Foi um problema.", [])).toEqual([]);
  });

  it("citeFromSentences gives unique cites in order of first use", () => {
    const sources = build();
    const cites = citeFromSentences(
      [
        { text: "a", cites: ["S3", "S1"] },
        { text: "b", cites: ["S1", "S2", "S99"] },
      ],
      sources,
    );
    expect(cites.map((c) => c.label)).toEqual(["S3", "S1", "S2"]);
    expect(cites[0]?.meeting_id).toBe("m2");
  });

  it("failureNote names the failed tokens and labels", () => {
    const check = checkAnswer({
      sentences: [
        { text: "The quote is 99 dollars.", cites: ["S1"] },
        { text: "x", cites: ["S42"] },
      ],
      sources: build(),
      question: "q",
      allowedMeetingIds: "all",
      knownNames: NAMES,
    });
    const note = failureNote(check);
    expect(note).toContain('Remove or fix: "99"');
    expect(note).toContain("S42");
  });
});

describe("assignMissingCites (grounding guard)", () => {
  const map = (): SourceMap => {
    const m = new SourceMap();
    m.add({
      kind: "transcript",
      meetingId: "m1",
      title: "Weekly sync",
      startedAt: 1,
      startMs: 1000,
      endMs: 2000,
      itemId: null,
      text: "The vendor quote for the storage cluster is 41500 dollars",
    });
    return m;
  };

  it("attaches the source that holds most words of the sentence", () => {
    const sources = map();
    const s = [
      {
        text: "The storage cluster quote is 41500 dollars",
        cites: [] as string[],
      },
    ];
    assignMissingCites(s, sources);
    expect(s[0]?.cites).toEqual(["S1"]);
  });

  it("never attaches the closest source to a claim it does not support", () => {
    const sources = map();
    const s = [
      {
        text: "Priya promised to hire three engineers next quarter",
        cites: [] as string[],
      },
    ];
    assignMissingCites(s, sources);
    expect(s[0]?.cites).toEqual([]);
    const check = checkAnswer({
      sentences: s,
      sources,
      question: "Who will hire?",
      allowedMeetingIds: "all",
      knownNames: [],
    });
    expect(check.sentences).toEqual([]);
    expect(check.ok).toBe(false);
  });
});

describe("known names in window sources", () => {
  const sourcesWith = (windowText: string): SourceMap => {
    const m = new SourceMap();
    m.add({
      kind: "transcript",
      meetingId: "m1",
      title: "Atlas sync",
      startedAt: 1,
      startMs: 418000,
      endMs: 440000,
      itemId: null,
      text: "Eu proponho uma página de status para a empresa toda.",
    });
    m.add({
      kind: "window",
      meetingId: "m1",
      title: "Atlas sync",
      startedAt: 1,
      startMs: 402000,
      endMs: 460000,
      itemId: null,
      text: windowText,
    });
    return m;
  };
  const check = (sources: SourceMap) =>
    checkAnswer({
      sentences: [
        {
          text: "Tomasz Wieczorek propôs uma página de status para a empresa toda.",
          cites: ["S1"],
        },
      ],
      sources,
      question: "Quem propôs uma página de status para a empresa toda?",
      allowedMeetingIds: new Set(["m1"]),
      knownNames: ["Tomasz Wieczorek"],
    });

  it("a name that a window source holds (the name is followed by a colon) is attached", () => {
    const r = check(
      sourcesWith(
        "[6:58] Tomasz Wieczorek: Eu proponho uma página de status para a empresa toda.\n[7:04] Me: Devemos testar",
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.unsupportedTokens).toEqual([]);
    expect(r.repairedCites).toBe(1);
    expect(r.sentences[0]?.cites).toEqual(["S1", "S2"]);
  });

  it("a name that no source holds stays unsupported and is not attached", () => {
    const r = check(
      sourcesWith(
        "[6:58] Priya Nandakumar: Eu proponho uma página de status para a empresa toda.",
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.unsupportedTokens).toEqual(["Tomasz Wieczorek"]);
    expect(r.repairedCites).toBe(0);
    expect(r.sentences[0]?.cites).toEqual(["S1"]);
  });
});

describe("numbers inside words", () => {
  it("p95 is one word, not the number 95", () => {
    const facts = extractFacts("The current p95 latency is 381 ms.", []);
    expect(facts.map((f) => f.norm)).toEqual(["381"]);
  });
});

describe("pickCiteTimes (P1.1)", () => {
  const withSegments = () => {
    const map = new SourceMap();
    const src = map.add({
      kind: "window",
      meetingId: "m1",
      title: "Harbor Sync",
      startedAt: D,
      startMs: 10_000,
      endMs: null,
      itemId: null,
      text: "filler. the fact. filler.",
    });
    map.segments.set(src.label, [
      { startMs: 10_000, text: "filler" },
      { startMs: 20_000, text: "the fact" },
      { startMs: 30_000, text: "filler again" },
    ]);
    return { map, label: src.label };
  };

  it("the best scored segment starts the cite", async () => {
    const { map, label } = withSegments();
    await pickCiteTimes([{ cites: [label] }], map, "q", async (_q, texts) =>
      texts.map((t) => (t === "the fact" ? 0.9 : 0.1)),
    );
    expect(map.get(label)?.startMs).toBe(20_000);
  });

  it("no ranker result leaves the start as it is", async () => {
    const { map, label } = withSegments();
    await pickCiteTimes([{ cites: [label] }], map, "q", async () => null);
    expect(map.get(label)?.startMs).toBe(10_000);
  });

  it("a summary cite and a one-segment source are not ranked", async () => {
    const map = new SourceMap();
    const sum = map.add({
      kind: "summary",
      meetingId: "m1",
      title: "T",
      startedAt: D,
      startMs: null,
      endMs: null,
      itemId: null,
      text: "x",
    });
    let called = false;
    await pickCiteTimes([{ cites: [sum.label] }], map, "q", async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
  });
});
