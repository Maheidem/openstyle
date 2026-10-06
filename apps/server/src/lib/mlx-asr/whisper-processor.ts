/**
 * Fill in the processor files of an old mlx-whisper repo
 * (specs/custom-mlx-models.md section 14).
 *
 * Such a repo has `config.json` and weights only. The worker needs
 * `preprocessor_config.json`, `tokenizer.json` and `tokenizer_config.json` to
 * build `WhisperProcessor`. They depend only on the vocabulary layout, so the
 * server takes them from the official OpenAI repo of the same layout. A wrong
 * set of files gives wrong text and no error, so the pair `n_vocab` and
 * `n_mels` must match a known layout, and the tokenizer length must equal
 * `n_vocab`.
 */

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CustomMlxFile } from "./constants.js";
import { HF_HOST, hfGet, readBody } from "./hf-http.js";

/** A tokenizer file is a few MB. This is a limit, not a size to expect. */
const MAX_FILE_BYTES = 8 * 1024 ** 2;
/** A file of 3 MB must have time on a slow line. */
const FILE_TIMEOUT_MS = 60_000;

interface WhisperProcessorSource {
  /** The official repo, for example `openai/whisper-tiny`. */
  repo: string;
  /** A commit sha, so the files cannot change. */
  revision: string;
  nVocab: number;
  nMels: number;
  /** The files with their sizes at `revision`. */
  files: readonly CustomMlxFile[];
}

/** The pinned sources (HF API, 2026-10-06). The sizes are the sizes at the revision. */
const SOURCES: readonly WhisperProcessorSource[] = [
  {
    repo: "openai/whisper-tiny.en",
    revision: "87c7102498dcde7456f24cfd30239ca606ed9063",
    nVocab: 51864,
    nMels: 80,
    files: [
      { path: "preprocessor_config.json", size: 184_990 },
      { path: "tokenizer.json", size: 2_405_679 },
      { path: "tokenizer_config.json", size: 805 },
    ],
  },
  {
    repo: "openai/whisper-tiny",
    revision: "169d4a4341b33bc18d8881c4b69c2e104e1cc0af",
    nVocab: 51865,
    nMels: 80,
    files: [
      { path: "preprocessor_config.json", size: 184_990 },
      { path: "tokenizer.json", size: 2_480_466 },
      { path: "tokenizer_config.json", size: 282_683 },
    ],
  },
  {
    repo: "openai/whisper-large-v3-turbo",
    revision: "41f01f3fe87f28c78e2fbf8b568835947dd65ed9",
    nVocab: 51866,
    nMels: 128,
    files: [
      { path: "preprocessor_config.json", size: 340 },
      { path: "tokenizer.json", size: 2_710_337 },
      { path: "tokenizer_config.json", size: 282_843 },
    ],
  },
];

const PROCESSOR_FILES = SOURCES[0].files.map((f) => f.path);

/** The source whose layout matches the model dims of `config.json`. */
function sourceForConfig(
  config: Record<string, unknown>,
): WhisperProcessorSource | null {
  return (
    SOURCES.find(
      (s) => s.nVocab === config.n_vocab && s.nMels === config.n_mels,
    ) ?? null
  );
}

/**
 * The source for a repo at validation time. `null` when the repo has any of
 * the processor files (a mixed repo stays blocked) or when no layout matches.
 */
export function whisperProcessorSource(
  config: Record<string, unknown>,
  repoPaths: readonly string[],
): WhisperProcessorSource | null {
  if (PROCESSOR_FILES.some((name) => repoPaths.includes(name))) return null;
  return sourceForConfig(config);
}

/**
 * The number of tokens that `WhisperProcessor` sees: the entries of
 * `model.vocab` plus the added tokens that are not in it. Equal to
 * `len(tokenizer)` of transformers 5.18.0 for the three pinned files.
 */
export function tokenizerLength(tokenizer: unknown): number | null {
  if (!tokenizer || typeof tokenizer !== "object") return null;
  const { model, added_tokens: added } = tokenizer as {
    model?: { vocab?: unknown };
    added_tokens?: unknown;
  };
  const vocab = model?.vocab;
  if (!vocab || typeof vocab !== "object" || !Array.isArray(added)) return null;
  const extra = added.filter(
    (token: { content?: unknown }) =>
      typeof token?.content === "string" &&
      !Object.hasOwn(vocab, token.content),
  );
  return Object.keys(vocab).length + extra.length;
}

/** A symlink in a snapshot dir is a file of the repo. Ours are plain files. */
function isRepoFile(snapshotDir: string, name: string): boolean {
  try {
    return lstatSync(join(snapshotDir, name)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function fetchSourceFile(
  source: WhisperProcessorSource,
  path: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const res = await hfGet(
    `https://${HF_HOST}/${source.repo}/resolve/${source.revision}/${path}`,
    { signal, timeoutMs: FILE_TIMEOUT_MS },
  );
  if (!res.ok) {
    throw new Error(`Hugging Face answered ${res.status} for ${source.repo}`);
  }
  return readBody(res, MAX_FILE_BYTES);
}

/**
 * Write the processor files into a downloaded snapshot of a whisper repo, when
 * the repo has none of its own. It does nothing for a repo that has its own.
 * It throws, and writes nothing, when no layout matches or the tokenizer length
 * differs from `n_vocab`.
 */
export async function fillWhisperProcessor(
  snapshotDir: string,
  signal: AbortSignal,
): Promise<void> {
  if (PROCESSOR_FILES.some((name) => isRepoFile(snapshotDir, name))) return;

  const config: unknown = JSON.parse(
    readFileSync(join(snapshotDir, "config.json"), "utf8"),
  );
  const source =
    config && typeof config === "object" && !Array.isArray(config)
      ? sourceForConfig(config as Record<string, unknown>)
      : null;
  if (!source) {
    throw new Error(
      "This Whisper model has no standard tokenizer in this app version.",
    );
  }

  const bodies = new Map<string, Buffer>();
  for (const { path } of source.files) {
    bodies.set(path, await fetchSourceFile(source, path, signal));
  }

  let length: number | null = null;
  try {
    length = tokenizerLength(
      JSON.parse((bodies.get("tokenizer.json") as Buffer).toString("utf8")),
    );
  } catch {}
  if (length !== source.nVocab) {
    throw new Error(
      `The tokenizer from ${source.repo} has ${length ?? "an unknown number of"} tokens. The model needs ${source.nVocab}. It was not used.`,
    );
  }

  for (const [path, body] of bodies) {
    writeFileSync(join(snapshotDir, path), body);
  }
}
