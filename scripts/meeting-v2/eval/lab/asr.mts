// asr.mts: one Eval Lab cell of the meeting ASR stage.
//
// Steps: a private scratch profile from the frozen corpus (setup-scratch.sh
// with the seed DB and the private audio copies), a check of the copied
// audio against the manifest, the knobs on the scratch DB and the env, the
// transcription (runtime.mts ensureTranscribed: a meeting comes from the
// lab ASR cache when its full key is there, else it is transcribed under
// the GPU lock), then the scores. The ASR cache key holds every knob, the
// audio sha256, the code hash and the model revisions, so a cache hit is
// always valid. The scratch profile is deleted at the end.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MLX_ALIGNER_MODEL,
  MLX_ASR_MODELS,
} from "../../../../apps/server/src/lib/mlx-asr/constants.ts";
import {
  serverKey,
  serverModelId,
} from "../../../../packages/validations/src/servers.ts";
import type { Gold } from "../gold.mts";
import {
  ensureTranscribed,
  removeScratch,
  setupScratch,
  type VoiceRow,
} from "../runtime.mts";
import {
  AUDIO_FILES,
  type Manifest,
  privateDir,
  privateWrite,
  seedPath,
  sha256File,
} from "./corpus.mts";
import { KNOBS, type KnobValues, runName } from "./knobs.mts";
import { type RunScore, scoreRunDb } from "./score.mts";
import { canonicalJson } from "./snapshot.mts";

export interface CellResult {
  score: RunScore;
  /** The ASR cache key of each meeting (by id8). */
  cacheKeys: Record<string, string>;
  fresh: string[];
  cached: string[];
  /** The ASR wall time of each meeting (s), from its first transcription. */
  asrWall: Record<string, number>;
  peakRssWorkerMb: number | null;
  peakRssTreeMb: number | null;
}

/** The HF ids of the models of a cell; throws when a model is not cached. */
export function cellModels(kv: KnobValues): { asr: string; aligner: string } {
  if (kv.asr_server_model !== "none")
    return {
      asr: `server:${kv.asr_server_model}`,
      aligner: MLX_ALIGNER_MODEL.hfId,
    };
  const d = MLX_ASR_MODELS.find((m) => m.id === kv.asr_model);
  if (!d) throw new Error(`asr_model ${kv.asr_model} is not in the catalog`);
  return {
    asr: d.hfId,
    aligner: MLX_ALIGNER_MODEL.hfId,
  };
}

/** Peak RSS of this process tree: the ASR worker and the whole tree (KB). */
function treeRss(): { worker: number; tree: number } {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
    encoding: "utf8",
  });
  const rows = (ps.stdout ?? "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((x) => x.length >= 4)
    .map(([pid, ppid, rss, ...c]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      rss: Number(rss) || 0,
      comm: c.join(" "),
    }));
  const kids = new Map<number, typeof rows>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  let worker = 0;
  let tree = 0;
  const walk = (pid: number) => {
    for (const k of kids.get(pid) ?? []) {
      tree += k.rss;
      if (k.comm.includes("mlx_asr_worker")) worker += k.rss;
      walk(k.pid);
    }
  };
  walk(process.pid);
  return { worker, tree };
}

/** The id of the own-server row that the lab writes into a scratch DB. */
const LAB_SERVER_ID = "srv_lab00001";

/** Apply the scratch-DB knobs to <work>/test.db. */
export function applyDbKnobs(
  dbPath: string,
  kv: KnobValues,
  ownerName: string | undefined,
  serverUrl?: string,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    if (kv.asr_server_model !== "none") {
      if (!serverUrl?.trim())
        throw new Error(
          "asr_server_model needs LAB_ASR_SERVER_URL in the env (the speech server address)",
        );
      // The same row that Settings > Models writes for an own server.
      db.exec(
        `CREATE TABLE IF NOT EXISTS own_servers (
           id TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key TEXT,
           flavor TEXT, server_key TEXT NOT NULL UNIQUE,
           created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      );
      db.prepare("DELETE FROM own_servers WHERE id = ?").run(LAB_SERVER_ID);
      db.prepare(
        "INSERT INTO own_servers (id, base_url, api_key, flavor, server_key) VALUES (?, ?, NULL, 'openai', ?)",
      ).run(LAB_SERVER_ID, serverUrl.trim(), serverKey(serverUrl.trim()));
    }
    const setSetting = (key: string, value: string | null) => {
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      if (value !== null)
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
          key,
          value,
        );
    };
    if (kv.owner_name === "env") {
      if (!ownerName?.trim())
        throw new Error("owner_name=env needs LAB_OWNER_NAME in the env");
      setSetting("owner_name", ownerName.trim());
    } else setSetting("owner_name", null);
    if (kv.vocabulary === "none") db.exec("DELETE FROM vocabulary");
    if (kv.languages === "unset") setSetting("languages", null);
    else if (kv.languages !== "corpus")
      setSetting("languages", kv.languages as string);
    if (kv.attendees === "none")
      db.exec("UPDATE meetings SET calendar_attendees = NULL");
    if (kv.context === "none") db.exec("UPDATE meetings SET context = NULL");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/** The env vars of the env knobs (all of them set, defaults included). */
export function envKnobs(kv: KnobValues): Record<string, string> {
  return Object.fromEntries(
    KNOBS.filter((k) => k.apply === "env").map((k) => [
      k.target,
      kv[k.name] as string,
    ]),
  );
}

/** Run with `env` set in process.env, then restore it. */
async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

export async function runAsrCell(opts: {
  manifest: Manifest;
  ids: string[];
  golds: Map<string, Gold>;
  kv: KnobValues;
  /** The ledger form of the knobs (the owner name as a fingerprint). */
  publicKv: KnobValues;
  ownerName: string | undefined;
  asrDir: string;
  hfCache: string;
  port: number;
  /** Code-side cache key inputs (code hash, diarizer models, revisions). */
  keyParts: string[];
}): Promise<CellResult> {
  const { manifest, ids, kv, asrDir } = opts;
  const run = runName(kv);
  const def = MLX_ASR_MODELS.find((m) => m.id === kv.asr_model);
  if (!def) throw new Error(`asr_model ${kv.asr_model} is not in the catalog`);
  const viaServer = kv.asr_server_model !== "none";
  const voice: VoiceRow = viaServer
    ? {
        provider: "server",
        model_id: serverModelId(LAB_SERVER_ID, kv.asr_server_model as string),
        model_name: kv.asr_server_model as string,
      }
    : {
        provider: "local-mlx",
        model_id: `local-mlx/${def.id}`,
        model_name: def.displayName,
      };
  for (const hf of [
    ...(viaServer ? [] : [def.hfId]),
    ...(kv.diarization === "on" ? [cellModels(kv).aligner] : []),
  ]) {
    const snap = join(
      opts.hfCache,
      "hub",
      `models--${hf.replaceAll("/", "--")}`,
      "snapshots",
    );
    if (!existsSync(snap) || readdirSync(snap).length === 0)
      throw new Error(
        `model ${hf} is not in the HF cache ${opts.hfCache} (the lab does not download)`,
      );
  }
  const env = {
    MEETING_EVAL_ASR_MODEL: def.id,
    MEETING_EVAL_OWNER_NAME: undefined,
    MEETING_EVAL_SOURCE_DB: seedPath(manifest),
    MEETING_EVAL_AUDIO_DIR: manifest.audioRoot,
    SEED_ASR_CONTEXT: undefined,
    ...envKnobs(kv),
  };
  return withEnv(env, async () => {
    privateDir(asrDir);
    const work = await setupScratch(asrDir, ids, opts.port + 2);
    try {
      // The audio that the run uses must be the audio of the manifest.
      for (const id of ids) {
        const m = manifest.meetings.find((x) => x.id === id);
        if (!m)
          throw new Error(`meeting ${id.slice(0, 8)} is not in the corpus`);
        for (const f of AUDIO_FILES) {
          const p = join(work, "meetings", id, f);
          const h = existsSync(p) ? sha256File(p) : null;
          if (h !== m.files[f])
            throw new Error(
              `scratch audio ${m.id8} ${f} differs from the manifest`,
            );
        }
      }
      applyDbKnobs(
        join(work, "test.db"),
        kv,
        opts.ownerName,
        process.env.LAB_ASR_SERVER_URL,
      );
      const keyOf = (id: string) => {
        const m = manifest.meetings.find((x) => x.id === id);
        return [
          "lab=1",
          `knobs=${canonicalJson(opts.publicKv)}`,
          `audio=${canonicalJson(m?.files ?? null)}`,
          ...opts.keyParts,
        ];
      };
      const cacheDir = join(asrDir, "cache");
      const before = new Set(existsSync(cacheDir) ? readdirSync(cacheDir) : []);
      let peak = { worker: 0, tree: 0 };
      const timer = setInterval(() => {
        const r = treeRss();
        peak = {
          worker: Math.max(peak.worker, r.worker),
          tree: Math.max(peak.tree, r.tree),
        };
      }, 2000);
      let t;
      try {
        t = await ensureTranscribed({
          asrDir,
          work,
          ids,
          voice,
          port: opts.port + 3,
          hfCache: opts.hfCache,
          out: join(work, "run.db"),
          hashExtra: keyOf,
          run,
        });
      } finally {
        clearInterval(timer);
      }
      const fresh = ids.filter((id) => !before.has(`${id}.${t.hashes[id]}.db`));
      const cached = ids.filter((id) => !fresh.includes(id));
      // The wall time of each meeting: run.json of a fresh transcription,
      // kept next to the cache file for later cache hits.
      const metaDir = privateDir(join(asrDir, "meta"));
      const asrWall: Record<string, number> = {};
      for (const id of ids) {
        const meta = join(metaDir, `${id}.${t.hashes[id]}.json`);
        const runJson = join(
          work,
          "baseline",
          `${run}-${id.slice(0, 8)}`,
          "run.json",
        );
        if (fresh.includes(id) && existsSync(runJson)) {
          const w = Number(
            JSON.parse(readFileSync(runJson, "utf8")).wallSeconds,
          );
          privateWrite(meta, `${JSON.stringify({ wallSeconds: w })}\n`);
        }
        if (existsSync(meta))
          asrWall[id.slice(0, 8)] = Number(
            JSON.parse(readFileSync(meta, "utf8")).wallSeconds,
          );
      }
      const score = scoreRunDb(t.path, ids, opts.golds);
      for (const m of score.meetings) {
        const w = asrWall[m.m];
        if (w !== undefined) m.metrics.asr_wall_s = w;
      }
      return {
        score,
        cacheKeys: Object.fromEntries(
          ids.map((id) => [id.slice(0, 8), t.hashes[id] as string]),
        ),
        fresh: fresh.map((id) => id.slice(0, 8)),
        cached: cached.map((id) => id.slice(0, 8)),
        asrWall,
        peakRssWorkerMb: fresh.length ? Math.round(peak.worker / 1024) : null,
        peakRssTreeMb: fresh.length ? Math.round(peak.tree / 1024) : null,
      };
    } finally {
      removeScratch(work);
    }
  });
}
