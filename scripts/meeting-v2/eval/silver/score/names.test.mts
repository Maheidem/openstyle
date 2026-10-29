// Unit tests of the silver arm name helpers (names.mts).
// Run: pnpm meeting:eval:test (node --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attendeeNames,
  attendeeTokens,
  countRun,
  hasRun,
  nameFromEmail,
} from "./names.mts";

test("nameFromEmail takes first.last with 2+ letters per part", () => {
  assert.equal(nameFromEmail("zorvo.quandt@example.com"), "Zorvo Quandt");
  assert.equal(nameFromEmail("ZORVO.QUANDT@example.com"), "Zorvo Quandt");
  assert.equal(nameFromEmail("jørn.vikse@example.com"), "Jørn Vikse");
});

test("nameFromEmail refuses other email forms", () => {
  assert.equal(nameFromEmail("zorvo@example.com"), null);
  assert.equal(nameFromEmail("z.quandt@example.com"), null);
  assert.equal(nameFromEmail("zorvo.b.quandt@example.com"), null);
  assert.equal(nameFromEmail("zorvo.quandt2@example.com"), null);
  assert.equal(nameFromEmail("@example.com"), null);
  assert.equal(nameFromEmail("no-at-sign"), null);
});

test("attendeeNames uses the display name, else the email name", () => {
  const json = JSON.stringify([
    { name: "Brisa Tolvane", email: "bt@example.com" },
    { name: "", email: "ulmo.kesper@example.com" },
    { name: "ulmo.ravik@example.com" },
    { name: "", email: "room-12@example.com" },
    { name: "X" },
  ]);
  assert.deepEqual(attendeeNames(json), [
    "Brisa Tolvane",
    "Ulmo Kesper",
    "Ulmo Ravik",
  ]);
  assert.deepEqual(attendeeNames(null), []);
});

test("attendeeTokens keeps tokens of 3+ letters once", () => {
  const json = JSON.stringify([
    { name: "Brisa Tolvane" },
    { name: "Brisa Ek" },
    { name: "Ky-Lin O'Varr" },
  ]);
  assert.deepEqual(attendeeTokens(json), ["Brisa", "Tolvane"]);
});

test("countRun and hasRun count contiguous word runs", () => {
  const hay = ["a", "b", "a", "b", "c"];
  assert.equal(countRun(hay, ["a", "b"]), 2);
  assert.equal(countRun(hay, ["b", "c"]), 1);
  assert.equal(countRun(hay, ["c", "a"]), 0);
  assert.equal(hasRun(hay, ["b", "a", "b"]), true);
  assert.equal(hasRun(hay, ["x"]), false);
});
