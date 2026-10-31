// stack.mts: boots the real server stack in this process on an isolated
// scratch profile and loads the fictional corpus into it (spec 8.1 rules 2
// and 3). It uses the server's own modules: getDb, the schema, indexMeeting,
// retrieve, the embed worker and the LLM worker. Nothing is mocked. The owner's
// profile, port 4649 and the real DB are never touched.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  HF_CACHE_DEFAULT,
  isCacheDir,
  repoRoot,
  serverEnv,
} from "../meeting-v2/eval/runtime.mts";
import { summaryJson, summaryMarkdown } from "./corpus.mts";
import type { Corpus } from "./types.mts";

export const OUT = join(homedir(), ".openstyle-eval", "chat-p0");
export const sha = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export const HERE = dirname(fileURLToPath(import.meta.url));
export const EMBED_MODEL_ID = "embeddinggemma-2-bf16-text";

/** The server modules the harness uses, imported after the env is set. */
export interface Stack {
  dir: string;
  db: DatabaseSync;
  mod: {
    retrieve: typeof import("../../apps/server/src/lib/search/retrieve.ts").retrieve;
    hitText: typeof import("../../apps/server/src/lib/search/retrieve.ts").hitText;
    indexMeeting: typeof import("../../apps/server/src/lib/search/indexer.ts").indexMeeting;
    buildMeetingChunks: typeof import("../../apps/server/src/lib/search/source.ts").buildMeetingChunks;
    loadMeetingSource: typeof import("../../apps/server/src/lib/search/source.ts").loadMeetingSource;
    stopMlxEmbedWorker: typeof import("../../apps/server/src/lib/mlx-embed/server.ts").stopMlxEmbedWorker;
    ensureMlxEmbedWorker: typeof import("../../apps/server/src/lib/mlx-embed/server.ts").ensureMlxEmbedWorker;
    actionItemKey: typeof import("../../apps/server/src/lib/meetings/folder-overview.ts").actionItemKey;
    writeSetting: typeof import("../../apps/server/src/lib/db.ts").writeSetting;
    searchState: typeof import("../../apps/server/src/lib/search/state.ts").searchState;
  };
}

/** Scratch folders live in /tmp or under the eval home (the guard rules of live-testing). */
export function scratchDir(name: string): string {
  const d = join("/tmp", "chatp0", "run", name);
  if (!isCacheDir(d)) throw new Error(`scratch ${d} is not under /tmp`);
  return d;
}

export async function bootStack(name: string, fresh: boolean): Promise<Stack> {
  const dir = scratchDir(name);
  if (fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = serverEnv(HF_CACHE_DEFAULT, {
    OPENSTYLE_DB_PATH: join(dir, "db.sqlite"),
    HF_HUB_OFFLINE: "1",
  });
  // The real profile must never be the target: refuse a non-scratch DB path.
  if (!String(env.OPENSTYLE_DB_PATH).startsWith("/tmp/"))
    throw new Error("DB path is not in /tmp");
  Object.assign(process.env, env);
  // vec0.dylib resolves from <cwd>/resources/bin (search/extension.ts).
  process.chdir(join(repoRoot, "apps", "electron"));
  const s = (p: string) => import(`../../apps/server/src/lib/${p}`);
  const [dbm, ret, idx, src, emb, fo, st] = await Promise.all([
    s("db.ts"),
    s("search/retrieve.ts"),
    s("search/indexer.ts"),
    s("search/source.ts"),
    s("mlx-embed/server.ts"),
    s("meetings/folder-overview.ts"),
    s("search/state.ts"),
  ]);
  const db = dbm.getDb() as DatabaseSync;
  return {
    dir,
    db,
    mod: {
      retrieve: ret.retrieve,
      hitText: ret.hitText,
      indexMeeting: idx.indexMeeting,
      buildMeetingChunks: src.buildMeetingChunks,
      loadMeetingSource: src.loadMeetingSource,
      stopMlxEmbedWorker: emb.stopMlxEmbedWorker,
      ensureMlxEmbedWorker: emb.ensureMlxEmbedWorker,
      actionItemKey: fo.actionItemKey,
      writeSetting: dbm.writeSetting,
      searchState: st.searchState,
    },
  };
}

/** Insert the corpus rows (no embedding yet). */
export function loadCorpus(stack: Stack, c: Corpus): void {
  const { db } = stack;
  const now = Date.now();
  db.exec("BEGIN");
  try {
    const folder = db.prepare(
      "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const f of c.folders)
      folder.run(f.id, f.name, f.description, now, now);
    const meeting = db.prepare(
      `INSERT INTO meetings (id, title, started_at, ended_at, duration_ms, status, language, folder_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'summarized', ?, ?, ?)`,
    );
    const seg = db.prepare(
      `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status, speaker_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
    );
    const spk = db.prepare(
      "INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, updated_at) VALUES (?, ?, ?, ?)",
    );
    const sum = db.prepare(
      "INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const tag = db.prepare(
      "INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)",
    );
    const mtag = db.prepare(
      "INSERT INTO meeting_tags (meeting_id, tag_id, source, created_at) VALUES (?, ?, 'user', ?)",
    );
    const done = db.prepare(
      "INSERT INTO folder_action_item_state (folder_id, item_key, done, updated_at) VALUES (?, ?, 1, ?)",
    );
    for (const m of c.meetings) {
      const lang = m.lang === "pt" ? "pt" : "en";
      meeting.run(
        m.id,
        m.title,
        m.startedAt,
        m.startedAt + m.durationMs,
        m.durationMs,
        lang,
        m.folderId,
        m.startedAt,
      );
      for (const s of m.segments) {
        seg.run(
          s.id,
          m.id,
          s.source,
          s.idx,
          s.startMs,
          s.endMs,
          s.text,
          s.speakerLabel,
        );
      }
      for (const sp of m.speakers) spk.run(m.id, sp.label, sp.displayName, now);
      sum.run(m.id, summaryMarkdown(m), JSON.stringify(summaryJson(m)), now);
      for (const t of m.tags) {
        tag.run(`tag-${t}`, t, now);
        mtag.run(m.id, `tag-${t}`, now);
      }
      if (m.folderId) {
        for (const a of m.actionItems) {
          if (a.done)
            done.run(m.folderId, stack.mod.actionItemKey(m.id, a.task), now);
        }
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Descendant processes of this node process with their RSS in MB. */
export function workerRss(match: RegExp): { pid: number; rssMb: number }[] {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
  });
  const rows = `${ps.stdout}`
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rss: Number(m[3]),
      cmd: m[4] as string,
    }));
  const mine = new Set<number>([process.pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of rows) {
      if (!mine.has(r.pid) && mine.has(r.ppid)) {
        mine.add(r.pid);
        changed = true;
      }
    }
  }
  return rows
    .filter(
      (r) => mine.has(r.pid) && r.pid !== process.pid && match.test(r.cmd),
    )
    .map((r) => ({ pid: r.pid, rssMb: Math.round(r.rss / 1024) }));
}

/** Samples the RSS of matching child processes every `everyMs` and keeps the peak. */
export class RssSampler {
  peakMb = 0;
  samples: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly match: RegExp;
  private readonly everyMs: number;
  constructor(match: RegExp, everyMs = 5000) {
    this.match = match;
    this.everyMs = everyMs;
  }
  sample(): number {
    const mb = workerRss(this.match).reduce((a, w) => a + w.rssMb, 0);
    if (mb > 0) {
      this.samples.push(mb);
      this.peakMb = Math.max(this.peakMb, mb);
    }
    return mb;
  }
  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.everyMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.sample();
  }
}
