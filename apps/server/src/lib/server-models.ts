import {
  normalizeOmlxRoot,
  omlxModelsUrl,
  type ServerKindSource,
  type ServerModelKind,
} from "@openstyle/validations";
import { REGISTRY_FETCH_TIMEOUT_MS } from "./model-registry.js";

/**
 * Which models of an own server fit which role (specs/model-picker-groups.md
 * section 4). The server sends the kind. The renderer decides the role fit.
 */

const STATUS_TIMEOUT_MS = 2000;

export interface ServerModel {
  id: string;
  kind: ServerModelKind;
  kind_source: ServerKindSource;
}

export type ServerFlavor = "omlx" | "openai";

/** Why a probe failed. The renderer maps each code to its own text. */
export type ServerProbeErrorCode =
  | "unreachable"
  | "unauthorized"
  | "not_openai";

export class ServerProbeError extends Error {
  constructor(
    readonly code: ServerProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServerProbeError";
  }
}

export interface ServerProbeResult {
  flavor: ServerFlavor;
  models: ServerModel[];
}

/** oMLX `model_type` to kind (section 4.3). */
const OMLX_TYPE_KINDS: Record<string, ServerModelKind> = {
  llm: "llm",
  vlm: "llm",
  audio_stt: "speech",
  audio_tts: "tts",
  audio_sts: "other",
  markitdown: "other",
  embedding: "embedding",
  reranker: "rerank",
};

const EMBEDDING_TOKENS = new Set(["bge", "gte", "minilm", "mxbai", "e5"]);
const TTS_TOKENS = new Set([
  "tts",
  "kokoro",
  "orpheus",
  "chatterbox",
  "outetts",
  "bark",
]);
const SPEECH_TOKENS = new Set([
  "asr",
  "stt",
  "whisper",
  "parakeet",
  "canary",
  "sensevoice",
  "moonshine",
  "voxtral",
  "wav2vec",
  "wav2vec2",
]);

/** The name rules. They run only for a model with no server data. */
export function kindFromName(modelId: string): ServerModelKind {
  const id = modelId.toLowerCase();
  const tokens = new Set(id.split(/[^a-z0-9]+/).filter(Boolean));
  const hasToken = (set: ReadonlySet<string>) =>
    [...tokens].some((token) => set.has(token));

  if (tokens.has("markitdown")) return "other";
  if (id.includes("embed") || hasToken(EMBEDDING_TOKENS)) return "embedding";
  if (id.includes("rerank")) return "rerank";
  if (hasToken(TTS_TOKENS) || id.includes("text-to-speech")) return "tts";
  if (
    hasToken(SPEECH_TOKENS) ||
    id.includes("transcri") ||
    id.includes("speech-to-text")
  ) {
    return "speech";
  }
  return "unknown";
}

interface OmlxStatusEntry {
  id?: unknown;
  model_alias?: unknown;
  model_type?: unknown;
}

/**
 * Join the `/v1/models` ids with the oMLX status entries. The alias wins over
 * the folder id. A model with no status entry, or with a type that this app
 * does not know, gets its kind from the name rules.
 */
function classify(
  ids: string[],
  status: OmlxStatusEntry[] | null,
): ServerModel[] {
  const byAlias = new Map<string, OmlxStatusEntry>();
  const byId = new Map<string, OmlxStatusEntry>();
  for (const entry of status ?? []) {
    if (typeof entry.model_alias === "string") {
      byAlias.set(entry.model_alias, entry);
    }
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }

  return ids.map((id) => {
    const entry = byAlias.get(id) ?? byId.get(id);
    const type = typeof entry?.model_type === "string" ? entry.model_type : "";
    const fromServer = OMLX_TYPE_KINDS[type];
    return fromServer
      ? { id, kind: fromServer, kind_source: "server" as const }
      : { id, kind: kindFromName(id), kind_source: "name" as const };
  });
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Step 1 of the probe: the model list. It must pass. */
async function fetchServerModelIds(
  root: string,
  apiKey: string | null,
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(omlxModelsUrl(root), {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ServerProbeError(
      "unreachable",
      err instanceof Error ? err.message : "Server not reachable",
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ServerProbeError("unauthorized", `Server answered ${res.status}`);
  }
  if (res.status === 404) {
    throw new ServerProbeError("not_openai", "Server has no /v1/models");
  }
  if (!res.ok) {
    throw new ServerProbeError(
      "unreachable",
      `Server returned ${res.status}: ${res.statusText}`,
    );
  }
  let body: { data?: unknown };
  try {
    body = (await res.json()) as { data?: unknown };
  } catch {
    throw new ServerProbeError("not_openai", "Reply is not JSON");
  }
  if (!Array.isArray(body.data)) {
    throw new ServerProbeError("not_openai", "Reply has no model list");
  }
  return body.data.flatMap((m: { id?: unknown }) =>
    typeof m?.id === "string" ? [m.id] : [],
  );
}

/** Step 2: the oMLX status list. It never fails the probe. */
async function fetchOmlxStatus(
  root: string,
  apiKey: string | null,
): Promise<OmlxStatusEntry[] | null> {
  try {
    const res = await fetch(`${root}/v1/models/status`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: unknown };
    return Array.isArray(body.models)
      ? (body.models as OmlxStatusEntry[])
      : null;
  } catch {
    return null;
  }
}

/** Probe a server (section 5.3). Throws {@link ServerProbeError}. */
export async function probeServer(
  baseUrl: string,
  apiKey: string | null,
): Promise<ServerProbeResult> {
  const root = normalizeOmlxRoot(baseUrl);
  const ids = await fetchServerModelIds(root, apiKey);
  const status = await fetchOmlxStatus(root, apiKey);
  return {
    flavor: status ? "omlx" : "openai",
    models: classify(ids, status),
  };
}
