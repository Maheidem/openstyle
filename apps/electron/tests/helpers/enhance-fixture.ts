import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import {
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./e2e-app";

// Shared fixture of the Enhance E2E specs (specs/meeting-enhance-agentic.md
// 10.11): a fake own LLM server that follows the pattern of
// tests/meeting-cancel-transcribe.test.ts, a fictional meeting seeded with
// node:sqlite, and the app set-up. All text is fictional.

export type StepName =
  | "correct_chunk"
  | "identify_speakers"
  | "meeting_summary"
  | "other";

/** One request that reached the fake server, as the test reads it. */
export interface ChatRequest {
  /** 1-based arrival number. Do not script on it: retries move it. */
  n: number;
  step: StepName;
  /** The segment ids of the `[id] Speaker: text` lines of the user message. */
  ids: string[];
  /** The text of each of those lines, by id. */
  lines: Map<string, string>;
  system: string;
  user: string;
  /** The content of every message, in order. The panel shows these. */
  messages: string[];
  body: Record<string, unknown>;
}

export interface Answer {
  /** The assistant message. */
  content: string;
  finish?: string;
  status?: number;
  headers?: Record<string, string>;
}

/** `"hold"` parks the request until `releaseHeld()`; a server kill drops it. */
export type Script = (req: ChatRequest) => Answer | "hold";

const LINE = /^\[([^\]]+)\] [^:\n]+: (.*)$/gm;

function stepOf(body: Record<string, unknown>): StepName {
  const rf = body.response_format as
    | { json_schema?: { name?: string } }
    | undefined;
  const name = rf?.json_schema?.name;
  return name === "correct_chunk" ||
    name === "identify_speakers" ||
    name === "meeting_summary"
    ? name
    : "other";
}

function messageText(body: Record<string, unknown>, role: string): string {
  const messages = (body.messages ?? []) as Array<{
    role: string;
    content: unknown;
  }>;
  return messages
    .filter((m) => m.role === role)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

export class FakeLlm {
  readonly requests: ChatRequest[] = [];
  script: Script = () => ({ content: "{}" });
  private server: Server | undefined;
  private port = 0;
  private held: ServerResponse[] = [];
  private sockets = new Set<Socket>();

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((done) => {
      this.server?.listen(port, "127.0.0.1", () => {
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

  /** Answers every held request with `answer`. */
  releaseHeld(answer: Answer): void {
    for (const res of this.held.splice(0)) this.send(res, answer, "fake-llm");
  }

  heldCount(): number {
    return this.held.length;
  }

  /** Requests that carry `id` in a `[id] ...` line of the user message. */
  countFor(step: StepName, id: string): number {
    return this.requests.filter((r) => r.step === step && r.ids.includes(id))
      .length;
  }

  private send(res: ServerResponse, answer: Answer, model: string): void {
    if (res.destroyed || res.writableEnded) return;
    const status = answer.status ?? 200;
    res.writeHead(status, {
      "Content-Type": "application/json",
      ...(answer.headers ?? {}),
    });
    if (status !== 200) {
      res.end(JSON.stringify({ error: { message: answer.content } }));
      return;
    }
    res.end(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: answer.content },
            finish_reason: answer.finish ?? "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.on("error", () => {});
    if (req.method !== "POST") {
      // The server probe of POST /api/servers lists models. The boot resume
      // probes the endpoint with a HEAD or GET.
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
    const user = messageText(body, "user");
    const lines = new Map<string, string>();
    for (const m of user.matchAll(LINE)) lines.set(m[1] as string, m[2] ?? "");
    const request: ChatRequest = {
      n: this.requests.length + 1,
      step: stepOf(body),
      ids: [...lines.keys()],
      lines,
      system: messageText(body, "system"),
      user,
      messages: ((body.messages ?? []) as Array<{ content: unknown }>).map(
        (m) => (typeof m.content === "string" ? m.content : ""),
      ),
      body,
    };
    this.requests.push(request);
    const answer = this.script(request);
    if (answer === "hold") {
      this.held.push(res);
      return;
    }
    this.send(res, answer, String(body.model ?? "fake-llm"));
  }
}

// ---------------------------------------------------------------------------
// Fictional meeting
// ---------------------------------------------------------------------------

/** The planted recognizer error and its fix. */
export const WRONG_WORD = "lunch";
export const RIGHT_WORD = "launch";

const FILLER =
  "We went through the open items and agreed on the next steps for the team. ";

/**
 * About 3000 characters, about 765 tokens (estimateTokens is ceil(length / 4)).
 * Two segments together are above CHUNK_TOKENS_MAX (1200), so each segment is
 * one chunk. The margin is about 330 tokens. This holds while the fake model
 * has no context window (chunkSizeFor returns 1200). A test asserts the chunk
 * count, so a change of the constant fails there with a clear message.
 */
export function longText(lead: string): string {
  return `${lead} ${FILLER.repeat(40)}`.trim();
}

export interface SeedSegment {
  source: "mic" | "system";
  /** The diarization label of a "Them" line. */
  label: string | null;
  text: string;
}

export function segmentId(meetingId: string, index: number): string {
  return `${meetingId}-seg-${index}`;
}

/**
 * Meeting of `chunks` segments, one chunk each. Segment 0 is "Me". Segment 1
 * is "Them 1" and holds a self-introduction. The others are "Them 2". Every
 * segment holds the planted error.
 */
export function defaultSegments(chunks: number): SeedSegment[] {
  const out: SeedSegment[] = [];
  for (let i = 0; i < chunks; i++) {
    const lead =
      i === 1
        ? `Hello everyone. This is Ana speaking. The ${WRONG_WORD} date moved to Friday.`
        : `Point ${i + 1}: the ${WRONG_WORD} date moved to Friday.`;
    out.push({
      source: i === 0 ? "mic" : "system",
      label: i === 0 ? null : i === 1 ? "1" : "2",
      text: longText(lead),
    });
  }
  return out;
}

/** Writes a meeting with `status` transcribed. Call it while the app runs. */
export function seedMeeting(
  userDataDir: string,
  meetingId: string,
  title: string,
  segments: SeedSegment[],
): void {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    db.prepare(
      `INSERT INTO meetings
         (id, title, started_at, ended_at, duration_ms, status, audio_dir,
          stt_provider, stt_model, language, created_at)
       VALUES (?, ?, ?, ?, ?, 'transcribed', NULL, 'local-mlx', 'fake-stt',
               'en', ?)`,
    ).run(meetingId, title, now, now + 60_000 * segments.length, 60_000, now);
    const insert = db.prepare(
      `INSERT INTO meeting_segments
         (id, meeting_id, source, idx, start_ms, end_ms, text, status,
          speaker_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
    );
    segments.forEach((s, i) => {
      insert.run(
        segmentId(meetingId, i),
        meetingId,
        s.source,
        i,
        i * 10_000,
        i * 10_000 + 9_000,
        s.text,
        s.label,
      );
    });
  } finally {
    db.close();
  }
}

/**
 * Writes one checkpoint row and one checkpoint write row for each run. A
 * finished run keeps none, so a delete test needs them to prove the cascade.
 */
export function seedCheckpointRows(
  userDataDir: string,
  runIds: string[],
): void {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    for (const runId of runIds) {
      db.prepare(
        `INSERT INTO llm_checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata)
         VALUES (?, '', 'cp-1', 'json', x'7b7d', x'7b7d')`,
      ).run(runId);
      db.prepare(
        `INSERT INTO llm_checkpoint_writes
           (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, task_path,
            channel, type, value)
         VALUES (?, '', 'cp-1', 'task-1', 0, '', 'ch', 'json', x'7b7d')`,
      ).run(runId);
    }
  } finally {
    db.close();
  }
}

/**
 * Row counts of the six tables of the LLM record for one meeting (10.9). Pass
 * the run ids read before a delete: the step and checkpoint tables reach the
 * meeting only through the run row.
 */
export function recordRowCounts(
  userDataDir: string,
  meetingId: string,
  runIds: string[],
): Record<string, number> {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"), {
    readOnly: true,
  });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const marks = runIds.map(() => "?").join(",") || "NULL";
    const count = (sql: string, ...args: string[]): number =>
      (db.prepare(sql).get(...args) as { n: number }).n;
    return {
      llm_runs: count(
        "SELECT count(*) AS n FROM llm_runs WHERE scope = 'meeting' AND scope_id = ?",
        meetingId,
      ),
      llm_run_steps: count(
        `SELECT count(*) AS n FROM llm_run_steps WHERE run_id IN (${marks})`,
        ...runIds,
      ),
      llm_calls: count(
        "SELECT count(*) AS n FROM llm_calls WHERE scope = 'meeting' AND scope_id = ?",
        meetingId,
      ),
      llm_call_links: count(
        "SELECT count(*) AS n FROM llm_call_links WHERE scope = 'meeting' AND scope_id = ?",
        meetingId,
      ),
      llm_checkpoints: count(
        `SELECT count(*) AS n FROM llm_checkpoints WHERE thread_id IN (${marks})`,
        ...runIds,
      ),
      llm_checkpoint_writes: count(
        `SELECT count(*) AS n FROM llm_checkpoint_writes WHERE thread_id IN (${marks})`,
        ...runIds,
      ),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// App set-up
// ---------------------------------------------------------------------------

export interface EnhanceApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  base: string;
  api(method: string, path: string, body?: unknown): Promise<Response>;
}

/**
 * Launches the app in quiet mode with the Meetings flag, a finished
 * onboarding, the fake server as an own server and as the default chat
 * model (10.11 set-up, items 1 to 3).
 */
export async function bootEnhanceApp(
  fake: FakeLlm,
  options: { advancedMode: boolean; prefix: string },
): Promise<EnhanceApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), options.prefix));
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  const app = await launchOpenstyle({ userDataDir });
  const page = await waitForDashboardWindow(app, 15_000);
  try {
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  } catch {
    await page.waitForLoadState("load", { timeout: 10_000 });
  }
  // Main's one-shot boot orphan sweep runs 3 s after startServerHost returns
  // (src/main/index.ts, the setTimeout of 3000 after createAppWindow). It
  // sweeps meetings in `recording` or `transcribing`, and the meetings of
  // these specs are `transcribed`, so it should not touch them. There is no
  // signal to poll: the sweep logs nothing when it finds nothing. This wait
  // starts after the window loaded, which is after the server started, so it
  // is at least 3.5 s after the timer started.
  await new Promise((r) => setTimeout(r, 3500));

  const base = embeddedServerUrl(app);
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const added = await api("POST", "/servers", { url: fake.url });
  expect(added.status, "POST /api/servers").toBe(201);
  const { id: serverId } = (await added.json()) as { id: string };
  const model = await api("POST", "/models/configured", {
    provider: "server",
    model_id: `server/${serverId}/fake-llm`,
    model_name: "Fake LLM",
    type: "llm",
    is_default: true,
  });
  expect(model.ok, "POST /api/models/configured").toBe(true);
  for (const [key, value] of [
    ["advanced_mode", String(options.advancedMode)],
    ["meeting_enhance_prompt_seen", "true"],
  ] as const) {
    const put = await api("PUT", `/settings/${key}`, { value });
    expect(put.status, `PUT /api/settings/${key}`).toBe(200);
  }
  // The window read the settings before the writes above. Load them again.
  await page.reload();
  await page.waitForLoadState("load");
  return { app, page, userDataDir, base, api };
}

/** Opens the detail view of a meeting from the list. */
export async function openMeeting(page: Page, title: string): Promise<void> {
  // A fresh load: the list query would not show a meeting seeded after it.
  await page.reload();
  await page.waitForLoadState("load");
  await page.getByRole("link", { name: "Meetings" }).click();
  await page.waitForURL(/\/meetings/);
  await page.getByText(title, { exact: true }).first().click();
}

export interface RunStepInfo {
  key: string;
  node: string;
  status: string;
  attempts: number;
  errorKind: string | null;
}

export interface RunInfo {
  id: string;
  kind: string;
  status: string;
  startedBy: string;
  resumeCount: number;
  errorKind: string | null;
  /** Only the failed and partly failed steps (10.9 item 9). */
  steps: RunStepInfo[];
  llmStepCount: number;
  failedStepCount: number;
  correctedCount: number | null;
}

/** The newest runs of a meeting, newest first. */
export async function readRuns(
  env: Pick<EnhanceApp, "api">,
  meetingId: string,
): Promise<RunInfo[]> {
  const res = await env.api("GET", `/meetings/${meetingId}/llm-runs`);
  expect(res.status, "GET llm-runs").toBe(200);
  return ((await res.json()) as { runs: RunInfo[] }).runs;
}

/** Waits until the newest run of a meeting has one of `statuses`. */
export async function waitForRun(
  env: Pick<EnhanceApp, "api">,
  meetingId: string,
  statuses: string[],
  timeoutMs = 60_000,
): Promise<RunInfo> {
  const deadline = Date.now() + timeoutMs;
  let last: RunInfo | undefined;
  while (Date.now() < deadline) {
    try {
      last = (await readRuns(env, meetingId))[0];
    } catch {
      // The server may be restarting.
    }
    if (last && statuses.includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `run of ${meetingId} did not reach ${statuses.join("|")}; last: ${last?.status ?? "none"}`,
  );
}

/** Every step row of a run, read from the database, in start order. */
export function readStepRows(
  userDataDir: string,
  runId: string,
): Array<{ key: string; node: string; status: string; attempts: number }> {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"), {
    readOnly: true,
  });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db
      .prepare(
        `SELECT step_key AS key, node, status, attempts
           FROM llm_run_steps WHERE run_id = ? ORDER BY seq`,
      )
      .all(runId) as Array<{
      key: string;
      node: string;
      status: string;
      attempts: number;
    }>;
  } finally {
    db.close();
  }
}
