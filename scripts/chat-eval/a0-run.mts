// a0-run.mts: arm A0, the baseline (spec 8.5): the live chat as it is today. One
// context build (folder block, 3 newest summaries, 8 retrieved chunks), the
// live-chat system prompt, a lenient parse, no router, no tools. It has no
// meeting scope, so a scope M question runs with the folder of that meeting.
// A0 runs on the questions with a text, count or not-found key and a meeting or
// folder scope. The code under test is the live chat code itself
// (apps/server/src/lib/meetings/live/chat-context.ts and chat-prompt.ts).

import { mean, percentile, scoreAnswer } from "./keys.mts";
import type { RunOut, RunResult } from "./retrieval-run.mts";
import { bootStack, EMBED_MODEL_ID, loadCorpus, RssSampler } from "./stack.mts";
import type { Corpus, GoldSet, Question } from "./types.mts";

const MODEL_ID = process.env.CHAT_EVAL_MODEL ?? "gemma-4-e2b-qat-4bit";
const NOT_FOUND = /not found in the sources|n[aã]o encontrei nas fontes/i;
const pct = (x: number) => (x * 100).toFixed(1);

export async function runA0(
  corpus: Corpus,
  gold: GoldSet,
  hashes: { corpus: string; gold: string },
): Promise<RunResult> {
  const log = (s: string) =>
    console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
  const stack = await bootStack("a0", true);
  loadCorpus(stack, corpus);
  stack.mod.writeSetting("search_embedding_model", EMBED_MODEL_ID);
  for (const m of corpus.meetings) await stack.mod.indexMeeting(m.id);
  log("indexed");
  const live = await import(
    "../../apps/server/src/lib/meetings/live/chat-context.ts"
  );
  const prompt = await import(
    "../../apps/server/src/lib/meetings/live/chat-prompt.ts"
  );
  const llm = await import("../../apps/server/src/lib/mlx-llm/server.ts");
  const { baseURL, hfId } = await llm.ensureMlxLlmWorker(MODEL_ID);
  const rss = new RssSampler(/--llm/);
  rss.start();

  // A dummy "running" meeting per folder (and one unfiled), so retrieval and
  // summaries come from the folder, as in a live meeting.
  const dummy = new Map<string | null, string>();
  const ins = stack.db.prepare(
    "INSERT INTO meetings (id, title, started_at, status, folder_id, created_at) VALUES (?, 'Live now', ?, 'recording', ?, ?)",
  );
  for (const f of [...corpus.folders.map((x) => x.id), null]) {
    const id = `live-dummy-${f ?? "none"}`;
    ins.run(id, corpus.todayMs, f, corpus.todayMs);
    dummy.set(f, id);
  }
  const folderOf = (q: Question): string | null =>
    q.scope.kind === "folder"
      ? q.scope.id
      : (corpus.meetings.find((m) => m.id === q.scope.id)?.folderId ?? null);

  const qs = gold.questions.filter(
    (q) =>
      ["text", "not_found", "count"].includes(q.key.kind) &&
      (q.scope.kind === "meeting" || q.scope.kind === "folder"),
  );
  const rows: {
    q: Question;
    pass: boolean;
    notFound: boolean;
    ms: number;
    cites: number;
    validCites: number;
    goldCite: boolean;
    tokens: number;
  }[] = [];
  for (const q of qs) {
    const meetingId = dummy.get(folderOf(q)) as string;
    const ctx = await live.buildChatContext(stack.db, {
      meetingId,
      question: q.text,
      live: [],
      budgetTokens: 6000,
    });
    const user = `SOURCES:\n${ctx.sources || "(none)"}\n\nQUESTION: ${q.text}`;
    const history = q.history.slice(-2).flatMap((h) => [
      { role: "user", content: h.q },
      { role: "assistant", content: h.a },
    ]);
    const t0 = performance.now();
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: hfId,
        temperature: 0,
        max_tokens: 400,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: "system", content: prompt.CHAT_SYSTEM_PROMPT },
          ...history,
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(`worker HTTP ${res.status}`);
    const j = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number };
    };
    const reply = prompt.parseChatReply(j.choices[0]?.message.content ?? "");
    const notFound = NOT_FOUND.test(reply.answer);
    const valid = reply.cites.filter((c) => ctx.index.has(c));
    const goldMeetings = new Set(q.gold.map((g) => g.meetingId));
    const goldCite = valid.some((c) =>
      goldMeetings.has(ctx.index.get(c)?.meetingId ?? ""),
    );
    const score = scoreAnswer(
      { notFound, text: reply.answer, ids: [], proposal: null },
      q.key,
    );
    rows.push({
      q,
      pass: score.pass,
      notFound,
      ms,
      cites: reply.cites.length,
      validCites: valid.length,
      goldCite,
      tokens: j.usage?.prompt_tokens ?? 0,
    });
  }
  rss.stop();
  await llm.stopMlxLlmWorker();
  await stack.mod.stopMlxEmbedWorker();

  const group = (name: string, f: (r: (typeof rows)[number]) => boolean) => {
    const rs = rows.filter(f);
    return { name, n: rs.length, acc: mean(rs.map((r) => (r.pass ? 1 : 0))) };
  };
  const answerable = (r: (typeof rows)[number]) => r.q.key.kind !== "not_found";
  const table = [
    group("lookup", (r) => r.q.type === "lookup"),
    group("who_said", (r) => r.q.type === "who_said"),
    group("knowledge_update", (r) => r.q.type === "knowledge_update"),
    group("follow_up", (r) => r.q.type === "follow_up"),
    group("long_thread", (r) => r.q.type === "long_thread"),
    group("temporal (text)", (r) => r.q.type === "temporal"),
    group("count", (r) => r.q.type === "count"),
    group("not_answerable", (r) => r.q.type === "not_answerable"),
    group("scope_trap", (r) => r.q.type === "scope_trap"),
    group("answerable, all", answerable),
    group("not_found keys, all", (r) => r.q.key.kind === "not_found"),
    group("all", () => true),
  ].filter((g) => g.n > 0);
  const falseNf = mean(
    rows.filter(answerable).map((r) => (r.notFound ? 1 : 0)),
  );
  const invalidCites = rows.reduce((a, r) => a + (r.cites - r.validCites), 0);
  let text = `Arm A0 (the live chat as it is), model ${MODEL_ID}, temperature 0, corpus ${hashes.corpus}, gold ${hashes.gold}; ${rows.length} questions (meeting or folder scope, text, count or not-found key).\n\n| group | n | pass by key |\n|---|---|---|\n`;
  for (const g of table) text += `| ${g.name} | ${g.n} | ${pct(g.acc)} |\n`;
  text += `\nFalse not-found rate (answerable questions answered "not found"): ${pct(falseNf)}%. Cites: ${rows.reduce((a, r) => a + r.cites, 0)} given, ${invalidCites} not in the source list (code drops them). Answers that cite a source from the gold meeting: ${pct(mean(rows.filter(answerable).map((r) => (r.goldCite ? 1 : 0))))}%.\n`;
  text += `Latency p50 ${percentile(
    rows.map((r) => r.ms),
    50,
  ).toFixed(0)} ms, p95 ${percentile(
    rows.map((r) => r.ms),
    95,
  ).toFixed(0)} ms; prompt tokens p50 ${percentile(
    rows.map((r) => r.tokens),
    50,
  ).toFixed(0)}; LLM worker RSS peak ${rss.peakMb} MB.\n`;
  const metrics: Record<string, number> = {
    n: rows.length,
    false_not_found: falseNf,
    invalid_cites: invalidCites,
    latency_ms_p50: percentile(
      rows.map((r) => r.ms),
      50,
    ),
    latency_ms_p95: percentile(
      rows.map((r) => r.ms),
      95,
    ),
    rss_peak_mb: rss.peakMb,
  };
  for (const g of table)
    metrics[`acc.${g.name.replace(/[^a-z_]+/gi, "_")}`] = g.acc;
  const runs: RunOut[] = [
    {
      name: `a0-${MODEL_ID}`,
      params: { arm: "A0", model: MODEL_ID, questions: rows.length },
      tags: {
        "chat.stage": "a0",
        "chat.corpus_hash": hashes.corpus,
        "chat.gold_hash": hashes.gold,
        "chat.model": MODEL_ID,
      },
      metrics,
    },
  ];
  return {
    text,
    result: {
      table,
      rows: rows.map((r) => ({
        id: r.q.id,
        type: r.q.type,
        pass: r.pass,
        notFound: r.notFound,
        ms: r.ms,
      })),
    },
    runs,
  };
}
