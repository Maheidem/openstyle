import { describe, expect, it } from "vitest";
import { fixNameSpelling } from "../src/lib/meetings/speaker-spelling.js";

// Fictional names only.
const LIST = ["Ana Souza", "Bruno Lima", "Carla Dias"];

describe("fixNameSpelling", () => {
  it("exact full name, any case: returns the attendee's full name", () => {
    expect(fixNameSpelling("ana souza", LIST)).toBe("Ana Souza");
  });

  it("exact first name: returns the full name", () => {
    expect(fixNameSpelling("bruno", LIST)).toBe("Bruno Lima");
  });

  it("one-letter typo in the first name, one candidate: returns the full name", () => {
    expect(fixNameSpelling("Brunno", LIST)).toBe("Bruno Lima");
    expect(fixNameSpelling("Carlo", LIST)).toBe("Carla Dias");
    expect(fixNameSpelling("Bruo", LIST)).toBe("Bruno Lima");
  });

  it("two candidates at the same level: no change", () => {
    const two = ["Bruno Lima", "Bruna Lima"];
    expect(fixNameSpelling("Brunn", two)).toBe("Brunn");
    expect(fixNameSpelling("Bruno", ["Bruno Lima", "Bruno Reis"])).toBe(
      "Bruno",
    );
  });

  it("an exact match beats a one-letter match", () => {
    expect(fixNameSpelling("Bruno", ["Bruno Lima", "Bruna Lima"])).toBe(
      "Bruno Lima",
    );
  });

  it("the same person listed twice is not ambiguous", () => {
    expect(fixNameSpelling("Brunno", ["Bruno Lima", "bruno lima"])).toBe(
      "Bruno Lima",
    );
  });

  it("a different surname blocks the match", () => {
    expect(fixNameSpelling("Ana Costa", LIST)).toBe("Ana Costa");
  });

  it("a name that is two letters off is not changed", () => {
    expect(fixNameSpelling("Brunoo Z", LIST)).toBe("Brunoo Z");
    expect(fixNameSpelling("Marcos", LIST)).toBe("Marcos");
  });

  it("a short first name gets no typo fix", () => {
    expect(fixNameSpelling("Al", ["Ed Lima"])).toBe("Al");
    expect(fixNameSpelling("Ana", ["Ane Lima"])).toBe("Ana");
  });

  it("an empty list changes nothing", () => {
    expect(fixNameSpelling("Brunno", [])).toBe("Brunno");
  });

  it("an empty suggestion changes nothing", () => {
    expect(fixNameSpelling("", LIST)).toBe("");
  });

  it("cleans the attendee name before it returns it", () => {
    expect(fixNameSpelling("Eve", ['Eve"\n{x} Stone'])).toBe("Eve x Stone");
  });
});
