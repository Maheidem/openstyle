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
