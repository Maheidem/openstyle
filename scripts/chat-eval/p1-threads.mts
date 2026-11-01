// p1-threads.mts: the multi-turn thread regression of the Ask tab (P1.2,
// branch fix/ask-followups-thread-persist). One thread is 5 turns in one
// meeting: a fact, "why?", "who said that?", a topic switch and "what was this
// meeting about?". The REAL answer of each turn goes into the history of the
// next turn (the gold set shows gold answers instead). A turn passes by key:
// a text key for a fact, a switch, a speaker or the topic of the meeting.
// A "why?" has no key (the corpus holds no reasons): it passes when its
// answer is not a repeat. "The sources do not say" is a right answer to it. A repeat is an answer that is the same as the answer of an earlier
// turn with another question (Jaccard overlap of the words >= 0.8). The keys are code.

import type { ChatMessage } from "@openstyle/validations";
import { mean, normalize, scoreAnswer } from "./keys.mts";
import { answerFromTurn, type IdMaps } from "./p1-score.mts";
import type { Corpus, ThreadQ, ThreadTurn } from "./types.mts";

export interface ThreadRow {
  thread: string;
  turn: number;
  kind: ThreadTurn["kind"];
  question: string;
  pass: boolean;
  repeat: boolean;
  leak: boolean;
  notFound: boolean;
  tool: string | null;
  cites: string[];
  answer: string;
  err: string | null;
}

const tokens = (s: string): Set<string> =>
  new Set(
    normalize(s)
      .split(" ")
      .filter((w) => w.length > 1),
  );

/** Jaccard overlap of the token sets: 1 for the same words. */
export function overlap(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}

const REPEAT_AT = 0.8;
/** A cite marker as the model writes it: [S1], [S1, S2], (S1), S1. */
const MARKER = /\[\s*S\d+\s*(?:[,;]\s*S\d+\s*)*\]|\(\s*S\d+\s*\)/;

interface ThreadEnv {
  corpus: Corpus;
  maps: IdMaps;
  stack: { db: import("node:sqlite").DatabaseSync };
  mods: {
    pipeline: typeof import("../../apps/server/src/lib/chat/pipeline.ts");
    llm: typeof import("../../apps/server/src/lib/chat/llm.ts");
    settings: typeof import("../../apps/server/src/lib/chat/settings.ts");
  };
  log: (s: string) => void;
}

export async function runThread(
  env: ThreadEnv,
  th: ThreadQ,
): Promise<ThreadRow[]> {
  const { mods, stack, corpus, maps } = env;
  const history: ChatMessage[] = [];
  const earlier: { q: string; a: string }[] = [];
  const rows: ThreadRow[] = [];
  let id = 1;
  for (const [i, turn] of th.turns.entries()) {
    const signal = AbortSignal.timeout(120_000);
    const base = {
      thread: th.id,
      turn: i + 1,
      kind: turn.kind,
      question: turn.text,
    };
    let llm: Awaited<ReturnType<typeof mods.llm.createChatLlm>> | null = null;
    try {
      llm = await mods.llm.createChatLlm(stack.db, {
        threadId: `eval-${th.id}`,
        signal,
      });
      const res = await mods.pipeline.runChatTurn({
        db: stack.db,
        scope: { kind: th.scope.kind, id: th.scope.id } as never,
        question: turn.text,
        history: [...history],
        settings: mods.settings.readChatSettings(),
        llm,
        signal,
        now: corpus.todayMs,
        allowProposals: false,
      });
      llm.finish("succeeded");
      const key = turn.key ?? { kind: "not_found" as const };
      const ans = answerFromTurn(res, maps, key);
      const text = res.content;
      const repeat =
        !ans.notFound &&
        text.trim() !== "" &&
        earlier.some(
          (e) => e.q !== turn.text && overlap(e.a, text) >= REPEAT_AT,
        );
      const pass =
        turn.key === null
          ? !repeat
          : scoreAnswer(ans, turn.key).pass && !repeat;
      rows.push({
        ...base,
        pass,
        repeat,
        leak: MARKER.test(text),
        notFound: ans.notFound,
        tool: res.toolCalls[0]?.tool ?? null,
        cites: res.cites.map((c) => `${c.label}@${c.start_ms}`),
        answer: text.slice(0, 300),
        err: null,
      });
      earlier.push({ q: turn.text, a: text });
      const mk = {
        thread_id: `eval-${th.id}`,
        trace: null,
        model_id: null,
        provider: null,
        ms: null,
        created_at: 0,
      };
      history.push(
        {
          ...mk,
          id: id++,
          role: "user",
          content: turn.text,
          blocks: [],
          cites: [],
        },
        {
          ...mk,
          id: id++,
          role: "assistant",
          content: res.content,
          blocks: res.blocks,
          cites: res.cites,
        },
      );
    } catch (e) {
      llm?.finish("failed", { errorDetail: String(e).slice(0, 200) });
      rows.push({
        ...base,
        pass: false,
        repeat: false,
        leak: false,
        notFound: false,
        tool: null,
        cites: [],
        answer: "",
        err: String(e).slice(0, 200),
      });
      break;
    }
  }
  return rows;
}

export function summarize(rows: ThreadRow[]): Record<string, number> {
  const m: Record<string, number> = {};
  m.turns = rows.length;
  m.errors = rows.filter((r) => r.err).length;
  m.acc = mean(rows.map((r) => (r.pass ? 1 : 0)));
  m.repeats = rows.filter((r) => r.repeat).length;
  m.leaks = rows.filter((r) => r.leak).length;
  for (const k of [
    "decided",
    "fact",
    "why",
    "switch",
    "who",
    "overview",
  ] as const) {
    const rs = rows.filter((r) => r.kind === k);
    if (rs.length > 0) m[`acc.${k}`] = mean(rs.map((r) => (r.pass ? 1 : 0)));
    m[`n.${k}`] = rs.length;
  }
  const ids = [...new Set(rows.map((r) => r.thread))];
  m.threads = ids.length;
  m.threads_all_pass = ids.filter((t) =>
    rows.filter((r) => r.thread === t).every((r) => r.pass),
  ).length;
  return m;
}
