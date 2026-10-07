import { describe, expect, it } from "vitest";
import {
  collapseAsrLineBreaks,
  isContextEcho,
  isVocabLeak,
  sanitizeTranscriptText,
  stripThinkingBlocks,
  stripTrailingDuplicate,
  stripVocabLeak,
  wordEndsSentence,
} from "./text.js";

describe("wordEndsSentence (phase 4f, §3.6 decision)", () => {
  it("flags period, question and exclamation ends (ASCII and curly)", () => {
    expect(wordEndsSentence("here.")).toBe(true);
    expect(wordEndsSentence("ready?")).toBe(true);
    expect(wordEndsSentence("ok!")).toBe(true);
    expect(wordEndsSentence("stop.")).toBe(true);
    expect(wordEndsSentence("there?\u2019")).toBe(true); // trailing apostrophe
    expect(wordEndsSentence("“oh,”")).toBe(false); // quotes only
    expect(wordEndsSentence("here")).toBe(false);
    expect(wordEndsSentence("")).toBe(false);
  });
});

describe("stripThinkingBlocks", () => {
  it("returns text with no think tags byte-identically", () => {
    const text = "  Leading and trailing space is preserved here.  \n\n";
    expect(stripThinkingBlocks(text)).toBe(text);
    expect(stripThinkingBlocks("")).toBe("");
    // A lone angle bracket or an unrelated tag is not a think tag.
    expect(stripThinkingBlocks("2 < 3 and <b>bold</b>")).toBe(
      "2 < 3 and <b>bold</b>",
    );
  });

  it("removes a complete block from anywhere in the text", () => {
    expect(
      stripThinkingBlocks("<think>Let me consider this.</think>The answer."),
    ).toBe("The answer.");
    expect(
      stripThinkingBlocks("Before <think>middle reasoning</think> after"),
    ).toBe("Before  after");
    expect(stripThinkingBlocks("<think>one</think>A<think>two</think>B")).toBe(
      "AB",
    );
  });

  it("removes an unclosed block through to the end", () => {
    // The model hit the token limit mid-reasoning.
    expect(
      stripThinkingBlocks(
        "Answer so far.<think>The user wants me to clean up a dictated tran",
      ),
    ).toBe("Answer so far.");
    expect(stripThinkingBlocks("<think>nothing but reasoning")).toBe("");
  });

  it("removes everything before a stray closing tag", () => {
    // The chat template emitted reasoning first and swallowed the opener.
    expect(
      stripThinkingBlocks(
        "The user wants me to fix punctuation.</think>The answer.",
      ),
    ).toBe("The answer.");
    // With more than one stray closer, the last one wins.
    expect(stripThinkingBlocks("a</think>b</think>The answer.")).toBe(
      "The answer.",
    );
  });

  it("is case-insensitive and tolerates whitespace inside the tag", () => {
    expect(stripThinkingBlocks("<THINK>reasoning</THINK>Answer.")).toBe(
      "Answer.",
    );
    expect(stripThinkingBlocks("< think >reasoning</ think >Answer.")).toBe(
      "Answer.",
    );
    expect(stripThinkingBlocks("reasoning</ Think >Answer.")).toBe("Answer.");
  });

  it("spans newlines inside a block", () => {
    expect(
      stripThinkingBlocks("<think>line one\n\nline two</think>\nAnswer."),
    ).toBe("\nAnswer.");
  });
});

describe("sanitizeTranscriptText", () => {
  it("strips trailing <fin> tags from raw transcripts", () => {
    expect(sanitizeTranscriptText("Hello there.<fin>")).toBe("Hello there.");
  });

  it("strips wrapping quotes around raw transcripts", () => {
    expect(sanitizeTranscriptText('"Quoted transcript.<fin>"')).toBe(
      "Quoted transcript.",
    );
  });

  it("strips trailing <fin> tags from gpt-oss output", () => {
    expect(
      sanitizeTranscriptText("Let's just do a remote Zoom call instead.<fin>"),
    ).toBe("Let's just do a remote Zoom call instead.");
  });

  it("strips leaked reasoning before the other cleanup steps", () => {
    expect(
      sanitizeTranscriptText(
        '<think>They want punctuation fixed.</think>"Hello there.<fin>"',
      ),
    ).toBe("Hello there.");
  });
});

describe("collapseAsrLineBreaks", () => {
  it("collapses per-segment line breaks into spaces", () => {
    expect(
      collapseAsrLineBreaks("This is the first segment.\nAnd the second one."),
    ).toBe("This is the first segment. And the second one.");
  });

  it("preserves blank-line paragraph breaks", () => {
    expect(collapseAsrLineBreaks("First paragraph.\n\nSecond paragraph.")).toBe(
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  it("collapses runs of more than two line breaks to a single paragraph break", () => {
    expect(collapseAsrLineBreaks("One.\n\n\n\nTwo.")).toBe("One.\n\nTwo.");
  });

  it("collapses a paragraph break with interleaved whitespace cleanly", () => {
    expect(collapseAsrLineBreaks("One.\n\n  \nTwo.")).toBe("One.\n\nTwo.");
  });

  it("normalizes Windows CRLF line endings", () => {
    expect(collapseAsrLineBreaks("Line one.\r\nLine two.")).toBe(
      "Line one. Line two.",
    );
  });

  it("trims surrounding whitespace around collapsed breaks", () => {
    expect(collapseAsrLineBreaks("Word one.  \n  word two.")).toBe(
      "Word one. word two.",
    );
  });

  it("leaves single-line text untouched", () => {
    expect(collapseAsrLineBreaks("Just one line.")).toBe("Just one line.");
  });
});

describe("stripTrailingDuplicate", () => {
  it("removes duplicated trailing paragraphs", () => {
    expect(stripTrailingDuplicate("Hello there.\n\nHello there.")).toBe(
      "Hello there.",
    );
  });
});

// Canonical home of the leak detector. meeting-merge.test.ts has the
// mergeTranscript segment scenarios that use it.
describe("isVocabLeak", () => {
  const vocabTerms = Array.from({ length: 80 }, (_, i) => `Zylotrix${i + 1}`);

  it("flags a full echo of either prompt shape", () => {
    expect(
      isVocabLeak(`Technical terms: ${vocabTerms.join(", ")}`, vocabTerms),
    ).toBe(true);
    expect(isVocabLeak(`Terms: ${vocabTerms.join(", ")}.`, vocabTerms)).toBe(
      true,
    );
  });

  it("does not flag real speech that merely mentions one vocab term", () => {
    const real = `so the plan is to ship ${vocabTerms[0]} next week`;
    expect(isVocabLeak(real, vocabTerms)).toBe(false);
  });
});

describe("stripVocabLeak", () => {
  // Mirrors the real dictation incident (specs/meeting-transcription-
  // quality.md Phase A's investigation shape, extended to dictation): an
  // 80-term vocabulary list, comma-joined into the ASR bias prompt.
  const vocabTerms = Array.from({ length: 80 }, (_, i) => `Zylotrix${i + 1}`);
  const dump = vocabTerms.join(", ");
  const realSpeech =
    "While you wait, why don't you launch a deep research on the subject about the best practices for this?";

  it("returns empty when the entire output is the omlx/local-mlx echo (the confirmed incident shape)", () => {
    // Matches the exact 2026-08-27 14:45:12 incident: a ~900ms near-silent
    // recording came back as nothing but the injected prompt, verbatim.
    expect(stripVocabLeak(`Technical terms: ${dump}`, vocabTerms)).toBe("");
  });

  it("returns empty when the entire output is the openai/local-whisper echo", () => {
    expect(stripVocabLeak(`Terms: ${dump}.`, vocabTerms)).toBe("");
  });

  it("strips a leak appended after real speech with no separating punctuation", () => {
    // The ASR concatenates the hallucinated prompt directly onto the last
    // real word — no period in between — which is why the split can't rely
    // on sentence boundaries alone.
    const mixed = `${realSpeech}Technical terms: ${dump}`;
    expect(stripVocabLeak(mixed, vocabTerms)).toBe(realSpeech);
  });

  it("strips a leak appended after real speech with a separating period", () => {
    const mixed = `${realSpeech} Technical terms: ${dump}`;
    expect(stripVocabLeak(mixed, vocabTerms)).toBe(realSpeech);
  });

  it("drops everything from the label onward, even if real speech somehow trails it", () => {
    // Not a shape seen in production (the ASR trails off *into* the echo,
    // it doesn't resume real transcription afterward) — documents that the
    // marker-anchored cut intentionally treats "label to end of text" as
    // leak territory rather than trying to recover a trailing remnant.
    const mixed = `Technical terms: ${dump} ${realSpeech}`;
    expect(stripVocabLeak(mixed, vocabTerms)).toBe("");
  });

  it("leaves ordinary speech mentioning a vocab term untouched (byte-identical)", () => {
    const real = `so the plan is to ship ${vocabTerms[0]} next week once qa signs off`;
    expect(stripVocabLeak(real, vocabTerms)).toBe(real);
  });

  it("does not strip a short real sentence that happens to be all vocab words", () => {
    // "Claude Code." as its own sentence, alongside real speech elsewhere —
    // too short (< 4 tokens) to trust the overlap ratio on its own.
    const mixed = `${realSpeech} ${vocabTerms[0]} ${vocabTerms[1]}.`;
    expect(stripVocabLeak(mixed, vocabTerms)).toBe(mixed);
  });

  it("strips a label-less leak (term list echoed with no 'Terms:' prefix) via the sentence-chunk fallback", () => {
    const mixed = `${realSpeech} ${dump}.`;
    expect(stripVocabLeak(mixed, vocabTerms)).toBe(realSpeech);
  });

  it("is a no-op with an empty vocabulary list", () => {
    const text = `Technical terms: ${dump}`;
    expect(stripVocabLeak(text, [])).toBe(text);
  });

  it("is a no-op on empty input", () => {
    expect(stripVocabLeak("", vocabTerms)).toBe("");
    expect(stripVocabLeak("   ", vocabTerms)).toBe("   ");
  });
});

// Phase 3b (specs/meeting-transcription-v2.md §3.1): the previous-chunk
// context echo guard.
describe("isContextEcho", () => {
  const context =
    "and so the quarter close plan is to ship the lane change first";

  it("flags a contiguous run of the context", () => {
    expect(isContextEcho("the quarter close plan is to ship", context)).toBe(
      true,
    );
    expect(isContextEcho(context, context)).toBe(true);
    // Case- and punctuation-normalized.
    expect(isContextEcho("Quarter close plan is to ship!", context)).toBe(true);
  });

  it("flags a start with 4 or more of the last words of the context", () => {
    expect(
      isContextEcho("ship the lane change first and then we go home", context),
    ).toBe(true);
    // Three of the last words is not enough — real speech that happens to
    // rhyme with the context's tail must pass.
    expect(isContextEcho("lane change first is done", context)).toBe(false);
  });

  it("flags a close paraphrase (similarity >= 0.8)", () => {
    expect(
      isContextEcho(
        "and so the quarter close plan is to ship the lane change",
        context,
      ),
    ).toBe(true);
  });

  it("passes unrelated speech", () => {
    expect(isContextEcho("hello can you repeat the question", context)).toBe(
      false,
    );
    expect(isContextEcho("ship it", context)).toBe(false);
  });

  it("is a no-op for short results (< 3 words) and an empty context", () => {
    expect(isContextEcho("the quarter", context)).toBe(false);
    expect(isContextEcho(context, "")).toBe(false);
  });

  it("flags a close paraphrase by similarity alone (no contiguous run, no tail start)", () => {
    const ctx = "one two three four five six seven eight nine ten";
    // Nine of the ten words, one substitution: Jaccard 9/11 >= 0.8. Not a
    // contiguous run (the substitution breaks it) and not a tail start.
    const text = "one two three four five six seven eight nine eleven";
    expect(isContextEcho(text, ctx)).toBe(true);
  });

  it("matches word-aligned: no mid-word substring, no partial-word tail prefix", () => {
    const ctx = "xab cdef ghij klmn opqr";
    // "ab cdef" straddles the xab/cdef boundary of the context — a string
    // substring, not a word run: not an echo.
    expect(isContextEcho("ab cdef ghij", ctx)).toBe(false);
    // Starts with the 4-word tail but its first word is a LONGER word
    // (opqrabc): a word-aligned match must reject the partial word.
    expect(isContextEcho("cdef ghij klmn opqrabc zzz", ctx)).toBe(false);
  });
});
