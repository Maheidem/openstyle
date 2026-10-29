import { SETTINGS_KEYS } from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import { writeSetting } from "../src/lib/db.js";
import {
  buildMeetingBiasTerms,
  meetingBiasTerms,
  nameFromEmail,
} from "../src/lib/meetings/bias-terms.js";
import {
  buildAsrVocabularyBias,
  mergeContextVocabTerms,
} from "../src/lib/vocabulary-bias.js";

/**
 * The meeting ASR bias terms: the owner name, then the calendar attendee
 * names, then the free-text context terms. All names, emails and terms are
 * fictional.
 */
const attendees = (list: { name?: string; email?: string }[]) =>
  JSON.stringify(
    list.map((a) => ({
      name: a.name ?? "",
      email: a.email ?? "",
      isOrganizer: false,
    })),
  );

const row = (
  list: { name?: string; email?: string }[],
  context: string | null = null,
) => ({ calendar_attendees: attendees(list), context });

describe("buildMeetingBiasTerms", () => {
  it("puts the owner first, then attendee names, then context terms", () => {
    expect(
      buildMeetingBiasTerms(
        row(
          [{ name: "Jane Doe", email: "jd@acme.io" }, { name: "Raj Patel" }],
          "Nova Rollout\nzetaLab",
        ),
        "Ana Silva",
      ),
    ).toEqual([
      "Ana Silva",
      "Jane Doe",
      "Raj Patel",
      "Nova Rollout",
      "zetaLab",
    ]);
  });

  it("derives First Last from a first.last email when the name is empty or an email", () => {
    expect(
      buildMeetingBiasTerms(
        row([
          { name: "", email: "grace.gao@acme.io" },
          { name: "tom.berg@acme.io", email: "" },
          { name: "", email: "ops@acme.io" },
          { name: "", email: "j.doe@acme.io" },
          { name: "", email: "lee.wu2@acme.io" },
        ]),
        "",
      ),
    ).toEqual(["Grace Gao", "Tom Berg"]);
  });

  it("removes duplicates without regard to case and keeps the first", () => {
    expect(
      buildMeetingBiasTerms(
        row(
          [
            { name: "ana silva" },
            { name: "Jane Doe" },
            { name: "", email: "jane.doe@acme.io" },
          ],
          "Jane Doe",
        ),
        "Ana Silva",
      ),
    ).toEqual(["Ana Silva", "Jane Doe"]);
  });

  it("gives no owner term for an empty, blank, missing or 1-letter owner", () => {
    const r = row([{ name: "Jane Doe" }]);
    for (const owner of ["", "   ", null, undefined, "A", "1"]) {
      expect(buildMeetingBiasTerms(r, owner)).toEqual(["Jane Doe"]);
    }
    expect(buildMeetingBiasTerms(r, "  Al  ")).toEqual(["Al", "Jane Doe"]);
  });

  it("skips attendee names shorter than 2 characters and bad JSON", () => {
    expect(buildMeetingBiasTerms(row([{ name: "J" }]), "")).toEqual([]);
    expect(
      buildMeetingBiasTerms(
        { calendar_attendees: "not json", context: null },
        "Ana",
      ),
    ).toEqual(["Ana"]);
  });

  it("keeps the context terms alone when there is no owner and no attendee", () => {
    expect(
      buildMeetingBiasTerms(
        { calendar_attendees: null, context: "Jane Doe" },
        null,
      ),
    ).toEqual(["Jane Doe"]);
  });
});

describe("nameFromEmail", () => {
  it("title-cases both parts of first.last", () => {
    expect(nameFromEmail("GRACE.gao@acme.io")).toBe("Grace Gao");
    expect(nameFromEmail("élodie.dupré@acme.fr")).toBe("Élodie Dupré");
  });

  it("returns null for any other shape", () => {
    for (const e of [
      "grace@acme.io",
      "g.gao@acme.io",
      "grace.g@acme.io",
      "grace.gao.x@acme.io",
      "grace_gao@acme.io",
      "grace.gao2@acme.io",
      "@acme.io",
      "grace.gao",
    ]) {
      expect(nameFromEmail(e)).toBeNull();
    }
  });
});

describe("meetingBiasTerms (stored owner name)", () => {
  it("reads owner_name from the settings table", () => {
    const r = row([{ name: "Jane Doe" }]);
    expect(meetingBiasTerms(r)).toEqual(["Jane Doe"]);
    writeSetting(SETTINGS_KEYS.ownerName, "Ana Silva");
    expect(meetingBiasTerms(r)).toEqual(["Ana Silva", "Jane Doe"]);
    writeSetting(SETTINGS_KEYS.ownerName, "");
    expect(meetingBiasTerms(r)).toEqual(["Jane Doe"]);
    expect(meetingBiasTerms(undefined)).toEqual([]);
  });
});

describe("the bias prompt with meeting terms", () => {
  it("keeps the meeting terms first and the vocabulary spelling on a case clash", () => {
    const terms = mergeContextVocabTerms(
      buildMeetingBiasTerms(row([{ name: "Jane Doe" }], "zetaLab"), "Ana"),
      ["Kubernetes", "ZetaLab", "ana"],
    );
    expect(terms).toEqual(["ana", "Jane Doe", "ZetaLab", "Kubernetes"]);
  });

  it("keeps the 900-char budget, with the owner and attendees at the front", () => {
    const vocab = Array.from({ length: 200 }, (_, i) => `Term${i}`);
    const terms = mergeContextVocabTerms(
      buildMeetingBiasTerms(row([{ name: "Jane Doe" }]), "Ana Silva"),
      vocab,
    );
    const bias = buildAsrVocabularyBias("local-mlx", "qwen3-1.7b-8bit", terms);
    expect(bias?.kind).toBe("prompt");
    const text = bias?.kind === "prompt" ? bias.text : "";
    expect(text.length).toBe(900);
    expect(
      text.startsWith("Technical terms: Ana Silva, Jane Doe, Term0,"),
    ).toBe(true);
  });
});
