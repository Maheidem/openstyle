import { describe, expect, it } from "vitest";
import {
  asksAcrossMeetings,
  researchTrigger,
} from "../src/lib/chat/research/trigger.js";
import {
  aboutItem,
  langOf,
  supported,
} from "../src/lib/chat/research/workers.js";

// The checks that decide whether a worker's reason is shown (spec 11.9.16).
describe("worker record checks", () => {
  const given = new Map([
    [
      "S1",
      "Kestrel only offers the Dublin region today. Then I cannot sign the Kestrel contract yet. Thirty keys cost 2400 euros.",
    ],
  ]);
  it("accepts a quote that the source holds and numbers that it holds", () => {
    expect(
      supported(
        given,
        "S1",
        "I cannot sign the Kestrel contract yet",
        "It cannot be signed yet.",
      ),
    ).toBe(true);
    expect(
      supported(
        given,
        "S1",
        "Thirty keys cost 2400 euros",
        "It costs 2400 euros.",
      ),
    ).toBe(true);
  });
  it("rejects an unknown label, an invented quote and an invented number", () => {
    expect(
      supported(given, "S9", "I cannot sign the Kestrel contract yet", "x"),
    ).toBe(false);
    expect(
      supported(
        given,
        "S1",
        "the budget is frozen until next year for all teams",
        "x",
      ),
    ).toBe(false);
    expect(
      supported(
        given,
        "S1",
        "Thirty keys cost 2400 euros",
        "It costs 9900 euros.",
      ),
    ).toBe(false);
    expect(supported(given, "S1", "too short", "x")).toBe(false);
  });
  it("a reason must be about the item and add something", () => {
    expect(
      aboutItem(
        "Sign the Kestrel hosting contract",
        "Kestrel only offers the Dublin region.",
        "cannot sign the Kestrel contract",
      ),
    ).toBe(true);
    // A reason of another item.
    expect(
      aboutItem(
        "Pay the contractor invoice",
        "The push certificate is still open.",
        "push certificate is open",
      ),
    ).toBe(false);
    // A restatement of the item.
    expect(
      aboutItem(
        "Update the terms page",
        "Update the terms page.",
        "update the terms page",
      ),
    ).toBe(false);
  });
  it("tells the language of a text by common words", () => {
    expect(langOf("Por que isso ainda não foi resolvido?")).toBe("pt");
    expect(langOf("Why are these still open?")).toBe("en");
  });
});

describe("trigger words (11.9.16)", () => {
  const fires = (q: string) =>
    researchTrigger({ question: q, history: [], enabled: true });
  it("digs for blockers, pushers and differences in plain words", () => {
    for (const q of [
      "What is stopping the push certificate renewal?",
      "Who insisted on the offline mode, and why?",
      "What is different between the first and the last meeting?",
      "Nobody can answer the points expiry question yet.",
      "O que atrasou o piloto?",
    ]) {
      expect(fires(q), q).toBe(true);
    }
  });
  it("keeps a single-fact question on the fast path", () => {
    for (const q of [
      "Who proposed the open source release?",
      "Quem propôs o hackathon?",
      "Qual número demos para o atraso de replicação na reunião de 8 de setembro?",
    ]) {
      expect(fires(q), q).toBe(false);
    }
  });
  it("sends one worker for each meeting for pushed and changed questions", () => {
    expect(asksAcrossMeetings("Who pushed for the API freeze and why?")).toBe(
      true,
    );
    expect(asksAcrossMeetings("Who owns the vendor contract?")).toBe(false);
  });
});
