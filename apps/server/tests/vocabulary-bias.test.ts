import { describe, expect, it } from "vitest";
import {
  buildAsrVocabularyBias,
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

  describe("omlx", () => {
    // A self-hosted oMLX server runs the same MLX ASR models as the bundled
    // worker, so it takes the same prompt. Without its own case it fell through
    // to `default` and the user's vocabulary was silently dropped.
    it("builds the same prompt as the bundled mlx worker", () => {
      const terms = ["TypeScript", "Kubernetes"];
      expect(
        buildAsrVocabularyBias(
          "omlx",
          "mlx-community--Qwen3-ASR-1.7B-8bit",
          terms,
        ),
      ).toEqual(buildAsrVocabularyBias("local-mlx", "qwen", terms));
    });

    it("returns a prompt rather than null", () => {
      expect(
        buildAsrVocabularyBias("omlx", "mlx-community--Qwen3-ASR-1.7B-8bit", [
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
    const bias = buildAsrVocabularyBias("omlx", "Qwen3-ASR", [
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
