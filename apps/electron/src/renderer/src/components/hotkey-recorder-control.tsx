import { KeyComboDisplay } from "@renderer/components/key-combo";
import { Button } from "@renderer/components/ui/button";
import {
  comboDisplayKeys,
  formatAcceleratorKeys,
  keyDisplayLabel,
  useHotkeyRecorder,
} from "@renderer/hooks/use-hotkey-recorder";
import { cn } from "@renderer/lib/utils";
import { Keyboard } from "lucide-react";
import { useTranslation } from "react-i18next";

const NOTICE_SIDE = { left: "left-0", right: "right-0" } as const;

function Notice({
  side,
  children,
}: {
  side: keyof typeof NOTICE_SIDE;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "bg-popover text-popover-foreground border-border shadow-[0_4px_16px_rgba(29,33,41,.08)] absolute top-[calc(100%+6px)] z-20 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs",
        NOTICE_SIDE[side],
      )}
    >
      {children}
    </div>
  );
}

/**
 * One hotkey recorder for the Settings page: an idle button that shows the
 * bound hotkey, and a capture pill that shows the keys while the user records.
 * It owns its `useHotkeyRecorder` instance, so each control records alone.
 *
 * - `onClear` adds a Clear button next to the idle button and puts the
 *   control in the compact "language hotkey" layout.
 * - `needsModifierNotice` is the text for the "add a modifier" popover. Only
 *   the main dictation hotkey shows it.
 * - `conflictNotice` is the popover text when `isBlocked` refuses a hotkey.
 */
export function HotkeyRecorderControl({
  accelerator,
  target,
  isBlocked,
  onRecorded,
  onClear,
  conflictNotice,
  needsModifierNotice,
  noticeSide = "right",
}: {
  accelerator?: string;
  target?: "dictation" | "remix" | "language";
  isBlocked: (accelerator: string) => boolean;
  onRecorded: (accelerator: string) => void;
  onClear?: () => void;
  conflictNotice: string;
  needsModifierNotice?: string;
  noticeSide?: keyof typeof NOTICE_SIDE;
}): React.JSX.Element {
  const { t } = useTranslation();
  const {
    state,
    liveModifiers,
    capturedCombo,
    canSaveRecording,
    needsModifierOrMouseButton,
    invalidReleaseNotice,
    blockedNotice,
    startRecording,
    cancelRecording,
  } = useHotkeyRecorder(onRecorded, { target, isBlocked });

  const liveKeys = liveModifiers.map(keyDisplayLabel);
  const draftKeys = capturedCombo ? comboDisplayKeys(capturedCombo) : liveKeys;
  const captureHint = needsModifierOrMouseButton
    ? "Add a modifier or side mouse button · Esc to cancel"
    : canSaveRecording
      ? "Release to save · Esc to cancel"
      : "Press a modifier or side mouse button... · Esc to cancel";
  const showNeedsModifier = !!needsModifierNotice && invalidReleaseNotice;

  if (state === "idle") {
    return (
      <div
        className={cn("relative inline-flex", onClear && "items-center gap-2")}
      >
        <Button
          variant="outline"
          onClick={startRecording}
          className="h-auto max-w-full flex-wrap gap-3 px-3.5 py-2"
        >
          <Keyboard className="text-muted-foreground size-4 shrink-0" />
          {accelerator ? (
            <>
              <KeyComboDisplay keys={formatAcceleratorKeys(accelerator)} />
              <span className="text-muted-foreground ml-1 text-xs">
                {t("common.change")}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground text-sm">
              {t("common.change")}
            </span>
          )}
        </Button>
        {accelerator && onClear && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="text-muted-foreground"
          >
            {t("common.clear")}
          </Button>
        )}
        {(blockedNotice || showNeedsModifier) && (
          <Notice side={noticeSide}>
            {blockedNotice ? conflictNotice : needsModifierNotice}
          </Notice>
        )}
      </div>
    );
  }

  return (
    <div className="border-border bg-secondary relative inline-flex max-w-full flex-wrap items-center gap-3 rounded-full border px-3.5 py-2">
      <Keyboard className="text-primary h-4 w-4 shrink-0" />
      {draftKeys.length > 0 ? (
        <>
          <KeyComboDisplay keys={draftKeys} variant="dim" />
          <span className="text-muted-foreground text-xs">{captureHint}</span>
        </>
      ) : (
        <span className="text-muted-foreground animate-pulse text-sm">
          {captureHint}
        </span>
      )}
      {showNeedsModifier && <Notice side="right">{needsModifierNotice}</Notice>}
      <Button
        variant="outline"
        size="sm"
        onClick={cancelRecording}
        className="ml-1"
      >
        {t("common.cancel")}
      </Button>
    </div>
  );
}
