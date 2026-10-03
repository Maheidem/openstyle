import { KeyComboDisplay } from "@renderer/components/key-combo";
import { Button } from "@renderer/components/ui/button";
import {
  acceleratorsEqual,
  comboDisplayKeys,
  formatAcceleratorKeys,
  keyDisplayLabel,
  useHotkeyRecorder,
} from "@renderer/hooks/use-hotkey-recorder";
import { Keyboard } from "lucide-react";
import { useTranslation } from "react-i18next";

export function StepHeading({ title }: { title: string }): React.JSX.Element {
  return (
    <h1 className="display text-foreground m-0 mb-6 text-[30px] leading-[1.1] font-medium">
      {title}
    </h1>
  );
}

// ---------------------------------------------------------------------------
// Hotkey rebind — a single minimal control, shared by the draft (dictation
// hotkey) and remix (remix hotkey) steps.
// ---------------------------------------------------------------------------
export function HotkeyRebindControl({
  hotkey,
  target,
  conflictHotkey,
  conflictNotice,
  onRecorded,
  onStartRecording,
}: {
  hotkey: string;
  target: "dictation" | "remix";
  /** The other feature's hotkey — recording it here is refused. */
  conflictHotkey?: string;
  conflictNotice?: string;
  onRecorded: (accelerator: string) => void;
  onStartRecording?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const {
    state: recorderState,
    liveModifiers,
    capturedCombo,
    canSaveRecording,
    needsModifierOrMouseButton,
    blockedNotice,
    startRecording,
    cancelRecording,
  } = useHotkeyRecorder(onRecorded, {
    target,
    isBlocked: conflictHotkey
      ? (accel) => acceleratorsEqual(accel, conflictHotkey)
      : undefined,
  });

  const liveKeys = liveModifiers.map(keyDisplayLabel);
  const draftKeys = capturedCombo ? comboDisplayKeys(capturedCombo) : liveKeys;
  const captureHint = needsModifierOrMouseButton
    ? "Add a modifier or side mouse button · Esc to cancel"
    : canSaveRecording
      ? "Release to save · Esc to cancel"
      : "Press a modifier or side mouse button… · Esc to cancel";

  return (
    <div className="mt-5 flex justify-start">
      {recorderState === "idle" ? (
        <div className="relative inline-flex">
          <Button
            variant="outline"
            onClick={() => {
              onStartRecording?.();
              startRecording();
            }}
            className="bg-card hover:bg-secondary h-auto gap-3 rounded-[10px] px-3.5 py-2.5"
          >
            <Keyboard className="text-muted-foreground shrink-0" />
            <KeyComboDisplay keys={formatAcceleratorKeys(hotkey)} />
            <span className="text-muted-foreground ml-1 text-[12.5px]">
              {t("common.change")}
            </span>
          </Button>
          {blockedNotice && conflictNotice && (
            <div className="bg-popover text-popover-foreground border-border shadow-soft absolute top-[calc(100%+6px)] left-0 z-20 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs">
              {conflictNotice}
            </div>
          )}
        </div>
      ) : (
        <div className="border-primary bg-accent inline-flex items-center gap-3 rounded-[10px] border px-3.5 py-2.5">
          <Keyboard className="text-accent-foreground h-4 w-4 shrink-0" />
          {draftKeys.length > 0 ? (
            <KeyComboDisplay keys={draftKeys} variant="dim" />
          ) : null}
          <span className="text-accent-foreground text-[12px]">
            {captureHint}
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={cancelRecording}
            className="ml-1"
          >
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}
