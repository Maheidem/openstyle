// dig.test.mts: unit tests of the dig set (D21). No model runs here. They prove
// that every key is supported by the data: each must-mention group is in the
// summaries or the transcripts of the meetings the key names, and the code
// that classifies the questions does what the key says.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDigAddon } from "./dig-corpus.mts";
import { normalize } from "./keys.mts";
import { buildDig, type DigRow, summarizeDig } from "./p1-dig.mts";

const addon = buildDigAddon();
const qs = buildDig();

const textOf = (id: string): string => {
  const m = addon.meetings.find((x) => x.id === id);
  assert.ok(m, `meeting ${id} exists`);
  return normalize(
    [
      m.title,
      m.overview,
      ...m.keyPoints,
      ...m.decisions.map((d) => d.text),
      ...m.actionItems.map((a) => `${a.task} ${a.owner}`),
      ...m.speakers.map((x) => x.displayName),
      ...m.openQuestions.map((q) => q.text),
      ...m.segments.map((s) => s.text),
    ].join(" "),
  );
};
const hasGroup = (norm: string, g: string[]) =>
  g.some((a) => ` ${norm} `.includes(` ${normalize(a)} `));

test("dig set: 32 questions, 48 turns, EN and PT, three scopes, 4 controls", () => {
  assert.equal(qs.length, 32);
  assert.equal(
    qs.reduce((a, q) => a + q.turns.length, 0),
    48,
  );
  assert.equal(qs.filter((q) => q.control).length, 4);
  assert.deepEqual(new Set(qs.map((q) => q.lang)), new Set(["en", "pt"]));
  assert.deepEqual(
    new Set(qs.map((q) => q.scope.kind)),
    new Set(["meeting", "folder", "all"]),
  );
  assert.ok(qs.filter((q) => q.turns.length === 2).length >= 14);
});

test("dig set: ids are unique and every scope exists", () => {
  assert.equal(new Set(qs.map((q) => q.id)).size, qs.length);
  const folders = new Set(addon.folders.map((f) => f.id));
  const meetings = new Set(addon.meetings.map((m) => m.id));
  for (const q of qs) {
    if (q.scope.kind === "folder") assert.ok(folders.has(q.scope.id ?? ""));
    if (q.scope.kind === "meeting") assert.ok(meetings.has(q.scope.id ?? ""));
  }
});

test("dig set: every must-mention group is in the data of the named meetings", () => {
  for (const q of qs)
    for (const t of q.turns) {
      const all = t.meetings.map(textOf).join(" ");
      // A reason is in at least one of the named meetings (a key with no named meeting uses the scope).
      const scopeText =
        t.meetings.length > 0
          ? all
          : addon.meetings.map((m) => textOf(m.id)).join(" ");
      for (const g of t.groups)
        assert.ok(
          hasGroup(scopeText, g),
          `${q.id} "${t.text}": group ${g.join("|")} is not in the data`,
        );
    }
});

test("dig set: the reasons are spread over 2 to 4 meetings and one meeting holds one reason of a 'why' key", () => {
  for (const q of qs)
    for (const t of q.turns) {
      if (!["why", "blocker"].includes(t.kind)) continue;
      if (q.scope.kind === "meeting") continue;
      assert.ok(t.meetings.length >= 2 && t.meetings.length <= 4, q.id);
      // No single named meeting holds all groups: one search cannot find the answer.
      for (const mid of t.meetings) {
        const n = t.groups.filter((g) => hasGroup(textOf(mid), g)).length;
        assert.ok(n < t.groups.length, `${q.id}: ${mid} holds every group`);
      }
    }
});

test("dig set: the done item is not an open item and the list key excludes it", () => {
  const done = addon.meetings.flatMap((m) =>
    m.actionItems.filter((a) => a.done).map((a) => normalize(a.task)),
  );
  assert.equal(done.length, 2);
  for (const q of qs)
    for (const t of q.turns)
      for (const m of t.mustNot) assert.ok(done.some((d) => d.includes(m)));
});

test("dig set: control questions name no meeting list and ask for one fact", () => {
  for (const q of qs.filter((x) => x.control)) {
    assert.equal(q.turns.length, 1);
    assert.equal(q.turns[0]?.kind, "fact");
    assert.equal(q.turns[0]?.groups.length, 1);
  }
});

test("dig data: ids do not meet the base corpus or the clarify data", () => {
  for (const m of addon.meetings) assert.match(m.id, /^dg-(orc|lag|ced)-\d$/);
  for (const f of addon.folders) assert.match(f.id, /^fld-dg-/);
  for (const p of addon.people) assert.match(p.id, /^dg\d$/);
});

test("summarizeDig keeps controls and setup turns out of the headline numbers", () => {
  const row = (o: Partial<DigRow>): DigRow => ({
    id: "dg01",
    turn: 1,
    scope: "folder",
    lang: "en",
    kind: "why",
    control: false,
    question: "q",
    pass: true,
    notFound: false,
    clarify: false,
    err: null,
    cov: 1,
    covHit: 2,
    covOf: 2,
    forbidden: 0,
    recall: 1,
    citedMeetings: 2,
    citesShown: 2,
    invalidCites: 0,
    uncited: 0,
    repeat: false,
    lenOk: true,
    blocks: 2,
    chars: 200,
    llmCalls: 3,
    toolCalls: 2,
    tool: "search_chunks",
    ms: 1000,
    answer: "a",
    trace: "",
    ...o,
  });
  const m = summarizeDig([
    row({ pass: false, cov: 0, llmCalls: 5 }),
    row({ kind: "fact", pass: true }),
    row({ control: true, kind: "fact", llmCalls: 1, ms: 300 }),
  ]);
  assert.equal(m.pass, 0);
  assert.equal(m.setup_n, 1);
  assert.equal(m.control_n, 1);
  assert.equal(m.control_llm_calls_mean, 1);
  assert.equal(m.llm_calls_mean, 5);
});

// ---- The blind held-out set (dig-heldout.mts) ----
test("held-out dig set: 30 questions, 4 controls, every key is in the data", async () => {
  const { buildHeldoutAddon, buildHeldoutDig } = await import(
    "./dig-heldout.mts"
  );
  const ha = buildHeldoutAddon();
  const hq = buildHeldoutDig();
  assert.equal(hq.length, 30);
  assert.equal(hq.filter((q) => q.control).length, 4);
  assert.equal(new Set(hq.map((q) => q.id)).size, hq.length);
  const text = (id: string) => {
    const m = ha.meetings.find((x) => x.id === id);
    assert.ok(m, `meeting ${id} exists`);
    return normalize(
      [
        m.title,
        m.overview,
        ...m.keyPoints,
        ...m.decisions.map((d) => d.text),
        ...m.actionItems.map((a) => `${a.task} ${a.owner}`),
        ...m.openQuestions.map((q) => q.text),
        ...m.segments.map((s) => s.text),
      ].join(" "),
    );
  };
  for (const q of hq)
    for (const t of q.turns) {
      const all = t.meetings.map(text).join(" ");
      for (const g of t.groups)
        assert.ok(
          hasGroup(all, g),
          `${q.id}: group ${g.join("|")} not in data`,
        );
    }
  // The base ids stay apart from the other data sets.
  assert.ok(ha.meetings.every((m) => m.id.startsWith("hd-")));
});
