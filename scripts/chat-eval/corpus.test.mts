// corpus.test.mts: the corpus, the gold set and the scorers (spec 8.2 to 8.4).
// Run: pnpm chat-eval:test

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildCorpus, summaryMarkdown, TODAY_MS } from "./corpus.mts";
import { buildGold } from "./gold.mts";
import {
  mrrAt,
  ndcgAt,
  normalize,
  percentile,
  recallAt,
  rrf,
  scoreAnswer,
  scoreSet,
  scoreText,
} from "./keys.mts";
import { INTENTS } from "./types.mts";

const c = buildCorpus();
const g = buildGold(c);
const sha = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");

test("the corpus is the same for the same seed and differs for another", () => {
  assert.equal(sha(buildCorpus()), sha(c));
  assert.notEqual(sha(buildCorpus(7)), sha(c));
  assert.equal(sha(buildGold(buildCorpus())), sha(g));
});

test("the corpus has the shape of spec 8.2", () => {
  assert.equal(c.meetings.length, 30);
  assert.equal(c.people.length, 12);
  assert.equal(c.folders.length, 4);
  const filed = c.meetings.filter((m) => m.folderId !== null);
  assert.equal(c.meetings.length - filed.length, 4);
  for (const f of c.folders) {
    const n = c.meetings.filter((m) => m.folderId === f.id).length;
    assert.ok(n >= 6 && n <= 8, `${f.name} has ${n}`);
  }
  const lang = (l: string) => c.meetings.filter((m) => m.lang === l).length;
  assert.deepEqual([lang("en"), lang("pt"), lang("mixed")], [20, 6, 4]);
  // Four people share a first name (two pairs).
  const firsts = new Map<string, number>();
  for (const p of c.people) firsts.set(p.first, (firsts.get(p.first) ?? 0) + 1);
  assert.equal(
    [...firsts.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0),
    4,
  );
  // Dates cover 12 weeks and the clock is after the last meeting.
  const ts = c.meetings.map((m) => m.startedAt);
  assert.ok(Math.max(...ts) < TODAY_MS);
  assert.ok((Math.max(...ts) - Math.min(...ts)) / (7 * 86_400_000) > 10);
  // Segments are in time order and ids are unique.
  const ids = new Set<string>();
  for (const m of c.meetings) {
    let last = -1;
    for (const s of m.segments) {
      assert.ok(s.startMs > last);
      last = s.startMs;
      assert.ok(!ids.has(s.id));
      ids.add(s.id);
    }
  }
});

test("a fact sits at the segment it names, with its value in the text", () => {
  for (const f of c.facts) {
    const m = c.meetings.find((x) => x.id === f.meetingId);
    const s = m?.segments[f.segmentIdx];
    assert.equal(s?.factId, f.id);
    if (f.family === "quote" || f.family === "metric") {
      assert.ok(normalize(s?.text ?? "").includes(normalize(f.value)), f.id);
    }
  }
  assert.equal(c.facts.filter((f) => f.asrNameLine).length, 21);
});

test("the gold set has the taxonomy of spec 8.3", () => {
  const by = new Map<string, number>();
  for (const q of g.questions) by.set(q.type, (by.get(q.type) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(by), {
    lookup: 25,
    who_said: 20,
    aggregation: 20,
    count: 10,
    temporal: 20,
    knowledge_update: 10,
    not_answerable: 30,
    scope_trap: 10,
    follow_up: 10,
    long_thread: 10,
    write: 25,
  });
  assert.equal(g.questions.length, 190);
  const nf = g.questions.filter((q) => q.key.kind === "not_found").length;
  assert.ok(nf / g.questions.length > 0.15);
  assert.equal(new Set(g.questions.map((q) => q.id)).size, 190);
  for (const q of g.questions) assert.ok(INTENTS.includes(q.intent));
  // Both languages, and every scope kind appears.
  for (const lang of ["en", "pt"])
    assert.ok(g.questions.some((q) => q.lang === lang));
  for (const k of ["meeting", "folder", "all"])
    assert.ok(g.questions.some((q) => q.scope.kind === k));
});

test("long threads have 5 to 10 turns and an early planted fact", () => {
  for (const q of g.questions.filter((x) => x.type === "long_thread")) {
    const turns = q.history.length + 1;
    assert.ok(turns >= 5 && turns <= 10, `${q.id}: ${turns}`);
    assert.ok(q.history[0]?.q.length);
  }
  const lens = g.questions
    .filter((x) => x.type === "long_thread")
    .map((q) => q.history.length + 1);
  assert.ok(lens.some((n) => n === 5) && lens.some((n) => n === 10));
});

test("every text key is supported by the evidence in the corpus", () => {
  const people = new Map(c.people.map((p) => [p.id, p]));
  for (const q of g.questions) {
    if (q.key.kind !== "text" || q.gold.length === 0) continue;
    const gold = q.gold[0] as (typeof q.gold)[number];
    const m = c.meetings.find((x) => x.id === gold.meetingId);
    assert.ok(m, q.id);
    const seg = m.segments[gold.segmentIdx];
    assert.ok(seg, q.id);
    const speaker = seg.personId ? (people.get(seg.personId)?.full ?? "") : "";
    const evidence = `${seg.text} ${speaker} ${summaryMarkdown(m)}`;
    const s = scoreText(evidence, q.key);
    assert.equal(s.missing, 0, `${q.id} ${q.text}: key not in the evidence`);
  }
});

test("set keys are not empty and point at real ids", () => {
  const items = new Set(
    c.meetings.flatMap((m) => [
      ...m.actionItems.map((a) => a.id),
      ...m.decisions.map((d) => d.id),
      ...m.openQuestions.map((x) => x.id),
    ]),
  );
  const meetings = new Set(c.meetings.map((m) => m.id));
  for (const q of g.questions) {
    if (q.key.kind === "set") {
      assert.ok(q.key.ids.length > 0, `${q.id} ${q.text}`);
      for (const id of q.key.ids)
        assert.ok(items.has(id) || meetings.has(id), `${q.id} ${id}`);
    }
    if (q.key.kind === "write") {
      assert.ok(q.key.ids.length > 0);
    }
  }
});

test("not-answerable questions use words that are not in the corpus (checked at build)", () => {
  // buildGold throws when a token is present; reaching here proves it.
  assert.equal(
    g.questions.filter((q) => q.type === "not_answerable").length,
    30,
  );
});

test("retrieval queries cover the five slices in both languages", () => {
  const by = new Map<string, number>();
  for (const q of g.retrieval) by.set(q.slice, (by.get(q.slice) ?? 0) + 1);
  assert.equal(by.get("names"), 40);
  assert.equal(by.get("concept"), 30);
  assert.equal(by.get("asr_names"), 20);
  assert.equal(by.get("date"), 20);
  assert.ok((by.get("numbers") ?? 0) >= 36);
  for (const q of g.retrieval) {
    assert.ok(q.gold.length > 0);
    for (const r of q.gold) {
      assert.ok(
        c.meetings.find((m) => m.id === r.meetingId)?.segments[r.segmentIdx],
      );
    }
  }
  for (const slice of ["names", "numbers", "concept", "asr_names", "date"]) {
    const en = g.retrieval.filter(
      (q) => q.slice === slice && q.lang === "en",
    ).length;
    const pt = g.retrieval.filter(
      (q) => q.slice === slice && q.lang === "pt",
    ).length;
    assert.ok(Math.abs(en - pt) <= 2, `${slice} ${en}/${pt}`);
  }
  // A date-bounded query lists a week that holds the gold meeting.
  for (const q of g.retrieval.filter((x) => x.slice === "date")) {
    const m = c.meetings.find((x) => x.id === q.gold[0]?.meetingId);
    assert.ok(m && q.dateFrom && q.dateTo);
    const day = new Date(m.startedAt).toISOString().slice(0, 10);
    assert.ok(day >= q.dateFrom && day <= q.dateTo);
  }
});

// --- scorers --------------------------------------------------------------

test("normalize folds numbers, dates, accents and number words", () => {
  assert.equal(normalize("41,500 dollars"), "41500 dollars");
  assert.equal(normalize("41.500 reais"), "41500 reais");
  assert.equal(normalize("October 28th"), "d:10-28");
  assert.equal(normalize("28 de outubro"), "d:10-28");
  assert.equal(normalize("2026-10-28"), "d:10-28");
  assert.equal(normalize("Quatorze dias"), "14 dias");
  assert.equal(normalize("São Paulo"), "sao paulo");
  assert.equal(normalize("3.4 percent"), "3.4 percent");
});

test("scoreText: must groups and must-not tokens", () => {
  const key = {
    kind: "text",
    must: [["52200"], ["kestrel", "kessel"]],
    mustNot: ["52700"],
  } as const;
  assert.ok(scoreText("Kestrel quoted 52,200 dollars.", key).pass);
  assert.ok(scoreText("Kessel Hosting: 52.200", key).pass);
  assert.ok(!scoreText("Kestrel quoted 52,700 dollars.", key).pass);
  assert.ok(!scoreText("Kestrel quoted 52,200 or 52,700", key).pass);
  assert.ok(!scoreText("I do not know.", key).pass);
});

test("scoreAnswer: not_found, sets, write proposals", () => {
  assert.ok(
    scoreAnswer(
      { notFound: true, text: "", ids: [], proposal: null },
      { kind: "not_found" },
    ).pass,
  );
  assert.ok(
    !scoreAnswer(
      { notFound: false, text: "42", ids: [], proposal: null },
      { kind: "not_found" },
    ).pass,
  );
  const set = scoreSet(["a", "b"], ["a", "c"]);
  assert.equal(set.precision, 0.5);
  assert.equal(set.recall, 0.5);
  assert.equal(set.f1, 0.5);
  const w = { kind: "write", change: "move", ids: ["m1"], arg: "f1" } as const;
  assert.ok(
    scoreAnswer(
      {
        notFound: false,
        text: "",
        ids: [],
        proposal: { kind: "move", ids: ["m1"], arg: "f1" },
      },
      w,
    ).pass,
  );
  assert.ok(
    !scoreAnswer(
      {
        notFound: false,
        text: "",
        ids: [],
        proposal: { kind: "move", ids: ["m1"], arg: "f2" },
      },
      w,
    ).pass,
  );
  assert.ok(
    !scoreAnswer(
      {
        notFound: false,
        text: "",
        ids: [],
        proposal: { kind: "retag", ids: ["m1"], arg: "f1" },
      },
      w,
    ).pass,
  );
});

test("retrieval metrics and fusion", () => {
  assert.equal(recallAt([0, 0, 2, 0], 3), 1);
  assert.equal(recallAt([0, 0, 2, 0], 2), 0);
  assert.equal(mrrAt([0, 2], 10), 0.5);
  assert.equal(ndcgAt([2, 0, 0], [2], 10), 1);
  assert.ok(ndcgAt([0, 2], [2], 10) < 1 && ndcgAt([0, 2], [2], 10) > 0);
  assert.equal(percentile([1, 2, 3, 4, 100], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  // RRF k=60: an id in both lists beats an id in one. 3 is first in one list
  // and third in the other (1/61 + 1/63) and beats 2 (2/62) by a small margin.
  assert.deepEqual(
    rrf([
      [1, 2, 3],
      [3, 2, 9],
    ]).slice(0, 2),
    [3, 2],
  );
  assert.equal(
    rrf([
      [7, 8],
      [7, 9],
    ])[0],
    7,
  );
  assert.deepEqual(
    rrf([
      [1, 2],
      [2, 1],
    ]),
    [1, 2],
  ); // tie: smaller id first
});
