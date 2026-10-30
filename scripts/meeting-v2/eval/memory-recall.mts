// memory-recall.mts: Recall@10 of the folder retrieval on the real meetings
// (issue #370, part b). Numbers and id8 only; no meeting text.
//
// Usage (repo root):
//   node --import ./scripts/meeting-v2/ts-register.mjs \
//     scripts/meeting-v2/eval/memory-recall.mts [--out <file.json>] [--hf-cache <dir>]
//
// Labels: the app's own folder assignments. For a filed meeting with at
// least one earlier meeting in its folder, the relevant meetings are the
// earlier meetings of that folder ("earlier" = the rule of
// folderMeetingsByTime in workflow/folder-memory.ts).
//
// Retrieval: the same code path as project memory (search/retrieve.ts,
// meeting query, k = FOLDER_MEMORY_RETRIEVE_K, the meeting itself and all
// later meetings excluded, only the kinds summary and transcript), with the
// scope widened to ALL meetings. The chunks become meetings in rank order
// (first hit of a meeting sets its rank). Recall@10, MRR and the base rate
// (relevant / candidates) are per query; the pooled values are the mean over
// queries. A second pass with k = 50 shows the effect of the small k.
// For the real folder-scoped call: how many distinct earlier meetings the
// chunks cover.
//
// Read only: the real DB is copied with `sqlite3 -readonly .backup` and the
// copy is used (the server code may migrate it). The copy is deleted at the
// end. The GPU lock is held during the retrieval (a query of a meeting that
// is not indexed starts the embedding worker).

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import type { DatabaseSync } from "node:sqlite";
import { rankMeetings, rankMetrics, TOP } from "./memory-recall-metrics.mts";
import {
  EVAL_HOME,
  HF_CACHE_DEFAULT,
  isCacheDir,
  REAL_DB,
  ROOT,
  releaseLock,
  repoRoot,
  serverEnv,
  takeLock,
  unqueue,
} from "./runtime.mts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const hfCache = resolve(arg("hf-cache") ?? HF_CACHE_DEFAULT);
const outPath = resolve(arg("out") ?? join(ROOT, "memeval", "recall.json"));
if (!isCacheDir(outPath) || !isCacheDir(hfCache)) {
  console.error(`--out and --hf-cache must be under /tmp or ${EVAL_HOME}`);
  process.exit(2);
}

const KS = [12, 50];
const MEMORY_KINDS = new Set(["summary", "transcript"]);

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

async function main(): Promise<void> {
  const work = join(ROOT, "memeval");
  mkdirSync(work, { recursive: true });
  const copy = join(work, "recall-copy.db");
  for (const f of [copy, `${copy}-wal`, `${copy}-shm`])
    rmSync(f, { force: true });
  const b = spawnSync("sqlite3", ["-readonly", REAL_DB, `.backup '${copy}'`]);
  if (b.status !== 0)
    throw new Error("cannot back up the real DB (sqlite3 -readonly)");

  // The server code reads these when it loads (db.ts, search/state.ts).
  Object.assign(process.env, serverEnv(hfCache, { OPENSTYLE_DB_PATH: copy }));
  process.chdir(join(repoRoot, "apps", "electron"));
  const { getDb } = await import("../../../apps/server/src/lib/db.ts");
  const { retrieve } = await import(
    "../../../apps/server/src/lib/search/retrieve.ts"
  );
  const { searchState } = await import(
    "../../../apps/server/src/lib/search/state.ts"
  );
  const { FOLDER_MEMORY_RETRIEVE_K } = await import(
    "../../../apps/server/src/lib/meetings/workflow/folder-memory.ts"
  );

  const db: DatabaseSync = getDb();
  const st = searchState();
  if (st.state !== "on") throw new Error(`search is off (${st.reason})`);
  console.log(`search on: ${st.modelId}; app k = ${FOLDER_MEMORY_RETRIEVE_K}`);

  const meetings = db
    .prepare(
      "SELECT id, folder_id, COALESCE(started_at, created_at) AS at FROM meetings WHERE status NOT IN ('recording', 'transcribing') ORDER BY id",
    )
    .all() as { id: string; folder_id: string | null; at: number | null }[];
  const indexed = new Set(
    (
      db
        .prepare(
          "SELECT DISTINCT meeting_id FROM meeting_chunks WHERE model_id = ? AND kind IN ('summary', 'transcript')",
        )
        .all(st.modelId) as { meeting_id: string }[]
    ).map((r) => r.meeting_id),
  );
  const split = (self: { id: string; at: number | null }) => {
    const earlier: string[] = [];
    const later: string[] = [];
    for (const o of meetings) {
      if (o.id === self.id) continue;
      if (self.at !== null && o.at !== null && o.at > self.at) later.push(o.id);
      else earlier.push(o.id);
    }
    return { earlier, later };
  };

  const queries = meetings.filter((m) => {
    if (!m.folder_id || !indexed.has(m.id)) return false;
    const { earlier } = split(m);
    return earlier.some(
      (e) =>
        meetings.find((x) => x.id === e)?.folder_id === m.folder_id &&
        indexed.has(e),
    );
  });
  console.log(
    `meetings ${meetings.length}, filed ${meetings.filter((m) => m.folder_id).length}, queries ${queries.length}`,
  );

  await takeLock("memory-recall", 10);
  const rows: Record<string, unknown>[] = [];
  try {
    for (const q of queries) {
      const { earlier, later } = split(q);
      const relevant = new Set(
        earlier.filter(
          (e) =>
            meetings.find((x) => x.id === e)?.folder_id === q.folder_id &&
            indexed.has(e),
        ),
      );
      const candidates = earlier.filter((e) => indexed.has(e)).length;
      const row: Record<string, unknown> = {
        meeting: q.id.slice(0, 8),
        relevant: relevant.size,
        candidates,
      };
      for (const k of KS) {
        const res = await retrieve({
          query: { kind: "meeting", meetingId: q.id },
          scope: { kind: "all" },
          k,
          excludeMeetingIds: [q.id, ...later],
        });
        if (res.status !== "ok")
          throw new Error(`retrieve (all) ${res.status}`);
        const ranked = rankMeetings(
          res.hits.filter((h) => MEMORY_KINDS.has(h.kind)),
        );
        const m = rankMetrics(ranked, relevant, candidates);
        row[`all_k${k}`] = {
          recall10: r4(m.recall),
          rr: r4(m.rr),
          baseRate: r4(m.baseRate),
          distinctMeetings: m.listed,
        };
      }
      // The real call of the app: the folder scope, k as in the app.
      const real = await retrieve({
        query: { kind: "meeting", meetingId: q.id },
        scope: { kind: "folder", folderId: q.folder_id as string },
        k: FOLDER_MEMORY_RETRIEVE_K,
        excludeMeetingIds: [q.id, ...later],
      });
      if (real.status !== "ok")
        throw new Error(`retrieve (folder) ${real.status}`);
      const used = real.hits.filter((h) => MEMORY_KINDS.has(h.kind));
      row.folderScoped = {
        chunks: real.hits.length,
        usedChunks: used.length,
        distinctEarlierMeetings: new Set(used.map((h) => h.meetingId)).size,
        earlierInFolder: relevant.size,
      };
      rows.push(row);
    }
  } finally {
    releaseLock();
    unqueue();
  }

  const pool = (k: number) => {
    const g = (f: string) =>
      rows.map((r) => (r[`all_k${k}`] as Record<string, number>)[f] as number);
    return {
      k,
      recall10: r4(mean(g("recall10"))),
      mrr: r4(mean(g("rr"))),
      baseRate: r4(
        mean(
          rows.map((r) => (r.relevant as number) / (r.candidates as number)),
        ),
      ),
      distinctMeetings: r4(mean(g("distinctMeetings"))),
    };
  };
  const cover = rows.map((r) => r.folderScoped as Record<string, number>);
  const out = {
    createdAt: new Date().toISOString(),
    appK: FOLDER_MEMORY_RETRIEVE_K,
    top: TOP,
    queries: rows.length,
    pooled: KS.map(pool),
    folderScoped: {
      meanDistinctEarlierMeetings: r4(
        mean(cover.map((c) => c.distinctEarlierMeetings)),
      ),
      meanEarlierInFolder: r4(mean(cover.map((c) => c.earlierInFolder))),
      meanCoverage: r4(
        mean(cover.map((c) => c.distinctEarlierMeetings / c.earlierInFolder)),
      ),
      meanUsedChunks: r4(mean(cover.map((c) => c.usedChunks))),
    },
    rows,
  };
  writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify({ ...out, rows: undefined }, null, 1));
  console.log(`per-query numbers: ${outPath}`);
  for (const f of [copy, `${copy}-wal`, `${copy}-shm`])
    rmSync(f, { force: true });
}

main().then(
  () => process.exit(0),
  (e) => {
    releaseLock();
    unqueue();
    console.error(`memory-recall failed: ${(e as Error).message}`);
    process.exit(1);
  },
);
