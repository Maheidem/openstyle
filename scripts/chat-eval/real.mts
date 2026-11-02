// real.mts: the private regression of the Ask chat on real threads. It copies
// a DB (a read-only copy of the owner's DB, made by hand) to a scratch folder
// in /tmp, replays the QUESTIONS of the named threads through the real
// pipeline (runChatTurn, createChatLlm) with the default model of that DB,
// and writes numbers to stdout. The answer TEXTS go only to
// ~/Library/Application Support/Openstyle-eval/chat-real/ (never to the repo,
// never to MLflow, never to stdout). The scratch copy is deleted at the end.
// "Before" numbers come from the answers that the DB already stores.
//
//   pnpm chat-eval real --db <copy.db> --threads <id prefix>,<id prefix> [--label after]

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { DatabaseSync } from "node:sqlite";
import type { ChatBlock, ChatCite, ChatMessage } from "@openstyle/validations";
import { isRepeat } from "./p1-broad.mts";
import { answerText } from "./p1-dig.mts";
import { bootStack, scratchDir } from "./stack.mts";

export const REAL_OUT = join(
  homedir(),
  "Library",
  "Application Support",
  "Openstyle-eval",
  "chat-real",
);

export interface RealTurn {
  thread: string;
  turn: number;
  scope: string;
  sentences: number;
  cites: number;
  repeat: boolean;
  notFound: boolean;
  /** The `why` of a clarify block (D20), else null. A clarify turn is not an answer. */
  clarify: string | null;
  /** At least 2 sentences, at least 1 cite, no repeat, not "not found". */
  pass: boolean;
  /** Steps of the pipeline, names only (no owner text). */
  steps: string;
  answer: string;
}

/** Sentences of an answer: lines and sentence ends. */
export function countSentences(text: string): number {
  return text
    .split(/\n+|(?<=[.!?。])\s+/u)
    .map((t) => t.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((t) => t.length > 2).length;
}

function score(
  base: Pick<RealTurn, "thread" | "turn" | "scope" | "steps">,
  content: string,
  blocks: ChatBlock[],
  cites: number,
  earlier: string[],
): RealTurn {
  const notFound = blocks.some((b) => b.kind === "not_found");
  const text =
    content.trim() !== ""
      ? content
      : blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join(" ");
  const clarifyBlock = blocks.find((b) => b.kind === "clarify");
  const clarify = clarifyBlock?.kind === "clarify" ? clarifyBlock.why : null;
  const sentences = countSentences(text);
  const repeat = !notFound && isRepeat(text, earlier);
  return {
    ...base,
    sentences,
    cites,
    repeat,
    notFound,
    clarify,
    pass:
      clarify === null && !notFound && sentences >= 2 && cites >= 1 && !repeat,
    answer: text,
  };
}

/**
 * One turn of a digging thread on the owner's real folders (D21). The folder
 * has a letter, never a name. The answer text stays in the private file.
 */
export interface RealDigTurn extends RealTurn {
  folder: string;
  /** Meetings of the folder. */
  folderMeetings: number;
  /** Distinct meetings that the answer cites. */
  citedMeetings: number;
  llmCalls: number;
  toolCalls: number;
  ms: number;
}

/**
 * The 6 digging questions (D21), in generic words. Folders A and B get "what
 * is open, why is it still open"; folder C gets "how did the decisions change,
 * who pushed and why".
 */
export const REAL_DIG_THREADS: readonly (readonly string[])[] = [
  ["What are the open items in this folder?", "Why are they still open?"],
  ["What are the open items in this folder?", "Why are they still open?"],
  [
    "How did the decisions in this folder change over the meetings?",
    "Who pushed for the biggest change, and why?",
  ],
];

interface MsgRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  blocks_json: string | null;
  cites_json: string | null;
  trace_json: string | null;
}

export async function runReal(opts: {
  db: string;
  threads: string[];
  extra?: string[];
  /** Run the 6 digging questions on the 3 largest folders (D21). */
  dig?: boolean;
  label: string;
}): Promise<void> {
  const dir = scratchDir("real");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (!existsSync(opts.db)) throw new Error(`no such DB copy: ${opts.db}`);
  cpSync(opts.db, join(dir, "db.sqlite"));
  const stack = await bootStack("real", false);
  const db: DatabaseSync = stack.db;
  const s = (p: string) => import(`../../apps/server/src/lib/${p}`);
  const [pipeline, llmMod, settings] = await Promise.all([
    s("chat/pipeline.ts"),
    s("chat/llm.ts"),
    s("chat/settings.ts"),
  ]);
  process.env.OPENSTYLE_MLX_RERANK_WORKER ??=
    process.env.OPENSTYLE_MLX_LLM_WORKER;
  const out: {
    before: RealTurn[];
    after: RealTurn[];
    extra: RealTurn[];
    dig: RealDigTurn[];
  } = {
    before: [],
    after: [],
    extra: [],
    dig: [],
  };
  const runOne = async (
    scope: { kind: "all" },
    question: string,
    history: ChatMessage[],
    noClarify = false,
  ) => {
    const signal = AbortSignal.timeout(180_000);
    const llm = await llmMod.createChatLlm(db, {
      threadId: "real-extra",
      signal,
    });
    const res = await pipeline.runChatTurn({
      db,
      scope,
      question,
      history,
      settings: settings.readChatSettings(),
      llm,
      signal,
      ...(noClarify ? { noClarify: true } : {}),
    });
    llm.finish("succeeded");
    return res;
  };
  try {
    for (const prefix of opts.threads) {
      const th = db
        .prepare(
          "SELECT id, meeting_id, folder_id FROM chat_threads WHERE id LIKE ?",
        )
        .get(`${prefix}%`) as
        | { id: string; meeting_id: string | null; folder_id: string | null }
        | undefined;
      if (!th) throw new Error(`no thread ${prefix}`);
      const tag = prefix.slice(0, 8);
      const scope = th.meeting_id
        ? { kind: "meeting" as const, id: th.meeting_id }
        : th.folder_id
          ? { kind: "folder" as const, id: th.folder_id }
          : { kind: "all" as const };
      const msgs = db
        .prepare(
          "SELECT id, role, content, blocks_json, cites_json, trace_json FROM chat_messages WHERE thread_id = ? ORDER BY id",
        )
        .all(th.id) as unknown as MsgRow[];
      const questions = msgs.filter((m) => m.role === "user");
      // Before: the stored answer after each question (the last of a widen pair).
      const earlierBefore: string[] = [];
      for (const [i, q] of questions.entries()) {
        const idx = msgs.findIndex((m) => m.id === q.id);
        let a: MsgRow | undefined;
        for (let j = idx + 1; msgs[j]?.role === "assistant"; j++) a = msgs[j];
        const blocks = JSON.parse(a?.blocks_json ?? "[]") as ChatBlock[];
        const cites = JSON.parse(a?.cites_json ?? "[]") as ChatCite[];
        const steps = (
          JSON.parse(a?.trace_json ?? "null") as {
            steps?: { stage: string; name: string }[];
          } | null
        )?.steps;
        const row = score(
          {
            thread: tag,
            turn: i + 1,
            scope: scope.kind,
            steps: (steps ?? []).map((x) => `${x.stage}:${x.name}`).join(" > "),
          },
          a?.content ?? "",
          blocks,
          cites.length,
          earlierBefore,
        );
        earlierBefore.push(row.answer);
        out.before.push(row);
      }
      // After: the same questions through the current pipeline, with the new answers as history.
      const history: ChatMessage[] = [];
      const earlier: string[] = [];
      let mid = 1;
      for (const [i, q] of questions.entries()) {
        const signal = AbortSignal.timeout(180_000);
        const llm = await llmMod.createChatLlm(db, {
          threadId: `real-${tag}`,
          signal,
        });
        const res = await pipeline.runChatTurn({
          db,
          scope,
          question: q.content,
          history: [...history],
          settings: settings.readChatSettings(),
          llm,
          signal,
        });
        llm.finish("succeeded");
        const row = score(
          {
            thread: tag,
            turn: i + 1,
            scope: scope.kind,
            steps: res.trace.steps
              .map(
                (x: { stage: string; name: string }) => `${x.stage}:${x.name}`,
              )
              .join(" > "),
          },
          res.content,
          res.blocks,
          res.cites.length,
          earlier,
        );
        earlier.push(row.answer);
        out.after.push(row);
        const mk = {
          thread_id: `real-${tag}`,
          trace: null,
          model_id: null,
          provider: null,
          ms: null,
          created_at: 0,
        };
        history.push(
          {
            ...mk,
            id: mid++,
            role: "user",
            content: q.content,
            blocks: [],
            cites: [],
          },
          {
            ...mk,
            id: mid++,
            role: "assistant",
            content: res.content,
            blocks: res.blocks,
            cites: res.cites,
          },
        );
      }
    }
    // New ambiguous-style questions at Everything: the first turn, then the
    // first chip as the next question (a clarify turn only).
    for (const [i, q] of (opts.extra ?? []).entries()) {
      const all = { kind: "all" as const };
      const mkRow = (turn: number, res: Awaited<ReturnType<typeof runOne>>) =>
        score(
          {
            thread: `extra${i + 1}`,
            turn,
            scope: "all",
            steps: res.trace.steps
              .map(
                (x: { stage: string; name: string }) => `${x.stage}:${x.name}`,
              )
              .join(" > "),
          },
          res.content,
          res.blocks,
          res.cites.length,
          [],
        );
      const first = await runOne(all, q, []);
      const r1 = mkRow(1, first);
      out.extra.push(r1);
      const block = first.blocks.find((b) => b.kind === "clarify");
      if (block?.kind === "clarify") {
        const mk = {
          thread_id: "real-extra",
          trace: null,
          model_id: null,
          provider: null,
          ms: null,
          created_at: 0,
        };
        const chip = block.options[0];
        if (chip) {
          const hist: ChatMessage[] = [
            { ...mk, id: 1, role: "user", content: q, blocks: [], cites: [] },
            {
              ...mk,
              id: 2,
              role: "assistant",
              content: first.content,
              blocks: first.blocks,
              cites: first.cites,
            },
          ];
          out.extra.push(mkRow(2, await runOne(all, chip.ask, hist)));
        }
        // "Answer anyway" for the same question.
        out.extra.push(mkRow(3, await runOne(all, q, [], true)));
      }
    }
    // Digging questions (D21) on the 3 folders with the most meetings.
    if (opts.dig) {
      const folders = db
        .prepare(
          `SELECT f.id AS id, COUNT(m.id) AS n FROM meeting_folders f
           JOIN meetings m ON m.folder_id = f.id
           GROUP BY f.id HAVING n >= 4 ORDER BY n DESC, f.id LIMIT 3`,
        )
        .all() as unknown as { id: string; n: number }[];
      const mk = {
        trace: null,
        model_id: null,
        provider: null,
        ms: null,
        created_at: 0,
      };
      for (const [fi, f] of folders.entries()) {
        const letter = String.fromCharCode(65 + fi);
        const scope = { kind: "folder" as const, id: f.id };
        const history: ChatMessage[] = [];
        const earlier: string[] = [];
        let mid = 1;
        for (const [ti, q] of (REAL_DIG_THREADS[fi] ?? []).entries()) {
          const signal = AbortSignal.timeout(300_000);
          const t0 = Date.now();
          const llm = await llmMod.createChatLlm(db, {
            threadId: `real-dig-${letter}`,
            signal,
          });
          // Privacy gate: the owner's meetings go to the local model only.
          if (llm.provider !== "local-mlx-llm") {
            llm.finish("cancelled");
            throw new Error(
              `dig stops: the chat model is not the local MLX model (${llm.provider})`,
            );
          }
          const res = await pipeline.runChatTurn({
            db,
            scope,
            question: q,
            history: [...history],
            settings: settings.readChatSettings(),
            llm,
            signal,
          });
          llm.finish("succeeded");
          const text = answerText(res);
          const row = score(
            {
              thread: `dig${letter}`,
              turn: ti + 1,
              scope: "folder",
              steps: res.trace.steps
                .map(
                  (x: { stage: string; name: string }) =>
                    `${x.stage}:${x.name}`,
                )
                .join(" > "),
            },
            text,
            res.blocks,
            res.cites.length,
            earlier,
          );
          const cited = new Set<string>(res.cites.map((c) => c.meeting_id));
          for (const b of res.blocks)
            if (b.kind === "list")
              for (const it of b.items)
                if (it.meeting_id) cited.add(it.meeting_id);
          out.dig.push({
            ...row,
            folder: letter,
            folderMeetings: f.n,
            citedMeetings: cited.size,
            llmCalls: res.trace.calls,
            toolCalls: res.toolCalls.length,
            ms: Date.now() - t0,
          });
          earlier.push(text);
          history.push(
            {
              ...mk,
              thread_id: `real-dig-${letter}`,
              id: mid++,
              role: "user",
              content: q,
              blocks: [],
              cites: [],
            },
            {
              ...mk,
              thread_id: `real-dig-${letter}`,
              id: mid++,
              role: "assistant",
              content: res.content,
              blocks: res.blocks,
              cites: res.cites,
            },
          );
        }
      }
    }
    mkdirSync(REAL_OUT, { recursive: true, mode: 0o700 });
    const file = join(REAL_OUT, `${opts.label}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
    // Numbers only on stdout.
    for (const [name, rows] of Object.entries(out)) {
      if (rows.length === 0) continue;
      console.log(
        `\n${name}: thread turn scope sentences cites repeat notFound pass`,
      );
      for (const r of rows)
        console.log(
          `${name} ${r.thread} ${r.turn} ${r.scope} clarify=${r.clarify ?? "no"} sentences=${r.sentences} cites=${r.cites} repeat=${r.repeat ? "yes" : "no"} not_found=${r.notFound ? "yes" : "no"} ${r.pass ? "PASS" : "FAIL"}${"llmCalls" in r ? ` folder=${(r as RealDigTurn).folder} folder_meetings=${(r as RealDigTurn).folderMeetings} cited_meetings=${(r as RealDigTurn).citedMeetings} llm_calls=${(r as RealDigTurn).llmCalls} tool_calls=${(r as RealDigTurn).toolCalls} ms=${(r as RealDigTurn).ms}` : ""}`,
        );
    }
    console.log(`\nresult file (private): ${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
