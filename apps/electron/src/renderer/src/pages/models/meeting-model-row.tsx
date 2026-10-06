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
import { parseMeetingSttModel } from "@openstyle/validations";
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

export function MeetingModelRow({
  value,
  voiceModels,
}: {
  /** Raw persisted `meeting_stt_model` value; `""` or absent = dictation. */
  value: string | undefined;
  /** The configured models where `type === "voice"`. */
  voiceModels: ConfiguredModel[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const stored = parseMeetingSttModel(value);
  const storedValue = stored ? storedOptionValue(stored) : "";
  const storedInList =
    stored !== null && voiceModels.some((m) => optionValue(m) === storedValue);
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
              {voiceModels.map((m) => (
                <SelectItem key={optionValue(m)} value={optionValue(m)}>
                  {m.model_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {stored && !storedInList && (
            <p className="text-destructive text-[11px] leading-snug">
              {t("models.meetingModel.notConfigured")}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
