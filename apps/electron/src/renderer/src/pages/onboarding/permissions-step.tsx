import { Button } from "@renderer/components/ui/button";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import {
  ArrowRight,
  Check,
  ClipboardPaste,
  Keyboard,
  Mic,
  Shield,
} from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { StepHeading } from "./shared";
import { StepHeader } from "./step-header";

// Linux system-setup state reported by the main process (input-group access
// for the hotkey listener, xdotool/wtype for the paste fallback).
export type LinuxSetup = NonNullable<
  Awaited<ReturnType<Window["api"]["checkLinuxSetup"]>>
>;

// ---------------------------------------------------------------------------
// Step 3 — Permissions. macOS asks for each one. The user can say no and still
// finish. The step checks again every second, when the window gets focus, and
// when the user presses "Check again". It never stops on its own.
// ---------------------------------------------------------------------------
export function PermissionsStep({
  counter,
  micStatus,
  accessibilityStatus,
  accessibilityWaiting,
  linuxSetup,
  onRequestMic,
  onOpenMicSettings,
  onOpenAccessibility,
  onCheckAgain,
  onRecheckLinuxSetup,
  onBack,
  onContinue,
}: {
  counter: { index: number; total: number };
  micStatus: string;
  accessibilityStatus: boolean;
  /** The user pressed "Open settings" and the grant is not there yet. */
  accessibilityWaiting: boolean;
  linuxSetup: LinuxSetup | null;
  onRequestMic: () => void;
  onOpenMicSettings: () => void;
  onOpenAccessibility: () => void;
  onCheckAgain: () => void;
  onRecheckLinuxSetup: () => void;
  onBack: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const micGranted = micStatus === "granted";
  const micDenied = micStatus === "denied";
  // On Wayland there is no hotkey fallback without /dev/input access, so
  // missing input access blocks. On X11 the Electron globalShortcut still
  // works (toggle mode), so the card only warns.
  const linuxBlocked = !!linuxSetup?.wayland && !linuxSetup.inputAccess;
  // Accessibility is macOS-only; elsewhere the mic alone unblocks.
  const accOk = !IS_MAC || accessibilityStatus;
  const allGranted = micGranted && accOk && !linuxBlocked;
  // macOS and Windows can deep-link to the OS mic privacy settings.
  const canOpenMicSettings = IS_MAC || IS_WINDOWS;
  const skipKey =
    !micGranted && !accOk
      ? "both"
      : !micGranted
        ? "microphone"
        : "accessibility";

  return (
    <div className="w-full max-w-[480px]">
      <StepHeader
        index={counter.index}
        total={counter.total}
        label={t("onboarding.stepName.permissions")}
      />
      <StepHeading title={t("onboarding.permissions.title")} />
      <p className="text-muted-foreground -mt-3 mb-4 text-[14px] leading-relaxed">
        {t("onboarding.permissions.desc")}
      </p>
      <div className="flex flex-col gap-2.5">
        <PermCard
          icon={Mic}
          testId="onboarding-perm-mic"
          title={t("onboarding.permissions.microphone.title")}
          desc={t("onboarding.permissions.microphone.desc")}
          granted={micGranted}
          action={
            micDenied && canOpenMicSettings ? null : (
              <PermButton onClick={onRequestMic}>
                {t("common.allow")}
              </PermButton>
            )
          }
        >
          {micDenied && (
            <div
              role="alert"
              data-testid="onboarding-mic-denied"
              className="bg-destructive/10 text-destructive mt-2 rounded-[10px] px-3 py-2.5 text-[12.5px] leading-snug"
            >
              <strong>{t("onboarding.permissions.micDeniedTitle")}</strong>
              <br />
              {t("onboarding.permissions.micDenied")}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={onOpenMicSettings}>
                  {t("onboarding.permissions.openSystemSettings")}
                </Button>
              </div>
            </div>
          )}
        </PermCard>

        {IS_MAC && (
          <PermCard
            icon={Shield}
            testId="onboarding-perm-accessibility"
            title={t("onboarding.permissions.accessibility.title")}
            desc={t("onboarding.permissions.accessibility.desc")}
            granted={accessibilityStatus}
            action={
              accessibilityWaiting ? (
                <span className="mono text-[10.5px] tracking-[0.14em] text-amber-700 uppercase dark:text-amber-300">
                  {t("onboarding.permissions.waiting")}
                </span>
              ) : (
                <PermButton onClick={onOpenAccessibility}>
                  {t("common.openSettings")}
                </PermButton>
              )
            }
          >
            {accessibilityWaiting && (
              <p
                data-testid="onboarding-acc-waiting"
                className="text-muted-foreground mt-1.5 mb-0 text-[12px] leading-snug"
              >
                {t("onboarding.permissions.accessibilityWaiting")}
              </p>
            )}
          </PermCard>
        )}

        {IS_LINUX && linuxSetup && (
          <PermCard
            icon={Keyboard}
            title={t("onboarding.permissions.keyboardAccess.title")}
            desc={
              linuxSetup.inputAccess ? (
                t("onboarding.permissions.keyboardAccess.descGranted")
              ) : (
                <>
                  <Trans
                    i18nKey="onboarding.permissions.keyboardAccess.descDenied"
                    components={{ code: <code className="text-foreground" /> }}
                  />
                  {!linuxSetup.wayland &&
                    t("onboarding.permissions.keyboardAccess.toggleNote")}
                </>
              )
            }
            granted={linuxSetup.inputAccess}
            action={
              <PermButton onClick={onRecheckLinuxSetup}>
                {t("common.recheck")}
              </PermButton>
            }
          />
        )}

        {IS_LINUX &&
          linuxSetup &&
          !linuxSetup.pasteTool &&
          !(linuxSetup.wayland && linuxSetup.uinputAccess) && (
            <PermCard
              icon={ClipboardPaste}
              title={t("onboarding.permissions.pasteTool.title")}
              desc={
                <Trans
                  i18nKey="onboarding.permissions.pasteTool.desc"
                  values={{ tool: linuxSetup.pasteToolRequired }}
                  components={{ code: <code className="text-foreground" /> }}
                />
              }
              granted={false}
              action={
                <PermButton onClick={onRecheckLinuxSetup}>
                  {t("common.recheck")}
                </PermButton>
              }
            />
          )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={onCheckAgain}
          data-testid="onboarding-check-again"
        >
          {t("onboarding.permissions.checkAgain")}
        </Button>
        <span className="text-muted-foreground text-[12.5px]">
          {t("onboarding.permissions.checkHint")}
        </span>
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <div className="flex items-center gap-3">
          {!allGranted && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onContinue}
              className="text-muted-foreground h-auto px-2 py-1 text-[12px] underline"
              data-testid="onboarding-continue-without"
            >
              {t(`onboarding.permissions.without.${skipKey}`)}
            </Button>
          )}
          <Button
            disabled={!allGranted}
            onClick={onContinue}
            data-testid="onboarding-permissions-continue"
          >
            {t("common.continue")}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function PermCard({
  icon: Icon,
  title,
  desc,
  granted,
  action,
  testId,
  children,
}: {
  icon: typeof Mic;
  title: string;
  desc: React.ReactNode;
  granted: boolean;
  action: React.ReactNode;
  testId?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      data-testid={testId}
      data-granted={granted}
      className="border-border bg-card flex items-start gap-3.5 rounded-[10px] border p-4"
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border",
          granted
            ? "bg-accent border-primary/20"
            : "bg-background border-border",
        )}
      >
        <Icon
          size={16}
          className={
            granted ? "text-accent-foreground" : "text-muted-foreground"
          }
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-[14px] font-medium">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">
          {desc}
        </div>
        {children}
      </div>
      {granted ? (
        <span className="mono text-accent-foreground inline-flex items-center gap-1.5 text-[10.5px] tracking-[0.14em] uppercase">
          <Check size={13} strokeWidth={2.2} />
          {t("common.granted")}
        </span>
      ) : (
        action
      )}
    </div>
  );
}

function PermButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button size="sm" onClick={onClick} className="shrink-0">
      {children}
    </Button>
  );
}
