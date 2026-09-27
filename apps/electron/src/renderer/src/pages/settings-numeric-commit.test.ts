import {
  DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
  MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
  MEETING_SUMMARY_TIMEOUT_SECONDS_MIN,
  meetingSummaryTimeoutMs,
  parseMeetingSummaryTimeoutSeconds,
} from "@openstyle/validations";
import { describe, expect, it } from "vitest";

import {
  type CommitTrigger,
  displayValueFor,
  inspectNumericDraft,
  resolveCommitIntent,
  sanitizeDigits,
} from "./settings-numeric-commit";

// ---------------------------------------------------------------------------
// Write-timing algebra behind the `meeting_summary_timeout_seconds` control
// (Settings → Data). One assertion per captured runtime defect from
// `openstyle-evidence/summary-timeout/defects.json`, stated against the
// digits a real user produces:
//   D-1 typing 3600 must not PUT 36 / 360 — a draft is not a write.
//   D-2 typing 99999 must not PUT 99 / 999 — an invalid draft reverts.
//   D-5 reset must PUT empty and hydrate to the default 600.
//   D-6 a failed write must revert to the server's value, never look saved.
//
// `runSession` is the reference model of the control's handlers. The browser
// harness (`openstyle-evidence/summary-timeout-fix/capture.mjs`, real
// `keyboard.press` against a live isolated server) proves the component
// matches it; this pins the decision table without a browser — the app's
// vitest config is `environment: "node"` with no jsdom and no
// testing-library, which is why the logic is a plain module (same reasoning
// as `models/preset-ops.ts`).
// ---------------------------------------------------------------------------

/** 4 digits, because the bound is 3600. */
const MAX_LENGTH = String(MEETING_SUMMARY_TIMEOUT_SECONDS_MAX).length;
const FALLBACK = DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS;
const parse = parseMeetingSummaryTimeoutSeconds;

interface Session {
  /** Field text after every event, in order. */
  field: string[];
  /** Every PUT body the session issued, in order. */
  puts: string[];
  /** Non-null while a failed write is on screen. */
  error: string | null;
}

/**
 * Reference model of the fixed control. Script grammar: `_` = select-all +
 * clear (what the harness's `fill("")` does), `!` = blur, `#` = Enter,
 * `R` = the Reset button, any other character is typed one keypress at a
 * time. Typing before clearing throws on purpose — a script must say what the
 * field started as instead of guessing where the caret was.
 */
function runSession(
  server: string | null,
  script: string,
  opts: { failPuts?: boolean; serverAfterFailure?: string | null } = {},
): Session {
  let saved = displayValueFor(server, FALLBACK, parse);
  let draft: string | null = null;
  let error: string | null = null;
  const puts: string[] = [];
  const field: string[] = [];

  const commit = (trigger: CommitTrigger): void => {
    const intent = resolveCommitIntent({ trigger, draft, saved, parse });
    draft = null;
    error = null;
    if (intent.kind === "write" || intent.kind === "reset") {
      const value = intent.kind === "reset" ? "" : intent.value;
      puts.push(value);
      if (opts.failPuts) {
        error = "save-failed";
        saved = displayValueFor(
          opts.serverAfterFailure ?? server,
          FALLBACK,
          parse,
        );
      } else {
        saved = displayValueFor(value, FALLBACK, parse);
      }
    }
    field.push(draft ?? saved);
  };

  for (const ch of script) {
    if (ch === "_") {
      draft = sanitizeDigits("", MAX_LENGTH);
      error = null;
      field.push(draft);
      continue;
    }
    if (ch === "!" || ch === "#" || ch === "R") {
      commit(ch === "#" ? "enter" : ch === "R" ? "reset" : "blur");
      continue;
    }
    if (draft === null) throw new Error(`type before clear: '${ch}'`);
    draft = sanitizeDigits(draft + ch, MAX_LENGTH);
    error = null;
    field.push(draft);
  }
  return { field, puts, error };
}

const last = (values: string[]): string => values[values.length - 1] ?? "";

describe("sanitizeDigits / inspectNumericDraft", () => {
  it("keeps digits and caps at the 4-digit ceiling of 3600", () => {
    expect(sanitizeDigits("3600", MAX_LENGTH)).toBe("3600");
    expect(sanitizeDigits("99999", MAX_LENGTH)).toBe("9999");
    expect(sanitizeDigits("-45.7", MAX_LENGTH)).toBe("457");
    expect(sanitizeDigits("abc", MAX_LENGTH)).toBe("");
  });

  it("reports the characters it dropped so the hint can say so (D-4)", () => {
    const d = inspectNumericDraft("-45.7", MAX_LENGTH);
    expect(d.digits).toBe("457");
    expect(d.stripped).toBe("-.");
    expect(d.truncated).toBe(false);
  });

  it("flags truncation instead of swallowing a 5th digit quietly (D-3)", () => {
    const d = inspectNumericDraft("99999", MAX_LENGTH);
    expect(d.digits).toBe("9999");
    expect(d.stripped).toBe("9");
    expect(d.truncated).toBe(true);
  });

  it("reports letters as dropped input too", () => {
    const d = inspectNumericDraft("abc", MAX_LENGTH);
    expect(d.digits).toBe("");
    expect(d.stripped).toBe("abc");
    expect(d.truncated).toBe(false);
  });

  it("reports nothing dropped when the input was already clean", () => {
    const d = inspectNumericDraft("600", MAX_LENGTH);
    expect(d.digits).toBe("600");
    expect(d.stripped).toBe("");
    expect(d.truncated).toBe(false);
  });
});

describe("D-1 — typing a multi-digit value PUTs exactly once", () => {
  it("typing 3600 from a 600 baseline issues ONE PUT of 3600", () => {
    const s = runSession("600", "_3600!");
    expect(s.puts).toEqual(["3600"]);
    expect(s.field).toEqual(["", "3", "36", "360", "3600", "3600"]);
  });

  it("never PUTs the 36 / 360 prefix the old control stored mid-keystroke", () => {
    const s = runSession("600", "_3600!");
    expect(s.puts).not.toContain("3");
    expect(s.puts).not.toContain("36");
    expect(s.puts).not.toContain("360");
  });

  it("keeps every intermediate draft on screen while typing", () => {
    const s = runSession("1800", "_900!");
    expect(s.field.slice(1, 4)).toEqual(["9", "90", "900"]);
    expect(s.puts).toEqual(["900"]);
  });

  it("Enter commits the same single value blur does", () => {
    expect(runSession("600", "_900#").puts).toEqual(["900"]);
  });

  it("committing a value the user did not change writes nothing", () => {
    expect(runSession("600", "!").puts).toEqual([]);
    expect(runSession("600", "_600!").puts).toEqual([]);
  });

  it("exact boundaries commit", () => {
    expect(runSession("600", "_30!").puts).toEqual(["30"]);
    expect(runSession("600", "_3600!").puts).toEqual(["3600"]);
  });

  it("typing without ever committing writes nothing at all", () => {
    expect(runSession("600", "_3600").puts).toEqual([]);
  });
});

describe("D-2 — an out-of-range entry writes nothing and reverts to SAVED", () => {
  it("typing 99999 renders 9999 and PUTs nothing", () => {
    const s = runSession("30", "_99999!");
    expect(s.field.slice(1, 6)).toEqual(["9", "99", "999", "9999", "9999"]);
    expect(s.puts).toEqual([]);
  });

  it("after blur the field shows the saved value, not a truncated prefix", () => {
    const s = runSession("30", "_99999!");
    expect(last(s.field)).toBe("30");
    expect(s.puts).not.toContain("999");
  });

  it("an invalid draft reverts even though shorter prefixes were in bounds", () => {
    // 99 and 999 are exactly what the pre-fix control left on the server
    // for this keystroke sequence.
    expect(parse("99")).not.toBeNull();
    expect(parse("999")).not.toBeNull();
    const s = runSession("600", "_99999!");
    expect(s.puts).toEqual([]);
    expect(last(s.field)).toBe("600");
  });

  it("empty and out-of-bounds drafts revert; nothing reaches the server", () => {
    for (const draft of ["5", "0", "9999"]) {
      const s = runSession("600", `_${draft}!`);
      expect(s.puts).toEqual([]);
      expect(last(s.field)).toBe("600");
    }
  });

  it("clearing the field and blurring writes nothing — reset needs Reset (D-5)", () => {
    const s = runSession("1800", "_!!");
    expect(s.puts).toEqual([]);
    expect(last(s.field)).toBe("1800");
  });
});

describe("D-5 — reset to default is reachable", () => {
  it("the Reset button PUTs empty whatever the field holds", () => {
    expect(runSession("1800", "R").puts).toEqual([""]);
    expect(runSession(null, "R").puts).toEqual([""]);
    expect(runSession("1800", "_9999R").puts).toEqual([""]);
  });

  it("after reset the field re-seeds to the default 600", () => {
    expect(last(runSession("1800", "R").field)).toBe("600");
  });

  it("empty hydrates to 600 and the resolver agrees", () => {
    expect(displayValueFor("", FALLBACK, parse)).toBe("600");
    expect(displayValueFor(null, FALLBACK, parse)).toBe("600");
    expect(displayValueFor(undefined, FALLBACK, parse)).toBe("600");
    expect(meetingSummaryTimeoutMs("")).toBe(600_000);
  });

  it("a stored value round-trips verbatim", () => {
    expect(displayValueFor("1800", FALLBACK, parse)).toBe("1800");
    expect(meetingSummaryTimeoutMs("1800")).toBe(1_800_000);
    expect(meetingSummaryTimeoutMs("30")).toBe(
      MEETING_SUMMARY_TIMEOUT_SECONDS_MIN * 1000,
    );
    expect(meetingSummaryTimeoutMs("3600")).toBe(
      MEETING_SUMMARY_TIMEOUT_SECONDS_MAX * 1000,
    );
  });
});

describe("D-6 — a failed write never looks like a success", () => {
  it("a rejected write leaves an error on screen and reverts to the server value", () => {
    const s = runSession("900", "_1800!", { failPuts: true });
    expect(s.puts).toEqual(["1800"]);
    expect(s.error).toBe("save-failed");
    expect(last(s.field)).toBe("900");
  });

  it("if the server row vanished mid-write the field falls back to 600", () => {
    const s = runSession("900", "_1800!", {
      failPuts: true,
      serverAfterFailure: "",
    });
    expect(last(s.field)).toBe("600");
  });

  it("the next clean commit clears the error", () => {
    const ok = runSession("900", "_1200!");
    expect(ok.error).toBeNull();
    expect(ok.puts).toEqual(["1200"]);
    expect(last(ok.field)).toBe("1200");
  });
});
