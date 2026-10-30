import {
  type LlmTaskAssignments,
  type LlmTaskId,
  profileLinkKey,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { getDb, writeSetting } from "../../src/lib/db.js";

/**
 * Store task assignments as the Models page does: the blob, and the link of
 * each task to the model it runs on (the override, else the default LLM). The
 * link map is replaced, so a test starts from exactly these links.
 */
export function putTaskAssignments(assignments: LlmTaskAssignments): void {
  const row = getDb()
    .prepare(
      "SELECT provider, model_id FROM model_configs WHERE type = 'llm' AND is_default = 1",
    )
    .get() as { provider: string; model_id: string } | undefined;
  const links: Record<string, Partial<Record<LlmTaskId, unknown>>> = {};
  for (const [task, a] of Object.entries(assignments) as [
    LlmTaskId,
    NonNullable<LlmTaskAssignments[LlmTaskId]>,
  ][]) {
    if (a.mode === "auto") continue;
    const target = a.modelOverride
      ? { provider: a.modelOverride.provider, id: a.modelOverride.model_id }
      : row
        ? { provider: row.provider, id: row.model_id }
        : null;
    if (!target) continue;
    const key = profileLinkKey(target.provider, target.id);
    (links[key] ??= {})[task] = {
      mode: a.mode,
      ...(a.presetId ? { presetId: a.presetId } : {}),
      ...(a.params ? { params: a.params } : {}),
    };
  }
  writeSetting(SETTINGS_KEYS.llmTaskAssignments, JSON.stringify(assignments));
  writeSetting(SETTINGS_KEYS.llmProfileLinks, JSON.stringify(links));
  writeSetting(SETTINGS_KEYS.llmProfileLinksMigrated, "1");
}
