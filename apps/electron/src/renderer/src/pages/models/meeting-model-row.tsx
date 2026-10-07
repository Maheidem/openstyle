/**
 * The "Meeting transcription" row (specs/meeting-transcription-v2.md §3.3,
 * phase 1). One Select: "Same as dictation" plus one item per configured
 * voice model. The whole write path is the `meeting_stt_model` setting —
 * "Same as dictation" stores the empty string, which the server reads as
 * "use the dictation model"; a chosen model stores its JSON pair.
 *
 * The reload note is the standing warning from the spec: a DIFFERENT local
 * meeting model reloads in the single MLX worker while dictation runs, so
 * the server also yields to dictation for it (transcriber's
 * `differsFromDictation` path).
 */
import {
  parseMeetingSttModel,
  SERVER_PROVIDER_ID,
} from "@openstyle/validations";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import type { ConfiguredModel } from "@renderer/lib/models";
import { queryKeys } from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { SETTINGS_KEYS } from "@shared/settings-keys";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { findServerModel, kindFitsRole, type ServerView } from "./server-roles";

// Radix `Select` reserves `""` internally to mean "no selection" and throws
// if an item uses it as its value — same reason `task-profiles-section.tsx`
// uses its `USE_DEFAULT_MODEL_VALUE` sentinel for "use the default model".
const SAME_AS_DICTATION = "__same_as_dictation__";

function optionValue(m: { provider: string; model_id: string }): string {
  return `${m.provider}/${m.model_id}`;
}

function storedOptionValue(m: { provider: string; modelId: string }): string {
  return `${m.provider}/${m.modelId}`;
}

/**
 * I3: a configured voice model fits the meeting transcription role by the
 * same rule as the dictation voice picker — a non-speech kind reported by
 * a live own server (LLM/TTS/embedding stored as voice after migration 36)
 * does not fit. A missing kind (server down, or model not listed) stays.
 */
function fitsVoiceRole(model: ConfiguredModel, servers: ServerView[]): boolean {
  if (model.provider !== SERVER_PROVIDER_ID) return true;
  const found = findServerModel(servers, model.model_id);
  return !found?.kind || kindFitsRole(found.kind, "voice");
}

export function MeetingModelRow({
  value,
  voiceModels,
  servers,
  alignerStatus,
}: {
  /** Raw persisted `meeting_stt_model` value; `""` or absent = dictation. */
  value: string | undefined;
  /** The configured models where `type === "voice"`. */
  voiceModels: ConfiguredModel[];
  /** Live own-server views, for the voice-role filter (I3). */
  servers: ServerView[];
  /** I4b (spec 3.6): the aligner helper's download state — the one-line
   * "Word timing for speaker changes" status. `null`/absent = not
   * available on this Mac. */
  alignerStatus?: {
    status: "not_downloaded" | "downloading" | "ready" | "error";
    downloadProgress?: { percent: number };
  } | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const stored = parseMeetingSttModel(value);
  const storedValue = stored ? storedOptionValue(stored) : "";
  // I3: same voice-role rule as the dictation voice picker — non-speech
  // server kinds are filtered out of the Select; unknown kinds stay.
  const visibleModels = voiceModels.filter((m) => fitsVoiceRole(m, servers));
  const storedInList =
    stored !== null &&
    visibleModels.some((m) => optionValue(m) === storedValue);
  // I3: the stored model itself, checked by the same rule — a non-speech
  // kind keeps the model visible with a warning instead of hiding it.
  const storedFitsVoiceRole =
    stored === null ||
    stored.provider !== SERVER_PROVIDER_ID ||
    (() => {
      const found = findServerModel(servers, stored.modelId);
      return !found?.kind || kindFitsRole(found.kind, "voice");
    })();
  const selected = stored ? storedValue : SAME_AS_DICTATION;

  const onValueChange = (next: string): void => {
    const ok =
      next === SAME_AS_DICTATION
        ? putSetting(SETTINGS_KEYS.meetingSttModel, "")
        : (() => {
            const model = voiceModels.find((m) => optionValue(m) === next);
            if (!model) return Promise.resolve(true);
            return putSetting(
              SETTINGS_KEYS.meetingSttModel,
              JSON.stringify({
                provider: model.provider,
                model_id: model.model_id,
                model_name: model.model_name,
              }),
            );
          })();
    void ok.then((saved) => {
      if (saved) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      }
    });
  };

  return (
    <section>
      <div className="border-border bg-card flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-[18px] py-[13px]">
        <div className="min-w-0">
          <span className="text-foreground text-[13.5px] font-semibold">
            {t("models.meetingModel.label")}
          </span>
          <p className="text-muted-foreground mt-0.5 text-[11.5px] leading-snug">
            {t("models.meetingModel.reloadNote")}
          </p>
          <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
            {alignerStatus?.status === "ready"
              ? t("models.meetingModel.asrTimingReady")
              : alignerStatus?.status === "downloading"
                ? t("models.meetingModel.asrTimingDownloading", {
                    percent: alignerStatus.downloadProgress?.percent ?? 0,
                  })
                : t("models.meetingModel.asrTimingUnavailable")}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Select value={selected} onValueChange={onValueChange}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SAME_AS_DICTATION}>
                {t("models.meetingModel.sameAsDictation")}
              </SelectItem>
              {stored && !storedInList && (
                <SelectItem value={storedValue}>
                  {stored.modelName ?? stored.modelId}
                </SelectItem>
              )}
              {visibleModels.map((m) => (
                <SelectItem key={optionValue(m)} value={optionValue(m)}>
                  {m.model_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {stored && !storedInList && (
            <p className="text-destructive text-[11px] leading-snug">
              {storedFitsVoiceRole
                ? t("models.meetingModel.notConfigured")
                : t("models.servers.cannotTranscribe")}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
