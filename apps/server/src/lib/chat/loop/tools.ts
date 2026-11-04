// The four tools of the Ask tool loop (specs/meeting-chat-agent.md 11.10.4).
// Each tool returns plain text and never throws: an error is a result that
// names the next call. Every source that a tool shows gets a label S<n> from
// the SourceMap of the turn. A source that a tool cut is removed from the map,
// so the answer can cite only what the model saw. Meetings have labels M1 to
// Mn, oldest first, with no cap (the closed list of the pipeline stops at 12).

import type { ChatBlock } from "@openstyle/validations";
import { parseSummary } from "../../meetings/folder-overview.js";
import { isoToRange } from "../dates.js";
import { followUpQuery } from "../plan.js";
import { runTool, scopeMeetingIds, speakerResolver } from "../tools.js";
import type { Turn } from "../turn.js";
import type { Source } from "../types.js";
import { type ItemKind, ledgerCovers, readLedger } from "./ledger.js";
import type { LoopProfile } from "./profile.js";

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

const BAD_DATE =
  "Dates must be YYYY-MM-DD, and date_from must not be after date_to.";

type Args = Record<string, unknown>;

export interface LoopTools {
  /** Runs one tool by name. Never throws. */
  execute(name: string, args: Args): Promise<string>;
  /** Labels of the sources that a result showed to the model. */
  readonly shown: Set<string>;
  /** Meeting ids of the scope, oldest first. */
  readonly ids: readonly string[];
  /** Labels of the list of meetings. */
  readonly navLabels: ReadonlySet<string>;
  /** The speakers of a transcript source, as ` speakers: A, B`, or "". */
  speakersOf(s: Source): string;
}

export function createLoopTools(
  t: Turn,
  profile: LoopProfile,
  question: string,
  noLabelledHits = false,
): LoopTools {
  const { db } = t.input;
  const resultChars = profile.resultChars;
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
  /** Labels of the list of meetings: a map of the project, not evidence. */
  const navLabels = new Set<string>();
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
  /**
   * A transcript hit shows who said each line: "Name: text". The tool result
   * and the answer step then both see the speaker of each line. The cite chip
   * keeps the plain text.
   */
  const labelHit = (s: Source): void => {
    if (noLabelledHits || s.citeText !== undefined) return;
    if (s.kind !== "transcript" && s.kind !== "window") return;
    const segs = t.sources.segments.get(s.label);
    if (!segs || segs.length === 0) return;
    const nameOf = speakerResolver(db, s.meetingId);
    const who = db.prepare(
      "SELECT speaker_label, source FROM meeting_segments WHERE meeting_id = ? AND start_ms = ? AND status = 'ok' LIMIT 1",
    );
    const lines = segs.map((g) => {
      const r = who.get(s.meetingId, g.startMs) as
        | { speaker_label: string | null; source: string }
        | undefined;
      const name = r
        ? r.speaker_label
          ? nameOf(r.speaker_label)
          : r.source === "mic"
            ? "Me"
            : "Them"
        : "";
      return name ? `${name}: ${g.text}` : g.text;
    });
    s.citeText = s.text;
    s.text = lines.join("\n");
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
    args: Args,
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

  // ---- list_meetings ----
  const listMeetings = async (a: Args): Promise<string> => {
    const range = isoToRange(iso(a.date_from), iso(a.date_to));
    if ((a.date_from || a.date_to) && range === null) return BAD_DATE;
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
      navLabels.add(s.label);
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
    // The list block of the pipeline, for the case that the meetings are the
    // answer (run.ts decides). It adds no source that the model saw.
    await call("list_meetings", {
      ...(iso(a.date_from) ? { date_from: iso(a.date_from) } : {}),
      ...(iso(a.date_to) ? { date_to: iso(a.date_to) } : {}),
    });
    return `${rows.length} meetings, oldest first.\n${body}`;
  };

  // ---- search ----
  const search = async (a: Args): Promise<string> => {
    const raw = typeof a.query === "string" ? a.query.trim() : "";
    if (raw.length < 2)
      return "The search needs a query of at least 2 characters.";
    // A follow-up that leans on the thread ("why?") gets the topic of the
    // earlier turn. A question with a topic of its own is not changed.
    const query = followUpQuery(question, t.priorTurns, raw);
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
    if (!r) return `Search failed: ${err}. ${BAD_DATE}`;
    if (r.degraded)
      return "Search is not available. Try list_meetings or list_items.";
    if (r.rows === 0)
      return "No passage found. Try other words, or call list_meetings or list_items.";
    for (const l of r.labels) {
      const src = t.sources.get(l);
      if (src) labelHit(src);
    }
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

  // ---- read ----
  const read = async (a: Args): Promise<string> => {
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

  // ---- list_items ----
  const ledgerItems = (
    q: Parameters<typeof readLedger>[2],
    status: string,
  ): string => {
    const started = Date.now();
    const res = readLedger(db, ids, q);
    t.toolCalls.push({ tool: "list_items", args: q, rows: res.total });
    t.step("tool", "list_items", started, res.total, "ledger");
    if (res.total === 0)
      return "No item matches. Try status=all, or call search.";
    const blocks: { labels: string[]; text: string }[] = [];
    for (const it of res.items) {
      const lastOwner =
        [...it.marks].reverse().find((k) => k.owner)?.owner ?? null;
      const days = Math.max(0, Math.round((t.todayMs - it.firstDate) / DAY));
      const meetingsN = new Set(it.marks.map((k) => k.meetingId)).size;
      const lines = [
        `${it.kind} "${it.text}" | now: ${it.nowStatus}${lastOwner ? ` | owner: ${lastOwner}` : ""} | raised in ${meetingsN} meeting${meetingsN === 1 ? "" : "s"}, first ${day(it.firstDate)} (${days} days before today)`,
      ];
      const labels: string[] = [];
      // One source for each mark, so a cite shows every meeting of the history.
      for (const k of it.marks) {
        const mi = info(k.meetingId);
        const detail = `${k.status}${k.owner ? `; owner: ${k.owner}` : ""}${
          k.quoteOk
            ? `${k.reason ? `; reason: ${k.reason}` : ""}${k.blockedBy ? `; blocked by: ${k.blockedBy}` : ""}${k.quote ? `; quote: "${k.quote}"` : ""}`
            : "; (quote not found in the transcript: reason hidden)"
        }`;
        const s = t.sources.add({
          kind: "summary",
          meetingId: k.meetingId,
          title: mi.title,
          startedAt: k.date,
          startMs: null,
          endMs: null,
          itemId: null,
          text: `${it.kind} "${it.text}" (now: ${it.nowStatus}) in ${labelOf.get(k.meetingId) ?? ""} ${day(k.date)}: ${detail}`,
        });
        labels.push(s.label);
        lines.push(
          `  [${s.label}] ${labelOf.get(k.meetingId) ?? ""} ${day(k.date)} ${detail}`,
        );
      }
      blocks.push({ labels, text: lines.join("\n") });
    }
    const out: string[] = [];
    let len = 0;
    let dropped = 0;
    let shownItems = 0;
    for (const b of blocks) {
      if (out.length > 0 && len + b.text.length > resultChars) {
        dropped++;
        for (const l of b.labels) if (!shown.has(l)) t.sources.remove([l]);
        continue;
      }
      out.push(b.text);
      len += b.text.length + 1;
      shownItems++;
      for (const l of b.labels) shown.add(l);
    }
    if (dropped > 0)
      out.push(`(${dropped} more not shown: use limit, status or meeting_ids)`);
    void status;
    return `${res.total} items${res.total > shownItems ? `, showing ${shownItems}` : ""}, newest first.\n${out.join("\n")}`;
  };

  const listItems = async (a: Args): Promise<string> => {
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
    if (a.date_from && !from) return BAD_DATE;
    // The ledger exists only for a cloud model. Without one, the lists of the summaries answer.
    if (profile.ledger && ledgerCovers(db, ids)) {
      return ledgerItems(
        {
          status,
          kind,
          owner,
          meetingIds: m.ids.length ? m.ids : null,
          dateFrom: from ? (isoToRange(from, null)?.fromMs ?? null) : null,
          limit,
        },
        status,
      );
    }
    // An owner or a status belongs to action items. Decisions and questions have neither.
    const kindOf: ItemKind | null =
      kind ?? (owner || a.status !== undefined ? "action" : null);
    const wantMeeting = m.ids.length === 1 ? (m.ids[0] ?? null) : null;
    const common = {
      ...(from ? { date_from: from } : {}),
      ...(wantMeeting ? { meeting_id: wantMeeting } : {}),
      limit,
    };
    const parts: string[] = [];
    const post = m.ids.length > 1 ? new Set(m.ids) : null;
    const add = async (title: string, tool: string, args: Args) => {
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
    if (!kindOf || kindOf === "action")
      await add("Action items", "list_action_items", {
        status,
        ...(owner ? { person_id: owner } : {}),
        ...common,
      });
    if (!kindOf || kindOf === "decision")
      await add("Decisions", "list_decisions_questions", {
        kind: "decision",
        ...common,
      });
    if (!kindOf || kindOf === "question")
      await add("Open questions", "list_decisions_questions", {
        kind: "open_question",
        ...common,
      });
    return parts.join("\n");
  };

  return {
    ids,
    shown,
    navLabels,
    speakersOf,
    async execute(name, args) {
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
    },
  };
}
