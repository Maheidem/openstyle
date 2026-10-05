import {
  type AvailableModel,
  displayProviderName,
  LLM_PROVIDERS,
  VOICE_PROVIDERS,
} from "@renderer/lib/models";

export function groupByProvider(
  list: AvailableModel[],
  type: "voice" | "llm",
): Map<string, { providerName: string; models: AvailableModel[] }> {
  const map = new Map<
    string,
    { providerName: string; models: AvailableModel[] }
  >();
  const allowed = type === "voice" ? VOICE_PROVIDERS : LLM_PROVIDERS;
  for (const m of list) {
    if (m.type !== type) continue;
    if (!allowed.includes(m.provider_id)) continue;
    // The built-in voice engines have their own dedicated section.
    if (type === "voice" && m.provider_id === "local-whisper") continue;
    if (type === "voice" && m.provider_id === "local-mlx") continue;
    let entry = map.get(m.provider_id);
    if (!entry) {
      entry = {
        providerName: displayProviderName(m.provider_id, m.provider_name),
        models: [],
      };
      map.set(m.provider_id, entry);
    }
    entry.models.push(m);
  }
  return map;
}
