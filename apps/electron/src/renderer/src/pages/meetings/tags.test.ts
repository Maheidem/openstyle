import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../locales/en.json";
import { MeetingTagChips } from "./tag-controls";
import { addTag, removeTag, tagErrorKey, tagSuggestions } from "./tags-model";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: i18n.t.bind(i18n), i18n }),
}));

const all = [
  { name: "budget", meeting_count: 4 },
  { name: "hiring", meeting_count: 9 },
  { name: "q3 budget", meeting_count: 1 },
  { name: "roadmap", meeting_count: 2 },
];

describe("addTag", () => {
  it("normalizes the name and keeps the list sorted", () => {
    expect(addTag(["roadmap"], "  Q3   Plan ")).toEqual({
      ok: true,
      tags: ["q3 plan", "roadmap"],
    });
  });

  it("refuses an empty, a too long, a known, or a 21st tag", () => {
    expect(addTag([], "   ")).toEqual({ ok: false, error: "empty" });
    expect(addTag([], "x".repeat(41))).toEqual({ ok: false, error: "tooLong" });
    expect(addTag(["budget"], "BUDGET")).toEqual({
      ok: false,
      error: "exists",
    });
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(addTag(twenty, "new")).toEqual({ ok: false, error: "tooMany" });
    expect(addTag(twenty.slice(1), "new").ok).toBe(true);
  });

  it("removes one tag", () => {
    expect(removeTag(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("tagSuggestions", () => {
  it("shows the most used tags first when the input is empty, without the meeting's tags", () => {
    expect(tagSuggestions(all, ["hiring"], "")).toEqual([
      "budget",
      "roadmap",
      "q3 budget",
    ]);
  });

  it("puts a prefix match before a contains match", () => {
    expect(tagSuggestions(all, [], "Bud")).toEqual(["budget", "q3 budget"]);
    expect(tagSuggestions(all, ["budget"], "bud")).toEqual(["q3 budget"]);
    expect(tagSuggestions(all, [], "zzz")).toEqual([]);
  });
});

describe("MeetingTagChips", () => {
  it("shows a chip with a remove button for each tag, and the add input", () => {
    const html = renderToStaticMarkup(
      createElement(MeetingTagChips, {
        tags: ["budget", "roadmap"],
        allTags: all,
        onSave: vi.fn(async () => {}),
      }),
    );
    expect(html).toContain('aria-label="Tags"');
    expect(html).toContain(">budget<");
    expect(html).toContain('aria-label="Remove the tag budget"');
    expect(html).toContain('aria-label="Remove the tag roadmap"');
    expect(html).toContain('placeholder="Add tag"');
    // No coral and no blue accent: the chips use neutral tokens.
    expect(html).toContain("bg-secondary");
    expect(html).not.toMatch(/coral|live|primary/);
  });

  it("renders with no tags and no existing tags (no LLM needed)", () => {
    const html = renderToStaticMarkup(
      createElement(MeetingTagChips, {
        tags: [],
        allTags: [],
        onSave: vi.fn(async () => {}),
      }),
    );
    expect(html).toContain('aria-label="Add a tag"');
    expect(html).not.toContain("Remove the tag");
  });

  it("has a text for every shown error", () => {
    for (const error of ["tooLong", "tooMany", "saveFailed"] as const) {
      expect(i18n.exists(tagErrorKey(error))).toBe(true);
    }
    expect(i18n.t(tagErrorKey("tooMany"), { max: 20 })).toContain("20");
  });
});
