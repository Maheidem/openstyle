import {
  type LocalModelRef,
  type MissingModel,
  type ModelMissingTask,
  parseMeetingSttModel,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { readSetting } from "./db.js";
import { resolveTaskModel } from "./llm/task-profiles.js";
import { getMlxAsrModel, MLX_ASR_PROVIDER_ID } from "./mlx-asr/constants.js";
import { isMlxModelDownloaded } from "./mlx-asr/models.js";
import { getMlxEmbedModel } from "./mlx-embed/constants.js";
import { isMlxEmbedModelDownloaded } from "./mlx-embed/models.js";
import { getSearchEmbeddingModelId } from "./mlx-embed/server.js";
import { getMlxLlmModel, MLX_LLM_PROVIDER_ID } from "./mlx-llm/constants.js";
import { isMlxLlmModelDownloaded } from "./mlx-llm/models.js";
import { stripModelPrefix } from "./model-id.js";
import { getDefaultModels } from "./providers.js";
import { getWhisperModel, WHISPER_PROVIDER_ID } from "./whisper/constants.js";
import { getDownloadedModelPath } from "./whisper/models.js";

// The models that the user selected for a task, which are not on the disk.
// Only stat calls on the Hugging Face cache and the whisper folder: no network,
// no worker start. The Models nav badge and the page banners read it.

/** The reference of a selected speech model, or null when it is not local. */
function voiceRef(
  provider: string,
  modelId: string,
): { ref: LocalModelRef; present: boolean } | null {
  if (provider === MLX_ASR_PROVIDER_ID) {
    const def = getMlxAsrModel(stripModelPrefix(provider, modelId));
    if (!def) return null;
    return {
      ref: { engine: "mlx", defId: def.id, name: def.displayName },
      present: isMlxModelDownloaded(def),
    };
  }
  if (provider === WHISPER_PROVIDER_ID) {
    const def = getWhisperModel(stripModelPrefix(provider, modelId));
    if (!def) return null;
    return {
      ref: { engine: "whisper", defId: def.id, name: def.displayName },
      present: getDownloadedModelPath(def.id) !== null,
    };
  }
  return null;
}

/** All selected local models that are not on the disk, one entry for each model. */
export async function listMissingModels(): Promise<MissingModel[]> {
  const found = new Map<string, MissingModel>();
  const add = (task: ModelMissingTask, ref: LocalModelRef): void => {
    const key = `${ref.engine}:${ref.defId}`;
    const entry = found.get(key);
    if (entry) {
      if (!entry.tasks.includes(task)) entry.tasks.push(task);
    } else {
      found.set(key, { ...ref, tasks: [task] });
    }
  };

  const defaults = getDefaultModels();
  if (defaults.voice) {
    const v = voiceRef(defaults.voice.provider, defaults.voice.model_id);
    if (v && !v.present) add("dictation", v.ref);
  }
  const meetingStt = parseMeetingSttModel(
    readSetting(SETTINGS_KEYS.meetingSttModel),
  );
  const meetingVoice = meetingStt
    ? voiceRef(meetingStt.provider, meetingStt.modelId)
    : defaults.voice
      ? voiceRef(defaults.voice.provider, defaults.voice.model_id)
      : null;
  if (meetingVoice && !meetingVoice.present) {
    add("meetingTranscribe", meetingVoice.ref);
  }

  const llmTasks: [ModelMissingTask, Parameters<typeof resolveTaskModel>[0]][] =
    [
      ["meetingEnhance", "meetingEnhance"],
      ["meetingSummarize", "meetingSummarize"],
    ];
  if (readSetting(SETTINGS_KEYS.llmCleanup) === "true") {
    llmTasks.push(["cleanup", "cleanup"]);
  }
  if (readSetting(SETTINGS_KEYS.meetingChatEnabled) === "true") {
    llmTasks.push(["ask", "meetingChat"]);
  }
  for (const [task, taskId] of llmTasks) {
    try {
      const { provider, modelId } = await resolveTaskModel(taskId);
      if (provider !== MLX_LLM_PROVIDER_ID) continue;
      const def = getMlxLlmModel(stripModelPrefix(provider, modelId));
      if (def && !isMlxLlmModelDownloaded(def)) {
        add(task, { engine: "mlx-llm", defId: def.id, name: def.displayName });
      }
    } catch {
      // No model for this task: nothing is selected, so nothing is missing.
    }
  }

  if (readSetting(SETTINGS_KEYS.meetingChatEnabled) === "true") {
    const embedId = getSearchEmbeddingModelId();
    const def = embedId ? getMlxEmbedModel(embedId) : undefined;
    if (def && !isMlxEmbedModelDownloaded(def)) {
      add("search", {
        engine: "mlx-embed",
        defId: def.id,
        name: def.displayName,
      });
    }
  }
  return [...found.values()];
}
