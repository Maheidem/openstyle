// corpus.mts: the private corpus of the Eval Lab.
//
// A corpus is a manifest (<lab home>/corpora/<name>.json) plus a frozen
// seed DB (<lab home>/corpora/<name>/source.db). The manifest holds the
// meeting ids, the paths of the private audio copies, the sha256 of each
// wav and sync.json, the gold folder with the sha256 of each key file, the
// goldKind values and the goldHash. The seed DB holds the rows that
// setup-scratch.sh copies (vocabulary, the languages setting, the meetings
// rows), so a later change of the app DB does not change a run.
//
// Everything here is private (folders 0700, files 0600) and lives outside
// the repo. Messages print ids, counts and hashes only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { goldInfo, loadGold } from "../gold.mts";
import { repoRoot } from "../runtime.mts";

/** The lab home: LAB_HOME, else ~/.openstyle-eval/lab. Never in the repo. */
export function labHome(): string {
  const h = resolve(
    process.env.LAB_HOME || join(homedir(), ".openstyle-eval", "lab"),
  );
  const real = (p: string) =>
    existsSync(p) ? realpathSync(p).toLowerCase() : p.toLowerCase();
  if (`${real(h)}/`.startsWith(`${real(repoRoot)}/`))
    throw new Error("LAB_HOME points into the repo: it holds private data");
  return h;
}

/** Make a private folder (0700) and its missing parents. */
export function privateDir(p: string): string {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  chmodSync(p, 0o700);
  return p;
}

/** Write a private file (0600). */
export function privateWrite(p: string, data: string): void {
  writeFileSync(p, data, { mode: 0o600 });
  chmodSync(p, 0o600);
}

/** The sha256 (hex) of a file, read in 8 MB blocks. */
export function sha256File(path: string): string {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(8 << 20);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

export const sha256 = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");

export const AUDIO_FILES = ["mic.wav", "system.wav", "sync.json"] as const;

export interface CorpusMeeting {
  id: string;
  id8: string;
  /** sha256 of each audio file; null when the file is absent. */
  files: Record<(typeof AUDIO_FILES)[number], string | null>;
  bytes: Record<(typeof AUDIO_FILES)[number], number | null>;
}

export interface Manifest {
  version: 1;
  name: string;
  createdAt: string;
  /** The folder of the private audio copies: <audioRoot>/<meeting id>/. */
  audioRoot: string;
  meetings: CorpusMeeting[];
  seed: {
    /** The frozen seed DB, relative to the corpora folder. */
    path: string;
    /** sha256 of the canonical JSON of its rows (seedContentHash). */
    contentSha256: string;
    vocabulary: number;
  };
  gold: {
    dir: string;
    goldKinds: string[];
    goldHash: string;
    /** sha256 of each key file, by id8. */
    files: Record<string, string>;
  };
}

export const corporaDir = () => join(labHome(), "corpora");
export const manifestPath = (name: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(name))
    throw new Error(`bad corpus name ${name}`);
  return join(corporaDir(), `${name}.json`);
};

/** The rows of a seed DB in a fixed order, as one JSON text. */
export function seedContent(dbPath: string): {
  json: string;
  vocabulary: number;
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all();
    const vocabulary = all(
      "SELECT term, notes FROM vocabulary ORDER BY term, notes",
    );
    const json = JSON.stringify({
      vocabulary,
      settings: all("SELECT key, value FROM settings ORDER BY key"),
      meetings: all(
        "SELECT id, title, context, calendar_attendees, started_at, ended_at, duration_ms FROM meetings ORDER BY id",
      ),
    });
    return { json, vocabulary: vocabulary.length };
  } finally {
    db.close();
  }
}

/**
 * Freeze the seed rows of `ids` from `appDb` into `out`: the vocabulary,
 * the languages setting and the meetings rows. Never the owner name (the
 * owner_name knob sets it), never API keys or own-server rows.
 */
export function freezeSeed(appDb: string, ids: string[], out: string): void {
  rmSync(out, { force: true });
  const copy = `${out}.copy`;
  rmSync(copy, { force: true });
  const b = spawnSync("sqlite3", ["-readonly", appDb, `.backup '${copy}'`]);
  if (b.status !== 0) throw new Error("cannot back up the app DB (sqlite3)");
  const db = new DatabaseSync(out);
  try {
    db.exec(`ATTACH DATABASE '${copy}' AS src`);
    db.exec(`
      CREATE TABLE vocabulary AS SELECT term, notes, created_at, updated_at FROM src.vocabulary;
      CREATE TABLE settings AS SELECT key, value, updated_at FROM src.settings WHERE key = 'languages';
      CREATE TABLE model_configs (provider TEXT, model_id TEXT, model_name TEXT, type TEXT, is_default INTEGER);
      CREATE TABLE meetings AS SELECT id, title, context, calendar_attendees, started_at, ended_at, duration_ms FROM src.meetings WHERE 0;
    `);
    const ins = db.prepare(
      "INSERT INTO meetings SELECT id, title, context, calendar_attendees, started_at, ended_at, duration_ms FROM src.meetings WHERE id = ?",
    );
    for (const id of ids)
      if (Number(ins.run(id).changes) !== 1)
        throw new Error(`meeting ${id.slice(0, 8)} is not in the app DB`);
    db.exec("DETACH DATABASE src");
  } finally {
    db.close();
    rmSync(copy, { force: true });
  }
  chmodSync(out, 0o600);
}

/** The full meeting ids of the audio folders that start with each id8. */
export function resolveAudioIds(audioRoot: string, id8s: string[]): string[] {
  const dirs = readdirSync(audioRoot);
  return id8s.map((k) => {
    const m = dirs.filter((d) => d.startsWith(k));
    if (m.length !== 1)
      throw new Error(`meeting ${k}: ${m.length} audio folders match`);
    return m[0] as string;
  });
}

/** Hash the audio files of one meeting folder. */
export function hashMeeting(dir: string, id: string): CorpusMeeting {
  const files = {} as CorpusMeeting["files"];
  const bytes = {} as CorpusMeeting["bytes"];
  for (const f of AUDIO_FILES) {
    const p = join(dir, f);
    files[f] = existsSync(p) ? sha256File(p) : null;
    bytes[f] = existsSync(p) ? statSync(p).size : null;
  }
  return { id, id8: id.slice(0, 8), files, bytes };
}

/** Build and write a manifest. Returns it. */
export function buildCorpus(opts: {
  name: string;
  audioRoot: string;
  goldDir: string;
  appDb: string;
  id8s?: string[];
}): Manifest {
  const goldDir = resolve(opts.goldDir);
  const id8s =
    opts.id8s ??
    readdirSync(goldDir)
      .filter((f) => /^[0-9a-f]{8}\.json$/.test(f))
      .map((f) => f.slice(0, 8))
      .sort();
  const ids = resolveAudioIds(opts.audioRoot, id8s);
  const golds = loadGold(id8s, goldDir);
  const info = goldInfo(golds);
  if (!info?.goldHash) throw new Error("the gold keys have no goldHash");
  const dir = privateDir(join(corporaDir(), opts.name));
  const seedPath = join(dir, "source.db");
  freezeSeed(opts.appDb, ids, seedPath);
  const seed = seedContent(seedPath);
  const m: Manifest = {
    version: 1,
    name: opts.name,
    createdAt: new Date().toISOString(),
    audioRoot: resolve(opts.audioRoot),
    meetings: ids.map((id) => hashMeeting(join(opts.audioRoot, id), id)),
    seed: {
      path: `${opts.name}/source.db`,
      contentSha256: sha256(seed.json),
      vocabulary: seed.vocabulary,
    },
    gold: {
      dir: goldDir,
      goldKinds: info.goldKinds ?? [],
      goldHash: info.goldHash,
      files: Object.fromEntries(
        [...golds].map(([k, g]) => [k, g.fileSha256 as string]),
      ),
    },
  };
  for (const mm of m.meetings)
    if (!mm.files["mic.wav"] || !mm.files["system.wav"])
      throw new Error(`meeting ${mm.id8}: mic.wav or system.wav is missing`);
  privateWrite(manifestPath(opts.name), `${JSON.stringify(m, null, 1)}\n`);
  return m;
}

export function readManifest(name: string): {
  manifest: Manifest;
  hash: string;
} {
  const p = manifestPath(name);
  if (!existsSync(p))
    throw new Error(`no corpus ${name} (pnpm lab corpus build ${name})`);
  const text = readFileSync(p, "utf8");
  return { manifest: JSON.parse(text) as Manifest, hash: sha256(text) };
}

export const seedPath = (m: Manifest) => join(corporaDir(), m.seed.path);

export interface CheckLine {
  what: string;
  ok: boolean;
}

/**
 * Check every file of a manifest: the audio hashes (of `only` meetings
 * when given), the seed content hash, the gold key hashes and goldHash, and
 * the private modes. Returns one line per check.
 */
export function checkCorpus(m: Manifest, only?: string[]): CheckLine[] {
  const out: CheckLine[] = [];
  const mode = (p: string, want: number) =>
    existsSync(p) && (statSync(p).mode & 0o777 & ~want) === 0;
  for (const mm of m.meetings) {
    if (only && !only.includes(mm.id8)) continue;
    const now = hashMeeting(join(m.audioRoot, mm.id), mm.id);
    for (const f of AUDIO_FILES)
      out.push({
        what: `audio ${mm.id8} ${f}`,
        ok: now.files[f] === mm.files[f],
      });
  }
  const sp = seedPath(m);
  out.push({
    what: `seed DB content (${m.seed.vocabulary} vocabulary rows)`,
    ok: existsSync(sp) && sha256(seedContent(sp).json) === m.seed.contentSha256,
  });
  out.push({ what: "seed DB mode 0600", ok: mode(sp, 0o600) });
  const ids = Object.keys(m.gold.files).sort();
  let golds: ReturnType<typeof loadGold> | null = null;
  try {
    golds = loadGold(ids, m.gold.dir);
  } catch {
    golds = null;
  }
  for (const k of ids)
    out.push({
      what: `gold ${k}`,
      ok: golds?.get(k)?.fileSha256 === m.gold.files[k],
    });
  const info = golds ? goldInfo(golds) : null;
  out.push({
    what: `goldHash ${m.gold.goldHash}`,
    ok: info?.goldHash === m.gold.goldHash,
  });
  out.push({
    what: `goldKinds ${m.gold.goldKinds.join(",")}`,
    ok:
      JSON.stringify(info?.goldKinds ?? []) ===
      JSON.stringify(m.gold.goldKinds),
  });
  out.push({
    what: "manifest mode 0600",
    ok: mode(manifestPath(m.name), 0o600),
  });
  return out;
}
