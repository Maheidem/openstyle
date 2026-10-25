// gold-draft.mts: the starting point of a gold key for one meeting
// (`pnpm meeting:eval:gold-draft --meeting <id8>`).
//
// Usage (from the repo root):
//   pnpm meeting:eval:gold-draft --meeting <id8> [--engine-b <hf repo | catalog id>]
//     [--port <n>] [--hf-cache <dir>]
//
// Steps:
//   1. Engine A and the Enhance output: `pnpm meeting:eval --models
//      gemma-4-e4b-qat-4bit --meetings <id8> --keep` (the built-in MLX ASR
//      model local-mlx/qwen3-1.7b-8bit with its ASR cache, then Enhance and
//      Summarize with the built-in Gemma 4 E4B).
//   2. Engine B: a second transcription of the same copied meeting in its own
//      private scratch profile (/tmp/meeting-eval/asr/work/<pid>). The default is Whisper
//      large-v3-turbo through the app's custom MLX model route
//      (POST /api/mlx-asr/custom-models/validate, then /custom-models, which
//      starts the download into the isolated HF cache). A catalog id of
//      apps/server/src/lib/mlx-asr/constants.ts selects a built-in model
//      instead. The transcription runs under the GPU lock and is cached by
//      its input hash, as for engine A.
//   3. Per channel: align A and B by time and words (align.mts) and mark the
//      spans where they differ.
//   4. Write ~/.openstyle-eval/drafts/<id8>.json (folder mode 0700, file
//      mode 0600): per-channel turns with both engine texts, the E4B text and
//      the speaker label, the diff spans, the E4B summary, tags and speaker
//      suggestions, and the asrHash of engine A.
//
// Only the app's built-in MLX models and a custom MLX model run on this Mac.
// Nothing calls the owner's model server (owner rule 2026-10-21).
//
// Privacy: the draft holds real meeting text. It stays under
// ~/.openstyle-eval (never the repo, never /tmp). The eval out folder of
// step 1 is deleted at the end. The console prints counts, ids, hashes and
// paths only.
//
// Exit codes: 0 ok; 1 a step failed; 2 usage.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { MLX_ASR_MODELS } from "../../../apps/server/src/lib/mlx-asr/constants.ts";
import { alignChannel, type Seg } from "./align.mts";
import { CHANNELS, type Channel } from "./gold.mts";
import {
  type Call,
  checkBuild,
  EVAL_HOME,
  ensureTranscribed,
  HF_CACHE_DEFAULT,
  isCacheDir,
  isTmp,
  ROOT,
  releaseLock,
  removeAllScratch,
  removeScratch,
  resolveMeetingIds,
  runChild,
  setupScratch,
  sleep,
  unqueue,
  type VoiceRow,
  withServer,
} from "./runtime.mts";

const ENHANCE_MODEL = "gemma-4-e4b-qat-4bit";
const DEFAULT_ENGINE_B = "mlx-community/whisper-large-v3-turbo";
// The ASR folder of pnpm meeting:eval: private scratch profiles under
// work/<pid>, the shared per-meeting transcription cache under cache/.
const ASR_DIR = join(ROOT, "asr");
const DRAFT_DIR = join(homedir(), ".openstyle-eval", "drafts");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: pnpm meeting:eval:gold-draft --meeting <id8> [--engine-b <hf repo | catalog id>] [--port <n>] [--hf-cache <dir>]",
  );
  process.exit(2);
}

const meetingArg = arg("meeting");
if (!meetingArg || !/^[0-9a-f]{8}/.test(meetingArg))
  usage("--meeting <id8> is required");
const engineB = arg("engine-b") ?? DEFAULT_ENGINE_B;
const builtinB = MLX_ASR_MODELS.find((m) => m.id === engineB);
if (!builtinB && !/^[\w.-]+\/[\w.-]+$/.test(engineB))
  usage(`--engine-b must be a catalog id or an HF repo id: ${engineB}`);
const basePort = Number(arg("port") ?? "4797");
if (!Number.isInteger(basePort) || basePort < 1024)
  usage("--port must be a port number");
for (let p = basePort; p < basePort + 4; p++)
  if (p === 4649)
    usage("the ports must not include 4649 (the installed app owns it)");
const hfCache = resolve(arg("hf-cache") ?? HF_CACHE_DEFAULT);
if (!isCacheDir(hfCache))
  usage(`--hf-cache must be under /tmp or ${EVAL_HOME}: ${hfCache}`);

// --- Rows -------------------------------------------------------------------------

interface Row {
  source: Channel;
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  enhanced_text: string | null;
  speaker_label: string | null;
}

function readSegments(dbPath: string, id: string): Row[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT source, idx, start_ms, end_ms, text, enhanced_text, speaker_label FROM meeting_segments WHERE meeting_id = ? ORDER BY source, start_ms, idx",
      )
      .all(id) as unknown as Row[];
  } finally {
    db.close();
  }
}

const segsOf = (rows: Row[], ch: Channel): Seg[] =>
  rows
    .filter((r) => r.source === ch)
    .map((r) => ({ startMs: r.start_ms, endMs: r.end_ms, text: r.text ?? "" }));

// --- 1. Engine A and E4B (pnpm meeting:eval) ----------------------------------------

async function runEngineA(id8: string, outDir: string) {
  rmSync(outDir, { recursive: true, force: true });
  const rc = await runChild(
    process.execPath,
    [
      "--import",
      "./scripts/meeting-v2/ts-register.mjs",
      "scripts/meeting-v2/eval/eval.mts",
      "--models",
      ENHANCE_MODEL,
      "--meetings",
      id8,
      "--out",
      outDir,
      "--keep",
      "--port",
      String(basePort),
      "--hf-cache",
      hfCache,
    ],
    process.env,
  );
  if (rc !== 0) throw new Error(`pnpm meeting:eval exited ${rc}`);
  const results = JSON.parse(
    readFileSync(join(outDir, "results.json"), "utf8"),
  );
  const run = (results.runs as { model: string; status: string }[]).find(
    (r) => r.model === ENHANCE_MODEL,
  );
  if (run?.status !== "ok")
    throw new Error(`the ${ENHANCE_MODEL} run is ${run?.status ?? "missing"}`);
  return {
    // The hash of this meeting's transcription (a gold key records it).
    asrHash: results.meetings[0].asrHash as string,
    asrModel: results.asrModel as string,
    runDb: join(outDir, "runs", ENHANCE_MODEL, id8, "test.db"),
  };
}

// --- 2. Engine B -----------------------------------------------------------------------

type StatusRow = { model: string; status: string; error?: string };
async function asrStatus(
  call: Call,
  id: string,
): Promise<StatusRow | undefined> {
  const r = await call("GET", "/api/mlx-asr/status");
  return ((r.json?.models ?? []) as StatusRow[]).find((m) => m.model === id);
}

/** Wait until the model is ready in the HF cache (the download is network and disk only). */
async function waitReady(call: Call, id: string): Promise<void> {
  let st = await asrStatus(call, id);
  let lastPrint = 0;
  const end = Date.now() + 2 * 3600_000;
  while (st?.status !== "ready" && Date.now() < end) {
    if (st?.status === "error")
      throw new Error(
        `model ${id}: status error (${st.error ?? "no message"})`,
      );
    if (Date.now() - lastPrint > 30_000) {
      lastPrint = Date.now();
      console.log(`engine B ${id}: ${st?.status ?? "unknown"}`);
    }
    await sleep(3000);
    st = await asrStatus(call, id);
  }
  if (st?.status !== "ready")
    throw new Error(`model ${id}: status ${st?.status ?? "missing"}`);
}

/** Register (custom) or download (catalog) engine B in the B scratch DB. */
async function prepareEngineB(work: string): Promise<{
  voice: VoiceRow;
  hashExtra: string[];
}> {
  const dbPath = join(work, "test.db");
  return withServer(
    {
      port: basePort,
      hfCache,
      dbPath,
      logPath: join(work, "engine-b.log"),
    },
    async (call) => {
      if (builtinB) {
        if ((await asrStatus(call, builtinB.id))?.status !== "ready") {
          console.log(
            `engine B download ${builtinB.id}: ${(builtinB.sizeBytes / 1e9).toFixed(2)} GB into ${hfCache}`,
          );
          const d = await call(
            "POST",
            `/api/mlx-asr/models/${builtinB.id}/download`,
          );
          if (d.status !== 200)
            throw new Error(`download route answered ${d.status}`);
        }
        await waitReady(call, builtinB.id);
        return {
          voice: {
            provider: "local-mlx",
            model_id: `local-mlx/${builtinB.id}`,
            model_name: builtinB.displayName,
          },
          hashExtra: [`engine-b=${builtinB.hfId}`],
        };
      }
      const v = await call("POST", "/api/mlx-asr/custom-models/validate", {
        model: engineB,
      });
      if (v.status !== 200)
        throw new Error(
          `custom model validate answered ${v.status} (code ${v.json?.code ?? "?"}): ${v.json?.error ?? ""}`,
        );
      console.log(
        `engine B validate: family ${v.json.family}, ${(v.json.totalBytes / 1e9).toFixed(2)} GB, revision ${String(v.json.revision).slice(0, 12)}, processor ${v.json.processorSource ?? "in repo"}`,
      );
      const add = await call("POST", "/api/mlx-asr/custom-models", {
        model: engineB,
      });
      if (add.status !== 201)
        throw new Error(
          `custom model add answered ${add.status} (code ${add.json?.code ?? "?"})`,
        );
      const id = add.json.id as string;
      await waitReady(call, id);
      console.log(`engine B ready: ${id}`);
      return {
        voice: {
          provider: "local-mlx",
          model_id: `local-mlx/${id}`,
          model_name: engineB.split("/")[1] as string,
        },
        hashExtra: [`engine-b=${engineB}@${v.json.revision}`],
      };
    },
  );
}

// --- 3 and 4. Draft --------------------------------------------------------------------

function readExtras(dbPath: string, id: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const s = db
      .prepare(
        "SELECT markdown, summary_json FROM meeting_summaries WHERE meeting_id = ?",
      )
      .get(id) as
      | { markdown: string | null; summary_json: string | null }
      | undefined;
    let tags: string[] = [];
    try {
      tags = (
        db
          .prepare(
            "SELECT t.name FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.meeting_id = ? ORDER BY t.name",
          )
          .all(id) as { name: string }[]
      ).map((t) => t.name);
    } catch {
      tags = [];
    }
    const speakers = (
      db
        .prepare(
          "SELECT speaker_label, suggested_name, suggested_kind FROM meeting_speakers WHERE meeting_id = ? ORDER BY speaker_label",
        )
        .all(id) as {
        speaker_label: string;
        suggested_name: string | null;
        suggested_kind: string | null;
      }[]
    ).map((r) => ({
      label: r.speaker_label,
      suggestedName: r.suggested_name,
      suggestedKind: r.suggested_kind,
    }));
    let summary: unknown = null;
    try {
      summary = JSON.parse(s?.summary_json ?? "null");
    } catch {
      summary = null;
    }
    return { summary, summaryMarkdown: s?.markdown ?? null, tags, speakers };
  } finally {
    db.close();
  }
}

const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);

async function main(): Promise<number> {
  checkBuild();
  mkdirSync(ASR_DIR, { recursive: true });
  const [id] = resolveMeetingIds([meetingArg as string], ASR_DIR);
  const meetingId = id as string;
  const id8 = meetingId.slice(0, 8);
  const evalOut = join(ROOT, "gold-draft", id8);

  console.log(
    `gold draft ${id8}: engine A + ${ENHANCE_MODEL} (pnpm meeting:eval)`,
  );
  const a = await runEngineA(id8, evalOut);

  console.log(`gold draft ${id8}: engine B ${engineB}`);
  const work = await setupScratch(ASR_DIR, [meetingId], basePort + 2);
  const b = await prepareEngineB(work);
  const bt = await ensureTranscribed({
    asrDir: ASR_DIR,
    work,
    out: join(evalOut, "engine-b.db"),
    ids: [meetingId],
    voice: b.voice,
    port: basePort + 3,
    hfCache,
    hashExtra: b.hashExtra,
  });

  const rowsA = readSegments(a.runDb, meetingId);
  const rowsB = readSegments(bt.path, meetingId);
  const extras = readExtras(a.runDb, meetingId);
  const channels = {} as Record<Channel, unknown>;
  const diffSpans = [];
  for (const ch of CHANNELS) {
    const al = alignChannel(ch, segsOf(rowsA, ch), segsOf(rowsB, ch));
    const rows = rowsA.filter((r) => r.source === ch);
    channels[ch] = {
      stats: {
        ...al.stats,
        bSegments: rowsB.filter((r) => r.source === ch).length,
      },
      turns: al.turns.map((t, i) => ({
        startMs: t.startMs,
        endMs: t.endMs,
        speaker: rows[i]?.speaker_label ?? null,
        a: t.a,
        b: t.b,
        enhanced: rows[i]?.enhanced_text ?? null,
        spans: t.spans,
      })),
    };
    diffSpans.push(...al.spans);
  }
  const draft = {
    format: "openstyle-gold-draft",
    meeting: id8,
    meetingId,
    createdAt: new Date().toISOString(),
    asrHash: a.asrHash,
    engines: {
      a: { voice: a.asrModel, asrHash: a.asrHash },
      b: {
        voice: b.voice.model_id,
        source: engineB,
        asrHash: bt.hashes[meetingId],
      },
    },
    enhanceModel: ENHANCE_MODEL,
    channels,
    diffSpans,
    summary: extras.summary,
    summaryMarkdown: extras.summaryMarkdown,
    tags: extras.tags,
    speakers: extras.speakers,
  };

  // Private folder: mode 0700 for ~/.openstyle-eval and drafts, 0600 file.
  for (const d of [join(homedir(), ".openstyle-eval"), DRAFT_DIR]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  const path = join(DRAFT_DIR, `${id8}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(draft, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, path);

  // Read the file back: a write that returned is not proof that it holds the draft.
  const back = JSON.parse(readFileSync(path, "utf8"));
  if (
    back.diffSpans.length !== diffSpans.length ||
    CHANNELS.some(
      (ch) =>
        back.channels[ch].turns.length !==
        rowsA.filter((r) => r.source === ch).length,
    )
  )
    throw new Error(`draft ${path}: the read-back counts differ`);

  // Counts only.
  for (const ch of CHANNELS) {
    const c = back.channels[ch];
    const sp = back.diffSpans.filter(
      (s: { channel: string }) => s.channel === ch,
    );
    const sec = sp.reduce(
      (n: number, s: { startMs: number; endMs: number }) =>
        n + (s.endMs - s.startMs),
      0,
    );
    console.log(
      `${ch}: turns ${c.turns.length} (B segments ${c.stats.bSegments}), words A ${c.stats.aWords} B ${c.stats.bWords} (eq ${c.stats.eq} sub ${c.stats.sub} del ${c.stats.del} ins ${c.stats.ins}), blocks ${c.stats.blocks}, diff spans ${sp.length} (${(sec / 1000).toFixed(1)} s)`,
    );
  }
  const totalSec =
    back.diffSpans.reduce(
      (n: number, s: { startMs: number; endMs: number }) =>
        n + (s.endMs - s.startMs),
      0,
    ) / 1000;
  const enhanced = rowsA.filter((r) => r.enhanced_text !== null).length;
  const s = back.summary as Record<string, unknown> | null;
  console.log(
    `diff spans: ${back.diffSpans.length} (${totalSec.toFixed(1)} s); E4B: enhanced segments ${enhanced}/${rowsA.length}, summary ${s ? `decisions ${len(s.decisions)}, action items ${len(s.actionItems)}, key points ${len(s.keyPoints)}, open questions ${len(s.openQuestions)}` : "none"}, tags ${back.tags.length}, speaker rows ${back.speakers.length} (named ${back.speakers.filter((x: { suggestedName: string | null }) => x.suggestedName).length})`,
  );
  console.log(`asrHash A ${a.asrHash}, B ${bt.hashes[meetingId]}`);
  console.log(`draft (private text): ${path}`);

  removeScratch(work);
  rmSync(evalOut, { recursive: true, force: true });
  console.log(`deleted ${evalOut} (eval runs) and the scratch profile`);
  console.log(
    `cleanup of the transcription caches (private text and audio): rm -rf ${join(ASR_DIR, "cache")}`,
  );
  return 0;
}

main().then(
  (code) => {
    releaseLock();
    unqueue();
    removeAllScratch();
    process.exit(code);
  },
  (e) => {
    // Messages name steps, ids and HTTP codes, never meeting text.
    console.error(`gold-draft failed: ${(e as Error).message}`);
    releaseLock();
    unqueue();
    removeAllScratch();
    process.exit(1);
  },
);
