import { SETTINGS_KEYS } from "@openstyle/validations";
import { describe, expect, it, vi } from "vitest";
import { writeSetting } from "../src/lib/db.js";
import {
  attendeeNameForm,
  buildMeetingBiasTerms,
  MAX_ATTENDEE_BIAS_NAMES,
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
    ).toEqual(["Ana Silva", "Jane", "Raj", "Nova Rollout", "zetaLab"]);
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
    ).toEqual(["Grace", "Tom"]);
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
          "JANE",
        ),
        "Ana",
      ),
    ).toEqual(["Ana", "Jane"]);
  });

  it("gives no owner term for an empty, blank, missing or 1-letter owner", () => {
    const r = row([{ name: "Jane Doe" }]);
    for (const owner of ["", "   ", null, undefined, "A", "1"]) {
      expect(buildMeetingBiasTerms(r, owner)).toEqual(["Jane"]);
    }
    expect(buildMeetingBiasTerms(r, "  Al  ")).toEqual(["Al", "Jane"]);
  });

  it("skips attendee names with fewer than 2 letters and bad JSON", () => {
    expect(buildMeetingBiasTerms(row([{ name: "J" }]), "")).toEqual([]);
    expect(buildMeetingBiasTerms(row([{ name: "J." }]), "")).toEqual([]);
    expect(
      buildMeetingBiasTerms(
        { calendar_attendees: "not json", context: null },
        "Ana",
      ),
    ).toEqual(["Ana"]);
  });

  it("keeps at most MAX_ATTENDEE_BIAS_NAMES attendee names, in calendar order", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `Pers${i} Number${i}`,
    }));
    const terms = buildMeetingBiasTerms(row(many, "Nova Rollout"), "Ana Silva");
    expect(terms).toHaveLength(1 + MAX_ATTENDEE_BIAS_NAMES + 1);
    expect(terms[1]).toBe("Pers0");
    expect(terms[MAX_ATTENDEE_BIAS_NAMES]).toBe(
      `Pers${MAX_ATTENDEE_BIAS_NAMES - 1}`,
    );
    expect(terms.at(-1)).toBe("Nova Rollout");
  });

  it("takes the attendee cap from OPENSTYLE_ASR_MAX_ATTENDEE_NAMES, and ignores a bad value", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `Pers${i} Number${i}`,
    }));
    const count = (v: string | undefined) => {
      if (v === undefined) delete process.env.OPENSTYLE_ASR_MAX_ATTENDEE_NAMES;
      else process.env.OPENSTYLE_ASR_MAX_ATTENDEE_NAMES = v;
      try {
        return buildMeetingBiasTerms(row(many, null), null).length;
      } finally {
        delete process.env.OPENSTYLE_ASR_MAX_ATTENDEE_NAMES;
      }
    };
    expect(count("5")).toBe(5);
    expect(count("0")).toBe(0);
    expect(count(undefined)).toBe(MAX_ATTENDEE_BIAS_NAMES);
    expect(count("abc")).toBe(MAX_ATTENDEE_BIAS_NAMES);
    expect(count("201")).toBe(MAX_ATTENDEE_BIAS_NAMES);
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

describe("the attendee name form (OPENSTYLE_ASR_ATTENDEE_NAME_FORM)", () => {
  const people = [
    { name: "Jane Doe", email: "jd@acme.io" },
    { name: "", email: "grace.gao@acme.io" },
    { name: "Jane Roe" },
    { name: "J Poe" },
    { name: "Madonna" },
  ];
  const terms = (
    form: string | undefined,
    owner = "Ana Silva",
    ctx = "Nova",
  ) => {
    if (form === undefined) delete process.env.OPENSTYLE_ASR_ATTENDEE_NAME_FORM;
    else process.env.OPENSTYLE_ASR_ATTENDEE_NAME_FORM = form;
    try {
      return buildMeetingBiasTerms(row(people, ctx), owner);
    } finally {
      delete process.env.OPENSTYLE_ASR_ATTENDEE_NAME_FORM;
    }
  };

  it("gives first names by default, and full names for full", () => {
    const full = [
      "Ana Silva",
      "Jane Doe",
      "Grace Gao",
      "Jane Roe",
      "J Poe",
      "Madonna",
      "Nova",
    ];
    expect(terms("full")).toEqual(full);
    expect(terms("  full ")).toEqual(full);
    expect(terms(undefined)).toEqual(terms("first"));
    expect(terms("")).toEqual(terms("first"));
  });

  it("first: the owner as is, then the first word of each name, once", () => {
    // Jane Roe repeats Jane; the email name gives Grace; "J" has 1 letter.
    expect(terms("first")).toEqual([
      "Ana Silva",
      "Jane",
      "Grace",
      "Madonna",
      "Nova",
    ]);
    expect(terms("first", "Jane")).toEqual([
      "Jane",
      "Grace",
      "Madonna",
      "Nova",
    ]);
  });

  it("both: each person gives the full name, then the first name", () => {
    expect(terms("both")).toEqual([
      "Ana Silva",
      "Jane Doe",
      "Jane",
      "Grace Gao",
      "Grace",
      "Jane Roe",
      "J Poe",
      "Madonna",
      "Nova",
    ]);
  });

  it("counts people for the cap, not terms", () => {
    process.env.OPENSTYLE_ASR_MAX_ATTENDEE_NAMES = "2";
    try {
      expect(terms("both", "", "")).toEqual([
        "Jane Doe",
        "Jane",
        "Grace Gao",
        "Grace",
      ]);
      expect(terms("first", "", "")).toEqual(["Jane", "Grace"]);
      expect(terms("full", "", "")).toEqual(["Jane Doe", "Grace Gao"]);
    } finally {
      delete process.env.OPENSTYLE_ASR_MAX_ATTENDEE_NAMES;
    }
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `Pers${i} Surname${i}`,
    }));
    process.env.OPENSTYLE_ASR_ATTENDEE_NAME_FORM = "both";
    try {
      expect(buildMeetingBiasTerms(row(many), null)).toHaveLength(
        2 * MAX_ATTENDEE_BIAS_NAMES,
      );
    } finally {
      delete process.env.OPENSTYLE_ASR_ATTENDEE_NAME_FORM;
    }
  });

  it("falls back to first on an unknown value and logs once, without the value", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      expect(terms("Zorblax")).toEqual(terms("first"));
      expect(terms("Zorblax")).toEqual(terms("first"));
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).not.toContain("Zorblax");
      process.env.OPENSTYLE_ASR_ATTENDEE_NAME_FORM = "bad";
      expect(attendeeNameForm()).toBe("first");
      delete process.env.OPENSTYLE_ASR_ATTENDEE_NAME_FORM;
      expect(debug).toHaveBeenCalledTimes(2);
    } finally {
      debug.mockRestore();
    }
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
    expect(meetingBiasTerms(r)).toEqual(["Jane"]);
    writeSetting(SETTINGS_KEYS.ownerName, "Ana Silva");
    expect(meetingBiasTerms(r)).toEqual(["Ana Silva", "Jane"]);
    writeSetting(SETTINGS_KEYS.ownerName, "");
    expect(meetingBiasTerms(r)).toEqual(["Jane"]);
    expect(meetingBiasTerms(undefined)).toEqual([]);
  });
});

describe("the bias prompt with meeting terms", () => {
  it("keeps the meeting terms first and the vocabulary spelling on a case clash", () => {
    const terms = mergeContextVocabTerms(
      buildMeetingBiasTerms(row([{ name: "Jane Doe" }], "zetaLab"), "Ana"),
      ["Kubernetes", "ZetaLab", "ana"],
    );
    expect(terms).toEqual(["ana", "Jane", "ZetaLab", "Kubernetes"]);
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
    expect(text.startsWith("Technical terms: Ana Silva, Jane, Term0,")).toBe(
      true,
    );
  });
});
