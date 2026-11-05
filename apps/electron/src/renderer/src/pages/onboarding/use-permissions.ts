import { requestMicAccess, resolveMicStatus } from "@renderer/lib/permissions";
import { IS_LINUX } from "@renderer/lib/platform";
import { useCallback, useEffect, useState } from "react";
import type { LinuxSetup } from "./permissions-step";

/**
 * The permission state of the first run. It checks at start, every second
 * while `watch` is true, and when the window gets focus. It never stops on its
 * own (a stop after 30 s left the user with a dead end).
 */
export function usePermissions(watch: boolean): {
  micStatus: string;
  accessibilityStatus: boolean;
  accessibilityWaiting: boolean;
  linuxSetup: LinuxSetup | null;
  checkAgain: () => Promise<void>;
  requestMic: () => Promise<void>;
  openMicSettings: () => void;
  openAccessibility: () => void;
  recheckLinuxSetup: () => Promise<void>;
} {
  const [micStatus, setMicStatus] = useState("unknown");
  const [accessibilityStatus, setAccessibilityStatus] = useState(false);
  const [accessibilityWaiting, setAccessibilityWaiting] = useState(false);
  const [linuxSetup, setLinuxSetup] = useState<LinuxSetup | null>(null);

  const checkAgain = useCallback(async () => {
    try {
      setMicStatus(await resolveMicStatus());
    } catch {}
    try {
      const granted = !!(await window.api?.checkAccessibilityPermission());
      setAccessibilityStatus(granted);
      if (granted) setAccessibilityWaiting(false);
    } catch {}
  }, []);

  const recheckLinuxSetup = useCallback(async () => {
    const setup = await window.api?.checkLinuxSetup();
    if (setup) setLinuxSetup(setup);
  }, []);

  useEffect(() => {
    void checkAgain();
    if (IS_LINUX) void recheckLinuxSetup();
  }, [checkAgain, recheckLinuxSetup]);

  useEffect(() => {
    if (!watch) return;
    const timer = window.setInterval(() => void checkAgain(), 1000);
    const onFocus = (): void => void checkAgain();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [watch, checkAgain]);

  const requestMic = useCallback(async () => {
    const status = await requestMicAccess();
    if (status) setMicStatus(status);
  }, []);

  const openMicSettings = useCallback(() => {
    window.api?.openMicSettings();
  }, []);

  const openAccessibility = useCallback(() => {
    window.api?.openAccessibilitySettings();
    setAccessibilityWaiting(true);
  }, []);

  return {
    micStatus,
    accessibilityStatus,
    accessibilityWaiting,
    linuxSetup,
    checkAgain,
    requestMic,
    openMicSettings,
    openAccessibility,
    recheckLinuxSetup,
  };
}
