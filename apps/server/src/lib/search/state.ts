import type { SearchOffReason } from "@openstyle/validations";
import { getMlxEmbedModel } from "../mlx-embed/constants.js";
import { isMlxEmbedModelDownloaded } from "../mlx-embed/models.js";
import { getSearchEmbeddingModelId } from "../mlx-embed/server.js";
import { getExtensionState } from "./extension.js";

// The one switch of search (specs/local-semantic-search.md 9.1).

export type SearchState =
  | { state: "on"; modelId: string }
  | { state: "off"; reason: SearchOffReason };

export function searchState(): SearchState {
  const ext = getExtensionState();
  if (ext.state !== "loaded") {
    return { state: "off", reason: ext.reason ?? "extension_load_failed" };
  }
  const modelId = getSearchEmbeddingModelId();
  const def = modelId ? getMlxEmbedModel(modelId) : undefined;
  if (!modelId || !def || !isMlxEmbedModelDownloaded(def)) {
    return { state: "off", reason: "no_model" };
  }
  return { state: "on", modelId };
}
