// Unit tests of the ranking metrics of the memory recall run
// (memory-recall-metrics.mts). Fictional ids. Run: pnpm meeting:eval:test.

import assert from "node:assert/strict";
import { test } from "node:test";
import { rankMeetings, rankMetrics } from "./memory-recall-metrics.mts";

test("rankMeetings: distinct meetings in order of the first hit", () => {
  assert.deepEqual(
    rankMeetings([{ meetingId: "b" }, { meetingId: "a" }, { meetingId: "b" }]),
    ["b", "a"],
  );
});

test("rankMetrics: recall at 10, reciprocal rank and base rate", () => {
  const ranked = ["x", "a", "y", "b"];
  const m = rankMetrics(ranked, new Set(["a", "b", "c"]), 12);
  assert.equal(m.recall, 2 / 3);
  assert.equal(m.rr, 1 / 2);
  assert.equal(m.baseRate, 3 / 12);
  assert.equal(m.listed, 4);
});

test("rankMetrics: a relevant meeting below rank 10 does not count for recall, but for rr", () => {
  const ranked = Array.from({ length: 12 }, (_, i) => `m${i}`);
  const m = rankMetrics(ranked, new Set(["m11"]), 20);
  assert.equal(m.recall, 0);
  assert.equal(m.rr, 1 / 12);
});

test("rankMetrics: no hit gives zero", () => {
  const m = rankMetrics([], new Set(["a"]), 5);
  assert.deepEqual(m, { recall: 0, rr: 0, baseRate: 0.2, listed: 0 });
});
