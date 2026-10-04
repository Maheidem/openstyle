import { useCoachPress } from "@renderer/components/hotkey-demo";
import { ModelSetupPanel } from "@renderer/components/model-setup-panel";
import { CoachStrip } from "@renderer/components/onboarding/coach-strip";
import { EmailDraft } from "@renderer/components/onboarding/email-draft";
import { Button } from "@renderer/components/ui/button";
import { formatAcceleratorKeys } from "@renderer/hooks/use-hotkey-recorder";
import type { VoiceItem } from "@renderer/lib/models";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HotkeyRebindControl, StepHeading } from "./shared";

// ---------------------------------------------------------------------------
// Step 4 — Dictate into the Gmail draft (replaces the old tutorial step:
// same model setup + hotkey rebind, new practice surface).
// ---------------------------------------------------------------------------
export function DraftStep({
  hotkey,
  remixHotkey,
  onHotkeyRecorded,
  localModel,
  onDownloadLocal,
  onRetryLocal,
  blockedReason,
  body,
  onBodyChange,
  onBack,
  onContinue,
}: {
  hotkey: string;
  remixHotkey: string;
  onHotkeyRecorded: (accelerator: string) => void;
  localModel: VoiceItem | undefined;
  onDownloadLocal: () => void;
  onRetryLocal: () => void;
  // Why Continue is disabled. null means the user can continue.
  blockedReason: "downloading" | "notReady" | null;
  body: string;
  onBodyChange: (text: string) => void;
  onBack: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { phase, getLiveLevel } = useCoachPress("dictation");

  const statusLabel =
    phase === "pressed"
      ? t("onboarding.draft.statusListening")
      : phase === "result"
        ? t("onboarding.draft.statusLanded")
        : t("onboarding.draft.statusReady");

  return (
    <div className="w-full max-w-[1100px]">
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <div>
          <StepHeading title={t("onboarding.draft.title")} />

          <CoachStrip
            keys={formatAcceleratorKeys(hotkey)}
            phase={phase}
            instructionPrefix={t("onboarding.draft.instructionPrefix")}
            instructionSuffix={t("onboarding.draft.instructionSuffix")}
            sayText={t("onboarding.draft.sayText")}
            statusLabel={statusLabel}
            statusEmphasis={phase !== "idle"}
            getLiveLevel={getLiveLevel}
          />

          <ModelSetupPanel
            model={localModel}
            onDownload={onDownloadLocal}
            onRetry={onRetryLocal}
          />
        </div>

        <div className="flex justify-center lg:justify-end">
          <EmailDraft body={body} onBodyChange={onBodyChange} stage="dictate" />
        </div>
      </div>

      <HotkeyRebindControl
        hotkey={hotkey}
        target="dictation"
        conflictHotkey={remixHotkey}
        conflictNotice={t("settings.recording.conflict")}
        onRecorded={onHotkeyRecorded}
      />

      <div className="mt-7 flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <div className="flex flex-col items-end gap-1.5">
          {blockedReason && (
            <p className="text-muted-foreground text-[11px]">
              {blockedReason === "downloading"
                ? t("onboarding.modelSetup.waitingWhileDownloading")
                : t("onboarding.modelSetup.waitingToFinish")}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={onContinue}
              disabled={!!blockedReason}
              className="text-muted-foreground h-auto px-2 py-1 text-[12px]"
            >
              {t("onboarding.draft.skip")}
            </Button>
            <Button
              variant="ink"
              onClick={onContinue}
              disabled={!!blockedReason || !body.trim()}
            >
              {t("common.continue")}
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
