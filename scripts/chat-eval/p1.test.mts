// p1.test.mts: unit tests of the P1 scorers (p1-score.mts). No model runs here.
// The model parts are proven by the real run (pnpm chat-eval p1).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildCorpus } from "./corpus.mts";
import { buildGold } from "./gold.mts";
import { scoreAnswer } from "./keys.mts";
import {
  answerFromTurn,
  BARS,
  barRow,
  barStatus,
  barsTable,
  buildIdMaps,
  checkCites,
  citeCounts,
  citeHits,
  confusion,
  creditGroup,
  evaluateBars,
  firstTool,
  goldSpans,
  listItemId,
  mapProposal,
  nativeOutcome,
  normalizeName,
  personId,
  scoreProdSlots,
  scoreToolArgs,
  type TurnLike,
} from "./p1-score.mts";

const corpus = buildCorpus();
const gold = buildGold(corpus);
const keyFn = (m: string, t: string) =>
  createHash("sha256").update(`${m}\n${t}`).digest("hex").slice(0, 16);
const maps = buildIdMaps(corpus, keyFn);
const byId = (id: string) => gold.questions.find((q) => q.id === id)!;

const turn = (p: Partial<TurnLike>): TurnLike => ({
  blocks: [],
  content: "",
  cites: [],
  proposal: null,
  ...p,
});
const cite = (label: string, meeting: string, start: number | null) => ({
  label,
  kind: "transcript" as const,
  meeting_id: meeting,
  title: null,
  started_at: null,
  start_ms: start,
  item_id: null,
  text: "x",
});

// --- ids --------------------------------------------------------------------------

test("id maps: action items, decisions and questions round trip", () => {
  const a = corpus.meetings[0]!.actionItems[0]!;
  const prod = maps.itemToProd.get(a.id)!;
  assert.equal(prod, keyFn(corpus.meetings[0]!.id, a.task));
  assert.equal(maps.prodToItem.get(prod), a.id);
  const d = corpus.meetings[0]!.decisions[0]!;
  assert.equal(maps.prodToItem.get(keyFn(corpus.meetings[0]!.id, d.text)), d.id);
});

test("id maps: person key is the normalized full name; aliases map back", () => {
  const p = corpus.people[0]!;
  assert.equal(maps.personToProd.get(p.id), normalizeName(p.full));
  assert.equal(personId("Ana Silvestre", maps), "p01");
  assert.equal(personId(normalizeName(p.asr), maps), p.id);
  assert.equal(personId("nobody known", maps), "nobody known");
  assert.equal(normalizeName("  José  Ça "), "jose ca");
});

test("listItemId reads the key first, then meeting and text", () => {
  const m = corpus.meetings[0]!;
  const a = m.actionItems[0]!;
  const key = maps.itemToProd.get(a.id)!;
  assert.equal(
    listItemId({ item_id: key, meeting_id: null, text: "x" }, maps),
    a.id,
  );
  assert.equal(
    listItemId({ item_id: "zz", meeting_id: m.id, text: a.task }, maps),
    a.id,
  );
  assert.equal(
    listItemId({ item_id: "zz", meeting_id: m.id, text: "unknown" }, maps),
    null,
  );
});

test("creditGroup: a member of the gold text counts as the gold id", () => {
  const ids = [...maps.textOf.entries()];
  const dup = ids.find(([id, t]) =>
    ids.some(([id2, t2]) => id2 !== id && t2 === t),
  );
  if (dup) {
    const other = ids.find(([id2, t2]) => id2 !== dup[0] && t2 === dup[1])!;
    assert.equal(creditGroup(dup[0], [other[0]], maps), other[0]);
  }
  assert.equal(creditGroup("a", ["a"], maps), "a");
  assert.equal(creditGroup("unknown", ["b"], maps), "unknown");
});

// --- Answer builder ------------------------------------------------------------------

test("Answer: not_found block", () => {
  const a = answerFromTurn(
    turn({
      blocks: [
        {
          kind: "not_found",
          scope: { kind: "meeting", id: "m" },
          reason: "no_sources",
          nearest: [],
        },
      ],
    }),
    maps,
    byId("q106").key,
  );
  assert.equal(a.notFound, true);
  assert.equal(scoreAnswer(a, byId("q106").key).pass, true);
});

test("Answer: text answer scored by the key", () => {
  const q = byId("q001");
  const a = answerFromTurn(
    turn({
      content: "The network gateway quote is 49,600 reais.",
      blocks: [{ kind: "text", text: "x", cites: ["S1"] }],
    }),
    maps,
    q.key,
  );
  assert.equal(a.notFound, false);
  assert.equal(scoreAnswer(a, q.key).pass, true);
  const wrong = answerFromTurn(turn({ content: "It is 49,400." }), maps, q.key);
  assert.equal(scoreAnswer(wrong, q.key).pass, false);
});

test("Answer: a count block gives its number as text", () => {
  const q = byId("q066");
  const a = answerFromTurn(
    turn({ blocks: [{ kind: "count", n: 7, what: "meetings" }] }),
    maps,
    q.key,
  );
  assert.equal(scoreAnswer(a, q.key).pass, true);
  const b = answerFromTurn(
    turn({ blocks: [{ kind: "count", n: 6, what: "meetings" }] }),
    maps,
    q.key,
  );
  assert.equal(scoreAnswer(b, q.key).pass, false);
});

test("Answer: a list block maps the item ids back to corpus ids", () => {
  const q = byId("q046");
  assert.equal(q.key.kind, "set");
  const ids = (q.key as { ids: string[] }).ids;
  const items = ids.map((id) => ({
    text: "t",
    meeting_id: id.split("#")[0]!,
    meeting_title: null,
    item_id: maps.itemToProd.get(id)!,
    done: false,
    owner: null,
    due: null,
    label: null,
  }));
  const a = answerFromTurn(
    turn({
      blocks: [{ kind: "list", list: "action_items", total: items.length, items }],
    }),
    maps,
    q.key,
  );
  assert.deepEqual([...a.ids].sort(), [...ids].sort());
  const s = scoreAnswer(a, q.key);
  assert.equal(s.pass, true);
  assert.equal(s.f1, 1);
});

test("Answer: a status block passes when open_actions equals the gold set size", () => {
  const q = byId("q060");
  const n = (q.key as { ids: string[] }).ids.length;
  const ok = answerFromTurn(
    turn({
      blocks: [{ kind: "status", bullets: [], open_actions: n, open_questions: 0 }],
    }),
    maps,
    q.key,
  );
  assert.equal(scoreAnswer(ok, q.key).pass, true);
  const bad = answerFromTurn(
    turn({
      blocks: [
        { kind: "status", bullets: [], open_actions: n + 1, open_questions: 0 },
      ],
    }),
    maps,
    q.key,
  );
  assert.equal(scoreAnswer(bad, q.key).pass, false);
});

test("Answer: a meeting set without a list reads the meetings of the cites", () => {
  const q = byId("q076");
  const ids = (q.key as { ids: string[] }).ids;
  const a = answerFromTurn(
    turn({
      content: "These meetings.",
      cites: [...ids, ids[0]!].map((m, i) => cite(`S${i + 1}`, m, null)),
    }),
    maps,
    q.key,
  );
  assert.equal(scoreAnswer(a, q.key).pass, true);
});

test("Answer: write proposal maps to corpus ids", () => {
  const q = byId("q166");
  const item = (q.key as { ids: string[] }).ids[0]!;
  const a = answerFromTurn(
    turn({
      blocks: [{ kind: "read_only" }],
      proposal: {
        kind: "action_item",
        ids: [maps.itemToProd.get(item)!],
        arg: true,
      },
    }),
    maps,
    q.key,
  );
  assert.equal(a.notFound, false);
  assert.equal(scoreAnswer(a, q.key).pass, true);
  assert.equal(
    scoreAnswer(
      answerFromTurn(turn({ blocks: [{ kind: "read_only" }] }), maps, q.key),
      q.key,
    ).pass,
    false,
  );
  const merge = mapProposal(
    { kind: "merge_people", ids: ["ana silvestre"], arg: null },
    maps,
  );
  assert.deepEqual(merge?.ids, ["p01"]);
  assert.equal(mapProposal(null, maps), null);
});

// --- Cites ----------------------------------------------------------------------------

test("cite precision and recall use the gold segment span", () => {
  const q = byId("q001");
  const spans = goldSpans(q, corpus);
  assert.equal(spans.length, 1);
  const s = spans[0]!;
  assert.equal(s.meetingId, "mtg-atlas-3");
  assert.equal(
    citeHits({ meeting_id: s.meetingId, start_ms: s.startMs + 1 }, spans, "start"),
    true,
  );
  assert.equal(
    citeHits({ meeting_id: s.meetingId, start_ms: s.endMs + 1 }, spans, "start"),
    false,
  );
  assert.equal(
    citeHits({ meeting_id: "other", start_ms: s.startMs }, spans, "start"),
    false,
  );
  // A chunk that starts before the segment and ends after it meets the span in range mode.
  const chunk = {
    meeting_id: s.meetingId,
    start_ms: Math.max(0, s.startMs - 20000),
    end_ms: s.endMs + 20000,
  };
  assert.equal(citeHits(chunk, spans, "start"), false);
  assert.equal(citeHits(chunk, spans, "range"), true);
  assert.equal(citeHits({ meeting_id: s.meetingId, start_ms: null }, spans, "meeting"), true);
  const pr = citeCounts(
    [
      { meeting_id: s.meetingId, start_ms: s.startMs },
      { meeting_id: s.meetingId, start_ms: s.endMs + 5000 },
    ],
    spans,
    "start",
  );
  assert.deepEqual(pr, { shown: 2, hit: 1, gold: 1, covered: 1 });
  assert.deepEqual(citeCounts([], spans, "start"), {
    shown: 0,
    hit: 0,
    gold: 1,
    covered: 0,
  });
});

test("checkCites finds labels without a cite and cites without data", () => {
  const known = {
    meeting: (id: string) => id === "m1",
    start: (_m: string, s: number) => s === 1000,
    item: (id: string) => id === "i1",
  };
  const good = checkCites(
    {
      blocks: [{ kind: "text", text: "x", cites: ["S1"] }],
      cites: [cite("S1", "m1", 1000)],
    },
    known,
  );
  assert.deepEqual(good.invalid, []);
  assert.equal(good.shown, 1);
  const bad = checkCites(
    {
      blocks: [{ kind: "text", text: "x", cites: ["S1", "S9"] }],
      cites: [cite("S1", "m2", 1000), cite("S2", "m1", 5), cite("X3", "m1", null)],
    },
    known,
  );
  assert.deepEqual(bad.invalid.sort(), [
    "S1:no_meeting",
    "S2:no_start",
    "S9:no_cite",
    "X3:bad_label",
  ]);
  const item = checkCites(
    { blocks: [], cites: [{ ...cite("S1", "m1", null), kind: "item", item_id: "zz" }] },
    known,
  );
  assert.deepEqual(item.invalid, ["S1:no_item"]);
  const list = checkCites(
    {
      blocks: [
        {
          kind: "list",
          list: "action_items",
          total: 1,
          items: [
            {
              text: "t",
              meeting_id: null,
              meeting_title: null,
              item_id: null,
              done: null,
              owner: null,
              due: null,
              label: "S13",
            },
          ],
        },
      ],
      cites: [],
    },
    known,
  );
  assert.deepEqual(list.invalid, ["S13:no_cite"]);
});

// --- Tool and args -----------------------------------------------------------------------

test("firstTool: run tool, native propose step, proposal kind", () => {
  assert.equal(firstTool([{ tool: "search_chunks" }], [], null), "search_chunks");
  assert.equal(firstTool([], ["native:propose_retag"], null), "propose_retag");
  assert.equal(firstTool([], ["intent:write"], "move"), "propose_move");
  assert.equal(firstTool([], [], null), null);
});

test("scoreToolArgs: read questions check the id-level args", () => {
  const q = byId("q001");
  assert.equal(
    scoreToolArgs(q, { tool: "search_chunks", args: { query: "network gateway quote" } }, null, maps).pass,
    true,
  );
  assert.equal(
    scoreToolArgs(q, { tool: "search_chunks", args: { query: "weather" } }, null, maps).pass,
    false,
  );
  const agg = byId("q046");
  const person = maps.personToProd.get("p01")!;
  assert.equal(
    scoreToolArgs(agg, { tool: "list_action_items", args: { person_id: person, status: "open" } }, null, maps).pass,
    true,
  );
  assert.equal(
    scoreToolArgs(agg, { tool: "list_action_items", args: { person_id: person } }, null, maps).pass,
    false,
  );
  const temporal = byId("q076");
  assert.equal(
    scoreToolArgs(temporal, { tool: "list_meetings", args: { date_from: "2026-10-19", date_to: "2026-10-25" } }, null, maps).pass,
    true,
  );
  assert.equal(
    scoreToolArgs(temporal, { tool: "list_meetings", args: { limit: 50 } }, null, maps).pass,
    false,
  );
});

test("scoreToolArgs: write questions check the proposal", () => {
  const q = byId("q176");
  const ok = scoreToolArgs(
    q,
    null,
    { kind: "retag", ids: ["mtg-atlas-4", "mtg-atlas-5"], arg: ["q3-review"] },
    maps,
  );
  assert.equal(ok.pass, true);
  assert.equal(ok.keys.date_from, undefined);
  assert.equal(
    scoreToolArgs(q, null, { kind: "retag", ids: ["mtg-atlas-4"], arg: ["other"] }, maps).pass,
    false,
  );
  const mv = byId("q182");
  assert.equal(
    scoreToolArgs(mv, null, { kind: "move", ids: ["mtg-ops-1"], arg: "fld-atlas" }, maps).pass,
    true,
  );
  const mg = byId("q187");
  assert.equal(
    scoreToolArgs(mg, null, { kind: "merge_people", ids: ["p01"], arg: null }, maps).pass,
    true,
  );
});

test("scoreProdSlots: labels resolve through the production choices", () => {
  const q = byId("q166");
  const itemId = (q.key as { ids: string[] }).ids[0]!;
  const choices = {
    items: [{ label: "A1", id: maps.itemToProd.get(itemId)! }],
    meetings: [],
  };
  const dates = { date_from: null, date_to: null };
  assert.equal(
    scoreProdSlots(q, { item: "A1", change: "action_item" }, dates, choices, maps).pass,
    true,
  );
  assert.equal(
    scoreProdSlots(q, { item: "none", change: "action_item" }, dates, choices, maps).pass,
    false,
  );
  assert.equal(
    scoreProdSlots(q, { item: "A1", change: "retag" }, dates, choices, maps).keys.change,
    false,
  );
  const t = byId("q076");
  assert.equal(
    scoreProdSlots(t, {}, { date_from: "2026-10-19", date_to: "2026-10-25" }, choices, maps).pass,
    true,
  );
  assert.equal(
    scoreProdSlots(t, {}, { date_from: "2026-10-19", date_to: null }, choices, maps).pass,
    false,
  );
});

// --- Router and native step ---------------------------------------------------------------

test("confusion matrix and accuracy", () => {
  const c = confusion([
    { gold: "lookup", pred: "lookup" },
    { gold: "lookup", pred: "temporal" },
    { gold: "temporal", pred: null },
  ]);
  assert.equal(c.n, 3);
  assert.ok(Math.abs(c.accuracy - 1 / 3) < 1e-9);
  assert.equal(c.matrix.lookup!.temporal, 1);
  assert.equal(c.matrix.temporal!.invalid, 1);
});

test("nativeOutcome reads the route step", () => {
  assert.equal(nativeOutcome(["native:search_chunks", "search_chunks"]), "ok");
  assert.equal(nativeOutcome(["native:invalid"]), "invalid");
  assert.equal(nativeOutcome(["native:none"]), "none");
  assert.equal(nativeOutcome(["native:error"]), "error");
  assert.equal(nativeOutcome(["intent:lookup"]), "off");
});

// --- Bars ---------------------------------------------------------------------------------

test("barStatus: threshold direction, not run and reported", () => {
  assert.equal(barStatus({ threshold: 0.85, dir: "min" }, 0.85), "PASS");
  assert.equal(barStatus({ threshold: 0.85, dir: "min" }, 0.849), "FAIL");
  assert.equal(barStatus({ threshold: 150, dir: "max" }, 150), "PASS");
  assert.equal(barStatus({ threshold: 150, dir: "max" }, 150.5), "FAIL");
  assert.equal(barStatus({ threshold: 0, dir: "eq" }, 0), "PASS");
  assert.equal(barStatus({ threshold: 0, dir: "eq" }, 1), "FAIL");
  assert.equal(barStatus({ threshold: 1, dir: "eq" }, 0.99), "FAIL");
  assert.equal(barStatus({ threshold: 0.9, dir: "min" }, null), "NOT RUN");
  assert.equal(barStatus({ threshold: 0.9, dir: "min" }, undefined), "NOT RUN");
  assert.equal(barStatus({ threshold: 0.9, dir: "min" }, Number.NaN), "NOT RUN");
  assert.equal(barStatus({ threshold: null, dir: "min" }, 0.4), "REPORTED");
  assert.equal(barStatus({ threshold: null, dir: "min" }, null), "NOT RUN");
});

test("bars table: every bar has a row, thresholds are fixed, unmeasured = NOT RUN", () => {
  const rows = evaluateBars({});
  assert.equal(rows.length, BARS.length);
  assert.ok(rows.every((r) => r.status === "NOT RUN"));
  const ids = new Set(BARS.map((b) => b.id));
  assert.equal(ids.size, BARS.length, "bar ids are unique");
  const th = (id: string) => BARS.find((b) => b.id === id)!.threshold;
  // The thresholds of the owner decision of 2026-10-31.
  assert.equal(th("ret.ndcg"), 0.65);
  assert.equal(th("ret.r10any"), 0.85);
  assert.equal(th("ret.rerank15"), 400);
  assert.equal(th("ret.ram"), 1536);
  assert.equal(th("route.blind"), 0.9);
  assert.equal(th("route.gold"), 0.85);
  assert.equal(th("slots"), 0.9);
  assert.equal(th("toolargs"), 0.85);
  assert.equal(th("write"), 0.9);
  assert.equal(th("route.lat"), 700);
  assert.equal(th("a0.22"), 0.74);
  assert.equal(th("a0.35"), 0.85);
  assert.equal(th("cite.valid"), 1);
  assert.equal(th("nf.acc"), 0.9);
  assert.equal(th("nf.false"), 0.15);
  assert.equal(th("listf1"), 0.85);
  assert.equal(th("cite.prec"), 0.8);
  assert.equal(th("lat.p95"), 6000);
  const some = evaluateBars({ "nf.false": 0.1, "nf.acc": 0.8, "writes": 0 });
  assert.equal(some.find((r) => r.id === "nf.false")!.status, "PASS");
  assert.equal(some.find((r) => r.id === "nf.acc")!.status, "FAIL");
  assert.equal(some.find((r) => r.id === "writes")!.status, "PASS");
  assert.equal(some.find((r) => r.id === "slots")!.status, "NOT RUN");
  const txt = barsTable(some);
  assert.match(txt, /\| bar \| threshold \| measured \| result \| source \|/);
  assert.match(txt, /False not-found rate \| <= 15\.0% \| 10\.0% \| PASS \| p1-e2e/);
});

test("barRow formats units", () => {
  const r = barRow(BARS.find((b) => b.id === "ret.ram")!, 1481.4);
  assert.equal(r.measured, "1481 MB");
  assert.equal(r.threshold, "<= 1536 MB");
  assert.equal(r.status, "PASS");
  assert.equal(barRow(BARS.find((b) => b.id === "whosaid")!, 0.5).threshold, "report");
});
