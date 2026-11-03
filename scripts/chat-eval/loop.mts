/**
 * The tool loop arm of the D22 spike (spec 11.10.4 and 11.10.5). Eval only.
 *
 *   CHAT_EVAL_DIG_ARM=loop          four tools over today's index; list_items wraps the summary lists
 *   CHAT_EVAL_DIG_ARM=loop-ledger   list_items reads the item ledger (ledger.mts)
 *   CHAT_EVAL_LOOP_FIRST=search|list_meetings   the forced first call of a small model
 *
 * The product route does not change. The model owns the next tool call.
 * Code owns the scope, the forced first call, the step cap, the size of a
 * result, the answer call and the cite check by id. The loop is driven step by
 * step through `llm.nativeCall`, so every model call stays in the cost log and
 * in the MLflow trace of the gateway.
 *
 * Tool results are plain text. Every source that a tool shows gets a label S<n>
 * from the SourceMap of the turn. A source that a tool cut is removed from the
 * map, so the answer can cite only what the model saw.
 */

import { createRequire } from "node:module";
import type { ChatBlock } from "@openstyle/validations";
import type { AnswerSentence } from "../../apps/server/src/lib/chat/cites.ts";
import { assembleAnswerInput } from "../../apps/server/src/lib/chat/context.ts";
import {
  isoToRange,
  parseDates,
} from "../../apps/server/src/lib/chat/dates.ts";
import type { ChatLlm } from "../../apps/server/src/lib/chat/llm.ts";
import type { ChatTurnInput } from "../../apps/server/src/lib/chat/pipeline.ts";
import { answerUser } from "../../apps/server/src/lib/chat/prompts.ts";
import {
  runTool,
  scopeMeetingIds,
  speakerResolver,
} from "../../apps/server/src/lib/chat/tools.ts";
import { Turn } from "../../apps/server/src/lib/chat/turn.ts";
import type {
  Source,
  TurnResult,
} from "../../apps/server/src/lib/chat/types.ts";
import { estimatePromptTokens } from "../../apps/server/src/lib/llm/token-budget.ts";
import { parseSummary } from "../../apps/server/src/lib/meetings/folder-overview.ts";
import { type ItemKind, readLedger } from "./ledger.mts";

const ZOD_PACKAGE = "zod";
const { z } = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)(ZOD_PACKAGE) as { z: any };

type ModelMessage = NonNullable<
  Parameters<ChatLlm["nativeCall"]>[0]["modelMessages"]
>[number];

const DAY = 86_400_000;
const day = (ms: number | null) =>
  ms === null ? "" : new Date(ms).toISOString().slice(0, 10);
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${r}` : `${m}:${r}`;
};
const cut = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

export type LoopArm = "loop" | "loop-ledger";

/** Model size classes. E2B and E4B are the small local floor (D9). */
function sizeOf(modelId: string): "e2b" | "e4b" | "large" {
  if (/e2b/i.test(modelId)) return "e2b";
  if (/e4b/i.test(modelId)) return "e4b";
  return "large";
}

const STEP_CAP = { e2b: 3, e4b: 5, large: 10 } as const;
const RESULT_CHARS = { small: 6000, large: 20000 } as const;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_meetings",
      description:
        "List all meetings of this project, oldest first, with label, date, title and a short gist. Use it for questions about order, time, first or last meeting, or the whole project.",
      parameters: {
        type: "object",
        properties: {
          date_from: { type: "string", description: "YYYY-MM-DD" },
          date_to: { type: "string", description: "YYYY-MM-DD" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Find passages of the transcripts and summaries by meaning and words. Use a full topic phrase with names, not pronouns. Returns passages with a source label.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A self-contained phrase." },
          meeting_ids: {
            type: "array",
            items: { type: "string" },
            description: "Meeting labels such as M3. Empty means all meetings.",
          },
          date_from: { type: "string", description: "YYYY-MM-DD" },
          date_to: { type: "string", description: "YYYY-MM-DD" },
          kind: { type: "string", enum: ["transcript", "summary"] },
          k: { type: "integer", description: "Passages, 1 to 20. Default 10." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read more of one source. id is a meeting label (M3) or a passage label (S5). part is summary or transcript. A transcript span is at most 3 minutes: when the result says there is more, call again with from_ms.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          part: { type: "string", enum: ["summary", "transcript"] },
          from_ms: { type: "integer" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_items",
      description:
        "List action items, decisions and open questions with their status and history. Use it for what is open, who owns what, what blocked it, and what changed.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "done", "all"] },
          kind: { type: "string", enum: ["action", "decision", "question"] },
          owner: { type: "string" },
          meeting_ids: { type: "array", items: { type: "string" } },
          date_from: { type: "string", description: "YYYY-MM-DD" },
          limit: { type: "integer", description: "At most 50. Default 25." },
        },
        required: [],
      },
    },
  },
] as const;

const ANSWER_SCHEMA = (bullets: number) => ({
  name: "chat_loop_answer",
  version: 1,
  zod: z.object({
    lead: z
      .array(
        z.object({
          text: z.string().max(300),
          cites: z.array(z.string().max(6)).max(4),
        }),
      )
      .max(3),
    bullets: z
      .array(
        z.object({
          text: z.string().max(300),
          cites: z.array(z.string().max(6)).max(4),
        }),
      )
      .max(bullets),
  }),
});

const answerSystem = (
  bullets: number,
) => `You answer a question about meeting notes. Use ONLY the numbered sources.
Write the answer in the language of the QUESTION, even when the sources use another language.
"lead" holds 1 to 3 short sentences: the answer first.
"bullets" holds one bullet for each separate fact, reason, item or change that the sources show. Put them in date order when the question is about change over time. Write as many bullets as the sources need, at most ${bullets}. Write no bullet when the lead answers the question.
One bullet states one fact in at most 30 words. Name the date of the meeting when the sources give one.
Put the labels of the sources that show the sentence or bullet in "cites", for example ["S2"]. Never write a label inside the text.
Copy names, numbers and dates exactly as the sources write them. Write the full name of a person when the sources have it.
When a source shows an item with its history, say its status now and why.
Answer the new question. Earlier questions give context only.
If the sources hold no answer, return empty lists. Never use knowledge from outside the sources.`;

export interface LoopOpts {
  arm: LoopArm;
  first: "search" | "list_meetings";
}

export function loopOptsFromEnv(): LoopOpts {
  const arm = (process.env.CHAT_EVAL_DIG_ARM ?? "").trim();
  const first =
    process.env.CHAT_EVAL_LOOP_FIRST === "list_meetings"
      ? "list_meetings"
      : "search";
  return { arm: arm === "loop-ledger" ? "loop-ledger" : "loop", first };
}

interface Step {
  tool: string;
  args: unknown;
  chars: number;
}

export async function runLoop(
  opts: LoopOpts,
  raw: ChatTurnInput,
): Promise<TurnResult> {
  const llm = raw.llm;
  const size = sizeOf(llm.modelId);
  const small = size !== "large";
  const cap = STEP_CAP[size];
  const resultChars = small ? RESULT_CHARS.small : RESULT_CHARS.large;
  const bullets = 12;
  const input: ChatTurnInput = { ...raw };
  const t = new Turn(input);
  const { db } = input;
  // Hit text is 1500 characters in the loop (spec 11.10.4, `search`).
  Object.assign(t.ctx, { hitChars: 1500 });
  t.prepare();
  // D20: the clarify block runs as today. It ends the turn.
  const clarified = t.clarify();
  if (clarified) return t.resolve(clarified);

  // ---- Labels of the meetings: all of them, oldest first (no 12 cap). ----
  const ids = scopeMeetingIds(db, t.turnScope);
  const labelOf = new Map(ids.map((id, i) => [id, `M${i + 1}`]));
  const idOf = new Map(ids.map((id, i) => [`M${i + 1}`, id]));
  const info = (id: string) =>
    db
      .prepare(
        "SELECT title, COALESCE(started_at, created_at) AS at FROM meetings WHERE id = ?",
      )
      .get(id) as { title: string | null; at: number };
  const resolveMeetings = (xs: unknown): { ids: string[]; bad: string[] } => {
    const out: string[] = [];
    const bad: string[] = [];
    if (Array.isArray(xs))
      for (const x of xs) {
        const s = String(x).trim();
        const id = idOf.get(s.toUpperCase()) ?? (labelOf.has(s) ? s : null);
        if (id) out.push(id);
        else bad.push(s);
      }
    return { ids: out, bad };
  };
  const iso = (v: unknown): string | null =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

  // ---- Source rendering. ----
  const shown = new Set<string>();
  const speakersOf = (s: Source): string => {
    if (s.kind !== "transcript" && s.kind !== "window") return "";
    const nameOf = speakerResolver(db, s.meetingId);
    const rows = db
      .prepare(
        `SELECT speaker_label, source FROM meeting_segments
          WHERE meeting_id = ? AND status = 'ok' AND start_ms >= ? AND start_ms <= ?`,
      )
      .all(s.meetingId, s.startMs ?? 0, s.endMs ?? s.startMs ?? 0) as {
      speaker_label: string | null;
      source: string;
    }[];
    const names = [
      ...new Set(
        rows.map((r) =>
          r.speaker_label
            ? nameOf(r.speaker_label)
            : r.source === "mic"
              ? "Me"
              : "Them",
        ),
      ),
    ];
    return names.length ? ` speakers: ${names.join(", ")}` : "";
  };
  const head = (s: Source): string => {
    const m = labelOf.get(s.meetingId) ?? "";
    const at = s.startMs === null ? "" : ` @${clock(s.startMs)}`;
    return `[${s.label}] ${m} ${day(s.startedAt)} "${s.title ?? "Untitled"}"${at}${speakersOf(s)}`;
  };
  /** Joins blocks until `limit` characters. A block that does not fit is removed from the map. */
  const fit = (
    labels: string[],
    render: (s: Source) => string,
    limit: number,
    note: string,
  ): string => {
    const out: string[] = [];
    let len = 0;
    let dropped = 0;
    for (const l of labels) {
      const s = t.sources.get(l);
      if (!s) continue;
      const block = render(s);
      if (out.length > 0 && len + block.length > limit) {
        dropped++;
        if (!shown.has(l)) t.sources.remove([l]);
        continue;
      }
      out.push(block);
      len += block.length + 1;
      shown.add(l);
    }
    if (dropped > 0) out.push(`(${dropped} more not shown: ${note})`);
    return out.join("\n");
  };

  const call = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{
    r: Awaited<ReturnType<typeof runTool>> | null;
    err: string | null;
  }> => {
    const started = Date.now();
    try {
      const r = await runTool(t.ctx, tool, args);
      t.toolCalls.push({ tool, args, rows: r.rows });
      t.step(
        "tool",
        tool,
        started,
        r.rows,
        r.topScore !== null ? `top=${r.topScore.toFixed(3)}` : null,
      );
      t.results.push(r);
      return { r, err: null };
    } catch (e) {
      const msg = (e as Error).message;
      t.toolCalls.push({ tool, args, rows: 0 });
      t.step("tool", tool, started, 0, msg.slice(0, 120));
      return { r: null, err: msg };
    }
  };
  const badDate =
    "Dates must be YYYY-MM-DD, and date_from must not be after date_to.";

  // ---- The four tools. Each returns plain text and never throws. ----
  const listMeetings = (a: Record<string, unknown>): string => {
    const range = isoToRange(iso(a.date_from), iso(a.date_to));
    if ((a.date_from || a.date_to) && range === null) return badDate;
    const rows = ids
      .map((id) => ({ id, ...info(id) }))
      .filter((m) => !range || (m.at >= range.fromMs && m.at < range.toMs));
    if (rows.length === 0)
      return "No meeting in this date range. Call list_meetings with no dates.";
    const started = Date.now();
    const labels: string[] = [];
    const gists = new Map<string, string>();
    for (const m of rows) {
      const sum = db
        .prepare(
          "SELECT summary_json, markdown FROM meeting_summaries WHERE meeting_id = ?",
        )
        .get(m.id) as
        | { summary_json: string | null; markdown: string | null }
        | undefined;
      const gist = cut(
        (
          parseSummary(sum?.summary_json ?? null)?.overview ||
          sum?.markdown ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim(),
        120,
      );
      const s = t.sources.add({
        kind: "summary",
        meetingId: m.id,
        title: m.title,
        startedAt: m.at,
        startMs: null,
        endMs: null,
        itemId: null,
        text: `${m.title ?? "Untitled"} (${day(m.at)})${gist ? ` ${gist}` : ""}`,
      });
      labels.push(s.label);
      gists.set(s.label, gist);
    }
    t.toolCalls.push({ tool: "list_meetings", args: a, rows: rows.length });
    t.step("tool", "list_meetings", started, rows.length);
    const body = fit(
      labels,
      (s) =>
        `${labelOf.get(s.meetingId)} [${s.label}] ${day(s.startedAt)} "${s.title ?? "Untitled"}" ${gists.get(s.label) ?? ""}`,
      resultChars,
      "narrow the date range",
    );
    return `${rows.length} meetings, oldest first.\n${body}`;
  };

  const search = async (a: Record<string, unknown>): Promise<string> => {
    const query = typeof a.query === "string" ? a.query.trim() : "";
    if (query.length < 2)
      return "The search needs a query of at least 2 characters.";
    const m = resolveMeetings(a.meeting_ids);
    if (m.bad.length > 0)
      return `Unknown meeting label: ${m.bad.join(", ")}. Call list_meetings for the labels.`;
    const k = Math.min(20, Math.max(1, Math.round(Number(a.k) || 10)));
    const kind =
      a.kind === "transcript" || a.kind === "summary" ? [a.kind] : undefined;
    const { r, err } = await call("search_chunks", {
      query,
      ...(m.ids.length ? { meeting_ids: m.ids } : {}),
      ...(iso(a.date_from) ? { date_from: iso(a.date_from) } : {}),
      ...(iso(a.date_to) ? { date_to: iso(a.date_to) } : {}),
      ...(kind ? { kinds: kind } : {}),
      k,
    });
    if (!r) return `Search failed: ${err}. ${badDate}`;
    if (r.degraded)
      return "Search is not available. Try list_meetings or list_items.";
    if (r.rows === 0)
      return "No passage found. Try other words, or call list_meetings or list_items.";
    const body = fit(
      r.labels,
      (s) => `${head(s)}\n${s.text}`,
      resultChars,
      "narrow with meeting_ids or a date range",
    );
    const weak =
      r.topScore !== null && r.topScore < 0.5
        ? `\nWeak match (best score ${r.topScore.toFixed(2)}). Try other words, or call list_meetings or list_items.`
        : "";
    return `${r.labels.length} passages.\n${body}${weak}`;
  };

  const read = async (a: Record<string, unknown>): Promise<string> => {
    const id = typeof a.id === "string" ? a.id.trim() : "";
    let meetingId = idOf.get(id.toUpperCase()) ?? null;
    let part = a.part === "transcript" || a.part === "summary" ? a.part : null;
    let from =
      Number.isFinite(Number(a.from_ms)) && a.from_ms !== undefined
        ? Math.max(0, Math.round(Number(a.from_ms)))
        : null;
    if (!meetingId) {
      const src = /^S\d+$/i.test(id)
        ? t.sources.get(id.toUpperCase())
        : undefined;
      if (!src || !shown.has(src.label))
        return `Unknown id "${id}". Use a meeting label such as M3 or a source label that a tool returned.`;
      meetingId = src.meetingId;
      if (part === null)
        part =
          src.kind === "transcript" || src.kind === "window"
            ? "transcript"
            : "summary";
      if (part === "transcript" && from === null)
        from = Math.max(0, (src.startMs ?? 0) - 20_000);
    }
    part ??= "summary";
    if (part === "summary") {
      const { r, err } = await call("get_meeting_summary", {
        meeting_id: meetingId,
      });
      if (!r) return `Read failed: ${err}`;
      if (r.rows === 0)
        return "This meeting has no summary. Call read with part=transcript.";
      const mi = info(meetingId);
      const body = fit(
        r.labels,
        (s) => `[${s.label}] ${s.text}`,
        resultChars,
        "read the transcript",
      );
      return `${labelOf.get(meetingId)} ${day(mi.at)} "${mi.title ?? "Untitled"}"\n${body}`;
    }
    const start = from ?? 0;
    const { r, err } = await call("get_transcript_window", {
      meeting_id: meetingId,
      from_ms: start,
      to_ms: start + 180_000,
    });
    if (!r) return `Read failed: ${err}`;
    const end = (
      db
        .prepare(
          "SELECT MAX(COALESCE(end_ms, start_ms)) AS e FROM meeting_segments WHERE meeting_id = ? AND status = 'ok'",
        )
        .get(meetingId) as { e: number | null }
    ).e;
    if (r.rows === 0)
      return `No transcript lines from ${start} ms. The transcript ends at ${end ?? 0} ms.`;
    const src = t.sources.get(r.labels.at(-1) ?? "");
    if (!src) return "No transcript lines.";
    const lines = src.text.split("\n").length;
    const next = lines < r.rows ? (src.endMs ?? start) + 1 : start + 180_000;
    const more =
      end !== null && next <= end
        ? `\nmore: call read again with from_ms=${next}`
        : "";
    shown.add(src.label);
    return `${head(src)}\n${src.text}${more}`;
  };

  const listItems = async (a: Record<string, unknown>): Promise<string> => {
    const status =
      a.status === "done" || a.status === "all" ? a.status : "open";
    const kind: ItemKind | null =
      a.kind === "action" || a.kind === "decision" || a.kind === "question"
        ? a.kind
        : null;
    const limit = Math.min(50, Math.max(1, Math.round(Number(a.limit) || 25)));
    const owner =
      typeof a.owner === "string" && a.owner.trim() ? a.owner.trim() : null;
    const m = resolveMeetings(a.meeting_ids);
    if (m.bad.length > 0)
      return `Unknown meeting label: ${m.bad.join(", ")}. Call list_meetings for the labels.`;
    const from = iso(a.date_from);
    if (a.date_from && !from) return badDate;
    if (opts.arm === "loop-ledger") {
      const started = Date.now();
      const res = readLedger(db, ids, {
        status,
        kind,
        owner,
        meetingIds: m.ids.length ? m.ids : null,
        dateFrom: from ? (isoToRange(from, null)?.fromMs ?? null) : null,
        limit,
      });
      t.toolCalls.push({ tool: "list_items", args: a, rows: res.total });
      t.step("tool", "list_items", started, res.total, "ledger");
      if (res.total === 0)
        return "No item matches. Try status=all, or call search.";
      const labels: string[] = [];
      for (const it of res.items) {
        const last = it.marks.at(-1)!;
        const lastOwner =
          [...it.marks].reverse().find((k) => k.owner)?.owner ?? null;
        const days = Math.max(0, Math.round((t.todayMs - it.firstDate) / DAY));
        const meetingsN = new Set(it.marks.map((k) => k.meetingId)).size;
        const lines = [
          `${it.kind} "${it.text}" | now: ${it.nowStatus}${lastOwner ? ` | owner: ${lastOwner}` : ""} | raised in ${meetingsN} meeting${meetingsN === 1 ? "" : "s"}, first ${day(it.firstDate)} (${days} days before today)`,
          ...it.marks.map(
            (k) =>
              `  ${labelOf.get(k.meetingId) ?? ""} ${day(k.date)} ${k.status}${k.owner ? `; owner: ${k.owner}` : ""}${
                k.quoteOk
                  ? `${k.reason ? `; reason: ${k.reason}` : ""}${k.blockedBy ? `; blocked by: ${k.blockedBy}` : ""}; quote: "${k.quote}"`
                  : "; (quote not found in the transcript: reason hidden)"
              }`,
          ),
        ];
        const mi = info(last.meetingId);
        const s = t.sources.add({
          kind: "summary",
          meetingId: last.meetingId,
          title: mi.title,
          startedAt: last.date,
          startMs: null,
          endMs: null,
          itemId: null,
          text: lines.join("\n"),
        });
        labels.push(s.label);
      }
      const body = fit(
        labels,
        (s) => `[${s.label}] ${s.text}`,
        resultChars,
        "use limit, status or meeting_ids",
      );
      return `${res.total} items${res.total > res.items.length ? `, showing ${res.items.length}` : ""}.\n${body}`;
    }
    // Phase 1: the lists of today's summaries.
    const wantMeeting = m.ids.length === 1 ? m.ids[0]! : null;
    const common = {
      ...(from ? { date_from: from } : {}),
      ...(wantMeeting ? { meeting_id: wantMeeting } : {}),
      limit,
    };
    const parts: string[] = [];
    const post = m.ids.length > 1 ? new Set(m.ids) : null;
    const add = async (
      title: string,
      tool: string,
      args: Record<string, unknown>,
    ) => {
      const { r, err } = await call(tool, args);
      if (!r) {
        parts.push(`${title}: failed (${err})`);
        return;
      }
      const items =
        (
          r.blocks.find((b) => b.kind === "list") as
            | Extract<ChatBlock, { kind: "list" }>
            | undefined
        )?.items ?? [];
      const labels = items
        .filter(
          (i) => i.label && (!post || (i.meeting_id && post.has(i.meeting_id))),
        )
        .map((i) => i.label as string);
      if (labels.length === 0) {
        parts.push(`${title}: none.`);
        return;
      }
      parts.push(
        `${title} (${r.rows} in total):\n${fit(labels, (s) => `[${s.label}] ${labelOf.get(s.meetingId) ?? ""} ${day(s.startedAt)}: ${s.text}`, resultChars / 2, "use limit or meeting_ids")}`,
      );
    };
    if (!kind || kind === "action")
      await add("Action items", "list_action_items", {
        status,
        ...(owner ? { person_id: owner } : {}),
        ...common,
      });
    if (!kind || kind === "decision")
      await add("Decisions", "list_decisions_questions", {
        kind: "decision",
        ...common,
      });
    if (!kind || kind === "question")
      await add("Open questions", "list_decisions_questions", {
        kind: "open_question",
        ...common,
      });
    return parts.join("\n");
  };

  const execute = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    switch (name) {
      case "list_meetings":
        return listMeetings(args);
      case "search":
        return search(args);
      case "read":
        return read(args);
      case "list_items":
        return listItems(args);
      default:
        return `Unknown tool "${name}". The tools are list_meetings, search, read and list_items.`;
    }
  };

  // ---- The loop. ----
  const todayIso = day(t.todayMs);
  const named = parseDates(input.question, t.todayMs);
  const toolLine: Record<string, string> = {
    list_meetings: "list_meetings (all meetings)",
    search: "search (passages by meaning and words)",
    read: "read (a summary or a transcript span)",
    list_items:
      "list_items (action items, decisions and open questions with their history)",
  };
  const systemFor = (
    names: string[],
  ) => `You answer questions about the meetings of ${t.scopeLine}. Use the tools to find the facts. Never answer from memory.
Today is ${todayIso}. ${named.dateFrom ? `The question names the dates ${named.dateFrom} to ${named.dateTo}. ` : ""}There are ${ids.length} meetings, labeled M1 to M${ids.length}, oldest first. Passages and items you receive have labels S1, S2, and so on.
Tools: ${names.map((n) => toolLine[n]).join(", ")}.
When you have the facts, stop calling tools and reply with one short line.`;
  const hist: ModelMessage[] = t.turns.slice(-3).flatMap((h) => [
    { role: "user" as const, content: h.question },
    { role: "assistant" as const, content: cut(h.answer, 700) },
  ]);
  const messages: ModelMessage[] = [
    ...hist,
    { role: "user", content: input.question },
  ];
  const steps: Step[] = [];
  const maxOut = small ? 300 : 1000;
  let idle = 0;
  for (let i = 0; i < cap; i++) {
    if (t.stopReason()) break;
    const forced = small ? opts.first : null;
    const tools =
      i === 0 && forced
        ? TOOLS.filter((x) => x.function.name === forced)
        : TOOLS;
    const before = t.sources.size;
    const started = Date.now();
    let res: Awaited<ReturnType<typeof llm.nativeCall>>;
    try {
      res = await llm.nativeCall({
        system: systemFor(tools.map((x) => x.function.name)),
        // The record and the window check see the flat text of the thread.
        messages: [
          { role: "user", content: JSON.stringify(messages).slice(-60_000) },
        ],
        modelMessages: messages,
        tools: tools as never,
        // The worker takes auto, required or none. One tool is active, so required forces it.
        ...(i === 0 && forced ? { toolChoice: "required" as const } : {}),
        maxOutputTokens: maxOut,
        unitKey: `loop/${i}`,
      });
    } catch (e) {
      const kind = (e as { kind?: string }).kind;
      t.step("route", `loop:${i}`, started, null, kind ?? "error");
      if (input.signal.aborted) break;
      // A cut reply or a bad call ends the loop; the answer step uses what was found.
      if (kind === "length" || kind === "context_exceeded") break;
      throw e;
    }
    const active = new Set(tools.map((x) => x.function.name as string));
    let calls = (res.calls ?? []).filter(
      (c) => c.args !== null && active.has(c.name),
    );
    // Code owns the first call of a small model. When the model does not make it
    // (it answers in text or picks another tool), code makes it. The query of a
    // forced search is the question.
    if (i === 0 && forced && calls.length === 0) {
      calls = [
        {
          id: "forced-0",
          name: forced,
          args: forced === "search" ? { query: input.question } : {},
        },
      ];
      t.step(
        "route",
        "loop:forced",
        started,
        1,
        `model gave no valid first call: ${JSON.stringify(res.calls ?? []).slice(0, 160)}`,
      );
    }
    t.step(
      "route",
      `loop:${i}`,
      started,
      calls.length,
      calls.map((c) => c.name).join(","),
    );
    if (calls.length === 0) break;
    messages.push({
      role: "assistant",
      content: [
        ...(res.text ? [{ type: "text" as const, text: res.text }] : []),
        ...calls.map((c) => ({
          type: "tool-call" as const,
          toolCallId: c.id,
          toolName: c.name,
          input: c.args,
        })),
      ],
    });
    const results: string[] = [];
    // Calls of one step run in order, so the labels do not change between runs.
    for (const c of calls) {
      const text = await execute(c.name, c.args ?? {});
      results.push(text);
      steps.push({ tool: c.name, args: c.args, chars: text.length });
    }
    messages.push({
      role: "tool",
      content: calls.map((c, j) => ({
        type: "tool-result" as const,
        toolCallId: c.id,
        toolName: c.name,
        output: { type: "text" as const, value: results[j] as string },
      })),
    });
    // Guard (not a router): two steps in a row with no new source end the loop.
    idle = t.sources.size === before ? idle + 1 : 0;
    if (idle >= 2) break;
  }

  // ---- The answer: one structured call, tools off (the worker rejects both). ----
  // Only what a tool showed to the model can be cited.
  t.sources.remove(
    t.sources
      .all()
      .filter((s) => !shown.has(s.label))
      .map((s) => s.label),
  );
  const ranked = t.sources
    .all()
    .sort((a, b) => Number(a.label.slice(1)) - Number(b.label.slice(1)));
  if (ranked.length === 0) return t.notFound("no_sources");
  const run = t.newRun();
  const budget = small ? 10_000 : 30_000;
  run.budget = budget;
  const ansSystem = answerSystem(bullets);
  const maxAns = small ? 1800 : 3500;
  const job = { ranked, synth: true, focus: null };
  while (run.attempt < 3) {
    const attempt = ++run.attempt;
    const why = t.stopReason();
    if (why) return t.notFound(why);
    const assembled = assembleAnswerInput({
      system: ansSystem,
      question: input.question,
      history: t.turns,
      sources: ranked,
      budgetTokens: run.budget,
      windowTokens: llm.contextWindow,
      maxOutputTokens: maxAns,
      fixedTokens: estimatePromptTokens(ansSystem),
    });
    t.sourcesDropped = assembled.droppedLabels;
    t.historyDropped = assembled.historyTurnsDropped;
    t.sourceTokens = assembled.parts.sources;
    const started = Date.now();
    let parsed: AnswerSentence[];
    try {
      const r = await llm.structured({
        step: "chatAnswer",
        unitKey: attempt === 1 ? "answer" : `answer/retry${attempt - 1}`,
        schema: ANSWER_SCHEMA(bullets),
        system: ansSystem,
        messages: [
          {
            role: "user",
            content: answerUser({
              history: assembled.historyText,
              sources: assembled.sourcesText,
              question: input.question,
              repair: run.repair,
            }),
          },
        ],
        maxOutputTokens: maxAns,
      });
      t.step("answer", `attempt ${attempt}`, started);
      parsed = [
        ...r.object.lead.map((x: AnswerSentence) => ({ ...x })),
        ...r.object.bullets.map((x: AnswerSentence) => ({
          ...x,
          bullet: true,
        })),
      ];
    } catch (e) {
      const kind = (e as { kind?: string }).kind ?? "";
      t.step("answer", `attempt ${attempt}`, started, null, kind || "error");
      if (input.signal.aborted) {
        const w = t.stopReason();
        if (w) return t.notFound(w);
      }
      if ((kind === "length" || kind === "context_exceeded") && attempt < 3) {
        run.budget = Math.floor(run.budget / 2);
        continue;
      }
      if (kind === "length" || kind === "context_exceeded")
        return t.notFound("model_error");
      throw e;
    }
    parsed = parsed.filter((x) => x.text.trim() !== "");
    if (parsed.length === 0) return t.notFound("no_sources");
    const c = await t.checkAttempt(job, run, parsed);
    if (c.kind === "exit") return t.resolve(c.exit);
  }
  return t.notFound("cite_check");
}

/** Used by the harness to name the arm in MLflow and in the log. */
export function loopTags(opts: LoopOpts): Record<string, string> {
  return {
    arm: opts.arm,
    first_call: opts.first,
    ledger: opts.arm === "loop-ledger" ? "true" : "false",
    scorer: "v3",
  };
}
