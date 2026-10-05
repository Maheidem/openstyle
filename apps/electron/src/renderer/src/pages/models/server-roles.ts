import {
  parseServerModelId,
  SERVER_PROVIDER_ID,
  type ServerModelKind,
} from "@openstyle/validations";
import type { ApiClient, ApiRes } from "@renderer/lib/api";
import type { ConfiguredModel } from "@renderer/lib/models";
import { displayProviderName } from "@renderer/lib/models";
import type { TFunction } from "i18next";

/** One own server with its live probe (`GET /api/servers`). */
export type ServerView = ApiRes<ApiClient["api"]["servers"]["$get"]>[number];

export type ModelRole = "voice" | "llm";

// Role fit (specs/model-picker-groups.md section 4.3). Transcription takes
// speech models only. Every LLM role also takes `unknown`, because an unknown
// name is more likely a chat model than not.
const ROLE_KINDS: Record<ModelRole, readonly ServerModelKind[]> = {
  voice: ["speech"],
  llm: ["llm", "unknown"],
};

export function kindFitsRole(kind: ServerModelKind, role: ModelRole): boolean {
  return ROLE_KINDS[role].includes(kind);
}

/** The server and the listed model that a configured server model id names. */
export function findServerModel(
  servers: ServerView[],
  modelId: string,
): { server: ServerView; kind: ServerModelKind | null } | null {
  const parsed = parseServerModelId(modelId);
  if (!parsed) return null;
  const server = servers.find((s) => s.id === parsed.serverId);
  if (!server) return null;
  const listed = server.models.find((m) => m.id === parsed.model);
  return { server, kind: listed?.kind ?? null };
}

/**
 * True when the default voice model runs on an own server that lists it with a
 * kind other than `speech`. A server that is down or does not list the model
 * gives no kind, so nothing is claimed.
 */
export function voiceCannotTranscribe(
  voice: ConfiguredModel | undefined,
  servers: ServerView[],
): boolean {
  if (voice?.provider !== SERVER_PROVIDER_ID) return false;
  const found = findServerModel(servers, voice.model_id);
  return !!found?.kind && !kindFitsRole(found.kind, "voice");
}

/** The "via ..." label of a configured model: the server name, or the provider. */
export function providerLabel(
  model: ConfiguredModel,
  servers: ServerView[],
  t: TFunction,
): string {
  if (model.provider !== SERVER_PROVIDER_ID) {
    return displayProviderName(model.provider);
  }
  return (
    findServerModel(servers, model.model_id)?.server.name ??
    t("models.picker.ownServer")
  );
}
