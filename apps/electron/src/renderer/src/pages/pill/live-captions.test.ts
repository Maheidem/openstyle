import { describe, expect, it } from "vitest";
import { captionIsEmpty, captionKey, pickCaption } from "./live-captions";

describe("pickCaption", () => {
  it("returns no text for no lines", () => {
    const caption = pickCaption([]);
    expect(caption).toEqual({ final: null, partial: null });
    expect(captionIsEmpty(caption)).toBe(true);
  });

  it("picks the newest final line and the newest partial line", () => {
    const caption = pickCaption([
      { startMs: 0, text: "first line", final: true },
      { startMs: 4000, text: " second line ", final: true },
      { startMs: 9000, text: "third li", final: false },
      { startMs: 8000, text: "older partial", final: false },
    ]);
    expect(caption).toEqual({ final: "second line", partial: "third li" });
  });

  it("ignores lines with no text", () => {
    const caption = pickCaption([
      { startMs: 0, text: "   ", final: true },
      { startMs: 1000, text: "", final: false },
    ]);
    expect(captionIsEmpty(caption)).toBe(true);
  });

  it("changes the key when the text changes", () => {
    const a = captionKey({ final: "a", partial: null });
    expect(a).not.toBe(captionKey({ final: "a", partial: "b" }));
    expect(a).toBe(captionKey({ final: "a", partial: null }));
  });
});
