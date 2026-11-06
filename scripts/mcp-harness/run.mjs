#!/usr/bin/env node
// The real-harness test of the Openstyle MCP server (specs/mcp.md 9.4, 10).
//
// One command, from the repo root:
//   node scripts/mcp-harness/run.mjs [--scratch /tmp/mcp-harness]
//     [--harness claude,pi] [--only J03,J07] [--skip-build --keep-build]
//   --skip-build reuses <scratch>/build; --keep-build keeps it after the run.
//
// What it does, for each harness (Claude Code, pi):
//   1. Builds the server, the app and a packaged "Openstyle Dev.app"
//      (electron-builder --dir, ad-hoc, no notarization) into the scratch folder.
//   2. Starts that app through the Test Runner (app-host.mjs) in quiet mode on
//      an isolated profile with fictional seed data.
//   3. Adds Openstyle to the REAL `claude`, `pi` and `codex` CLIs through the
//      app's own `agents:add` IPC (J1, J2). Every CLI config dir is a sandbox:
//      CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR, CODEX_HOME.
//   4. Runs the journeys J1-J15 as prompts: `claude -p` (stream-json) and
//      `pi -p --mode json` with the default pi model.
//   5. Collects the evidence for each tool and each harness: the tool call and
//      its result, the server log line `[mcp] tool=<name> agent=<agent>`, and
//      for a write a `sqlite3 -readonly` read-back.
//   6. Writes <scratch>/evidence/matrix.json and matrix.md. Exits 1 when a
//      cell of the 50 x 2 matrix is missing.
//
// Hard rules (.claude/skills/live-testing/SKILL.md): never port 4649, never
// the real profile, never the real agent configs, kill only own PIDs, take the
// shared GPU lock for the run only.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "../site-captures/seed-data.mjs";
import {
  CONFIRM_TEXT,
  FAILURE_TEXTS,
  journeys,
  LIVE_FAR_LINE,
  LIVE_LATE_LINE,
  LIVE_OFF_TEXT,
  SEED,
  SERVER,
} from "./journeys.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ELECTRON = join(REPO, "apps/electron");
const HOME = homedir();
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const SCRATCH = resolve(opt("--scratch", "/tmp/mcp-harness"));
const HARNESSES = opt("--harness", "claude,pi").split(",");
const ONLY = opt("--only", "")
  .split(",")
  .filter(Boolean)
  .map((s) => s.toUpperCase());
const SKIP_BUILD = args.includes("--skip-build");
const EVID = join(SCRATCH, "evidence");
const BUILD = join(SCRATCH, "build");
const APP = join(BUILD, "mac-arm64", "Openstyle Dev.app");
const APP_EXE = join(APP, "Contents", "MacOS", "Openstyle Dev");
const HF = join(SCRATCH, "hf");
const GPU_LOCK = "/tmp/openstyle-gpu.lock";
const WORKER = join(
  HOME,
  ".cache/freestyle/mlx-asr/runtime/darwin-arm64/mlx_asr_worker/mlx_asr_worker",
);
const PI_MD = join(
  HOME,
  ".pi/agent/npm/node_modules/@maheidem/model-discovery/index.ts",
);
const AGENT_PREFIX = { claude: "claude-code/", pi: "pi/" };
const TOOL_PREFIX = { claude: `mcp__${SERVER}__`, pi: "mcp__openstyle_dev__" };

const own = new Set(); // PIDs that this run started
const t0 = Date.now();
const say = (text) =>
  console.log(`[harness ${((Date.now() - t0) / 1000).toFixed(0)}s] ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SCRATCH.startsWith("/tmp/") && !SCRATCH.startsWith("/private/tmp/")) {
  console.error("The scratch folder must be under /tmp.");
  process.exit(2);
}
mkdirSync(EVID, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function which(bin) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  const local = join(HOME, ".local/bin", bin);
  return existsSync(local) ? local : null;
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

function run(cmd, argv, options = {}) {
  const r = spawnSync(cmd, argv, {
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: r.status ?? 124,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Run a command and wait for it, with a log file and a time box. */
function runLogged(cmd, argv, { cwd, env, logFile, timeoutMs }) {
  return new Promise((done) => {
    const out = [];
    const child = spawn(cmd, argv, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    own.add(child.pid);
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      err += d;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      own.delete(child.pid);
      const stdout = Buffer.concat(out).toString("utf8");
      if (logFile) writeFileSync(logFile, stdout);
      if (logFile) writeFileSync(`${logFile}.stderr`, err);
      done({ code: code ?? 124, stdout, stderr: err });
    });
  });
}

function sql(db, query) {
  const r = run("sqlite3", ["-readonly", "-json", db, query]);
  if (r.code !== 0) return { error: r.stderr.trim() };
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

/** stat of the real agent configs: path, size, mtime. */
const REAL_CONFIGS = [
  join(HOME, ".claude.json"),
  join(HOME, ".claude/settings.json"),
  join(HOME, ".pi/agent/mcp.json"),
  join(HOME, ".pi/agent/settings.json"),
  join(HOME, ".pi/agent/trust.json"),
  join(HOME, ".pi/agent/mcp-project-approvals.json"),
  join(HOME, ".codex/config.toml"),
];
function configState() {
  const rows = REAL_CONFIGS.map((p) => {
    try {
      const s = statSync(p);
      return { path: p, size: s.size, mtime: s.mtime.toISOString() };
    } catch {
      return { path: p, missing: true };
    }
  });
  // ~/.claude.json changes during any Claude Code session (counters). The
  // proof for it is that its MCP entries do not name Openstyle.
  let claudeEntries = null;
  try {
    const c = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8"));
    const names = new Set(Object.keys(c.mcpServers ?? {}));
    for (const project of Object.values(c.projects ?? {}))
      for (const n of Object.keys(project.mcpServers ?? {})) names.add(n);
    claudeEntries = [...names].filter((n) => n.includes("openstyle"));
  } catch {
    claudeEntries = "unreadable";
  }
  const piEntries = Object.keys(
    JSON.parse(readFileSync(join(HOME, ".pi/agent/mcp.json"), "utf8"))
      .mcpServers ?? {},
  ).filter((n) => n.includes("openstyle"));
  const codex = existsSync(join(HOME, ".codex/config.toml"))
    ? /\[mcp_servers\.openstyle/.test(
        readFileSync(join(HOME, ".codex/config.toml"), "utf8"),
      )
    : false;
  return {
    files: rows,
    openstyleEntries: { claude: claudeEntries, pi: piEntries, codex },
  };
}

function logState() {
  const dir = join(HOME, "Library/Logs/Openstyle");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => {
    const s = statSync(join(dir, f));
    return { file: f, size: s.size, mtime: s.mtime.toISOString() };
  });
}

function tccPrompts() {
  const r = run(
    "/usr/bin/log",
    [
      "show",
      "--last",
      "15m",
      "--predicate",
      'subsystem == "com.apple.TCC"',
      "--style",
      "compact",
    ],
    { timeout: 120_000 },
  );
  return (r.stdout.match(/AUTHREQ_PROMPTING/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// GPU lock (shared with other Openstyle sessions)
// ---------------------------------------------------------------------------

let haveLock = false;
async function takeLock() {
  for (let i = 0; i < 120; i++) {
    const queue = existsSync("/tmp/openstyle-gpu.queue")
      ? readFileSync("/tmp/openstyle-gpu.queue", "utf8").trim()
      : "";
    if (!queue) {
      try {
        mkdirSync(GPU_LOCK);
        writeFileSync(
          join(GPU_LOCK, "owner"),
          `mcp-harness PR5 ${new Date().toISOString()}\n`,
        );
        haveLock = true;
        say("GPU lock taken");
        return;
      } catch {
        // held by someone else
      }
    }
    say("GPU lock busy or queue not empty, waiting 60 s");
    await sleep(60_000);
  }
  throw new Error("GPU lock not free after 2 hours");
}
function releaseLock() {
  if (!haveLock) return;
  rmSync(GPU_LOCK, { recursive: true, force: true });
  haveLock = false;
  say("GPU lock released");
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build() {
  const step = (label, cmd, argv, cwd, env = {}) => {
    say(`build: ${label}`);
    const r = spawnSync(cmd, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 20 * 60_000,
    });
    writeFileSync(join(SCRATCH, `build-${label}.log`), r.stdout + r.stderr);
    if (r.status !== 0) throw new Error(`build step ${label} failed`);
  };
  const noSign = {
    OPENSTYLE_DEV_SIGN: "0",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
  step(
    "server",
    "pnpm",
    ["turbo", "build", "--filter=@openstyle/server"],
    REPO,
  );
  step("app", "pnpm", ["run", "build"], ELECTRON, noSign);
  step(
    "package",
    "pnpm",
    [
      "exec",
      "electron-builder",
      "--mac",
      "dir",
      "--arm64",
      "--publish",
      "never",
      "-c.productName=Openstyle Dev",
      "-c.extraMetadata.openstyleFlavor=dev",
      "-c.appId=com.openstyle.app.dev",
      "-c.mac.notarize=false",
      `-c.directories.output=${BUILD}`,
    ],
    ELECTRON,
    noSign,
  );
}

/** Bundle live-server.ts: the server and the live store in one module graph. */
async function buildLiveServer() {
  const dir = join(SCRATCH, "live-bundle");
  mkdirSync(dir, { recursive: true });
  const esbuild = createRequire(
    createRequire(join(ELECTRON, "package.json")).resolve("vite"),
  )("esbuild");
  await esbuild.build({
    entryPoints: [join(REPO, "scripts/mcp-harness/live-server.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: join(dir, "live-server.mjs"),
    logLevel: "warning",
  });
  // Bare imports resolve from the server's own node_modules.
  rmSync(join(dir, "node_modules"), { force: true });
  symlinkSync(
    join(REPO, "apps/server/node_modules"),
    join(dir, "node_modules"),
  );
  return join(dir, "live-server.mjs");
}

// ---------------------------------------------------------------------------
// The app (through the Test Runner) and its control API
// ---------------------------------------------------------------------------

async function startApp(h, dirs) {
  const readyFile = join(dirs.root, "ready.json");
  rmSync(readyFile, { force: true });
  const job = {
    appExe: APP_EXE,
    userDataDir: dirs.profile,
    readyFile,
    maxMinutes: 150,
    env: {
      // The install IPC finds the real CLIs only in this folder (E2E mode).
      OPENSTYLE_E2E_AGENT_BIN: dirs.bin,
      CLAUDE_CONFIG_DIR: dirs.claude,
      PI_CODING_AGENT_DIR: dirs.pi,
      CODEX_HOME: dirs.codex,
      OPENSTYLE_E2E_OMLX_URL: "http://127.0.0.1:1",
      OPENSTYLE_MODEL_CACHE_DIR: join(dirs.root, "model-cache"),
      HF_HOME: HF,
      HUGGINGFACE_HUB_CACHE: join(HF, "hub"),
      // The shipped worker of the installed runtime, executed only.
      OPENSTYLE_MLX_ASR_WORKER: WORKER,
      OPENSTYLE_MLX_LLM_WORKER: WORKER,
    },
  };
  writeFileSync(join(dirs.root, "job.json"), JSON.stringify(job, null, 2));
  const host = spawn(
    join(REPO, "scripts/test-runner/run.sh"),
    [
      ELECTRON,
      "--",
      process.execPath,
      join(REPO, "scripts/mcp-harness/app-host.mjs"),
      join(dirs.root, "job.json"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  own.add(host.pid);
  let hostLog = "";
  host.stdout.on("data", (d) => {
    hostLog += d;
  });
  host.stderr.on("data", (d) => {
    hostLog += d;
  });
  const exited = new Promise((r) =>
    host.on("close", (code) => {
      own.delete(host.pid);
      writeFileSync(join(EVID, h, "app-host.log"), hostLog);
      r(code);
    }),
  );
  for (let i = 0; i < 180; i++) {
    if (existsSync(readyFile)) break;
    await sleep(1000);
  }
  if (!existsSync(readyFile)) throw new Error(`app did not start: ${hostLog}`);
  const ready = JSON.parse(readFileSync(readyFile, "utf8"));
  const api = (method, path, body) =>
    fetch(`http://127.0.0.1:${ready.serverPort}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  const control = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${ready.controlPort}${path}`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(120_000),
    });
    return res.json();
  };
  const invoke = async (channel, ...a) =>
    (await control("/invoke", { channel, args: a })).result;
  const quit = async () => {
    try {
      await control("/quit");
    } catch {
      // the host may already be gone
    }
    await exited;
  };
  say(`${h}: app ready (pid ${ready.pid}, port ${ready.serverPort})`);
  return { ready, api, invoke, quit };
}

// ---------------------------------------------------------------------------
// Seed (fictional)
// ---------------------------------------------------------------------------

async function seed(app, profile) {
  const db = join(profile, "freestyle.db");
  seedDatabase(db);
  const d = new DatabaseSync(db);
  d.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  const summaryJson = {
    overview: "Weekly sync of the product team.",
    keyPoints: ["Onboarding drop-off is about forty percent."],
    decisions: ["Start with the small model."],
    actionItems: [
      { task: "Size the onboarding change", owner: "Alex", due: "Thursday" },
      {
        task: "Find a second reviewer for the Safari fix",
        owner: "Sam",
        due: null,
      },
    ],
    openQuestions: ["When is the release date?"],
  };
  d.prepare(
    "UPDATE meeting_summaries SET summary_json = ? WHERE meeting_id = ?",
  ).run(JSON.stringify(summaryJson), SEED.meeting);
  // Delete targets.
  d.prepare(
    `INSERT INTO meetings (id, title, started_at, ended_at, duration_ms, status, language, created_at)
     VALUES (?, 'Old test meeting to delete', ?, ?, 60000, 'summarized', 'en', ?)`,
  ).run(
    SEED.deleteMeeting,
    now - 86_400_000,
    now - 86_340_000,
    now - 86_400_000,
  );
  d.prepare(
    `INSERT INTO meeting_folders (id, name, description, created_at, updated_at)
     VALUES (?, 'Empty archive', NULL, ?, ?)`,
  ).run(SEED.deleteFolder, now, now);
  // Ask threads.
  const thread = d.prepare(
    "INSERT INTO chat_threads (id, meeting_id, folder_id, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)",
  );
  const message = d.prepare(
    "INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)",
  );
  thread.run(SEED.keepThread, SEED.meeting, "Release date questions", now, now);
  message.run(SEED.keepThread, "user", "When is the release?", now);
  message.run(
    SEED.keepThread,
    "assistant",
    "The team did not fix a date yet.",
    now + 1,
  );
  thread.run(SEED.deleteThread, SEED.meeting, "Old scratch thread", now, now);
  message.run(SEED.deleteThread, "user", "Test question.", now);
  // Ledger.
  const item = d.prepare(
    "INSERT INTO ledger_items (id, folder_id, kind, text, first_meeting_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const mark = d.prepare(
    `INSERT INTO ledger_marks (id, item_id, meeting_id, meeting_date, status, owner, quote, quote_ok, writer_model, written_at)
     VALUES (?, ?, ?, ?, 'raised', ?, ?, 1, 'seed', ?)`,
  );
  item.run(
    SEED.keepItem,
    SEED.folder,
    "action",
    "Fix the Safari login bug",
    SEED.meeting,
    now,
  );
  mark.run(
    "mark_harness_1",
    SEED.keepItem,
    SEED.meeting,
    now,
    "Sam",
    "I can reproduce it.",
    now,
  );
  item.run(
    SEED.deleteItem,
    SEED.folder,
    "question",
    "Old open question",
    SEED.meeting,
    now,
  );
  mark.run(
    "mark_harness_2",
    SEED.deleteItem,
    SEED.meeting,
    now,
    null,
    "Thanks for joining.",
    now,
  );
  // Vocabulary and a dictation to delete.
  d.prepare(
    "INSERT INTO vocabulary (term, notes) VALUES ('Orchid', 'Project name')",
  ).run();
  const term = d
    .prepare("INSERT INTO vocabulary (term, notes) VALUES (?, NULL)")
    .run(SEED.deleteTerm);
  const dict = d
    .prepare(
      `INSERT INTO transcription_history (raw_text, cleaned_text, voice_provider, voice_model, created_at)
       VALUES (?, ?, 'local-mlx', 'local-mlx/qwen3-0.6b-8bit', datetime('now'))`,
    )
    .run(SEED.deleteDictationText, SEED.deleteDictationText);
  d.close();
  for (const [key, value] of [
    ["meeting_enhance_prompt_seen", "true"],
    ["meeting_chat_enabled", "true"],
  ]) {
    const res = await app.api("PUT", `/settings/${key}`, { value });
    if (!res.ok) throw new Error(`seed setting ${key}: ${res.status}`);
  }
  const res = await app.api("POST", "/models/configured", {
    provider: "local-mlx-llm",
    model_id: `local-mlx-llm/${SEED.model}`,
    model_name: "Gemma 4 E2B",
    type: "llm",
    is_default: true,
  });
  if (!res.ok) throw new Error(`seed model: ${res.status} ${await res.text()}`);
  return {
    deleteTermId: Number(term.lastInsertRowid),
    deleteDictationId: Number(dict.lastInsertRowid),
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Parse the tool calls of one agent run. */
function parseCalls(h, stdout) {
  const calls = [];
  const byId = new Map();
  let init = null;
  let finalText = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (h === "claude") {
      if (e.type === "system" && e.subtype === "init") init = e;
      if (e.type === "result") finalText = String(e.result ?? "");
      for (const c of e.message?.content ?? []) {
        if (c?.type === "tool_use" && c.name.startsWith(TOOL_PREFIX.claude)) {
          const call = {
            id: c.id,
            tool: c.name.slice(TOOL_PREFIX.claude.length),
            input: c.input,
          };
          byId.set(c.id, call);
          calls.push(call);
        }
        if (c?.type === "tool_result" && byId.has(c.tool_use_id)) {
          const call = byId.get(c.tool_use_id);
          call.isError = c.is_error === true;
          call.result = Array.isArray(c.content)
            ? c.content.map((x) => x.text ?? "").join("\n")
            : String(c.content ?? "");
        }
      }
    } else {
      if (e.type === "agent_end") {
        const last = [...(e.messages ?? [])]
          .reverse()
          .find((m) => m.role === "assistant");
        finalText = (last?.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      }
      if (!e.toolName?.startsWith(TOOL_PREFIX.pi)) continue;
      if (e.type === "tool_execution_start") {
        const call = {
          id: e.toolCallId,
          tool: e.toolName.slice(TOOL_PREFIX.pi.length),
          input: e.args,
        };
        byId.set(e.toolCallId, call);
        calls.push(call);
      }
      if (e.type === "tool_execution_end" && byId.has(e.toolCallId)) {
        const call = byId.get(e.toolCallId);
        call.isError = e.isError === true;
        call.result = (e.result?.content ?? [])
          .map((x) => x.text ?? "")
          .join("\n");
      }
    }
  }
  return { calls, init, finalText };
}

async function runAgent(h, j, cfg) {
  const file = join(EVID, h, `${j.id}.jsonl`);
  let r;
  if (h === "claude") {
    r = await runLogged(
      cfg.claudeBin,
      [
        "-p",
        "--strict-mcp-config",
        "--mcp-config",
        cfg.mcpConfig,
        "--allowedTools",
        `mcp__${SERVER}__*`,
        "--output-format",
        "stream-json",
        "--verbose",
        j.prompt,
      ],
      {
        cwd: cfg.cwd,
        env: { CLAUDE_CONFIG_DIR: cfg.claudeDir },
        logFile: file,
        timeoutMs: 15 * 60_000,
      },
    );
  } else {
    r = await runLogged(
      cfg.piBin,
      [
        "-p",
        "-a",
        "--no-session",
        "-ne",
        "-e",
        PI_MD,
        "-e",
        "builtin:mcp",
        "-e",
        "builtin:codemode",
        "-ns",
        "-nc",
        "-t",
        "codemode,mcp__openstyle_dev__*",
        "--mode",
        "json",
        j.prompt,
      ],
      { cwd: cfg.cwd, logFile: file, timeoutMs: 20 * 60_000 },
    );
  }
  const parsed = parseCalls(h, r.stdout);
  return { ...parsed, code: r.code, file, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Checks (SQLite read-back and live state)
// ---------------------------------------------------------------------------

function checksFor(h, db, app, profile) {
  const tag = h;
  const one = (q) => {
    const rows = sql(db, q);
    return Array.isArray(rows) ? rows[0] : rows;
  };
  return {
    set_summary: () => {
      const s = one(
        `SELECT llm_provider, llm_model, substr(markdown,1,40) AS md FROM meeting_summaries WHERE meeting_id='${SEED.meeting}'`,
      );
      const v = one(
        `SELECT count(*) AS n FROM meeting_summary_versions WHERE meeting_id='${SEED.meeting}'`,
      );
      return {
        ok: s?.llm_provider === "agent" && v?.n >= 1,
        row: s,
        versions: v?.n,
      };
    },
    set_enhanced_segments: () => {
      const rows = sql(
        db,
        `SELECT id, text, enhanced_text FROM meeting_segments WHERE meeting_id='${SEED.meeting}' AND idx < 3 ORDER BY idx`,
      );
      const ok =
        rows.length === 3 &&
        rows.every(
          (r) =>
            r.enhanced_text?.includes(`(${tag})`) &&
            !r.text.includes(`(${tag})`),
        );
      return { ok, rows };
    },
    update_speaker: () => {
      const rows = sql(
        db,
        `SELECT speaker_label, display_name, merged_into FROM meeting_speakers WHERE meeting_id='${SEED.meeting}' ORDER BY speaker_label`,
      );
      const s1 = rows.find((r) => r.speaker_label === "1");
      const s2 = rows.find((r) => r.speaker_label === "2");
      return {
        ok: s1?.display_name === "Alex Rivera" && s2?.merged_into === "1",
        rows,
      };
    },
    update_meeting: () => {
      const r = one(
        `SELECT title, language, context FROM meetings WHERE id='${SEED.pilot}'`,
      );
      return {
        ok:
          r?.title === `Pilot call, week 45 (${tag})` &&
          r?.context?.includes("second demo"),
        row: r,
      };
    },
    set_meeting_tags: () => {
      const rows = sql(
        db,
        `SELECT t.name FROM meeting_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.meeting_id='${SEED.pilot}'`,
      );
      const names = rows.map((r) => r.name);
      return {
        ok: names.includes("pilot") && names.includes(`customer-${tag}`),
        names,
      };
    },
    set_attendees: () => {
      const r = one(
        `SELECT calendar_event_id, calendar_attendees FROM meetings WHERE id='${SEED.pilot}'`,
      );
      return {
        ok:
          r?.calendar_event_id === null &&
          String(r?.calendar_attendees).includes("Dana Reyes"),
        row: r,
      };
    },
    set_calendar_link: () => {
      const r = one(
        `SELECT calendar_event_id FROM meetings WHERE id='${SEED.pilot}'`,
      );
      return { ok: r?.calendar_event_id === null, row: r };
    },
    create_folder: () => {
      const r = one(
        `SELECT id, name FROM meeting_folders WHERE name LIKE 'Harness ${tag}%'`,
      );
      return { ok: !!r, row: r };
    },
    update_folder: () => {
      const r = one(
        `SELECT id, name FROM meeting_folders WHERE name = 'Harness ${tag} renamed'`,
      );
      return { ok: !!r, row: r };
    },
    move_meetings: () => {
      const rows = sql(
        db,
        `SELECT m.id, f.name FROM meetings m JOIN meeting_folders f ON f.id=m.folder_id WHERE m.id IN ('${SEED.pilot}','${SEED.interview}')`,
      );
      return {
        ok:
          rows.length === 2 &&
          rows.every((r) => r.name.startsWith(`Harness ${tag}`)),
        rows,
      };
    },
    set_action_item_done: () => {
      const rows = sql(
        db,
        `SELECT item_key, done FROM folder_action_item_state WHERE folder_id='${SEED.folder}' AND done=1`,
      );
      return { ok: rows.length >= 1, rows };
    },
    set_folder_standing: () => {
      const r = one(
        `SELECT bullets_json FROM folder_standing WHERE folder_id='${SEED.folder}'`,
      );
      return { ok: String(r?.bullets_json).includes(`(${tag})`), row: r };
    },
    create_open_item: () => {
      const r = one(
        `SELECT id, text, kind FROM ledger_items WHERE text LIKE 'Book the release review%(${tag})'`,
      );
      return { ok: !!r, row: r };
    },
    update_open_item: () => {
      const r = one(
        `SELECT text FROM ledger_items WHERE text = 'Book the release review for Thursday (${tag})'`,
      );
      return { ok: !!r, row: r };
    },
    add_open_item_mark: () => {
      const rows = sql(
        db,
        `SELECT m.status, m.writer_model, m.quote_ok FROM ledger_marks m JOIN ledger_items i ON i.id=m.item_id WHERE i.text LIKE 'Book the release review%(${tag})'`,
      );
      const done = rows.find((r) => r.status === "done");
      return { ok: !!done && done.writer_model.startsWith("agent:"), rows };
    },
    rename_ask_thread: () => {
      const r = one(
        `SELECT title FROM chat_threads WHERE id='${SEED.keepThread}'`,
      );
      return { ok: r?.title === `Release date (${tag})`, row: r };
    },
    add_vocabulary: () => {
      const rows = sql(
        db,
        `SELECT term, notes FROM vocabulary WHERE term LIKE '%${tag}'`,
      );
      return { ok: rows.length === 3, rows };
    },
    update_vocabulary: () => {
      const r = one(
        `SELECT term, notes FROM vocabulary WHERE term = 'Kestrel ${tag}'`,
      );
      return { ok: r?.notes === "Project name, fixed by the agent", row: r };
    },
    set_setting: async () => {
      const rows = sql(
        db,
        "SELECT key, value FROM settings WHERE key IN ('chat_hotkey','output_mode','sound_enabled','live_chat_enabled','network_proxy_url') ORDER BY key",
      );
      const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      const hotkey = await app.invoke("e2e:chat-hotkey-state");
      return {
        ok:
          v.chat_hotkey === "Control+Alt+J" &&
          v.output_mode === "clipboard" &&
          v.sound_enabled === "false" &&
          !v.network_proxy_url &&
          /J$/.test(hotkey?.registered ?? ""),
        rows,
        liveHotkey: hotkey,
      };
    },
    set_app_settings: () => {
      const s = JSON.parse(
        readFileSync(join(profile, "settings.json"), "utf8"),
      );
      return {
        ok: s.pillPosition === "bottom-right",
        settingsJson: { pillPosition: s.pillPosition },
      };
    },
    download_model: () => {
      const dirs = existsSync(join(HF, "hub"))
        ? readdirSync(join(HF, "hub")).filter((n) => n.startsWith("models--"))
        : [];
      return {
        ok: dirs.some((n) => n.toLowerCase().includes("gemma-4-e2b")),
        cacheDirs: dirs,
      };
    },
    start_meeting_job: () => {
      const r = one(
        `SELECT llm_provider, llm_model FROM meeting_summaries WHERE meeting_id='${SEED.meeting}'`,
      );
      const v = one(
        `SELECT count(*) AS n FROM meeting_summary_versions WHERE meeting_id='${SEED.meeting}'`,
      );
      return {
        ok: r?.llm_provider === "local-mlx-llm",
        summary: r,
        versions: v?.n,
      };
    },
    cancel_meeting_job: () => {
      const r = one(`SELECT status FROM meetings WHERE id='${SEED.pilot}'`);
      return { ok: !!r && r.status !== "enhancing", row: r };
    },
    delete_meeting: () => ({
      ok: !one(`SELECT id FROM meetings WHERE id='${SEED.deleteMeeting}'`),
    }),
    delete_folder: () => ({
      ok: !one(
        `SELECT id FROM meeting_folders WHERE id='${SEED.deleteFolder}'`,
      ),
    }),
    delete_open_item: () => ({
      ok:
        !one(`SELECT id FROM ledger_items WHERE id='${SEED.deleteItem}'`) &&
        !one(`SELECT id FROM ledger_marks WHERE item_id='${SEED.deleteItem}'`),
    }),
    delete_ask_thread: () => ({
      ok:
        !one(`SELECT id FROM chat_threads WHERE id='${SEED.deleteThread}'`) &&
        !one(
          `SELECT id FROM chat_messages WHERE thread_id='${SEED.deleteThread}'`,
        ),
    }),
    delete_dictation: () => ({
      ok: !one(
        `SELECT id FROM transcription_history WHERE raw_text='${SEED.deleteDictationText}'`,
      ),
    }),
    delete_vocabulary: () => ({
      ok: !one(`SELECT id FROM vocabulary WHERE term='${SEED.deleteTerm}'`),
    }),
  };
}

const WRITE_TOOLS = new Set([
  "update_meeting",
  "set_calendar_link",
  "set_attendees",
  "set_meeting_tags",
  "move_meetings",
  "set_enhanced_segments",
  "update_speaker",
  "set_summary",
  "start_meeting_job",
  "cancel_meeting_job",
  "create_folder",
  "update_folder",
  "set_action_item_done",
  "set_folder_standing",
  "create_open_item",
  "update_open_item",
  "add_open_item_mark",
  "rename_ask_thread",
  "add_vocabulary",
  "update_vocabulary",
  "set_setting",
  "set_app_settings",
  "download_model",
  "delete_meeting",
  "delete_folder",
  "delete_open_item",
  "delete_ask_thread",
  "delete_dictation",
  "delete_vocabulary",
]);
const DELETE_TOOLS = new Set(
  [...WRITE_TOOLS].filter((t) => t.startsWith("delete_")),
);

// ---------------------------------------------------------------------------
// Install (J1, J2, Codex) through the app's own IPC
// ---------------------------------------------------------------------------

async function install(h, app, dirs, cfg) {
  const out = [];
  const log = (label, value) => {
    out.push(
      `### ${label}\n\n\`\`\`\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n\`\`\`\n`,
    );
  };
  const rows = await app.invoke("agents:list");
  log(
    "agents:list (before)",
    rows.map((r) => ({
      tool: r.tool,
      found: r.found,
      state: r.state,
      cliPath: r.cliPath,
    })),
  );
  const result = { ok: false };
  if (h === "claude") {
    const added = await app.invoke("agents:add", "claude");
    log("agents:add claude", { state: added.state, name: added.name });
    const get = run(cfg.claudeBin, ["mcp", "get", SERVER], {
      env: { CLAUDE_CONFIG_DIR: dirs.claude },
      timeout: 60_000,
    });
    log(
      `CLAUDE_CONFIG_DIR=<sandbox> claude mcp get ${SERVER} (exit ${get.code})`,
      get.stdout + get.stderr,
    );
    const entry = JSON.parse(
      readFileSync(join(dirs.claude, ".claude.json"), "utf8"),
    ).mcpServers?.[SERVER];
    result.entry = entry;
    result.ok =
      added.state === "added" &&
      get.code === 0 &&
      get.stdout.includes("Connected") &&
      get.stdout.includes(`Command: ${entry?.command}`);
    // Codex: install proof only (spec 10, no Codex column).
    const codex = await app.invoke("agents:add", "codex");
    log("agents:add codex", { state: codex.state });
    const cget = run(
      which("codex") ?? "codex",
      ["mcp", "get", SERVER, "--json"],
      { env: { CODEX_HOME: dirs.codex } },
    );
    log(
      `CODEX_HOME=<sandbox> codex mcp get ${SERVER} --json (exit ${cget.code})`,
      cget.stdout + cget.stderr,
    );
    result.codexOk =
      codex.state === "added" &&
      cget.code === 0 &&
      cget.stdout.includes("openstyle-mcp");
  } else {
    const added = await app.invoke("agents:add", "pi");
    log("agents:add pi", { state: added.state, name: added.name });
    const file = readFileSync(join(dirs.pi, "mcp.json"), "utf8");
    log("<sandbox PI_CODING_AGENT_DIR>/mcp.json", file);
    const entry = JSON.parse(file).mcpServers?.[SERVER];
    result.entry = entry;
    const list = run(cfg.piBin, ["mcp", "list", "--json"], {
      env: { PI_CODING_AGENT_DIR: dirs.pi },
      timeout: 120_000,
      cwd: dirs.root,
    });
    let toolCount = null;
    try {
      const parsed = JSON.parse(list.stdout);
      const servers = Array.isArray(parsed)
        ? parsed
        : (parsed.servers ?? Object.values(parsed));
      const s = servers.find((x) => x.name === SERVER) ?? servers[0];
      toolCount = (s?.tools ?? []).length;
    } catch {
      toolCount = (list.stdout.match(/"name"/g) ?? []).length;
    }
    log(
      `PI_CODING_AGENT_DIR=<sandbox> pi mcp list --json (exit ${list.code}, ${toolCount} tools)`,
      list.stdout.slice(0, 1500),
    );
    result.toolCount = toolCount;
    result.ok =
      added.state === "added" &&
      entry?.command?.endsWith("openstyle-mcp") &&
      list.code === 0 &&
      toolCount === 50;
  }
  result.text = out.join("\n");
  return result;
}

async function uninstall(h, app, dirs, cfg) {
  const removed = await app.invoke("agents:remove", h);
  if (h === "claude") {
    const get = run(cfg.claudeBin, ["mcp", "get", SERVER], {
      env: { CLAUDE_CONFIG_DIR: dirs.claude },
    });
    return {
      ok: removed.state === "not-added" && get.code !== 0,
      text: `agents:remove claude -> ${removed.state}\nclaude mcp get ${SERVER} (exit ${get.code}): ${(get.stdout + get.stderr).trim()}`,
    };
  }
  const text = existsSync(join(dirs.pi, "mcp.json"))
    ? readFileSync(join(dirs.pi, "mcp.json"), "utf8")
    : "(no file)";
  return {
    ok: removed.state === "not-added" && !text.includes(SERVER),
    text: `agents:remove pi -> ${removed.state}\n<sandbox>/mcp.json: ${text.trim()}`,
  };
}

/**
 * J14 in a real agent: it connects, calls openstyle_status, gets the text of
 * section 5 as a tool error and shows the text in its final answer.
 */
function agentFailure(run, text) {
  const status = run.calls.find((c) => c.tool === "openstyle_status");
  const connected = run.init
    ? run.init.mcp_servers?.some(
        (s) => s.name === SERVER && s.status === "connected",
      )
    : true;
  return {
    ok:
      connected &&
      !!status &&
      status.isError === true &&
      status.result.includes(text) &&
      run.finalText.includes(text),
    connected,
    statusResult: status?.result ?? null,
    finalText: run.finalText.slice(0, 600),
  };
}

/** A raw JSON-RPC client on the launcher: the bridge must stay alive. */
async function rawBridge(launcher, userData) {
  const child = spawn(launcher, ["--user-data", userData], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  own.add(child.pid);
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  const req = (id, method, params = {}) =>
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  req(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "harness-raw", version: "1" },
  });
  await sleep(1500);
  req(2, "tools/list");
  await sleep(1500);
  req(3, "tools/call", { name: "openstyle_status", arguments: {} });
  await sleep(1500);
  const alive = child.exitCode === null;
  child.kill("SIGTERM");
  own.delete(child.pid);
  return { alive, out: out.trim() };
}

// ---------------------------------------------------------------------------
// One harness
// ---------------------------------------------------------------------------

async function runHarness(h, liveBundle) {
  const root = join(SCRATCH, h);
  rmSync(root, { recursive: true, force: true });
  const dirs = {
    root,
    profile: join(root, "profile"),
    bin: join(root, "bin"),
    claude: join(root, "sandbox-claude"),
    pi: join(root, "sandbox-pi"),
    codex: join(root, "sandbox-codex"),
    cwd: join(root, "cwd"),
    live: join(root, "live-profile"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(join(EVID, h), { recursive: true });
  // The real CLIs, behind symlinks in a folder that only the app sees.
  const cfg = {
    claudeBin: which("claude"),
    piBin: which("pi"),
    cwd: dirs.cwd,
    claudeDir: dirs.claude,
  };
  for (const [bin, path] of [
    ["claude", cfg.claudeBin],
    ["pi", cfg.piBin],
    ["codex", which("codex")],
    ["node", which("node")],
  ]) {
    if (path) symlinkSync(path, join(dirs.bin, bin));
  }
  const result = {
    harness: h,
    journeys: {},
    checks: {},
    install: null,
    failures: {},
  };
  const app = await startApp(h, dirs);
  const db = join(dirs.profile, "freestyle.db");
  let appUp = true;
  try {
    const ctx = await seed(app, dirs.profile);
    say(
      `${h}: seeded (dictation ${ctx.deleteDictationId}, term ${ctx.deleteTermId})`,
    );
    result.install = await install(h, app, dirs, cfg);
    say(`${h}: install ${result.install.ok ? "ok" : "FAILED"}`);
    const entry = result.install.entry;
    if (!entry) throw new Error("no registered entry");
    const writeAgentConfig = (userData) => {
      const server = { ...entry, args: ["--user-data", userData] };
      if (h === "claude") {
        cfg.mcpConfig = join(root, "claude-mcp.json");
        writeFileSync(
          cfg.mcpConfig,
          JSON.stringify({ mcpServers: { [SERVER]: server } }, null, 2),
        );
      } else {
        // A project config in a scratch cwd. The user-level pi servers are off
        // here, so only Openstyle connects. The real ~/.pi/agent stays as is.
        const user =
          JSON.parse(readFileSync(join(HOME, ".pi/agent/mcp.json"), "utf8"))
            .mcpServers ?? {};
        const servers = Object.fromEntries(
          Object.keys(user).map((k) => [k, { enabled: false }]),
        );
        servers[SERVER] = { command: server.command, args: server.args };
        mkdirSync(join(dirs.cwd, ".pi"), { recursive: true });
        writeFileSync(
          join(dirs.cwd, ".pi", "mcp.json"),
          JSON.stringify({ mcpServers: servers }, null, 2),
        );
      }
    };
    writeAgentConfig(entry.args?.[1] ?? dirs.profile);
    const checks = checksFor(h, db, app, dirs.profile);
    const all = journeys(h, ctx).filter(
      (j) => !ONLY.length || ONLY.some((o) => j.id.startsWith(o)),
    );

    const doJourney = async (j, extra = {}) => {
      say(`${h}: ${j.id} start`);
      let r = await runAgent(h, j, cfg);
      const expected = new Set(j.tools);
      const missing = () =>
        [...expected].filter((t) => !r.calls.some((c) => c.tool === t));
      if (!j.failure && missing().length) {
        say(`${h}: ${j.id} missing ${missing().join(",")}, run again once`);
        const first = r;
        r = await runAgent(h, { ...j, id: `${j.id}-retry` }, cfg);
        r.firstMissing = first.calls.length ? missing() : "no tool calls";
      }
      result.journeys[j.id] = {
        ...extra,
        title: j.title,
        code: r.code,
        file: r.file.replace(`${SCRATCH}/`, ""),
        calls: r.calls,
        init: r.init
          ? {
              mcp_servers: r.init.mcp_servers,
              openstyleTools: r.init.tools?.filter((t) =>
                t.startsWith(TOOL_PREFIX.claude),
              ).length,
            }
          : null,
        missing: j.failure ? [] : missing(),
      };
      say(
        `${h}: ${j.id} done: ${r.calls.length} calls, missing [${result.journeys[j.id].missing.join(",")}]`,
      );
      return r;
    };

    for (const j of all) {
      if (j.live || j.failure) continue;
      await doJourney(j);
      if (j.id === "J12a-model-download") {
        say(`${h}: waiting for the model download`);
        for (let i = 0; i < 180; i++) {
          const status = await (await app.api("GET", "/mlx-llm/status")).json();
          const m = status.models?.find((x) => x.model === SEED.model);
          if (m?.status === "ready") break;
          if (m?.status === "error")
            throw new Error(`download error: ${JSON.stringify(m)}`);
          await sleep(10_000);
        }
      }
      if (j.id === "J12b-jobs") {
        say(`${h}: waiting for the summarize job`);
        for (let i = 0; i < 60; i++) {
          const jobs = await (await app.api("GET", "/jobs")).json();
          if (!JSON.stringify(jobs).includes(SEED.meeting)) break;
          await sleep(5000);
        }
      }
      for (const tool of j.tools) {
        if (checks[tool] && !result.checks[tool]) {
          try {
            result.checks[tool] = await checks[tool]();
          } catch (error) {
            result.checks[tool] = { ok: false, error: String(error) };
          }
        }
      }
    }
    // Checks that a later journey can change: run them again at the end.
    for (const tool of Object.keys(result.checks)) {
      if (!result.checks[tool].ok && checks[tool])
        result.checks[tool] = await checks[tool]();
    }

    // J15: the live store of a standalone server (live-server.ts).
    const live = all.find((j) => j.live);
    if (live) {
      const port = await freePort();
      const token = (await import("node:crypto"))
        .randomBytes(32)
        .toString("hex");
      const proc = spawn(process.execPath, [liveBundle], {
        cwd: ELECTRON,
        env: {
          ...process.env,
          OPENSTYLE_DB_PATH: join(dirs.live, "freestyle.db"),
          OPENSTYLE_MCP_TOKEN: token,
          OPENSTYLE_LOG_DIR: join(dirs.live, "logs"),
          OPENSTYLE_MODEL_CACHE_DIR: join(dirs.root, "model-cache"),
          HF_HOME: HF,
          HUGGINGFACE_HUB_CACHE: join(HF, "hub"),
          LIVE_USER_DATA: dirs.live,
          LIVE_PORT: String(port),
          LIVE_LINE_MS: "3000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      own.add(proc.pid);
      let liveLog = "";
      proc.stdout.on("data", (d) => {
        liveLog += d;
      });
      proc.stderr.on("data", (d) => {
        liveLog += d;
      });
      for (let i = 0; i < 60 && !existsSync(join(dirs.live, "mcp.json")); i++)
        await sleep(500);
      writeAgentConfig(dirs.live);
      const r = await doJourney(live);
      proc.kill("SIGTERM");
      own.delete(proc.pid);
      writeFileSync(join(EVID, h, "live-server.log"), liveLog);
      const polls = r.calls.filter((c) => c.tool === "get_live_transcript");
      const data = polls
        .filter((c) => !c.isError)
        .map((c) => {
          try {
            return JSON.parse(c.result);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const cursors = data.map((d) => d.cursor);
      // The late-line step (issue #434): the far mic line comes in one poll,
      // the late system line in a later poll, and the late line ends before
      // the far line. An end-time cursor would skip it.
      const has = (d, text) => d.lines.some((l) => l.text === text);
      const farAt = data.findIndex((d) => has(d, LIVE_FAR_LINE));
      const lateAt = data.findIndex((d) => has(d, LIVE_LATE_LINE));
      const late = data[lateAt]?.lines.find((l) => l.text === LIVE_LATE_LINE);
      const maxEndBefore = Math.max(
        0,
        ...data.slice(0, lateAt).flatMap((d) => d.lines.map((l) => l.endMs)),
      );
      const lateCount = data.filter((d) => has(d, LIVE_LATE_LINE)).length;
      const lateOk =
        farAt >= 0 &&
        lateAt > farAt &&
        late !== undefined &&
        late.endMs < maxEndBefore &&
        lateCount === 1;
      result.checks.get_live_transcript = {
        ok:
          polls.some((c) => c.isError && c.result.includes(LIVE_OFF_TEXT)) &&
          data.length >= 3 &&
          cursors.at(-1) > cursors[0] &&
          data[0].lines.length > 0 &&
          data.every((d) => d.recording === true) &&
          lateOk,
        offText: polls.find((c) => c.isError)?.result ?? null,
        cursors,
        lineCounts: data.map((d) => d.lines.length),
        lateLine: {
          ok: lateOk,
          farPoll: farAt + 1,
          latePoll: lateAt + 1,
          lateEndMs: late?.endMs ?? null,
          maxEndMsBefore: maxEndBefore,
          timesSeen: lateCount,
        },
      };
      writeAgentConfig(dirs.profile);
    }

    // J14: the three failure modes of section 5.
    const fail = all.find((j) => j.failure);
    const j14 = {};
    if (fail) {
      // a) Agent access off (the user turns it off in Settings).
      await app.api("PUT", "/settings/mcp_enabled", { value: "false" });
      const offRun = await doJourney({
        ...fail,
        id: `${fail.id}-a-access-off`,
      });
      j14.off = await rawBridge(entry.command, dirs.profile);
      await app.api("PUT", "/settings/mcp_enabled", { value: "true" });
      // b) A wrong token in the profile mcp.json.
      const mcpJson = join(dirs.profile, "mcp.json");
      const original = readFileSync(mcpJson, "utf8");
      const wrong = JSON.parse(original);
      wrong.token = "0".repeat(64);
      writeFileSync(mcpJson, JSON.stringify(wrong), { mode: 0o600 });
      const tokenRun = await doJourney({
        ...fail,
        id: `${fail.id}-b-wrong-token`,
      });
      j14.token = await rawBridge(entry.command, dirs.profile);
      writeFileSync(mcpJson, original, { mode: 0o600 });
      j14.offRun = agentFailure(offRun, FAILURE_TEXTS.off);
      j14.tokenRun = agentFailure(tokenRun, FAILURE_TEXTS.token);
    }

    // J1 step 9 / J2: remove the entry again, through the app.
    result.uninstall = await uninstall(h, app, dirs, cfg);
    say(`${h}: uninstall ${result.uninstall.ok ? "ok" : "FAILED"}`);

    // Logs of the profile, then quit.
    await app.quit();
    appUp = false;
    if (fail) {
      // c) The app is not running. Re-add the entry in the agent config only.
      const downRun = await doJourney({
        ...fail,
        id: `${fail.id}-c-not-running`,
      });
      j14.down = await rawBridge(entry.command, dirs.profile);
      j14.downRun = agentFailure(downRun, FAILURE_TEXTS.down);
      const texts = (k) => j14[k]?.out ?? "";
      result.checks.j14 = {
        ok:
          texts("off").includes(FAILURE_TEXTS.off) &&
          texts("token").includes(FAILURE_TEXTS.token) &&
          texts("down").includes(FAILURE_TEXTS.down) &&
          j14.off.alive &&
          j14.token.alive &&
          j14.down.alive &&
          j14.offRun.ok &&
          j14.tokenRun.ok &&
          j14.downRun.ok,
        ...j14,
      };
    }
  } finally {
    if (appUp) await app.quit();
    // Keep the server log of the profile as evidence (fictional data only).
    const logs = join(dirs.profile, "logs");
    if (existsSync(logs))
      cpSync(logs, join(EVID, h, "profile-logs"), { recursive: true });
    const liveLogs = join(dirs.live, "logs");
    if (existsSync(liveLogs))
      cpSync(liveLogs, join(EVID, h, "live-logs"), { recursive: true });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

function logLines(h) {
  const lines = [];
  for (const sub of ["profile-logs", "live-logs"]) {
    const dir = join(EVID, h, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (line.includes("[mcp] tool="))
          lines.push({ file: `${h}/${sub}/${f}`, line });
      }
    }
  }
  return lines;
}

function buildMatrix(results, toolNames) {
  const matrix = {};
  for (const tool of toolNames) {
    matrix[tool] = {};
    for (const h of HARNESSES) {
      const r = results[h];
      if (!r) {
        matrix[tool][h] = { ok: false, why: "harness not run" };
        continue;
      }
      const calls = Object.entries(r.journeys).flatMap(([jid, j]) =>
        j.calls.map((c) => ({ ...c, journey: jid, file: j.file })),
      );
      const mine = calls.filter(
        (c) => c.tool === tool && c.result !== undefined,
      );
      const log = logLines(h).filter((l) =>
        l.line.includes(`tool=${tool} agent=${AGENT_PREFIX[h]}`),
      );
      const check = r.checks[tool];
      const why = [];
      if (!mine.length) why.push("no tool call with result");
      if (!log.length) why.push("no server log line");
      if (DELETE_TOOLS.has(tool)) {
        if (!mine.some((c) => c.isError && c.result.includes(CONFIRM_TEXT)))
          why.push("no refusal without confirm");
        if (!mine.some((c) => !c.isError)) why.push("no confirmed delete");
      }
      if (WRITE_TOOLS.has(tool) && !check?.ok)
        why.push("SQLite read-back failed or missing");
      if (tool === "get_live_transcript" && !check?.ok)
        why.push("live poll check failed");
      const first = mine.find((c) => !c.isError) ?? mine[0];
      matrix[tool][h] = {
        ok: why.length === 0,
        why,
        calls: mine.length,
        evidence: first ? `${first.file} (${first.journey})` : null,
        log: log[0]?.line.trim() ?? null,
        check: check ?? null,
      };
    }
  }
  return matrix;
}

function matrixMd(matrix, results, configs) {
  const lines = [
    "# MCP harness evidence matrix",
    "",
    `Run: ${new Date().toISOString()}. Data: fictional seed only. Server name: \`${SERVER}\`.`,
    "",
    `| Tool | ${HARNESSES.join(" | ")} | Evidence (first harness) |`,
    `|---|${HARNESSES.map(() => "---").join("|")}|---|`,
  ];
  for (const [tool, cells] of Object.entries(matrix)) {
    const marks = HARNESSES.map((h) =>
      cells[h].ok ? "ok" : `missing (${cells[h].why.join("; ")})`,
    );
    lines.push(
      `| ${tool} | ${marks.join(" | ")} | ${cells[HARNESSES[0]].evidence ?? "-"} |`,
    );
  }
  const okCells = Object.values(matrix)
    .flatMap((c) => HARNESSES.map((h) => c[h].ok))
    .filter(Boolean).length;
  lines.push(
    "",
    `Cells ok: ${okCells} of ${Object.keys(matrix).length * HARNESSES.length}.`,
    "",
  );
  for (const h of HARNESSES) {
    const r = results[h];
    if (!r) continue;
    lines.push(
      `## ${h}`,
      "",
      `- Install: ${r.install?.ok ? "ok" : "FAILED"}${r.install?.codexOk !== undefined ? `, Codex install: ${r.install.codexOk ? "ok" : "FAILED"}` : ""}`,
    );
    lines.push(`- Remove: ${r.uninstall?.ok ? "ok" : "FAILED"}`);
    lines.push(`- J14 failure texts: ${r.checks.j14?.ok ? "ok" : "FAILED"}`);
    lines.push(
      `- J15 live: ${r.checks.get_live_transcript?.ok ? "ok" : "FAILED"} (cursors ${JSON.stringify(r.checks.get_live_transcript?.cursors ?? [])}, late line ${JSON.stringify(r.checks.get_live_transcript?.lateLine ?? null)})`,
      "",
    );
  }
  lines.push(
    "## Real agent configs (before and after)",
    "",
    "```json",
    JSON.stringify(configs, null, 2),
    "```",
    "",
  );
  return lines.join("\n");
}

/** One evidence file per journey: a section for each harness. */
function journeyFiles(results) {
  const dir = join(EVID, "journeys");
  mkdirSync(dir, { recursive: true });
  const ids = new Set(
    Object.values(results).flatMap((r) =>
      Object.keys(r.journeys).map((k) =>
        k.replace(/-(retry|a-access-off|b-wrong-token|c-not-running)$/, ""),
      ),
    ),
  );
  for (const id of ids) {
    const out = [
      `# ${id}`,
      "",
      "Fictional data. Generated by `scripts/mcp-harness/run.mjs`.",
      "",
    ];
    for (const [h, r] of Object.entries(results)) {
      const runs = Object.entries(r.journeys).filter(([k]) => k.startsWith(id));
      if (!runs.length) continue;
      out.push(
        `## ${h === "claude" ? "Claude Code" : "pi (default model)"}`,
        "",
      );
      for (const [k, j] of runs) {
        out.push(
          `### ${k}`,
          "",
          `Transcript: \`${j.file}\`. Exit code ${j.code}.`,
          "",
        );
        if (j.init)
          out.push(
            `MCP servers at start: \`${JSON.stringify(j.init.mcp_servers)}\`, Openstyle tools: ${j.init.openstyleTools}.`,
            "",
          );
        out.push("| # | Tool | Input | Result |", "|---|---|---|---|");
        j.calls.forEach((c, i) => {
          const cut = (s, n) =>
            String(s ?? "")
              .replace(/\|/g, "\\|")
              .replace(/\n/g, " ")
              .slice(0, n);
          out.push(
            `| ${i + 1} | ${c.tool} | \`${cut(JSON.stringify(c.input), 140)}\` | ${c.isError ? "ERROR: " : ""}${cut(c.result, 200)} |`,
          );
        });
        out.push("");
      }
      const tools = new Set(
        runs.flatMap(([, j]) => j.calls.map((c) => c.tool)),
      );
      const checks = [...tools]
        .filter((t) => r.checks[t])
        .map(
          (t) =>
            `- ${t}: ${r.checks[t].ok ? "ok" : "FAILED"} \`${JSON.stringify({ ...r.checks[t], ok: undefined }).slice(0, 400)}\``,
        );
      if (id.startsWith("J14") && r.checks.j14)
        checks.push(
          `- failure texts: ${r.checks.j14.ok ? "ok" : "FAILED"}\n  - off: \`${r.checks.j14.off?.out}\`\n  - token: \`${r.checks.j14.token?.out}\`\n  - down: \`${r.checks.j14.down?.out}\`\n  - bridge alive after each: ${[r.checks.j14.off?.alive, r.checks.j14.token?.alive, r.checks.j14.down?.alive].join(", ")}\n${["offRun", "tokenRun", "downRun"].map((k) => `  - agent ${k}: ${r.checks.j14[k]?.ok ? "ok" : "FAILED"}, connected ${r.checks.j14[k]?.connected}, openstyle_status: \`${r.checks.j14[k]?.statusResult}\`, final text: ${JSON.stringify(r.checks.j14[k]?.finalText)}`).join("\n")}`,
        );
      if ((id.startsWith("J01") || id.startsWith("J02")) && r.install)
        checks.push(r.install.text, `Remove: ${r.uninstall?.text}`);
      if (checks.length) out.push("Read-back:", "", ...checks, "");
    }
    writeFileSync(join(dir, `${id}.md`), out.join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cleanup = () => {
  for (const pid of own) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone
    }
  }
  releaseLock();
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

let exitCode = 1;
const configsBefore = configState();
const logsBefore = logState();
const results = {};
try {
  if (!SKIP_BUILD || !existsSync(APP_EXE)) build();
  const liveBundle = await buildLiveServer();
  await takeLock();
  const tccBefore = tccPrompts();
  for (const h of HARNESSES) {
    try {
      results[h] = await runHarness(h, liveBundle);
    } catch (error) {
      say(`${h}: FAILED: ${error.stack ?? error}`);
      results[h] = results[h] ?? {
        harness: h,
        journeys: {},
        checks: {},
        error: String(error),
      };
    }
    writeFileSync(
      join(EVID, `${h}-result.json`),
      JSON.stringify(results[h], null, 2),
    );
  }
  const tccAfter = tccPrompts();
  releaseLock();
  // The Claude init event lists the tools that tools/list gave (J1: 50).
  const init = Object.values(results.claude?.journeys ?? {}).find(
    (j) => j.init,
  )?.init;
  // The 50 tool names come from the tool source files.
  const allTools = [];
  for (const f of [
    "meetings",
    "folders",
    "history",
    "ledger",
    "vocabulary",
    "settings",
  ]) {
    const src = readFileSync(
      join(REPO, `apps/server/src/mcp/tools/${f}.ts`),
      "utf8",
    );
    for (const m of src.matchAll(/^\s+name: "([a-z_]+)",$/gm))
      allTools.push(m[1]);
  }
  const matrix = buildMatrix(results, allTools);
  const configsAfter = configState();
  const configs = {
    before: configsBefore,
    after: configsAfter,
    openstyleLogs: { before: logsBefore, after: logState() },
    tccPrompts: { before: tccBefore, after: tccAfter },
    claudeInit: init ?? null,
  };
  writeFileSync(
    join(EVID, "matrix.json"),
    JSON.stringify({ tools: allTools.length, matrix, configs }, null, 2),
  );
  writeFileSync(join(EVID, "matrix.md"), matrixMd(matrix, results, configs));
  journeyFiles(results);
  const missing = Object.entries(matrix).flatMap(([t, c]) =>
    HARNESSES.filter((h) => !c[h].ok).map((h) => `${t}/${h}`),
  );
  say(
    `matrix: ${allTools.length} tools, missing cells: ${missing.length ? missing.join(", ") : "none"}`,
  );
  // The install, remove and failure-text proofs count too.
  const extra = HARNESSES.flatMap((h) => {
    const r = results[h] ?? {};
    return [
      ["install", r.install?.ok],
      ["remove", r.uninstall?.ok],
      ["J14", r.checks?.j14?.ok],
    ]
      .filter(([, ok]) => !ok)
      .map(([what]) => `${what}/${h}`);
  });
  if (extra.length) say(`failed proofs: ${extra.join(", ")}`);
  exitCode = missing.length || extra.length || allTools.length !== 50 ? 1 : 0;
} catch (error) {
  say(`FAILED: ${error.stack ?? error}`);
} finally {
  cleanup();
  // Delete the scratch folder except the evidence (and the build, for --skip-build).
  for (const entry of readdirSync(SCRATCH)) {
    if (
      entry === "evidence" ||
      (args.includes("--keep-build") && entry === "build")
    )
      continue;
    rmSync(join(SCRATCH, entry), { recursive: true, force: true });
  }
  say(`evidence: ${EVID}`);
}
process.exit(exitCode);
