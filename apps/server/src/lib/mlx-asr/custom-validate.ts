/**
 * Add a custom MLX speech model from Hugging Face (specs/custom-mlx-models.md
 * sections 6 and 7): the search proxy, the one validation function and the
 * add step. Only huggingface.co is called, with no token.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertEnoughDiskSpace,
  DOWNLOAD_FREE_BUFFER_BYTES,
  InsufficientDiskSpaceError,
} from "../disk.js";
import {
  type CustomMlxFile,
  hfCacheRoot,
  LEGACY_MLX_ASR_MODELS,
  MLX_ASR_MODELS,
} from "./constants.js";
import {
  findCustomModelId,
  insertCustomModel,
  isSafeHfId,
  MAX_MODEL_BYTES,
} from "./custom-models.js";
import {
  isNotTranscriber,
  resolveSttFamily,
  SUPPORTED_STT_FAMILIES,
} from "./families.js";
import { downloadMlxModel } from "./models.js";

const HF_HOST = "huggingface.co";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_JSON_BYTES = 1024 * 1024;
const SEARCH_LIMIT = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BARE_HF_ID = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

type CustomModelErrorCode =
  | "invalid_input"
  | "offline"
  | "hf_error"
  | "not_found"
  | "gated"
  | "no_config"
  | "unsupported_family"
  | "not_transcriber"
  | "remote_code"
  | "no_weights"
  | "too_large"
  | "no_disk"
  | "already_added";

type CustomModelErrorStatus = 400 | 404 | 409 | 422 | 502 | 503;

const ERROR_STATUS: Record<CustomModelErrorCode, CustomModelErrorStatus> = {
  invalid_input: 400,
  not_found: 404,
  already_added: 409,
  offline: 503,
  hf_error: 502,
  gated: 422,
  no_config: 422,
  unsupported_family: 422,
  not_transcriber: 422,
  remote_code: 422,
  no_weights: 422,
  too_large: 422,
  no_disk: 422,
};

/**
 * A failed validation or search. The renderer maps `code` to text, so the
 * message is for logs only. `extra` carries the values a text needs.
 */
export class CustomModelError extends Error {
  readonly status: CustomModelErrorStatus;

  constructor(
    readonly code: CustomModelErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CustomModelError";
    this.status = ERROR_STATUS[code];
  }
}

// --- Hugging Face HTTP -----------------------------------------------------

/**
 * GET with a timeout. Redirects are followed by hand, and only to
 * huggingface.co over https, for at most 3 hops.
 */
async function hfGet(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new CustomModelError("hf_error", "Hugging Face timed out");
      }
      throw new CustomModelError("offline", "Cannot reach Hugging Face");
    }
    if (!REDIRECT_STATUSES.has(res.status)) return res;

    await res.body?.cancel();
    const location = res.headers.get("location");
    const next = location ? new URL(location, current) : null;
    if (!next || next.protocol !== "https:" || next.hostname !== HF_HOST) {
      throw new CustomModelError("hf_error", "Unexpected redirect");
    }
    current = next.href;
  }
  throw new CustomModelError("hf_error", "Too many redirects");
}

async function readJson(
  res: Response,
  badJsonCode: CustomModelErrorCode,
): Promise<unknown> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    // The request timeout also covers the body. A stalled body is a timeout.
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new CustomModelError("hf_error", "Hugging Face timed out");
      }
      throw new CustomModelError("offline", "Cannot reach Hugging Face");
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new CustomModelError("hf_error", "Response is too large");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CustomModelError(badJsonCode, "Response is not valid JSON");
  }
}

/**
 * GET a JSON document. `notFoundCode` is the code for a 404. A 403 is always
 * `gated`. `unauthorizedCode` is the code for a 401.
 */
async function hfGetJson(
  url: string,
  notFoundCode: CustomModelErrorCode,
  badJsonCode: CustomModelErrorCode,
  unauthorizedCode: CustomModelErrorCode = "gated",
): Promise<unknown> {
  const res = await hfGet(url);
  if (res.status === 404) throw new CustomModelError(notFoundCode, "Not found");
  if (res.status === 403) {
    throw new CustomModelError("gated", "Login required");
  }
  if (res.status === 401) {
    throw new CustomModelError(unauthorizedCode, "Not authorized");
  }
  if (!res.ok) {
    throw new CustomModelError(
      "hf_error",
      `Hugging Face answered ${res.status}`,
    );
  }
  return readJson(res, badJsonCode);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// --- Search ----------------------------------------------------------------

export interface MlxSearchHit {
  id: string;
  downloads: number;
  pipeline_tag: string | null;
}

const ASR_PIPELINE_TAG = "automatic-speech-recognition";

async function searchQuery(
  params: Record<string, string>,
  q: string | undefined,
): Promise<MlxSearchHit[]> {
  const query = new URLSearchParams({
    ...params,
    sort: "downloads",
    limit: String(SEARCH_LIMIT),
  });
  if (q) query.set("search", q);
  const body = await hfGetJson(
    `https://${HF_HOST}/api/models?${query}`,
    "hf_error",
    "hf_error",
  );
  if (!Array.isArray(body)) {
    throw new CustomModelError("hf_error", "Unexpected search response");
  }
  return body.flatMap((raw): MlxSearchHit[] => {
    const hit = asObject(raw);
    if (!hit || typeof hit.id !== "string") return [];
    return [
      {
        id: hit.id,
        downloads: typeof hit.downloads === "number" ? hit.downloads : 0,
        pipeline_tag:
          typeof hit.pipeline_tag === "string" ? hit.pipeline_tag : null,
      },
    ];
  });
}

/**
 * Two queries. `filter=mlx` with the ASR tag finds most repos. The Qwen3-ASR
 * repos have no pipeline tag and only match `filter=mlx-audio`, which also
 * returns TTS repos. So the second query's hits drop a non-ASR tag. The merge
 * dedupes by id and sorts by downloads.
 */
export async function searchMlxModels(q?: string): Promise<MlxSearchHit[]> {
  const [tagged, audio] = await Promise.all([
    searchQuery({ filter: "mlx", pipeline_tag: ASR_PIPELINE_TAG }, q),
    searchQuery({ filter: "mlx-audio" }, q),
  ]);
  const byId = new Map<string, MlxSearchHit>();
  for (const hit of [...tagged, ...audio]) {
    if (hit.pipeline_tag && hit.pipeline_tag !== ASR_PIPELINE_TAG) continue;
    if (!byId.has(hit.id)) byId.set(hit.id, hit);
  }
  return [...byId.values()]
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, SEARCH_LIMIT);
}

// --- Validation ------------------------------------------------------------

export interface ValidatedCustomModel {
  hfId: string;
  family: string;
  /** The worker key from `resolveSttFamily`. */
  modelType: string;
  totalBytes: number;
  revision: string;
  files: CustomMlxFile[];
}

/** Step 1. Accept `org/name` or a huggingface.co model URL. */
function parseHfInput(input: string): string {
  const text = input.trim();
  const invalid = () =>
    new CustomModelError("invalid_input", "Not a Hugging Face model link");
  if (BARE_HF_ID.test(text)) return text;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== HF_HOST ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw invalid();
  }
  const [, org, name, kind, ...rest] = url.pathname.split("/");
  const suffixOk =
    kind === undefined ||
    (kind === "" && rest.length === 0) ||
    ["tree", "blob", "resolve"].includes(kind);
  if (!org || !name || !suffixOk) throw invalid();
  return `${org}/${name}`;
}

function alreadyAdded(id: string): CustomModelError {
  return new CustomModelError("already_added", "Model is already in the list", {
    id,
  });
}

/** The first dir that exists, so `statfs` works before the hub cache exists. */
function nearestExistingDir(dir: string): string {
  let current = dir;
  while (!existsSync(current) && dirname(current) !== current) {
    current = dirname(current);
  }
  return current;
}

function siblingPaths(siblings: Record<string, unknown>[]): string[] {
  return siblings.map((s) => String(s.rfilename));
}

/**
 * Steps 1 to 11 of the validation. It writes nothing. The first failure
 * throws a `CustomModelError`.
 */
export async function validateCustomModel(
  input: string,
): Promise<ValidatedCustomModel> {
  // 1 and 2: normalize and check the id.
  const hfId = parseHfInput(input);
  if (!isSafeHfId(hfId)) {
    throw new CustomModelError("invalid_input", "Not a valid repo id");
  }
  const [, repoName] = hfId.split("/");

  // 3: not curated, not added before.
  const known = [...MLX_ASR_MODELS, ...LEGACY_MLX_ASR_MODELS].find(
    (m) => m.hfId.toLowerCase() === hfId.toLowerCase(),
  );
  if (known) throw alreadyAdded(known.id);
  const existingId = findCustomModelId(hfId);
  if (existingId) throw alreadyAdded(existingId);

  // 4 and 5: metadata, gated or private. A repo that is gated answers 200 with
  // `gated` set. HF answers 401 for a repo that does not exist, and for a
  // private one (checked 2026-10-04). The two look the same, so a 401 is
  // `not_found`.
  const meta = asObject(
    await hfGetJson(
      `https://${HF_HOST}/api/models/${hfId}?blobs=true`,
      "not_found",
      "hf_error",
      "not_found",
    ),
  );
  if (!meta) throw new CustomModelError("hf_error", "Unexpected response");
  if (meta.gated !== false || meta.private === true) {
    throw new CustomModelError("gated", "Login required");
  }
  if (!Array.isArray(meta.siblings)) {
    throw new CustomModelError("hf_error", "Response has no file list");
  }
  const siblings = meta.siblings.flatMap((s) => {
    const sibling = asObject(s);
    return sibling && typeof sibling.rfilename === "string" ? [sibling] : [];
  });
  const paths = siblingPaths(siblings);
  const topLevel = (name: string) => paths.includes(name);

  // 6: config.json. The API `config` field is not enough (spec section 4.1).
  if (!topLevel("config.json")) {
    throw new CustomModelError("no_config", "Repo has no config.json");
  }
  const configUrl = (file: string) =>
    `https://${HF_HOST}/${hfId}/resolve/main/${file}`;
  const config = asObject(
    await hfGetJson(configUrl("config.json"), "no_config", "no_config"),
  );
  if (!config) throw new CustomModelError("no_config", "Bad config.json");

  // 7: remote code. A .py file, or an auto_map key in a config file.
  const remoteCode = () =>
    new CustomModelError("remote_code", "Repo has its own code");
  if (paths.some((p) => p.toLowerCase().endsWith(".py"))) throw remoteCode();
  if ("auto_map" in config) throw remoteCode();
  for (const file of ["tokenizer_config.json", "preprocessor_config.json"]) {
    if (!topLevel(file)) continue;
    const other = asObject(
      await hfGetJson(configUrl(file), "hf_error", "hf_error"),
    );
    if (other && "auto_map" in other) throw remoteCode();
  }

  // 8: family.
  const modelType = resolveSttFamily(config, repoName);
  if (isNotTranscriber(modelType, config, repoName)) {
    throw new CustomModelError("not_transcriber", "Not a transcription model");
  }
  const family =
    modelType !== null && Object.hasOwn(SUPPORTED_STT_FAMILIES, modelType)
      ? SUPPORTED_STT_FAMILIES[modelType]
      : undefined;
  if (!modelType || !family) {
    const rawType =
      typeof config.model_type === "string" ? config.model_type : modelType;
    throw new CustomModelError(
      "unsupported_family",
      `Model type ${rawType} is not supported`,
      { modelType: rawType },
    );
  }

  // 9: weights the worker can load. Top-level files only.
  const hasWeights = paths.some(
    (p) => !p.includes("/") && /\.(safetensors|npz)$/i.test(p),
  );
  if (!hasWeights) {
    throw new CustomModelError("no_weights", "Repo has no loadable weights");
  }

  // 10: size.
  const files: CustomMlxFile[] = [];
  for (const sibling of siblings) {
    const path = String(sibling.rfilename);
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new CustomModelError("hf_error", "Repo file list has a bad path");
    }
    if (typeof sibling.size !== "number" || sibling.size < 0) {
      throw new CustomModelError("hf_error", "Repo file list has no sizes");
    }
    files.push({ path, size: sibling.size });
  }
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_MODEL_BYTES) {
    throw new CustomModelError("too_large", "Model is larger than 8 GiB", {
      totalBytes,
    });
  }
  if (typeof meta.sha !== "string" || !meta.sha) {
    throw new CustomModelError("hf_error", "Response has no revision");
  }

  // 11: free disk.
  try {
    await assertEnoughDiskSpace(
      nearestExistingDir(hfCacheRoot()),
      totalBytes + DOWNLOAD_FREE_BUFFER_BYTES,
    );
  } catch (err) {
    if (err instanceof InsufficientDiskSpaceError) {
      throw new CustomModelError("no_disk", "Not enough disk space", {
        needBytes: err.requiredBytes,
        freeBytes: err.freeBytes,
      });
    }
    throw err;
  }

  return {
    hfId,
    family: family.family,
    modelType,
    totalBytes,
    revision: meta.sha,
    files,
  };
}

/** Step 12. Validate again, insert the row and start the download. */
export async function addCustomModel(input: string): Promise<{ id: string }> {
  const model = await validateCustomModel(input);
  let id: string;
  try {
    id = insertCustomModel(model);
  } catch (err) {
    // A second add of the same repo that passed step 3 in a race.
    if (err instanceof Error && /constraint/i.test(err.message)) {
      throw alreadyAdded(model.hfId);
    }
    throw err;
  }
  downloadMlxModel(id).catch(() => {});
  return { id };
}
