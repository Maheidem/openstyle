import { describe, expect, it } from "vitest";
import {
  buildAsrVocabularyBias,
  combinePrompt,
  contextTail,
  providerTakesPrompt,
  vocabularyBiasTerms,
} from "../src/lib/vocabulary-bias.js";

function terms(count: number, prefix = "term"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

describe("buildAsrVocabularyBias", () => {
  describe("empty input", () => {
    it("returns null when there are no terms", () => {
      expect(buildAsrVocabularyBias("openai", "whisper-1", [])).toBeNull();
      expect(buildAsrVocabularyBias("deepgram", "nova-3", [], true)).toBeNull();
    });

    it("returns null for unknown providers", () => {
      expect(
        buildAsrVocabularyBias("unknown", "model", ["Openstyle"]),
      ).toBeNull();
    });
  });

  describe("prompt providers (openai, groq, local-whisper)", () => {
    it.each([
      "openai",
      "groq",
      "local-whisper",
    ] as const)("builds prompt bias for %s", (providerId) => {
      const bias = buildAsrVocabularyBias(providerId, "whisper-1", [
        "TypeScript",
        "Kubernetes",
      ]);
      expect(bias).toEqual({
        kind: "prompt",
        text: "Terms: TypeScript, Kubernetes.",
      });
    });

    it("deduplicates terms case-insensitively", () => {
      const bias = buildAsrVocabularyBias("openai", "whisper-1", [
        "React",
        "react",
        "REACT",
      ]);
      expect(bias).toEqual({ kind: "prompt", text: "Terms: React." });
    });

    it("trims whitespace and skips empty terms", () => {
      const bias = buildAsrVocabularyBias("openai", "whisper-1", [
        "  alpha  ",
        "",
        "   ",
        "beta",
      ]);
      expect(bias).toEqual({ kind: "prompt", text: "Terms: alpha, beta." });
    });

    it("caps prompt text at 900 characters", () => {
      const longTerms = terms(200, "abcdefghij");
      const bias = buildAsrVocabularyBias("openai", "whisper-1", longTerms);
      expect(bias?.kind).toBe("prompt");
      if (bias?.kind === "prompt") {
        expect(bias.text.length).toBeLessThanOrEqual(900);
        expect(bias.text.startsWith("Terms:")).toBe(true);
      }
    });

    it("keeps shorter terms after a long term overflows the budget", () => {
      const long = "x".repeat(950);
      const bias = buildAsrVocabularyBias("openai", "whisper-1", [
        long,
        "alpha",
        "beta",
      ]);
      expect(bias).toEqual({ kind: "prompt", text: "Terms: alpha, beta." });
    });

    it("strips provider prefix from model id", () => {
      const bias = buildAsrVocabularyBias(
        "local-whisper",
        "local-whisper/base",
        ["Openstyle"],
      );
      expect(bias).toEqual({ kind: "prompt", text: "Terms: Openstyle." });
    });
  });

  describe("deepgram", () => {
    it("uses keyterms for nova-3 batch requests", () => {
      const bias = buildAsrVocabularyBias(
        "deepgram",
        "deepgram/nova-3",
        ["Openstyle", "Kubernetes"],
        false,
      );
      expect(bias).toEqual({
        kind: "deepgram-keyterms",
        terms: ["Openstyle", "Kubernetes"],
      });
    });

    it("caps nova-3 streaming keyterms at 25", () => {
      const bias = buildAsrVocabularyBias(
        "deepgram",
        "nova-3-general",
        terms(40),
        true,
      );
      expect(bias?.kind).toBe("deepgram-keyterms");
      if (bias?.kind === "deepgram-keyterms") {
        expect(bias.terms).toHaveLength(25);
      }
    });

    it("caps nova-3 batch keyterms at 100", () => {
      const bias = buildAsrVocabularyBias(
        "deepgram",
        "nova-3",
        terms(150),
        false,
      );
      expect(bias?.kind).toBe("deepgram-keyterms");
      if (bias?.kind === "deepgram-keyterms") {
        expect(bias.terms).toHaveLength(100);
      }
    });

    it("expands nova-2 phrases into keyword tokens", () => {
      const bias = buildAsrVocabularyBias(
        "deepgram",
        "nova-2",
        ["account number", "TypeScript"],
        false,
      );
      expect(bias).toEqual({
        kind: "deepgram-keywords",
        terms: ["account", "number", "TypeScript"],
      });
    });

    it("returns null for unsupported deepgram models", () => {
      expect(
        buildAsrVocabularyBias("deepgram", "whisper-large", ["Openstyle"]),
      ).toBeNull();
    });
  });

  describe("elevenlabs", () => {
    it("uses keyterms for scribe_v2 batch requests", () => {
      const bias = buildAsrVocabularyBias(
        "elevenlabs",
        "scribe_v2",
        ["Openstyle", "Nguyen"],
        false,
      );
      expect(bias).toEqual({
        kind: "elevenlabs-keyterms",
        terms: ["Openstyle", "Nguyen"],
      });
    });

    it("returns null for scribe_v1", () => {
      expect(
        buildAsrVocabularyBias("elevenlabs", "scribe_v1", ["Openstyle"]),
      ).toBeNull();
    });

    it("caps streaming keyterms at 50", () => {
      const bias = buildAsrVocabularyBias(
        "elevenlabs",
        "scribe_v2_realtime",
        terms(60),
        true,
      );
      expect(bias?.kind).toBe("elevenlabs-keyterms");
      if (bias?.kind === "elevenlabs-keyterms") {
        expect(bias.terms).toHaveLength(50);
      }
    });

    it("truncates streaming terms longer than 20 chars", () => {
      const bias = buildAsrVocabularyBias(
        "elevenlabs",
        "scribe_v2_realtime",
        ["abcdefghijklmnopqrstuvwxyz"],
        true,
      );
      expect(bias).toEqual({
        kind: "elevenlabs-keyterms",
        terms: ["abcdefghijklmnopqrst"],
      });
    });

    it("allows longer terms in batch mode (50 chars)", () => {
      const longTerm = "a".repeat(60);
      const bias = buildAsrVocabularyBias(
        "elevenlabs",
        "scribe_v2",
        [longTerm],
        false,
      );
      expect(bias).toEqual({
        kind: "elevenlabs-keyterms",
        terms: ["a".repeat(50)],
      });
    });
  });

  describe("local-mlx", () => {
    it("builds mlx prompt with technical terms prefix", () => {
      const bias = buildAsrVocabularyBias("local-mlx", "qwen", [
        "TypeScript",
        "Kubernetes",
      ]);
      expect(bias).toEqual({
        kind: "prompt",
        text: "Technical terms: TypeScript, Kubernetes",
      });
    });
  });

  describe("server", () => {
    // A server that the user runs (for example oMLX) runs the same MLX ASR
    // models as the bundled worker, so it takes the same prompt. Without its
    // own case it fell through to `default` and the vocabulary was dropped.
    it("builds the same prompt as the bundled mlx worker", () => {
      const terms = ["TypeScript", "Kubernetes"];
      expect(
        buildAsrVocabularyBias(
          "server",
          "server/srv_00000000/Qwen3-ASR",
          terms,
        ),
      ).toEqual(buildAsrVocabularyBias("local-mlx", "qwen", terms));
    });

    it("returns a prompt rather than null", () => {
      expect(
        buildAsrVocabularyBias("server", "server/srv_00000000/Qwen3-ASR", [
          "presales-toolkit",
        ]),
      ).toEqual({ kind: "prompt", text: "Technical terms: presales-toolkit" });
    });
  });
});

describe("resolveAsrVocabularyBias", () => {
  it("loads terms from the database", async () => {
    const { getDb } = await import("../src/lib/db.js");
    const { resolveAsrVocabularyBias } = await import(
      "../src/lib/vocabulary-bias.js"
    );

    const db = getDb();
    db.prepare("INSERT INTO vocabulary (term, notes) VALUES (?, ?)").run(
      "Openstyle",
      null,
    );

    const bias = resolveAsrVocabularyBias("openai", "whisper-1", false);
    expect(bias?.kind).toBe("prompt");
    if (bias?.kind === "prompt") {
      expect(bias.text).toContain("Openstyle");
    }
  });

  it("feeds term notes into soniox background text", async () => {
    const { getDb } = await import("../src/lib/db.js");
    const { resolveAsrVocabularyBias } = await import(
      "../src/lib/vocabulary-bias.js"
    );

    const db = getDb();
    db.prepare("INSERT INTO vocabulary (term, notes) VALUES (?, ?)").run(
      "Soniox",
      "speech-to-text provider",
    );

    const bias = resolveAsrVocabularyBias("soniox", "stt-rt-v5", true);
    expect(bias?.kind).toBe("soniox-context");
    if (bias?.kind === "soniox-context") {
      expect(bias.terms).toContain("Soniox");
      expect(bias.text).toContain("Soniox: speech-to-text provider");
    }
  });
});

describe("soniox", () => {
  it("builds soniox-context bias with terms", () => {
    const bias = buildAsrVocabularyBias("soniox", "stt-rt-v5", [
      "Openstyle",
      "Kubernetes",
    ]);
    expect(bias).toEqual({
      kind: "soniox-context",
      terms: ["Openstyle", "Kubernetes"],
    });
  });

  it("returns null for empty terms", () => {
    const bias = buildAsrVocabularyBias("soniox", "stt-rt-v5", []);
    expect(bias).toBeNull();
  });

  it("caps terms at 500", () => {
    const bias = buildAsrVocabularyBias("soniox", "stt-rt-v5", terms(600));
    expect(bias?.kind).toBe("soniox-context");
    if (bias?.kind === "soniox-context") {
      expect(bias.terms).toHaveLength(500);
    }
  });

  it("caps cumulative term characters at 6000", () => {
    const longTerms = terms(100, "x".repeat(100));
    const bias = buildAsrVocabularyBias("soniox", "stt-rt-v5", longTerms);
    expect(bias?.kind).toBe("soniox-context");
    if (bias?.kind === "soniox-context") {
      const totalChars = bias.terms.reduce((sum, t) => sum + t.length, 0);
      expect(totalChars).toBeLessThanOrEqual(6000);
      expect(bias.terms.length).toBeGreaterThan(0);
    }
  });

  it("includes note text as background context", () => {
    const bias = buildAsrVocabularyBias(
      "soniox",
      "stt-rt-v5",
      ["Openstyle"],
      true,
      "Openstyle: our voice dictation app",
    );
    expect(bias).toEqual({
      kind: "soniox-context",
      terms: ["Openstyle"],
      text: "Openstyle: our voice dictation app",
    });
  });

  it("omits text when no note text is supplied", () => {
    const bias = buildAsrVocabularyBias("soniox", "stt-rt-v5", ["Openstyle"]);
    expect(bias).toEqual({ kind: "soniox-context", terms: ["Openstyle"] });
  });
});

describe("vocabularyBiasTerms", () => {
  // Recovers the terms out of an already-resolved bias, rather than a fresh
  // DB read — see the doc comment on the function for why (dictation leak
  // filter, specs/meeting-transcription-quality.md Phase A extended to
  // dictation).
  it("returns [] for null/undefined bias", () => {
    expect(vocabularyBiasTerms(null)).toEqual([]);
    expect(vocabularyBiasTerms(undefined)).toEqual([]);
  });

  it("strips the 'Technical terms:' label from a prompt-kind bias", () => {
    const bias = buildAsrVocabularyBias("server", "Qwen3-ASR", [
      "PortifolioZero",
      "churrasqueira",
    ]);
    expect(bias?.kind).toBe("prompt");
    const terms = vocabularyBiasTerms(bias);
    expect(terms).toHaveLength(1);
    expect(terms[0]).not.toMatch(/^technical terms:/i);
    expect(terms[0]).toContain("PortifolioZero");
    expect(terms[0]).toContain("churrasqueira");
  });

  it("strips the bare 'Terms:' label from an openai/groq/local-whisper bias", () => {
    const bias = buildAsrVocabularyBias("openai", "whisper-1", ["Openstyle"]);
    expect(bias?.kind).toBe("prompt");
    const terms = vocabularyBiasTerms(bias);
    expect(terms).toEqual(["Openstyle."]);
  });

  it("passes through the terms array unchanged for keyterm/context kinds", () => {
    expect(
      vocabularyBiasTerms({ kind: "deepgram-keyterms", terms: ["Openstyle"] }),
    ).toEqual(["Openstyle"]);
    expect(
      vocabularyBiasTerms({
        kind: "soniox-context",
        terms: ["Openstyle"],
        text: "Openstyle: our voice dictation app",
      }),
    ).toEqual(["Openstyle"]);
  });
});

// Phase 3b (specs/meeting-transcription-v2.md §3.1): the five prompt
// providers and the terms-first / context-last combined prompt.
describe("providerTakesPrompt", () => {
  it("accepts the five prompt providers and nothing else", () => {
    for (const id of [
      "local-whisper",
      "server",
      "openai",
      "groq",
      "local-mlx",
    ]) {
      expect(providerTakesPrompt(id)).toBe(true);
    }
    for (const id of ["deepgram", "elevenlabs", "soniox", "fake", ""]) {
      expect(providerTakesPrompt(id)).toBe(false);
    }
  });
});

describe("combinePrompt", () => {
  const context =
    "and so the quarter close plan is to ship the lane change first";

  it("puts terms first and context last", () => {
    const out = combinePrompt("PortifolioZero, churrasqueira", context);
    expect(out.startsWith("PortifolioZero, churrasqueira ")).toBe(true);
    expect(out.endsWith(context)).toBe(true);
    expect(out).toBe(`PortifolioZero, churrasqueira ${context}`);
  });

  it("never exceeds the 900-char budget, cutting terms at the last comma", () => {
    // 300 terms x ~10 chars ≈ 3000 — far over the budget.
    const termsText = terms(300).join(", ");
    const out = combinePrompt(termsText, context);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out.endsWith(context)).toBe(true);
    // The cut is at a comma boundary: no term is truncated mid-word.
    const keptTerms = out.slice(0, out.length - context.length - 1);
    for (const piece of keptTerms.split(", ")) {
      expect(termsText.split(", ")).toContain(piece);
    }
  });

  it("keeps short terms uncut and adds the context within the budget", () => {
    const out = combinePrompt("PortifolioZero", context);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out.startsWith("PortifolioZero ")).toBe(true);
  });

  it("truncates the context to its 200-char word-boundary tail", () => {
    const longContext = `${"w ".repeat(300)}end word`; // ~900 chars
    const out = combinePrompt("PortifolioZero", longContext);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out.startsWith("PortifolioZero ")).toBe(true);
    const ctxPart = out.slice("PortifolioZero ".length);
    expect(ctxPart.length).toBeLessThanOrEqual(200);
    expect(ctxPart.endsWith("end word")).toBe(true);
  });

  it("returns the bias text unchanged for an empty context", () => {
    expect(combinePrompt("PortifolioZero", "")).toBe("PortifolioZero");
    expect(combinePrompt("PortifolioZero", "   ")).toBe("PortifolioZero");
  });

  it("returns the context alone when there are no terms", () => {
    expect(combinePrompt("", context)).toBe(context);
  });
});

// Phase 3b review: contextTail word-boundary and surrogate-pair rules.
describe("contextTail", () => {
  it("keeps the first word when the slice already starts at a word boundary", () => {
    // 70 "xx" words (210-1 chars) + 15-char tail = 224; the 200-char
    // slice starts at char 24, right after a space — the whole "xx" word
    // must stay (the old code cut it off).
    const text = `${"xx ".repeat(70).trim()} alpha beta del`;
    expect(text.length).toBe(224);
    expect(text[23]).toBe(" ");
    const tail = contextTail(text);
    expect(tail).toBe(text.slice(24));
    expect(tail).toHaveLength(200);
    expect(tail.startsWith("xx ")).toBe(true);
  });

  it("cuts a mid-word start at the first whitespace", () => {
    // 34 six-letter words + spaces = 237 chars; the 200-char slice
    // starts at char 37, mid-word. The tail must start at the next word
    // (char 42), dropping the broken head.
    const text = "abcdef ".repeat(34).trim();
    expect(text.length).toBe(237);
    const tail = contextTail(text);
    expect(tail).toBe(text.slice(42));
    expect(tail.startsWith("abcdef")).toBe(true);
  });

  it("never leaves a lone trailing surrogate when the text has no whitespace", () => {
    // 198 "a" + U+1D11E (2 code units) + 199 "a" = 399 units; the 200-
    // unit slice starts exactly on the pair's second half.
    const text = `${"a".repeat(198)}\u{1D11E}${"a".repeat(199)}`;
    const tail = contextTail(text);
    expect(tail).toBe("a".repeat(199));
  });
});
