// The stages of Enhance `correctChunk` (the owner rule "specialization over
// over-prompting", AGENTS.md): code vocabulary spelling, the LLM job "fix
// misheard words", code exact-repeat removal. Each stage has its own tests.
// All text is made up.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { removeRepeatedWords } from "../src/lib/meetings/repeat-words.js";
import { fixVocabSpelling } from "../src/lib/meetings/vocab-spelling.js";
import { estimateTokens } from "../src/lib/meetings/workflow/chunking.js";
import { mergeStages } from "../src/lib/meetings/workflow/nodes/correct-chunk.js";
import { buildCorrectSystemPrompt } from "../src/lib/meetings/workflow/prompts.js";
import type { CorrectUnitResult } from "../src/lib/meetings/workflow/types.js";
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

describe("stage 1b (code): exact repeated words", () => {
  it("removes an immediate repeat in any case", () => {
    expect(removeRepeatedWords("so the the plan is fine")).toBe(
      "so the plan is fine",
    );
    expect(removeRepeatedWords("The the plan")).toBe("The plan");
    expect(removeRepeatedWords("we we we go")).toBe("we go");
  });

  it("moves the punctuation after the removed word", () => {
    expect(removeRepeatedWords("I, I think so")).toBe("I think so");
    expect(removeRepeatedWords("we ship it it, then")).toBe("we ship it, then");
  });

  it("keeps words across a sentence end, after a quote, and numbers", () => {
    expect(removeRepeatedWords("No. No. We wait.")).toBe("No. No. We wait.");
    expect(removeRepeatedWords('he said "said" twice')).toBe(
      'he said "said" twice',
    );
    expect(removeRepeatedWords("in 20 20 and twenty twenty")).toBe(
      "in 20 20 and twenty twenty",
    );
    expect(removeRepeatedWords("No, no. We wait")).toBe("No, no. We wait");
    expect(removeRepeatedWords("I don't don't know")).toBe(
      "I don't don't know",
    );
  });

  it("keeps the capital of the second word", () => {
    expect(removeRepeatedWords("next stages. the The step")).toBe(
      "next stages. The step",
    );
  });

  it("returns an unchanged text as it is, spacing included", () => {
    expect(removeRepeatedWords("  a  plan ")).toBe("  a  plan ");
  });
});

describe("stage 2 (LLM): the fix-misheard-words prompt has one job", () => {
  it("has no punctuation, repeat or translation job and is short", () => {
    const prompt = buildCorrectSystemPrompt({ language: "en", vocabTerms: [] });
    expect(prompt).toContain("You fix misheard words");
    expect(prompt).not.toMatch(/punctuation and capitalization/i);
    expect(prompt).not.toMatch(/translated/i);
    expect(prompt).not.toMatch(/remove a word that the speaker repeated/i);
    expect(prompt).toContain("Keep all other words, fillers and punctuation");
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

describe("mergeStages: the LLM fix wins, else the code fix", () => {
  const unit = (over: Partial<CorrectUnitResult>): CorrectUnitResult => ({
    unitKey: "chunk:0",
    segmentIds: ["a", "b", "c"],
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
  ]);
  const code = new Map([
    ["a", "a code"],
    ["b", "b code"],
    ["c", "c raw"],
  ]);

  it("LLM fix, then code fix, else nothing", () => {
    const [u] = mergeStages(
      [unit({ corrections: [{ id: "b", text: "b llm", seq: 0, callId: 1 }] })],
      raw,
      code,
    );
    expect(u?.corrections.map((c) => [c.id, c.text, c.callId])).toEqual([
      ["a", "a code", null],
      ["b", "b llm", 1],
    ]);
  });

  it("the repeat rule runs on the LLM fix; a text equal to raw is no correction", () => {
    const [u] = mergeStages(
      [
        unit({
          corrections: [
            { id: "b", text: "b b llm", seq: 0, callId: 1 },
            { id: "c", text: "c c raw", seq: 1, callId: 1 },
          ],
        }),
      ],
      raw,
      code,
    );
    expect(u?.corrections.map((c) => [c.id, c.text])).toEqual([
      ["a", "a code"],
      ["b", "b llm"],
    ]);
  });

  it("a unit that is not ok stays as it is", () => {
    const failed = unit({ status: "failed" });
    expect(mergeStages([failed], raw, code)).toEqual([failed]);
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

  it("one LLM call sees the code fix; the code fix lands with no call; a line in another language stays", async () => {
    const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: "m-st" });
    const [a, b] = f.segments.map((s) => s.id) as [string, string];
    const update = getDb().prepare(
      "UPDATE meeting_segments SET text = ? WHERE id = ?",
    );
    update.run("we keep the the notes in open style for the whole team", a);
    update.run(PT_LINE, b);
    getDb()
      .prepare("INSERT INTO vocabulary (term) VALUES (?)")
      .run("Openstyle");
    const { deps } = makeTestDeps();
    const r = await runScriptedGraph({
      deps,
      meetingId: f.meeting.id,
      stages: ["enhance"],
      script: () => okReply('{"corrections":[]}'),
    });
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]?.system).toMatch(/^You fix misheard words/);
    expect(r.requests[0]?.user).toContain("Openstyle for the whole team");
    const text = (id: string) =>
      (
        getDb()
          .prepare("SELECT enhanced_text FROM meeting_segments WHERE id = ?")
          .get(id) as { enhanced_text: string | null }
      ).enhanced_text;
    expect(text(a)).toBe("we keep the notes in Openstyle for the whole team");
    expect(text(b)).toBeNull();
    expect(r.finalState.corrections[0]?.status).toBe("ok");
  });
});
