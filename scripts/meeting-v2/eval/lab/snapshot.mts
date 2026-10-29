// snapshot.mts: the snapshot of one Eval Lab run, and its hash.
//
// The snapshot records everything that can change a result: the git state
// (sha, branch, dirty flag, hash of the diff and of the untracked files),
// the hash of the server and worker code, the worker and diarizer hashes,
// the model ids and their HF revisions, every knob value, the corpus
// manifest hash, the gold hash, the scorer version and the machine. The
// snapshot_hash is the sha256 of the identity fields (all but the times).
// Two runs with the same snapshot_hash are the same experiment.

import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DIARIZER, repoRoot, WORKER } from "../runtime.mts";
import {
  labHome,
  privateDir,
  privateWrite,
  sha256,
  sha256File,
} from "./corpus.mts";
import { KNOBS, type KnobValues } from "./knobs.mts";

/** JSON with the object keys sorted at every level (a stable text for hashes). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** Every file under `dir` (recursive), sorted, as "<repo path>:<sha256>". */
export function treeParts(dir: string, skip: RegExp = /^$/): string[] {
  if (!existsSync(dir)) return [`${relative(repoRoot, dir)}:-`];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    const rel = relative(repoRoot, p);
    if (skip.test(rel)) continue;
    out.push(`${rel}:${sha256(readFileSync(p))}`);
  }
  return out.sort();
}

/**
 * The code that a meeting transcription runs, by content: the server
 * source, the workspace packages, the ASR worker script and the scratch
 * scripts of the eval. Same content = same hash in every checkout.
 */
export function asrCodeParts(): string[] {
  const pk = join(repoRoot, "packages");
  return [
    ...treeParts(join(repoRoot, "apps", "server", "src")),
    ...readdirSync(pk)
      .sort()
      .flatMap((p) => treeParts(join(pk, p, "src"))),
    ...[
      "scripts/mlx_asr_server.py",
      "scripts/meeting-v2/setup-scratch.sh",
      "scripts/meeting-v2/seed-scratch-db.mjs",
      "scripts/meeting-v2/run-baseline.mjs",
      "scripts/meeting-v2/eval/runtime.mts",
    ].map((f) => `${f}:${sha256(readFileSync(join(repoRoot, f)))}`),
  ];
}

/** The scorer files, by content. */
export const SCORER_FILES = [
  "scripts/meeting-v2/eval/score.mts",
  "scripts/meeting-v2/eval/gold.mts",
  "scripts/meeting-v2/eval/silver/score/insertions.mts",
  "scripts/meeting-v2/eval/silver/score/names.mts",
  "scripts/meeting-v2/eval/lab/score.mts",
];
export const scorerVersion = () =>
  sha256(
    SCORER_FILES.map(
      (f) => `${f}:${sha256(readFileSync(join(repoRoot, f)))}`,
    ).join("\n"),
  ).slice(0, 16);

/** The lab code itself (the runner can change a result too). */
export const labCodeVersion = () =>
  sha256(
    treeParts(
      join(repoRoot, "scripts", "meeting-v2", "eval", "lab"),
      /\.test\.mts$|grids\//,
    ).join("\n"),
  ).slice(0, 16);

/** The file list and sizes of the diarizer and VAD models. */
export function diarizerModelParts(): string[] {
  const root = join(repoRoot, "apps", "electron", "resources", "models");
  const out: string[] = [];
  for (const d of ["speaker-diarization", "silero-vad"]) {
    const dir = join(root, d);
    if (!existsSync(dir)) {
      out.push(`${d}:-`);
      continue;
    }
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true }))
      if (e.isFile()) {
        const p = join(e.parentPath, e.name);
        out.push(`${relative(root, p)}:${statSync(p).size}`);
      }
  }
  return out.sort();
}

const git = (...args: string[]) =>
  spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  }).stdout ?? "";

export interface GitState {
  sha: string;
  branch: string;
  dirty: boolean;
  /** sha256 of `git diff HEAD` (empty diff = the hash of ""). */
  diffSha256: string;
  /** sha256 over the untracked files (not ignored), path and content. */
  untrackedSha256: string;
  untracked: number;
}

export function gitState(): GitState {
  const diff = git("diff", "HEAD", "--binary");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean)
    .sort();
  const parts = untracked.map((f) => `${f}:${sha256File(join(repoRoot, f))}`);
  return {
    sha: git("rev-parse", "HEAD").trim(),
    branch: git("rev-parse", "--abbrev-ref", "HEAD").trim(),
    dirty: diff.length > 0 || untracked.length > 0,
    diffSha256: sha256(diff),
    untrackedSha256: sha256(parts.join("\n")),
    untracked: untracked.length,
  };
}

/** The HF revision (refs/main) of a model in the HF cache, or null. */
export function hfRevision(hfCache: string, hfId: string): string | null {
  const ref = join(
    hfCache,
    "hub",
    `models--${hfId.replaceAll("/", "--")}`,
    "refs",
    "main",
  );
  return existsSync(ref) ? readFileSync(ref, "utf8").trim() : null;
}

export interface Machine {
  chip: string;
  ramGb: number;
  macos: string;
  node: string;
}

export function machine(): Machine {
  const run = (cmd: string, ...a: string[]) =>
    (spawnSync(cmd, a, { encoding: "utf8" }).stdout ?? "").trim();
  return {
    chip: run("sysctl", "-n", "machdep.cpu.brand_string"),
    ramGb: Math.round(Number(run("sysctl", "-n", "hw.memsize")) / 2 ** 30),
    macos: run("sw_vers", "-productVersion"),
    node: process.version,
  };
}

/**
 * A private salt (lab home, 0600) for the fingerprint of a secret knob
 * value. The ledger shows that the value changed, never the value.
 */
export function secretFingerprint(value: string): string {
  const p = join(privateDir(labHome()), "salt");
  if (!existsSync(p)) privateWrite(p, randomBytes(32).toString("hex"));
  const salt = readFileSync(p, "utf8").trim();
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 12);
}

/**
 * The knob values for the ledger: a secret knob gives "unset" or
 * "set:<fingerprint>" (the value comes from `secrets`).
 */
export function publicKnobs(
  kv: KnobValues,
  secrets: Record<string, string | undefined>,
): KnobValues {
  const out: KnobValues = {};
  for (const k of KNOBS) {
    const v = kv[k.name] as string;
    if (!k.secret || v === "unset") out[k.name] = v;
    else {
      const s = secrets[k.name];
      if (!s) throw new Error(`knob ${k.name}=${v} needs its value in the env`);
      out[k.name] = `set:${secretFingerprint(s)}`;
    }
  }
  return out;
}

export interface Snapshot {
  stage: "asr";
  knobs: KnobValues;
  runName: string;
  meetings: string[];
  corpus: { name: string; manifestSha256: string };
  gold: {
    goldHash: string;
    goldKinds: string[];
    /**
     * Spans that the owner confirmed by ear, the verified_unsure ones and the
     * verified_none ones (no named entity; not scored).
     */
    verified: number;
    verifiedUnsure: number;
    verifiedNone: number;
  };
  scorerVersion: string;
  labVersion: string;
  git: GitState;
  codeSha256: string;
  workerSha256: string;
  diarizerSha256: string;
  diarizerModelsSha256: string;
  models: {
    asr: string;
    asrRevision: string | null;
    aligner: string;
    alignerRevision: string | null;
  };
  machine: Machine;
}

/** The hash of the identity of a run (the snapshot has no times). */
export const snapshotHash = (s: Snapshot) => sha256(canonicalJson(s));

/** The code-side snapshot fields (slow parts computed once per lab run). */
export function codeFields(): Pick<
  Snapshot,
  | "scorerVersion"
  | "labVersion"
  | "git"
  | "codeSha256"
  | "workerSha256"
  | "diarizerSha256"
  | "diarizerModelsSha256"
  | "machine"
> {
  return {
    scorerVersion: scorerVersion(),
    labVersion: labCodeVersion(),
    git: gitState(),
    codeSha256: sha256(asrCodeParts().join("\n")),
    workerSha256: sha256File(WORKER),
    diarizerSha256: sha256File(DIARIZER),
    diarizerModelsSha256: sha256(diarizerModelParts().join("\n")),
    machine: machine(),
  };
}
