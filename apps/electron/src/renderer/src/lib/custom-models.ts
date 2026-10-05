import { type ApiClient, type ApiRes, getClient } from "./api";

type MlxAsrApi = ApiClient["api"]["mlx-asr"];

/** One Hugging Face hit from GET /api/mlx-asr/search. */
export type MlxSearchHit = ApiRes<MlxAsrApi["search"]["$get"]>[number];

/** The 200 body of POST /api/mlx-asr/custom-models/validate. */
export type CustomModelCheck = ApiRes<
  MlxAsrApi["custom-models"]["validate"]["$post"]
>;

/** An error body from the custom model routes: `{ error, code, ...extras }`. */
export interface CustomModelFailure {
  code: string;
  modelType?: string;
  missing?: string[];
  needBytes?: number;
  freeBytes?: number;
  totalBytes?: number;
}

export type CustomModelResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: CustomModelFailure };

// Codes of specs/custom-mlx-models.md section 6.3. Each has a text under
// `models.custom.errors.<code>`. Any other code reads as `unknown`.
const KNOWN_FAILURE_CODES = new Set([
  "invalid_input",
  "offline",
  "hf_error",
  "not_found",
  "gated",
  "no_config",
  "unsupported_family",
  "not_transcriber",
  "remote_code",
  "no_weights",
  "missing_files",
  "too_large",
  "no_disk",
  "already_added",
]);

/** The unit of the GB in the texts: the same decimal GB as `formatBytes`. */
function toGb(bytes: number | undefined): string {
  return ((bytes ?? 0) / 1_000_000_000).toFixed(1);
}

/** Maps a failure to its i18n key and the values its text needs. */
export function customModelFailureText(f: CustomModelFailure): {
  key: string;
  values: Record<string, string>;
} {
  const code = KNOWN_FAILURE_CODES.has(f.code) ? f.code : "unknown";
  return {
    key: `models.custom.errors.${code}`,
    values: {
      type: f.modelType ?? "?",
      files: (f.missing ?? []).join(", "),
      need: toGb(f.needBytes),
      free: toGb(f.freeBytes),
      size: toGb(f.totalBytes),
    },
  };
}

// A request that threw (server not reachable) or an answer that was not JSON.
const UNKNOWN_FAILURE: CustomModelFailure = { code: "unknown" };

/** Reads the error body of a failed answer. A body without a `code` reads as `unknown`. */
async function readFailure(res: Response): Promise<CustomModelFailure> {
  const body: unknown = await res.json();
  return body && typeof body === "object" && "code" in body
    ? (body as CustomModelFailure)
    : UNKNOWN_FAILURE;
}

/** Search Hugging Face for MLX speech models. */
export async function searchMlxModels(
  q: string,
  signal?: AbortSignal,
): Promise<CustomModelResult<MlxSearchHit[]>> {
  try {
    const res = await getClient().api["mlx-asr"].search.$get(
      { query: { q } },
      { init: { signal } },
    );
    if (res.ok) return { ok: true, data: await res.json() };
    return { ok: false, failure: await readFailure(res) };
  } catch {
    return { ok: false, failure: UNKNOWN_FAILURE };
  }
}

/** Check a model. It writes nothing and starts no download. */
export async function validateCustomMlxModel(
  model: string,
): Promise<CustomModelResult<CustomModelCheck>> {
  try {
    const res = await getClient().api["mlx-asr"][
      "custom-models"
    ].validate.$post({ json: { model } });
    if (res.ok) return { ok: true, data: await res.json() };
    return { ok: false, failure: await readFailure(res) };
  } catch {
    return { ok: false, failure: UNKNOWN_FAILURE };
  }
}

/** Add a model and start its download. */
export async function addCustomMlxModel(
  model: string,
): Promise<CustomModelResult<{ id: string }>> {
  try {
    const res = await getClient().api["mlx-asr"]["custom-models"].$post({
      json: { model },
    });
    if (res.ok) return { ok: true, data: await res.json() };
    return { ok: false, failure: await readFailure(res) };
  } catch {
    return { ok: false, failure: UNKNOWN_FAILURE };
  }
}
