import type {
  OverviewActionItem,
  OverviewSource,
} from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import {
  SOURCES_SHOWN,
  splitActionItems,
  visibleSources,
} from "./folder-overview-model";

const source = (id: string): OverviewSource => ({
  meeting_id: id,
  title: id,
  started_at: 1,
});
const item = (key: string, done: boolean): OverviewActionItem => ({
  key,
  text: key,
  owner: null,
  due: null,
  done,
  sources: [source("m")],
});

describe("splitActionItems", () => {
  it("separates open and done items and keeps the order", () => {
    const { open, done } = splitActionItems([
      item("a", false),
      item("b", true),
      item("c", false),
    ]);
    expect(open.map((i) => i.key)).toEqual(["a", "c"]);
    expect(done.map((i) => i.key)).toEqual(["b"]);
  });

  it("handles an empty list", () => {
    expect(splitActionItems([])).toEqual({ open: [], done: [] });
  });
});

describe("visibleSources", () => {
  const all = ["a", "b", "c", "d"].map(source);
  it("shows the first sources and counts the rest", () => {
    const { shown, hidden } = visibleSources(all, false);
    expect(shown).toHaveLength(SOURCES_SHOWN);
    expect(hidden).toBe(all.length - SOURCES_SHOWN);
  });

  it("shows all sources when expanded", () => {
    expect(visibleSources(all, true)).toEqual({ shown: all, hidden: 0 });
  });

  it("hides none for a short list", () => {
    expect(visibleSources(all.slice(0, 1), false).hidden).toBe(0);
  });
});
