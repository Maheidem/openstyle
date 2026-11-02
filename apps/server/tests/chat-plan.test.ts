// The plan table, the slot schema and the planned calls (specs/
// meeting-chat-agent.md 2.3 stage 2). No model. All text is fictional.
import { describe, expect, it } from "vitest";
import type { Choices } from "../src/lib/chat/choices.js";
import {
  asksDecisions,
  asksElaboration,
  asksForCount,
  asksNextSteps,
  asksOverview,
  asksSynthesis,
  defaultSlots,
  followUpQuery,
  isDependentFollowUp,
  mentionPhrase,
  planFor,
  plannedCalls,
  refineIntent,
  reviewKind,
  slotSystem,
  slotZod,
} from "../src/lib/chat/plan.js";
import { asksForStatus } from "../src/lib/chat/prompts.js";
import type { TurnScope } from "../src/lib/chat/types.js";

const TODAY = Date.UTC(2026, 9, 26);
const CH: Choices = {
  people: [{ id: "ana lima", name: "Ana Lima" }],
  items: [{ label: "A1", id: "key1", text: "Write the rollback plan" }],
  meetings: [
    { label: "M1", id: "m1", text: "Harbor Sync (2026-09-15)" },
    { label: "M2", id: "m2", text: "Pier Review (2026-09-22)" },
  ],
  folders: [{ id: "f1", name: "Atlas" }],
  scopeMeetingIds: new Set(["m1", "m2"]),
};
const ALL: TurnScope = { kind: "all", id: null };
const FOLDER: TurnScope = { kind: "folder", id: "f1" };
const MEETING: TurnScope = { kind: "meeting", id: "m1" };
const calls = (
  intent: Parameters<typeof plannedCalls>[0],
  scope: TurnScope,
  q: string,
  slots = defaultSlots(q),
  round = 1,
) => plannedCalls(intent, scope, slots, CH, q, TODAY, round);

describe("planFor", () => {
  it("follows the table", () => {
    expect(planFor("lookup", "meeting")).toEqual([
      "search_chunks",
      "get_meeting_summary",
    ]);
    expect(planFor("lookup", "folder")).toEqual(["search_chunks"]);
    expect(planFor("who_said", "all")).toEqual([
      "search_chunks",
      "get_transcript_window",
    ]);
    expect(planFor("status", "folder")).toEqual(["folder_status"]);
    expect(planFor("status", "meeting")).toEqual(["get_meeting_summary"]);
    expect(planFor("status", "all")).toEqual([
      "list_meetings",
      "list_action_items",
    ]);
    expect(planFor("review", "folder")).toEqual([
      "list_decisions_questions",
      "list_action_items",
    ]);
    expect(planFor("other", "all")).toEqual(planFor("lookup", "all"));
  });
  it("write gives the four propose tools; no plan shows more than 8 tools", () => {
    expect(planFor("write", "all")).toHaveLength(4);
    for (const i of [
      "lookup",
      "who_said",
      "aggregate",
      "temporal",
      "review",
      "status",
      "write",
      "other",
    ] as const)
      for (const s of ["meeting", "folder", "all"] as const)
        expect(planFor(i, s).length).toBeLessThanOrEqual(8);
  });
});

describe("asksForCount", () => {
  it.each([
    "How many meetings did we have?",
    "What is the number of open items?",
    "Quantas reuniões tivemos?",
    "Quantos itens estão abertos?",
    "¿Cuántos temas hay?",
    "Wie viele Meetings gab es?",
    "Combien de réunions ?",
    "Quanti incontri abbiamo avuto?",
  ])("true: %s", (q) => expect(asksForCount(q)).toBe(true));
  it.each([
    "List the open items",
    "Who owns the plan?",
    "Liste as decisões",
  ])("false: %s", (q) => expect(asksForCount(q)).toBe(false));
});

describe("plannedCalls", () => {
  it("lookup: one search with the dates of the question", () => {
    const q = "What was decided about the pilot on September 15?";
    const [c] = calls("lookup", ALL, q);
    expect(c?.tool).toBe("search_chunks");
    expect(c?.args).toMatchObject({
      query: q,
      date_from: "2026-09-15",
      date_to: "2026-09-15",
    });
  });

  it("uses the query slot, and the question when the slot is too long", () => {
    const q = "and who owns it?";
    expect(
      calls("lookup", ALL, q, {
        ...defaultSlots(q),
        query: "rollback plan owner",
      })[0]?.args,
    ).toMatchObject({ query: "rollback plan owner" });
    expect(
      calls("lookup", ALL, q, { ...defaultSlots(q), query: "x".repeat(300) })[0]
        ?.args,
    ).toMatchObject({ query: q });
  });

  it("scope meeting limits the search to that meeting", () => {
    expect(calls("lookup", MEETING, "pilot?")[0]?.args).toMatchObject({
      meeting_ids: ["m1"],
    });
  });

  it("round 2 raises k and drops the dates; round 3 cuts the query", () => {
    const q =
      "What did the committee decide about the storage cluster budget on September 15?";
    const r1 = calls("lookup", ALL, q)[0]?.args as Record<string, unknown>;
    const r2 = calls("lookup", ALL, q, undefined, 2)[0]?.args as Record<
      string,
      unknown
    >;
    const r3 = calls("lookup", ALL, q, undefined, 3)[0]?.args as Record<
      string,
      unknown
    >;
    expect(r1.k).toBeUndefined();
    expect(r1.date_from).toBe("2026-09-15");
    expect(r2.k).toBe(20);
    expect(r2.date_from).toBeUndefined();
    expect(r2.query).toBe(r1.query);
    expect(r3.k).toBe(20);
    expect((r3.query as string).split(" ")).toHaveLength(3);
    expect(r3.query).toBe("committee storage September");
  });

  it("aggregate: open action items of a person, or a meeting count", () => {
    const a = calls("aggregate", ALL, "List the open items of Ana", {
      ...defaultSlots("x"),
      person: "ana lima",
    });
    expect(a).toEqual([
      {
        tool: "list_action_items",
        args: { status: "open", person_id: "ana lima" },
      },
    ]);
    const unknown = calls("aggregate", ALL, "List items", {
      ...defaultSlots("x"),
      person: "nobody",
    });
    expect(unknown[0]?.args).toEqual({ status: "open" });
    const done = calls("aggregate", ALL, "How many tasks are done?");
    expect(done[0]?.args).toMatchObject({ status: "done" });
    expect(
      calls("aggregate", ALL, "How many meetings did we have last week?")[0]
        ?.tool,
    ).toBe("list_meetings");
    expect(
      calls("aggregate", MEETING, "How many tasks?")[0]?.args,
    ).toMatchObject({ meeting_id: "m1" });
  });

  it("temporal: list meetings when a date exists, else search", () => {
    expect(
      calls(
        "temporal",
        FOLDER,
        "Which meetings did we have on September 22?",
      )[0],
    ).toMatchObject({
      tool: "list_meetings",
      args: { date_from: "2026-09-22" },
    });
    expect(calls("temporal", ALL, "When is the cutover?")[0]?.tool).toBe(
      "search_chunks",
    );
  });

  it("review: kind from the slot, else from the words", () => {
    expect(
      calls("review", FOLDER, "Show all decisions", {
        ...defaultSlots("x"),
        kind: "open_question",
      })[0]?.args,
    ).toMatchObject({ kind: "open_question" });
    expect(
      calls("review", FOLDER, "Show the open questions")[0]?.args,
    ).toMatchObject({ kind: "open_question" });
    expect(
      calls("review", FOLDER, "Show all decisions")[0]?.args,
    ).toMatchObject({ kind: "decision" });
  });

  it("status per scope", () => {
    expect(calls("status", MEETING, "status?")).toEqual([
      { tool: "get_meeting_summary", args: { meeting_id: "m1" } },
    ]);
    expect(calls("status", FOLDER, "status?")).toEqual([
      { tool: "folder_status", args: {} },
    ]);
    expect(calls("status", ALL, "status?").map((c) => c.tool)).toEqual([
      "list_meetings",
      "list_action_items",
    ]);
  });

  it("write: ids from labels; a missing slot gives no call", () => {
    const s = {
      ...defaultSlots("x"),
      change: "action_item" as const,
      item: "A1",
    };
    expect(calls("write", ALL, "Mark the rollback plan as done", s)).toEqual([
      {
        tool: "propose_action_item_change",
        args: { item_id: "key1", done: true },
      },
    ]);
    expect(
      calls("write", ALL, "Reopen the rollback plan", s)[0]?.args,
    ).toMatchObject({ done: false });
    expect(calls("write", ALL, "x", { ...s, item: "none" })).toEqual([]);
    expect(calls("write", ALL, "x", { ...s, item: "A9" })).toEqual([]);
    expect(
      calls("write", ALL, "Move Harbor Sync to Atlas", {
        ...defaultSlots("x"),
        change: "move",
        meeting: "M1",
        folder: "f1",
      }),
    ).toEqual([
      { tool: "propose_move", args: { meeting_id: "m1", folder_id: "f1" } },
    ]);
    expect(
      calls("write", ALL, "Tag it", {
        ...defaultSlots("x"),
        change: "retag",
        meeting: "M2",
        tag: "pilot",
      }),
    ).toEqual([
      { tool: "propose_retag", args: { meeting_ids: ["m2"], tag: "pilot" } },
    ]);
    expect(
      calls("write", ALL, "Merge Ana", {
        ...defaultSlots("x"),
        change: "merge_people",
        person: "ana lima",
      }),
    ).toEqual([
      { tool: "propose_merge_people", args: { person_ids: ["ana lima"] } },
    ]);
    expect(calls("write", ALL, "x", s, 2)).toEqual([]);
  });
});

describe("slots", () => {
  it("has no date fields and closed choices", () => {
    const z = slotZod("aggregate", CH);
    expect(z?.safeParse({ person: "ana lima" }).success).toBe(true);
    expect(z?.safeParse({ person: "nobody" }).success).toBe(false);
    expect(
      z?.safeParse({ person: "none", date_from: "2026-01-01" }).success,
    ).toBe(false);
    expect(slotZod("status", CH)).toBeNull();

    const w = slotZod("write", CH);
    expect(
      w?.safeParse({
        change: "move",
        item: "none",
        meeting: "M2",
        folder: "f1",
        person: "none",
        tag: null,
      }).success,
    ).toBe(true);
    expect(
      w?.safeParse({
        change: "move",
        item: "A9",
        meeting: "M2",
        folder: "f1",
        person: "none",
        tag: null,
      }).success,
    ).toBe(false);
  });

  it("the prompt names no date field and lists the choices", () => {
    const p = slotSystem("write", CH, "2026-10-26");
    expect(p).not.toMatch(/date_from|date_to/);
    expect(p).toContain('A1="Write the rollback plan"');
    expect(p).toContain("M2=Pier Review (2026-09-22)");
    // lookup, who_said and temporal have no model field: the query is made by code.
    expect(slotZod("lookup", CH)).toBeNull();
    expect(slotZod("temporal", CH)).toBeNull();
  });

  it("defaultSlots uses the question as the query", () => {
    expect(defaultSlots("who owns it?").query).toBe("who owns it?");
  });
});

describe("follow-up query (P1.1)", () => {
  const turns = [
    { question: "Who will write the rollback plan?", answer: "Ana Silvestre" },
  ];
  it("holds the new question, the earlier question and its answer", () => {
    expect(followUpQuery("And when is that due?", turns)).toBe(
      "And when is that due? Who will write the rollback plan? Ana Silvestre",
    );
  });
  it("uses the base query of the model instead of the question", () => {
    expect(followUpQuery("and when?", turns, "rollback plan due")).toBe(
      "rollback plan due Who will write the rollback plan? Ana Silvestre",
    );
  });
  it("my first question points to the first turn", () => {
    const many = [
      { question: "First topic?", answer: "alpha" },
      { question: "Second topic?", answer: "beta" },
    ];
    expect(
      followUpQuery("Back to my first question: when is it?", many),
    ).toContain("First topic? alpha");
    expect(followUpQuery("And when is it?", many)).toContain("Second topic?");
  });
  it("leaves out an answer that names no topic and cuts at 200 characters", () => {
    expect(
      followUpQuery("when?", [{ question: "Q1?", answer: "found nothing" }]),
    ).toBe("when? Q1?");
    expect(
      followUpQuery("x".repeat(300), [{ question: "Q1?", answer: "a" }]).length,
    ).toBeLessThanOrEqual(200);
  });
  it("defaultSlots builds the same query from the turns", () => {
    expect(defaultSlots("and when?", turns).query).toContain(
      "rollback plan? Ana Silvestre",
    );
    expect(defaultSlots("and when?", turns).query).toMatch(/^and when\?/);
    expect(defaultSlots("who owns it?").query).toBe("who owns it?");
  });
});

describe("follow-up or new topic (P1.2)", () => {
  const long = [
    {
      question: "What has been decided?",
      answer:
        "The team decided to move the database to Postgres before the cutover window on Sunday night. ".repeat(
          4,
        ),
    },
  ];
  it("a short question or one with a reference word is a follow-up", () => {
    for (const q of [
      "Why?",
      "Por quê?",
      "But why did we decide that?",
      "Who said that?",
      "Quem disse isso?",
      "And when is that due?",
      "E para quando isso é?",
      "Back to my first question: when is that task due?",
      "それはいつ?",
    ]) {
      expect(isDependentFollowUp(q), q).toBe(true);
    }
  });
  it("a question with its own topic is not a follow-up", () => {
    for (const q of [
      "What did we decide on the database engine?",
      "How much is the quote for the network gateway?",
      "Quando é o teste de rollback?",
      "What did this meeting decide about the budget for hosting?",
      "Who proposed the pilot program?",
      "Why did we pick Postgres for the database?",
      "Quem vai escrever o plano de rollback?",
    ]) {
      expect(isDependentFollowUp(q), q).toBe(false);
    }
  });
  it("a new topic searches with its own words only", () => {
    const q = "What did we decide on the database engine?";
    expect(followUpQuery(q, long)).toBe(q);
  });
  it("a follow-up query is not taken over by a long earlier answer", () => {
    const query = followUpQuery("Why?", long);
    expect(query.startsWith("Why? What has been decided?")).toBe(true);
    expect(query.length).toBeLessThan(150);
  });
  it("a follow-up of a follow-up keeps the topic of the first question", () => {
    const turns = [
      { question: "How much is the quote for the gateway?", answer: "49,600" },
      { question: "Why?", answer: "found nothing" },
    ];
    const q = followUpQuery("Who said that?", turns);
    expect(q.startsWith("Who said that? Why? How much is the quote")).toBe(
      true,
    );
    expect(q).toContain("49,600");
  });
  it("detects an overview question in the UI languages", () => {
    for (const q of [
      "But, what WAS this meeting about?",
      "What was this meeting about?",
      "Sobre o que foi esta reunião?",
      "Mas, sobre o que FOI esta reunião?",
      "¿De qué trató esta reunión?",
      "Worum ging es in dieser Besprechung?",
      "De quoi parlait cette réunion ?",
      "Di cosa trattava questa riunione?",
      "この会議は何についてでしたか",
    ]) {
      expect(asksOverview(q), q).toBe(true);
    }
    for (const q of [
      "What did we decide on the database engine?",
      "Who will write the rollback plan?",
      "When is the launch?",
    ]) {
      expect(asksOverview(q), q).toBe(false);
    }
  });
});

describe("decisions and next steps read the summary (P1.2)", () => {
  it("a broad decisions question is detected in the UI languages", () => {
    for (const q of [
      "What has been decided?",
      "what did we decide",
      "What did we decide in this meeting?",
      "What was decided so far?",
      "So, what have we decided?",
      "Decisions",
      "O que foi decidido?",
      "o que decidimos nesta reunião?",
      "Decisões",
      "¿Qué se decidió?",
      "¿Qué decidimos?",
      "Decisiones",
      "Was wurde entschieden?",
      "Was haben wir beschlossen?",
      "Entscheidungen",
      "Qu'est-ce qui a été décidé ?",
      "Qu'avons-nous décidé ?",
      "Décisions",
      "Cosa è stato deciso?",
      "Cosa abbiamo deciso?",
      "Decisioni",
      "何が決まりましたか",
      "決定事項",
    ]) {
      expect(asksDecisions(q), q).toBe(true);
    }
  });
  it("a decision about a topic or a list request is not a broad question", () => {
    for (const q of [
      "What did we decide on the database engine?",
      "What has been decided about the launch date?",
      "O que decidimos sobre o motor do banco?",
      "Show all decisions",
      "List the decisions of this meeting",
      "Mostre todas as decisões",
      "Why did we decide that?",
      "What was this meeting about?",
    ]) {
      expect(asksDecisions(q), q).toBe(false);
    }
  });
  it("a next steps question is detected in the UI languages", () => {
    for (const q of [
      "What are the next steps?",
      "next steps",
      "What's next?",
      "What are the action items?",
      "Quais são os próximos passos?",
      "Próximos passos",
      "¿Cuáles son los próximos pasos?",
      "Was sind die nächsten Schritte?",
      "Quelles sont les prochaines étapes ?",
      "Quali sono i prossimi passi?",
      "次のステップは何ですか",
    ]) {
      expect(asksNextSteps(q), q).toBe(true);
    }
    for (const q of [
      "Who will write the rollback plan?",
      "What are the next steps for the migration budget?",
      "What did we decide?",
    ]) {
      expect(asksNextSteps(q), q).toBe(false);
    }
  });
});

describe("review kind by code (P1.1)", () => {
  it("reads decisions and open questions from the words", () => {
    expect(reviewKind("Show all decisions in Atlas Migration.")).toBe(
      "decision",
    );
    expect(reviewKind("Which questions are still open in Atlas?")).toBe(
      "open_question",
    );
    expect(reviewKind("Quais perguntas ainda estão em aberto?")).toBe(
      "open_question",
    );
    expect(defaultSlots("Show all decisions", [], "review").kind).toBe(
      "decision",
    );
    expect(defaultSlots("Show all decisions", [], "lookup").kind).toBeNull();
    // No model field: the slot call is skipped for a review.
    expect(slotZod("review", CH)).toBeNull();
  });
});

describe("mention count question (P1.1)", () => {
  it("returns the name of a count of meetings that name something", () => {
    expect(
      mentionPhrase("In how many meetings was Kestrel Hosting named?"),
    ).toBe("Kestrel Hosting");
    expect(
      mentionPhrase("Em quantas reuniões a Marlin Analytics foi citada?"),
    ).toBe("Marlin Analytics");
  });
  it("ignores a count of meetings of a project and other questions", () => {
    expect(
      mentionPhrase("How many meetings do we have in Atlas Migration?"),
    ).toBe(null);
    expect(mentionPhrase("Who named the Atlas Migration plan?")).toBeNull();
    expect(
      mentionPhrase("How many meetings mentioned the rollback?"),
    ).toBeNull();
  });
});

describe("status words", () => {
  it("find a status question in several languages", () => {
    expect(asksForStatus("Where do we stand on Atlas Migration?")).toBe(true);
    expect(asksForStatus("Em que pé estamos com Harbor Pricing?")).toBe(true);
    expect(asksForStatus("When is the code freeze?")).toBe(false);
  });
});

describe("refineIntent (P1.1)", () => {
  const T = Date.UTC(2026, 9, 26);
  it("a lookup that names a day with a number is temporal", () => {
    expect(
      refineIntent(
        "What did we decide on the database in the meeting on August 25?",
        "lookup",
        T,
      ),
    ).toBe("temporal");
    expect(
      refineIntent("What did we decide on the database?", "lookup", T),
    ).toBe("lookup");
    // A relative day alone does not move a lookup.
    expect(
      refineIntent("What did Brightline quote yesterday?", "lookup", T),
    ).toBe("lookup");
  });
  it("a temporal with no date, no when word and no meeting word is a lookup", () => {
    expect(
      refineIntent("What is the current date for the launch?", "temporal", T),
    ).toBe("lookup");
    expect(refineIntent("When is the launch?", "temporal", T)).toBe("temporal");
    expect(refineIntent("Quais reuniões tivemos?", "temporal", T)).toBe(
      "temporal",
    );
  });
  it("who_said needs a who word or a verb of speech", () => {
    expect(
      refineIntent("And which company confirmed that?", "who_said", T),
    ).toBe("lookup");
    expect(refineIntent("Who proposed a pilot?", "who_said", T)).toBe(
      "who_said",
    );
    expect(refineIntent("What did Sofia say about it?", "who_said", T)).toBe(
      "who_said",
    );
    expect(refineIntent("Show all decisions", "review", T)).toBe("review");
  });
});

describe("broad questions", () => {
  const BROAD = [
    "Tell me the story of this project so far. A good and complete onboarding",
    "Cant you tell me anything?",
    "gimme details",
    "I need more details about the whole project",
    "but how did this project begin? what is the history?",
    "Tell me everything that happened in this meeting.",
    "Catch me up on this project.",
    "What is this project about? Give me the big picture.",
    "Give me an overview of the Atlas project.",
    "me conta a história desse projeto",
    "como esse projeto começou?",
    "me dá mais detalhes",
    "Quero um onboarding completo desse projeto",
    "Me dá uma visão geral do projeto.",
    "O que já aconteceu nesse projeto?",
    "Cuéntame la historia del proyecto",
    "Dame más detalles",
    "Erzähl mir die Geschichte des Projekts",
    "Gib mir mehr Details",
    "Raconte-moi l'histoire du projet",
    "Donne-moi plus de détails",
    "Raccontami la storia del progetto",
    "Dammi più dettagli",
    "プロジェクトの経緯を教えて",
    "もっと詳しく教えて",
  ];
  const NARROW = [
    "What did we decide?",
    "What did we decide on the database?",
    "Who proposed the pilot?",
    "When is the launch?",
    "Why did we pick Postgres?",
    "List the open tasks of Ana.",
    "How many meetings did we have?",
    "What is the budget for the storage cluster?",
    "Qual foi o valor da cotação?",
    "Mark the task as done.",
  ];
  it.each(BROAD)("%s is a synthesis question", (q) => {
    expect(asksSynthesis(q) || asksOverview(q)).toBe(true);
  });
  it.each(NARROW)("%s stays a lookup", (q) => {
    expect(asksSynthesis(q)).toBe(false);
  });
  it("elaboration is a subset of synthesis", () => {
    expect(asksElaboration("gimme details")).toBe(true);
    expect(asksElaboration("Tell me more.")).toBe(true);
    expect(asksElaboration("Conte mais.")).toBe(true);
    expect(asksElaboration("Tell me the story of the project")).toBe(false);
    expect(asksSynthesis("Tell me more.")).toBe(true);
  });
  it("the 'What did the team decide?' wording reads the summary decisions", () => {
    expect(asksDecisions("What did the team decide?")).toBe(true);
    expect(asksDecisions("What did the team decide about hosting?")).toBe(
      false,
    );
  });
});
