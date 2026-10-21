// runtime.mts: the shared runtime of the meeting eval tools (eval.mts and
// gold-draft.mts): paths, the GPU lock, child processes, ports, isolated
// servers, and the cached transcription of the copied meetings.
//
// Only the app's built-in MLX models run. Nothing here calls the owner's
// model server (owner rule 2026-10-21). Messages name steps, ids and HTTP
// codes, never meeting text.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { MLX_ASR_MODELS } from "../../../apps/server/src/lib/mlx-asr/constants.ts";
import { isOurTurn } from "./gpu-queue.mts";

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
export const ROOT = "/tmp/meeting-eval";
export const SERVER_HOME = join(ROOT, "home");
/** The built-in MLX ASR model of every eval transcription (owner rule 2026-10-21). */
export const ASR_MODEL_ID = "qwen3-1.7b-8bit";
export const ASR_DEF = (() => {
  const d = MLX_ASR_MODELS.find((m) => m.id === ASR_MODEL_ID);
  if (!d) throw new Error(`${ASR_MODEL_ID} is not in the MLX ASR catalog`);
  return d;
})();

/** A voice row of model_configs, as the app's Models page writes it. */
export interface VoiceRow {
  provider: string;
  model_id: string;
  model_name: string;
}
/** The built-in MLX ASR voice row (provider local-mlx). */
export const ASR_VOICE: VoiceRow = {
  provider: "local-mlx",
  model_id: `local-mlx/${ASR_MODEL_ID}`,
  model_name: ASR_DEF.displayName,
};

const LOCK = "/tmp/openstyle-gpu.lock";
const QUEUE = "/tmp/openstyle-gpu.queue";
export const REAL_PROFILE = join(
  process.env.HOME ?? "",
  "Library",
  "Application Support",
  "Openstyle",
);
export const REAL_DB = join(REAL_PROFILE, "freestyle.db");
export const DIARIZER = join(
  repoRoot,
  "apps",
  "electron",
  "resources",
  "bin",
  `${process.platform}-${process.arch}`,
  "fluidaudio-diarize",
);
const DIARIZER_MODELS = join(
  repoRoot,
  "apps",
  "electron",
  "resources",
  "models",
);
export const WORKER =
  process.env.OPENSTYLE_MLX_LLM_WORKER ??
  join(repoRoot, "dist", "mlx_asr_worker", "mlx_asr_worker");

export const isTmp = (p: string) => /^\/(private\/)?tmp\//.test(resolve(p));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmm = () => new Date().toTimeString().slice(0, 5);
export const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);

// --- GPU lock (owner rule 2026-10-20) ---------------------------------------------

let heldLock: string | null = null;
let queuedLine: string | null = null;
/** When this process first saw each queue line (ages a line with no time). */
const firstSeen = new Map<string, number>();
export function unqueue(): void {
  if (!queuedLine || !existsSync(QUEUE)) return;
  const kept = readFileSync(QUEUE, "utf8")
    .split("\n")
    .filter((l) => l !== queuedLine);
  writeFileSync(QUEUE, kept.join("\n"));
  queuedLine = null;
}

/**
 * Take the GPU lock in queue order: append our line to the queue first,
 * then take the lock only when it is free AND our line is the first live
 * line. Our line is removed when the lock is taken, at exit and on a signal.
 */
export async function takeLock(job: string, minutes: number): Promise<void> {
  const owner = `meeting-eval ${job} ${hhmm()}`;
  queuedLine = `meeting-eval ${job} ${minutes} ${new Date().toISOString()} pid=${process.pid}`;
  appendFileSync(QUEUE, `${queuedLine}\n`);
  let told = false;
  for (;;) {
    const lines = existsSync(QUEUE)
      ? readFileSync(QUEUE, "utf8").split("\n")
      : [];
    if (!lines.includes(queuedLine)) {
      // Someone removed our line: queue again at the end.
      appendFileSync(QUEUE, `${queuedLine}\n`);
    } else if (isOurTurn(lines, queuedLine, Date.now(), firstSeen)) {
      try {
        mkdirSync(LOCK);
        break;
      } catch {
        // The lock is held: wait.
      }
    }
    if (!told) {
      told = true;
      console.log(
        `GPU lock: queued (${QUEUE}); waiting for the lock and our turn, check every 30 s`,
      );
    }
    await sleep(30_000);
  }
  writeFileSync(join(LOCK, "owner"), `${owner}\n`);
  heldLock = owner;
  unqueue();
  console.log(`GPU lock taken: ${job}`);
}

export function releaseLock(): void {
  if (!heldLock) return;
  const owner = existsSync(join(LOCK, "owner"))
    ? readFileSync(join(LOCK, "owner"), "utf8").trim()
    : "";
  // Never remove the lock of another owner.
  if (owner === heldLock) rmSync(LOCK, { recursive: true, force: true });
  console.log(
    `GPU lock released${owner === heldLock ? "" : " (owner changed; left in place)"}`,
  );
  heldLock = null;
}

// --- Children and cleanup -----------------------------------------------------------

const children = new Set<ChildProcess>();
/** The private scratch profiles of this process (deleted on a signal). */
const workDirs = new Set<string>();
function onSignal() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  releaseLock();
  unqueue();
  for (const w of workDirs) rmSync(w, { recursive: true, force: true });
  process.exit(1);
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen({ port, host: "127.0.0.1" }, () => s.close(() => ok(true)));
  });
}

export async function needPort(port: number): Promise<void> {
  if (!(await portFree(port)))
    throw new Error(`port ${port} is in use; pass --port`);
}

/** Run a child to its end. Its output goes to the console (the tools print counts only). */
export function runChild(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = repoRoot,
): Promise<number> {
  return new Promise((ok) => {
    const c = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    children.add(c);
    c.on("exit", (code) => {
      children.delete(c);
      ok(code ?? 1);
    });
  });
}

/** The environment of every isolated server: scratch HOME, HF cache, dev worker, no trace. */
export function serverEnv(
  hfCache: string,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.OPENSTYLE_LOG_DIR;
  for (const k of Object.keys(env))
    if (/^(LANGSMITH|LANGCHAIN|MLFLOW|OKTO_NEURON|MARGINALIA)/i.test(k))
      delete env[k];
  env.HF_HOME = hfCache;
  env.HF_HUB_CACHE = join(hfCache, "hub");
  env.HUGGINGFACE_HUB_CACHE = join(hfCache, "hub");
  env.OPENSTYLE_MLX_LLM_WORKER = WORKER;
  env.OPENSTYLE_MLX_ASR_WORKER = WORKER;
  return env;
}

// --- Preconditions ---------------------------------------------------------------------

function newestMtime(dir: string): number {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile())
      t = Math.max(t, statSync(join(e.parentPath, e.name)).mtimeMs);
  }
  return t;
}

export function checkBuild(): void {
  const dist = join(repoRoot, "apps", "server", "dist", "index.js");
  if (!existsSync(dist))
    throw new Error(
      "no server build (pnpm turbo build --filter=@openstyle/server)",
    );
  if (
    statSync(dist).mtimeMs <
    newestMtime(join(repoRoot, "apps", "server", "src"))
  )
    throw new Error(
      "the server build is older than apps/server/src (pnpm turbo build --filter=@openstyle/server)",
    );
  if (!existsSync(WORKER))
    throw new Error(
      `no dev worker at ${WORKER} (scripts/build_mlx_asr_worker.sh)`,
    );
  // A stale build has no LLM mode: every Enhance chunk then fails with an
  // "internal" reason (found 2026-10-21 with an old dist/ worker).
  const help = spawnSync(WORKER, ["--help"], { encoding: "utf8" });
  if (!`${help.stdout}`.includes("--llm"))
    throw new Error(
      `the worker at ${WORKER} has no --llm mode (stale build; scripts/build_mlx_asr_worker.sh, or a copy of the shipped runtime)`,
    );
  if (
    statSync(WORKER).mtimeMs <
    statSync(join(repoRoot, "scripts", "mlx_asr_server.py")).mtimeMs
  )
    console.log(
      "warning: the dev worker is older than scripts/mlx_asr_server.py",
    );
  // Without these files the server skips diarization and VAD with no error
  // (diarize.ts resolves them from <cwd>/resources), and the speaker step
  // gets no labels. A new worktree does not have them (gitignored).
  for (const f of [DIARIZER, join(DIARIZER_MODELS, "speaker-diarization")])
    if (!existsSync(f))
      throw new Error(
        `missing ${f} (pnpm --filter @openstyle/electron compile:native, or copy apps/electron/resources/bin and models from the main checkout)`,
      );
}

/** The full meeting ids of id8 or full-id arguments, from a read-only copy of the real DB. */
export function resolveMeetingIds(
  args: string[],
  scratchDir: string,
): string[] {
  mkdirSync(join(scratchDir, "dbcopy"), { recursive: true });
  const copy = join(scratchDir, "dbcopy", `lookup-${process.pid}.db`);
  rmSync(copy, { force: true });
  const b = spawnSync("sqlite3", ["-readonly", REAL_DB, `.backup '${copy}'`]);
  if (b.status !== 0)
    throw new Error("cannot back up the real DB (sqlite3 -readonly)");
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    return args.map((a) => {
      const rows = db
        .prepare("SELECT id FROM meetings WHERE id LIKE ?")
        .all(`${a}%`) as { id: string }[];
      if (rows.length !== 1)
        throw new Error(`meeting ${a}: ${rows.length} matches in the real DB`);
      return (rows[0] as { id: string }).id;
    });
  } finally {
    db.close();
    rmSync(copy, { force: true });
  }
}

// --- Isolated servers ----------------------------------------------------------------------

async function api(
  port: number,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}

export type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: any }>;

/** Start an isolated server on a DB, run `fn` against its API, stop it. */
export async function withServer<T>(
  opts: { port: number; hfCache: string; dbPath: string; logPath: string },
  fn: (call: Call) => Promise<T>,
): Promise<T> {
  const { port, hfCache, dbPath, logPath } = opts;
  await needPort(port);
  const token = randomUUID();
  const log = createWriteStream(logPath);
  const server = spawn(process.execPath, ["../server/dist/startup.js"], {
    cwd: join(repoRoot, "apps", "electron"),
    env: serverEnv(hfCache, {
      OPENSTYLE_DB_PATH: dbPath,
      PORT: String(port),
      HOST: "127.0.0.1",
      OPENSTYLE_AUTH_TOKEN: token,
      HOME: SERVER_HOME,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(server);
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  const exited = new Promise<void>((ok) => server.on("exit", () => ok()));
  const call: Call = (method, path, body) =>
    api(port, token, method, path, body);
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await call("GET", "/api/health").then(
        (r) => r.status === 200,
        () => false,
      );
      if (!up) await sleep(500);
    }
    if (!up) throw new Error(`isolated server did not start; log: ${logPath}`);
    return await fn(call);
  } finally {
    server.kill("SIGTERM");
    await Promise.race([exited, sleep(10_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
    children.delete(server);
    log.end();
  }
}

// --- Transcribed meetings (cached per meeting) ------------------------------------------
//
// Layout of an ASR folder (default /tmp/meeting-eval/asr, shared by runs):
//   work/<pid>/          the private scratch profile of one process
//                        (setup-scratch.sh: meeting copies + test.db). Only
//                        this process writes it; it is deleted at the end.
//   cache/<id>.<hash>.db the transcription of one meeting, keyed by the
//                        hash of its inputs. Written only under the GPU
//                        lock, through a temp file and a rename, so a
//                        reader never sees half a file and no run deletes
//                        the cache of another run.

/**
 * A private scratch profile for this process: the meetings copied read-only
 * and a fresh seeded DB (<asrDir>/work/<pid>/test.db). Returns its folder.
 */
export async function setupScratch(
  asrDir: string,
  ids: string[],
  bootPort: number,
): Promise<string> {
  const work = join(asrDir, "work", String(process.pid));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  workDirs.add(work);
  await needPort(bootPort);
  const setup = await runChild(
    "bash",
    [join(repoRoot, "scripts", "meeting-v2", "setup-scratch.sh"), ...ids],
    { ...process.env, SCRATCH: work, BOOT_PORT: String(bootPort) },
  );
  if (setup !== 0) throw new Error("setup-scratch.sh failed");
  return work;
}

/** Delete every private scratch profile of this process (at exit). */
export function removeAllScratch(): void {
  for (const w of [...workDirs]) removeScratch(w);
}

/** Delete a private scratch profile (it holds copies of the meeting audio). */
export function removeScratch(work: string): void {
  rmSync(work, { recursive: true, force: true });
  workDirs.delete(work);
}

/**
 * Make `voice` the only default voice row of a scratch DB, and read it back.
 * The eval never transcribes through an own-server row (owner rule 2026-10-21).
 */
export function forceVoiceRow(dbPath: string, voice: VoiceRow): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("UPDATE model_configs SET is_default = 0 WHERE type = 'voice'");
    db.prepare(
      `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
       VALUES (?, ?, ?, 'voice', 1)
       ON CONFLICT(provider, model_id, type) DO UPDATE SET is_default = 1`,
    ).run(voice.provider, voice.model_id, voice.model_name);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const rows = db
      .prepare(
        "SELECT provider, model_id FROM model_configs WHERE type = 'voice' AND is_default = 1",
      )
      .all() as { provider: string; model_id: string }[];
    if (
      rows.length !== 1 ||
      rows[0]?.provider !== voice.provider ||
      rows[0]?.model_id !== voice.model_id
    )
      throw new Error(
        `scratch DB: the default voice row is not ${voice.model_id} (${rows.length} rows)`,
      );
  } finally {
    db.close();
  }
}

/** The hashes of the files of every run: same content = same hash in every checkout. */
function codeHashParts(): string[] {
  const lib = join(repoRoot, "apps", "server", "src", "lib");
  const files = [
    ...readdirSync(join(lib, "meetings"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(lib, "meetings", f)),
    join(lib, "transcription-pipeline.ts"),
    join(lib, "vocabulary-bias.ts"),
    join(lib, "schema.ts"),
    join(repoRoot, "scripts", "mlx_asr_server.py"),
  ];
  const parts = files
    .map((f) => `${relative(repoRoot, f)}:${sha(readFileSync(f))}`)
    .sort();
  parts.push(`worker:${sha(readFileSync(WORKER))}`);
  parts.push(`diarizer:${sha(readFileSync(DIARIZER))}`);
  return parts;
}

/**
 * Hash of every input of the transcription of ONE meeting. Equal hash = its
 * cached transcription is valid. `extra` adds inputs that the DB does not
 * show (for example the revision of a custom model). File contents only,
 * with repo-relative paths, so a new worktree hits the same cache.
 */
function meetingHash(
  work: string,
  id: string,
  voice: VoiceRow,
  extra: string[],
  code: string[],
): string {
  const db = new DatabaseSync(join(work, "test.db"), { readOnly: true });
  const q = (sql: string, ...p: string[]) =>
    JSON.stringify(db.prepare(sql).all(...p));
  const parts = [
    "run=R0d",
    `asr=${voice.model_id}`,
    ...extra,
    q("SELECT term, notes FROM vocabulary ORDER BY term"),
    q("SELECT value FROM settings WHERE key = 'languages'"),
    q(
      "SELECT provider, model_id FROM model_configs WHERE type = 'voice' AND is_default = 1",
    ),
    q("SELECT id, title, context, duration_ms FROM meetings WHERE id = ?", id),
  ];
  db.close();
  for (const f of ["mic.wav", "system.wav"]) {
    const p = join(work, "meetings", id, f);
    parts.push(`${f}:${existsSync(p) ? statSync(p).size : "-"}`);
  }
  return sha([...parts, ...code].join("\n"));
}

/** The tables that hold the transcription of a meeting (besides its meetings row). */
const TRANSCRIPT_TABLES = [
  "meeting_segments",
  "meeting_speakers",
  "meeting_diarizer_turns",
];

/** Copy a DB that no process writes (no WAL) into one plain file. */
function backupPlain(from: string, to: string): void {
  rmSync(to, { force: true });
  const b = spawnSync("sqlite3", [
    "-readonly",
    `file:${from}?immutable=1`,
    `.backup '${to}'`,
  ]);
  if (b.status !== 0) throw new Error(`cannot back up ${basename(from)}`);
  const rw = new DatabaseSync(to);
  rw.exec("PRAGMA journal_mode = DELETE");
  rw.close();
}

/**
 * The meetings of a scratch profile, transcribed with `voice` (run R0d,
 * diarization on), as one DB at `out`. Each meeting comes from the cache
 * when its input hash is there; the others are transcribed under the GPU
 * lock (run-baseline.mjs on the private scratch DB) and stored in the cache.
 * Returns the per-meeting hashes and one hash over all of them.
 */
export async function ensureTranscribed(opts: {
  asrDir: string;
  work: string;
  ids: string[];
  voice: VoiceRow;
  port: number;
  hfCache: string;
  out: string;
  hashExtra?: string[];
}): Promise<{ path: string; hash: string; hashes: Record<string, string> }> {
  const { asrDir, work, ids, voice, port, hfCache, out } = opts;
  const testDb = join(work, "test.db");
  forceVoiceRow(testDb, voice);
  const code = codeHashParts();
  const hashes: Record<string, string> = {};
  for (const id of ids)
    hashes[id] = meetingHash(work, id, voice, opts.hashExtra ?? [], code);
  const cacheDir = join(asrDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const cached = (id: string) => join(cacheDir, `${id}.${hashes[id]}.db`);
  const missing = ids.filter((id) => !existsSync(cached(id)));
  for (const id of ids)
    if (!missing.includes(id))
      console.log(`transcription ${id.slice(0, 8)}: cached (${hashes[id]})`);

  if (missing.length > 0) {
    await needPort(port);
    await takeLock("transcribe", 10 + missing.length * 5);
    try {
      for (const id of missing) {
        // Another run can have stored it while this one waited for the lock.
        if (existsSync(cached(id))) {
          console.log(`transcription ${id.slice(0, 8)}: cached by another run`);
          continue;
        }
        console.log(
          `transcribing ${id.slice(0, 8)} with ${voice.model_id} (asr hash ${hashes[id]})`,
        );
        const rc = await runChild(
          process.execPath,
          [
            join(repoRoot, "scripts", "meeting-v2", "run-baseline.mjs"),
            "--meeting",
            id,
            "--run",
            "R0d",
            "--port",
            String(port),
            "--hf-cache",
            hfCache,
          ],
          serverEnv(hfCache, { SCRATCH: work, HOME: SERVER_HOME }),
        );
        if (rc !== 0)
          throw new Error(`run-baseline failed for ${id.slice(0, 8)}`);
        const tmp = `${cached(id)}.${process.pid}.tmp`;
        backupPlain(testDb, tmp);
        const db = new DatabaseSync(tmp, { readOnly: true });
        const m = db
          .prepare(
            "SELECT status, (SELECT COUNT(*) FROM meeting_segments s WHERE s.meeting_id = m.id) AS n FROM meetings m WHERE id = ?",
          )
          .get(id) as { status: string; n: number } | undefined;
        db.close();
        if (m?.status !== "transcribed" || m.n === 0) {
          rmSync(tmp, { force: true });
          throw new Error(
            `meeting ${id.slice(0, 8)}: status ${m?.status ?? "missing"}, ${m?.n ?? 0} segments`,
          );
        }
        renameSync(tmp, cached(id));
      }
    } finally {
      releaseLock();
    }
  }

  // One DB for the run: the private scratch DB with each meeting's
  // transcription rows taken from its cache file.
  backupPlain(testDb, out);
  const db = new DatabaseSync(out);
  try {
    for (const id of ids) {
      db.exec(`ATTACH DATABASE '${cached(id)}' AS c`);
      try {
        db.prepare(
          "INSERT OR REPLACE INTO main.meetings SELECT * FROM c.meetings WHERE id = ?",
        ).run(id);
        for (const t of TRANSCRIPT_TABLES) {
          db.prepare(`DELETE FROM main.${t} WHERE meeting_id = ?`).run(id);
          db.prepare(
            `INSERT INTO main.${t} SELECT * FROM c.${t} WHERE meeting_id = ?`,
          ).run(id);
        }
      } finally {
        db.exec("DETACH DATABASE c");
      }
      const m = db
        .prepare(
          "SELECT status, (SELECT COUNT(*) FROM meeting_segments s WHERE s.meeting_id = m.id) AS n FROM meetings m WHERE id = ?",
        )
        .get(id) as { status: string; n: number } | undefined;
      if (m?.status !== "transcribed" || m.n === 0)
        throw new Error(
          `meeting ${id.slice(0, 8)}: the run DB has status ${m?.status ?? "missing"}, ${m?.n ?? 0} segments`,
        );
    }
  } finally {
    db.close();
  }
  const hash = sha(
    ids
      .map((id) => `${id}:${hashes[id]}`)
      .sort()
      .join("\n"),
  );
  return { path: out, hash, hashes };
}
