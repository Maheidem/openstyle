// Clean-up of the loop answer: cut sentences and repeated sentences. Fictional text.

import { describe, expect, it } from "vitest";
import { endCleanly, tidySentences } from "../src/lib/chat/loop/tidy.js";

const s = (text: string) => ({ text, cites: [] as string[] });

describe("endCleanly", () => {
  it("removes a label bracket that the limit cut", () => {
    expect(endCleanly("Maria owns the vendor review (S59")).toBe(
      "Maria owns the vendor review",
    );
  });

  it("ends a cut sentence at the last clause", () => {
    const text = `${"The team agreed on the plan. ".repeat(9)}Then they talked about the budget and the very long`;
    const out = endCleanly(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out.endsWith(".")).toBe(true);
  });

  it("leaves a normal sentence alone", () => {
    expect(endCleanly("The review is on December 4.")).toBe(
      "The review is on December 4.",
    );
  });
});

describe("tidySentences", () => {
  it("drops a sentence that repeats an earlier one", () => {
    const out = tidySentences([
      s("Maria will send the vendor contract on Friday."),
      s("The budget is 180k."),
      s("Maria will send the vendor contract on Friday"),
    ]);
    expect(out.map((x) => x.text)).toEqual([
      "Maria will send the vendor contract on Friday.",
      "The budget is 180k.",
    ]);
  });
});
