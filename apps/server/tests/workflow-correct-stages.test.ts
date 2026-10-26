// The stages of Enhance `correctChunk` (the owner rule "specialization over
// over-prompting", AGENTS.md): code vocabulary spelling, the LLM job "fix
// misheard words", code line-language check, the LLM job `retranscribeLines`.
// Each stage has its own tests. All text is made up.
import { detectAll } from "tinyld";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import {
  baseLanguage,
  isOffLanguage,
  offLanguageIds,
} from "../src/lib/meetings/line-language.js";
import { fixVocabSpelling } from "../src/lib/meetings/vocab-spelling.js";
import { estimateTokens } from "../src/lib/meetings/workflow/chunking.js";
import {
  checkRetranscriptions,
  mergeStages,
} from "../src/lib/meetings/workflow/nodes/correct-chunk.js";
import {
  buildCorrectSystemPrompt,
  buildRetranscribeSystemPrompt,
} from "../src/lib/meetings/workflow/prompts.js";
import type {
  CorrectUnitResult,
  PreparedSegment,
} from "../src/lib/meetings/workflow/types.js";
import { okReply } from "./helpers/fake-model.js";
import {
  makeTestDeps,
  resetWorkflowTables,
  runScriptedGraph,
  seedFixtureMeeting,
  seedTestModel,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const PT_LINE =
  "nós vamos fazer o deploy da nova versão amanhã de manhã com a equipe";
const EN_LINE = "we will ship the new version tomorrow morning with the team";

function seg(id: string, text: string): PreparedSegment {
  return {
    id,
    speaker: "Me",
    startMs: 0,
    speakerLabel: null,
    displayLabel: "Me",
    text,
    enhancedText: null,
    speakerName: null,
  };
}

describe("stage 1 (code): vocabulary spelling", () => {
  const vocab = [
    "Openstyle",
    "GitHub",
    "OpenAI",
    "Heidemann",
    "Go",
    "Kubernetes",
  ];

  it("joins split words into one term", () => {
    expect(fixVocabSpelling("we use open style daily", vocab)).toBe(
      "we use Openstyle daily",
    );
    expect(fixVocabSpelling("push it to git hub, please", vocab)).toBe(
      "push it to GitHub, please",
    );
  });

  it("fixes the case of a term with a marked case only", () => {
    expect(fixVocabSpelling("the openai model works", vocab)).toBe(
      "the OpenAI model works",
    );
    // "Go" has no marked case: "go" is also a common word.
    expect(fixVocabSpelling("we go home", vocab)).toBe("we go home");
    // "Kubernetes" has no marked case either: the LLM stage decides.
    expect(fixVocabSpelling("the kubernetes cluster", vocab)).toBe(
      "the kubernetes cluster",
    );
  });

  it("fixes a capitalized name one letter away, not at a sentence start", () => {
    expect(fixVocabSpelling("ask Marcos Heideman about it", vocab)).toBe(
      "ask Marcos Heidemann about it",
    );
    expect(fixVocabSpelling("Heideman said yes.", vocab)).toBe(
      "Heideman said yes.",
    );
    // A short or lowercase word never changes.
    expect(fixVocabSpelling("ask heideman about it", vocab)).toBe(
      "ask heideman about it",
    );
  });

  it("changes nothing when two terms match or no term is given", () => {
    expect(fixVocabSpelling("ask Jensen now", ["Jansen", "Jenson"])).toBe(
      "ask Jensen now",
    );
    expect(fixVocabSpelling("the the plan", [])).toBe("the the plan");
  });

  it("keeps repeats, fillers and punctuation as they are", () => {
    const text = "um, the the open style plan... you know?";
    expect(fixVocabSpelling(text, vocab)).toBe(
      "um, the the Openstyle plan... you know?",
    );
  });
});

describe("stage 2 (LLM): the fix-misheard-words prompt has one job", () => {
  it("has no punctuation, repeat or translation job and is short", () => {
    const prompt = buildCorrectSystemPrompt({ language: "en", vocabTerms: [] });
    expect(prompt).toContain("You fix misheard words");
    expect(prompt).not.toMatch(/punctuation and capitalization/i);
    expect(prompt).not.toMatch(/translated/i);
    expect(prompt).not.toMatch(/remove a word that the speaker repeated/i);
    expect(prompt).toContain("Keep all other words, fillers, repeats");
    // The old multi-job prompt was 696 tokens (estimateTokens), the new one 248.
    expect(estimateTokens(prompt)).toBeLessThan(330);
  });

  it("lists the vocabulary on one line", () => {
    const prompt = buildCorrectSystemPrompt({
      language: null,
      vocabTerms: ["Openstyle", "GitHub"],
    });
    expect(prompt).toContain("Names and terms of this user: Openstyle, GitHub");
  });
});

describe("stage 4 (LLM): the retranscribeLines prompt has one job", () => {
  it("names the meeting language and asks for each line again", () => {
    const prompt = buildRetranscribeSystemPrompt("en");
    expect(prompt).toContain('The meeting language is "en"');
    expect(prompt).toContain('Write each line again in "en"');
    expect(prompt).toContain("Keep names, numbers and terms as they are.");
    expect(estimateTokens(prompt)).toBeLessThan(150);
  });
});

describe("stage 3 (code): lines in another language", () => {
  it("flags a clear line in another language than the pin", () => {
    expect(isOffLanguage(PT_LINE, "en", detectAll)).toBe(true);
    expect(isOffLanguage(EN_LINE, "en", detectAll)).toBe(false);
    expect(isOffLanguage(EN_LINE, "pt", detectAll)).toBe(true);
  });

  it("never flags a short line", () => {
    expect(isOffLanguage("sim, obrigado", "en", detectAll)).toBe(false);
  });

  it("flags nothing without a pinned language, and reads a region code", () => {
    const lines = [
      { id: "a", text: EN_LINE },
      { id: "b", text: PT_LINE },
    ];
    expect(offLanguageIds(lines, null, detectAll)).toEqual([]);
    expect(offLanguageIds(lines, "en", detectAll)).toEqual(["b"]);
    expect(offLanguageIds(lines, "pt-BR", detectAll)).toEqual(["a"]);
    expect(baseLanguage("pt-BR")).toBe("pt");
  });

  it("never flags a line whose top language is not a meeting language", () => {
    const fake = () => [{ lang: "ber", accuracy: 0.95 }];
    expect(isOffLanguage(EN_LINE, "en", fake)).toBe(false);
  });
});

describe("stage 4 (code after the LLM): retranscription checks", () => {
  const segments = [
    seg("b", PT_LINE),
    seg("c", "o custo foi 42 mil reais no total este mês"),
  ];

  it("keeps a line in the meeting language with the same numbers", () => {
    const r = checkRetranscriptions(
      [{ id: "b", text: EN_LINE }],
      segments,
      7,
      "en",
      detectAll,
    );
    expect(r.corrections).toEqual([
      { id: "b", text: EN_LINE, seq: 0, callId: 7 },
    ]);
    expect(r.dropped).toEqual([]);
  });

  it("drops a line in the wrong language, a lost number and a false flag", () => {
    const r = checkRetranscriptions(
      [
        { id: "b", text: "vamos lançar a versão nova amanhã cedo com o time" },
        { id: "c", text: "the cost was 41 thousand reais in total this month" },
        { id: "b", text: `${PT_LINE} hoje` },
      ],
      segments,
      7,
      "en",
      detectAll,
    );
    expect(r.corrections).toEqual([]);
    expect(r.dropped.map((d) => [d.id, d.reason])).toEqual([
      ["b", "wrong_language"],
      ["c", "too_different"],
      ["b", "wrong_language"],
    ]);
  });

  it("drops a rewrite that keeps most words (the line was not off-language)", () => {
    const en = [seg("e", EN_LINE)];
    const r = checkRetranscriptions(
      [{ id: "e", text: `${EN_LINE} too` }],
      en,
      7,
      "en",
      detectAll,
    );
    expect(r.dropped.map((d) => d.reason)).toEqual(["unchanged"]);
  });
});

describe("mergeStages: the last stage that changed a segment wins", () => {
  const unit = (over: Partial<CorrectUnitResult>): CorrectUnitResult => ({
    unitKey: "chunk:0",
    segmentIds: ["a", "b", "c", "d"],
    status: "ok",
    corrections: [],
    dropped: [],
    failure: null,
    ...over,
  });
  const raw = new Map([
    ["a", "a raw"],
    ["b", "b raw"],
    ["c", "c raw"],
    ["d", "d raw"],
  ]);
  const code = new Map([
    ["a", "a code"],
    ["b", "b code"],
    ["c", "c raw"],
    ["d", "d raw"],
  ]);

  it("retranscription, then LLM fix, then code fix", () => {
    const [u] = mergeStages(
      [
        unit({
          corrections: [
            { id: "b", text: "b llm", seq: 0, callId: 1 },
            { id: "c", text: "c llm", seq: 1, callId: 1 },
          ],
        }),
      ],
      raw,
      code,
      {
        corrections: [{ id: "c", text: "c retr", seq: 0, callId: 2 }],
        dropped: [{ id: "d", reason: "wrong_language", seq: 1, callId: 2 }],
      },
    );
    expect(u?.corrections.map((c) => [c.id, c.text, c.callId])).toEqual([
      ["a", "a code", null],
      ["b", "b llm", 1],
      ["c", "c retr", 2],
    ]);
    expect(u?.dropped.map((d) => [d.id, d.reason])).toEqual([
      ["d", "wrong_language"],
    ]);
  });

  it("a unit that is not ok stays as it is", () => {
    const failed = unit({ status: "failed" });
    expect(
      mergeStages([failed], raw, code, { corrections: [], dropped: [] }),
    ).toEqual([failed]);
  });
});

describe("the stages in a graph run", () => {
  beforeEach(() => {
    resetWorkflowTables();
    __resetLlmLanesForTests();
    __clearModeCacheForTests();
    seedTestModel();
  });
  afterEach(() => {
    getDb().exec("DELETE FROM vocabulary");
  });

  it("one retranscribeLines call gets only the off-language line; the code fix lands with no call", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-st" });
    const [a, b] = f.segments.map((s) => s.id) as [string, string];
    const update = getDb().prepare(
      "UPDATE meeting_segments SET text = ? WHERE id = ?",
    );
    update.run("we keep the notes in open style for the whole team", a);
    update.run(PT_LINE, b);
    getDb()
      .prepare("INSERT INTO vocabulary (term) VALUES (?)")
      .run("Openstyle");
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: (req) =>
        req.system.startsWith("The meeting language")
          ? okReply(JSON.stringify({ corrections: [{ id: b, text: EN_LINE }] }))
          : okReply('{"corrections":[]}'),
    });
    expect(r.requests).toHaveLength(2);
    expect(r.requests[0]?.system).toMatch(/^You fix misheard words/);
    // The LLM stage sees the code fix.
    expect(r.requests[0]?.user).toContain("Openstyle for the whole team");
    const retr = r.requests[1];
    expect(retr?.system).toMatch(/^The meeting language is "en"/);
    expect(retr?.user).toContain(`[${b}]`);
    expect(retr?.user).not.toContain(`[${a}]`);
    const text = (id: string) =>
      (
        getDb()
          .prepare("SELECT enhanced_text FROM meeting_segments WHERE id = ?")
          .get(id) as { enhanced_text: string | null }
      ).enhanced_text;
    expect(text(a)).toBe("we keep the notes in Openstyle for the whole team");
    expect(text(b)).toBe(EN_LINE);
    expect(r.finalState.corrections[0]?.status).toBe("ok");
  });

  it("an English meeting with no off-language line makes no retranscribeLines call", async () => {
    const f = seedFixtureMeeting({
      chunks: 1,
      speakers: 1,
      meetingId: "m-st2",
    });
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: () => okReply('{"corrections":[]}'),
    });
    expect(r.requests).toHaveLength(1);
  });
});
