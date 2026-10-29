// lab.mts: the Eval Lab CLI (`pnpm lab <command>`). Phase 2: meeting ASR.
//
//   pnpm lab knobs
//   pnpm lab corpus build <name> [--gold-dir <dir>] [--audio-dir <dir>] [--meetings <id8,...>]
//   pnpm lab corpus check <name> [--meetings <id8,...>]
//   pnpm lab run <grid.json> [--force] [--dry-run] [--port <n>]
//   pnpm lab list [--stage asr] [--filter knob=value ...] [--metrics m,...]
//   pnpm lab best --metric <m> [--top N] [--asc | --desc] [--filter knob=value ...]
//   pnpm lab compare <runA> <runB>
//   pnpm lab show <run>
//
// The ledger is MLflow (LAB_MLFLOW_URI or SILVER_MLFLOW_URI; no default)
// plus the private items in <lab home>/runs/<run id>/. The owner name of
// the owner_name=env knob comes from LAB_OWNER_NAME only. The console
// prints ids, knob values, hashes and numbers, never meeting text.
// Read .claude/skills/eval-lab/SKILL.md first.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { loadGold } from "../gold.mts";
import {
  checkBuild,
  EVAL_HOME,
  HF_CACHE_DEFAULT,
  removeAllScratch,
  repoRoot,
} from "../runtime.mts";
import { cellModels, runAsrCell } from "./asr.mts";
import {
  buildCorpus,
  checkCorpus,
  labHome,
  readManifest,
  sha256,
} from "./corpus.mts";
import { expandGrid, parseGrid } from "./grid.mts";
import { KNOBS, NOT_KNOBS, runName } from "./knobs.mts";
import {
  diffRun,
  experimentName,
  type FlatRun,
  Mlflow,
  mlflowUri,
  readItems,
  runDir,
  writeItems,
} from "./ledger.mts";
import {
  bestRuns,
  compareRuns,
  listTable,
  parseFilters,
  renderComparison,
  table,
} from "./query.mts";
import {
  MEETING_LEDGER_METRICS,
  type MeetingScore,
  type SpanItem,
} from "./score.mts";
import {
  codeFields,
  hfRevision,
  publicKnobs,
  type Snapshot,
  snapshotHash,
  treeParts,
} from "./snapshot.mts";

const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const args = (n: string) =>
  argv.flatMap((a, i) =>
    a === `--${n}` && argv[i + 1] ? [argv[i + 1] as string] : [],
  );
const positional = argv.filter(
  (a, i) =>
    !a.startsWith("--") &&
    !(
      i > 0 &&
      /^--(gold-dir|audio-dir|meetings|port|stage|filter|metrics|metric|top)$/.test(
        argv[i - 1] as string,
      )
    ),
);

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error(
    readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .slice(2, 10)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n"),
  );
  process.exit(2);
}

const ownerSecret = () =>
  process.env.LAB_OWNER_NAME?.trim() ||
  process.env.MEETING_EVAL_OWNER_NAME?.trim() ||
  undefined;

const fmt = (v: number | undefined) =>
  v === undefined || !Number.isFinite(v) ? "-" : String(v);

// --- knobs -------------------------------------------------------------------------

function cmdKnobs() {
  console.log(
    table(
      ["knob", "applied as", "target", "default", "values"],
      KNOBS.map((k) => [
        k.name,
        k.apply,
        k.target,
        k.default,
        k.values.replaceAll(" | ", " / "),
      ]),
    ),
  );
  console.log("\nNot a knob yet (a constant in the code):");
  console.log(
    table(
      ["input", "where"],
      NOT_KNOBS.map((k) => [k.name, k.where]),
    ),
  );
}

// --- corpus ------------------------------------------------------------------------

function cmdCorpus() {
  const [, sub, name] = positional;
  if (!name) usage("corpus needs build|check <name>");
  const only = arg("meetings")?.split(",").filter(Boolean);
  if (sub === "build") {
    const m = buildCorpus({
      name,
      audioRoot: resolve(arg("audio-dir") ?? join(EVAL_HOME, "audio")),
      goldDir: resolve(
        arg("gold-dir") ?? join(homedir(), ".openstyle-eval", "gold-silver"),
      ),
      appDb: join(
        homedir(),
        "Library",
        "Application Support",
        "Openstyle",
        "freestyle.db",
      ),
      id8s: only,
    });
    console.log(
      `corpus ${name}: ${m.meetings.length} meetings, ${m.seed.vocabulary} vocabulary rows, goldHash ${m.gold.goldHash}, goldKinds ${m.gold.goldKinds.join(",")}`,
    );
  } else if (sub !== "check") usage("corpus needs build|check <name>");
  const { manifest, hash } = readManifest(name);
  const lines = checkCorpus(manifest, only);
  for (const l of lines) console.log(`${l.ok ? "OK  " : "FAIL"} ${l.what}`);
  const bad = lines.filter((l) => !l.ok).length;
  console.log(
    `corpus ${name}: manifest sha256 ${hash.slice(0, 16)}; ${lines.length - bad}/${lines.length} OK`,
  );
  if (bad > 0) process.exit(1);
}

// --- run ---------------------------------------------------------------------------

/** The ASR cache key parts of the lab: the input-shaping lab files, the models. */
function labKeyParts(code: ReturnType<typeof codeFields>): string[] {
  const lab = join(repoRoot, "scripts", "meeting-v2", "eval", "lab");
  return [
    `code=${code.codeSha256}`,
    `diarizerModels=${code.diarizerModelsSha256}`,
    `lab=${sha256(
      treeParts(lab)
        .filter((p) => /\/(asr|knobs|corpus)\.mts:/.test(p))
        .join("\n"),
    )}`,
  ];
}

/** The server build must be newer than the workspace packages it bundles. */
function checkPackagesBuild() {
  const dist = join(repoRoot, "apps", "server", "dist", "index.js");
  const t = statSync(dist).mtimeMs;
  for (const p of ["stt", "utils", "validations", "sdk"]) {
    const dir = join(repoRoot, "packages", p, "src");
    if (!existsSync(dir)) continue;
    for (const f of treeParts(dir)) {
      const path = join(repoRoot, f.slice(0, f.lastIndexOf(":")));
      if (statSync(path).mtimeMs > t)
        throw new Error(
          `the server build is older than packages/${p}/src (pnpm turbo build --filter=@openstyle/server)`,
        );
    }
  }
}

async function cmdRun() {
  const file = positional[1];
  if (!file) usage("run needs a grid file");
  const grid = parseGrid(readFileSync(file, "utf8"));
  const cells = expandGrid(grid);
  const { manifest, hash: manifestHash } = readManifest(grid.corpus);
  const ids = (grid.meetings ?? manifest.meetings.map((m) => m.id8)).map(
    (k) => {
      const m = manifest.meetings.find((x) => x.id8 === k);
      if (!m) throw new Error(`meeting ${k} is not in corpus ${grid.corpus}`);
      return m.id;
    },
  );
  const id8s = ids.map((id) => id.slice(0, 8));
  console.log(
    `grid ${grid.name}: ${cells.length} cells, ${ids.length} meetings, corpus ${grid.corpus}`,
  );
  const bad = checkCorpus(manifest, id8s).filter((l) => !l.ok);
  if (bad.length > 0)
    throw new Error(
      `corpus check failed: ${bad.map((l) => l.what).join("; ")}`,
    );
  checkBuild();
  checkPackagesBuild();
  const golds = loadGold(id8s, manifest.gold.dir);
  const spans = [...golds.values()].flatMap((g) => g.spans ?? []);
  const goldInfo = {
    goldHash: manifest.gold.goldHash,
    goldKinds: manifest.gold.goldKinds,
    verified: spans.filter((s) => s.verified).length,
    verifiedUnsure: spans.filter((s) => s.verifiedUnsure).length,
  };
  const code = codeFields();
  const keyParts = labKeyParts(code);
  const hfCache = HF_CACHE_DEFAULT;
  const owner = ownerSecret();
  const dry = has("dry-run");
  const ml = dry ? null : new Mlflow(mlflowUri());
  const expId = ml ? await ml.experimentId(experimentName("asr")) : null;
  const done = ml && expId ? await ml.searchRuns([expId]) : [];
  const port = Number(arg("port") ?? "4851");
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    (port <= 4649 && port + 3 >= 4649)
  )
    usage("--port must be a free port base (never near 4649)");
  let failed = 0;
  for (const cell of cells) {
    const publicKv = publicKnobs(cell.knobs, { owner_name: owner });
    const models = cellModels(cell.knobs);
    const snap: Snapshot = {
      stage: "asr",
      knobs: publicKv,
      runName: runName(cell.knobs),
      meetings: id8s,
      corpus: { name: grid.corpus, manifestSha256: manifestHash },
      gold: goldInfo,
      ...code,
      models: {
        asr: models.asr,
        asrRevision: hfRevision(hfCache, models.asr),
        aligner: models.aligner,
        alignerRevision: hfRevision(hfCache, models.aligner),
      },
    };
    const sh = snapshotHash(snap);
    const prior = done.find(
      (r) => r.status === "FINISHED" && r.tags["lab.snapshot_hash"] === sh,
    );
    const label = `cell ${cell.index}/${cells.length} ${JSON.stringify(cell.set)} snapshot ${sh.slice(0, 12)}`;
    if (prior && !has("force")) {
      console.log(`${label}: SKIP (run ${prior.id} has this snapshot)`);
      continue;
    }
    if (dry || !ml || !expId) {
      console.log(`${label}: would run`);
      continue;
    }
    const startedAt = new Date().toISOString();
    const tags: Record<string, string> = {
      "lab.stage": "asr",
      "lab.snapshot_hash": sh,
      "lab.grid": grid.name,
      "lab.cell": String(cell.index),
      "lab.run_name": snap.runName,
      "lab.corpus": grid.corpus,
      "lab.corpus_sha256": manifestHash,
      "lab.meetings": id8s.join(","),
      "lab.gold_hash": goldInfo.goldHash,
      "lab.gold_kinds": goldInfo.goldKinds.join(","),
      "lab.gold_verified": String(goldInfo.verified),
      "lab.gold_verified_unsure": String(goldInfo.verifiedUnsure),
      "lab.scorer_version": code.scorerVersion,
      "lab.lab_version": code.labVersion,
      "lab.git_sha": code.git.sha,
      "lab.git_branch": code.git.branch,
      "lab.git_dirty": String(code.git.dirty),
      "lab.git_diff_sha256": code.git.diffSha256,
      "lab.git_untracked_sha256": code.git.untrackedSha256,
      "lab.code_sha256": code.codeSha256,
      "lab.worker_sha256": code.workerSha256,
      "lab.diarizer_sha256": code.diarizerSha256,
      "lab.diarizer_models_sha256": code.diarizerModelsSha256,
      "lab.asr_model": snap.models.asr,
      "lab.asr_revision": snap.models.asrRevision ?? "-",
      "lab.aligner": snap.models.aligner,
      "lab.aligner_revision": snap.models.alignerRevision ?? "-",
      "lab.machine_chip": code.machine.chip,
      "lab.machine_ram_gb": String(code.machine.ramGb),
      "lab.macos": code.machine.macos,
      "lab.node": code.machine.node,
      "lab.started_at": startedAt,
    };
    const runId = await ml.createRun(
      expId,
      `${grid.name}-${cell.index}-${sh.slice(0, 8)}`,
      tags,
    );
    console.log(`${label}: run ${runId}`);
    const t0 = performance.now();
    try {
      const r = await runAsrCell({
        manifest,
        ids,
        golds,
        kv: cell.knobs,
        publicKv,
        ownerName: owner,
        asrDir: join(labHome(), "asr"),
        hfCache,
        port,
        keyParts,
      });
      const wall = Math.round((performance.now() - t0) / 10) / 100;
      const metrics: Record<string, number> = {
        ...r.score.metrics,
        cell_wall_s: wall,
        asr_fresh_meetings: r.fresh.length,
        asr_cached_meetings: r.cached.length,
      };
      const walls = Object.values(r.asrWall);
      if (walls.length === ids.length)
        metrics.asr_wall_s =
          Math.round(walls.reduce((a, x) => a + x, 0) * 100) / 100;
      if (r.peakRssWorkerMb !== null)
        metrics.peak_rss_worker_mb = r.peakRssWorkerMb;
      if (r.peakRssTreeMb !== null) metrics.peak_rss_tree_mb = r.peakRssTreeMb;
      for (const m of r.score.meetings)
        for (const k of MEETING_LEDGER_METRICS) {
          const v = m.metrics[k];
          if (v !== undefined && Number.isFinite(v))
            metrics[`m.${m.m}.${k}`] = v;
        }
      const endedAt = new Date().toISOString();
      const dir = writeItems(runId, {
        "snapshot.json": {
          snapshot: snap,
          snapshot_hash: sh,
          started_at: startedAt,
          ended_at: endedAt,
          asr_cache_keys: r.cacheKeys,
          asr_fresh: r.fresh,
          asr_cached: r.cached,
        },
        "items.jsonl": r.score.items,
        "meetings.jsonl": r.score.meetings,
      });
      const endTags = {
        "lab.ended_at": endedAt,
        "lab.items_dir": dir.replace(homedir(), "~"),
      };
      await ml.logBatch(runId, publicKv, endTags, metrics);
      await ml.endRun(runId, "FINISHED");
      // The ledger counts only after the read-back.
      const back = await ml.getRun(runId);
      const diff = diffRun(back, {
        params: publicKv,
        tags: { ...tags, ...endTags },
        metrics,
        status: "FINISHED",
      });
      if (diff.length > 0)
        throw new Error(
          `read-back of run ${runId} differs: ${diff.slice(0, 10).join(", ")}`,
        );
      const m = r.score.metrics;
      console.log(
        `${label}: READ BACK OK (${Object.keys(back.params).length} params, ${Object.keys(back.tags).length} tags, ${Object.keys(back.metrics).length} metrics); spans_all ${fmt(m.spans_all)} (${m.spans_all_hits}/${m.spans_all_n}) wer ${fmt(m.wer)} wer_eligible ${fmt(m.wer_eligible)} possible_insertions ${m.possible_insertions} fresh ${r.fresh.length} cached ${r.cached.length} wall ${wall}s`,
      );
    } catch (e) {
      failed++;
      await ml.endRun(runId, "FAILED").catch(() => {});
      console.error(`${label}: FAILED: ${(e as Error).message}`);
      break;
    }
  }
  if (failed > 0) process.exit(1);
}

// --- queries -------------------------------------------------------------------------

async function allRuns(): Promise<{ ml: Mlflow; runs: FlatRun[] }> {
  const ml = new Mlflow(mlflowUri());
  const stage = arg("stage") ?? "asr";
  const id = await ml.experimentId(experimentName(stage), false);
  if (!id) throw new Error(`no experiment ${experimentName(stage)} yet`);
  return { ml, runs: await ml.searchRuns([id]) };
}

async function findRun(runs: FlatRun[], key: string): Promise<FlatRun> {
  const m = runs.filter((r) => r.id.startsWith(key));
  if (m.length !== 1) throw new Error(`run ${key}: ${m.length} matches`);
  return m[0] as FlatRun;
}

async function cmdList() {
  const { runs } = await allRuns();
  const sel = parseFilters(args("filter"));
  const rows = runs.filter((r) => sel.every(([k, v]) => r.params[k] === v));
  const metrics = (
    arg("metrics") ??
    "spans_all,spans_person,wer,possible_insertions,cell_wall_s"
  ).split(",");
  console.log(listTable(rows, metrics));
  console.log(`${rows.length} runs`);
}

async function cmdBest() {
  const metric = arg("metric");
  if (!metric) usage("best needs --metric <name>");
  const { runs } = await allRuns();
  const sel = parseFilters(args("filter"));
  const top = Number(arg("top") ?? "5");
  const best = bestRuns(
    runs.filter((r) => sel.every(([k, v]) => r.params[k] === v)),
    metric,
    top,
    has("asc") ? true : has("desc") ? false : undefined,
  );
  console.log(
    table(
      ["rank", "run", metric, ...KNOBS.map((k) => k.name), "gold", "meetings"],
      best.map((r, i) => [
        String(i + 1),
        r.id.slice(0, 12),
        fmt(r.metrics[metric]),
        ...KNOBS.map((k) => r.params[k.name] ?? "-"),
        r.tags["lab.gold_hash"] ?? "-",
        String(
          (r.tags["lab.meetings"] ?? "").split(",").filter(Boolean).length,
        ),
      ]),
    ),
  );
  const golds = new Set(best.map((r) => r.tags["lab.gold_hash"]));
  const sets = new Set(best.map((r) => r.tags["lab.meetings"]));
  if (golds.size > 1 || sets.size > 1)
    console.log(
      "WARN the runs differ in gold or meetings; compare within one basis (--filter)",
    );
}

async function cmdCompare() {
  const [, ka, kb] = positional;
  if (!ka || !kb) usage("compare needs <runA> <runB>");
  const { runs } = await allRuns();
  const a = await findRun(runs, ka);
  const b = await findRun(runs, kb);
  const c = compareRuns(
    a,
    b,
    readItems<MeetingScore>(a.id, "meetings.jsonl"),
    readItems<MeetingScore>(b.id, "meetings.jsonl"),
    readItems<SpanItem>(a.id, "items.jsonl"),
    readItems<SpanItem>(b.id, "items.jsonl"),
  );
  console.log(renderComparison(c, a, b));
}

async function cmdShow() {
  const key = positional[1];
  if (!key) usage("show needs <run>");
  const { runs } = await allRuns();
  const r = await findRun(runs, key);
  console.log(`run ${r.id} ${r.name} ${r.status}`);
  console.log(table(["knob", "value"], Object.entries(r.params).sort()));
  console.log("");
  console.log(
    table(
      ["tag", "value"],
      Object.entries(r.tags)
        .filter(([k]) => k.startsWith("lab."))
        .sort(),
    ),
  );
  console.log("");
  console.log(
    table(
      ["metric", "value"],
      Object.entries(r.metrics)
        .filter(([k]) => !k.startsWith("m."))
        .sort()
        .map(([k, v]) => [k, fmt(v)]),
    ),
  );
  const items = readItems<SpanItem>(r.id, "items.jsonl");
  console.log(
    items
      ? `local items: ${runDir(r.id).replace(homedir(), "~")} (${items.length} spans, ${items.filter((x) => x.hit).length} hits)`
      : "local items: none on this machine",
  );
}

// --- main ----------------------------------------------------------------------------

const cmd = positional[0];
try {
  if (cmd === "knobs") cmdKnobs();
  else if (cmd === "corpus") cmdCorpus();
  else if (cmd === "run") await cmdRun();
  else if (cmd === "list") await cmdList();
  else if (cmd === "best") await cmdBest();
  else if (cmd === "compare") await cmdCompare();
  else if (cmd === "show") await cmdShow();
  else usage();
} catch (e) {
  removeAllScratch();
  console.error(`lab: ${(e as Error).message}`);
  process.exit(1);
}
