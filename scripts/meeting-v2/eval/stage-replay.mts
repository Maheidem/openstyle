// stage-replay.mts: stage capture and stage replay of the per-stage
// parameter sweep (`pnpm meeting:eval:sweep`, PR #308, issue #307).
//
// Capture: a kept `meeting:eval` run holds every LLM call of Enhance and
// Summarize in the llm_calls rows of its run DB (messages, schema, params,
// step label, raw answer). `captureRun` copies, per meeting and model, the
// run DB and the calls into ~/.openstyle-eval/sweep/<id8>/ (folder 0700,
// files 0600). The files hold real meeting text: never commit or print them.
//
// Replay: a stage executor rebuilds the requests of one stage and sends them
// to the local MLX worker with overridden settings. Sampling settings
// (temperature, top_p, top_k, min_p, max_tokens, thinking) change the stored
// wire body. App-level settings change the stage input, and the executor
// rebuilds it with the server's own builders (chunking, prompts, plan,
// checks, verifyEvidence), never with a hand-made prompt:
//   correctChunk  chunkTokens (CHUNK_TOKENS_MAX of the server, 1200 today)
//   summarize     contextBudget (meeting_summary_context_budget, 8000 today)
//   suggestTags   maxItems (a JSON Schema maxItems on the tags list)
// `rebuildCheck` proves that the rebuild at the current settings gives the
// stored requests byte for byte.
//
// Only the app's built-in MLX models run, on a worker that this process
// starts on 127.0.0.1. Nothing here calls the owner's model server or the
// installed app. Messages name steps, ids and counts, never meeting text.

import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { speakerDisplayLabel } from "../../../apps/server/src/lib/meetings/merge.ts";
import { parseAttendees } from "../../../apps/server/src/lib/meetings/store.ts";
import { loadMergedTranscript } from "../../../apps/server/src/lib/meetings/transcript-io.ts";
import {
  chunkForEnhance,
  chunkTranscript,
  estimateTokens,
  formatSegment,
} from "../../../apps/server/src/lib/meetings/workflow/chunking.ts";
import { checkCorrections } from "../../../apps/server/src/lib/meetings/workflow/nodes/correct-chunk.ts";
import { verifyEvidence } from "../../../apps/server/src/lib/meetings/workflow/nodes/verify-evidence.ts";
import {
  buildCorrectUserPrompt,
  buildSummaryMapSystemPrompt,
  buildSummaryMapUserPrompt,
  buildSummaryReduceSystemPrompt,
  buildSummaryReduceUserPrompt,
  buildSummarySingleSystemPrompt,
  buildSummarySingleUserPrompt,
  reduceBlocks,
} from "../../../apps/server/src/lib/meetings/workflow/prompts.ts";
import {
  correctChunkStepSchema,
  identifySpeakersStepSchema,
  MEETING_TAGS_STEP_SCHEMA,
  type MeetingSummary,
  meetingSummaryStepSchema,
} from "../../../apps/server/src/lib/meetings/workflow/schemas.ts";
import {
  MAX_SUMMARIZE_CALLS,
  plannedSummaryCalls,
  repairCutSummary,
} from "../../../apps/server/src/lib/meetings/workflow/summary-pure.ts";
import {
  CHUNK_TOKENS_MAX,
  CORRECT_ANSWER_FACTOR,
  CORRECT_ANSWER_FIXED,
  type PreparedMeeting,
  type PreparedSegment,
  SAFETY_TOKENS,
} from "../../../apps/server/src/lib/meetings/workflow/types.ts";
import { MLX_LLM_MODELS } from "../../../apps/server/src/lib/mlx-llm/constants.ts";
import {
  MAX_SUGGESTED_TAGS,
  normalizeTagNames,
} from "../../../packages/validations/src/meeting-tags.ts";
import { parseMeetingSummaryInstructions } from "../../../packages/validations/src/settings.ts";
import type { SegmentRow } from "./checks.mts";
import type { SpeakerRow } from "./score.mts";

export const SWEEP_DIR = join(homedir(), ".openstyle-eval", "sweep");
export const STAGES = [
  "correctChunk",
  "identifySpeakers",
  "summarize",
  "suggestTags",
] as const;
export type StageName = (typeof STAGES)[number];

/** The current app values of the app-level settings (the sweep baseline). */
export const CURRENT = {
  chunkTokens: CHUNK_TOKENS_MAX,
  contextBudget: 8000,
  maxItems: null as number | null,
};

// --- Capture --------------------------------------------------------------------------

export interface Message {
  role: string;
  content: string;
}

/** One stored LLM call: the exact request and the stored answer. */
export interface StoredCall {
  id: number;
  node: string;
  unitKey: string;
  attempt: number;
  schemaName: string;
  messages: Message[];
  schema: Record<string, unknown>;
  /** The wire body without messages and schema (llm_calls.params_json). */
  topLevel: Record<string, unknown>;
  extraBody: Record<string, unknown>;
  rawText: string | null;
  finish: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
}

export interface Capture {
  format: "openstyle-stage-capture";
  version: 1;
  meetingId: string;
  model: string;
  asrHash: string | null;
  capturedAt: string;
  calls: StoredCall[];
}

/** The stored calls of one meeting, in call order, from a run DB. */
export function readCalls(dbPath: string, meetingId: string): StoredCall[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.node, c.step_key, c.attempt, c.schema_name, c.messages_json,
                c.schema_json, c.params_json, c.raw_text, c.finish_unified,
                c.input_tokens, c.output_tokens, c.latency_ms
         FROM llm_calls c JOIN llm_runs r ON r.id = c.run_id
         WHERE r.meeting_id = ? ORDER BY c.id`,
      )
      .all(meetingId) as Record<string, unknown>[];
    return rows.map((r) => {
      const params = JSON.parse(String(r.params_json)) as {
        topLevel?: Record<string, unknown>;
        extraBody?: Record<string, unknown>;
      };
      return {
        id: Number(r.id),
        node: String(r.node),
        unitKey: String(r.step_key),
        attempt: Number(r.attempt),
        schemaName: String(r.schema_name),
        messages: JSON.parse(String(r.messages_json)) as Message[],
        schema: JSON.parse(String(r.schema_json)) as Record<string, unknown>,
        topLevel: params.topLevel ?? {},
        extraBody: params.extraBody ?? {},
        rawText: (r.raw_text as string | null) ?? null,
        finish: (r.finish_unified as string | null) ?? null,
        inputTokens: (r.input_tokens as number | null) ?? null,
        outputTokens: (r.output_tokens as number | null) ?? null,
        latencyMs: (r.latency_ms as number | null) ?? null,
      };
    });
  } finally {
    db.close();
  }
}

export const slug = (model: string) => model.replace(/[^A-Za-z0-9.-]+/g, "-");
export const capturePaths = (id8: string, model: string, root = SWEEP_DIR) => ({
  dir: join(root, id8),
  calls: join(root, id8, `${slug(model)}.calls.json`),
  db: join(root, id8, `${slug(model)}.run.db`),
});

/**
 * Copy the run DB and the calls of one meeting into the private sweep
 * folder (0700 folder, 0600 files) and read the calls back.
 */
export function captureRun(o: {
  runDb: string;
  meetingId: string;
  model: string;
  asrHash: string | null;
  root?: string;
}): { calls: number; path: string } {
  const p = capturePaths(o.meetingId.slice(0, 8), o.model, o.root);
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(join(p.dir, ".."), 0o700);
  chmodSync(p.dir, 0o700);
  const calls = readCalls(o.runDb, o.meetingId);
  if (calls.length === 0) throw new Error("the run DB has no llm_calls rows");
  const cap: Capture = {
    format: "openstyle-stage-capture",
    version: 1,
    meetingId: o.meetingId,
    model: o.model,
    asrHash: o.asrHash,
    capturedAt: new Date().toISOString(),
    calls,
  };
  writeFileSync(p.calls, `${JSON.stringify(cap)}\n`, { mode: 0o600 });
  copyFileSync(o.runDb, p.db);
  chmodSync(p.calls, 0o600);
  chmodSync(p.db, 0o600);
  const back = loadCapture(o.meetingId.slice(0, 8), o.model, o.root);
  if (back.calls.length !== calls.length)
    throw new Error(`capture read back ${back.calls.length} calls`);
  return { calls: calls.length, path: p.calls };
}

export function loadCapture(
  id8: string,
  model: string,
  root = SWEEP_DIR,
): Capture {
  const p = capturePaths(id8, model, root);
  if ((statSync(p.dir).mode & 0o077) !== 0)
    throw new Error(`${p.dir} must have mode 0700`);
  const cap = JSON.parse(readFileSync(p.calls, "utf8")) as Capture;
  if (cap.format !== "openstyle-stage-capture" || cap.version !== 1)
    throw new Error(`${p.calls}: not a stage capture`);
  return cap;
}

// --- Wire body and overrides ------------------------------------------------------------

export interface Overrides {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  /** Added to the max_tokens of each call. */
  maxTokensExtra?: number;
  /** chat_template_kwargs.enable_thinking. */
  thinking?: boolean;
  /** One word changed in the system prompt (the noise-band arm). */
  perturb?: [string, string];
  /** The worker's repetition_penalty (mlx-lm window: 20 tokens). */
  repetition_penalty?: number;
  /** llama.cpp only (the MLX worker drops it). */
  seed?: number;
}

const NUMBER_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "repetition_penalty",
  "seed",
] as const;

/** The wire body of a stored call: params + messages + schema. */
export function wireBody(c: {
  topLevel: Record<string, unknown>;
  extraBody: Record<string, unknown>;
  messages: Message[];
  schema: Record<string, unknown>;
}): Record<string, unknown> {
  const body = structuredClone({
    ...c.topLevel,
    ...c.extraBody,
  }) as Record<string, any>;
  body.messages = structuredClone(c.messages);
  const rf = body.response_format;
  if (rf?.type === "json_schema" && rf.json_schema)
    rf.json_schema.schema = structuredClone(c.schema);
  return body;
}

/** A copy of the body with the overrides applied. Throws on a bad perturb word. */
export function applyOverrides(
  body: Record<string, unknown>,
  o: Overrides,
): Record<string, any> {
  const b = structuredClone(body) as Record<string, any>;
  for (const k of NUMBER_KEYS) if (o[k] !== undefined) b[k] = o[k];
  if (o.maxTokensExtra) b.max_tokens = Number(b.max_tokens) + o.maxTokensExtra;
  if (o.thinking !== undefined)
    b.chat_template_kwargs = {
      ...(b.chat_template_kwargs ?? {}),
      enable_thinking: o.thinking,
    };
  if (o.perturb) {
    const sys = (b.messages as Message[]).find((m) => m.role === "system");
    const [from, to] = o.perturb;
    if (!sys?.content.includes(from))
      throw new Error(`perturb: the system prompt has no "${from}"`);
    sys.content = sys.content.replace(from, to);
  }
  return b;
}

/** The overrides that a parameter set holds (the app-level keys are not overrides). */
export function overridesOf(params: Record<string, unknown>): Overrides {
  const o: Overrides = {};
  for (const k of NUMBER_KEYS)
    if (typeof params[k] === "number") o[k] = params[k] as number;
  if (typeof params.maxTokensExtra === "number")
    o.maxTokensExtra = params.maxTokensExtra as number;
  if (typeof params.thinking === "boolean") o.thinking = params.thinking;
  return o;
}

// --- Worker ---------------------------------------------------------------------------

export interface Reply {
  text: string;
  finish: string;
  outputTokens: number;
  promptTokens: number;
  latencyMs: number;
}
export type Complete = (body: Record<string, unknown>) => Promise<Reply>;

/**
 * POST one body to an OpenAI-style chat URL (timeout per call). Throws on a
 * non-200. The MLX worker: `<base>/v1/chat/completions`. The llama.cpp
 * desktop backend (owner, 2026-10-22, sweeps only): `model` is the server's
 * model name, repetition_penalty goes as repeat_penalty, the prompt cache is
 * off, and at most `parallel` requests run at a time.
 */
export function workerClient(
  chatUrl: string,
  o: { timeoutMs?: number; model?: string; parallel?: number } = {},
): Complete {
  let running = 0;
  const waiting: (() => void)[] = [];
  const parallel = o.parallel ?? 1;
  return async (input) => {
    while (running >= parallel) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await post(input);
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
  async function post(input: Record<string, unknown>): Promise<Reply> {
    const body: Record<string, unknown> = { ...input, stream: false };
    if (o.model) {
      body.model = o.model;
      // The prompt cache changes the logits a little: at temperature 0 the
      // same summary request gave 2 different answers in 3 runs with it, and
      // 3 equal answers without it (2026-10-22).
      body.cache_prompt = false;
      if (body.repetition_penalty !== undefined) {
        body.repeat_penalty = body.repetition_penalty;
        delete body.repetition_penalty;
      }
    }
    const t0 = Date.now();
    const r = await fetch(chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 900_000),
    });
    const j = (await r.json().catch(() => null)) as any;
    if (r.status !== 200 || !j?.choices?.[0])
      throw new Error(`the model server answered ${r.status}`);
    return {
      text: String(j.choices[0].message?.content ?? ""),
      finish: String(j.choices[0].finish_reason ?? ""),
      outputTokens: Number(j.usage?.completion_tokens ?? 0),
      promptTokens: Number(j.usage?.prompt_tokens ?? 0),
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * Start the MLX worker in LLM mode for a built-in model on 127.0.0.1:<port>
 * and wait until GET /v1/models answers. HF cache and HOME are scratch
 * folders under /tmp.
 */
export async function startWorker(o: {
  worker: string;
  model: string;
  port: number;
  hfCache: string;
  home: string;
  log: string;
}): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  if (o.port === 4649 || o.port === 8123)
    throw new Error(`port ${o.port} is not allowed`);
  const def = MLX_LLM_MODELS.find((m) => m.id === o.model);
  if (!def) throw new Error(`unknown built-in model ${o.model}`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env))
    if (
      /^(LANGSMITH|LANGCHAIN|MLFLOW|OKTO_NEURON|MARGINALIA|OPENSTYLE_LOG)/i.test(
        k,
      )
    )
      delete env[k];
  Object.assign(env, {
    HF_HOME: o.hfCache,
    HF_HUB_CACHE: join(o.hfCache, "hub"),
    HUGGINGFACE_HUB_CACHE: join(o.hfCache, "hub"),
    HF_HUB_OFFLINE: "1",
    HOME: o.home,
  });
  mkdirSync(o.home, { recursive: true });
  const { createWriteStream } = await import("node:fs");
  const log = createWriteStream(o.log);
  const child: ChildProcess = spawn(
    o.worker,
    ["--llm", "--model", def.hfId, "--port", String(o.port)],
    // The worker stops when its stdin closes: keep a pipe open.
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const baseUrl = `http://127.0.0.1:${o.port}`;
  const kill = () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  process.on("exit", kill);
  const stop = async () => {
    process.off("exit", kill);
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    if (child.exitCode === null) child.kill("SIGKILL");
    log.end();
  };
  const end = Date.now() + 300_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) break;
    const ok = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    }).then(
      (r) => r.status === 200,
      () => false,
    );
    if (ok) return { baseUrl, stop };
    await new Promise((r) => setTimeout(r, 1000));
  }
  await stop();
  throw new Error(`the worker did not start; log: ${o.log}`);
}

// --- Stage output -----------------------------------------------------------------------

export interface CallStat {
  key: string;
  finish: string;
  outputTokens: number;
  latencyMs: number;
  jsonValid: boolean;
}

export interface StageOutput {
  stage: StageName;
  calls: CallStat[];
  /** Units that gave no usable answer (finish length, bad JSON). */
  failedUnits: number;
  /** correctChunk: segment id -> applied correction. */
  corrections?: Record<string, string>;
  /** correctChunk: the drops of the server checks, by reason. */
  dropped?: Record<string, number>;
  /** identifySpeakers: the rows that save would write. */
  speakers?: SpeakerRow[];
  /** summarize: the summary JSON as save stores it, or null. */
  summaryJson?: string | null;
  summaryPartial?: boolean;
  /** suggestTags: the tags that the node keeps. */
  tags?: string[];
  /** The built requests (for the rebuild check; not written to results). */
  requests?: Record<string, unknown>[];
}

/** The meeting context that the stage builders need, read from the run DB. */
export interface MeetingInput {
  meetingId: string;
  row: Record<string, any>;
  /** Segments as prepare.ts builds them. */
  segments: PreparedSegment[];
  language: string | null;
  summaryInstructions: string;
  /** meeting_segments rows (for the scorer). */
  rows: SegmentRow[];
}

/** The scratch folder of this process (deleted by `removeWorkDir`). */
export const WORK_DIR = join(
  "/tmp/meeting-eval/sweep-work",
  String(process.pid),
);
export function removeWorkDir(): void {
  rmSync(WORK_DIR, { recursive: true, force: true });
}

/**
 * The server's transcript loader reads the vocabulary through getDb(), which
 * opens OPENSTYLE_DB_PATH and migrates it. Point it at a private scratch
 * copy of the first run DB (every meeting of the eval has the same
 * vocabulary), never at a capture file.
 */
function ensureServerDb(dbPath: string): void {
  if (process.env.OPENSTYLE_DB_PATH?.startsWith(WORK_DIR)) return;
  mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  const copy = join(WORK_DIR, "server.db");
  copyFileSync(dbPath, copy);
  process.env.OPENSTYLE_DB_PATH = copy;
}

/** Read the meeting the way prepare.ts does (merged transcript, labels). */
export function readMeeting(dbPath: string, meetingId: string): MeetingInput {
  ensureServerDb(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT * FROM meetings WHERE id = ?")
      .get(meetingId) as Record<string, any>;
    if (!row) throw new Error(`meeting ${meetingId.slice(0, 8)} not in DB`);
    const merged = loadMergedTranscript(meetingId, row.audio_dir, db).filter(
      (s) => Boolean(s.id) && s.text.trim().length > 0,
    );
    const segments: PreparedSegment[] = merged.map((s) => ({
      id: s.id as string,
      speaker: s.speaker,
      startMs: s.startMs,
      speakerLabel:
        s.speaker === "Them" && s.speakerLabel ? s.speakerLabel : null,
      displayLabel: speakerDisplayLabel(s, "Them"),
      text: s.text,
      enhancedText: s.enhancedText ?? null,
      speakerName: s.speakerName ?? null,
    }));
    const instr = db
      .prepare(
        "SELECT value FROM settings WHERE key = 'meeting_summary_instructions'",
      )
      .get() as { value: string } | undefined;
    const rows = db
      .prepare(
        "SELECT id, source, idx, start_ms, text, enhanced_text FROM meeting_segments WHERE meeting_id = ? ORDER BY source, idx, start_ms",
      )
      .all(meetingId) as unknown as SegmentRow[];
    return {
      meetingId,
      row,
      segments,
      language: row.language ?? null,
      summaryInstructions: parseMeetingSummaryInstructions(instr?.value),
      rows,
    };
  } finally {
    db.close();
  }
}

/** The last attempt of each unit of one node, in call order. */
export function finalCalls(calls: StoredCall[], node: string): StoredCall[] {
  const last = new Map<string, StoredCall>();
  for (const c of calls) if (c.node === node) last.set(c.unitKey, c);
  return [...last.values()].sort((a, b) => a.id - b.id);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The text between the transcript tags of a user prompt, as lines. */
export function transcriptLines(user: string): string[] {
  const m = /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(user);
  return m ? (m[1] as string).split("\n") : [];
}

/** `[id] Label: text` (formatEnhanceLine) back to its parts. */
export function parseEnhanceLine(
  line: string,
): { id: string; label: string; text: string } | null {
  const m = /^\[([^\]]+)\] (.+?): ([\s\S]*)$/.exec(line);
  return m
    ? { id: m[1] as string, label: m[2] as string, text: m[3] as string }
    : null;
}

// --- correctChunk -------------------------------------------------------------------

/**
 * Rebuild the correctChunk units at `chunkTokens` with the server builders:
 * the segment lines come from the stored prompts (exact), chunkForEnhance
 * cuts them, buildCorrectUserPrompt wraps them, and the stored schema gets
 * the id enum of the new chunk (correctChunkStepSchema shape).
 */
export function buildCorrectRequests(calls: StoredCall[], chunkTokens: number) {
  const stored = finalCalls(calls, "correctChunk");
  const first = stored[0];
  if (!first) return { requests: [], segments: [] as PreparedSegment[] };
  const seen = new Set<string>();
  const segments: PreparedSegment[] = [];
  for (const c of stored) {
    const user = c.messages.find((m) => m.role === "user")?.content ?? "";
    for (const line of transcriptLines(user)) {
      const p = parseEnhanceLine(line);
      if (!p)
        throw new Error(`correctChunk call ${c.id}: a line does not parse`);
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      segments.push({
        id: p.id,
        speaker: p.label === "Me" ? "Me" : "Them",
        startMs: 0,
        speakerLabel: null,
        displayLabel: p.label,
        text: p.text,
        enhancedText: null,
        speakerName: null,
      });
    }
  }
  const system = first.messages.find((m) => m.role === "system")?.content ?? "";
  const lineOf = (s: PreparedSegment) =>
    `[${s.id}] ${s.displayLabel}: ${s.text}`;
  const chunks = chunkForEnhance(
    segments.map((s) => ({ id: s.id, speaker: s.displayLabel, text: s.text })),
    chunkTokens,
  );
  const byId = new Map(segments.map((s) => [s.id, s]));
  const requests = chunks.map((chunk, i) => {
    const members = chunk.map((c) => byId.get(c.id) as PreparedSegment);
    const lines = members.map(lineOf);
    const tokens = lines.reduce((a, l) => a + estimateTokens(l) + 1, 0);
    const schema = structuredClone(first.schema) as any;
    schema.properties.corrections.items.properties.id.enum = [
      ...new Set(members.map((s) => s.id)),
    ];
    const body = wireBody({
      topLevel: first.topLevel,
      extraBody: first.extraBody,
      messages: [
        { role: "system", content: system },
        { role: "user", content: buildCorrectUserPrompt(lines) },
      ],
      schema,
    });
    body.max_tokens = Math.min(
      8192,
      Math.ceil(tokens * CORRECT_ANSWER_FACTOR) + CORRECT_ANSWER_FIXED,
    );
    return { key: `chunk:${i}`, body, members };
  });
  return { requests, segments };
}

export async function runCorrect(
  cap: Capture,
  params: Record<string, unknown>,
  complete: Complete,
  extra: Overrides = {},
): Promise<StageOutput> {
  const chunkTokens = Number(params.chunkTokens ?? CURRENT.chunkTokens);
  const { requests } = buildCorrectRequests(cap.calls, chunkTokens);
  const o = { ...overridesOf(params), ...extra };
  const out: StageOutput = {
    stage: "correctChunk",
    calls: [],
    failedUnits: 0,
    corrections: {},
    dropped: {},
    requests: [],
  };
  // The chunks are independent: send them together (the client limits the
  // parallel requests), then read the answers in chunk order.
  const bodies = requests.map((r) => applyOverrides(r.body, o));
  out.requests?.push(...bodies);
  const replies = await Promise.all(bodies.map((b) => complete(b)));
  for (const [i, r] of requests.entries()) {
    const reply = replies[i] as Reply;
    const ids = r.members.map((s) => s.id);
    const parsed =
      reply.finish === "stop"
        ? correctChunkStepSchema(ids).zod.safeParse(parseJson(reply.text))
        : null;
    out.calls.push({
      key: r.key,
      finish: reply.finish,
      outputTokens: reply.outputTokens,
      latencyMs: reply.latencyMs,
      jsonValid: parsed?.success === true,
    });
    if (!parsed?.success) {
      out.failedUnits++;
      continue;
    }
    const checked = checkCorrections(parsed.data.corrections, r.members, null);
    for (const c of checked.corrections)
      (out.corrections as Record<string, string>)[c.id] = c.text;
    for (const d of checked.dropped) {
      const m = out.dropped as Record<string, number>;
      m[d.reason] = (m[d.reason] ?? 0) + 1;
    }
  }
  return out;
}

// --- identifySpeakers --------------------------------------------------------------

/** The PreparedMeeting fields that verifyEvidence reads. */
export function preparedFor(m: MeetingInput): PreparedMeeting {
  const all: string[] = [];
  const confirmed = new Set<string>();
  for (const s of m.segments) {
    if (s.speaker !== "Them" || !s.speakerLabel) continue;
    if (!all.includes(s.speakerLabel)) all.push(s.speakerLabel);
    if (s.speakerName) confirmed.add(s.speakerLabel);
  }
  return {
    meetingId: m.meetingId,
    language: m.language,
    title: m.row.title ?? null,
    context: m.row.context ?? null,
    contextWithFolder: m.row.context ?? null,
    vocabTerms: [],
    attendeeNames: parseAttendees(m.row as never)
      .map((a) => a.name)
      .filter((n) => n.trim().length > 0),
    segments: m.segments,
    chunks: [],
    labels: {
      all,
      confirmed: all.filter((l) => confirmed.has(l)),
      toIdentify: all.filter((l) => !confirmed.has(l)),
    },
    chunkTokens: CURRENT.chunkTokens,
    summary: {
      instructions: m.summaryInstructions,
      contextBudget: CURRENT.contextBudget,
    },
    inputHash: "",
  } as PreparedMeeting;
}

export async function runIdentify(
  cap: Capture,
  meeting: MeetingInput,
  params: Record<string, unknown>,
  complete: Complete,
  extra: Overrides = {},
): Promise<StageOutput> {
  const o = { ...overridesOf(params), ...extra };
  const out: StageOutput = {
    stage: "identifySpeakers",
    calls: [],
    failedUnits: 0,
    speakers: [],
    requests: [],
  };
  const proposals: Parameters<typeof verifyEvidence>[1][number][] = [];
  const shown: { unitKey: string; segmentIds: string[] }[] = [];
  for (const c of finalCalls(cap.calls, "identifySpeakers")) {
    const body = applyOverrides(wireBody(c), o);
    out.requests?.push(body);
    const reply = await complete(body);
    const item = (c.schema as any).properties.speakers.items.properties;
    const ids: string[] = item.segmentId.enum ?? [];
    const labels: string[] = item.label.enum ?? [];
    const parsed =
      reply.finish === "stop"
        ? identifySpeakersStepSchema(ids, labels, {
            sizeLimits: true,
          }).zod.safeParse(parseJson(reply.text))
        : null;
    out.calls.push({
      key: c.unitKey,
      finish: reply.finish,
      outputTokens: reply.outputTokens,
      latencyMs: reply.latencyMs,
      jsonValid: parsed?.success === true,
    });
    if (!parsed?.success) {
      out.failedUnits++;
      continue;
    }
    shown.push({ unitKey: c.unitKey, segmentIds: ids });
    parsed.data.speakers.forEach((p, seq) => {
      proposals.push({
        unitKey: c.unitKey,
        llmCallId: c.id,
        seq,
        segmentId: p.segmentId,
        quote: p.quote,
        label: p.label,
        kind: p.kind,
        name: p.name,
      });
    });
  }
  const { suggestions } = verifyEvidence(
    preparedFor(meeting),
    proposals,
    shown,
  );
  out.speakers = suggestions.map((s) => ({
    label: s.label,
    suggested_name: s.name,
    suggested_kind: s.kind,
  }));
  return out;
}

// --- suggestTags --------------------------------------------------------------------

export async function runTags(
  cap: Capture,
  params: Record<string, unknown>,
  complete: Complete,
  extra: Overrides = {},
): Promise<StageOutput> {
  const o = { ...overridesOf(params), ...extra };
  const out: StageOutput = {
    stage: "suggestTags",
    calls: [],
    failedUnits: 0,
    tags: [],
    requests: [],
  };
  for (const c of finalCalls(cap.calls, "suggestTags")) {
    const schema = structuredClone(c.schema) as any;
    if (typeof params.maxItems === "number")
      schema.properties.tags.maxItems = params.maxItems;
    const body = applyOverrides(wireBody({ ...c, schema }), o);
    out.requests?.push(body);
    const reply = await complete(body);
    const parsed =
      reply.finish === "stop"
        ? MEETING_TAGS_STEP_SCHEMA.zod.safeParse(parseJson(reply.text))
        : null;
    out.calls.push({
      key: c.unitKey,
      finish: reply.finish,
      outputTokens: reply.outputTokens,
      latencyMs: reply.latencyMs,
      jsonValid: parsed?.success === true,
    });
    if (!parsed?.success) {
      out.failedUnits++;
      continue;
    }
    out.tags = normalizeTagNames(parsed.data.tags).slice(0, MAX_SUGGESTED_TAGS);
  }
  return out;
}

// --- summarize ------------------------------------------------------------------------

/** The summary lines of a summarize-only run (summarize.ts summarySegments, not chained). */
export function summaryLines(m: MeetingInput) {
  const segs = m.segments
    .map((s) => ({
      startMs: s.startMs,
      endMs: s.startMs,
      text: s.enhancedText ?? s.text,
      speaker: s.speaker,
      ...(s.speakerLabel ? { speakerLabel: s.speakerLabel } : {}),
      ...(s.speakerName ? { speakerName: s.speakerName } : {}),
    }))
    .filter((s) => s.text.trim().length > 0);
  return { segs, lines: segs.map((s) => formatSegment(s as never)) };
}

const SUMMARY_ANSWER_TOKENS = 4096;
const CONTEXT_WINDOW = 32_768;

/**
 * One Summarize run (summarize.ts): `single` when the transcript fits the
 * budget, else map calls and grouped reduce calls. A `single` that ends at
 * the token limit is planned again as map and reduce at half the tokens,
 * as the server does. A map or reduce unit that ends at the token limit is
 * repaired from its cut answer (repairCutSummary) or fails; the server's
 * split and raise steps are not run (no split happened in the capture).
 */
export async function runSummary(
  cap: Capture,
  meeting: MeetingInput,
  params: Record<string, unknown>,
  complete: Complete,
  extra: Overrides = {},
): Promise<StageOutput> {
  const o = { ...overridesOf(params), ...extra };
  const template = finalCalls(cap.calls, "summarize")[0];
  const out: StageOutput = {
    stage: "summarize",
    calls: [],
    failedUnits: 0,
    summaryJson: null,
    summaryPartial: false,
    requests: [],
  };
  if (!template) return out;
  const { segs, lines } = summaryLines(meeting);
  const promptInput = {
    language: meeting.language,
    instructions: meeting.summaryInstructions,
    context: meeting.row.context ?? null,
  };
  const systems = {
    single: buildSummarySingleSystemPrompt(promptInput),
    map: buildSummaryMapSystemPrompt(promptInput),
    reduce: buildSummaryReduceSystemPrompt(promptInput),
  };
  const systemTokens = Math.max(...Object.values(systems).map(estimateTokens));
  const fit =
    CONTEXT_WINDOW - systemTokens - SUMMARY_ANSWER_TOKENS - SAFETY_TOKENS;
  const budget = Math.min(
    Number(params.contextBudget ?? CURRENT.contextBudget),
    fit,
  );
  const zod = meetingSummaryStepSchema({ sizeLimits: true }).zod;
  let made = 0;

  const call = async (
    key: string,
    system: string,
    user: string,
  ): Promise<{ obj: MeetingSummary | null; length: boolean; cut: boolean }> => {
    if (made >= MAX_SUMMARIZE_CALLS)
      return { obj: null, length: false, cut: false };
    made++;
    const body = applyOverrides(
      wireBody({
        topLevel: template.topLevel,
        extraBody: template.extraBody,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        schema: template.schema,
      }),
      o,
    );
    body.max_tokens = SUMMARY_ANSWER_TOKENS + (o.maxTokensExtra ?? 0);
    out.requests?.push(body);
    const reply = await complete(body);
    const length = reply.finish === "length";
    const parsed = length ? null : zod.safeParse(parseJson(reply.text));
    out.calls.push({
      key,
      finish: reply.finish,
      outputTokens: reply.outputTokens,
      latencyMs: reply.latencyMs,
      jsonValid: parsed?.success === true,
    });
    if (parsed?.success)
      return { obj: parsed.data as MeetingSummary, length, cut: false };
    if (length) {
      const fixed = repairCutSummary(reply.text, zod) as MeetingSummary | null;
      if (fixed) return { obj: fixed, length, cut: true };
    }
    return { obj: null, length, cut: false };
  };

  const partialTokens = (p: MeetingSummary[]) =>
    reduceBlocks(p).reduce((a, b) => a + estimateTokens(b) + 1, 0);

  const mapReduce = async (
    chunkBudget: number,
  ): Promise<MeetingSummary | null | "one"> => {
    const chunks = chunkTranscript(segs as never, chunkBudget);
    if (chunks.length < 2) return "one";
    if (made + chunks.length + 1 > MAX_SUMMARIZE_CALLS) return null;
    // The map calls are independent: send them together, keep chunk order.
    const maps = await Promise.all(
      chunks.map((chunk, i) =>
        call(
          `map:${i}`,
          systems.map,
          buildSummaryMapUserPrompt(chunk, i, chunks.length),
        ),
      ),
    );
    const partials: MeetingSummary[] = [];
    for (const r of maps) {
      if (!r.obj) return null;
      if (r.cut) out.summaryPartial = true;
      partials.push(r.obj);
    }
    let current = partials;
    for (let level = 1; ; level++) {
      const groups: MeetingSummary[][] = [];
      let cur: MeetingSummary[] = [];
      for (const p of current) {
        const next = [...cur, p];
        if (cur.length > 0 && partialTokens(next) > budget) {
          groups.push(cur);
          cur = [p];
        } else cur = next;
      }
      if (cur.length > 0) groups.push(cur);
      if (groups.length === current.length && current.length > 1) return null;
      if (groups.length === 1) {
        const r = await call(
          `reduce:${level}:0`,
          systems.reduce,
          buildSummaryReduceUserPrompt(groups[0] as MeetingSummary[]),
        );
        if (r.cut) out.summaryPartial = true;
        return r.obj;
      }
      const next: MeetingSummary[] = [];
      for (const [g, group] of groups.entries()) {
        if (group.length === 1) {
          next.push(group[0] as MeetingSummary);
          continue;
        }
        const r = await call(
          `reduce:${level}:${g}`,
          systems.reduce,
          buildSummaryReduceUserPrompt(group),
        );
        if (!r.obj) return null;
        if (r.cut) out.summaryPartial = true;
        next.push(r.obj);
      }
      current = next;
    }
  };

  const tokens = estimateTokens(lines.join("\n"));
  let result: MeetingSummary | null = null;
  if ("error" in plannedSummaryCalls(tokens, budget)) {
    out.failedUnits++;
    return out;
  }
  const single = () =>
    call(
      "single",
      systems.single,
      buildSummarySingleUserPrompt(lines.join("\n")),
    );
  if (tokens <= budget) {
    const r = await single();
    if (r.obj && !r.cut) result = r.obj;
    else if (r.length) {
      const half = Math.ceil(tokens / 2);
      const done =
        "error" in plannedSummaryCalls(tokens, half)
          ? "one"
          : await mapReduce(half);
      if (done === "one") {
        result = r.obj;
        if (r.cut) out.summaryPartial = true;
      } else result = done;
    }
  } else {
    const done = await mapReduce(budget);
    if (done === "one") {
      const r = await single();
      result = r.obj;
      if (r.cut) out.summaryPartial = true;
    } else result = done;
  }
  if (result === null) out.failedUnits++;
  out.summaryJson = result ? JSON.stringify(result) : null;
  return out;
}

/** Run one stage for one meeting. */
export function runStage(
  stage: StageName,
  cap: Capture,
  meeting: MeetingInput,
  params: Record<string, unknown>,
  complete: Complete,
  extra: Overrides = {},
): Promise<StageOutput> {
  if (stage === "correctChunk") return runCorrect(cap, params, complete, extra);
  if (stage === "identifySpeakers")
    return runIdentify(cap, meeting, params, complete, extra);
  if (stage === "summarize")
    return runSummary(cap, meeting, params, complete, extra);
  return runTags(cap, params, complete, extra);
}

/** The node name of a stage in llm_calls. */
export const NODE_OF: Record<StageName, string> = {
  correctChunk: "correctChunk",
  identifySpeakers: "identifySpeakers",
  summarize: "summarize",
  suggestTags: "suggestTags",
};

/** The one-word change of the noise-band arm, per stage (a word of its system prompt). */
export const PERTURB: Record<StageName, [string, string]> = {
  correctChunk: ["garbled words", "jumbled words"],
  identifySpeakers: ["read an excerpt", "read a section"],
  summarize: ["substantive points", "important points"],
  suggestTags: ["short topic tags", "brief topic tags"],
};

// --- Rebuild check (no GPU) -------------------------------------------------------------

/** The body as bytes (key order kept, so a schema property order change counts). */
const canon = (b: Record<string, unknown>) => {
  const { stream: _s, ...rest } = b;
  return JSON.stringify(rest);
};

/**
 * Rebuild the requests of a stage at the current settings and compare them
 * with the stored requests (same set, byte-equal JSON). The
 * stub answers with the stored answer of the call whose request matches.
 */
export async function rebuildCheck(
  stage: StageName,
  cap: Capture,
  meeting: MeetingInput,
): Promise<{ stored: number; rebuilt: number; equal: number }> {
  const stored = finalCalls(cap.calls, NODE_OF[stage]);
  const byBody = new Map(stored.map((c) => [canon(wireBody(c)), c]));
  let equal = 0;
  const stub: Complete = async (body) => {
    const hit = byBody.get(canon(body));
    if (hit) equal++;
    return {
      text: hit?.rawText ?? "",
      finish: hit ? (hit.finish ?? "stop") : "length",
      outputTokens: hit?.outputTokens ?? 0,
      promptTokens: hit?.inputTokens ?? 0,
      latencyMs: 0,
    };
  };
  const out = await runStage(stage, cap, meeting, {}, stub);
  return { stored: stored.length, rebuilt: out.requests?.length ?? 0, equal };
}

export function existsCapture(id8: string, model: string, root = SWEEP_DIR) {
  const p = capturePaths(id8, model, root);
  return existsSync(p.calls) && existsSync(p.db);
}
