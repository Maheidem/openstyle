import { describe, expect, it } from "vitest";
import {
  alignChunks,
  type CompareRow,
  renderCompare,
  rowKey,
  rowSignature,
  selfCheckSide,
} from "../src/lib/meetings/compare-rows.js";

function row(
  source: string,
  idx: number,
  start_ms: number,
  end_ms: number,
  text: string,
  label: string | null = null,
): CompareRow {
  return { source, idx, start_ms, end_ms, text, label };
}

const A = row("mic", 0, 100, 900, "hello world", null);
const B = row("system", 1, 1000, 2000, "good morning", "1");
const C = row("system", 2, 2000, 3000, "how are you", "2");

describe("rowKey / rowSignature", () => {
  it("rowKey ignores idx (a split part keeps the original idx)", () => {
    const sameRowOtherIdx = row("system", 9, 1000, 2000, "good morning", "1");
    expect(rowKey(sameRowOtherIdx)).toBe(rowKey(B));
  });

  it("rowKey differs on label, text or boundaries", () => {
    expect(rowKey(row("system", 1, 1000, 2000, "good morning", "2"))).not.toBe(
      rowKey(B),
    );
    expect(
      rowKey(row("system", 1, 1000, 2000, "good afternoon", "1")),
    ).not.toBe(rowKey(B));
    expect(rowKey(row("system", 1, 1000, 2100, "good morning", "1"))).not.toBe(
      rowKey(B),
    );
  });

  it("rowSignature includes idx and renders null labels as '-'", () => {
    expect(rowSignature(A)).toBe("mic|0|100|900|-");
    expect(rowSignature(B)).toBe("system|1|1000|2000|1");
    expect(rowSignature(row("system", 7, 1000, 2000, "x", "1"))).toBe(
      "system|7|1000|2000|1",
    );
  });
});

describe("selfCheckSide", () => {
  it("passes when the rendered side equals the re-read dump", () => {
    const res = selfCheckSide([A, B, C], [A, B, C]);
    expect(res.ok).toBe(true);
    expect(res.firstMismatch).toBeNull();
    expect(res.renderedCount).toBe(3);
    expect(res.refCount).toBe(3);
  });

  it("catches a label mismatch and reports the first row", () => {
    const res = selfCheckSide(
      [A, row("system", 1, 1000, 2000, "good morning", "2"), C],
      [A, B, C],
    );
    expect(res.ok).toBe(false);
    expect(res.firstMismatch).toBe(1);
  });

  it("catches a stale dump row (wrong idx / boundaries / source)", () => {
    // The copy-edit bug: the side was built from the PREVIOUS run's dump.
    expect(
      selfCheckSide(
        [A, row("system", 1, 1000, 2500, "good morning", "1"), C],
        [A, B, C],
      ).ok,
    ).toBe(false);
    expect(
      selfCheckSide([A, B, row("mic", 2, 2000, 3000, "how are you")], [A, B, C])
        .ok,
    ).toBe(false);
    expect(
      selfCheckSide(
        [A, row("system", 9, 1000, 2000, "good morning", "1"), C],
        [A, B, C],
      ).firstMismatch,
    ).toBe(1);
  });

  it("catches a length mismatch in both directions", () => {
    expect(selfCheckSide([A, B, C], [A, B]).ok).toBe(false);
    expect(selfCheckSide([A], [A, B, C]).ok).toBe(false);
  });
});

describe("alignChunks", () => {
  it("aligns identical rows one-to-one", () => {
    expect(alignChunks([A, B, C], [A, B, C])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("handles empty sides", () => {
    expect(alignChunks([], [])).toEqual([]);
    expect(alignChunks([], [B])).toEqual([[null, 0]]);
    expect(alignChunks([B], [])).toEqual([[0, null]]);
  });

  it("aligns a changed label as a substitution, not a delete+insert", () => {
    const b2 = row("system", 1, 1000, 2000, "good morning", "2");
    expect(alignChunks([A, B], [A, b2])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("drops a removed row from the from side", () => {
    expect(alignChunks([A, B, C], [A, C])).toEqual([
      [0, 0],
      [1, null],
      [2, 1],
    ]);
  });

  it("aligns a split (one from row into two to rows) with one insert", () => {
    const part1 = row("system", 2, 2000, 2500, "how", "2");
    const part2 = row("system", 2, 2500, 3000, "are you", "2");
    const res = alignChunks([C], [part1, part2]);
    // One insert (the extra part) plus one substitute: cost 2, and the
    // backtrace prefers the substitute over a delete+insert.
    expect(res).toEqual([
      [null, 0],
      [0, 1],
    ]);
  });
});

describe("renderCompare", () => {
  it("renders 'No changed chunks.' for identical sides (byte-exact header)", () => {
    const { markdown, changed } = renderCompare({
      fromName: "R4f",
      toName: "R4g",
      meetingId8: "abcd1234",
      from: [A, B],
      to: [A, B],
      systemCounts: false,
    });
    expect(changed).toBe(0);
    expect(markdown).toBe(
      "# R4f vs R4g — meeting abcd1234\n\n" +
        "R4f chunks: 2   R4g chunks: 2   changed: 0\n\n" +
        "No changed chunks.\n",
    );
  });

  it("renders the R0d-style summary with system counts", () => {
    const { markdown } = renderCompare({
      fromName: "R0d",
      toName: "R4f",
      meetingId8: "abcd1234",
      from: [A, B],
      to: [A, B],
      systemCounts: true,
    });
    expect(markdown.split("\n")[2]).toBe(
      "R0d chunks: 2 (system 1)   R4f chunks: 2 (system 1)   changed: 0",
    );
  });

  it("renders a changed pair with the to side first, then the from side", () => {
    const b2 = row("system", 1, 1000, 2000, "good morning", "2");
    const { markdown, changed, labelOnly } = renderCompare({
      fromName: "R0d",
      toName: "R4g",
      meetingId8: "abcd1234",
      from: [A, B],
      to: [A, b2],
      systemCounts: true,
    });
    expect(changed).toBe(1);
    expect(labelOnly).toBe(1);
    expect(markdown).toBe(
      "# R0d vs R4g — meeting abcd1234\n\n" +
        "R0d chunks: 2 (system 1)   R4g chunks: 2 (system 1)   changed: 1\n\n" +
        "- [R4g] system #1 1000-2000ms speaker=2 status=ok\n" +
        "  good morning\n" +
        "- [R0d] system #1 1000-2000ms speaker=1 status=ok\n" +
        "  good morning\n",
    );
  });

  it("counts a text change as not label-only", () => {
    const { changed, labelOnly } = renderCompare({
      fromName: "R4f",
      toName: "R4g",
      meetingId8: "abcd1234",
      from: [B],
      to: [row("system", 1, 1000, 2000, "good morning.", "1")],
      systemCounts: false,
    });
    expect(changed).toBe(1);
    expect(labelOnly).toBe(0);
  });

  it("renders an added to-side row without a from line", () => {
    const part = row("system", 1, 2000, 2500, "extra", "1");
    const { markdown, changed } = renderCompare({
      fromName: "R4f",
      toName: "R4g",
      meetingId8: "abcd1234",
      from: [B],
      to: [B, part],
      systemCounts: false,
    });
    expect(changed).toBe(1);
    expect(markdown).toContain(
      "- [R4g] system #1 2000-2500ms speaker=1 status=ok",
    );
    expect(markdown).not.toContain("- [R4f] system #1 2000-2500ms");
  });
});
