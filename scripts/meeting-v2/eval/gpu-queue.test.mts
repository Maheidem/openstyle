// Unit tests of the GPU lock queue order (gpu-queue.mts).
// Run: pnpm meeting:eval:test (node --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { isOurTurn, queueLineTime } from "./gpu-queue.mts";

const NOW = new Date(2026, 9, 21, 9, 0, 0).getTime();
const H = 3600_000;
const OURS = "meeting-eval transcribe 10 2026-10-21T12:00:00.000Z pid=42";

test("queueLineTime: ISO time, HH:MM[:SS] of today or yesterday, or none", () => {
  assert.equal(
    queueLineTime("x 2026-10-21T11:30:00.000Z y", NOW),
    Date.parse("2026-10-21T11:30:00.000Z"),
  );
  assert.equal(
    queueLineTime("project-memory e2b239b 08:43:08 e2b-folder", NOW),
    new Date(2026, 9, 21, 8, 43, 8).getTime(),
  );
  // 23:50 is later than now (09:00): it was yesterday.
  assert.equal(
    queueLineTime("job 23:50 x", NOW),
    new Date(2026, 9, 20, 23, 50, 0).getTime(),
  );
  assert.equal(queueLineTime("summary-fix-246 regression 25", NOW), null);
});

test("isOurTurn: a live line ahead of ours waits; ours first goes", () => {
  const seen = new Map<string, number>();
  const ahead = "project-memory e2b239b 08:43:08 e2b-folder-9243bea0";
  assert.equal(isOurTurn([ahead, OURS, ""], OURS, NOW, seen), false);
  assert.equal(isOurTurn(["", OURS, ahead], OURS, NOW, seen), true);
});

test("isOurTurn: a timed line older than 2 h is skipped, not a newer one", () => {
  const seen = new Map<string, number>();
  const old = "other-job x 06:30:00 y"; // 2.5 h before NOW
  const fresh = "other-job x 07:30:00 y"; // 1.5 h before NOW
  assert.equal(isOurTurn([old, OURS], OURS, NOW, seen), true);
  assert.equal(isOurTurn([fresh, OURS], OURS, NOW, seen), false);
});

test("isOurTurn: a line with no time ages from when it was first seen", () => {
  const seen = new Map<string, number>();
  const untimed = "summary-fix-246 regression 25";
  assert.equal(isOurTurn([untimed, OURS], OURS, NOW, seen), false);
  assert.equal(isOurTurn([untimed, OURS], OURS, NOW + H, seen), false);
  assert.equal(isOurTurn([untimed, OURS], OURS, NOW + 2 * H + 1, seen), true);
});

test("isOurTurn: our line missing is never our turn", () => {
  assert.equal(isOurTurn(["a 08:59 b"], OURS, NOW, new Map()), false);
  assert.equal(isOurTurn([], OURS, NOW, new Map()), false);
});
