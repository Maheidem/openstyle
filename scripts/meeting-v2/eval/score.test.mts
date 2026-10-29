// Unit tests of the gold key v2 (gold.mts), the scorers (score.mts), the
// baselines (baseline.mts) and the report scorecard (report.mts).
// Run: pnpm meeting:eval:test (node --test). Fictional text only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  legacyRawKeys,
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
  type Channel,
  type Gold,
  type GoldSpan,
  goldFromAnswerKey,
  goldInfo,
  loadGold,
  parseGold,
} from "./gold.mts";
import {
  floorModel,
  hardFailsOf,
  pooledSpans,
  type Results,
  type RunResult,
  renderResults,
  selfCheck,
} from "./report.mts";
import {
  errorRates,
  normalizeWords,
  scoreChannel,
  scoreFixes,
  scoreRun,
  scoreSpans,
  scoreSpeakers,
  scoreSummary,
  scoreTags,
  scoreWords,
  spanHits,
  spanWords,
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

test("normalizeWords: number words are digits (English and Portuguese)", () => {
  const n = (t: string) => normalizeWords(scoreWords(t)).words.join(" ");
  assert.equal(n("we need five rooms"), "we need 5 rooms");
  assert.equal(n("twenty one days"), "21 days");
  assert.equal(n("twenty-one days"), "21 days");
  assert.equal(n("one hundred and five boxes"), "105 boxes");
  assert.equal(n("two thousand twenty six"), "2026");
  assert.equal(n("a thousand cups"), "a 1000 cups");
  assert.equal(n("three million"), "3000000");
  assert.equal(n("eleven or zero"), "11 or 0");
  assert.equal(n("vinte e um dias"), "21 dias");
  assert.equal(n("cento e vinte e três"), "123");
  assert.equal(n("mil e duzentos reais"), "1200 reais");
  assert.equal(n("dois mil e vinte e seis"), "2026");
  assert.equal(n("duas salas e três mesas"), "2 salas e 3 mesas");
  assert.equal(n("dezesseis"), "16");
  // Digits stay; a thousands separator goes.
  assert.equal(n("1,000 or 1.000 units"), "1000 or 1000 units");
  assert.equal(n("version 3.14159"), "version 3 14159");
  // Two numbers side by side do not join.
  assert.equal(n("five six seven"), "5 6 7");
  assert.equal(n("twenty thirty"), "20 30");
  assert.equal(n("zero zero seven"), "0 7");
});

test("normalizeWords: an exact adjacent repeat counts once; flags follow", () => {
  const n = (t: string) => normalizeWords(words(t)).words.join(" ");
  assert.equal(n("the the plan is is ready"), "the plan is ready");
  assert.equal(n("I I I think so"), "i think so");
  // Not adjacent, or not exact: kept.
  assert.equal(n("the plan the plan"), "the plan the plan");
  assert.equal(n("go going"), "go going");
  // A repeat made by the number rule ("five 5") also counts once.
  assert.equal(n("five 5 cars"), "5 cars");
  const f = normalizeWords(
    ["the", "the", "twenty", "one", "cats"],
    [true, false, true, false, true],
  );
  assert.deepEqual(f.words, ["the", "21", "cats"]);
  assert.deepEqual(f.flags, [true, false, true]);
});

test("scoreWords: an exact repeated token goes, contractions too (owner rule 2026-10-26)", () => {
  const n = (t: string) => normalizeWords(scoreWords(t)).words.join(" ");
  assert.equal(n("I'm I'm good"), "i m good");
  assert.equal(n("we'll, we'll talk"), "we ll talk");
  assert.equal(n("the The step"), "the step");
  // A different token, or a repeat that is not next to it: kept.
  assert.equal(n("I'm I am"), "i m i am");
  assert.equal(n("it is it"), "it is it");
});

test("WER: normalized vs raw on number words and stutter repeats", () => {
  const g = parseGold(
    JSON.stringify({
      ...GOLD_JSON,
      transcript: {
        mic: [
          {
            startMs: 0,
            endMs: 3000,
            text: "We need twenty one chairs, the the big ones.",
            verified: true,
          },
        ],
      },
    }),
    "aaaa1111",
  );
  const rows = [seg("mic", 0, 0, "We need 21 chairs the big ones")];
  const s = scoreChannel(g, "mic", rows, "asr");
  // Raw: "twenty one" vs "21" is 1 substitution + 1 deletion; "the the" vs
  // "the" is 1 deletion. Normalized: no error.
  assert.deepEqual([s?.wordsRaw.errors, s?.wordsRaw.ref], [3, 9]);
  assert.deepEqual([s?.words.errors, s?.words.ref], [0, 7]);
  assert.equal(s?.wordsVerified.errors, 0);
  assert.equal(s?.wordsVerifiedRaw.errors, 3);
  // A real error still counts in both.
  const bad = scoreChannel(
    g,
    "mic",
    [seg("mic", 0, 0, "We need 22 chairs the big ones")],
    "asr",
  );
  assert.equal(bad?.words.errors, 1);
});

test("baseline: compare warns when the gold kind or the gold hash differs", () => {
  const withGold = (gold: Results["gold"]) =>
    buildBaseline({ ...results(RAW), gold }, "run");
  const v2 = { source: "gold-v2" as const, versions: { aaaa1111: 2 } };
  const now = withGold({
    ...v2,
    goldKinds: ["none"],
    goldHash: "aaaaaaaaaaaa",
  });
  assert.deepEqual(compareBaselines(now, now).warnings, []);
  // An old baseline has neither field: both are unknown.
  const old = compareBaselines(withGold(v2), now);
  assert.deepEqual(old.warnings, [
    "WARN: the gold kind differs (baseline unknown, now none). Do not compare scores across gold kinds.",
    "WARN: the gold hash differs (baseline unknown, now aaaaaaaaaaaa). The gold keys are not the same.",
  ]);
  assert.ok(old.text.includes(old.warnings[0] as string));
  // The warning does not change the exit code.
  assert.equal(old.exitCode, 0);
  const silver = withGold({
    ...v2,
    goldKinds: ["silver-3.3"],
    goldHash: "bbbbbbbbbbbb",
  });
  assert.deepEqual(compareBaselines(now, silver).warnings, [
    "WARN: the gold kind differs (baseline none, now silver-3.3). Do not compare scores across gold kinds.",
    "WARN: the gold hash differs (baseline aaaaaaaaaaaa, now bbbbbbbbbbbb). The gold keys are not the same.",
  ]);
});

test("report: the gold line of an old key has no kind", () => {
  const md = renderResults({
    ...results(RAW),
    gold: {
      source: "gold-v2",
      versions: { aaaa1111: 2 },
      goldKinds: ["none"],
      goldHash: "aaaaaaaaaaaa",
    },
  });
  assert.ok(md.includes("- Gold: gold-v2 (aaaa1111 v2)\n"));
  // No spans: no empty line before the next section.
  assert.ok(!md.includes("\n\n\n"));
});

test("baseline: a legacy baseline compares its WER as the raw WER", () => {
  assert.deepEqual(
    legacyRawKeys({
      wer: 0.2,
      "wer.mic": 0.3,
      werVerified: 0.1,
      delta: -0.01,
      cer: 0.1,
    }),
    {
      werRaw: 0.2,
      "werRaw.mic": 0.3,
      werVerifiedRaw: 0.1,
      deltaRaw: -0.01,
      cer: 0.1,
    },
  );
  const now = { wer: 0.1, werRaw: 0.2 };
  assert.equal(legacyRawKeys(now), now);
});

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
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  assert.deepEqual(goldInfo(golds), {
    source: "gold-v2",
    versions: { aaaa1111: 2 },
    goldKinds: ["none"],
    goldHash: sha(`aaaa1111 ${sha(JSON.stringify(GOLD_JSON))}`).slice(0, 12),
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

// --- Silver keys: spans and the eligible WER -------------------------------------------

/** A fictional silver key: two people talk about the Zorblax tool. */
const SILVER_JSON = {
  format: "openstyle-gold",
  meeting: "cccc3333",
  goldVersion: 3,
  goldKind: "silver-2",
  asrHash: "hash-s",
  builtAt: "2026-10-28T10:00:00Z",
  verifiedSpans: 0,
  timeToleranceMs: 2000,
  transcript: {
    mic: [
      {
        startMs: 0,
        endMs: 4000,
        text: "We tried Zorblax yesterday.",
        verified: false,
        basis: ["h1", "h2"],
        wer_eligible: true,
      },
      {
        startMs: 4000,
        endMs: 8000,
        text: "It was fine I guess.",
        verified: false,
        basis: ["h1"],
        wer_eligible: false,
      },
    ],
    system: [
      {
        startMs: 10000,
        endMs: 12000,
        text: "Ask Quillon about twenty one seats.",
        verified: false,
        basis: ["h1", "h2", "h3"],
        wer_eligible: true,
      },
    ],
  },
  fixes: [],
  mustNotChange: [],
  witnesses: { h1: "engine one", h2: "engine two" },
  verification: { verifier: "blind", chunks: 3 },
  spans: [
    {
      channel: "mic",
      startMs: 1000,
      endMs: 2000,
      text: "Zorblax",
      label: "product",
      in_vocab: true,
      confidence: "high",
      witnesses: ["h1", "h2"],
    },
    {
      channel: "system",
      startMs: 10000,
      endMs: 11000,
      text: "Quillon",
      label: "person",
      in_vocab: false,
      confidence: "medium",
      witnesses: ["h1"],
      verifier_conflict: true,
    },
    {
      channel: "system",
      startMs: 11000,
      endMs: 12000,
      text: "twenty-one seats",
      label: "other",
      in_vocab: false,
      confidence: "high",
      witnesses: ["h2"],
    },
    {
      channel: "mic",
      startMs: 5000,
      endMs: 6000,
      text: "Mumblecore",
      label: "org",
      in_vocab: false,
      confidence: "unsure",
      witnesses: [],
    },
  ],
};
const silver = (patch: Record<string, unknown> = {}): Gold =>
  parseGold(JSON.stringify({ ...SILVER_JSON, ...patch }), "cccc3333");

const segE = (
  source: "mic" | "system",
  idx: number,
  start: number,
  end: number,
  text: string,
  enhanced: string | null = null,
): SegmentRow => ({ ...seg(source, idx, start, text, enhanced), end_ms: end });

test("silver key: loads spans, basis, wer_eligible, witnesses and verification", () => {
  const g = silver();
  assert.deepEqual([g.goldVersion, g.goldKind], [3, "silver-2"]);
  assert.equal(g.spans?.length, 4);
  assert.deepEqual(g.spans?.[1], {
    channel: "system",
    startMs: 10000,
    endMs: 11000,
    text: "Quillon",
    label: "person",
    inVocab: false,
    confidence: "medium",
    witnesses: ["h1"],
    verifierConflict: true,
    verified: false,
    verifiedSource: null,
    verifiedText: null,
    verifiedUnsure: false,
  });
  assert.equal(g.spans?.[0]?.verifierConflict, false);
  assert.deepEqual(
    g.transcript?.mic.map((t) => t.werEligible),
    [true, false],
  );
  // Old keys load as before: no spans, no werEligible field.
  const old = gold();
  assert.equal(old.spans, null);
  assert.deepEqual([old.goldVersion, old.goldKind], [2, null]);
  assert.ok(!("werEligible" in (old.transcript?.mic[0] ?? {})));
});

test("silver key: strict span validation, errors never hold the text", () => {
  const bad = (f: (j: Record<string, any>) => void, re: RegExp) => {
    const j = structuredClone(SILVER_JSON) as Record<string, any>;
    f(j);
    assert.throws(
      () => parseGold(JSON.stringify(j), "cccc3333"),
      (e: Error) =>
        re.test(e.message) &&
        !e.message.includes("Zorblax") &&
        !e.message.includes("Quillon"),
    );
  };
  bad((j) => (j.goldVersion = "silver-2"), /goldVersion must be an integer/);
  bad((j) => (j.goldKind = "silver 2 Zorblax"), /goldKind/);
  bad((j) => (j.spans[0].label = "Zorblax"), /spans\[0\].*label/);
  bad((j) => (j.spans[0].confidence = "low"), /spans\[0\].*confidence/);
  bad((j) => delete j.spans[0].in_vocab, /spans\[0\].*in_vocab/);
  bad((j) => (j.spans[1].witnesses = "h1"), /spans\[1\].*witnesses/);
  bad((j) => (j.spans[1].verifier_conflict = false), /verifier_conflict/);
  bad((j) => (j.spans[0].endMs = 500), /spans\[0\].*startMs <= endMs/);
  bad((j) => (j.spans[0].channel = "room"), /spans\[0\].*channel/);
  bad((j) => (j.spans[0].text = " "), /spans\[0\].*text/);
  bad((j) => (j.spans = { a: 1 }), /spans must be an array/);
  bad((j) => (j.witnesses = ["h1"]), /witnesses must be an object/);
  bad((j) => (j.verification = "ok"), /verification must be an object/);
  bad(
    (j) => (j.transcript.mic[0].wer_eligible = "yes"),
    /transcript\.mic\[0\].*wer_eligible/,
  );
  bad((j) => (j.transcript.mic[0].basis = [1]), /transcript\.mic\[0\].*basis/);
});

test("silver key: the loader reads it from a 0700 folder; goldInfo keeps the version", () => {
  const dir = join(tmp, "gold-silver");
  mkdirSync(dir);
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "cccc3333.json"), JSON.stringify(SILVER_JSON));
  writeFileSync(join(dir, "aaaa1111.json"), JSON.stringify(GOLD_JSON));
  const golds = loadGold(["cccc3333", "aaaa1111"], dir);
  const info = goldInfo(golds);
  assert.deepEqual(info?.versions, {
    aaaa1111: 2,
    cccc3333: 3,
  });
  assert.deepEqual(info?.goldKinds, ["none", "silver-2"]);
  assert.match(info?.goldHash ?? "", /^[0-9a-f]{12}$/);
  // Another key file gives another hash; a v1 answer key has no hash.
  writeFileSync(
    join(dir, "cccc3333.json"),
    JSON.stringify({ ...SILVER_JSON, goldKind: "silver-3.3" }),
  );
  const info2 = goldInfo(loadGold(["cccc3333", "aaaa1111"], dir));
  assert.deepEqual(info2?.goldKinds, ["none", "silver-3.3"]);
  assert.notEqual(info2?.goldHash, info?.goldHash);
  const v1 = goldFromAnswerKey(
    parseAnswerKey(JSON.stringify({ version: 1, meetings: {} })),
  );
  v1.set("dddd4444", { ...gold(), source: "answer-key-v1" });
  assert.equal(goldInfo(v1)?.goldHash, null);
});

test("scoreSpans: hit, miss, normalization, unsure skipped, groups", () => {
  const g = silver();
  const rows = [
    segE("mic", 0, 0, 4000, "We tried zorblax, yesterday."),
    segE("system", 0, 10000, 12000, "Ask Quilan about 21 seats."),
  ];
  const s = scoreSpans(g.spans ?? [], rows, "asr");
  // Zorblax: hit (case and punctuation do not count). Quillon: miss (other
  // letters). "twenty-one seats": hit ("21 seats" after normalization).
  assert.deepEqual([s.all.hits, s.all.n, s.all.rate], [2, 3, 0.6667]);
  assert.deepEqual([s.high.hits, s.high.n], [2, 2]);
  assert.deepEqual(
    [s.byLabel.term, s.byLabel.person, s.byLabel.other].map((c) => [
      c.hits,
      c.n,
    ]),
    [
      [1, 1],
      [0, 1],
      [1, 1],
    ],
  );
  assert.deepEqual([s.byVocab.inVocab.hits, s.byVocab.inVocab.n], [1, 1]);
  assert.deepEqual([s.byVocab.notInVocab.hits, s.byVocab.notInVocab.n], [1, 2]);
  assert.equal(s.unsure, 1);
  assert.equal(s.empty, 0);
  assert.deepEqual(s.missedKeys, ["system@10000:person"]);
  // Enhance reads the enhanced text: a fix of the person name is a hit.
  const enh = [
    rows[0] as SegmentRow,
    segE(
      "system",
      0,
      10000,
      12000,
      "Ask Quilan about 21 seats.",
      "Ask Quillon about 21 seats.",
    ),
  ];
  const e = scoreSpans(g.spans ?? [], enh, "enhance");
  assert.deepEqual([e.all.hits, e.all.n, e.missedKeys], [3, 3, []]);
  // The asr stage of the same rows still reads the raw text.
  assert.equal(scoreSpans(g.spans ?? [], enh, "asr").all.hits, 2);
});

test("scoreSpans: the time window edge, the channel and segments joined", () => {
  const span = (
    startMs: number,
    endMs: number,
    text = "Zorblax tool",
  ): GoldSpan => ({
    channel: "mic",
    startMs,
    endMs,
    text,
    label: "term",
    inVocab: false,
    confidence: "high",
    witnesses: [],
    verifierConflict: false,
    verified: false,
    verifiedSource: null,
    verifiedText: null,
    verifiedUnsure: false,
  });
  const hit = (rows: SegmentRow[], sp = span(10000, 11000)) =>
    scoreSpans([sp], rows, "asr").all.hits;
  // Window = [7000, 14000] at the default tolerance of 3000 ms.
  assert.equal(hit([segE("mic", 0, 5000, 7000, "the zorblax tool")]), 1);
  assert.equal(hit([segE("mic", 0, 5000, 6999, "the zorblax tool")]), 0);
  assert.equal(hit([segE("mic", 0, 14000, 15000, "zorblax tool")]), 1);
  assert.equal(hit([segE("mic", 0, 14001, 15000, "zorblax tool")]), 0);
  // A smaller tolerance moves the edge.
  assert.equal(
    scoreSpans(
      [span(10000, 11000)],
      [segE("mic", 0, 5000, 7000, "zorblax tool")],
      "asr",
      2000,
    ).all.hits,
    0,
  );
  // The other channel at the same time does not count.
  assert.equal(hit([segE("system", 0, 10000, 11000, "zorblax tool")]), 0);
  // A span across two segments in the window is a hit (time order).
  assert.equal(
    hit([
      segE("mic", 1, 10500, 12000, "tool today"),
      segE("mic", 0, 9000, 10500, "the zorblax"),
    ]),
    1,
  );
  // Words in another order are a miss.
  assert.equal(hit([segE("mic", 0, 10000, 11000, "tool zorblax")]), 0);
  // A segment without end_ms is a point at start_ms.
  assert.equal(hit([seg("mic", 0, 6000, "zorblax tool")]), 0);
  assert.equal(hit([seg("mic", 0, 7000, "zorblax tool")]), 1);
  // A span with no words after normalization is counted as empty.
  const empty = scoreSpans([span(10000, 11000, "...")], [], "asr");
  assert.deepEqual([empty.all.n, empty.empty, empty.all.rate], [0, 1, null]);
});

const termSpan = (startMs: number, endMs: number, text: string): GoldSpan => ({
  channel: "mic",
  startMs,
  endMs,
  text,
  label: "term",
  inVocab: false,
  confidence: "high",
  witnesses: [],
  verifierConflict: false,
  verified: false,
  verifiedSource: null,
  verifiedText: null,
  verifiedUnsure: false,
});

test("scoreSpans: accents fold and a match without spaces, as the vote", () => {
  const hit = (span: string, out: string) =>
    scoreSpans(
      [termSpan(10000, 11000, span)],
      [segE("mic", 0, 10000, 11000, out)],
      "asr",
    ).all.hits;
  assert.equal(hit("José", "ask jose now"), 1);
  assert.equal(hit("jose", "ask José now"), 1);
  assert.equal(hit("Open Style", "we use openstyle now"), 1);
  assert.equal(hit("openstyle", "we use Open Style now"), 1);
  assert.equal(hit("Quillon", "ask Quill on now"), 1);
  // The match starts and ends at word edges: a part of a word is a miss.
  assert.equal(hit("Zor", "the zorblax tool"), 0);
  assert.equal(hit("blax", "the zorblax tool"), 0);
  assert.equal(hit("Zorblax", "the zorblaxes tool"), 0);
  assert.equal(hit("Zorblax", "the zor blaxes tool"), 0);
  // spanWords folds; the WER words do not change.
  assert.deepEqual(spanWords("José Zorblax"), ["jose", "zorblax"]);
  assert.deepEqual(words("José"), ["josé"]);
});

test("scoreSpans: one output occurrence counts for one span; missed keys once", () => {
  const two = [
    termSpan(10000, 11000, "Zorblax"),
    termSpan(12000, 13000, "Zorblax"),
  ];
  const one = scoreSpans(two, [segE("mic", 0, 11000, 12000, "zorblax")], "asr");
  assert.deepEqual([one.all.hits, one.all.n], [1, 2]);
  assert.deepEqual(one.missedKeys, ["mic@12000:term"]);
  const both = scoreSpans(
    two,
    [segE("mic", 0, 11000, 12000, "zorblax and zorblax")],
    "asr",
  );
  assert.equal(both.all.hits, 2);
  // "Open Style" and "openstyle" share the one output word.
  const forms = scoreSpans(
    [termSpan(10000, 11000, "Open Style"), termSpan(10000, 11000, "openstyle")],
    [segE("mic", 0, 10000, 11000, "openstyle")],
    "asr",
  );
  assert.equal(forms.all.hits, 1);
  // The order never loses a hit: the first span takes the early word, so the
  // second span (which sees only the late word) still has one.
  assert.deepEqual(
    spanHits(
      [
        { channel: "mic", startMs: 10000, endMs: 11000, words: ["zorblax"] },
        { channel: "mic", startMs: 15000, endMs: 16000, words: ["zorblax"] },
      ],
      [
        { source: "mic", start: 7000, end: 8000, words: ["zorblax"] },
        { source: "mic", start: 12500, end: 13500, words: ["zorblax"] },
      ],
    ),
    [true, true],
  );
  // Two missed spans with the same key give the key once.
  const missed = scoreSpans(
    [termSpan(10000, 11000, "Zorblax"), termSpan(10000, 11000, "Zorblax")],
    [],
    "asr",
  );
  assert.deepEqual([missed.all.n, missed.missedKeys], [2, ["mic@10000:term"]]);
});

test("span match parity: scoreSpans and score_silver.py (span_match.py) give the same hits", () => {
  type Case = {
    tol: number;
    spans: [Channel, number, number, string][];
    segs: [Channel, number, number, string][];
  };
  const cases: Case[] = [
    {
      tol: 3000,
      spans: [["mic", 10000, 11000, "José"]],
      segs: [["mic", 10000, 11000, "ask jose now"]],
    },
    {
      tol: 3000,
      spans: [["mic", 10000, 11000, "Open Style"]],
      segs: [["mic", 10000, 11000, "openstyle"]],
    },
    {
      tol: 3000,
      spans: [["mic", 10000, 11000, "openstyle"]],
      segs: [["mic", 10000, 11000, "open style"]],
    },
    {
      tol: 3000,
      spans: [["mic", 10000, 11000, "Zor"]],
      segs: [["mic", 10000, 11000, "zorblax"]],
    },
    {
      tol: 3000,
      spans: [
        ["mic", 10000, 11000, "Zorblax"],
        ["mic", 12000, 13000, "Zorblax"],
        ["system", 12000, 13000, "Quillon"],
      ],
      segs: [
        ["mic", 11000, 12000, "zorblax"],
        ["system", 9000, 10000, "Quill"],
        ["system", 10000, 11000, "on twenty one"],
      ],
    },
    {
      tol: 3000,
      spans: [
        ["mic", 15000, 16000, "Zorblax"],
        ["mic", 10000, 11000, "Zorblax"],
        ["mic", 10500, 11000, "21 seats"],
      ],
      segs: [
        ["mic", 12500, 13500, "zorblax twenty one seats"],
        ["mic", 7000, 8000, "Zorblax"],
      ],
    },
    {
      tol: 1000,
      spans: [["mic", 10000, 11000, "Zorblax"]],
      segs: [["mic", 5000, 8999, "zorblax"]],
    },
  ];
  const norm = (t: string) => normalizeWords(scoreWords(t)).words.join(" ");
  const ts = cases.map((c) => {
    const spans = c.spans.map(([ch, s, e, t]) => ({
      ...termSpan(s, e, t),
      channel: ch,
    }));
    const rows = c.segs.map(([ch, s, e, t], i) => segE(ch, i, s, e, t));
    // Each span alone in the missed keys: the start times differ per channel.
    const r = scoreSpans(spans, rows, "asr", c.tol);
    return spans.map(
      (sp) => !r.missedKeys.includes(`${sp.channel}@${sp.startMs}:term`),
    );
  });
  const py = spawnSync(
    "python3",
    ["-I", join(import.meta.dirname, "silver", "score", "span_match.py")],
    {
      input: JSON.stringify({
        cases: cases.map((c) => ({
          tol: c.tol,
          spans: c.spans.map(([channel, startMs, endMs, t]) => ({
            channel,
            startMs,
            endMs,
            norm: norm(t),
          })),
          segs: c.segs.map(([channel, start, end, t]) => ({
            channel,
            start,
            end,
            norm: norm(t),
          })),
        })),
      }),
      encoding: "utf8",
    },
  );
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout).hits, ts);
  // The cases cover hits and misses.
  assert.deepEqual(ts, [
    [true],
    [true],
    [true],
    [false],
    [true, false, true],
    [true, true, true],
    [false],
  ]);
});

test("eligible WER: only errors on eligible turns; old keys have none", () => {
  const g = silver();
  // Errors: one in the eligible mic turn (yesterday -> today), one in the
  // ineligible turn (guess -> gas), one inserted word in it.
  const rows = [
    segE("mic", 0, 0, 4000, "We tried Zorblax today."),
    segE("mic", 1, 4000, 8000, "It was fine fine okay I gas."),
    segE("system", 0, 10000, 12000, "Ask Quillon about 21 seats."),
  ];
  const mic = scoreChannel(g, "mic", rows, "asr");
  assert.deepEqual(
    [mic?.words.errors, mic?.words.ref],
    [3, 9],
    "all-turn WER stays as before",
  );
  assert.deepEqual(
    [mic?.wordsEligible?.errors, mic?.wordsEligible?.ref],
    [1, 4],
  );
  const sc = scoreRun(
    g,
    { segments: rows, summaryJson: null, tags: [], speakers: [] },
    "hash-s",
  );
  const m = stageMetrics(sc);
  // Pooled eligible: 1 error over 4 + 5 eligible words ("21" is one word).
  assert.equal(m.asr.werEligible, 0.1111);
  assert.equal(m.asr["werEligible.system"], 0);
  assert.equal(m.asr.spanAcc, 1);
  assert.ok("spanAccNotInVocab" in m.enhance);
  // A v2 key: no eligible WER and no span metrics.
  const old = stageMetrics(
    scoreRun(
      gold(),
      { segments: RAW, summaryJson: null, tags: [], speakers: [] },
      "hash-1",
    ),
  );
  assert.ok(!("werEligible" in old.asr));
  assert.ok(!("spanAcc" in old.asr));
  assert.equal(
    scoreChannel(gold(), "mic", RAW, "asr")?.wordsEligible,
    undefined,
  );
});

test("report: the Spans section, numbers only, passes the self-check", () => {
  const rows = [
    segE("mic", 0, 0, 4000, "We tried zorblax yesterday."),
    segE("mic", 1, 4000, 8000, "It was fine I guess."),
    segE(
      "system",
      0,
      10000,
      12000,
      "Ask Quilan about 21 seats.",
      "Ask Quillon about 21 seats.",
    ),
  ];
  const r: RunResult = {
    model: "m1",
    meeting: "cccc3333",
    status: "ok",
    exitCode: 0,
    seconds: 1,
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
      silver(),
      { segments: rows, summaryJson: null, tags: [], speakers: [] },
      "hash-s",
    ),
  };
  const res: Results = {
    createdAt: "2026-10-28T10:00:00Z",
    commit: "abc1234",
    models: ["m1"],
    meetings: [
      { id8: "cccc3333", id: "cccc3333-x", segments: 3, durationSeconds: 12 },
    ],
    asrHash: "hash-s",
    asrModel: "local-mlx/qwen3-1.7b-8bit",
    gold: { source: "gold-v2", versions: { cccc3333: 3 } },
    runs: [r],
    floor: null,
  };
  res.floor = floorModel(res);
  res.spans = pooledSpans(res.runs);
  const md = renderResults(res);
  assert.deepEqual(selfCheck(md, res), []);
  assert.ok(md.includes("cccc3333 v3"));
  assert.ok(
    md.includes(
      "| m1 | pooled | asr | 66.7 (2/3) | 100.0 (2/2) | 100.0 (1/1) | 0.0 (0/1) | 100.0 (1/1) | 100.0 (1/1) | 50.0 (1/2) | 1 | 0 |",
    ),
  );
  assert.ok(md.includes("| m1 | cccc3333 | enhance | 100.0 (3/3) |"));
  assert.ok(md.includes("- m1 cccc3333 asr (1): system@10000:person"));
  assert.ok(md.includes("- m1 cccc3333 enhance (0): none"));
  assert.ok(md.includes("WER eligible 0.0000 (9 ref) (1 of 1 meetings)"));
  // The eligible WER names the meetings it covers: a v2 key has none.
  const mixed = results(RAW);
  mixed.runs.push(r);
  mixed.meetings.push(res.meetings[0] as Results["meetings"][number]);
  assert.ok(
    renderResults(mixed).includes(
      "WER eligible 0.0000 (9 ref) (1 of 2 meetings)",
    ),
  );
  // The gold line shows the kind and the hash of a silver key.
  const kinded = {
    ...res,
    gold: { ...res.gold, goldKinds: ["silver-2"], goldHash: "0123456789ab" },
  } as Results;
  assert.ok(
    renderResults(kinded).includes(
      "- Gold: gold-v2 (cccc3333 v3); kind silver-2, hash 0123456789ab",
    ),
  );
  // A changed cell or changed pooled JSON fails the self-check.
  assert.ok(
    selfCheck(md.replace("66.7 (2/3)", "70.0 (2/3)"), res).some((e) =>
      e.includes("spans table"),
    ),
  );
  const tampered = structuredClone(res);
  const pooledM1 = tampered.spans?.m1;
  assert.ok(pooledM1);
  pooledM1.asr.all.hits = 3;
  assert.ok(selfCheck(md, tampered).some((e) => e.includes("fresh pooling")));
  // Span and turn text never goes into results.md.
  for (const w of [
    "Zorblax",
    "zorblax",
    "Quillon",
    "Quill",
    "Mumblecore",
    "seats",
  ])
    assert.ok(!md.includes(w), `results.md holds "${w}"`);
});
