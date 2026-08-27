import { describe, expect, it } from "vitest";
import type { MergedSegment } from "../src/lib/meetings/merge.js";
import {
  resolveSpeakerNames,
  type SpeakerMapRow,
} from "../src/lib/meetings/speaker-names.js";

function seg(
  speaker: "Me" | "Them",
  speakerLabel?: string,
  text = "hello",
): MergedSegment {
  return {
    speaker,
    startMs: 0,
    endMs: 1000,
    text,
    ...(speakerLabel ? { speakerLabel } : {}),
  };
}

describe("resolveSpeakerNames", () => {
  it("attaches speakerName for a segment whose label has a confirmed displayName, leaving speakerLabel unchanged", () => {
    const segments = [seg("Them", "3")];
    const rows: SpeakerMapRow[] = [
      { speakerLabel: "3", displayName: "Ana", mergedInto: null },
    ];
    resolveSpeakerNames(segments, rows);
    expect(segments[0].speakerLabel).toBe("3");
    expect(segments[0].speakerName).toBe("Ana");
  });

  it("remaps a merged segment's speakerLabel to the merge target and attaches the target's name (one-hop resolution, not a passthrough)", () => {
    const segments = [seg("Them", "8")];
    const rows: SpeakerMapRow[] = [
      { speakerLabel: "8", displayName: null, mergedInto: "3" },
      { speakerLabel: "3", displayName: "Ana", mergedInto: null },
    ];
    resolveSpeakerNames(segments, rows);
    expect(segments[0].speakerLabel).toBe("3");
    expect(segments[0].speakerName).toBe("Ana");
  });

  it("leaves a segment untouched when its speakerLabel has no meeting_speakers row at all (lazy-row case)", () => {
    const segments = [seg("Them", "5")];
    resolveSpeakerNames(segments, []);
    expect(segments[0].speakerLabel).toBe("5");
    expect(segments[0].speakerName).toBeUndefined();
  });

  it("never touches a 'Me' segment, or a 'Them' segment with no speakerLabel, regardless of rows", () => {
    const meSeg = seg("Me", "3"); // speakerLabel would never really be set on Me, but prove it's ignored by speaker check
    const unlabeledThem = seg("Them");
    const segments = [meSeg, unlabeledThem];
    const rows: SpeakerMapRow[] = [
      { speakerLabel: "3", displayName: "Ana", mergedInto: null },
    ];
    resolveSpeakerNames(segments, rows);
    expect(segments[0].speakerName).toBeUndefined();
    expect(segments[1].speakerLabel).toBeUndefined();
    expect(segments[1].speakerName).toBeUndefined();
  });

  // Regression test (specs/meeting-speaker-naming.md §14): merging into a
  // target with no `meeting_speakers` row at all — the real shape of
  // meeting 8e6aea86's labels 3/2/5/7 before any naming/suggestion has
  // touched them. A row for the *source* label only, no row for the target
  // in `rows` at all. Resolving through `byLabel.get(row.mergedInto)`
  // instead of the raw label string would silently drop this merge.
  it("resolves a merge into a target with no meeting_speakers row of its own", () => {
    const segments = [seg("Them", "8")];
    const rows: SpeakerMapRow[] = [
      { speakerLabel: "8", displayName: null, mergedInto: "3" },
      // Deliberately no row for "3".
    ];
    resolveSpeakerNames(segments, rows);
    expect(segments[0].speakerLabel).toBe("3");
    expect(segments[0].speakerName).toBeUndefined();
  });
});
