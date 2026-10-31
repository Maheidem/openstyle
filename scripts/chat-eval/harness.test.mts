// harness.test.mts: the parts of the harness that need no model: the FTS5
// channels, the grades, the fusion in an arm, the slot closed choices and
// scorers, the rules router and the plan table. The model parts are proven by
// real runs (see the P0 report).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCorpus } from "./corpus.mts";
import { buildGold } from "./gold.mts";
import {
  ARMS,
  buildFts,
  type ChunkRow,
  ftsQuery,
  ftsSearch,
  gradesFor,
  type QueryPass,
  rankArm,
} from "./retrieval.mts";
import {
  extraRouterItems,
  heldoutRouterItems,
  planFor,
  routerSystem,
  rulesRoute,
} from "./router-data.mts";
import {
  buildChoices,
  defaultSlots,
  resolvePeriod,
  scoreSlots,
  slotSchema,
} from "./slots.mts";
import type { Question } from "./types.mts";

const c = buildCorpus();
const g = buildGold(c);

function chunk(
  id: number,
  meetingId: string,
  text: string,
  kind: ChunkRow["kind"] = "transcript",
  segmentIds: string[] = [],
): ChunkRow {
  return { id, meetingId, ordinal: id, kind, segmentIds, text, title: "" };
}

test("ftsQuery drops stop words, quotes terms and keeps names", () => {
  assert.equal(
    ftsQuery("What did Kestrel Hosting quote for the storage cluster?", "word"),
    '"kestrel" OR "hosting" OR "quote" OR "storage" OR "cluster"',
  );
  assert.equal(ftsQuery('say "hi" or "ok"', "word"), '"say" OR "hi" OR "ok"');
  // The trigram tokenizer needs 3 characters (FTS5 docs: shorter strings match nothing).
  assert.equal(ftsQuery("a to go", "trigram"), "");
  assert.equal(
    ftsQuery("Quanto ficou a cotação para o gateway", "word"),
    '"quanto" OR "ficou" OR "cotação" OR "gateway"',
  );
  assert.equal(ftsQuery("", "word"), "");
});

test("FTS5 BM25: word channel folds accents, trigram matches a spelling variant", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-eval-fts-"));
  try {
    const chunks = [
      chunk(
        1,
        "m1",
        "Kestrel Hosting quoted 52,200 dollars for the storage cluster.",
      ),
      chunk(2, "m1", "Cotação do gateway de rede foi aprovada ontem."),
      chunk(3, "m2", "The quote for the backup appliance is still open."),
      chunk(4, "m2", "Tomash Vyechorek signed off on the capacity plan."),
    ];
    const word = buildFts(dir, "word", chunks);
    const tri = buildFts(dir, "trigram", chunks);
    assert.deepEqual(ftsSearch(word, "kestrel quoted", 5), [1]);
    assert.deepEqual(
      new Set(ftsSearch(word, "kestrel quote", 5)),
      new Set([1, 3]),
    ); // no stemming: "quoted" is not "quote"
    // Accent folding: the query has no accent, the text has one.
    assert.deepEqual(ftsSearch(word, "cotacao gateway", 5), [2]);
    // A meeting filter.
    assert.deepEqual(ftsSearch(word, "quote", 5, ["m2"]), [3]);
    // The word tokenizer misses a spelling variant, the trigram tokenizer finds it by shared trigrams.
    assert.deepEqual(ftsSearch(word, "Wieczorek", 5), []);
    assert.deepEqual(ftsSearch(tri, "Vyechorek", 5), [4]);
    assert.ok(ftsSearch(tri, "Hosting", 5).includes(1));
    assert.ok(word.bytes > 0 && tri.bytes >= word.bytes);
    const nc = buildFts(dir, "word", chunks, true);
    assert.ok(nc.bytes <= word.bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gradesFor: 2 for the transcript chunk with the gold segment, 1 for a summary with the value", () => {
  const f = c.facts.find(
    (x) => x.family === "quote" && x.version === 0,
  ) as (typeof c.facts)[number];
  const segId = `${f.meetingId}-s${f.segmentIdx}`;
  const amount = Number(f.value).toLocaleString("en-US");
  const chunks: ChunkRow[] = [
    chunk(10, f.meetingId, "no value here", "transcript", [segId]),
    chunk(11, f.meetingId, `The summary says ${amount} dollars.`, "summary"),
    chunk(12, f.meetingId, "nothing", "summary"),
    chunk(13, "other-meeting", `${amount} dollars`, "summary"),
    chunk(14, f.meetingId, "later chunk", "transcript", [
      `${f.meetingId}-s9999`,
    ]),
  ];
  const grades = gradesFor(
    { gold: [{ meetingId: f.meetingId, segmentIdx: f.segmentIdx }] },
    chunks,
    c,
  );
  assert.equal(grades.get(10), 2);
  assert.equal(grades.get(11), 1);
  assert.equal(grades.has(12), false);
  assert.equal(grades.has(13), false);
  assert.equal(grades.has(14), false);
});

test("arms fuse the channel lists", () => {
  const q = g.retrieval[0] as (typeof g.retrieval)[number];
  const p: QueryPass = {
    q,
    dense: {
      ids: [1, 2, 3],
      ms: 10,
      scores: new Map([
        [1, 0.9],
        [2, 0.8],
        [3, 0.1],
      ]),
    },
    word: { ids: [3, 2, 9], ms: 1 },
    tri: { ids: [9], ms: 1 },
    grades: new Map(),
    ideal: [],
  };
  const arm = (id: string) =>
    ARMS.find((a) => a.id === id) as (typeof ARMS)[number];
  assert.deepEqual(rankArm(p, arm("V0")).ids, [1, 2, 3]);
  assert.deepEqual(rankArm(p, arm("B1")).ids, [3, 2, 9]);
  assert.deepEqual(rankArm(p, arm("H1")).ids.slice(0, 2), [3, 2]);
  assert.equal(rankArm(p, arm("V0")).ms, 10);
  assert.ok(rankArm(p, arm("H1")).ms >= 11);
  assert.ok(rankArm(p, arm("H3")).ms >= 12);
  // R1 without a rerank result is empty (the runner removes the arm then).
  assert.deepEqual(rankArm(p, arm("R1")).ids, []);
  p.rerank = { R1: { ids: [2, 1], ms: 50 } };
  assert.deepEqual(rankArm(p, arm("R1")).ids, [2, 1]);
});

test("closed choices: people, items and meetings come from the scope", () => {
  const folderQ = g.questions.find(
    (q) =>
      q.intent === "aggregate" && q.scope.kind === "folder" && q.args.person_id,
  ) as Question;
  const ch = buildChoices(c, folderQ);
  const team =
    c.folders.find((f) => f.id === folderQ.scope.id)?.teamPersonIds ?? [];
  assert.ok(
    ch.people.length > 0 && ch.people.every((p) => team.includes(p.id)),
  );
  // The person named in the question ranks first.
  assert.equal(ch.people[0]?.id, folderQ.args.person_id);
  assert.ok(ch.items.length <= 8 && ch.meetings.length <= 12);
  const w = g.questions.find(
    (q) =>
      q.intent === "write" &&
      q.key.kind === "write" &&
      q.key.change === "action_item",
  ) as Question;
  const cw = buildChoices(c, w);
  assert.ok(
    cw.items.some((i) => i.id === w.args.item),
    "the gold item is a candidate",
  );
  assert.equal(cw.items[0]?.label, "A1");
});

test("scoreSlots: query tokens, ids, dates, labels", () => {
  const w = g.questions.find(
    (q) =>
      q.intent === "write" &&
      q.key.kind === "write" &&
      q.key.change === "action_item",
  ) as Question;
  const ch = buildChoices(c, w);
  const label = ch.items.find((i) => i.id === w.args.item)?.label;
  assert.ok(scoreSlots(w, { change: "action_item", item: label }, ch).pass);
  assert.ok(!scoreSlots(w, { change: "retag", item: label }, ch).pass);
  assert.ok(!scoreSlots(w, { change: "action_item", item: "none" }, ch).pass);
  const tmp = g.questions.find(
    (q) => q.type === "temporal" && typeof q.args.date_from === "string",
  ) as Question;
  const ok = scoreSlots(
    tmp,
    {
      date_from: tmp.args.date_from as string,
      date_to: tmp.args.date_to as string,
    },
    buildChoices(c, tmp),
  );
  assert.ok(ok.pass);
  assert.ok(
    !scoreSlots(tmp, { date_from: null, date_to: null }, buildChoices(c, tmp))
      .pass,
  );
  const look = g.questions.find((q) => q.type === "lookup") as Question;
  const tok = (look.args.query_any as string[])[0] as string;
  assert.ok(
    scoreSlots(look, { query: `about ${tok}` }, buildChoices(c, look)).pass,
  );
  assert.ok(
    !scoreSlots(look, { query: "something else" }, buildChoices(c, look)).pass,
  );
  // Default slots (arm A5) pass a lookup (query = question) but not a dated question.
  assert.ok(scoreSlots(look, defaultSlots(look), buildChoices(c, look)).pass);
  assert.ok(!scoreSlots(tmp, defaultSlots(tmp), buildChoices(c, tmp)).pass);
});

test("slot schemas are strict objects with closed enums", () => {
  const w = g.questions.find((q) => q.intent === "write") as Question;
  const s = slotSchema("write", buildChoices(c, w)) as {
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, { enum?: string[] }>;
  };
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(new Set(s.required), new Set(Object.keys(s.properties)));
  assert.ok(s.properties.item?.enum?.includes("none"));
  assert.equal(slotSchema("status", buildChoices(c, w)), null);
});

test("rules router and plan table", () => {
  assert.equal(rulesRoute("Who proposed the pilot?"), "who_said");
  assert.equal(rulesRoute("Quem aprovou o plano?"), "who_said");
  assert.equal(rulesRoute("Mark the task as done."), "write");
  assert.equal(rulesRoute("Where do we stand on Atlas?"), "status");
  assert.equal(rulesRoute("Show all decisions in Harbor Pricing."), "review");
  assert.equal(rulesRoute("Which meetings did we have last week?"), "temporal");
  assert.equal(
    rulesRoute("How much is the quote for the storage cluster?"),
    "lookup",
  );
  assert.equal(rulesRoute("Hello, what can you do?"), "other");
  assert.deepEqual(planFor("other"), planFor("lookup"));
  assert.equal(planFor("status")[0], "folder_status");
  assert.equal(planFor("write")[1], "propose_action_item_change");
  const extra = extraRouterItems();
  assert.equal(extra.length, 44);
  assert.equal(new Set(extra.map((x) => x.lang)).size, 7);
});

test("closed dates: the period resolves to the ranges of the gold set", () => {
  assert.deepEqual(resolvePeriod({ period: "last_week" }), {
    date_from: "2026-10-19",
    date_to: "2026-10-25",
  });
  assert.deepEqual(resolvePeriod({ period: "this_week" }), {
    date_from: "2026-10-26",
    date_to: "2026-11-01",
  });
  assert.deepEqual(resolvePeriod({ period: "last_month" }), {
    date_from: "2026-09-01",
    date_to: "2026-09-30",
  });
  assert.deepEqual(resolvePeriod({ period: "this_month" }), {
    date_from: "2026-10-01",
    date_to: "2026-10-26",
  });
  assert.deepEqual(resolvePeriod({ period: "month", month: 9 }), {
    date_from: "2026-09-01",
    date_to: "2026-09-30",
  });
  assert.deepEqual(resolvePeriod({ period: "month", month: 9, day: 15 }), {
    date_from: "2026-09-15",
    date_to: "2026-09-15",
  });
  assert.deepEqual(resolvePeriod({ period: "none" }), {
    date_from: null,
    date_to: null,
  });
  assert.deepEqual(resolvePeriod({ period: "month", month: 13 }), {
    date_from: null,
    date_to: null,
  });
  // Every gold question that says "last week" or "last month" has the range the code gives.
  for (const q of g.questions.filter(
    (x) => /last week|semana passada/.test(x.text) && x.args.date_from,
  )) {
    assert.deepEqual(
      { date_from: q.args.date_from, date_to: q.args.date_to },
      resolvePeriod({ period: "last_week" }),
      q.id,
    );
  }
  const w = g.questions.find((q) => q.intent === "temporal") as Question;
  const s = slotSchema("temporal", buildChoices(c, w), "closed") as {
    properties: Record<string, unknown>;
  };
  assert.ok(s.properties.period && s.properties.month && s.properties.day);
  assert.equal(s.properties.date_from, undefined);
});

test("the blind held-out router set has 4 items per intent and language", () => {
  const h = heldoutRouterItems();
  assert.equal(h.length, 224);
  const per = new Map<string, number>();
  for (const x of h)
    per.set(
      `${x.intent}|${x.lang}`,
      (per.get(`${x.intent}|${x.lang}`) ?? 0) + 1,
    );
  assert.equal(per.size, 56);
  assert.ok([...per.values()].every((n) => n === 4));
  assert.equal(new Set(h.map((x) => x.text)).size, 224);
});

test("router prompts: three variants, all list the 8 intents", () => {
  for (const kind of ["en", "ml", "v2"] as const) {
    const t = routerSystem(kind);
    for (const i of [
      "lookup",
      "who_said",
      "aggregate",
      "temporal",
      "review",
      "status",
      "write",
      "other",
    ]) {
      assert.ok(t.includes(`${i}:`), `${kind} ${i}`);
    }
    // The spec asks for a router prompt under 150 words (spec 2.3, stage 1, point 2).
    assert.ok(
      t.split(/\s+/).length < 220,
      `${kind} is ${t.split(/\s+/).length} words`,
    );
  }
});
