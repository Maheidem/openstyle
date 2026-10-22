// Unit tests of the gold key v2 (gold.mts), the scorers (score.mts), the
// baselines (baseline.mts) and the report scorecard (report.mts).
// Run: pnpm meeting:eval:test (node --test). Fictional text only.

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  baselinePath,
  buildBaseline,
  compareBaselines,
  noiseBands,
  parseBaseline,
  saveBaseline,
} from "./baseline.mts";
import {
  levenshtein,
  parseAnswerKey,
  runMetrics,
  type SegmentRow,
} from "./checks.mts";
import {
  type Gold,
  goldFromAnswerKey,
  goldInfo,
  loadGold,
  parseGold,
} from "./gold.mts";
import {
  floorModel,
  hardFailsOf,
  type Results,
  type RunResult,
  renderResults,
  selfCheck,
} from "./report.mts";
import {
  errorRates,
  scoreFixes,
  scoreRun,
  scoreSpeakers,
  scoreSummary,
  scoreTags,
  stageMetrics,
  words,
} from "./score.mts";

const tmp = mkdtempSync(join(tmpdir(), "score-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const seg = (
  source: "mic" | "system",
  idx: number,
  start: number,
  text: string,
  enhanced: string | null = null,
): SegmentRow => ({
  id: `${source}${idx}`,
  source,
  idx,
  start_ms: start,
  text,
  enhanced_text: enhanced,
});

/** A fictional gold key: a product team plans a launch. */
const GOLD_JSON = {
  format: "openstyle-gold",
  meeting: "aaaa1111",
  goldVersion: 2,
  asrHash: "hash-1",
  builtAt: "2026-10-21T10:00:00Z",
  verifiedSpans: 1,
  transcript: {
    mic: [
      { startMs: 0, endMs: 3000, text: "The plan is ready.", verified: true },
      {
        startMs: 3000,
        endMs: 6000,
        text: "We ship on Friday.",
        verified: false,
      },
    ],
    system: [
      { startMs: 0, endMs: 2000, text: "Sounds good to me", verified: true },
    ],
  },
  fixes: [{ channel: "mic", startMs: 1000, from: "red", to: "ready" }],
  mustNotChange: [{ channel: "mic", startMs: 3000, span: "Friday" }],
  summary: {
    decisions: [
      { id: "d1", keywords: ["ship", "friday"], owner: null, due: null },
    ],
    actionItems: [
      {
        id: "a1",
        keywords: ["send", "invoice"],
        owner: "Ana",
        due: "next week",
      },
      { id: "a2", keywords: ["book", "room"], owner: null, due: null },
      { id: "a3", keywords: ["call", "vendor"], owner: "Bruno", due: null },
    ],
    mustNotClaim: [{ id: "c1", keywords: ["carla", "invoice"] }],
  },
  tags: {
    expected: [
      { name: "Pricing", synonyms: ["price"] },
      { name: "hiring", synonyms: [] },
      { name: "Q4  Plan" },
    ],
  },
  speakers: {
    "Them 1": "Ana",
    "Them 2": null,
    "Them 3": "Bruno",
    Me: "Marcos",
  },
};
const gold = (patch: Record<string, unknown> = {}): Gold =>
  parseGold(JSON.stringify({ ...GOLD_JSON, ...patch }), "aaaa1111");

// --- Normalizer and error rates ------------------------------------------------------

test("words: lower case, punctuation is a space", () => {
  assert.deepEqual(words("Hello, World! It's 5:20."), [
    "hello",
    "world",
    "it",
    "s",
    "5",
    "20",
  ]);
  assert.deepEqual(words("  "), []);
});

test("levenshtein: strings and token arrays", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein(["a", "b", "c"], ["a", "c"]), 1);
  assert.equal(levenshtein([], ["x", "y"]), 2);
});

test("WER and CER: pairs with known edit counts", () => {
  const cases: [string, string, number, number, number, number][] = [
    // ref, hyp, word errors, ref words, char errors, ref chars
    ["the quick brown fox", "the quack brown fox jumps", 2, 4, 7, 19],
    ["a b c d", "a c d", 1, 4, 2, 7],
    ["one two three", "one two three", 0, 3, 0, 13],
    ["one two", "", 2, 2, 7, 7],
    ["red apple", "a red apple", 1, 2, 2, 9],
    ["send the invoice", "sent invoice today", 3, 3, 10, 16],
  ];
  for (const [ref, hyp, we, wr, ce, cr] of cases) {
    const s = errorRates(words(ref), words(hyp));
    assert.equal(s.words.errors, we, `${ref} | ${hyp} word errors`);
    assert.equal(s.words.ref, wr);
    assert.equal(s.chars.errors, ce, `${ref} | ${hyp} char errors`);
    assert.equal(s.chars.ref, cr);
    // The span method gives the true character distance on these pairs.
    assert.equal(
      s.chars.errors,
      levenshtein(words(ref).join(" "), words(hyp).join(" ")),
    );
    assert.equal(s.substitutions + s.deletions + s.insertions, we);
  }
  const q = errorRates(
    words("the quick brown fox"),
    words("the quack brown fox jumps"),
  );
  assert.deepEqual([q.words.rate, q.substitutions, q.insertions], [0.5, 1, 1]);
  assert.equal(q.chars.rate, 0.3684);
  // No reference words: no rate, the insertions still count.
  const e = errorRates([], ["x", "y"]);
  assert.deepEqual([e.words.errors, e.words.rate], [2, null]);
});

test("WER verified: only errors on verified reference words", () => {
  const ref = words("the plan is ready we ship on friday");
  const flags = [true, true, true, true, false, false, false, false];
  const s = errorRates(ref, words("the plan is red we ship on monday"), flags);
  assert.deepEqual([s.words.errors, s.words.ref, s.words.rate], [2, 8, 0.25]);
  assert.deepEqual(
    [s.wordsVerified.errors, s.wordsVerified.ref, s.wordsVerified.rate],
    [1, 4, 0.25],
  );
  // "ready" -> "red" is 2 character edits; verified text "the plan is ready" has 17.
  assert.deepEqual([s.charsVerified.errors, s.charsVerified.ref], [2, 17]);
  // An insertion takes the flag of the reference word before it.
  const ins = errorRates(words("a b"), words("a x b"), [true, false]);
  assert.deepEqual([ins.wordsVerified.errors, ins.words.errors], [1, 1]);
  const ins2 = errorRates(words("a b"), words("a b x"), [true, false]);
  assert.deepEqual([ins2.wordsVerified.errors, ins2.words.errors], [0, 1]);
});

// --- Run scorecard: ASR, Enhance, fixes ---------------------------------------------------

const RAW = [
  seg("mic", 0, 0, "The plan is red.", "The plan is ready."),
  seg("mic", 1, 3000, "We ship on Friday.", "We ship on Monday."),
  seg("system", 0, 0, "Sounds good to me", null),
];

test("scorecard: meeting-level WER per channel, Enhance delta", () => {
  const sc = scoreRun(
    gold(),
    { segments: RAW, summaryJson: null, tags: [], speakers: [] },
    "hash-1",
  );
  assert.equal(sc.asrHashMatch, true);
  assert.deepEqual([sc.asr?.mic?.words.errors, sc.asr?.mic?.words.ref], [1, 8]);
  assert.equal(sc.asr?.mic?.wordsVerified.errors, 1);
  assert.deepEqual(
    [sc.asr?.system?.words.errors, sc.asr?.system?.words.ref],
    [0, 4],
  );
  assert.equal(sc.enhance.channels?.mic?.words.errors, 1);
  assert.equal(sc.enhance.channels?.mic?.wordsVerified.errors, 0);
  assert.deepEqual(sc.enhance.delta, { mic: 0, system: 0, all: 0 });
  // A new segmentation of the same text gives the same channel score.
  const resplit = [
    seg("mic", 0, 0, "The plan"),
    seg("mic", 1, 1500, "is red. We ship"),
    seg("mic", 2, 4000, "on Friday."),
    RAW[2] as SegmentRow,
  ];
  const sc2 = scoreRun(
    gold(),
    { segments: resplit, summaryJson: null, tags: [], speakers: [] },
    "other",
  );
  assert.deepEqual(sc2.asr, sc.asr);
  assert.equal(sc2.asrHashMatch, false);
  // Enhance fixes "red" and keeps "Friday": delta 1/12 > 0.
  const good = RAW.map((s, i) => (i === 1 ? { ...s, enhanced_text: null } : s));
  const sc3 = scoreRun(
    gold(),
    { segments: good, summaryJson: null, tags: [], speakers: [] },
    null,
  );
  assert.equal(sc3.enhance.channels?.mic?.words.errors, 0);
  assert.equal(sc3.enhance.delta?.all, 0.0833);
  assert.equal(sc3.asrHashMatch, null);
});

test("fixes and must-not-change: channel + start within the tolerance", () => {
  const f = scoreFixes(gold(), RAW);
  // The fix at 1000 finds the mic segment at 0 (tolerance 2000); "Friday" is lost.
  assert.deepEqual(
    [
      f.fixesFound,
      f.fixesMissed,
      f.mustNotChangeViolations,
      f.violationKeys,
      f.badEntries,
    ],
    [1, 0, 1, ["mic@3000"], 0],
  );
  const tight = scoreFixes(gold({ timeToleranceMs: 500 }), RAW);
  assert.deepEqual([tight.fixesFound, tight.badEntries], [0, 1]);
  const kept = scoreFixes(
    gold(),
    RAW.map((s) => ({ ...s, enhanced_text: null })),
  );
  assert.deepEqual(
    [kept.fixesMissed, kept.missedKeys, kept.mustNotChangeViolations],
    [1, ["mic@1000"], 0],
  );
});

// --- Summary, tags, speakers ----------------------------------------------------------

const SUMMARY = {
  overview: "A launch plan.",
  keyPoints: ["The launch is near."],
  decisions: ["We ship on Friday.", "The budget stays."],
  actionItems: [
    { task: "Send the invoice", owner: "Ana Lima", due: "next week" },
    { task: "Book a room", owner: "Bruno", due: null },
    { task: "Order lunch", owner: null, due: null },
  ],
  openQuestions: [],
};

test("summary: keyword match, owner and due, unmatched items, must-not-claim", () => {
  const s = scoreSummary(gold(), JSON.stringify(SUMMARY));
  assert.ok(s);
  assert.equal(s.parsed, true);
  assert.deepEqual(
    [
      s.decisions.matched,
      s.decisions.gold,
      s.decisions.unmatchedOutput,
      s.decisions.recall,
    ],
    [1, 1, ["decisions[1]"], 1],
  );
  assert.deepEqual(
    [
      s.actionItems.matched,
      s.actionItems.missedIds,
      s.actionItems.unmatchedOutput,
    ],
    [2, ["a3"], ["actionItems[2]"]],
  );
  assert.equal(s.actionItems.recall, 0.6667);
  assert.equal(s.actionItems.precision, 0.6667);
  // d1 null/null correct, a1 "Ana" in "Ana Lima" correct, a2 invented owner wrong.
  assert.deepEqual(s.owner, {
    correct: 2,
    wrong: 1,
    missing: 0,
    wrongIds: ["a2"],
  });
  assert.deepEqual([s.due.correct, s.due.wrong, s.due.missing], [3, 0, 0]);
  assert.deepEqual(s.mustNotClaimHits, []);
  // A wrong owner of the gold "a1" fact, and a missing due.
  const bad = structuredClone(SUMMARY);
  bad.actionItems[0] = { task: "Send the invoice", owner: "Carla", due: null };
  const b = scoreSummary(gold(), JSON.stringify(bad));
  assert.deepEqual(b?.mustNotClaimHits, ["c1"]);
  assert.deepEqual([b?.owner.wrongIds, b?.due.missing], [["a1", "a2"], 1]);
  const sc = scoreRun(
    gold(),
    { segments: RAW, summaryJson: JSON.stringify(bad), tags: [], speakers: [] },
    null,
  );
  assert.deepEqual(sc.hardFails, ["claim:c1"]);
  // An unparsable summary matches nothing.
  const none = scoreSummary(gold(), "not json");
  assert.deepEqual(
    [
      none?.parsed,
      none?.actionItems.matched,
      none?.actionItems.missedIds.length,
    ],
    [false, 0, 3],
  );
  assert.equal(scoreSummary(gold({ summary: null }), "{}"), null);
});

test('summary: a gold owner "A (B)" accepts either form (#273)', () => {
  const twoForms = (owner: string) =>
    gold({
      summary: {
        decisions: [],
        actionItems: [
          { id: "a1", keywords: ["send", "invoice"], owner, due: null },
        ],
        mustNotClaim: [],
      },
    });
  const ownerOf = (goldOwner: string, outOwner: string | null) =>
    scoreSummary(
      twoForms(goldOwner),
      JSON.stringify({
        ...SUMMARY,
        decisions: [],
        actionItems: [{ task: "Send the invoice", owner: outOwner, due: null }],
      }),
    )?.owner;
  const right = { correct: 1, wrong: 0, missing: 0, wrongIds: [] };
  const wrong = { correct: 0, wrong: 1, missing: 0, wrongIds: ["a1"] };
  // The name with a surname, the label, the whole value: the same person.
  assert.deepEqual(ownerOf("Ana (Them 2)", "Ana Lima"), right);
  assert.deepEqual(ownerOf("Ana (Them 2)", "Them 2"), right);
  assert.deepEqual(ownerOf("Ana (Them 2)", "Ana (Them 2)"), right);
  assert.deepEqual(ownerOf("Me (Marcos)", "Me"), right);
  assert.deepEqual(ownerOf("Me (Marcos)", "Marcos Vale"), right);
  // Another person or another label stays wrong.
  assert.deepEqual(ownerOf("Ana (Them 2)", "Bruno Lima"), wrong);
  assert.deepEqual(ownerOf("Ana (Them 2)", "Them 3"), wrong);
  assert.deepEqual(ownerOf("Me (Marcos)", "Them 1"), wrong);
  // A gold value with no parentheses keeps the old rule.
  assert.deepEqual(ownerOf("Ana", "Ana Lima"), right);
  assert.deepEqual(ownerOf("Ana", "Bruno"), wrong);
  assert.deepEqual(ownerOf("Ana (Them 2)", null), {
    correct: 0,
    wrong: 0,
    missing: 1,
    wrongIds: [],
  });
});

test("tags: precision and recall with synonyms and the app's normalization", () => {
  const t = scoreTags(gold(), ["price ", "q4 plan", "lunch"]);
  assert.ok(t);
  assert.deepEqual(
    [
      t.output,
      t.expected,
      t.matchedOutput,
      t.matchedExpected,
      t.precision,
      t.recall,
    ],
    [3, 3, 2, 2, 0.6667, 0.6667],
  );
  assert.deepEqual(
    [t.unmatchedOutput, t.missedExpected],
    [["tags[2]"], ["expected[1]"]],
  );
  assert.deepEqual(
    [scoreTags(gold(), [])?.precision, scoreTags(gold(), [])?.recall],
    [null, 0],
  );
});

test("speakers: correct, wrong (hard fail) and missing names", () => {
  const rows = [
    { label: "Them 1", suggested_name: "Ana Lima", suggested_kind: "name" },
    { label: "Them 2", suggested_name: "Carla", suggested_kind: "name" },
    { label: "Them 3", suggested_name: null, suggested_kind: null },
    { label: "Me", suggested_name: "Marcos", suggested_kind: null },
    { label: "Them 4", suggested_name: "Dora", suggested_kind: "name" },
  ];
  const s = scoreSpeakers(gold(), rows);
  assert.deepEqual(s, {
    correct: 2,
    wrong: 1,
    missing: 1,
    wrongLabels: ["Them 2"],
    missingLabels: ["Them 3"],
  });
  // A role is no name: Them 2 (gold null) is then correct.
  const role = scoreSpeakers(gold(), [
    { label: "Them 2", suggested_name: "the client", suggested_kind: "role" },
  ]);
  assert.equal(role?.wrong, 0);
  const sc = scoreRun(
    gold(),
    { segments: RAW, summaryJson: null, tags: [], speakers: rows },
    null,
  );
  assert.deepEqual(sc.hardFails, ["speaker:Them 2"]);
});

// --- Gold v2 loading and the v1 adapter ------------------------------------------------------

test("gold v2: validation errors name the field, never the text", () => {
  assert.throws(() => parseGold("{", "aaaa1111"), /not valid JSON/);
  assert.throws(
    () => parseGold(JSON.stringify({ ...GOLD_JSON, format: "x" }), "aaaa1111"),
    /format/,
  );
  assert.throws(
    () => parseGold(JSON.stringify(GOLD_JSON), "bbbb2222"),
    /meeting must equal/,
  );
  const badTurn = structuredClone(GOLD_JSON) as Record<string, any>;
  badTurn.transcript.mic[0].verified = "secret words";
  assert.throws(
    () => parseGold(JSON.stringify(badTurn), "aaaa1111"),
    (e: Error) =>
      /transcript\.mic\[0\]/.test(e.message) && !e.message.includes("secret"),
  );
  const badId = structuredClone(GOLD_JSON) as Record<string, any>;
  badId.summary.actionItems[0].id = "send the invoice";
  assert.throws(
    () => parseGold(JSON.stringify(badId), "aaaa1111"),
    (e: Error) =>
      /actionItems\[0\]/.test(e.message) && !e.message.includes("invoice"),
  );
  const dup = structuredClone(GOLD_JSON) as Record<string, any>;
  dup.summary.actionItems[1].id = "a1";
  assert.throws(() => parseGold(JSON.stringify(dup), "aaaa1111"), /used twice/);
  // Optional parts: absent = not scored.
  const min = parseGold(
    JSON.stringify({
      format: "openstyle-gold",
      meeting: "aaaa1111",
      goldVersion: 1,
    }),
    "aaaa1111",
  );
  assert.deepEqual(
    [min.transcript, min.summary, min.tags, min.speakers, min.timeToleranceMs],
    [null, null, null, null, 2000],
  );
});

test("gold v2: loader needs a 0700 folder and a file per meeting", () => {
  const dir = join(tmp, "gold");
  mkdirSync(dir);
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "aaaa1111.json"), JSON.stringify(GOLD_JSON));
  const golds = loadGold(["aaaa1111"], dir);
  assert.equal(golds.get("aaaa1111")?.goldVersion, 2);
  assert.deepEqual(goldInfo(golds), {
    source: "gold-v2",
    versions: { aaaa1111: 2 },
  });
  assert.throws(
    () => loadGold(["aaaa1111", "bbbb2222"], dir),
    /no gold file .* bbbb2222/,
  );
  chmodSync(dir, 0o755);
  assert.throws(() => loadGold(["aaaa1111"], dir), /mode 0700/);
  assert.throws(
    () => loadGold(["aaaa1111"], join(tmp, "none")),
    /does not exist/,
  );
});

test("gold v1 adapter: the answer key scores as before", () => {
  const key = parseAnswerKey(
    JSON.stringify({
      version: 1,
      meetings: {
        "2943c36a-full-id": {
          fixes: [
            { key: "system:0@0", from: "open style", to: "Openstyle" },
            { key: "system:1@1000", from: "cube", to: "Kube" },
            { key: "system:9@9", from: "x", to: "y" },
          ],
          mustNotChange: [
            { key: "system:1@1000", span: "twenty five" },
            { key: "system:0@0", span: "the plan" },
          ],
        },
      },
    }),
  );
  const g = goldFromAnswerKey(key).get("2943c36a") as Gold;
  assert.deepEqual(
    [g.source, g.timeToleranceMs, g.transcript, g.summary],
    ["answer-key-v1", 0, null, null],
  );
  const rows = [
    seg("system", 0, 0, "the plan for open style", "The plan for Openstyle."),
    seg("system", 1, 1000, "cube has twenty five pods", "Cube has 25 pods."),
  ];
  const s = scoreFixes(g, rows);
  assert.deepEqual(
    [
      s.fixesFound,
      s.fixesMissed,
      s.missedKeys,
      s.mustNotChangeViolations,
      s.violationKeys,
      s.badEntries,
    ],
    [1, 1, ["system@1000"], 2, ["system@1000", "system@0"], 1],
  );
  // A v1 key that is not source:idx@start_ms fails.
  const bad = parseAnswerKey(
    '{"version":1,"meetings":{"x":{"fixes":[{"key":"k","from":"","to":"y"}]}}}',
  );
  assert.throws(() => goldFromAnswerKey(bad), /source:idx@start_ms/);
});

// --- Report and baselines --------------------------------------------------------------

const NO_CHECKS = () =>
  Object.fromEntries(
    [
      "segments",
      "numbers",
      "names",
      "negations",
      "labels",
      "chunks",
      "summary",
      "speakers",
    ].map((c) => [c, { count: 0, keys: [] }]),
  ) as unknown as RunResult["checks"];

function results(
  segments: SegmentRow[],
  speakers: Parameters<typeof scoreSpeakers>[1] = [],
): Results {
  const r: RunResult = {
    model: "m1",
    meeting: "aaaa1111",
    status: "ok",
    exitCode: 0,
    seconds: 10,
    peakRssGb: 1,
    diskBytes: 1e9,
    inputTokens: 1,
    outputTokens: 1,
    chunksAttempted: 1,
    chunksFailed: 0,
    metrics: runMetrics([], [], []),
    checks: NO_CHECKS(),
    hardFails: 0,
    scorecard: scoreRun(
      gold(),
      {
        segments,
        summaryJson: JSON.stringify(SUMMARY),
        tags: ["price", "lunch"],
        speakers,
      },
      "hash-1",
    ),
  };
  r.hardFails = hardFailsOf(r);
  const res: Results = {
    createdAt: "2026-10-21T10:00:00Z",
    commit: "abc1234",
    models: ["m1"],
    meetings: [
      {
        id8: "aaaa1111",
        id: "aaaa1111-x",
        segments: segments.length,
        durationSeconds: 6,
      },
    ],
    asrHash: "hash-1",
    asrModel: "local-mlx/qwen3-1.7b-8bit",
    gold: { source: "gold-v2", versions: { aaaa1111: 2 } },
    runs: [r],
    floor: null,
  };
  res.floor = floorModel(res);
  return res;
}

test("report: the Scorecard section comes first and passes the self-check", () => {
  const res = results(RAW, [
    { label: "Them 2", suggested_name: "Carla", suggested_kind: "name" },
  ]);
  const md = renderResults(res);
  assert.deepEqual(selfCheck(md, res), []);
  const first = md.split("\n").find((l) => l.startsWith("## "));
  assert.equal(first, "## Scorecard");
  assert.ok(md.includes("| m1 | asr | 1 | WER 0.0833 (12 ref) |"));
  assert.ok(
    md.includes("| m1 | speakers | 1 | correct 0/4 | wrong 1; missing 3 | 1 |"),
  );
  assert.ok(md.includes("gold hard fails (1): speaker:Them 2"));
  // The gold hard fail counts in the run's hard fails: no floor model.
  assert.deepEqual([res.runs[0]?.hardFails, res.floor], [1, null]);
  // A changed scorecard cell fails the self-check.
  const broken = md.replace(
    "| m1 | asr | 1 | WER 0.0833",
    "| m1 | asr | 1 | WER 0.0000",
  );
  assert.ok(selfCheck(broken, res).some((e) => e.includes("scorecard table")));
  // No gold: a note, and the self-check still passes.
  const plain = {
    ...res,
    gold: null,
    runs: res.runs.map((r) => ({ ...r, scorecard: null, hardFails: 0 })),
  };
  plain.floor = floorModel(plain);
  const md2 = renderResults(plain);
  assert.ok(md2.includes("No gold key"));
  assert.deepEqual(selfCheck(md2, plain), []);
  // Text never goes into results.md.
  for (const w of [
    "plan",
    "Friday",
    "invoice",
    "Carla",
    "Ana",
    "lunch",
    "price",
  ])
    assert.ok(!md.includes(w), `results.md holds "${w}"`);
});

test("baseline: save, read back, compare with a planted regression and improvement", () => {
  const dir = join(tmp, "eval-baselines");
  const base = buildBaseline(results(RAW), "main");
  const path = saveBaseline(base, dir, new Date(2026, 9, 21, 12));
  assert.equal(path, join(dir, "2026-10-21-main.json"));
  assert.equal(
    baselinePath(dir, "x", new Date(2026, 0, 5)),
    join(dir, "2026-01-05-x.json"),
  );
  assert.throws(
    () => saveBaseline(base, dir, new Date(2026, 9, 21, 12)),
    /exists/,
  );
  assert.throws(() => buildBaseline(results(RAW), "Bad Name"), /baseline name/);
  const json = readFileSync(path, "utf8");
  const back = parseBaseline(json);
  assert.deepEqual(back, base);
  // Numbers and ids only: no gold or output text in the file.
  for (const w of [
    "plan",
    "ready",
    "friday",
    "invoice",
    "ana",
    "bruno",
    "lunch",
    "price",
    "sounds",
  ])
    assert.ok(!json.toLowerCase().includes(w), `baseline holds "${w}"`);
  assert.equal(back.runs[0]?.stages.asr.wer, 0.0833);
  assert.deepEqual(
    stageMetrics(results(RAW).runs[0]?.scorecard as never).speakers,
    {
      correct: 1,
      wrong: 0,
      missing: 3,
    },
  );

  // Same run: every metric is the same, exit 0.
  const same = compareBaselines(back, buildBaseline(results(RAW), "run"));
  assert.equal(same.exitCode, 0);
  assert.ok(same.rows.every((r) => r.verdict === "same"));
  assert.ok(same.text.includes("Result: no regression"));

  // Planted regression: a worse ASR text on mic, and a new wrong speaker name.
  const worseSegs = RAW.map((s, i) =>
    i === 1 ? { ...s, text: "We shop on Fried day.", enhanced_text: null } : s,
  );
  const worse = compareBaselines(
    back,
    buildBaseline(
      results(worseSegs, [
        { label: "Them 2", suggested_name: "Carla", suggested_kind: "name" },
      ]),
      "run",
    ),
  );
  assert.equal(worse.exitCode, 3);
  assert.ok(
    worse.rows.some(
      (r) => r.stage === "asr" && r.metric === "wer" && r.verdict === "worse",
    ),
  );
  assert.deepEqual(worse.newHardFails, ["m1 aaaa1111 speaker:Them 2"]);
  assert.ok(worse.text.includes("REGRESSION"));

  // Planted improvement: Enhance keeps "Friday" (fewer errors), no new hard fail.
  const betterSegs = RAW.map((s, i) =>
    i === 1 ? { ...s, enhanced_text: null } : s,
  );
  const better = compareBaselines(
    back,
    buildBaseline(results(betterSegs), "run"),
  );
  assert.equal(better.exitCode, 0);
  assert.ok(
    better.rows.some(
      (r) =>
        r.stage === "enhance" && r.metric === "wer" && r.verdict === "better",
    ),
  );
  assert.ok(
    better.rows.some(
      (r) =>
        r.stage === "enhance" &&
        r.metric === "mustNotChangeViolations" &&
        r.verdict === "better",
    ),
  );
  assert.ok(!better.rows.some((r) => r.verdict === "worse"));

  // A noise band from two runs hides a move inside it.
  const now = buildBaseline(results(worseSegs), "run");
  const bands = noiseBands(back, now);
  assert.equal(bands["asr.wer"], 0.25);
  const wide = parseBaseline(JSON.stringify({ ...back, noise: bands }));
  const quiet = compareBaselines(wide, now);
  assert.ok(
    quiet.rows
      .filter((r) => r.stage === "asr")
      .every((r) => r.verdict === "same"),
  );
  // A metric that is gone now counts as worse.
  const gone = buildBaseline(results(RAW), "run");
  delete (gone.runs[0] as { stages: Record<string, Record<string, unknown>> })
    .stages.tags?.recall;
  assert.equal(compareBaselines(back, gone).exitCode, 3);
  // A string where a number must be fails the parse.
  const textInside = JSON.parse(json);
  textInside.runs[0].stages.asr.wer = "the plan";
  assert.throws(
    () => parseBaseline(JSON.stringify(textInside)),
    /must be a number/,
  );
});
