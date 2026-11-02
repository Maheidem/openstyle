// p1-dig.mts: the "dig" part of the chat eval (D21, spec 11.9). A digging
// question needs more than one search: "what are the open items", then "why
// are they open?"; "what blocked X?"; "how did decision Y evolve across the
// meetings?"; "who pushed for Z and why?"; "what changed between the first
// and the last meeting?"; "is anything still unresolved about W?". The data
// is `dig-corpus.mts`: the reasons sit in 2 to 4 meetings, most of them in the
// transcript only. Keys are code (no judge). A turn is measured on:
//   (a) coverage: the share of the must-mention reasons and facts that the
//       answer names (a group holds alternative spellings),
//   (b) cross-meeting recall: the share of the meetings that hold a reason
//       and that the answer cites,
//   (c) cite validity: no invalid cite, no text block without a cite,
//   (d) no repeat of an earlier answer of the thread,
//   (e) answer length in range.
// It also records the LLM calls, the tool calls and the latency of each turn.
// "Control" questions ask a simple fact. They must stay cheap (round 1).

import type { ChatMessage } from "@openstyle/validations";
import {
  DIG_CEDAR_ID,
  DIG_LAGOA_ID,
  DIG_ORCHARD_ID,
  digMeetingId,
} from "./dig-corpus.mts";
import { mean, normalize } from "./keys.mts";
import { isRepeat } from "./p1-broad.mts";
import { checkCites } from "./p1-score.mts";
import type { Lang, Scope } from "./types.mts";

export type DigKind =
  | "list"
  | "why"
  | "blocker"
  | "evolve"
  | "pushed"
  | "changed"
  | "unresolved"
  | "fact";

export interface DigTurn {
  kind: DigKind;
  text: string;
  /** Must-mention groups. A group holds alternatives; one is enough. */
  groups: string[][];
  /** Tokens the answer must not hold (a done item in a list of open items). */
  mustNot: string[];
  /** The meetings that hold a reason. The answer should cite them. */
  meetings: string[];
  /** Share of `groups` that the answer must name. */
  minCov: number;
}
export interface DigQ {
  id: string;
  lang: Lang;
  scope: Scope;
  /** A simple fact: it must finish in round 1 with few calls. */
  control: boolean;
  turns: DigTurn[];
}

const orc = (...n: number[]) => n.map((x) => digMeetingId("orc", x));
const lag = (...n: number[]) => n.map((x) => digMeetingId("lag", x));
const ced = (...n: number[]) => n.map((x) => digMeetingId("ced", x));

/** Two of three groups (a plain 0.67 would fail 2 of 3 by rounding). */
const TWO_THIRDS = 2 / 3 - 1e-9;

const T = (
  kind: DigKind,
  text: string,
  groups: string[][],
  meetings: string[],
  minCov = 0.6,
  mustNot: string[] = [],
): DigTurn => ({ kind, text, groups, mustNot, meetings, minCov });

// --- Reason groups (spelling alternatives; the key normalizes both sides) ---
const KESTREL_WHY = [["frankfurt", "dublin"], ["36"], ["budget freeze"]];
const OPEN_ORCHARD = [["kestrel"], ["freeze the public api", "api freeze"]];
const OPEN_ORCHARD_WHY = [
  ...KESTREL_WHY,
  ["export", "audit log"],
  ["28 october"],
];
const PUSHED_API = [["omar"], ["14"], ["audit", "3 december"]];
const SIGNIN_EVOLVE = [["aldoro"], ["brumel"], ["scim"], ["contractors"]];
const OPEN_LAGOA = [["publicar o app"], ["certificado"]];
const WHY_LAGOA = [["icone"], ["certificado"], ["privacidade"]];
const PUSHED_DELAY = [["nadia"], ["bateria"], ["aparelhos antigos"]];

export function buildDig(): DigQ[] {
  const O: Scope = { kind: "folder", id: DIG_ORCHARD_ID };
  const L: Scope = { kind: "folder", id: DIG_LAGOA_ID };
  const C: Scope = { kind: "folder", id: DIG_CEDAR_ID };
  const A: Scope = { kind: "all", id: null };
  const M = (id: string): Scope => ({ kind: "meeting", id });
  const out: DigQ[] = [];
  const add = (lang: Lang, scope: Scope, turns: DigTurn[], control = false) => {
    out.push({
      id: `dg${String(out.length + 1).padStart(2, "0")}`,
      lang,
      scope,
      control,
      turns,
    });
  };

  // ---- Orchard Platform, folder scope, EN ----
  add("en", O, [
    T(
      "list",
      "What are the open items in this project?",
      OPEN_ORCHARD,
      orc(1, 2),
      1,
      ["onboarding guide"],
    ),
    T("why", "Why are these still open?", OPEN_ORCHARD_WHY, orc(2, 3, 4)),
  ]);
  add("en", O, [
    T("fact", "Who owns the Kestrel contract?", [["beatriz"]], orc(1), 1),
    T("blocker", "What has blocked it so far?", KESTREL_WHY, orc(2, 3, 4)),
  ]);
  add("en", O, [
    T(
      "fact",
      "What did the team decide about sign-in?",
      [["brumel"]],
      orc(3, 5),
      1,
    ),
    T(
      "evolve",
      "How did that decision evolve across the meetings?",
      SIGNIN_EVOLVE,
      orc(1, 3, 5),
      0.75,
    ),
  ]);
  add("en", O, [
    T("fact", "Who proposed the API freeze?", [["omar"]], orc(2), 1),
    T(
      "pushed",
      "Why did he push for it?",
      [["14"], ["audit", "3 december"]],
      orc(2, 4),
      0.5,
    ),
  ]);
  add("en", O, [
    T(
      "fact",
      "What was the release budget at the kickoff?",
      [["80000"]],
      orc(1),
      1,
    ),
    T(
      "changed",
      "What changed between the first and the last meeting of this project?",
      [["80000"], ["95000"], ["brumel"], ["frankfurt"]],
      orc(1, 5),
      0.5,
    ),
  ]);
  add("en", O, [
    T(
      "unresolved",
      "Is anything still unresolved about sign-in?",
      [["hardware keys"], ["phishing", "2400"]],
      orc(5),
      0.5,
    ),
  ]);

  // ---- Projeto Lagoa, folder scope, PT ----
  add("pt", L, [
    T(
      "list",
      "Quais são os itens em aberto neste projeto?",
      OPEN_LAGOA,
      lag(1, 3),
      1,
      ["plano de testes"],
    ),
    T(
      "why",
      "Por que eles ainda estão em aberto?",
      WHY_LAGOA,
      lag(2, 3, 4),
      TWO_THIRDS,
    ),
  ]);
  add("pt", L, [
    T(
      "blocker",
      "O que bloqueou a publicação do app na loja de testes?",
      WHY_LAGOA,
      lag(2, 3, 4),
      TWO_THIRDS,
    ),
  ]);
  add("pt", L, [
    T("fact", "Quem quer adiar o lançamento?", [["nadia"]], lag(2, 3), 1),
    T(
      "pushed",
      "Por que ela defende isso?",
      [["bateria"], ["aparelhos antigos"]],
      lag(2, 3, 4),
      0.5,
    ),
  ]);
  add("pt", L, [
    T(
      "fact",
      "Qual é a situação da escolha do provedor de push?",
      [["pushwave", "notiq"]],
      lag(1, 4),
      1,
    ),
    T(
      "unresolved",
      "Por que isso ainda não foi decidido?",
      [["notiq"], ["1200"], ["pushwave"]],
      lag(3, 4),
      TWO_THIRDS,
    ),
  ]);
  add("pt", L, [
    T(
      "fact",
      "Quando está previsto o lançamento do app?",
      [["15 de janeiro"]],
      lag(4),
      1,
    ),
    T(
      "evolve",
      "Como essa data mudou ao longo das reuniões?",
      [["1 de dezembro"], ["15 de dezembro"], ["15 de janeiro"]],
      lag(1, 3, 4),
      TWO_THIRDS,
    ),
  ]);

  // ---- Cedar Rollout, folder scope, EN ----
  add("en", C, [
    T(
      "list",
      "What are the open items in this project?",
      [["order the pilot kits"], ["safety check"]],
      ced(1, 3),
      1,
    ),
    T(
      "why",
      "Why are they still open?",
      [["zorvan"], ["customs"], ["10 kits"]],
      ced(2, 3, 4),
      TWO_THIRDS,
    ),
  ]);
  add("en", C, [
    T(
      "fact",
      "Which sites are in the pilot?",
      [["porto"], ["lyon"]],
      ced(4),
      1,
    ),
    T(
      "unresolved",
      "Is anything still unresolved about the pilot sites?",
      [["porto", "lyon"]],
      ced(4),
      1,
    ),
  ]);
  add("en", C, [
    T(
      "changed",
      "What changed between the first and the last meeting of this project?",
      [["40"], ["24"], ["porto"], ["madrid", "milan"]],
      ced(1, 4),
      0.5,
    ),
  ]);
  add("en", C, [
    T(
      "evolve",
      "How did the pilot sites decision evolve across the meetings?",
      [["madrid"], ["milan"], ["porto"]],
      ced(1, 2, 3, 4),
      TWO_THIRDS,
    ),
  ]);
  add("en", C, [
    T(
      "pushed",
      "Who pushed to drop Milan and why?",
      [["omar"], ["network"]],
      ced(3),
      1,
    ),
  ]);

  // ---- Everything scope ----
  add("en", A, [
    T("fact", "What is the Kestrel hosting contract?", [["kestrel"]], [], 1),
    T(
      "blocker",
      "What blocked it?",
      [...KESTREL_WHY, ["99.5"]],
      [...orc(2, 3, 4), ...ced(2)],
      0.5,
    ),
  ]);
  add("en", A, [
    T(
      "list",
      "What are the open items in the Orchard Platform project?",
      OPEN_ORCHARD,
      orc(1, 2),
      1,
      ["onboarding guide"],
    ),
    T("why", "Why are they still open?", OPEN_ORCHARD_WHY, orc(2, 3, 4)),
  ]);
  add("pt", A, [
    T(
      "list",
      "Quais são os itens em aberto do projeto Lagoa?",
      OPEN_LAGOA,
      lag(1, 3),
      1,
      ["plano de testes"],
    ),
    T(
      "why",
      "Por que eles ainda estão em aberto?",
      WHY_LAGOA,
      lag(2, 3, 4),
      TWO_THIRDS,
    ),
  ]);
  add("en", A, [
    T(
      "pushed",
      "Who pushed for the API freeze in the Orchard Platform project and why?",
      PUSHED_API,
      orc(2, 4),
      TWO_THIRDS,
    ),
  ]);
  add("pt", A, [
    T(
      "pushed",
      "Quem defendeu adiar o lançamento do app do projeto Lagoa e por quê?",
      PUSHED_DELAY,
      lag(2, 3, 4),
      TWO_THIRDS,
    ),
  ]);
  add("en", A, [
    T(
      "evolve",
      "How did the sign-in decision of the Orchard Platform project evolve across the meetings?",
      SIGNIN_EVOLVE,
      orc(1, 3, 5),
      0.75,
    ),
  ]);
  add("en", A, [
    T(
      "unresolved",
      "Is anything still unresolved about the Kestrel hosting contract?",
      [["budget freeze"], ["99.5"], ["36"]],
      [...orc(3, 4), ...ced(2)],
      0.5,
    ),
  ]);
  add("en", A, [
    T(
      "changed",
      "What changed between the first and the last meeting of the Orchard Platform project?",
      [["80000"], ["95000"], ["brumel"]],
      orc(1, 5),
      TWO_THIRDS,
    ),
  ]);

  // ---- Meeting scope (the reasons are in the meeting) ----
  add("en", M(digMeetingId("orc", 2)), [
    T(
      "list",
      "What is still open in this meeting?",
      [["public api", "api freeze"], ["frankfurt"]],
      orc(2),
      1,
    ),
    T(
      "why",
      "Why are they still open?",
      [["dublin"], ["endpoints"]],
      orc(2),
      0.5,
    ),
  ]);
  add("pt", M(digMeetingId("lag", 3)), [
    T(
      "list",
      "O que ainda está em aberto nesta reunião?",
      [["certificado"]],
      lag(3),
      1,
    ),
    T(
      "why",
      "Por que isso ainda não foi resolvido?",
      [["apple", "3 de outubro"], ["nao chegou"]],
      lag(3),
      0.5,
    ),
  ]);
  add("en", M(digMeetingId("ced", 3)), [
    T(
      "blocker",
      "What blocked the pilot kits in this meeting?",
      [["customs"], ["safety certificate"]],
      ced(3),
      1,
    ),
  ]);
  add("en", M(digMeetingId("orc", 3)), [
    T(
      "evolve",
      "What was decided in this meeting and why?",
      [["brumel"], ["scim"]],
      orc(3),
      1,
    ),
  ]);

  // ---- Controls: a simple fact must finish in round 1 ----
  add(
    "en",
    A,
    [T("fact", "Who owns the Kestrel hosting contract?", [["beatriz"]], [], 1)],
    true,
  );
  add(
    "en",
    O,
    [T("fact", "How much is the release budget now?", [["95000"]], [], 1)],
    true,
  );
  add(
    "pt",
    L,
    [
      T(
        "fact",
        "Quem é o responsável por publicar o app na loja de testes?",
        [["felipe"]],
        [],
        1,
      ),
    ],
    true,
  );
  add(
    "en",
    M(digMeetingId("orc", 5)),
    [
      T(
        "fact",
        "What is the release budget in this meeting?",
        [["95000"]],
        [],
        1,
      ),
    ],
    true,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface DigRow {
  id: string;
  turn: number;
  scope: Scope["kind"];
  lang: Lang;
  kind: DigKind;
  control: boolean;
  question: string;
  pass: boolean;
  notFound: boolean;
  clarify: boolean;
  err: string | null;
  /** Share of the must-mention groups that the answer names. */
  cov: number;
  covHit: number;
  covOf: number;
  forbidden: number;
  /** Share of the expected meetings that the answer cites; null when none is expected. */
  recall: number | null;
  citedMeetings: number;
  citesShown: number;
  invalidCites: number;
  uncited: number;
  repeat: boolean;
  lenOk: boolean;
  blocks: number;
  chars: number;
  /** LLM calls of the turn, tool calls of the turn, and the first tool. */
  llmCalls: number;
  toolCalls: number;
  tool: string | null;
  ms: number;
  answer: string;
  trace: string;
  /** The research mode ran for this turn (the trace holds `research`). */
  research: boolean;
  /** The time of each checkpoint write of the turn, in ms. */
  ckptMs: number[];
}

const has = (norm: string, g: string[]): boolean =>
  g.some((alt) => {
    const a = normalize(alt);
    return a !== "" && ` ${norm} `.includes(` ${a} `);
  });

/** The text of an answer, list items included (a list block has no content text). */
export function answerText(res: {
  content: string;
  blocks: ChatMessage["blocks"];
}): string {
  const parts: string[] = [res.content];
  for (const b of res.blocks) {
    if (b.kind === "list")
      for (const it of b.items)
        parts.push([it.text, it.owner ?? "", it.meeting_title ?? ""].join(" "));
    if (b.kind === "status") parts.push(b.bullets.join(" "));
    if (b.kind === "text" && res.content === "") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

export interface DigEnv {
  corpusTodayMs: number;
  stack: { db: import("node:sqlite").DatabaseSync };
  mods: {
    pipeline: typeof import("../../apps/server/src/lib/chat/pipeline.ts");
    llm: typeof import("../../apps/server/src/lib/chat/llm.ts");
    settings: typeof import("../../apps/server/src/lib/chat/settings.ts");
  };
  known: Parameters<typeof checkCites>[1];
}

export async function runDig(env: DigEnv, q: DigQ): Promise<DigRow[]> {
  const { mods, stack } = env;
  const history: ChatMessage[] = [];
  const earlier: string[] = [];
  const rows: DigRow[] = [];
  let mid = 1;
  for (const [i, t] of q.turns.entries()) {
    const signal = AbortSignal.timeout(240_000);
    const t0 = Date.now();
    const base = {
      id: q.id,
      turn: i + 1,
      scope: q.scope.kind,
      lang: q.lang,
      kind: t.kind,
      control: q.control,
      question: t.text,
    };
    let llm: Awaited<ReturnType<typeof mods.llm.createChatLlm>> | null = null;
    const ckptMs: number[] = [];
    try {
      llm = await mods.llm.createChatLlm(stack.db, {
        threadId: `eval-${q.id}`,
        signal,
      });
      const res = await mods.pipeline.runChatTurn({
        db: stack.db,
        scope: { kind: q.scope.kind, id: q.scope.id } as never,
        question: t.text,
        history: [...history],
        settings: mods.settings.readChatSettings(),
        llm,
        signal,
        now: env.corpusTodayMs,
        allowProposals: false,
        onCheckpointMs: (ms) => ckptMs.push(ms),
        ...(process.env.CHAT_EVAL_REFLECT === "off"
          ? { researchReflect: false }
          : {}),
      });
      llm.finish("succeeded");
      const nf = res.blocks.some((b) => b.kind === "not_found");
      const clarify = res.blocks.some((b) => b.kind === "clarify");
      const text = answerText(res);
      const norm = normalize(text);
      const covHit = t.groups.filter((g) => has(norm, g)).length;
      const cov = t.groups.length === 0 ? 1 : covHit / t.groups.length;
      const forbidden = t.mustNot.filter((m) => has(norm, [m])).length;
      const cited = new Set<string>(res.cites.map((c) => c.meeting_id));
      for (const b of res.blocks)
        if (b.kind === "list")
          for (const it of b.items) if (it.meeting_id) cited.add(it.meeting_id);
      const want = new Set(t.meetings);
      const recall =
        want.size === 0
          ? null
          : [...want].filter((m) => cited.has(m)).length / want.size;
      const chk = checkCites(res, env.known);
      const textBlocks = res.blocks.filter((b) => b.kind === "text");
      const uncited = textBlocks.filter(
        (b) => b.kind === "text" && b.cites.length === 0,
      ).length;
      const repeat = !nf && isRepeat(text, earlier);
      // A list answer is a block. A control or fact answer is short. A digging answer
      // has 1 to 9 text blocks and 60 to 1800 characters.
      const lenOk =
        t.kind === "list"
          ? text.length > 0
          : q.control || t.kind === "fact"
            ? textBlocks.length >= 1 && text.length <= 500
            : textBlocks.length >= 1 &&
              textBlocks.length <= 9 &&
              text.length >= 60 &&
              text.length <= 1800;
      const recallOk = recall === null || want.size < 2 || recall >= 0.5;
      const pass =
        !nf &&
        !clarify &&
        cov >= t.minCov &&
        forbidden === 0 &&
        recallOk &&
        chk.invalid.length === 0 &&
        uncited === 0 &&
        !repeat &&
        lenOk;
      rows.push({
        ...base,
        pass,
        notFound: nf,
        clarify,
        err: null,
        cov,
        covHit,
        covOf: t.groups.length,
        forbidden,
        recall,
        citedMeetings: cited.size,
        citesShown: chk.shown,
        invalidCites: chk.invalid.length,
        uncited,
        repeat,
        lenOk,
        blocks: textBlocks.length,
        chars: text.length,
        llmCalls: res.trace.calls,
        toolCalls: res.toolCalls.length,
        tool: res.toolCalls[0]?.tool ?? null,
        ms: Date.now() - t0,
        answer: text,
        trace: res.trace.steps
          .map((x) => `${x.stage}:${x.name}${x.note ? `(${x.note})` : ""}`)
          .join(" > "),
        research: res.trace.research !== undefined,
        ckptMs,
      });
      earlier.push(text);
      const mk = {
        thread_id: `eval-${q.id}`,
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
          content: t.text,
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
    } catch (e) {
      llm?.finish("failed", { errorDetail: String(e).slice(0, 200) });
      rows.push({
        ...base,
        pass: false,
        notFound: false,
        clarify: false,
        err: String(e).slice(0, 200),
        cov: 0,
        covHit: 0,
        covOf: t.groups.length,
        forbidden: 0,
        recall: null,
        citedMeetings: 0,
        citesShown: 0,
        invalidCites: 0,
        uncited: 0,
        repeat: false,
        lenOk: false,
        blocks: 0,
        chars: 0,
        llmCalls: 0,
        toolCalls: 0,
        tool: null,
        ms: Date.now() - t0,
        answer: "",
        trace: "",
        research: false,
        ckptMs,
      });
      break;
    }
  }
  return rows;
}

const pctile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
};

export function summarizeDig(rows: DigRow[]): Record<string, number> {
  const m: Record<string, number> = {};
  // The headline set is every digging turn. A "fact" turn of a thread only
  // sets the thread up ("who owns it?" before "what blocked it?").
  const dig = rows.filter((r) => !r.control && r.kind !== "fact");
  const setup = rows.filter((r) => !r.control && r.kind === "fact");
  const ctl = rows.filter((r) => r.control);
  const second = dig.filter((r) => r.turn >= 2);
  const withRecall = dig.filter((r) => r.recall !== null);
  m.turns = rows.length;
  m.questions = new Set(rows.map((r) => r.id)).size;
  m.errors = rows.filter((r) => r.err).length;
  m.pass = mean(dig.map((r) => (r.pass ? 1 : 0)));
  m.pass_second = mean(second.map((r) => (r.pass ? 1 : 0)));
  m.cov = mean(dig.map((r) => r.cov));
  m.cov_second = mean(second.map((r) => r.cov));
  m.recall = mean(withRecall.map((r) => r.recall as number));
  m.recall_multi = mean(
    withRecall.filter((r) => r.kind !== "fact").map((r) => r.recall as number),
  );
  m.not_found = mean(dig.map((r) => (r.notFound ? 1 : 0)));
  m.clarify = mean(dig.map((r) => (r.clarify ? 1 : 0)));
  m.invalid_cites = rows.reduce((a, r) => a + r.invalidCites + r.uncited, 0);
  m.repeats = rows.filter((r) => r.repeat).length;
  m.len_ok = mean(dig.map((r) => (r.lenOk ? 1 : 0)));
  m.llm_calls_mean = mean(dig.map((r) => r.llmCalls));
  m.llm_calls_p95 = pctile(
    dig.map((r) => r.llmCalls),
    0.95,
  );
  m.llm_calls_max = Math.max(0, ...rows.map((r) => r.llmCalls));
  m.tool_calls_mean = mean(dig.map((r) => r.toolCalls));
  // The trigger (11.9.9): digging turns that ran the research mode, and
  // controls and setup facts that ran it although they should not.
  m.trigger_recall = mean(dig.map((r) => (r.research ? 1 : 0)));
  m.trigger_false_controls = ctl.filter((r) => r.research).length;
  m.trigger_false_setup = setup.filter((r) => r.research).length;
  m.ckpt_ms_p95 = pctile(
    rows.flatMap((r) => r.ckptMs),
    0.95,
  );
  m.ms_p50 = pctile(
    dig.map((r) => r.ms),
    0.5,
  );
  m.ms_p95 = pctile(
    dig.map((r) => r.ms),
    0.95,
  );
  m.setup_n = setup.length;
  m.setup_pass = mean(setup.map((r) => (r.pass ? 1 : 0)));
  m.control_n = ctl.length;
  m.control_pass = mean(ctl.map((r) => (r.pass ? 1 : 0)));
  m.control_llm_calls_mean = mean(ctl.map((r) => r.llmCalls));
  m.control_tool_calls_mean = mean(ctl.map((r) => r.toolCalls));
  m.control_ms_p95 = pctile(
    ctl.map((r) => r.ms),
    0.95,
  );
  for (const s of ["meeting", "folder", "all"] as const) {
    const rs = dig.filter((r) => r.scope === s);
    m[`n.${s}`] = rs.length;
    if (rs.length) {
      m[`pass.${s}`] = mean(rs.map((r) => (r.pass ? 1 : 0)));
      m[`cov.${s}`] = mean(rs.map((r) => r.cov));
    }
  }
  for (const l of ["en", "pt"] as const) {
    const rs = dig.filter((r) => r.lang === l);
    if (rs.length) {
      m[`pass.${l}`] = mean(rs.map((r) => (r.pass ? 1 : 0)));
      m[`cov.${l}`] = mean(rs.map((r) => r.cov));
    }
  }
  if (m["pass.en"] !== undefined && m["pass.pt"] !== undefined) {
    // D9: PT pass not below EN pass by more than 10 points.
    m.lang_gap = Math.max(
      0,
      (m["pass.en"] as number) - (m["pass.pt"] as number),
    );
  }
  for (const k of [
    "list",
    "why",
    "blocker",
    "evolve",
    "pushed",
    "changed",
    "unresolved",
  ] as const) {
    const rs = dig.filter((r) => r.kind === k);
    if (rs.length) {
      m[`pass.kind.${k}`] = mean(rs.map((r) => (r.pass ? 1 : 0)));
      m[`cov.kind.${k}`] = mean(rs.map((r) => r.cov));
    }
  }
  return m;
}
