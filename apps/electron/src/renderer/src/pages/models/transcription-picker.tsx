import { Button } from "@renderer/components/ui/button";
import { ON_DEVICE_PHRASE } from "@renderer/lib/utils";
import { ExternalLink, Key, Laptop, Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  PICKER_MODAL_BODY,
  PickerModalHeader,
  PickerOption,
} from "./picker-option";
import type { ConfiguredModel } from "./types";
import type { UseModels } from "./use-models";
import { displayName } from "./utils";

const LOCAL_PROVIDERS = new Set(["local-whisper", "local-mlx"]);

export function recommendedVoiceKey(
  items: { key: string; localEngine?: string }[],
): string {
  return items.some((it) => it.localEngine === "mlx")
    ? "local-mlx/qwen3-0.6b-8bit"
    : "local-whisper/small-q5_1";
}

function isLocalVoice(voice: ConfiguredModel | undefined): boolean {
  return voice?.provider === "local-whisper" || voice?.provider === "local-mlx";
}

function isByokVoice(voice: ConfiguredModel | undefined): boolean {
  if (!voice) return false;
  return !LOCAL_PROVIDERS.has(voice.provider);
}

/** Modal tier picker: browse on-device → browse BYOK. */
export function TranscriptionPicker({
  m,
  onClose,
  onBrowseLocal,
  onBrowseCloud,
}: {
  m: UseModels;
  onClose: () => void;
  onBrowseLocal: () => void;
  onBrowseCloud: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const localItems = m.voiceItems.filter((it) => it.kind === "local");
  const byokCount = m.voiceItems.filter((it) => it.kind === "cloud").length;

  const localActive = isLocalVoice(m.defaultVoice);
  const byokActive = isByokVoice(m.defaultVoice);

  const selectedLocal = localItems.find((it) => it.selected);
  const localHint = selectedLocal
    ? selectedLocal.name
    : localItems.length > 0
      ? t("models.picker.modelCount", { count: localItems.length })
      : t("models.picker.unavailableOnDevice");

  const byokLabel = byokActive
    ? (m.defaultVoice?.model_name ?? displayName(m.defaultVoice!.provider))
    : byokCount > 0
      ? t("models.picker.cloudModelCount", { count: byokCount })
      : t("models.picker.byokProviders");

  return (
    <>
      <PickerModalHeader
        icon={Mic}
        title={t("models.picker.transcription")}
        onClose={onClose}
      />
      <div className={PICKER_MODAL_BODY}>
        <div className="border-border divide-border overflow-hidden rounded-[12px] border divide-y">
          <PickerOption
            icon={Laptop}
            title={t("models.picker.onDevice", { phrase: ON_DEVICE_PHRASE })}
            hint={localHint}
            active={localActive}
            onClick={onBrowseLocal}
            browseLabel={t("models.picker.browseLocalVoice")}
          />
          <PickerOption
            icon={Key}
            title={t("models.picker.yourApiKey")}
            hint={byokLabel}
            active={byokActive}
            onClick={onBrowseCloud}
            browseLabel={t("models.picker.browseByokVoice")}
          />
        </div>
      </div>
    </>
  );
}

export function OpenModelSourceButton({
  url,
}: {
  url: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void window.api?.openExternal(url);
      }}
    >
      <ExternalLink data-icon="inline-start" />
      {t("models.picker.openModelSource")}
    </Button>
  );
}
