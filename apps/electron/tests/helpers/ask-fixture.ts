import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Fixture of the Ask tab E2E spec (tests/meeting-ask-tab.test.ts): a fake
// OpenAI-compatible LLM server and a seeded set of fictional meetings. All
// text is fictional. The fake needs no model and no GPU, so CI can run it.

// ---------------------------------------------------------------------------
// Fictional data
// ---------------------------------------------------------------------------

export const FOLDER_ID = "ask-folder-orchid";
export const FOLDER_NAME = "Orchid project";

export const DECISION_TEXT = "Move the beta launch to Friday 14 November.";
export const ACTION_TASK = "Send the vendor contract draft to legal";
export const ACTION_OWNER = "Dana Reyes";
export const OPEN_QUESTION = "Who pays for the extra test devices?";

export interface SeedMeeting {
  id: string;
  title: string;
  /** Start time of the meeting, ms since the epoch. */
  startedAt: number;
  overview: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: { task: string; owner: string | null; due: string | null }[];
  openQuestions: string[];
  /** Topic lines. The seed adds filler lines around them. */
  topics: string[];
}

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 9, 12, 9, 0, 0);

export const MEETINGS: SeedMeeting[] = [
  {
    id: "ask-m-weekly",
    title: "Weekly sync",
    startedAt: BASE,
    overview:
      "The team reviewed the beta plan and agreed on a new launch date. Dana will send the vendor contract draft to legal.",
    keyPoints: [
      "The test build passed the smoke checks on Monday",
      "The vendor needs the signed contract before the first delivery",
    ],
    decisions: [DECISION_TEXT],
    actionItems: [
      { task: ACTION_TASK, owner: ACTION_OWNER, due: "2026-11-07" },
      {
        task: "Book the demo room for the launch",
        owner: "Tomas Weber",
        due: null,
      },
    ],
    openQuestions: [OPEN_QUESTION],
    topics: [
      "I think we should move the beta launch to Friday the fourteenth of November, because the test devices arrive late.",
      "Agreed. The smoke checks passed on Monday, so the build itself is not the problem for the launch date.",
      "Dana, can you send the vendor contract draft to legal this week? They need it before the first delivery.",
      "Yes, I will send it by the seventh of November. I already have the draft from the vendor.",
      "We still do not know who pays for the extra test devices. Finance has not answered yet.",
      "Let us write that down as an open question and ask finance again on Thursday.",
      "Tomas, please book the demo room for the launch. The big room on the second floor is free that Friday.",
    ],
  },
  {
    id: "ask-m-vendor",
    title: "Vendor review",
    startedAt: BASE + 3 * DAY,
    overview:
      "The team compared two vendor offers for the sensor board and chose the cheaper offer with the longer warranty.",
    keyPoints: [
      "Vendor A is faster but has a one year warranty",
      "Vendor B has a three year warranty and a lower unit price",
    ],
    decisions: ["Order the first batch of 200 sensor boards from Vendor B."],
    actionItems: [
      {
        task: "Confirm the delivery date with Vendor B",
        owner: "Dana Reyes",
        due: "2026-10-20",
      },
    ],
    openQuestions: ["Does Vendor B ship to the east warehouse?"],
    topics: [
      "Vendor A can deliver in two weeks, but the warranty is only one year, and that worries me for the field units.",
      "Vendor B quotes a lower unit price and a three year warranty, but delivery takes five weeks.",
      "I prefer Vendor B. The field units will run for years, and a long warranty saves us repair work.",
      "Then we order the first batch of 200 sensor boards from Vendor B and keep Vendor A as a backup.",
      "Dana, please confirm the delivery date with Vendor B by the twentieth of October.",
      "We also need to know if Vendor B ships to the east warehouse, because the west dock is full.",
    ],
  },
  {
    id: "ask-m-roadmap",
    title: "Roadmap check",
    startedAt: BASE + 6 * DAY,
    overview:
      "The team checked the roadmap for the next quarter and moved the reporting feature to the second sprint.",
    keyPoints: [
      "The reporting feature needs two more weeks of design",
      "Support asked for a status page before the launch",
    ],
    decisions: ["Move the reporting feature to the second sprint."],
    actionItems: [
      {
        task: "Draft the status page text",
        owner: "Tomas Weber",
        due: "2026-10-30",
      },
    ],
    openQuestions: ["Should the status page show the uptime history?"],
    topics: [
      "The reporting feature needs two more weeks of design, so I suggest we move it to the second sprint.",
      "That works for me. The launch work is already heavy, and the reports are not needed on day one.",
      "Support asked for a public status page before the launch. Tomas, can you draft the text this month?",
      "Sure, I will have a first version by the thirtieth of October.",
      "Should the status page show the uptime history, or only the current state? I have no strong view.",
    ],
  },
];

const FILLER = [
  "Okay, let me share my screen so everyone sees the same plan.",
  "Can you hear me well? The line was bad a minute ago.",
  "Let us go through the list from the top, and stop if anything looks wrong.",
  "I wrote down the main points in the shared notes, so please check them later.",
  "That is a fair point, and I want to make sure the whole team agrees before we move on.",
  "We have about ten minutes left, so let us keep the next items short.",
  "I will follow up by email after the call with the details we discussed.",
  "Thanks, that was clear. I have no more questions on this item.",
];

const SPEAKERS: { label: string | null; source: "mic" | "system" }[] = [
  { label: null, source: "mic" },
  { label: "1", source: "system" },
  { label: "2", source: "system" },
];

export const SPEAKER_NAMES: Record<string, string> = {
  "1": "Dana Reyes",
  "2": "Tomas Weber",
};

/** About 40 transcript lines for one meeting, with the topic lines inside. */
export function transcriptLines(m: SeedMeeting, total = 40): string[] {
  const lines: string[] = [];
  const every = Math.floor(total / (m.topics.length + 1));
  let topic = 0;
  for (let i = 0; i < total; i++) {
    if (topic < m.topics.length && i > 0 && i % every === 0) {
      lines.push(m.topics[topic++] as string);
    } else {
      lines.push(FILLER[(i + m.id.length) % FILLER.length] as string);
    }
  }
  while (topic < m.topics.length) lines.push(m.topics[topic++] as string);
  return lines;
}

/** The segment id of line `index` of a meeting. */
export function segId(meetingId: string, index: number): string {
  return `${meetingId}-seg-${index}`;
}

export function markdownOf(m: SeedMeeting): string {
  const items = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return [
    `## Overview\n\n${m.overview}`,
    `## Key points\n\n${items(m.keyPoints)}`,
    `## Decisions\n\n${items(m.decisions)}`,
    `## Action items\n\n${items(
      m.actionItems.map(
        (a) =>
          `${a.task}${a.owner ? ` (${a.owner}${a.due ? `, due ${a.due}` : ""})` : ""}`,
      ),
    )}`,
    `## Open questions\n\n${items(m.openQuestions)}`,
  ].join("\n\n");
}

/** Writes the folder and the meetings into the profile DB. Call it while the app runs. */
export function seedAskMeetings(userDataDir: string): void {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    db.prepare(
      `INSERT INTO meeting_folders (id, name, description, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?)`,
    ).run(FOLDER_ID, FOLDER_NAME, now, now);
    for (const m of MEETINGS) {
      const lines = transcriptLines(m);
      db.prepare(
        `INSERT INTO meetings
           (id, title, started_at, ended_at, duration_ms, status, audio_dir,
            stt_provider, stt_model, language, folder_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'summarized', NULL, 'local-mlx', 'fake-stt',
                 'en', ?, ?)`,
      ).run(
        m.id,
        m.title,
        m.startedAt,
        m.startedAt + lines.length * 12_000,
        lines.length * 12_000,
        FOLDER_ID,
        m.startedAt,
      );
      const insert = db.prepare(
        `INSERT INTO meeting_segments
           (id, meeting_id, source, idx, start_ms, end_ms, text, status,
            speaker_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
      );
      lines.forEach((text, i) => {
        const sp = SPEAKERS[i % SPEAKERS.length] as (typeof SPEAKERS)[number];
        insert.run(
          segId(m.id, i),
          m.id,
          sp.source,
          i,
          i * 12_000,
          i * 12_000 + 11_000,
          text,
          sp.label,
        );
      });
      for (const [label, name] of Object.entries(SPEAKER_NAMES)) {
        db.prepare(
          `INSERT INTO meeting_speakers
             (meeting_id, speaker_label, display_name, updated_at, confirmed_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(m.id, label, name, now, now);
      }
      db.prepare(
        `INSERT INTO meeting_summaries
           (meeting_id, markdown, llm_provider, llm_model, created_at,
            summary_json)
         VALUES (?, ?, 'server', 'fake-llm', ?, ?)`,
      ).run(
        m.id,
        markdownOf(m),
        now,
        JSON.stringify({
          overview: m.overview,
          keyPoints: m.keyPoints,
          decisions: m.decisions,
          actionItems: m.actionItems,
          openQuestions: m.openQuestions,
        }),
      );
    }
  } finally {
    db.close();
  }
}

/** The state of the action items of one meeting, as the summary JSON holds them. */
export function readActionItems(
  userDataDir: string,
  meetingId: string,
): { summaryJson: string | null; doneKeys: string[] } {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"), {
    readOnly: true,
  });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db
      .prepare(
        "SELECT summary_json FROM meeting_summaries WHERE meeting_id = ?",
      )
      .get(meetingId) as { summary_json: string | null } | undefined;
    const done = db
      .prepare("SELECT item_key FROM folder_action_item_state WHERE done = 1")
      .all() as { item_key: string }[];
    return {
      summaryJson: row?.summary_json ?? null,
      doneKeys: done.map((d) => d.item_key),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Fake LLM server
// ---------------------------------------------------------------------------

/** What the fake saw in one request. */
export interface AskRequest {
  n: number;
  /** "native" (has tools), a response_format schema name, or "other". */
  kind: "native" | "chat_router" | "chat_slots" | "chat_answer" | "other";
  system: string;
  /** The text of the last user message. */
  user: string;
  tools: string[];
  /** What the fake answered: a tool name, a schema name or "text". */
  answered: string;
  body: Record<string, unknown>;
}

export const NOT_FOUND_MARK = "Mars colony";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "object" && p
          ? String((p as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "and",
  "is",
  "was",
  "what",
  "who",
  "did",
  "we",
  "do",
  "does",
  "about",
  "for",
  "in",
  "on",
  "that",
  "this",
  "it",
  "me",
  "my",
  "our",
  "us",
  "i",
  "you",
  "are",
  "or",
  "be",
  "by",
  "with",
]);

function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length > 2 && !STOP.has(w),
  );
}

interface ParsedSource {
  label: string;
  text: string;
}

/** The `[S1] Title, 2026-10-12: text` lines of the SOURCES block. */
export function parseSources(user: string): ParsedSource[] {
  const block = /SOURCES:\n([\s\S]*?)(?:\n\n|$)/.exec(user)?.[1] ?? "";
  const out: ParsedSource[] = [];
  for (const line of block.split("\n")) {
    const m =
      /^\[(S\d+)\] (?:.*?, )?\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?: (.*)$/.exec(
        line,
      );
    if (m) out.push({ label: m[1] as string, text: m[2] as string });
  }
  return out;
}

/** The text after "QUESTION:" of the answer prompt. */
function questionOf(user: string): string {
  return /QUESTION: ([\s\S]*)$/.exec(user)?.[1]?.trim() ?? user;
}

/**
 * The fake model. It looks at each request and answers by rule, so a run is
 * deterministic:
 * - native tool turn: search_chunks for most questions, get_meeting_summary
 *   when the question holds "owns" or "owner", a propose tool for a write
 *   question;
 * - chat_router: lookup, or write for "Mark ...";
 * - chat_slots: valid empty slots;
 * - chat_answer: one sentence, copied from the source that shares most words
 *   with the question, cited with its label. found=false for NOT_FOUND_MARK.
 */
export class FakeAskLlm {
  readonly requests: AskRequest[] = [];
  /** When true, a native tool turn gets a plain text answer (no tool call). */
  noNativeTools = false;
  private server: Server | undefined;
  private port = 0;
  private sockets = new Set<Socket>();

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((done) => {
      this.server?.listen(0, "127.0.0.1", () => {
        const address = this.server?.address();
        this.port = typeof address === "object" && address ? address.port : 0;
        done();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((done) => this.server?.close(() => done()));
    this.server = undefined;
  }

  /** Requests of one kind, oldest first. */
  ofKind(kind: AskRequest["kind"]): AskRequest[] {
    return this.requests.filter((r) => r.kind === kind);
  }

  private reply(
    res: ServerResponse,
    message: Record<string, unknown>,
    finish: string,
  ): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 1,
        model: "fake-llm",
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  }

  private text(res: ServerResponse, content: string): void {
    this.reply(res, { role: "assistant", content }, "stop");
  }

  private toolCall(res: ServerResponse, name: string, args: unknown): void {
    this.reply(
      res,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_fake_1",
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      "tool_calls",
    );
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.on("error", () => {});
    if (req.method !== "POST") {
      // The probe of POST /api/servers lists the models.
      const isStatus = req.url?.startsWith("/v1/models/status");
      res.writeHead(isStatus ? 404 : 200, {
        "Content-Type": "application/json",
      });
      res.end(isStatus ? "{}" : JSON.stringify({ data: [{ id: "fake-llm" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    const messages = (body.messages ?? []) as {
      role: string;
      content: unknown;
    }[];
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => textOf(m.content))
      .join("\n");
    const user = textOf(
      messages.filter((m) => m.role === "user").at(-1)?.content,
    );
    const tools = (
      (body.tools ?? []) as { function?: { name?: string } }[]
    ).map((t) => t.function?.name ?? "");
    const schema = (
      body.response_format as { json_schema?: { name?: string } } | undefined
    )?.json_schema?.name;
    const kind: AskRequest["kind"] =
      tools.length > 0
        ? "native"
        : schema === "chat_router" ||
            schema === "chat_slots" ||
            schema === "chat_answer"
          ? schema
          : "other";
    const record: AskRequest = {
      n: this.requests.length + 1,
      kind,
      system,
      user,
      tools,
      answered: "text",
      body,
    };
    this.requests.push(record);

    if (kind === "native") {
      if (this.noNativeTools) {
        record.answered = "text";
        this.text(res, "I cannot call a tool.");
        return;
      }
      const q = user;
      if (/\bmark\b/i.test(q) && tools.includes("propose_action_item_change")) {
        record.answered = "propose_action_item_change";
        this.toolCall(res, "propose_action_item_change", {
          item: "A1",
          done: true,
        });
      } else if (
        /\bowns?\b|\bowner\b/i.test(q) &&
        tools.includes("get_meeting_summary")
      ) {
        record.answered = "get_meeting_summary";
        this.toolCall(res, "get_meeting_summary", { meeting: "M1" });
      } else {
        record.answered = "search_chunks";
        this.toolCall(res, "search_chunks", { query: q.slice(0, 200) });
      }
      return;
    }
    if (kind === "chat_router") {
      const q = user.replace(/^[\s\S]*Question: /, "");
      const intent = /\bmark\b/i.test(q) ? "write" : "lookup";
      record.answered = "chat_router";
      this.text(res, JSON.stringify({ intent }));
      return;
    }
    if (kind === "chat_slots") {
      record.answered = "chat_slots";
      this.text(
        res,
        JSON.stringify(
          /\bmark\b/i.test(user)
            ? {
                change: "action_item",
                item: "none",
                meeting: "none",
                folder: "none",
                person: "none",
                tag: null,
              }
            : { query: user.replace(/^[\s\S]*Question: /, "").slice(0, 200) },
        ),
      );
      return;
    }
    if (kind === "chat_answer") {
      const question = questionOf(user);
      const sources = parseSources(user);
      record.answered = "chat_answer";
      if (question.includes(NOT_FOUND_MARK) || sources.length === 0) {
        this.text(res, JSON.stringify({ found: false, sentences: [] }));
        return;
      }
      const qw = new Set(words(question));
      let best = sources[0] as ParsedSource;
      let bestScore = -1;
      for (const s of sources) {
        // "decide" in the question points at a Decision line (stem match).
        const decisionBonus =
          /\bdecid/i.test(question) && s.text.startsWith("Decision:") ? 3 : 0;
        const score =
          words(s.text).filter((w) => qw.has(w)).length +
          decisionBonus +
          // "owns" or "task" in the question points at an Action item line.
          (/\bowns?\b|\btask\b/i.test(question) &&
          s.text.startsWith("Action item:")
            ? 3
            : 0);
        if (score > bestScore) {
          best = s;
          bestScore = score;
        }
      }
      let sentence = best.text.replace(
        /^(Overview|Decision|Key points|Action item|Open question): /,
        "",
      );
      if (sentence.length > 300)
        sentence = sentence.slice(0, 300).replace(/\s+\S*$/, "");
      this.text(
        res,
        JSON.stringify({
          found: true,
          sentences: [{ text: sentence, cites: [best.label] }],
        }),
      );
      return;
    }
    // Anything else: a harmless empty object.
    this.text(res, "{}");
  }
}
