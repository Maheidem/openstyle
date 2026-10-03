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

// Linux system-setup state reported by the main process (input-group access
// for the hotkey listener, xdotool/wtype for the paste fallback).
export type LinuxSetup = NonNullable<
  Awaited<ReturnType<Window["api"]["checkLinuxSetup"]>>
>;

// ---------------------------------------------------------------------------
// Step 1 — Permissions
// ---------------------------------------------------------------------------
export function PermissionsStep({
  micStatus,
  accessibilityStatus,
  linuxSetup,
  onRequestMic,
  onOpenMicSettings,
  onOpenAccessibility,
  onRecheckLinuxSetup,
  onContinue,
}: {
  micStatus: string;
  accessibilityStatus: boolean;
  linuxSetup: LinuxSetup | null;
  onRequestMic: () => void;
  onOpenMicSettings: () => void;
  onOpenAccessibility: () => void;
  onRecheckLinuxSetup: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const micGranted = micStatus === "granted";
  // On Wayland there is no hotkey fallback without /dev/input access, so
  // missing input access blocks. On X11 the Electron globalShortcut still
  // works (toggle mode), so the card only warns.
  const linuxBlocked = !!linuxSetup?.wayland && !linuxSetup.inputAccess;
  // Accessibility is macOS-only; elsewhere the mic alone unblocks.
  // E2E runs on machines that can't grant OS permissions.
  const allGranted =
    (micGranted && (!IS_MAC || accessibilityStatus) && !linuxBlocked) ||
    !!window.api?.isE2E;
  // macOS and Windows can deep-link to the OS mic privacy settings.
  const canOpenMicSettings = IS_MAC || IS_WINDOWS;

  return (
    <div className="w-full max-w-[440px]">
      <div className="flex flex-col gap-2.5">
        <PermCard
          icon={Mic}
          title={t("onboarding.permissions.microphone.title")}
          desc={t("onboarding.permissions.microphone.desc")}
          granted={micGranted}
          action={
            micStatus === "denied" && canOpenMicSettings ? (
              <PermButton onClick={onOpenMicSettings}>
                {t("common.openSettings")}
              </PermButton>
            ) : (
              <PermButton onClick={onRequestMic}>
                {t("common.allow")}
              </PermButton>
            )
          }
        />

        {IS_MAC && (
          <PermCard
            icon={Shield}
            title={t("onboarding.permissions.accessibility.title")}
            desc={t("onboarding.permissions.accessibility.desc")}
            granted={accessibilityStatus}
            action={
              <PermButton onClick={onOpenAccessibility}>
                {t("common.openSettings")}
              </PermButton>
            }
          />
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

      <div className="mt-7 flex items-center justify-end gap-3.5">
        <div className="flex items-center gap-3.5">
          {!allGranted && (
            <span className="mono text-muted-foreground text-[10.5px] tracking-[0.1em] uppercase">
              {IS_MAC
                ? t("onboarding.permissions.grantBoth")
                : t("onboarding.permissions.grantAccess")}
            </span>
          )}
          <Button variant="ink" disabled={!allGranted} onClick={onContinue}>
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
}: {
  icon: typeof Mic;
  title: string;
  desc: React.ReactNode;
  granted: boolean;
  action: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="border-border bg-card flex items-center gap-3.5 rounded-[10px] border p-4">
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
    <Button variant="ink" size="sm" onClick={onClick} className="shrink-0">
      {children}
    </Button>
  );
}
