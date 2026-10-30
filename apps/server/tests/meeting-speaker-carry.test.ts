import { describe, expect, it } from "vitest";
import {
  carrySpeakerRows,
  type LabeledSpan,
  matchSpeakerLabels,
  type SpeakerRow,
} from "../src/lib/meetings/speaker-carry.js";

const span = (startMs: number, endMs: number, label: string): LabeledSpan => ({
  startMs,
  endMs,
  label,
});

const row = (label: string, o: Partial<SpeakerRow> = {}): SpeakerRow => ({
  speaker_label: label,
  display_name: null,
  suggested_name: null,
  suggested_evidence: null,
  suggested_kind: null,
  merged_into: null,
  confirmed_at: null,
  updated_at: 1,
  ...o,
});

describe("matchSpeakerLabels", () => {
  it("maps each new label to the old label with the same time, also when the numbers change", () => {
    const old = [
      span(0, 1000, "1"),
      span(1000, 2000, "2"),
      span(2000, 3000, "1"),
    ];
    // The new run numbers the speakers the other way round and cuts the
    // segments at other times.
    const now = [
      span(0, 600, "2"),
      span(600, 1000, "2"),
      span(1000, 2000, "1"),
      span(2000, 3000, "2"),
    ];
    expect(Object.fromEntries(matchSpeakerLabels(old, now))).toEqual({
      "1": "2",
      "2": "1",
    });
  });

  it("leaves a new label unmapped when its time is split between two old speakers", () => {
    // New "1" covers old "1" and old "2" in equal parts.
    const old = [span(0, 1000, "1"), span(1000, 2000, "2")];
    const now = [span(0, 2000, "1")];
    expect(matchSpeakerLabels(old, now).size).toBe(0);
  });

  it("leaves both new labels unmapped when one old speaker splits into two (60/40)", () => {
    const old = [span(0, 1000, "1")];
    const now = [span(0, 600, "1"), span(600, 1000, "2")];
    expect(matchSpeakerLabels(old, now).size).toBe(0);
  });

  it("maps at the threshold: 80% of the overlap in both directions", () => {
    const old = [span(0, 800, "1"), span(800, 1000, "2")];
    const now = [span(0, 1000, "1")];
    // New "1": 800 of 1000 ms with old "1" (80%). Old "1": all of its overlap
    // goes to new "1" (100%).
    expect(Object.fromEntries(matchSpeakerLabels(old, now))).toEqual({
      "1": "1",
    });
    const below = [span(0, 790, "1"), span(790, 1000, "2")];
    expect(matchSpeakerLabels(below, now).size).toBe(0);
  });

  it("ignores time where only one side has a labeled segment", () => {
    const old = [span(0, 1000, "1")];
    const now = [span(0, 1000, "1"), span(5000, 6000, "2")];
    expect(Object.fromEntries(matchSpeakerLabels(old, now))).toEqual({
      "1": "1",
    });
  });
});

describe("carrySpeakerRows", () => {
  it("moves names, suggestions and merges to the new labels", () => {
    const rows = [
      row("1", { display_name: "Ana Lima", confirmed_at: 5 }),
      row("2", { display_name: "Ben Ortiz", confirmed_at: 6 }),
      row("3", { merged_into: "1", confirmed_at: 7 }),
      row("4", { suggested_name: "Cleo", suggested_kind: "name" }),
    ];
    const map = new Map([
      ["2", "1"],
      ["1", "2"],
      ["5", "3"],
      ["6", "4"],
    ]);
    const { rows: carried, lost } = carrySpeakerRows(rows, map);
    expect(lost).toEqual([]);
    expect(carried).toEqual([
      row("2", { display_name: "Ana Lima", confirmed_at: 5 }),
      row("1", { display_name: "Ben Ortiz", confirmed_at: 6 }),
      row("5", { merged_into: "2", confirmed_at: 7 }),
      row("6", { suggested_name: "Cleo", suggested_kind: "name" }),
    ]);
  });

  it("lists the confirmed names that have no match, and drops a merge whose target has none", () => {
    const rows = [
      row("1", { display_name: "Ana Lima" }),
      row("2", { display_name: "Ben Ortiz" }),
      row("3", { display_name: "Dana Cruz", merged_into: "2" }),
    ];
    const { rows: carried, lost } = carrySpeakerRows(
      rows,
      new Map([
        ["1", "1"],
        ["4", "3"],
      ]),
    );
    expect(lost).toEqual(["Ben Ortiz"]);
    expect(carried).toEqual([
      row("1", { display_name: "Ana Lima" }),
      row("4", { display_name: "Dana Cruz", merged_into: null }),
    ]);
  });

  it("does not list a name that another kept row still carries", () => {
    const rows = [
      row("1", { display_name: "Ana Lima" }),
      row("2", { display_name: "Ana Lima" }),
    ];
    const { lost } = carrySpeakerRows(rows, new Map([["1", "1"]]));
    expect(lost).toEqual([]);
  });
});
