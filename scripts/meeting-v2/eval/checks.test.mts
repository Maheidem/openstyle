// Unit tests of the meeting:eval hard-fail checks and the report self-check.
// Run: pnpm meeting:eval:test (node --test). Fictional text only.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attendeeNames,
  checkChunks,
  checkLabels,
  checkNames,
  checkNegations,
  checkNumbers,
  checkSegments,
  checkSpeakerNames,
  checkSummary,
  knownForms,
  metadataNames,
  numberValues,
  parseAnswerKey,
  runMetrics,
  type SegmentRow,
} from "./checks.mts";
import {
  floorModel,
  hardFailsOf,
  type Results,
  type RunResult,
  renderResults,
  selfCheck,
} from "./report.mts";

const seg = (
  idx: number,
  text: string,
  enhanced: string | null,
  start = idx * 1000,
): SegmentRow => ({
  id: `id${idx}`,
  source: "system",
  idx,
  start_ms: start,
  text,
  enhanced_text: enhanced,
});

test("segments: lost, added, moved and raw text changed", () => {
  const raw = [seg(0, "a", null), seg(1, "b", null), seg(2, "c", null)];
  assert.equal(checkSegments(raw, raw).count, 0);
  const lost = checkSegments(raw, raw.slice(0, 2));
  assert.deepEqual([lost.lost, lost.keys], [1, ["system:2@2000"]]);
  const added = checkSegments(raw, [...raw, seg(3, "d", null)]);
  assert.deepEqual([added.added, added.keys], [1, ["system:3@3000"]]);
  const moved = checkSegments(raw, [
    raw[0],
    { ...(raw[1] as SegmentRow), idx: 5 },
    raw[2],
  ] as SegmentRow[]);
  assert.equal(moved.moved, 1);
  assert.equal(moved.lost, 1);
  assert.equal(moved.added, 1);
  const edited = checkSegments(raw, [
    raw[0],
    { ...(raw[1] as SegmentRow), text: "x" },
    raw[2],
  ] as SegmentRow[]);
  assert.deepEqual([edited.textChanged, edited.keys], [1, ["system:1@1000"]]);
});

test("numbers: digits, number words and times", () => {
  assert.deepEqual(numberValues("we start at 5:20 with 1,000 users"), [
    "5",
    "20",
    "1000",
  ]);
  assert.deepEqual(numberValues("twenty five people"), ["25"]);
  assert.deepEqual(numberValues("at five twenty"), ["5", "20"]);
  assert.deepEqual(
    numberValues("one hundred and five, two thousand twenty six"),
    ["105", "2026"],
  );
  assert.deepEqual(numberValues("and then nothing"), []);
  const rows = [
    seg(0, "meet at five twenty", "Meet at 5:20."), // same values: pass
    seg(1, "we need twenty five", "We need 25."), // same value: pass
    seg(2, "budget is 30 dollars", "Budget is 40 dollars."), // changed
    seg(3, "wait 10 minutes", "Wait minutes."), // lost
    seg(4, "the plan works", "The plan works for 2 people."), // added
    seg(5, "budget is 30 dollars", null), // not enhanced: not checked
  ];
  assert.deepEqual(checkNumbers(rows).keys, [
    "system:2@2000",
    "system:3@3000",
    "system:4@4000",
  ]);
});

test("names: removed, lowercased and changed fail; spelling fixes pass", () => {
  const names = metadataNames(["Weekly sync", "Alice Moreau, Bob Tanaka"]);
  assert.ok(names.has("alice") && names.has("tanaka"));
  const rows = [
    seg(0, "then Alyce said it works", "Then Alice said it works."), // fix to a metadata name
    seg(1, "we use Tablo for charts", "We use Tableau for charts."), // small edit distance
    seg(2, "ask Bob about it", "Ask about it."), // removed
    seg(3, "the Tableau report", "The tableau report."), // lowercased
    seg(4, "send it to Carol today", "Send it to Dave today."), // changed
    seg(5, "so alice will check", "So Alice will check."), // metadata name in lower case: kept
    seg(6, "Okay. Then I will go", "Okay, then I will go."), // sentence start and "I": no names
    seg(7, "open Open Style now", "Open OpenStyle now."), // join
  ];
  assert.deepEqual(checkNames(rows, names).keys, [
    "system:2@2000",
    "system:3@3000",
    "system:4@4000",
  ]);
});

test("names: case, spacing, punctuation and known-form fixes pass", () => {
  const names = metadataNames(["Weekly sync", "Alice Moreau"]);
  const known = knownForms(
    ["the gizmos are back", "we tried ZapQuery last week"],
    ["Fluxbase", "Night Owl"],
  );
  const rows = [
    seg(0, "we run it on FluxBase now", "We run it on Fluxbase now."), // case only
    seg(1, "data from Zap Query today", "Data from ZapQuery today."), // join, known
    seg(2, "data from Zip Query today", "Data from ZapQuery today."), // join + spelling, known
    seg(3, "the Gias were down", "The Gizmos were down."), // distance 3, known form
    seg(4, "move to Falkor-DB soon", "Move to FalkorDB soon."), // punctuation inside
    seg(5, "use Nite Owl for that", "Use NightOwl for that."), // vocabulary term joined
    seg(6, "use Zip Query today", "Use ZipperQueue today."), // join, not known, far
    seg(7, "talk to Alice later", "Talk to Bruno later."), // a different name
    seg(8, "ask Carol and Bruno", "Ask Bruno and Bruno."), // replaced by another raw name
    seg(9, "then Gizmos will move", "Then gizmo will move."), // lowercased
    seg(10, "ask Carol today", "Ask Gizmos today."), // a different known word
  ];
  assert.deepEqual(checkNames(rows, names, known).keys, [
    "system:6@6000",
    "system:7@7000",
    "system:8@8000",
    "system:9@9000",
    "system:10@10000",
  ]);
  // Without the known forms, a fix far from the raw name fails.
  assert.deepEqual(checkNames([rows[3] as SegmentRow], names).keys, [
    "system:3@3000",
  ]);
});

test("negations: added or removed", () => {
  const rows = [
    seg(0, "it does not work", "It does not work."),
    seg(1, "it doesn't work", "It does work."),
    seg(2, "we will ship", "We will never ship."),
    seg(3, "no no it is fine", "No, it is fine."),
  ];
  assert.deepEqual(checkNegations(rows).keys, [
    "system:1@1000",
    "system:2@2000",
    "system:3@3000",
  ]);
});

test("labels: the enhanced text starts with a speaker label, the raw text does not", () => {
  const rows = [
    seg(0, "we ship on friday", "Me: We ship on Friday."),
    seg(1, "we ship on friday", "them 7: we ship on Friday."),
    seg(2, "we ship on friday", "Them:"), // a label only
    seg(3, "we ship on friday", "  THEM 12 : We ship on Friday."),
    seg(4, "me: we ship on friday", "Me: We ship on Friday."), // raw has it: kept
    seg(5, "tell me: we ship", "Tell me: we ship."), // not at the start
    seg(6, "theme: we ship", "Theme: we ship."), // a word, not a label
    seg(7, "we ship on friday", null), // no enhanced text
  ];
  assert.deepEqual(checkLabels(rows).keys, [
    "system:0@0",
    "system:1@1000",
    "system:2@2000",
    "system:3@3000",
  ]);
});

test("chunks: failed chunks and unrecovered finish length", () => {
  const call = (step: string, attempt: number, finish: string | null) => ({
    run_id: "r1",
    step_key: step,
    schema_name: "x",
    attempt,
    finish_unified: finish,
  });
  const ok = checkChunks([], 0, [
    call("chunk:0", 1, "length"),
    call("chunk:0", 2, "stop"),
  ]);
  assert.equal(ok.count, 0);
  const bad = checkChunks([3], 2, [
    call("speakers", 1, "length"),
    call("speakers", 2, "length"),
  ]);
  assert.deepEqual(bad.keys, ["chunk:3", "chunk:?", "step:speakers"]);
  assert.deepEqual([bad.failedChunks, bad.unrecoveredLength], [2, 1]);
});

test("summary: check-summary result and placeholders", () => {
  const json = (owner: string | null, due: string | null) =>
    JSON.stringify({ actionItems: [{ task: "t", owner, due }] });
  assert.equal(
    checkSummary(true, json("Alice", null), "- t (Owner: Alice)").count,
    0,
  );
  assert.deepEqual(checkSummary(false, json(null, null), "").keys, [
    "check-summary",
  ]);
  const ph = checkSummary(
    true,
    json("null", "N/A"),
    "## Action Items\n- t (Owner: null)",
  );
  assert.deepEqual(ph.keys, [
    "actionItems[0].owner",
    "actionItems[0].due",
    "markdown:line2",
  ]);
  assert.equal(ph.placeholders, 3);
  assert.deepEqual(checkSummary(null, null, null).keys, ["check-summary"]);
});

test("speakers: a suggested name must be in the text or metadata", () => {
  const sp = [
    { label: "S1", suggested_name: "Alice Moreau" },
    { label: "S2", suggested_name: "José" },
    { label: "S3", suggested_name: "Zed" },
    { label: "S4", suggested_name: null },
  ];
  const f = checkSpeakerNames(sp, [
    "hi, this is alice",
    "Jose here",
    null,
    "Alice Moreau, Bob",
  ]);
  assert.deepEqual(f.keys, ["speaker:S3"]);
});

test("speakers: kinds, labels and the app's support texts", () => {
  assert.deepEqual(
    attendeeNames(
      JSON.stringify([
        { name: "Nora Quill", email: "nq@example.test" },
        { name: "", email: "x@example.test" },
        "bad",
      ]),
    ),
    ["Nora Quill"],
  );
  assert.deepEqual(attendeeNames("not json"), []);
  const sp = [
    { label: "1", suggested_name: "Nora Quill", suggested_kind: "name" }, // attendee surname
    { label: "2", suggested_name: "Ravi Pell", suggested_kind: "name" }, // surname from context
    { label: "3", suggested_name: "Ravi Stone", suggested_kind: "name" }, // invented surname
    { label: "4", suggested_name: "the client", suggested_kind: "role" }, // role: no name check
    { label: "5", suggested_name: "Them 1", suggested_kind: "role" }, // label echo
    { label: "6", suggested_name: "Speaker 2", suggested_kind: "name" }, // label echo
    { label: "7", suggested_name: "Me", suggested_kind: null }, // label echo
    { label: "8", suggested_name: "Ravi", suggested_kind: "name" }, // first name in the text
  ];
  const f = checkSpeakerNames(sp, [
    "hi nora, ravi here, them 1 said",
    "Speaker 2 me",
    "Kickoff with Nora", // title
    "Ravi Pell runs the build", // context
    ...attendeeNames(JSON.stringify([{ name: "Nora Quill", email: "" }])),
  ]);
  assert.deepEqual(f.keys, [
    "speaker:3",
    "speaker:5",
    "speaker:6",
    "speaker:7",
  ]);
});

test("metrics: applied, echo rate, drops, finish", () => {
  const links = [
    { target_type: "segment", outcome: "applied", reason: null },
    { target_type: "segment", outcome: "dropped", reason: "unchanged" },
    { target_type: "segment", outcome: "dropped", reason: "deletes_words" },
    { target_type: "segment", outcome: "dropped", reason: "unchanged" },
    { target_type: "speaker", outcome: "dropped", reason: "quote_too_long" },
    { target_type: "speaker", outcome: "applied", reason: null },
  ];
  const calls = [
    {
      run_id: "r",
      step_key: "chunk:0",
      schema_name: "correct_chunk",
      attempt: 1,
      finish_unified: "stop",
    },
    {
      run_id: "r",
      step_key: "speakers",
      schema_name: "identify_speakers",
      attempt: 1,
      finish_unified: "length",
    },
  ];
  const m = runMetrics(links, calls, [
    { suggested_name: "A" },
    { suggested_name: " " },
  ]);
  assert.equal(m.applied, 1);
  assert.equal(m.echoRate, 0.5);
  assert.deepEqual(m.dropsCorrection, { deletes_words: 1, unchanged: 2 });
  assert.deepEqual(m.dropsSpeaker, { quote_too_long: 1 });
  assert.deepEqual(m.finish.identify_speakers, {
    stop: 0,
    length: 1,
    other: 0,
  });
  assert.equal(m.suggestions, 1);
});

test("answer key: load and validate (v1)", () => {
  assert.throws(() => parseAnswerKey('{"version":2}'), /version/);
  assert.throws(
    () =>
      parseAnswerKey(
        '{"version":1,"meetings":{"abc":{"fixes":[{"key":"k"}]}}}',
      ),
    /fixes\[0\]/,
  );
  const key = parseAnswerKey(
    '{"version":1,"meetings":{"2943c36a-full-id":{"fixes":[],"mustNotChange":[]}}}',
  );
  assert.deepEqual(Object.keys(key), ["2943c36a"]);
});

test("report: render, self-check and floor", () => {
  const checks = (n: number) => ({
    segments: { count: 0, keys: [] },
    numbers: {
      count: n,
      keys: Array.from({ length: n }, (_, i) => `system:${i}@0`),
    },
    names: { count: 0, keys: [] },
    negations: { count: 0, keys: [] },
    labels: { count: 0, keys: [] },
    chunks: { count: 0, keys: [] },
    summary: { count: 0, keys: [] },
    speakers: { count: 0, keys: [] },
  });
  const run = (
    model: string,
    disk: number | null,
    fails: number,
  ): RunResult => {
    const r: RunResult = {
      model,
      meeting: "2943c36a",
      status: "ok",
      exitCode: 0,
      seconds: 12.3,
      peakRssGb: disk === null ? null : 1.5,
      diskBytes: disk,
      inputTokens: 100,
      outputTokens: 50,
      chunksAttempted: 2,
      chunksFailed: 0,
      metrics: runMetrics([], [], []),
      checks: checks(fails),
      hardFails: 0,
      scorecard: null,
    };
    r.hardFails = hardFailsOf(r);
    return r;
  };
  const res: Results = {
    createdAt: "2026-10-20T00:00:00Z",
    commit: "abc1234",
    models: ["small", "big", "no-size"],
    meetings: [
      { id8: "2943c36a", id: "2943c36a-x", segments: 37, durationSeconds: 425 },
    ],
    asrHash: null,
    asrModel: null,
    gold: null,
    runs: [run("small", 1e9, 2), run("big", 8e9, 0), run("no-size", null, 0)],
    floor: null,
  };
  res.floor = floorModel(res);
  assert.equal(res.floor, "big");
  const md = renderResults(res);
  assert.deepEqual(selfCheck(md, res), []);
  assert.ok(md.includes("system:0@0, system:1@0"));
  assert.ok(md.includes("| negations | labels | chunks |"));
  // A changed cell in the Markdown fails the self-check.
  const broken = md.replace("| small | 2 |", "| small | 3 |");
  assert.ok(selfCheck(broken, res).length > 0);
  // A wrong total fails it too.
  const wrong = structuredClone(res);
  (wrong.runs[0] as RunResult).hardFails = 0;
  assert.ok(
    selfCheck(renderResults(wrong), wrong).some((e) => e.includes("check sum")),
  );
  // A failed run counts as one hard fail.
  assert.equal(hardFailsOf({ status: "failed", checks: null }), 1);
});
