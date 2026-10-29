// Unit tests of the gold-building tools: the A/B alignment and diff spans
// (align.mts) and the merge of review answers (gold.mts mergeAnswers).
// Run: pnpm meeting:eval:test (node --test). Fictional text only.

import assert from "node:assert/strict";
import { test } from "node:test";
import { alignChannel, timeBlocks, tokens } from "./align.mts";
import {
  type GoldAnswer,
  mergeAnswers,
  parseAnswers,
  parseGold,
} from "./gold.mts";

// --- align.mts ---------------------------------------------------------------------

test("tokens: words get times inside their segment, by length", () => {
  const t = tokens([{ startMs: 1000, endMs: 2000, text: "Hi, Bob!" }]);
  assert.deepEqual(
    t.map((x) => [x.w, x.o, x.startMs, x.endMs]),
    [
      ["hi", "Hi", 1000, 1429],
      ["bob", "Bob", 1429, 2000],
    ],
  );
});

test("timeBlocks: the union of the segments, small gaps joined", () => {
  const b = timeBlocks(
    [
      { startMs: 0, endMs: 1000, text: "" },
      { startMs: 1500, endMs: 3000, text: "" },
      { startMs: 6000, endMs: 7000, text: "" },
      { startMs: 500, endMs: 1200, text: "" },
    ],
    1000,
  );
  assert.deepEqual(b, [
    { startMs: 0, endMs: 3000 },
    { startMs: 6000, endMs: 7000 },
  ]);
});

test("alignChannel: equal text (case and punctuation aside) has no span", () => {
  const r = alignChannel(
    "mic",
    [{ startMs: 0, endMs: 3000, text: "The blue kettle is on." }],
    [{ startMs: 100, endMs: 2900, text: "the blue kettle is on" }],
  );
  assert.equal(r.spans.length, 0);
  assert.deepEqual(r.stats, {
    aWords: 5,
    bWords: 5,
    eq: 5,
    sub: 0,
    del: 0,
    ins: 0,
    blocks: 1,
  });
  assert.equal(r.turns[0]?.b, "the blue kettle is on");
});

test("alignChannel: one substitution gives one span with both texts and times", () => {
  const r = alignChannel(
    "system",
    [{ startMs: 0, endMs: 4000, text: "We meet at the harbor on Tuesday." }],
    [{ startMs: 0, endMs: 4000, text: "We meet at the harvest on Tuesday." }],
  );
  assert.equal(r.spans.length, 1);
  const s = r.spans[0];
  assert.equal(s?.id, "s1");
  assert.equal(s?.channel, "system");
  assert.equal(s?.a, "harbor");
  assert.equal(s?.b, "harvest");
  assert.ok((s?.startMs ?? -1) > 0 && (s?.endMs ?? 0) < 4000);
  assert.deepEqual(r.turns[0]?.spans, ["s1"]);
  assert.equal(r.stats.sub, 1);
});

test("alignChannel: runs with fewer than mergeEq equal words between them join", () => {
  const a = [
    { startMs: 0, endMs: 6000, text: "red fox jumps over lazy dogs today" },
  ];
  const b = [
    { startMs: 0, endMs: 6000, text: "red box jumps over hazy dogs today" },
  ];
  // Two equal words (jumps over) between the two changes.
  assert.equal(alignChannel("mic", a, b).spans.length, 2);
  const joined = alignChannel("mic", a, b, { mergeEq: 3 });
  assert.equal(joined.spans.length, 1);
  assert.equal(joined.spans[0]?.a, "fox jumps over lazy");
  assert.equal(joined.spans[0]?.b, "box jumps over hazy");
});

test("alignChannel: words in different time blocks never pair", () => {
  // Engine A hears "apple" at 0 s, engine B hears it at 60 s only.
  const r = alignChannel(
    "mic",
    [{ startMs: 0, endMs: 1000, text: "apple" }],
    [{ startMs: 60_000, endMs: 61_000, text: "apple" }],
  );
  assert.equal(r.stats.blocks, 2);
  assert.equal(r.stats.eq, 0);
  assert.deepEqual(
    r.spans.map((s) => [s.id, s.a, s.b, s.startMs, s.endMs]),
    [
      ["m1", "apple", "", 0, 1000],
      ["m2", "", "apple", 60_000, 61_000],
    ],
  );
});

test("alignChannel: inserted B words go to the turn of the A word before them", () => {
  const r = alignChannel(
    "mic",
    [
      { startMs: 0, endMs: 1000, text: "good morning" },
      { startMs: 1200, endMs: 2000, text: "team" },
    ],
    [{ startMs: 0, endMs: 2000, text: "good morning all team" }],
  );
  assert.equal(r.turns[0]?.b, "good morning all");
  assert.equal(r.turns[1]?.b, "team");
  assert.equal(r.spans.length, 1);
  assert.equal(r.spans[0]?.a, "");
  assert.equal(r.spans[0]?.b, "all");
  assert.equal(r.stats.ins, 1);
});

// --- mergeAnswers ------------------------------------------------------------------

function gold(
  mic: { startMs: number; endMs: number; text: string; verified?: boolean }[],
) {
  return {
    format: "openstyle-gold",
    meeting: "abcd1234",
    goldVersion: 2,
    asrHash: "h",
    builtAt: "2026-10-21T10:00:00Z",
    verifiedSpans: 0,
    transcript: {
      mic: mic.map((t) => ({ verified: false, ...t })),
      system: [],
    },
    fixes: [],
    mustNotChange: [],
    extra: "kept",
  };
}
const ans = (o: Partial<GoldAnswer>): GoldAnswer => ({
  id: "m1",
  channel: "mic",
  startMs: 1000,
  endMs: 2000,
  from: "",
  text: "",
  ...o,
});

test("mergeAnswers: the answer splits the turn into before, verified answer, after", () => {
  const g = gold([
    { startMs: 0, endMs: 3000, text: "Please bring the harbor maps, thanks." },
  ]);
  const r = mergeAnswers(g, [
    ans({
      startMs: 1000,
      endMs: 2000,
      from: "harbor maps",
      text: "harbour maps",
    }),
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.merged, 1);
  assert.equal(r.gold.goldVersion, 3);
  assert.equal(r.gold.verifiedSpans, 1);
  assert.equal(r.gold.extra, "kept");
  const mic = (r.gold.transcript as { mic: unknown[] }).mic;
  assert.deepEqual(mic, [
    { startMs: 0, endMs: 1000, text: "Please bring the", verified: false },
    { startMs: 1000, endMs: 2000, text: "harbour maps", verified: true },
    { startMs: 2000, endMs: 3000, text: ", thanks.", verified: false },
  ]);
  // The result is a valid gold file.
  assert.equal(parseGold(JSON.stringify(r.gold), "abcd1234").verifiedSpans, 1);
});

test("mergeAnswers: from words that cross two turns join them", () => {
  const g = gold([
    { startMs: 0, endMs: 1500, text: "see you at" },
    { startMs: 1600, endMs: 3000, text: "nine thirty then" },
  ]);
  const r = mergeAnswers(g, [
    ans({
      startMs: 1000,
      endMs: 2500,
      from: "at nine thirty",
      text: "at 9:30",
    }),
  ]);
  assert.deepEqual(r.errors, []);
  const mic = (
    r.gold.transcript as { mic: { text: string; verified: boolean }[] }
  ).mic;
  assert.deepEqual(
    mic.map((t) => [t.text, t.verified]),
    [
      ["see you", false],
      ["at 9:30", true],
      ["then", false],
    ],
  );
});

test("mergeAnswers: an empty from adds a verified turn; an empty text means no speech", () => {
  const g = gold([{ startMs: 0, endMs: 1000, text: "hello there" }]);
  const r = mergeAnswers(g, [
    ans({
      id: "m1",
      startMs: 5000,
      endMs: 6000,
      from: "",
      text: "one more thing",
    }),
    ans({ id: "m2", startMs: 0, endMs: 1000, from: "there", text: "" }),
  ]);
  assert.deepEqual(r.errors, []);
  const mic = (
    r.gold.transcript as { mic: { text: string; verified: boolean }[] }
  ).mic;
  assert.deepEqual(
    mic.map((t) => [t.text, t.verified]),
    [
      ["hello", false],
      ["", true],
      ["one more thing", true],
    ],
  );
  assert.equal(r.gold.verifiedSpans, 2);
});

test("mergeAnswers: missing or repeated from words refuse the whole merge", () => {
  const g = gold([{ startMs: 0, endMs: 3000, text: "yes yes and no" }]);
  const r = mergeAnswers(g, [
    ans({ id: "m1", from: "and no", text: "and now" }),
    ans({ id: "m2", from: "yes", text: "yeah" }),
    ans({ id: "m3", from: "maybe", text: "perhaps" }),
  ]);
  assert.equal(r.merged, 0);
  assert.equal(r.gold, g);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0] as string, /answer m2: .* 2 times/);
  assert.match(r.errors[1] as string, /answer m3: .* 0 times/);
});

test("mergeAnswers: only turns near the answer time are searched", () => {
  const g = gold([
    { startMs: 0, endMs: 1000, text: "check the boiler" },
    { startMs: 50_000, endMs: 51_000, text: "check the boiler" },
  ]);
  const r = mergeAnswers(g, [
    ans({ startMs: 50_100, endMs: 50_900, from: "boiler", text: "border" }),
  ]);
  assert.deepEqual(r.errors, []);
  const mic = (r.gold.transcript as { mic: { text: string }[] }).mic;
  assert.deepEqual(
    mic.map((t) => t.text),
    ["check the boiler", "check the", "border"],
  );
});

test("mergeAnswers: a repeated short from word resolves to the open span's own turn", () => {
  // The gold puts the open span "the" in its own turn; the same word also
  // occurs in the turns around it.
  const g = gold([
    { startMs: 0, endMs: 1400, text: "Put the kettle on" },
    { startMs: 1400, endMs: 1600, text: "the" },
    { startMs: 1600, endMs: 3000, text: "stove, and the mugs." },
  ]);
  const r = mergeAnswers(g, [
    // The span time starts before its own turn (the other engine's words).
    ans({ startMs: 1300, endMs: 1650, from: "the", text: "a" }),
  ]);
  assert.deepEqual(r.errors, []);
  const mic = (
    r.gold.transcript as {
      mic: { startMs: number; text: string; verified: boolean }[];
    }
  ).mic;
  assert.deepEqual(
    mic.map((t) => [t.startMs, t.text, t.verified]),
    [
      [0, "Put the kettle on", false],
      // Starts inside the turn that held the words, so the order holds.
      [1400, "a", true],
      [1600, "stove, and the mugs.", false],
    ],
  );
  // Two whole-turn hits are still refused.
  const twice = mergeAnswers(
    gold([
      { startMs: 0, endMs: 500, text: "the" },
      { startMs: 600, endMs: 900, text: "the" },
    ]),
    [ans({ startMs: 0, endMs: 900, from: "the", text: "a" })],
  );
  assert.equal(twice.merged, 0);
  assert.match(twice.errors[0] as string, /answer m1: .* 2 times/);
});

test("mergeAnswers: a silver key keeps basis and wer_eligible after a merge and a reload", () => {
  const silver = (t: { startMs: number; endMs: number; text: string }) => ({
    ...t,
    verified: false,
    basis: ["h1", "h3"],
    wer_eligible: true,
  });
  const g = {
    ...gold([]),
    goldVersion: 3,
    goldKind: "silver-3.3",
    transcript: {
      mic: [
        silver({ startMs: 0, endMs: 3000, text: "Zorblax met Quillon today." }),
        silver({ startMs: 4000, endMs: 6000, text: "Thanks, see you." }),
      ],
      system: [
        {
          startMs: 0,
          endMs: 2000,
          text: "Hello there.",
          verified: false,
          basis: ["h1"],
          wer_eligible: false,
        },
      ],
    },
  };
  const r = mergeAnswers(g, [
    ans({ startMs: 1000, endMs: 2000, from: "Quillon", text: "Quilon" }),
  ]);
  assert.deepEqual(r.errors, []);
  const tr = r.gold.transcript as Record<string, Record<string, unknown>[]>;
  // Split parts keep the fields of their source turn; the answer turn has
  // no witness basis, so it is not eligible.
  assert.deepEqual(
    tr.mic?.map((t) => [t.text, t.verified, t.basis, t.wer_eligible]),
    [
      ["Zorblax met", false, ["h1", "h3"], true],
      ["Quilon", true, [], false],
      ["today.", false, ["h1", "h3"], true],
      ["Thanks, see you.", false, ["h1", "h3"], true],
    ],
  );
  assert.deepEqual(tr.system?.[0], g.transcript.system[0]);
  // No turn holds the internal name of the field.
  assert.ok(
    [...(tr.mic ?? []), ...(tr.system ?? [])].every(
      (t) => !("werEligible" in t),
    ),
  );
  // Reload: parseGold reads wer_eligible again.
  const back = parseGold(JSON.stringify(r.gold), "abcd1234");
  assert.deepEqual(
    back.transcript?.mic.map((t) => t.werEligible),
    [true, false, true, true],
  );
  assert.deepEqual(
    back.transcript?.system.map((t) => t.werEligible),
    [false],
  );
});

test("mergeAnswers: a v2 key without wer_eligible gets no new fields", () => {
  const r = mergeAnswers(
    gold([{ startMs: 0, endMs: 3000, text: "Zorblax met Quillon today." }]),
    [ans({ startMs: 1000, endMs: 2000, from: "Quillon", text: "Quilon" })],
  );
  const mic = (r.gold.transcript as { mic: Record<string, unknown>[] }).mic;
  assert.ok(mic.every((t) => !("basis" in t) && !("wer_eligible" in t)));
});

test("parseAnswers: format, meeting and fields are checked", () => {
  const ok = JSON.stringify({
    format: "openstyle-gold-answers",
    meeting: "abcd1234",
    answers: [
      {
        id: "s3",
        channel: "system",
        startMs: 10,
        endMs: 20,
        from: "a",
        text: " b ",
      },
    ],
  });
  assert.deepEqual(parseAnswers(ok, "abcd1234"), [
    {
      id: "s3",
      channel: "system",
      startMs: 10,
      endMs: 20,
      from: "a",
      text: "b",
    },
  ]);
  assert.throws(() => parseAnswers(ok, "ffff0000"), /meeting must equal/);
  assert.throws(
    () =>
      parseAnswers(
        JSON.stringify({ format: "x", meeting: "abcd1234" }),
        "abcd1234",
      ),
    /format must be/,
  );
  const bad = JSON.stringify({
    format: "openstyle-gold-answers",
    meeting: "abcd1234",
    answers: [
      {
        id: "has space",
        channel: "mic",
        startMs: 0,
        endMs: 1,
        from: "",
        text: "",
      },
    ],
  });
  assert.throws(() => parseAnswers(bad, "abcd1234"), /id must match/);
});
