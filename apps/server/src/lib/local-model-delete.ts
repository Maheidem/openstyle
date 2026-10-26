import { createAppLogger } from "@openstyle/utils";
import {
  parseLlmTaskAssignments,
  parseMeetingSttModel,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import type { Context } from "hono";
import {
  deleteSetting,
  getDb,
  readSetting,
  withTransaction,
  writeSetting,
} from "./db.js";
import { listJobs, type MeetingJobKind } from "./meetings/job-registry.js";

const log = createAppLogger("models");

/** Why a local model cannot be deleted now. */
export type DeleteBlocker = "downloading" | "in_use";

/** The model that becomes the default when the deleted model was the default. */
export interface DefaultFallback {
  provider: string;
  /** The full model id, for example `local-mlx-llm/gemma-4-e2b-qat-4bit`. */
  modelId: string;
  modelName: string;
}

const BLOCKER_MESSAGES: Record<DeleteBlocker, string> = {
  downloading: "The model is downloading. Cancel the download first.",
  in_use: "The model is in use now. Try again when the job is done.",
};

/** The 409 answer of a delete route when the model cannot be deleted now. */
export function deleteBlockedResponse(c: Context, blocker: DeleteBlocker) {
  return c.json(
    { ok: false as const, error: BLOCKER_MESSAGES[blocker], code: blocker },
    409,
  );
}

/** True while a meeting job of one of these kinds holds a slot. */
export function hasMeetingJobOfKind(
  kinds: ReadonlySet<MeetingJobKind>,
): boolean {
  return listJobs().some((job) => job.kind !== null && kinds.has(job.kind));
}

/**
 * Remove every pointer to a local model whose files are deleted:
 * - its `model_configs` row;
 * - the `meeting_stt_model` setting (voice) or a task model override (llm)
 *   that names it.
 * When the model was the default of its type and `fallback` is set,
 * `fallback` becomes the default. Otherwise the type has no default model.
 * Returns the model id of the new default, or null.
 */
export function releaseDeletedModel(opts: {
  type: "voice" | "llm";
  provider: string;
  modelId: string;
  fallback: DefaultFallback | null;
}): string | null {
  const { type, provider, modelId, fallback } = opts;
  let newDefault: string | null = null;
  try {
    const db = getDb();
    withTransaction(db, () => {
      const row = db
        .prepare(
          "SELECT is_default FROM model_configs WHERE type = ? AND provider = ? AND model_id = ?",
        )
        .get(type, provider, modelId) as { is_default: number } | undefined;
      db.prepare(
        "DELETE FROM model_configs WHERE type = ? AND provider = ? AND model_id = ?",
      ).run(type, provider, modelId);
      if (row?.is_default !== 1 || !fallback) return;
      db.prepare("UPDATE model_configs SET is_default = 0 WHERE type = ?").run(
        type,
      );
      db.prepare(
        `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(provider, model_id, type) DO UPDATE SET
           model_name = excluded.model_name,
           is_default = 1`,
      ).run(fallback.provider, fallback.modelId, fallback.modelName, type);
      newDefault = fallback.modelId;
    });
  } catch {
    // The DB can be closed during shutdown.
    return null;
  }

  if (type === "voice") {
    const meeting = parseMeetingSttModel(
      readSetting(SETTINGS_KEYS.meetingSttModel),
    );
    // Without the setting, meetings use the dictation model.
    if (meeting?.provider === provider && meeting.modelId === modelId) {
      deleteSetting(SETTINGS_KEYS.meetingSttModel);
    }
  } else {
    const assignments = parseLlmTaskAssignments(
      readSetting(SETTINGS_KEYS.llmTaskAssignments),
    );
    let changed = false;
    for (const assignment of Object.values(assignments)) {
      const o = assignment?.modelOverride;
      if (o?.provider === provider && o.model_id === modelId) {
        delete assignment.modelOverride;
        changed = true;
      }
    }
    if (changed) {
      writeSetting(
        SETTINGS_KEYS.llmTaskAssignments,
        JSON.stringify(assignments),
      );
    }
  }

  log.info(
    `released deleted ${type} model ${modelId}${newDefault ? `; new default ${newDefault}` : ""}`,
  );
  return newDefault;
}
