import { describe, expect, it } from "vitest";
import {
  collapseAsrLineBreaks,
  sanitizeTranscriptText,
  stripThinkingBlocks,
  stripTrailingDuplicate,
} from "./text.js";

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
