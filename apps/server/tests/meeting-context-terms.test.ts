import { isVocabLeak } from "@openstyle/stt";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_TERMS_MAX,
  extractContextTerms,
} from "../src/lib/meetings/context-terms.js";

/**
 * PR #39: candidate terms extracted from the meeting's free-text context
 * (the calendar invitee list). The fixture is shaped like the real
 * 2026-10 invite list (person names, parenthesized emails, plain emails,
 * a mixed-case product token, calendar noise, a title line) but every
 * name, email and domain is fictional.
 */
const INVITEE_LIST = [
  "Weekly Product Sync",
  "Organizer",
  "Outside working hours",
  "Jane Doe",
  "(bob.smith@acme.io)",
  "Priya.Nair@Globex.com",
  "grace.gao@acme.io",
  "acmeLab",
  "Office",
  "Optional",
  "Edit",
  "-",
  "bedtime",
].join("\n");

describe("extractContextTerms (PR #39)", () => {
  it("extracts names, email-local names and domain words from an invitee list", () => {
    expect(extractContextTerms(INVITEE_LIST)).toEqual([
      "Jane Doe",
      "Bob Smith",
      "acme",
      "Priya Nair",
      "globex",
      "Grace Gao",
      "acmeLab",
    ]);
  });

  it("splits hyphen and underscore local parts into names", () => {
    expect(
      extractContextTerms("mike-reilly@xcorp.com\namy_wong@xcorp.com"),
    ).toEqual(["Mike Reilly", "xcorp", "Amy Wong"]);
  });

  it("keeps a mixed-case token as written (the ecoATM case)", () => {
    expect(extractContextTerms("Status of the EcoATM rollout")).toEqual([
      "EcoATM",
    ]);
  });

  it("does not add a title sentence as a phrase (only mixed-case tokens inside it)", () => {
    expect(extractContextTerms("Quarterly Planning Session")).toEqual([]);
    expect(extractContextTerms("EcoATM Weekly Planning")).toEqual(["EcoATM"]);
  });

  it("a lone capitalized word on a sentence line is capitalization, not a name", () => {
    expect(extractContextTerms("Status of the EcoATM rollout")).toEqual([
      "EcoATM",
    ]);
  });

  it("drops the calendar noise words and the phrase", () => {
    expect(
      extractContextTerms(
        [
          "Organizer",
          "Optional",
          "Home",
          "Office",
          "bedtime",
          "Edit",
          "-",
          "Outside working hours",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("ignores lowercase words (noise or not)", () => {
    expect(extractContextTerms("bedtime at home\noffice call")).toEqual([]);
  });

  it("deduplicates case-insensitively (name line + its email)", () => {
    expect(extractContextTerms("Jane Doe\njane.doe@acme.io\nJANE DOE")).toEqual(
      ["Jane Doe", "acme"],
    );
  });

  it("caps the terms at CONTEXT_TERMS_MAX", () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `Alpha${i} Beta${i}`,
    ).join("\n");
    const terms = extractContextTerms(lines);
    expect(terms).toHaveLength(CONTEXT_TERMS_MAX);
    expect(CONTEXT_TERMS_MAX).toBe(30);
    expect(terms[0]).toBe("Alpha0 Beta0");
  });

  it("returns [] for empty, blank and undefined-ish input", () => {
    expect(extractContextTerms("")).toEqual([]);
    expect(extractContextTerms("   \n  \n")).toEqual([]);
  });

  it("uses the domain word before a multi-part TLD", () => {
    expect(extractContextTerms("jane@doe.com.br")).toEqual(["Jane", "doe"]);
  });

  it("skips generic domain labels (mail.google-style addresses)", () => {
    expect(extractContextTerms("jane@mail.example.com")).toEqual([
      "Jane",
      "example",
    ]);
  });
});

describe("leak check widens to the context terms (PR #39)", () => {
  // The persist-time leak check (leakCheckedTextAndStatus) passes the
  // meeting's vocab terms = context terms + global terms. A prompt echo
  // of the invitee names must be caught even though none of them is in
  // the global vocabulary.
  const contextTerms = ["Jane Doe", "acme", "Priya Nair"];

  it("flags a prompt echo of the context terms that are not global vocabulary", () => {
    const echo = "Technical terms: Jane Doe, acme, Priya Nair.";
    // With the context terms in the leak vocabulary...
    expect(isVocabLeak(echo, [...contextTerms, "Qwen3"])).toBe(true);
    // ...the same text with ONLY the global terms is not a leak.
    expect(isVocabLeak(echo, ["Qwen3"])).toBe(false);
  });

  it("does not flag real speech that merely mentions one context name", () => {
    const speech = "Jane told me the acme numbers will be ready by Friday.";
    expect(isVocabLeak(speech, contextTerms)).toBe(false);
  });
});
