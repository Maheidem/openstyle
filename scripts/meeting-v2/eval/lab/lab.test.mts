// Tests of the Eval Lab with fictional data only: the grid expansion, the
// knobs, the snapshot hash, the ASR cache key inputs, the corpus check,
// the ledger (a fake MLflow REST server), the scores of a run DB with
// verified spans, and the compare logic.
// Run: pnpm meeting:eval:test

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseGold } from "../gold.mts";
import { scoreSpans } from "../score.mts";
import { applyDbKnobs, envKnobs } from "./asr.mts";
import { buildCorpus, checkCorpus, readManifest } from "./corpus.mts";
import { expandGrid, parseGrid } from "./grid.mts";
import { KNOBS, resolveKnobs, runName } from "./knobs.mts";
import {
  diffRun,
  type FlatRun,
  Mlflow,
  readItems,
  writeItems,
} from "./ledger.mts";
import { bestRuns, compareRuns, lowerIsBetter } from "./query.mts";
import { scoreRunDb } from "./score.mts";
import {
  asrCodeParts,
  canonicalJson,
  publicKnobs,
  type Snapshot,
  snapshotHash,
} from "./snapshot.mts";

const tmp = () => mkdtempSync(join(tmpdir(), "lab-test-"));

// --- Grid and knobs ---------------------------------------------------------------

const GRID = {
  name: "g1",
  stage: "asr",
  corpus: "c1",
  base: { vocabulary: "none" },
  grid: { owner_name: ["unset", "env"], diarization: ["on", "off"] },
  cells: [{ asr_model: "qwen3-0.6b-8bit" }, { owner_name: "unset" }],
};

test("grid: cartesian product plus explicit cells over base and defaults", () => {
  const cells = expandGrid(parseGrid(JSON.stringify(GRID)));
  // 2 x 2 product + 1 new explicit cell; {owner_name: unset} equals a product cell.
  assert.equal(cells.length, 5);
  assert.deepEqual(
    cells.map((c) => [c.knobs.owner_name, c.knobs.diarization]),
    [
      ["unset", "on"],
      ["unset", "off"],
      ["env", "on"],
      ["env", "off"],
      ["unset", "on"],
    ],
  );
  assert.equal(cells[4]?.knobs.asr_model, "qwen3-0.6b-8bit");
  for (const c of cells) assert.equal(c.knobs.vocabulary, "none");
  assert.equal(cells[0]?.knobs.languages, "corpus");
  assert.deepEqual(
    cells.map((c) => c.index),
    [1, 2, 3, 4, 5],
  );
});

test("grid: an empty grid is one cell of defaults; bad files fail", () => {
  const one = expandGrid(
    parseGrid(JSON.stringify({ name: "d", stage: "asr", corpus: "c" })),
  );
  assert.equal(one.length, 1);
  assert.deepEqual(
    one[0]?.knobs,
    Object.fromEntries(KNOBS.map((k) => [k.name, k.default])),
  );
  const bad = (g: unknown, re: RegExp) =>
    assert.throws(() => expandGrid(parseGrid(JSON.stringify(g))), re);
  bad({ ...GRID, stage: "enhance" }, /stage/);
  bad({ ...GRID, extra: 1 }, /unknown field/);
  bad({ ...GRID, grid: { nope: ["x"] } }, /unknown knob nope/);
  bad({ ...GRID, grid: { diarization: ["maybe"] } }, /diarization=maybe/);
  bad({ ...GRID, grid: { diarization: [] } }, /non-empty/);
  bad({ ...GRID, meetings: ["not-id8"] }, /id8/);
  bad({ ...GRID, grid: { max_attendee_names: [201] } }, /0 to 200/);
});

test("knobs: values, numbers as strings, run names", () => {
  assert.equal(resolveKnobs({ max_attendee_names: 5 }).max_attendee_names, "5");
  assert.equal(
    resolveKnobs({ languages: ["en", "pt"] }).languages,
    '["en","pt"]',
  );
  assert.throws(() => resolveKnobs({ languages: "en" }), /languages/);
  assert.throws(() => resolveKnobs({ asr_model: "gpt-x" }), /catalog/);
  const rn = (diarization: string, asr_context: string) =>
    runName(resolveKnobs({ diarization, asr_context }));
  assert.equal(rn("on", "off"), "R0d");
  assert.equal(rn("off", "off"), "R0");
  assert.equal(rn("on", "on"), "R7base");
  assert.equal(rn("off", "on"), "R3c-on");
  assert.deepEqual(envKnobs(resolveKnobs({})), {
    OPENSTYLE_ASR_MAX_ATTENDEE_NAMES: "20",
  });
});

// --- Snapshot and cache key -----------------------------------------------------------

const snap = (knobs: Record<string, string>): Snapshot => ({
  stage: "asr",
  knobs,
  runName: "R0d",
  meetings: ["aaaa1111"],
  corpus: { name: "c1", manifestSha256: "m".repeat(64) },
  gold: {
    goldHash: "g".repeat(12),
    goldKinds: ["silver-3.3"],
    verified: 0,
    verifiedUnsure: 0,
  },
  scorerVersion: "s1",
  labVersion: "l1",
  git: {
    sha: "a".repeat(40),
    branch: "feat/x",
    dirty: false,
    diffSha256: "d",
    untrackedSha256: "u",
    untracked: 0,
  },
  codeSha256: "c",
  workerSha256: "w",
  diarizerSha256: "z",
  diarizerModelsSha256: "zm",
  models: {
    asr: "org/asr",
    asrRevision: "r1",
    aligner: "org/al",
    alignerRevision: "r2",
  },
  machine: { chip: "chip", ramGb: 8, macos: "1.0", node: "v0" },
});

test("snapshot hash: stable over key order, changes with any knob", () => {
  const kv = resolveKnobs({});
  const a = snapshotHash(snap(kv));
  const reordered = Object.fromEntries(Object.entries(kv).reverse());
  assert.equal(snapshotHash(snap(reordered)), a);
  assert.equal(
    canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }),
    canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
  );
  for (const k of KNOBS) {
    const other = { ...kv, [k.name]: `${kv[k.name]}x` };
    assert.notEqual(snapshotHash(snap(other)), a, k.name);
  }
  const s = snap(kv);
  assert.notEqual(snapshotHash({ ...s, gold: { ...s.gold, verified: 1 } }), a);
  assert.notEqual(snapshotHash({ ...s, git: { ...s.git, dirty: true } }), a);
});

test("publicKnobs: the owner name becomes a salted fingerprint, never the value", () => {
  const home = tmp();
  const old = process.env.LAB_HOME;
  process.env.LAB_HOME = home;
  try {
    const kv = resolveKnobs({ owner_name: "env" });
    const p = publicKnobs(kv, { owner_name: "Ana Example" });
    assert.match(p.owner_name as string, /^set:[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(p).includes("Ana"));
    assert.equal(
      publicKnobs(kv, { owner_name: "Ana Example" }).owner_name,
      p.owner_name,
    );
    assert.notEqual(
      publicKnobs(kv, { owner_name: "Bo Other" }).owner_name,
      p.owner_name,
    );
    assert.equal(publicKnobs(resolveKnobs({}), {}).owner_name, "unset");
    assert.throws(() => publicKnobs(kv, {}), /needs its value/);
  } finally {
    if (old === undefined) delete process.env.LAB_HOME;
    else process.env.LAB_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
});

test("ASR cache key: the code parts hold the paths that the old key missed", () => {
  const parts = asrCodeParts().map((p) => p.slice(0, p.lastIndexOf(":")));
  for (const dir of [
    "apps/server/src/lib/mlx-asr/",
    "apps/server/src/lib/audio/",
    "apps/server/src/lib/streaming/",
    "apps/server/src/lib/meetings/",
    "packages/stt/src/",
    "packages/validations/src/",
  ])
    assert.ok(
      parts.some((p) => p.startsWith(dir)),
      dir,
    );
  for (const f of [
    "apps/server/src/lib/vocabulary-bias.ts",
    "scripts/mlx_asr_server.py",
    "scripts/meeting-v2/setup-scratch.sh",
    "scripts/meeting-v2/run-baseline.mjs",
  ])
    assert.ok(parts.includes(f), f);
  // Every knob is in the key (the key holds the canonical knob JSON).
  const kv = resolveKnobs({});
  for (const k of KNOBS)
    assert.notEqual(
      canonicalJson({ ...kv, [k.name]: "other" }),
      canonicalJson(kv),
    );
});

test("applyDbKnobs: owner name, vocabulary, languages, attendees, context", () => {
  const dir = tmp();
  try {
    const p = join(dir, "t.db");
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE vocabulary (term TEXT);
      CREATE TABLE meetings (id TEXT, calendar_attendees TEXT, context TEXT);
      INSERT INTO settings VALUES ('languages', '["en"]'), ('owner_name', 'Old');
      INSERT INTO vocabulary VALUES ('Zorblax');
      INSERT INTO meetings VALUES ('m1', '[]', 'ctx');`);
    db.close();
    const read = () => {
      const d = new DatabaseSync(p, { readOnly: true });
      const r = {
        s: d.prepare("SELECT key, value FROM settings ORDER BY key").all(),
        v: (
          d.prepare("SELECT COUNT(*) AS n FROM vocabulary").get() as {
            n: number;
          }
        ).n,
        m: d.prepare("SELECT calendar_attendees, context FROM meetings").get(),
      };
      d.close();
      return JSON.parse(JSON.stringify(r));
    };
    applyDbKnobs(
      p,
      resolveKnobs({ owner_name: "env", languages: ["pt"] }),
      "Ana",
    );
    assert.deepEqual(read().s, [
      { key: "languages", value: '["pt"]' },
      { key: "owner_name", value: "Ana" },
    ]);
    assert.throws(
      () => applyDbKnobs(p, resolveKnobs({ owner_name: "env" }), ""),
      /LAB_OWNER_NAME/,
    );
    applyDbKnobs(
      p,
      resolveKnobs({
        vocabulary: "none",
        languages: "unset",
        attendees: "none",
        context: "none",
      }),
      undefined,
    );
    assert.deepEqual(read(), {
      s: [],
      v: 0,
      m: { calendar_attendees: null, context: null },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Corpus ----------------------------------------------------------------------------

const ID = "abcd1234-0000-4000-8000-000000000001";
const span = (o: Record<string, unknown> = {}) => ({
  channel: "mic",
  startMs: 1000,
  endMs: 2000,
  text: "Zorblax",
  label: "product",
  in_vocab: true,
  confidence: "high",
  witnesses: ["h1"],
  ...o,
});
const goldJson = (spans: unknown[]) =>
  JSON.stringify({
    format: "openstyle-gold",
    meeting: "abcd1234",
    goldVersion: 3,
    goldKind: "silver-3.4",
    asrHash: null,
    builtAt: null,
    verifiedSpans: 0,
    timeToleranceMs: 2000,
    transcript: {
      mic: [
        {
          startMs: 0,
          endMs: 4000,
          text: "We tried Zorblax today.",
          verified: false,
          wer_eligible: true,
        },
      ],
      system: [],
    },
    fixes: [],
    mustNotChange: [],
    spans,
  });

test("corpus: build, check OK, then a changed wav and a changed key fail", () => {
  const home = tmp();
  const old = process.env.LAB_HOME;
  process.env.LAB_HOME = join(home, "lab");
  try {
    const audio = join(home, "audio", ID);
    mkdirSync(audio, { recursive: true });
    writeFileSync(join(audio, "mic.wav"), "fake mic");
    writeFileSync(join(audio, "system.wav"), "fake system");
    const gold = join(home, "gold");
    mkdirSync(gold, { mode: 0o700 });
    writeFileSync(join(gold, "abcd1234.json"), goldJson([span()]));
    const app = join(home, "app.db");
    const db = new DatabaseSync(app);
    db.exec(`CREATE TABLE vocabulary (term TEXT, notes TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE settings (key TEXT, value TEXT, updated_at TEXT);
      CREATE TABLE meetings (id TEXT, title TEXT, context TEXT, calendar_attendees TEXT, started_at INT, ended_at INT, duration_ms INT);
      INSERT INTO vocabulary VALUES ('Zorblax', NULL, NULL, NULL);
      INSERT INTO settings VALUES ('languages', '["en"]', NULL), ('owner_name', 'Secret', NULL);
      INSERT INTO meetings VALUES ('${ID}', 't', NULL, NULL, 0, 1, 1);`);
    db.close();
    const m = buildCorpus({
      name: "c1",
      audioRoot: join(home, "audio"),
      goldDir: gold,
      appDb: app,
    });
    assert.equal(m.meetings[0]?.id, ID);
    assert.equal(m.meetings[0]?.files["sync.json"], null);
    assert.equal(m.seed.vocabulary, 1);
    const seed = new DatabaseSync(
      join(home, "lab", "corpora", "c1", "source.db"),
      { readOnly: true },
    );
    // The owner name is never frozen.
    assert.deepEqual(
      seed
        .prepare("SELECT key FROM settings")
        .all()
        .map((r) => (r as { key: string }).key),
      ["languages"],
    );
    seed.close();
    const ok = (c = readManifest("c1").manifest) =>
      checkCorpus(c)
        .filter((l) => !l.ok)
        .map((l) => l.what);
    assert.deepEqual(ok(), []);
    writeFileSync(join(audio, "mic.wav"), "fake mic changed");
    assert.deepEqual(ok(), ["audio abcd1234 mic.wav"]);
    writeFileSync(join(audio, "mic.wav"), "fake mic");
    // A new version of the live key does not change the frozen corpus.
    writeFileSync(
      join(gold, "abcd1234.json"),
      goldJson([span({ text: "Other" })]),
    );
    assert.deepEqual(ok(), []);
    // A change of the frozen copy fails, and the line names the new hash.
    const frozen = join(m.gold.dir, "abcd1234.json");
    assert.ok(frozen.startsWith(join(home, "lab", "corpora", "c1")));
    assert.equal(statSync(frozen).mode & 0o777, 0o600);
    writeFileSync(frozen, goldJson([span({ text: "Other" })]));
    const bad = ok();
    assert.equal(bad[0], "gold abcd1234");
    assert.match(
      bad[1] as string,
      new RegExp(`^goldHash ${m.gold.goldHash} \\(now [0-9a-f]{12}\\)$`),
    );
    // --gold-suffix freezes a backup version (<id8>.<suffix>.json).
    writeFileSync(
      join(gold, "abcd1234.silver-3.3.json"),
      goldJson([
        span({ verified: true, verified_source: "ear-check:b1:2026-10-29" }),
      ]),
    );
    const m2 = buildCorpus({
      name: "c2",
      audioRoot: join(home, "audio"),
      goldDir: gold,
      goldSuffix: "silver-3.3",
      appDb: app,
    });
    assert.deepEqual(Object.keys(m2.gold.files), ["abcd1234"]);
    assert.deepEqual([m2.gold.verified, m2.gold.verifiedUnsure], [1, 0]);
    assert.notEqual(m2.gold.goldHash, m.gold.goldHash);
    assert.deepEqual(ok(readManifest("c2").manifest), []);
  } finally {
    if (old === undefined) delete process.env.LAB_HOME;
    else process.env.LAB_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Verified spans --------------------------------------------------------------------

test("verified spans: parse, errors name the field only", () => {
  const g = parseGold(
    goldJson([
      span({
        verified: true,
        verified_source: "ear-check:b1:2026-10-29",
        verified_text: "Zorblacks",
      }),
      span({
        verified_unsure: true,
        verified_source: "ear-check:b1:2026-10-29",
      }),
      span(),
    ]),
    "abcd1234",
  );
  assert.deepEqual(
    g.spans?.map((s) => [
      s.verified,
      s.verifiedSource,
      s.verifiedText,
      s.verifiedUnsure,
    ]),
    [
      [true, "ear-check:b1:2026-10-29", "Zorblacks", false],
      [false, "ear-check:b1:2026-10-29", null, true],
      [false, null, null, false],
    ],
  );
  const err = (o: Record<string, unknown>) => {
    try {
      parseGold(goldJson([span(o)]), "abcd1234");
    } catch (e) {
      return (e as Error).message;
    }
    return "no error";
  };
  assert.match(err({ verified: "yes" }), /verified must be/);
  assert.match(
    err({ verified: true, verified_source: "" }),
    /verified_source must be/,
  );
  const secret = err({ verified: true, verified_text: 42 });
  assert.match(secret, /verified_text must be/);
  assert.match(
    err({ verified_unsure: true }),
    /verified or verified_unsure needs verified_source/,
  );
  assert.match(
    err({ verified_text: "Quux" }),
    /verified_text needs verified true/,
  );
  assert.ok(!err({ verified_text: "Quux" }).includes("Quux"));
  assert.match(err({ verified: true }), /needs verified_source/);
  assert.match(
    err({ verified_source: "ear-check:b1:2026-10-29" }),
    /verified_source needs verified or verified_unsure/,
  );
  // verified_text equal to text is a fault (the key must leave it out).
  assert.match(
    err({ verified: true, verified_source: "s", verified_text: "Zorblax" }),
    /must differ from text/,
  );
  assert.match(
    err({ verified: true, verified_unsure: true, verified_source: "x" }),
    /must not both be true/,
  );
});

test("verified spans: high confidence, never skipped, matched on verified_text", () => {
  const g = parseGold(
    goldJson([
      // Unsure confidence, but verified: scored, with the confirmed spelling.
      span({
        confidence: "unsure",
        verified: true,
        verified_source: "s",
        verified_text: "Zorblacks",
      }),
      // Unsure and verified_unsure: still skipped, not verified.
      span({
        startMs: 5000,
        endMs: 6000,
        confidence: "unsure",
        verified_unsure: true,
        verified_source: "s",
      }),
      span({
        startMs: 9000,
        endMs: 9500,
        text: "Quillon",
        confidence: "medium",
      }),
    ]),
    "abcd1234",
  );
  const rows = [
    {
      id: 1,
      source: "mic",
      idx: 0,
      start_ms: 1000,
      end_ms: 2000,
      text: "we tried zorblacks",
      enhanced_text: null,
    },
  ];
  const s = scoreSpans(g.spans ?? [], rows as never, "asr");
  assert.deepEqual([s.all.hits, s.all.n], [1, 2]);
  assert.deepEqual([s.high.hits, s.high.n], [1, 1]);
  assert.deepEqual([s.verified?.hits, s.verified?.n], [1, 1]);
  assert.equal(s.verifiedUnsure, 1);
  assert.equal(s.unsure, 1);
  // The old spelling no longer counts.
  const old = scoreSpans(
    g.spans ?? [],
    [{ ...rows[0], text: "we tried zorblax" }] as never,
    "asr",
  );
  assert.equal(old.verified?.hits, 0);
});

// --- Scores of a run DB --------------------------------------------------------------------

function runDb(dir: string, text: string): string {
  const p = join(dir, "run.db");
  rmSync(p, { force: true });
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE vocabulary (term TEXT);
    CREATE TABLE settings (key TEXT, value TEXT);
    CREATE TABLE meetings (id TEXT, calendar_attendees TEXT);
    CREATE TABLE meeting_segments (id INT, meeting_id TEXT, source TEXT, idx INT, start_ms INT, end_ms INT, text TEXT, enhanced_text TEXT);
    INSERT INTO vocabulary VALUES ('Zorblax'), ('Quux');
    INSERT INTO meetings VALUES ('${ID}', NULL);`);
  db.prepare(
    "INSERT INTO meeting_segments VALUES (1, ?, 'mic', 0, 0, 4000, ?, NULL)",
  ).run(ID, text);
  db.close();
  return p;
}

test("scoreRunDb: spans, WER, possible insertions; no verified rate when n = 0", () => {
  const dir = tmp();
  try {
    const golds = new Map([
      ["abcd1234", parseGold(goldJson([span()]), "abcd1234")],
    ]);
    const r = scoreRunDb(
      runDb(dir, "We tried Zorblax today, Quux."),
      [ID],
      golds,
    );
    assert.equal(r.metrics.spans_all_hits, 1);
    assert.equal(r.metrics.spans_all_n, 1);
    assert.equal(r.metrics.spans_all, 100);
    assert.equal(r.metrics.wer_errors, 1);
    assert.equal(r.metrics.wer_ref, 4);
    assert.equal(r.metrics.wer, 25);
    assert.equal(r.metrics.ins_vocab_occ, 2);
    assert.equal(r.metrics.ins_vocab_unsup, 1);
    assert.equal(r.metrics.possible_insertions, 1);
    assert.equal(r.metrics.spans_verified_n, 0);
    assert.equal(r.metrics.spans_verified_unsure, 0);
    assert.ok(!("spans_verified" in r.metrics));
    assert.ok(!("spans_verified_hits" in r.metrics));
    assert.deepEqual(r.items, [
      {
        m: "abcd1234",
        ch: "mic",
        s: 1000,
        e: 2000,
        l: "product",
        c: "high",
        iv: true,
        hit: true,
      },
    ]);
    // The items hold keys only: no text of the output or the gold.
    assert.ok(!/zorblax|quux|tried/i.test(JSON.stringify(r)));
    const miss = scoreRunDb(runDb(dir, "We tried today."), [ID], golds);
    assert.equal(miss.metrics.spans_all_hits, 0);
    assert.equal(miss.meetings[0]?.metrics.spans_all, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Ledger (fake MLflow REST server) ------------------------------------------------------

function fakeMlflow() {
  const exps = new Map<string, string>();
  const runs = new Map<string, any>();
  let batches = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "", "http://x");
      const p = u.pathname.replace("/api/2.0/mlflow/", "");
      const j = body ? JSON.parse(body) : {};
      const send = (code: number, o: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const kv = (o: Record<string, unknown>) =>
        Object.entries(o).map(([key, value]) => ({ key, value }));
      if (p === "experiments/get-by-name") {
        const id = exps.get(u.searchParams.get("experiment_name") ?? "");
        return id
          ? send(200, { experiment: { experiment_id: id } })
          : send(404, { error_code: "RESOURCE_DOES_NOT_EXIST" });
      }
      if (p === "experiments/create") {
        const id = String(exps.size + 1);
        exps.set(j.name, id);
        return send(200, { experiment_id: id });
      }
      if (p === "runs/create") {
        const id = `run${runs.size + 1}`;
        runs.set(id, {
          info: {
            run_id: id,
            run_name: j.run_name,
            experiment_id: j.experiment_id,
            status: "RUNNING",
            start_time: j.start_time,
          },
          params: {},
          tags: Object.fromEntries(j.tags.map((t: any) => [t.key, t.value])),
          metrics: {},
        });
        return send(200, { run: { info: runs.get(id).info } });
      }
      if (p === "runs/log-batch") {
        batches++;
        const r = runs.get(j.run_id);
        for (const x of j.params) r.params[x.key] = x.value;
        for (const x of j.tags) r.tags[x.key] = x.value;
        for (const x of j.metrics) r.metrics[x.key] = x.value;
        return send(200, {});
      }
      if (p === "runs/update") {
        runs.get(j.run_id).info.status = j.status;
        return send(200, {});
      }
      const view = (r: any) => ({
        info: r.info,
        data: {
          params: kv(r.params),
          tags: kv(r.tags),
          metrics: kv(r.metrics),
        },
      });
      if (p === "runs/get")
        return send(200, { run: view(runs.get(u.searchParams.get("run_id"))) });
      if (p === "runs/search")
        return send(200, {
          runs: [...runs.values()]
            .filter((r) => j.experiment_ids.includes(r.info.experiment_id))
            .map(view),
        });
      send(404, {});
    });
  });
  return { server, runs, batches: () => batches };
}

test("ledger: write, read back, batching, and a diff on a lost value", async () => {
  const f = fakeMlflow();
  await new Promise<void>((ok) => f.server.listen(0, "127.0.0.1", ok));
  const port = (f.server.address() as { port: number }).port;
  try {
    const ml = new Mlflow(`http://127.0.0.1:${port}`);
    assert.equal(await ml.experimentId("openstyle-lab-asr", false), null);
    const exp = (await ml.experimentId("openstyle-lab-asr")) as string;
    assert.equal(await ml.experimentId("openstyle-lab-asr"), exp);
    const id = await ml.createRun(exp, "g-1", { "lab.snapshot_hash": "h1" });
    const metrics: Record<string, number> = { bad: Number.NaN };
    for (let i = 0; i < 250; i++) metrics[`m.k${i}`] = i / 3;
    await ml.logBatch(
      id,
      { owner_name: "unset" },
      { "lab.items_dir": "~/x" },
      metrics,
    );
    assert.equal(f.batches(), 3);
    await ml.endRun(id, "FINISHED");
    const back = await ml.getRun(id);
    const want = {
      params: { owner_name: "unset" },
      tags: { "lab.snapshot_hash": "h1", "lab.items_dir": "~/x" },
      metrics,
      status: "FINISHED",
    };
    assert.deepEqual(diffRun(back, want), []);
    assert.ok(!("bad" in back.metrics));
    // A value that the server dropped is a loud difference.
    delete f.runs.get(id).metrics["m.k7"];
    assert.deepEqual(diffRun(await ml.getRun(id), want), ["metric m.k7"]);
    assert.equal((await ml.searchRuns([exp])).length, 1);
  } finally {
    f.server.close();
  }
});

test("ledger: local items are private files that read back", () => {
  const home = tmp();
  const old = process.env.LAB_HOME;
  process.env.LAB_HOME = home;
  try {
    const dir = writeItems("run1", {
      "items.jsonl": [{ m: "a", hit: true }],
      "snapshot.json": { x: 1 },
    });
    assert.deepEqual(readItems("run1", "items.jsonl"), [{ m: "a", hit: true }]);
    assert.equal(readItems("run1", "none.jsonl"), null);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "items.jsonl")).mode & 0o777, 0o600);
    assert.throws(() => writeItems("../x", {}), /bad run id/);
  } finally {
    if (old === undefined) delete process.env.LAB_HOME;
    else process.env.LAB_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Queries -------------------------------------------------------------------------------

const run = (
  id: string,
  metrics: Record<string, number>,
  tags: Record<string, string> = {},
  params: Record<string, string> = {},
): FlatRun => ({
  id,
  name: id,
  status: "FINISHED",
  start: 0,
  params,
  tags: {
    "lab.gold_hash": "g1",
    "lab.corpus_sha256": "c",
    "lab.scorer_version": "s",
    "lab.meetings": "a,b",
    ...tags,
  },
  metrics,
});

test("best: direction per metric, unfinished and missing runs left out", () => {
  assert.ok(lowerIsBetter("wer"));
  assert.ok(lowerIsBetter("possible_insertions"));
  assert.ok(lowerIsBetter("m.aaaa1111.wer"));
  assert.ok(!lowerIsBetter("spans_all"));
  const rs = [
    run("r1", { spans_all: 80, wer: 10 }),
    run("r2", { spans_all: 82, wer: 12 }),
    run("r3", { wer: 9 }),
    { ...run("r4", { spans_all: 99 }), status: "FAILED" },
  ];
  assert.deepEqual(
    bestRuns(rs, "spans_all", 5).map((r) => r.id),
    ["r2", "r1"],
  );
  assert.deepEqual(
    bestRuns(rs, "wer", 2).map((r) => r.id),
    ["r3", "r1"],
  );
  assert.deepEqual(
    bestRuns(rs, "wer", 1, false).map((r) => r.id),
    ["r2"],
  );
});

test("compare: deltas, meetings better/worse/same, span flips, basis warnings", () => {
  const a = run(
    "A",
    { spans_all: 80, "m.aaaa1111.spans_all_hits": 3 },
    {},
    { owner_name: "unset" },
  );
  const b = run(
    "B",
    { spans_all: 82.5, "m.aaaa1111.spans_all_hits": 4 },
    { "lab.gold_hash": "g2" },
    { owner_name: "set:abc" },
  );
  const it = (s: number, hit: boolean) => ({
    m: "a",
    ch: "mic",
    s,
    e: s + 1,
    l: "person",
    c: "high",
    iv: false,
    hit,
  });
  const ma = [
    { m: "a", metrics: { spans_all_hits: 3 } },
    { m: "b", metrics: { spans_all_hits: 5 } },
    { m: "c", metrics: { spans_all_hits: 2 } },
  ];
  const mb = [
    { m: "a", metrics: { spans_all_hits: 4 } },
    { m: "b", metrics: { spans_all_hits: 5 } },
    { m: "c", metrics: { spans_all_hits: 1 } },
  ];
  const c = compareRuns(
    a,
    b,
    ma,
    mb,
    [it(1, false), it(2, true), it(3, true)],
    [it(1, true), it(2, false), it(3, true), it(9, true)],
  );
  assert.deepEqual(c.warnings, ["WARN lab.gold_hash differs: g1 vs g2"]);
  assert.deepEqual(c.metrics.find((m) => m.key === "spans_all")?.delta, 2.5);
  assert.ok(!c.metrics.some((m) => m.key.startsWith("m.")));
  assert.deepEqual(c.meetings, { better: ["a"], worse: ["c"], same: ["b"] });
  assert.deepEqual(c.flips, { missToHit: 1, hitToMiss: 1, common: 3 });
  assert.deepEqual(c.knobs, [{ key: "owner_name", a: "unset", b: "set:abc" }]);
  // Twin spans (same key) never hide each other: equal lists have no flips.
  const twins = [it(5, true), it(5, false), it(5, true)];
  assert.deepEqual(compareRuns(a, b, null, null, twins, [...twins]).flips, {
    missToHit: 0,
    hitToMiss: 0,
    common: 3,
  });
  assert.deepEqual(
    compareRuns(a, b, null, null, twins, [
      it(5, true),
      it(5, true),
      it(5, true),
    ]).flips,
    { missToHit: 1, hitToMiss: 0, common: 3 },
  );
  // Without local items: meetings from the m.* metrics, no flips.
  const d = compareRuns(a, b, null, null, null, null);
  assert.deepEqual(d.meetings.better, ["aaaa1111"]);
  assert.equal(d.flips, null);
  assert.deepEqual(compareRuns(a, a, ma, ma, null, null).warnings, []);
});
