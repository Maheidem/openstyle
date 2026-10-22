// Unit tests of the parameter sweep (stage-replay.mts, stage-score.mts,
// sweep-search.mts). Fictional text only. Run: pnpm meeting:eval:test

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCorrectSystemPrompt,
  buildCorrectUserPrompt,
  buildTagsSystemPrompt,
} from "../../../apps/server/src/lib/meetings/workflow/prompts.ts";
import { correctChunkStepSchema } from "../../../apps/server/src/lib/meetings/workflow/schemas.ts";
import type { Gold } from "./gold.mts";
import {
  type AppInputs,
  applyOverrides,
  buildCorrectRequests,
  type Capture,
  type Complete,
  overridesOf,
  parseEnhanceLine,
  runCorrect,
  runTags,
  type StoredCall,
  storedExistingTags,
  wireBody,
  wireSchema,
} from "./stage-replay.mts";
import { objective, scoreStage } from "./stage-score.mts";
import {
  coarseGrid,
  compareVariant,
  fineGrid,
  type Params,
  parseSpace,
  runVariant,
  type Space,
  search,
} from "./sweep-search.mts";

// --- Fictional fixtures ---------------------------------------------------------------

/** Fictional prompt inputs: no language pin, one vocabulary term. */
const APP: AppInputs = {
  language: null,
  vocabTerms: ["Kubernetes"],
  title: "Fictional launch sync",
  context: null,
  contextWithFolder: null,
};
/** The system prompt of the current app code for APP (the replay rebuilds it). */
const SYSTEM = buildCorrectSystemPrompt(APP);
const LINES = [
  "[s1] Me: we moved the cluster to cooper netties",
  "[s2] Them 1: the the demo is on friday",
  "[s3] Me: thanks Ana see you then",
];
const TOP = {
  model: "fictional/model",
  max_tokens: 0,
  temperature: 0,
  response_format: {
    type: "json_schema",
    json_schema: { strict: true, name: "correct_chunk" },
  },
};
const EXTRA = { chat_template_kwargs: { enable_thinking: false } };

function call(
  id: number,
  node: string,
  unitKey: string,
  patch: Partial<StoredCall>,
): StoredCall {
  return {
    id,
    node,
    unitKey,
    attempt: 1,
    schemaName: "x",
    messages: [],
    schema: {},
    topLevel: structuredClone(TOP),
    extraBody: structuredClone(EXTRA),
    rawText: null,
    finish: "stop",
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    ...patch,
  };
}

/** The schema of the current app code for the three ids (the replay rebuilds it). */
const CORRECT_SCHEMA = await wireSchema(
  correctChunkStepSchema(["s1", "s2", "s3"]),
);

/** One stored correctChunk call with all three lines (as the server would build it). */
function correctCapture(): Capture {
  const user = buildCorrectUserPrompt(LINES);
  const tokens = LINES.reduce((a, l) => a + Math.ceil(l.length / 4) + 1, 0);
  const c = call(1, "correctChunk", "chunk:0", {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    schema: structuredClone(CORRECT_SCHEMA),
    topLevel: { ...structuredClone(TOP), max_tokens: tokens * 2 + 200 },
  });
  return {
    format: "openstyle-stage-capture",
    version: 1,
    meetingId: "fictional-meeting",
    model: "fictional",
    asrHash: null,
    capturedAt: "",
    calls: [c],
  };
}

const gold = (patch: Partial<Gold> = {}): Gold => ({
  source: "gold-v2",
  meeting: "aaaa1111",
  goldVersion: 1,
  asrHash: null,
  builtAt: null,
  verifiedSpans: 0,
  timeToleranceMs: 2000,
  transcript: null,
  fixes: [],
  mustNotChange: [],
  summary: null,
  tags: null,
  speakers: null,
  ...patch,
});

const reply = (text: string, finish = "stop") => ({
  text,
  finish,
  outputTokens: 7,
  promptTokens: 9,
  latencyMs: 5,
});

// --- Replay request override ----------------------------------------------------------

test("wireBody puts messages and schema back; applyOverrides changes only a copy", () => {
  const c = correctCapture().calls[0] as StoredCall;
  const body = wireBody(c);
  assert.deepEqual((body.messages as unknown[]).length, 2);
  assert.deepEqual(
    (body.response_format as any).json_schema.schema.properties.corrections
      .items.properties.id.enum,
    ["s1", "s2", "s3"],
  );
  const o = applyOverrides(body, {
    temperature: 0.3,
    top_p: 0.95,
    top_k: 64,
    thinking: true,
    maxTokensExtra: 2048,
    perturb: ["garbled words", "jumbled words"],
  });
  assert.equal(o.temperature, 0.3);
  assert.equal(o.top_p, 0.95);
  assert.equal(o.top_k, 64);
  assert.equal(o.chat_template_kwargs.enable_thinking, true);
  assert.equal(o.max_tokens, Number(body.max_tokens) + 2048);
  assert.match(o.messages[0].content, /jumbled words/);
  // The input body did not change.
  assert.equal(body.temperature, 0);
  assert.match((body.messages as any)[0].content, /garbled words/);
  assert.equal((body.chat_template_kwargs as any).enable_thinking, false);
});

test("applyOverrides refuses a perturb word that the system prompt does not hold", () => {
  const body = wireBody(correctCapture().calls[0] as StoredCall);
  assert.throws(
    () => applyOverrides(body, { perturb: ["no such words", "x"] }),
    /perturb/,
  );
});

test("overridesOf keeps sampling keys and drops app-level keys", () => {
  assert.deepEqual(
    overridesOf({
      temperature: 0.3,
      chunkTokens: 600,
      thinking: false,
      maxTokensExtra: 1024,
      contextBudget: 4000,
    }),
    { temperature: 0.3, thinking: false, maxTokensExtra: 1024 },
  );
});

test("parseEnhanceLine reads id, label and text (text may hold a colon)", () => {
  assert.deepEqual(parseEnhanceLine("[s9] Them 2: note: ship it"), {
    id: "s9",
    label: "Them 2",
    text: "note: ship it",
  });
  assert.equal(parseEnhanceLine("no id here"), null);
});

test("buildCorrectRequests at the stored chunk size gives the stored request byte for byte", async () => {
  const cap = correctCapture();
  const { requests } = await buildCorrectRequests(cap.calls, 1200, APP);
  assert.equal(requests.length, 1);
  assert.equal(
    JSON.stringify(requests[0]?.body),
    JSON.stringify(wireBody(cap.calls[0] as StoredCall)),
  );
});

test("buildCorrectRequests at a small chunk size cuts whole segments with their own id enum", async () => {
  const { requests } = await buildCorrectRequests(
    correctCapture().calls,
    15,
    APP,
  );
  assert.equal(requests.length, 3);
  const ids = requests.map(
    (r) =>
      (r.body.response_format as any).json_schema.schema.properties.corrections
        .items.properties.id.enum,
  );
  assert.deepEqual(ids, [["s1"], ["s2"], ["s3"]]);
  assert.match(
    (requests[1]?.body.messages as any)[1].content,
    /\[s2\] Them 1: the the demo/,
  );
});

test("runCorrect applies the server checks: a fix stays, a deletion is dropped", async () => {
  const answer = JSON.stringify({
    corrections: [
      { id: "s1", text: "we moved the cluster to Kubernetes" },
      { id: "s3", text: "thanks see you then" },
    ],
  });
  const stub: Complete = async () => reply(answer);
  const out = await runCorrect(correctCapture(), APP, { temperature: 0 }, stub);
  assert.deepEqual(out.corrections, {
    s1: "we moved the cluster to Kubernetes",
  });
  assert.deepEqual(out.dropped, { deletes_words: 1 });
  assert.equal(out.failedUnits, 0);
  assert.equal(out.calls[0]?.jsonValid, true);
});

test("runCorrect counts a length finish as a failed unit", async () => {
  const out = await runCorrect(correctCapture(), APP, {}, async () =>
    reply('{"corr', "length"),
  );
  assert.equal(out.failedUnits, 1);
  assert.equal(out.calls[0]?.finish, "length");
  assert.deepEqual(out.corrections, {});
});

test("buildCorrectRequests takes the system prompt from the current code, not the stored one", async () => {
  const cap = correctCapture();
  (cap.calls[0] as StoredCall).messages[0] = {
    role: "system",
    content: "An old fictional prompt.",
  };
  const { requests } = await buildCorrectRequests(cap.calls, 1200, APP);
  const sent = (requests[0]?.body.messages as { content: string }[])[0];
  assert.equal(sent?.content, SYSTEM);
  assert.match(sent?.content ?? "", /Kubernetes/);
});

test("storedExistingTags reads the existing tags of a stored tags prompt", () => {
  const system = buildTagsSystemPrompt({
    title: null,
    context: null,
    existingTags: ["billing", "q4 plan"],
    maxTags: 5,
  });
  assert.deepEqual(storedExistingTags(system), ["billing", "q4 plan"]);
  assert.deepEqual(
    storedExistingTags(
      buildTagsSystemPrompt({
        title: null,
        context: null,
        existingTags: [],
        maxTags: 5,
      }),
    ),
    [],
  );
});

test("runTags sets maxItems on the schema and keeps at most 5 normalized tags", async () => {
  const tagsCall = call(5, "suggestTags", "tags", {
    messages: [
      { role: "system", content: "Give short topic tags." },
      { role: "user", content: "<transcript>\nMe: fictional\n</transcript>" },
    ],
    schema: {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    },
  });
  const cap = { ...correctCapture(), calls: [tagsCall] };
  let sent: any = null;
  const out = await runTags(cap, APP, { maxItems: 5 }, async (b) => {
    sent = b;
    return reply(
      JSON.stringify({
        tags: ["Alpha", "beta", "gamma", "delta", "eps", "zeta"],
      }),
    );
  });
  assert.equal(
    sent.response_format.json_schema.schema.properties.tags.maxItems,
    5,
  );
  assert.equal(out.tags?.length, 5);
  assert.equal(out.tags?.[0], "alpha");
});

// --- Scoring per stage -----------------------------------------------------------------

test("scoreStage correctChunk: WER delta, fixes, must-not-change, drops", () => {
  const rows = [
    {
      id: "s1",
      source: "mic",
      idx: 0,
      start_ms: 0,
      text: "we moved to cooper netties",
      enhanced_text: null,
    },
  ];
  const g = gold({
    transcript: {
      mic: [
        {
          startMs: 0,
          endMs: 1000,
          text: "we moved to Kubernetes",
          verified: true,
        },
      ],
      system: [],
    },
    fixes: [
      { channel: "mic", startMs: 0, from: "cooper netties", to: "Kubernetes" },
    ],
    mustNotChange: [{ channel: "mic", startMs: 0, span: "we moved" }],
  });
  const m = scoreStage(
    "correctChunk",
    {
      stage: "correctChunk",
      calls: [
        {
          key: "chunk:0",
          finish: "stop",
          outputTokens: 3,
          latencyMs: 10,
          jsonValid: true,
        },
      ],
      failedUnits: 0,
      corrections: { s1: "we moved to Kubernetes" },
      dropped: { unchanged: 2 },
    },
    g,
    rows,
  );
  assert.equal(m.fixesFound, 1);
  assert.equal(m.mustNotChangeHits, 0);
  assert.equal(m.wer, 0);
  assert.equal(m.werDelta, 0.5);
  assert.equal(m.droppedByChecks, 2);
  assert.equal(objective("correctChunk", [m]), 50.5);
});

test("scoreStage summarize: matched facts, owner/due, mustNotClaim, invented items", () => {
  const g = gold({
    summary: {
      decisions: [
        { id: "d1", keywords: ["ship friday"], owner: null, due: null },
      ],
      actionItems: [
        { id: "a1", keywords: ["send report"], owner: "Ana", due: "monday" },
      ],
      mustNotClaim: [{ id: "c1", keywords: ["cancel"] }],
    },
  });
  const summaryJson = JSON.stringify({
    overview: "A fictional plan.",
    keyPoints: [],
    decisions: ["We ship friday", "We cancel the trip"],
    actionItems: [{ task: "Send report", owner: "Ana", due: "tuesday" }],
    openQuestions: [],
  });
  const m = scoreStage(
    "summarize",
    { stage: "summarize", calls: [], failedUnits: 0, summaryJson },
    g,
    [],
  );
  assert.equal(m.factsMatched, 2);
  assert.equal(m.ownerCorrect, 2); // d1 null/null and a1 Ana
  assert.equal(m.dueWrong, 1);
  assert.equal(m.mustNotClaimHits, 1);
  assert.equal(m.inventedItems, 1);
  // 2 + 0.5*(2+1) - 1 - 3 - 0.25
  assert.equal(objective("summarize", [m]), -0.75);
});

test("scoreStage identifySpeakers and suggestTags", () => {
  const g = gold({
    speakers: { "1": "Ana", "2": null },
    tags: {
      expected: [
        { name: "roadmap", synonyms: ["plan"] },
        { name: "billing", synonyms: [] },
      ],
    },
  });
  const sp = scoreStage(
    "identifySpeakers",
    {
      stage: "identifySpeakers",
      calls: [],
      failedUnits: 0,
      speakers: [
        { label: "1", suggested_name: "Ana", suggested_kind: "name" },
        { label: "2", suggested_name: "Bo", suggested_kind: "name" },
      ],
    },
    g,
    [],
  );
  assert.equal(sp.speakersCorrect, 1);
  assert.equal(sp.speakersWrong, 1);
  assert.equal(objective("identifySpeakers", [sp]), -1);
  const tg = scoreStage(
    "suggestTags",
    {
      stage: "suggestTags",
      calls: [],
      failedUnits: 0,
      tags: ["plan", "travel"],
    },
    g,
    [],
  );
  assert.equal(tg.tagsPrecision, 0.5);
  assert.equal(tg.tagsRecall, 0.5);
  assert.equal(objective("suggestTags", [tg]), 0.5);
});

// --- Search driver ------------------------------------------------------------------------

const SPACE: Space = parseSpace(
  JSON.stringify({
    stage: "suggestTags",
    baseline: { maxItems: null, temperature: 0 },
    params: {
      maxItems: { values: [null, 5] },
      temperature: { values: [0, 0.4] },
      top_p: { values: [0.95], when: "temperature>0" },
    },
    repeats: 3,
    earlyStopAfter: 2,
    earlyStopMargin: 0.2,
  }),
);

test("coarseGrid drops a parameter whose condition does not hold and removes duplicates", () => {
  const grid = coarseGrid(SPACE);
  assert.equal(grid.length, 4);
  assert.ok(
    grid.every((p) =>
      p.temperature === 0 ? !("top_p" in p) : p.top_p === 0.95,
    ),
  );
});

test("fineGrid adds the midpoints to the neighbour values (halved steps)", () => {
  const s = parseSpace(
    JSON.stringify({
      stage: "summarize",
      baseline: { contextBudget: 8000, temperature: 0 },
      params: {
        contextBudget: { values: [4000, 8000, 16000], integer: true },
        temperature: { values: [0, 0.3] },
      },
    }),
  );
  const fine = fineGrid(s, { contextBudget: 8000, temperature: 0 });
  const budgets = [...new Set(fine.map((p) => p.contextBudget))].sort(
    (a, b) => Number(a) - Number(b),
  );
  assert.deepEqual(budgets, [6000, 8000, 12000]);
  assert.deepEqual(
    [...new Set(fine.map((p) => p.temperature))].sort(),
    [0, 0.15],
  );
});

/** A fictional evaluator: tag F1 by parameters; temperature adds a spread by repeat. */
function fakeEval(
  table: (p: Params, meeting: number, repeat: number) => number,
) {
  const calls: {
    p: Params;
    meeting: number;
    repeat: number;
    perturb: boolean;
  }[] = [];
  const evaluate = async (
    p: Params,
    meeting: number,
    repeat: number,
    perturb: boolean,
  ) => {
    calls.push({ p, meeting, repeat, perturb });
    const f1 = perturb
      ? table(p, meeting, repeat) - 0.05
      : table(p, meeting, repeat);
    return { tagsPrecision: f1, tagsRecall: f1, failedUnits: 0 };
  };
  return { calls, evaluate };
}

test("search: baseline, noise band, repeats above temperature 0, winner beats noise", async () => {
  const { calls, evaluate } = fakeEval((p, _m, r) =>
    p.maxItems === 5 ? (p.temperature ? 0.8 + r * 0.01 : 0.9) : 0.5,
  );
  const res = await search({ ...SPACE, fine: false }, 3, evaluate);
  assert.equal(res.baseline.objective, 1.5); // 3 meetings x 0.5
  assert.equal(res.band.objective, 0.15);
  assert.deepEqual(res.best.params, { maxItems: 5, temperature: 0 });
  assert.equal(res.delta, 1.2);
  assert.equal(res.beatsNoise, true);
  const warm = res.combos.find(
    (c) => c.params.maxItems === 5 && c.params.temperature === 0.4,
  );
  assert.equal(warm?.repeats, 3);
  assert.equal(warm?.objectives.length, 3);
  assert.equal(warm?.objective, 2.43); // median of 2.4, 2.43, 2.46
  assert.equal(calls.filter((c) => c.perturb).length, 3);
});

test("search: a clearly worse combination stops after 2 meetings", async () => {
  const { calls, evaluate } = fakeEval((p) =>
    p.maxItems === 5 && p.temperature === 0 ? 0.1 : 0.5,
  );
  const res = await search({ ...SPACE, fine: false }, 4, evaluate);
  const bad = res.combos.find(
    (c) => c.params.maxItems === 5 && c.params.temperature === 0,
  );
  assert.equal(bad?.earlyStopped, true);
  assert.equal(bad?.meetingsRun, 2);
  assert.equal(calls.filter((c) => c.p === bad?.params).length, 2);
  // A stopped combination never wins, and a tie keeps the baseline.
  assert.equal(res.best, res.baseline);
  assert.equal(res.beatsNoise, false);
});

test("search: a delta inside the noise band does not beat noise", async () => {
  const { evaluate } = fakeEval((p) =>
    p.maxItems === 5 && p.temperature === 0 ? 0.52 : 0.5,
  );
  const res = await search({ ...SPACE, fine: false }, 2, evaluate);
  assert.deepEqual(res.best.params, { maxItems: 5, temperature: 0 });
  assert.ok(res.delta > 0);
  assert.equal(res.beatsNoise, false);
});

test("workerClient (llama.cpp mode): template + raw completion, schema grammar, thought token blocked, at most `parallel` requests", async () => {
  const { createServer } = await import("node:http");
  let running = 0;
  let peak = 0;
  const seen: { url: string; body: any }[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => {
      const body = JSON.parse(data);
      seen.push({ url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/apply-template")) {
        res.end(JSON.stringify({ prompt: "<rendered>" }));
        return;
      }
      running++;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running--;
        res.end(
          JSON.stringify({
            content: "{}",
            stop_type: "limit",
            tokens_predicted: 2,
            tokens_evaluated: 3,
          }),
        );
      }, 30);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const { workerClient } = await import("./stage-replay.mts");
  const complete = workerClient(
    `http://127.0.0.1:${port}/v1/chat/completions`,
    { model: "server-name", parallel: 2, timeoutMs: 5000 },
  );
  const schema = { type: "object" };
  const replies = await Promise.all(
    [1, 2, 3, 4, 5].map(() =>
      complete({
        model: "app/model",
        max_tokens: 50,
        temperature: 0,
        repetition_penalty: 1.1,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_schema", json_schema: { schema } },
        messages: [{ role: "user", content: "fictional" }],
      }),
    ),
  );
  server.close();
  assert.equal(replies.length, 5);
  assert.equal(replies[0]?.finish, "length");
  assert.equal(peak, 2);
  const tpl = seen.find((x) => x.url.endsWith("/apply-template"));
  assert.equal(tpl?.url, "/upstream/server-name/apply-template");
  assert.deepEqual(tpl?.body.chat_template_kwargs, { enable_thinking: false });
  const done = seen.find((x) => x.url.endsWith("/completion"));
  assert.equal(done?.body.prompt, "<rendered>");
  assert.deepEqual(done?.body.json_schema, schema);
  assert.equal(done?.body.n_predict, 50);
  assert.equal(done?.body.repeat_penalty, 1.1);
  assert.equal(done?.body.cache_prompt, false);
  assert.deepEqual(done?.body.logit_bias, [[100, false]]);
});

test("search with explicit combos runs only those, plus baseline and noise", async () => {
  const { calls, evaluate } = fakeEval((p) => (p.maxItems === 5 ? 0.7 : 0.5));
  const res = await search(
    { ...SPACE, combos: [{ maxItems: 5, temperature: 0 }] },
    2,
    evaluate,
  );
  assert.equal(res.combos.length, 2); // baseline + 1 combo (noise is separate)
  assert.deepEqual(res.best.params, { maxItems: 5, temperature: 0 });
  assert.equal(calls.length, 6); // baseline 2 + noise 2 + combo 2
});

test("search runs a control arm once as it is and never centers the fine grid on it", async () => {
  const { calls, evaluate } = fakeEval((p) =>
    "repetition_penalty" in p ? 0.9 : 0.5,
  );
  const res = await search(
    { ...SPACE, controls: [{ temperature: 0, repetition_penalty: 1.1 }] },
    2,
    evaluate,
  );
  const ctl = res.combos.filter((c) => "repetition_penalty" in c.params);
  assert.equal(ctl.length, 1);
  assert.deepEqual(ctl[0]?.params, { repetition_penalty: 1.1, temperature: 0 });
  assert.equal(
    res.combos.filter(
      (c) => c.phase === "fine" && "repetition_penalty" in c.params,
    ).length,
    0,
  );
  assert.ok(calls.length > 0);
});

test("runVariant: one run at temperature 0, repeats above it, noise band with --noise", async () => {
  const cold = fakeEval(() => 0.5);
  const a = await runVariant("suggestTags", 2, cold.evaluate, {
    params: {},
    repeats: 3,
    noise: false,
  });
  assert.equal(a.arm.repeats, 1);
  assert.equal(a.arm.objective, 1); // 2 meetings x F1 0.5
  assert.equal(a.noise, null);
  assert.equal(cold.calls.length, 2);
  const hot = fakeEval((_p, _m, r) => 0.5 + r * 0.01);
  const b = await runVariant("suggestTags", 2, hot.evaluate, {
    params: { temperature: 0.4 },
    repeats: 3,
    noise: true,
  });
  assert.equal(b.arm.repeats, 3);
  assert.equal(b.arm.objective, 1.02); // median of 1, 1.02, 1.04
  assert.equal(hot.calls.filter((c) => c.perturb).length, 2);
  // The noise run (repeat 0, F1 0.45 per meeting) vs the median arm: |0.9 - 1.02|.
  assert.equal(b.band?.objective, 0.12);
});

test("compareVariant: delta per metric, the larger band decides the verdict", async () => {
  const { evaluate } = fakeEval(() => 0.6);
  const v = await runVariant("suggestTags", 2, evaluate, {
    params: {},
    repeats: 3,
    noise: true,
  });
  const base = {
    objective: 1,
    totals: { tagsPrecision: 1, tagsRecall: 1 },
    band: { objective: 0.05, tagsPrecision: 0.02 },
  };
  const c = compareVariant(base, v, ["tagsPrecision", "tagsRecall", "none"]);
  assert.equal(c.delta, 0.2);
  assert.equal(c.band, 0.1); // this run's band (2 x 0.05) is larger
  assert.equal(c.verdict, "better");
  // A rate is the mean over the meetings; its band is the larger one (0.05).
  assert.deepEqual(c.rows[0], {
    metric: "tagsPrecision",
    base: 1,
    variant: 0.6,
    delta: -0.4,
    band: 0.05,
  });
  assert.deepEqual(c.rows[2], {
    metric: "none",
    base: null,
    variant: null,
    delta: null,
    band: null,
  });
  const inside = compareVariant({ ...base, objective: 1.15 }, v, []);
  assert.equal(inside.verdict, "inside noise");
  const worse = compareVariant({ ...base, objective: 1.5 }, v, []);
  assert.equal(worse.verdict, "worse");
});
