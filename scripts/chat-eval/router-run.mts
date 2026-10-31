// router-run.mts: the router arms on Gemma 4 E2B (spec 8.5, D9, D11).
//   A1  LLM router (json_schema strict) -> plan table -> slot fill (strict)
//   A3  rules router -> plan table -> slot fill
//   A5  LLM router -> plan table, default slots (no slot call)
//   T1  native tools in the local worker (flag), same closed choices
// Request shape = what the gateway sends to the local provider (specs/llm-runtime-
// tuning.md): temperature 0 (the Auto path), thinking off, strict JSON schema.
// The harness calls the worker over HTTP; it does not go through callUnit.

import process from "node:process";
import { mean, percentile } from "./keys.mts";
import type { RunOut, RunResult } from "./retrieval-run.mts";
import {
  extraRouterItems,
  planFor,
  ROUTER_SCHEMA,
  type RouterItem,
  type RouterPrompt,
  routerSystem,
  rulesRoute,
} from "./router-data.mts";
import {
  buildChoices,
  type Choices,
  defaultSlots,
  type SlotValues,
  scoreSlots,
  slotSchema,
  slotSystem,
  TODAY_ISO,
  TODAY_NAME,
} from "./slots.mts";
import { bootStack, RssSampler } from "./stack.mts";
import type { Corpus, GoldSet, Intent, Question } from "./types.mts";

const MODEL_ID = "gemma-4-e2b-qat-4bit";

interface Reply {
  content: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  ms: number;
  finish: string;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number | null;
}

async function ask(
  base: string,
  hfId: string,
  body: Record<string, unknown>,
): Promise<Reply> {
  const t0 = performance.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: hfId,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      ...body,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const ms = performance.now() - t0;
  const text = await res.text();
  if (!res.ok)
    throw new Error(`worker HTTP ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as {
    choices: {
      message: {
        content: string | null;
        tool_calls?: { function: { name: string; arguments: string } }[];
      };
      finish_reason: string;
    }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      ttft_ms?: number;
    };
  };
  const ch = j.choices[0] as (typeof j.choices)[number];
  return {
    content: ch.message.content ?? "",
    toolCalls: (ch.message.tool_calls ?? []).map((t) => ({
      name: t.function.name,
      args: safeJson(t.function.arguments),
    })),
    ms,
    finish: ch.finish_reason,
    promptTokens: j.usage?.prompt_tokens ?? 0,
    completionTokens: j.usage?.completion_tokens ?? 0,
    ttftMs: j.usage?.ttft_ms ?? null,
  };
}
function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const strict = (name: string, schema: unknown) => ({
  type: "json_schema",
  json_schema: { name, strict: true, schema },
});

// --- Stages ----------------------------------------------------------------------------------

async function routeLlm(
  base: string,
  hf: string,
  text: string,
  prev: string | null,
  prompt: RouterPrompt,
) {
  const user = prev
    ? `Previous question: ${prev}\nQuestion: ${text}`
    : `Question: ${text}`;
  const r = await ask(base, hf, {
    messages: [
      { role: "system", content: routerSystem(prompt) },
      { role: "user", content: user },
    ],
    max_tokens: 24,
    response_format: strict("router", ROUTER_SCHEMA),
  });
  let intent: Intent = "lookup";
  let valid = false;
  try {
    const v = JSON.parse(r.content) as { intent?: Intent };
    if (v.intent) {
      intent = v.intent;
      valid = true;
    }
  } catch {
    // invalid JSON: the default intent (spec 2.3 stage 1)
  }
  return { intent, valid, r };
}

async function fillSlots(
  base: string,
  hf: string,
  q: Question,
  intent: Intent,
  ch: Choices,
) {
  const schema = slotSchema(intent, ch);
  if (!schema) return { slots: {} as SlotValues, r: null, valid: true };
  const hist = q.history.length
    ? `Earlier: ${q.history
        .slice(-2)
        .map((h) => `${h.q} -> ${h.a}`)
        .join(" | ")}\n`
    : "";
  const r = await ask(base, hf, {
    messages: [
      { role: "system", content: slotSystem(intent, ch) },
      { role: "user", content: `${hist}Question: ${q.text}` },
    ],
    max_tokens: 150,
    response_format: strict("slots", schema),
  });
  try {
    return { slots: JSON.parse(r.content) as SlotValues, r, valid: true };
  } catch {
    return { slots: defaultSlots(q), r, valid: false };
  }
}

// --- T1 tools ------------------------------------------------------------------------------------

const D = { type: "string", description: "YYYY-MM-DD or empty" };
function tools(ch: Choices, write: boolean) {
  const person = {
    type: "string",
    enum: ["none", ...ch.people.map((p) => p.id)],
    description: "person id",
  };
  const fn = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = [],
  ) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  });
  if (write) {
    return [
      fn(
        "propose_action_item_change",
        "Propose to close or reopen one action item",
        {
          item: { type: "string", enum: ch.items.map((i) => i.label) },
          done: { type: "boolean" },
        },
        ["item", "done"],
      ),
      fn(
        "propose_retag",
        "Propose to add a tag to meetings",
        { tag: { type: "string" }, date_from: D, date_to: D },
        ["tag"],
      ),
      fn(
        "propose_move",
        "Propose to move one meeting to a folder",
        {
          meeting: { type: "string", enum: ch.meetings.map((m) => m.label) },
          folder: { type: "string", enum: ch.folders.map((f) => f.id) },
        },
        ["meeting", "folder"],
      ),
      fn(
        "propose_merge_people",
        "Propose to merge name variants of one person",
        { person },
        ["person"],
      ),
    ];
  }
  return [
    fn(
      "search_chunks",
      "Search meeting text by meaning",
      { query: { type: "string" }, date_from: D, date_to: D },
      ["query"],
    ),
    fn(
      "get_meeting_summary",
      "Read the summary of one meeting",
      { meeting: { type: "string", enum: ch.meetings.map((m) => m.label) } },
      ["meeting"],
    ),
    fn("list_action_items", "List action items", {
      person,
      status: { type: "string", enum: ["open", "done", "all"] },
      date_from: D,
      date_to: D,
    }),
    fn(
      "list_decisions_questions",
      "List decisions or open questions",
      {
        kind: { type: "string", enum: ["decision", "open_question"] },
        date_from: D,
        date_to: D,
      },
      ["kind"],
    ),
    fn("list_people", "List people", { query: { type: "string" } }),
    fn(
      "get_transcript_window",
      "Read transcript lines of one meeting",
      { meeting: { type: "string", enum: ch.meetings.map((m) => m.label) } },
      ["meeting"],
    ),
    fn("folder_status", "Where a project stands", {}),
    fn("list_meetings", "List meetings by date or tag", {
      date_from: D,
      date_to: D,
      tag: { type: "string" },
    }),
  ];
}
function t1System(ch: Choices, write: boolean): string {
  const lines = [
    `You help with questions about meeting notes. Call exactly one tool. Today is ${TODAY_ISO} (${TODAY_NAME}). A week starts on Monday.`,
    "Dates are YYYY-MM-DD. Use ids and labels from the lists.",
    `people: ${ch.people.map((p) => `${p.id}=${p.name}`).join("; ")}`,
    `meetings: ${ch.meetings.map((m) => `${m.label}=${m.text}`).join("; ")}`,
  ];
  if (write) {
    lines.push(
      `items: ${ch.items.map((i) => `${i.label}="${i.text}"`).join("; ")}`,
    );
    lines.push(
      `folders: ${ch.folders.map((f) => `${f.id}=${f.name}`).join("; ")}`,
    );
  }
  return lines.join("\n");
}
function t1Slots(name: string, a: Record<string, unknown>): SlotValues {
  const s = (k: string) =>
    typeof a[k] === "string" && a[k] !== "" ? (a[k] as string) : null;
  const v: SlotValues = {
    date_from: s("date_from"),
    date_to: s("date_to"),
    query: s("query"),
  };
  if (name === "list_action_items" || name === "propose_merge_people")
    v.person = s("person");
  if (name === "list_decisions_questions") v.kind = s("kind");
  if (name === "propose_action_item_change") {
    v.item = s("item");
    v.change = "action_item";
  }
  if (name === "propose_retag") {
    v.tag = s("tag");
    v.change = "retag";
  }
  if (name === "propose_move") {
    v.meeting = s("meeting");
    v.folder = s("folder");
    v.change = "move";
  }
  if (name === "propose_merge_people") v.change = "merge_people";
  return v;
}

// --- Runner --------------------------------------------------------------------------------------------

const goldWriteTool = (q: Question) =>
  q.key.kind === "write"
    ? `propose_${q.key.change === "action_item" ? "action_item_change" : q.key.change === "merge_people" ? "merge_people" : q.key.change}`
    : "";
const ratio = (x: number[]) => (x.length ? mean(x) : 0);
const pct = (x: number) => (x * 100).toFixed(1);
const prevQ = (q: Question) =>
  q.history.length
    ? (q.history[q.history.length - 1] as { q: string }).q
    : null;

export async function runRouter(
  corpus: Corpus,
  gold: GoldSet,
  hashes: { corpus: string; gold: string },
): Promise<RunResult> {
  const log = (s: string) =>
    console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
  const stack = await bootStack("router", true);
  void stack;
  const mod = await import("../../apps/server/src/lib/mlx-llm/server.ts");
  const rss = new RssSampler(/--llm/);
  const qs = gold.questions;
  const extra = extraRouterItems();
  const out: Record<string, unknown> = {};
  let text = `Corpus ${hashes.corpus}, gold ${hashes.gold}; model ${MODEL_ID} (worker: ${process.env.OPENSTYLE_MLX_LLM_WORKER ? "operator binary" : "managed"}), temperature 0, thinking off.\n\n`;

  // ====================== phase 1: shipped worker (A1, A3, A5) ======================
  const t0 = performance.now();
  const { baseURL, hfId } = await mod.ensureMlxLlmWorker(MODEL_ID);
  const loadMs = performance.now() - t0;
  log(`worker ready in ${Math.round(loadMs)} ms`);
  rss.start();
  const warm = await ask(baseURL, hfId, {
    messages: [{ role: "user", content: "Say ok." }],
    max_tokens: 4,
  });
  void warm;

  // ---- stage 1: router accuracy, two prompts ----
  const routes: Record<
    string,
    {
      gold: Intent;
      pred: Intent;
      ms: number;
      valid: boolean;
      lang: string;
      id: string;
    }[]
  > = {};
  for (const prompt of ["en", "ml"] as RouterPrompt[]) {
    const rows: (typeof routes)[string] = [];
    for (const q of qs) {
      const x = await routeLlm(baseURL, hfId, q.text, prevQ(q), prompt);
      rows.push({
        id: q.id,
        lang: q.lang,
        gold: q.intent,
        pred: x.intent,
        ms: x.r.ms,
        valid: x.valid,
      });
    }
    for (const it of extra) {
      const x = await routeLlm(baseURL, hfId, it.text, null, prompt);
      rows.push({
        id: it.id,
        lang: it.lang,
        gold: it.intent,
        pred: x.intent,
        ms: x.r.ms,
        valid: x.valid,
      });
    }
    routes[`LLM-${prompt}`] = rows;
    log(
      `router ${prompt}: ${pct(ratio(rows.map((r) => (r.gold === r.pred ? 1 : 0))))}% of ${rows.length}`,
    );
  }
  const rules: (typeof routes)[string] = [
    ...qs.map((q) => ({
      id: q.id,
      lang: q.lang,
      gold: q.intent,
      pred: rulesRoute(q.text),
      ms: 0,
      valid: true,
    })),
    ...extra.map((it: RouterItem) => ({
      id: it.id,
      lang: it.lang,
      gold: it.intent,
      pred: rulesRoute(it.text),
      ms: 0,
      valid: true,
    })),
  ];
  routes.rules = rules;

  const accOf = (rows: (typeof rules)[number][]) =>
    ratio(rows.map((r) => (r.gold === r.pred ? 1 : 0)));
  const byLang = (rows: (typeof rules)[number][]) =>
    Object.fromEntries(
      ["en", "pt", "de", "es", "fr", "it", "ja"].map((l) => [
        l,
        accOf(rows.filter((r) => r.lang === l)),
      ]),
    );
  text += `Stage 1, intent accuracy (190 gold questions in EN and PT + 44 extra items in 7 languages):\n\n| router | all | gold 190 | extra 44 | en | pt | de | es | fr | it | ja | p50 ms | p95 ms | invalid JSON |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const [name, rows] of Object.entries(routes)) {
    const g = rows.filter((r) => r.id.startsWith("q"));
    const x = rows.filter((r) => r.id.startsWith("x"));
    const bl = byLang(rows);
    text += `| ${name} | ${pct(accOf(rows))} | ${pct(accOf(g))} | ${pct(accOf(x))} | ${["en", "pt", "de", "es", "fr", "it", "ja"].map((l) => pct(bl[l] as number)).join(" | ")} | ${percentile(
      rows.map((r) => r.ms),
      50,
    ).toFixed(0)} | ${percentile(
      rows.map((r) => r.ms),
      95,
    ).toFixed(0)} | ${rows.filter((r) => !r.valid).length} |\n`;
  }
  // Confusion of the best LLM router on gold questions.
  const bestKey =
    accOf(routes["LLM-ml"] as (typeof rules)[number][]) >
    accOf(routes["LLM-en"] as (typeof rules)[number][])
      ? "LLM-ml"
      : "LLM-en";
  const conf = new Map<string, number>();
  for (const r of routes[bestKey] as (typeof rules)[number][])
    if (r.gold !== r.pred)
      conf.set(
        `${r.gold}->${r.pred}`,
        (conf.get(`${r.gold}->${r.pred}`) ?? 0) + 1,
      );
  text += `\nMisroutes of ${bestKey} (gold->predicted: count): ${
    [...conf]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}: ${n}`)
      .join(", ") || "none"
  }.\n`;
  out.routes = Object.fromEntries(
    Object.entries(routes).map(([k, rows]) => [
      k,
      rows.map((r) => ({ id: r.id, gold: r.gold, pred: r.pred })),
    ]),
  );

  // ---- stage 2b: slot fill, oracle intent (slot accuracy independent of the router) ----
  const choices = new Map(qs.map((q) => [q.id, buildChoices(corpus, q)]));
  const slotRows: {
    id: string;
    type: string;
    intent: Intent;
    pass: boolean;
    keys: Record<string, boolean>;
    ms: number;
    valid: boolean;
  }[] = [];
  const slotByQ = new Map<string, SlotValues>();
  for (const q of qs) {
    if (q.intent === "status") continue;
    const ch = choices.get(q.id) as Choices;
    const s = await fillSlots(baseURL, hfId, q, q.intent, ch);
    const sc = scoreSlots(q, s.slots, ch);
    slotByQ.set(q.id, s.slots);
    slotRows.push({
      id: q.id,
      type: q.type,
      intent: q.intent,
      pass: sc.pass,
      keys: sc.keys,
      ms: s.r?.ms ?? 0,
      valid: s.valid,
    });
  }
  const noSlot = qs
    .filter((q) => q.intent !== "status")
    .map(
      (q) => scoreSlots(q, defaultSlots(q), choices.get(q.id) as Choices).pass,
    );
  text += `\nStage 2b, slot accuracy with the GOLD intent (all gold args of a question must match), ${slotRows.length} questions:\n\n| group | n | slot fill (strict schema) | default slots (A5) |\n|---|---|---|---|\n`;
  const groups = [...new Set(slotRows.map((r) => r.intent))];
  const qOf = new Map(qs.map((q) => [q.id, q]));
  for (const g of groups) {
    const rs = slotRows.filter((r) => r.intent === g);
    const base = rs.map(
      (r) =>
        scoreSlots(
          qOf.get(r.id) as Question,
          defaultSlots(qOf.get(r.id) as Question),
          choices.get(r.id) as Choices,
        ).pass,
    );
    text += `| ${g} | ${rs.length} | ${pct(ratio(rs.map((r) => (r.pass ? 1 : 0))))} | ${pct(ratio(base.map((b) => (b ? 1 : 0))))} |\n`;
  }
  text += `| all | ${slotRows.length} | ${pct(ratio(slotRows.map((r) => (r.pass ? 1 : 0))))} | ${pct(ratio(noSlot.map((b) => (b ? 1 : 0))))} |\n`;
  const keyAcc = new Map<string, number[]>();
  for (const r of slotRows)
    for (const [k, v] of Object.entries(r.keys))
      keyAcc.set(k, [...(keyAcc.get(k) ?? []), v ? 1 : 0]);
  text += `\nPer arg key (strict slot fill): ${[...keyAcc].map(([k, v]) => `${k} ${pct(ratio(v))}% (n=${v.length})`).join(", ")}. Slot call p50 ${percentile(
    slotRows.map((r) => r.ms).filter((x) => x > 0),
    50,
  ).toFixed(0)} ms, p95 ${percentile(
    slotRows.map((r) => r.ms).filter((x) => x > 0),
    95,
  ).toFixed(0)} ms; invalid JSON ${slotRows.filter((r) => !r.valid).length}.\n`;
  const writeQs = qs.filter((q) => q.intent === "write");
  const cand = writeQs.map((q) => {
    const ch = choices.get(q.id) as Choices;
    if (typeof q.args.item === "string")
      return ch.items.some((i) => i.id === q.args.item);
    if (typeof q.args.meeting === "string")
      return ch.meetings.some((m) => m.id === q.args.meeting);
    if (typeof q.args.cluster === "string")
      return ch.people.some((p) => p.id === q.args.cluster);
    return true;
  });
  text += `Closed-choice recall (the gold item, meeting or person is in the list that code built): ${pct(ratio(cand.map((c) => (c ? 1 : 0))))}% of ${writeQs.length} write questions.\n`;

  // ---- end to end: tool choice and arguments, per arm ----
  type E2E = {
    id: string;
    tool: boolean;
    args: boolean;
    ms: number;
    calls: number;
  };
  const e2e = async (
    arm: "A1" | "A3" | "A5",
    routerRows: (typeof rules)[number][],
  ): Promise<E2E[]> => {
    const rows: E2E[] = [];
    const rmap = new Map(routerRows.map((r) => [r.id, r]));
    for (const q of qs) {
      const r = rmap.get(q.id) as (typeof rules)[number];
      const pred = r.pred === "other" ? "lookup" : r.pred;
      const plan = planFor(pred);
      const tool =
        q.intent === "write"
          ? pred === "write"
          : q.tools.includes(plan[0] as string);
      let args = false;
      let ms = r.ms;
      let calls = 1;
      const ch = choices.get(q.id) as Choices;
      if (arm === "A5") {
        args = scoreSlots(q, defaultSlots(q), ch).pass;
      } else if (pred === q.intent) {
        const s = slotByQ.get(q.id) ?? {};
        args = q.intent === "status" ? true : scoreSlots(q, s, ch).pass;
        const slotMs = slotRows.find((x) => x.id === q.id)?.ms ?? 0;
        ms += slotMs;
        calls = q.intent === "status" ? 1 : 2;
      } else {
        const s = await fillSlots(baseURL, hfId, q, pred, ch);
        args =
          pred === "status"
            ? false
            : scoreSlots(q, s.slots, ch).pass && q.intent === pred;
        ms += s.r?.ms ?? 0;
        calls = 2;
      }
      rows.push({
        id: q.id,
        tool,
        args: tool && args,
        ms: arm === "A5" ? r.ms : ms,
        calls: arm === "A5" ? 1 : calls,
      });
    }
    return rows;
  };
  const best = routes[bestKey] as (typeof rules)[number][];
  const arms: Record<string, E2E[]> = {
    A1: await e2e(
      "A1",
      best.filter((r) => r.id.startsWith("q")),
    ),
    A3: await e2e(
      "A3",
      rules.filter((r) => r.id.startsWith("q")),
    ),
    A5: await e2e(
      "A5",
      best.filter((r) => r.id.startsWith("q")),
    ),
  };
  rss.stop();
  await mod.stopMlxLlmWorker();
  out.shippedRssPeakMb = rss.peakMb;
  out.loadMs = loadMs;

  // ====================== phase 2: T1 on the dev worker with the flag ======================
  const t1Launcher =
    process.env.CHAT_EVAL_T1_WORKER ?? "/tmp/chatp0/worker-dev/run-worker.sh";
  const prevWorker = process.env.OPENSTYLE_MLX_LLM_WORKER;
  process.env.OPENSTYLE_MLX_LLM_WORKER = t1Launcher;
  process.env.OPENSTYLE_MLX_LLM_NATIVE_TOOLS = "1";
  const rss2 = new RssSampler(/--llm/);
  const t1: E2E[] = [];
  const t1Detail: { id: string; tool: string | null; ok: boolean }[] = [];
  let t1Err: string | null = null;
  try {
    const t1s = performance.now();
    const w2 = await mod.ensureMlxLlmWorker(MODEL_ID);
    out.t1LoadMs = performance.now() - t1s;
    rss2.start();
    await ask(w2.baseURL, w2.hfId, {
      messages: [{ role: "user", content: "Say ok." }],
      max_tokens: 4,
    });
    for (const q of qs) {
      const ch = choices.get(q.id) as Choices;
      const write = q.intent === "write";
      const r = await ask(w2.baseURL, w2.hfId, {
        messages: [
          { role: "system", content: t1System(ch, write) },
          ...(q.history.length
            ? [
                {
                  role: "user",
                  content: `Earlier: ${q.history
                    .slice(-2)
                    .map((h) => `${h.q} -> ${h.a}`)
                    .join(" | ")}`,
                },
              ]
            : []),
          { role: "user", content: q.text },
        ],
        tools: tools(ch, write),
        tool_choice: "auto",
        max_tokens: 200,
      });
      const call = r.toolCalls[0];
      const name = call?.name ?? null;
      const toolOk =
        name !== null &&
        (write ? name === goldWriteTool(q) : q.tools.includes(name));
      let argsOk = false;
      if (toolOk && call) {
        const slots = t1Slots(call.name, call.args);
        // The plan tools carry the same gold args; compare the filled keys.
        argsOk = q.intent === "status" ? true : scoreSlots(q, slots, ch).pass;
      }
      t1.push({
        id: q.id,
        tool: toolOk,
        args: argsOk,
        ms: r.ms,
        calls: r.toolCalls.length,
      });
      t1Detail.push({ id: q.id, tool: name, ok: toolOk });
    }
    rss2.stop();
  } catch (e) {
    t1Err = e instanceof Error ? e.message : String(e);
    log(`T1 failed: ${t1Err}`);
  } finally {
    await mod.stopMlxLlmWorker();
    process.env.OPENSTYLE_MLX_LLM_WORKER = prevWorker;
    delete process.env.OPENSTYLE_MLX_LLM_NATIVE_TOOLS;
  }
  if (t1.length) arms.T1 = t1;
  out.t1Rss = rss2.peakMb;
  out.t1Error = t1Err;

  // ---- table of arms ----
  const by = (rows: E2E[], f: (q: Question) => boolean) =>
    rows.filter((r) => f(qOf.get(r.id) as Question));
  text += `\nEnd to end on the 190 gold questions (tool choice = the first tool is in the gold plan; for write, the right propose tool; args = every gold arg matches):\n\n| arm | tool choice | args (all gold args) | both | p50 ms | p95 ms | no-write tool | no-write both | write tool | write both | no-count tool |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const [name, rows] of Object.entries(arms)) {
    const nw = by(rows, (q) => q.intent !== "write");
    const w = by(rows, (q) => q.intent === "write");
    const nc = by(rows, (q) => q.type !== "count");
    text += `| ${name} | ${pct(ratio(rows.map((r) => (r.tool ? 1 : 0))))} | ${pct(ratio(rows.map((r) => (r.args ? 1 : 0))))} | ${pct(ratio(rows.map((r) => (r.tool && r.args ? 1 : 0))))} | ${percentile(
      rows.map((r) => r.ms),
      50,
    ).toFixed(0)} | ${percentile(
      rows.map((r) => r.ms),
      95,
    ).toFixed(
      0,
    )} | ${pct(ratio(nw.map((r) => (r.tool ? 1 : 0))))} | ${pct(ratio(nw.map((r) => (r.tool && r.args ? 1 : 0))))} | ${pct(ratio(w.map((r) => (r.tool ? 1 : 0))))} | ${pct(ratio(w.map((r) => (r.tool && r.args ? 1 : 0))))} | ${pct(ratio(nc.map((r) => (r.tool ? 1 : 0))))} |\n`;
  }
  const t1calls = t1.map((r) => r.calls);
  if (t1.length)
    text += `\nT1: tool calls per answer: ${t1calls.filter((n) => n === 0).length} with no call, ${t1calls.filter((n) => n === 1).length} with one, ${t1calls.filter((n) => n > 1).length} with more. Worker load ${Math.round(out.t1LoadMs as number)} ms. T1 worker peak RSS ${rss2.peakMb} MB; shipped worker peak RSS ${rss.peakMb} MB.\n`;
  if (t1Err) text += `\nT1 FAILED: ${t1Err}\n`;
  out.arms = Object.fromEntries(
    Object.entries(arms).map(([k, rows]) => [k, rows]),
  );
  out.t1Detail = t1Detail;
  out.slotRows = slotRows;

  // ---- MLflow runs ----
  const runs: RunOut[] = [];
  const base = {
    "chat.stage": "router",
    "chat.corpus_hash": hashes.corpus,
    "chat.gold_hash": hashes.gold,
    "chat.model": MODEL_ID,
  };
  for (const [name, rows] of Object.entries(routes)) {
    runs.push({
      name: `router-stage1-${name}`,
      params: {
        arm: name,
        stage: "intent",
        questions: rows.length,
        model: MODEL_ID,
      },
      tags: base,
      metrics: {
        acc_all: accOf(rows),
        acc_gold: accOf(rows.filter((r) => r.id.startsWith("q"))),
        acc_extra: accOf(rows.filter((r) => r.id.startsWith("x"))),
        ...Object.fromEntries(
          Object.entries(byLang(rows)).map(([l, v]) => [`acc_${l}`, v]),
        ),
        latency_ms_p50: percentile(
          rows.map((r) => r.ms),
          50,
        ),
        latency_ms_p95: percentile(
          rows.map((r) => r.ms),
          95,
        ),
        invalid_json: rows.filter((r) => !r.valid).length,
      },
    });
  }
  for (const [name, rows] of Object.entries(arms)) {
    runs.push({
      name: `router-e2e-${name}`,
      params: {
        arm: name,
        stage: "tool_and_args",
        questions: rows.length,
        model: MODEL_ID,
      },
      tags: base,
      metrics: {
        tool_acc: ratio(rows.map((r) => (r.tool ? 1 : 0))),
        args_acc: ratio(rows.map((r) => (r.args ? 1 : 0))),
        both_acc: ratio(rows.map((r) => (r.tool && r.args ? 1 : 0))),
        latency_ms_p50: percentile(
          rows.map((r) => r.ms),
          50,
        ),
        latency_ms_p95: percentile(
          rows.map((r) => r.ms),
          95,
        ),
      },
    });
  }
  runs.push({
    name: "router-slot-fill-oracle",
    params: { stage: "slots", questions: slotRows.length, model: MODEL_ID },
    tags: base,
    metrics: {
      acc_strict: ratio(slotRows.map((r) => (r.pass ? 1 : 0))),
      acc_default_slots: ratio(noSlot.map((b) => (b ? 1 : 0))),
      shipped_rss_peak_mb: rss.peakMb,
      ...Object.fromEntries(
        [...keyAcc].map(([k, v]) => [`key_${k}`, ratio(v)]),
      ),
    },
  });
  return { text, result: out, runs };
}
