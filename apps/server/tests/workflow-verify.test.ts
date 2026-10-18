// Node `verifyEvidence` (specs/meeting-enhance-agentic.md 4.4, 10.6 row
// `verifyEvidence`). Code only. The function `verifyEvidence` is pure, so most
// cases call it with hand-built input. Two cases run the node in the graph.
import { describe, expect, it } from "vitest";
import {
  containsWord,
  looksSelfIdentifying,
  normalizeForMatch,
  verifyEvidence,
} from "../src/lib/meetings/workflow/nodes/verify-evidence.js";
import type {
  PreparedMeeting,
  PreparedSegment,
  SpeakerProposal,
} from "../src/lib/meetings/workflow/types.js";

function seg(
  id: string,
  label: string | null,
  text: string,
  startMs: number,
): PreparedSegment {
  return {
    id,
    speaker: label ? "Them" : "Me",
    startMs,
    speakerLabel: label,
    displayLabel: label ? `Them ${label}` : "Me",
    text,
    enhancedText: null,
    speakerName: null,
  };
}

function prepared(
  segments: PreparedSegment[],
  over: Partial<PreparedMeeting> = {},
): PreparedMeeting {
  return {
    meetingId: "m",
    language: "en",
    title: null,
    context: null,
    vocabTerms: [],
    attendeeNames: [],
    segments,
    chunks: [],
    labels: { all: ["2", "3"], confirmed: [], toIdentify: ["2", "3"] },
    chunkTokens: 1200,
    summary: { instructions: "", contextBudget: 8000 },
    inputHash: "h",
    ...over,
  };
}

let nextSeq = 0;
function prop(
  over: Partial<SpeakerProposal> &
    Pick<SpeakerProposal, "segmentId" | "quote" | "label" | "name">,
): SpeakerProposal {
  return {
    unitKey: "candidates",
    llmCallId: 7,
    seq: nextSeq++,
    kind: "name",
    ...over,
  };
}

const SEGS = [
  seg("a", "2", "Hi, this is Ana and I lead the pilot.", 1000),
  seg("b", "3", "Thank you, Ana. Let us start.", 2000),
  seg("c", null, "Me talking about the plan.", 3000),
  seg("d", "3", "I am Ben, the client contact for this rollout.", 4000),
];

function verify(
  proposals: SpeakerProposal[],
  over: Partial<PreparedMeeting> = {},
  shownIds = ["a", "b", "d"],
) {
  return verifyEvidence(prepared(SEGS, over), proposals, [
    { unitKey: "candidates", segmentIds: shownIds },
  ]);
}

describe("verifyEvidence: normalization (4.4.1)", () => {
  it("handles the four cases of the table", () => {
    // Hi, this is José: true (the old \\b form said false).
    expect(
      looksSelfIdentifying(
        normalizeForMatch("Hi, this is José"),
        normalizeForMatch("José"),
      ),
    ).toBe(true);
    // A curly apostrophe: true.
    expect(looksSelfIdentifying(normalizeForMatch("Hi, I’m Ana"), "ana")).toBe(
      true,
    );
    // "banana" does not hold the word "ana".
    expect(containsWord(normalizeForMatch("banana"), "ana")).toBe(false);
    // The unchanged case.
    expect(
      looksSelfIdentifying(normalizeForMatch("Hi, this is Ana"), "ana"),
    ).toBe(true);
    // A name that starts a clause, then a comma and a job title.
    expect(
      looksSelfIdentifying(
        normalizeForMatch("So Tom, SVP of kiosks here at Acme"),
        "tom",
      ),
    ).toBe(true);
    expect(
      looksSelfIdentifying(normalizeForMatch("Tom, head of sales."), "tom"),
    ).toBe(true);
    // A greeting to someone is no introduction.
    expect(
      looksSelfIdentifying(normalizeForMatch("Oh, good, Mike."), "mike"),
    ).toBe(false);
    expect(
      looksSelfIdentifying(normalizeForMatch("Hello, Mike and Grace."), "mike"),
    ).toBe(false);
    expect(
      looksSelfIdentifying(
        normalizeForMatch("Hello, Mike, director of sales"),
        "mike",
      ),
    ).toBe(false);
    // "Thank you, Ana." is no introduction.
    expect(
      looksSelfIdentifying(normalizeForMatch("Thank you, Ana."), "ana"),
    ).toBe(false);
  });
});

describe("verifyEvidence: one test for each drop reason (4.4.2)", () => {
  it("1 unknown_label: a confirmed or missing label", () => {
    const r = verify([
      prop({ segmentId: "a", quote: "this is Ana", label: "9", name: "Ana" }),
    ]);
    expect(r.verdicts[0]).toMatchObject({
      status: "dropped",
      reason: "unknown_label",
      evidenceType: null,
    });
    const confirmed = verify(
      [prop({ segmentId: "a", quote: "this is Ana", label: "2", name: "Ana" })],
      { labels: { all: ["2", "3"], confirmed: ["2"], toIdentify: ["3"] } },
    );
    expect(confirmed.verdicts[0]?.reason).toBe("unknown_label");
  });

  it("2 unknown_segment: a line that was not shown, and a Me line", () => {
    expect(
      verify([prop({ segmentId: "zzz", quote: "x", label: "2", name: "Ana" })])
        .verdicts[0]?.reason,
    ).toBe("unknown_segment");
    expect(
      verify([
        prop({
          segmentId: "c",
          quote: "Me talking",
          label: "2",
          name: "Ana",
        }),
      ]).verdicts[0]?.reason,
    ).toBe("unknown_segment");
    // A line that exists but was not shown to this unit.
    expect(
      verify(
        [prop({ segmentId: "d", quote: "I am Ben", label: "3", name: "Ben" })],
        {},
        ["a", "b"],
      ).verdicts[0]?.reason,
    ).toBe("unknown_segment");
  });

  it("3 no_quote", () => {
    expect(
      verify([prop({ segmentId: "a", quote: "   ", label: "2", name: "Ana" })])
        .verdicts[0]?.reason,
    ).toBe("no_quote");
  });

  it("4 quote_too_long: more than 160 characters", () => {
    const long = "this is Ana".padEnd(161, "x");
    expect(
      verify([prop({ segmentId: "a", quote: long, label: "2", name: "Ana" })])
        .verdicts[0]?.reason,
    ).toBe("quote_too_long");
  });

  it("5 quote_not_in_segment: a quote from another line", () => {
    expect(
      verify([
        prop({ segmentId: "a", quote: "I am Ben", label: "2", name: "Ben" }),
      ]).verdicts[0]?.reason,
    ).toBe("quote_not_in_segment");
  });

  it("6 empty_name", () => {
    expect(
      verify([
        prop({ segmentId: "a", quote: "this is Ana", label: "2", name: "  " }),
      ]).verdicts[0]?.reason,
    ).toBe("empty_name");
  });

  it("7 name_not_in_quote, at a letter boundary", () => {
    const r = verify([
      prop({ segmentId: "a", quote: "this is Ana", label: "2", name: "An" }),
    ]);
    expect(r.verdicts[0]).toMatchObject({
      reason: "name_not_in_quote",
      evidenceType: "self_introduction",
    });
    const banana = verifyEvidence(
      prepared([seg("x", "2", "I like banana bread.", 100)]),
      [
        prop({
          segmentId: "x",
          quote: "banana bread",
          label: "2",
          name: "ana",
        }),
      ],
      [{ unitKey: "candidates", segmentIds: ["x"] }],
    );
    expect(banana.verdicts[0]?.reason).toBe("name_not_in_quote");
  });

  it("7 passes with the spoken first name; the full name stays in the result", () => {
    const r = verifyEvidence(
      prepared([seg("x", "2", "Hi everyone, I am Milana.", 100)], {
        attendeeNames: ["Milana Marjanovic"],
      }),
      [
        prop({
          segmentId: "x",
          quote: "I am Milana",
          label: "2",
          name: "Milana Marjanovic",
        }),
      ],
      [{ unitKey: "candidates", segmentIds: ["x"] }],
    );
    expect(r.verdicts[0]).toMatchObject({
      status: "kept",
      proposedName: "Milana Marjanovic",
      finalName: "Milana Marjanovic",
    });
    expect(r.suggestions[0]?.name).toBe("Milana Marjanovic");
  });

  it("7 passes one letter off: quote Harris, proposal Haris", () => {
    const r = verifyEvidence(
      prepared([seg("x", "2", "Hi, this is Harris from sales.", 100)], {
        attendeeNames: ["Haris Kovac"],
      }),
      [
        prop({
          segmentId: "x",
          quote: "this is Harris",
          label: "2",
          name: "Haris",
        }),
      ],
      [{ unitKey: "candidates", segmentIds: ["x"] }],
    );
    expect(r.verdicts[0]?.status).toBe("kept");
    expect(r.suggestions[0]?.name).toBe("Haris Kovac");
  });

  it("7 still fails when the quote holds neither the name nor its first name", () => {
    const r = verify([
      prop({
        segmentId: "a",
        quote: "this is Ana",
        label: "2",
        name: "Milana Marjanovic",
      }),
    ]);
    expect(r.verdicts[0]?.reason).toBe("name_not_in_quote");
  });

  it("8 still fails for a third-person mention of the first name", () => {
    const r = verifyEvidence(
      prepared([seg("x", "2", "I asked Milana about it yesterday.", 100)]),
      [
        prop({
          segmentId: "x",
          quote: "I asked Milana about it",
          label: "2",
          name: "Milana Marjanovic",
        }),
      ],
      [{ unitKey: "candidates", segmentIds: ["x"] }],
    );
    expect(r.verdicts[0]?.reason).toBe("not_self_introduction");
  });

  it("8 not_self_introduction: the label's own line only greets a name", () => {
    const r = verifyEvidence(
      prepared([seg("x", "2", "Hello Marcus, how are you today.", 100)]),
      [
        prop({
          segmentId: "x",
          quote: "Hello Marcus",
          label: "2",
          name: "Marcus",
        }),
      ],
      [{ unitKey: "candidates", segmentIds: ["x"] }],
    );
    expect(r.verdicts[0]).toMatchObject({
      reason: "not_self_introduction",
      evidenceType: "self_introduction",
    });
  });

  it("9 conflict_lost and 10 duplicate_same_name: one winner for each label", () => {
    const r = verify([
      prop({ segmentId: "d", quote: "I am Ben", label: "3", name: "Ben" }), // self-introduction, later
      prop({ segmentId: "a", quote: "this is Ana", label: "3", name: "Ana" }), // addressed_as, the line of label 2
      prop({ segmentId: "d", quote: "I am Ben", label: "3", name: "ben" }), // same name as the winner
    ]);
    expect(r.verdicts.map((v) => [v.status, v.reason])).toEqual([
      ["kept", null],
      ["dropped", "conflict_lost"],
      ["dropped", "duplicate_same_name"],
    ]);
    expect(r.verdicts[1]?.winnerCallId).toBe(7);
    expect(r.verdicts[1]?.detail).toContain("Ben");
    expect(r.suggestions).toEqual([
      {
        label: "3",
        kind: "name",
        name: "Ben",
        evidence: "I am Ben",
        evidenceType: "self_introduction",
        segmentId: "d",
      },
    ]);
  });
});

describe("verifyEvidence: evidence types, conflicts and spelling", () => {
  it("a name on the line of a different label is addressed_as and passes", () => {
    const r = verify([
      prop({
        segmentId: "b",
        quote: "Thank you, Ana",
        label: "2",
        name: "Ana",
      }),
    ]);
    expect(r.verdicts[0]).toMatchObject({
      status: "kept",
      evidenceType: "addressed_as",
    });
  });

  it("a role keeps role_detail; an early role loses to a later self-introduced name", () => {
    const role = verify([
      prop({
        segmentId: "d",
        quote: "client contact",
        label: "3",
        name: "the client",
        kind: "role",
      }),
    ]);
    expect(role.verdicts[0]).toMatchObject({
      status: "kept",
      evidenceType: "role_detail",
    });
    const both = verify([
      prop({
        segmentId: "b",
        quote: "Let us start",
        label: "3",
        name: "the host",
        kind: "role",
      }),
      prop({ segmentId: "d", quote: "I am Ben", label: "3", name: "Ben" }),
    ]);
    expect(both.verdicts.map((v) => v.status)).toEqual(["dropped", "kept"]);
    expect(both.suggestions[0]?.name).toBe("Ben");
  });

  it("Anna and Ana with attendee Ana Lima: one winner, respelledFrom set (N8)", () => {
    const segs = [
      seg("q", "2", "Hi, this is Ana again.", 100),
      seg("p", "2", "Hello, this is Anna from sales.", 200),
    ];
    const r = verifyEvidence(
      prepared(segs, { attendeeNames: ["Ana Lima"] }),
      [
        prop({
          segmentId: "p",
          quote: "this is Anna",
          label: "2",
          name: "Anna",
        }),
        prop({ segmentId: "q", quote: "this is Ana", label: "2", name: "Ana" }),
      ],
      [{ unitKey: "candidates", segmentIds: ["p", "q"] }],
    );
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]?.name).toBe("Ana Lima");
    expect(r.verdicts.map((v) => [v.status, v.reason])).toEqual([
      ["dropped", "conflict_lost"],
      ["kept", null],
    ]);
    expect(r.verdicts[1]).toMatchObject({
      respelledFrom: "Ana",
      finalName: "Ana Lima",
    });
    // The quote keeps the transcript spelling.
    expect(r.suggestions[0]?.evidence).toBe("this is Ana");
  });

  it("two spellings of one attendee join before the conflict policy (Marcos, Marcus)", () => {
    const segs = [
      seg("p", "2", "Hello, this is Marcos from sales.", 100),
      seg("q", "2", "Hi, this is Marcus again.", 200),
    ];
    const r = verifyEvidence(
      prepared(segs, { attendeeNames: ["Marcus Silva", "Markus Lee"] }),
      [
        prop({
          segmentId: "p",
          quote: "this is Marcos",
          label: "2",
          name: "Marcos",
        }),
        prop({
          segmentId: "q",
          quote: "this is Marcus",
          label: "2",
          name: "Marcus",
        }),
      ],
      [{ unitKey: "candidates", segmentIds: ["p", "q"] }],
    );
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]?.name).toBe("Marcus Silva");
    expect(r.verdicts.map((v) => [v.status, v.reason])).toEqual([
      ["kept", null],
      ["dropped", "duplicate_same_name"],
    ]);
    expect(r.verdicts[0]?.respelledFrom).toBe("Marcos");
  });

  it("every verdict carries unitKey, call id, seq, status and a reason when dropped (D10)", () => {
    const r = verify([
      prop({ segmentId: "a", quote: "this is Ana", label: "2", name: "Ana" }),
      prop({ segmentId: "a", quote: "nope", label: "2", name: "Ana" }),
    ]);
    for (const v of r.verdicts) {
      expect(v.unitKey).toBe("candidates");
      expect(v.llmCallId).toBe(7);
      expect(["kept", "dropped"]).toContain(v.status);
      if (v.status === "dropped") expect(v.reason).not.toBeNull();
    }
    expect(r.verdicts[0]?.seq).not.toBe(r.verdicts[1]?.seq);
  });

  it("a name longer than 80 characters is cut", () => {
    const name = `Ana ${"x".repeat(200)}`;
    const r = verifyEvidence(
      prepared([seg("x", "2", `Hi, this is ${name}`, 10)]),
      [prop({ segmentId: "x", quote: `this is ${"Ana"}`, label: "2", name })],
      [{ unitKey: "candidates", segmentIds: ["x"] }],
    );
    expect(r.verdicts[0]?.proposedName.length).toBeGreaterThan(80);
    expect((r.suggestions[0]?.name ?? "").length).toBeLessThanOrEqual(80);
  });
});
