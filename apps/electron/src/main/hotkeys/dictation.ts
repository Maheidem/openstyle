// Dictation hotkeys. Registers the native key listeners and the
// global shortcut fallback. Starts and stops dictation on hold or toggle.
// Shared state is read and written through the state object in main-state.
import { createAppLogger } from "@openstyle/utils";
import { globalShortcut, ipcMain } from "electron";
import { getDefaultHotkey } from "../../shared/hotkey-defaults";
import { SETTINGS_KEYS } from "../../shared/settings-keys";
import {
  diffLanguageHotkeys,
  isLanguageHotkeyTaken,
  isValidAccelerator,
  normalizeAccelerator,
} from "../hotkey-utils";
import { NativeKeyListener } from "../key-listener";
import { broadcastToWindows, state } from "../main-state";
import { notify } from "../notifications";
import {
  getMissingDictationPermission,
  showRequiredPermissionDialog,
} from "../permission-dialogs";
import {
  applyRemixSettings,
  scheduleRemixHotkeyRegistration,
} from "../remix/hotkey";
import { getServerSettings, waitForServerReady } from "../server-target";
import { showPill } from "../windows/pill-window";
import { startNativeRetry } from "./native-retry";
import {
  clearHotkeyStuckWatchdog,
  HOTKEY_STUCK_TIMEOUT_MS,
} from "./stuck-release";

const hotkeyLog = createAppLogger("hotkey");

const DEFAULT_HOTKEY = getDefaultHotkey();
let hotkeyActivationMode: "hold" | "toggle" = "hold";
/** Which hotkey (if any) started the in-progress dictation session. */
let activeDictationLanguage: string | null = null;

export function registerHotkeyIpc(): void {
  // Register the hold-to-record hotkey immediately with the default accelerator
  // so a press right after launch is never dropped. Pass DEFAULT_HOTKEY
  // explicitly so this doesn't fire a settings request at the not-yet-ready
  // server. Once the server answers, re-register with the configured
  // accelerator + activation mode (only if they differ, to avoid a needless
  // native-listener rebuild).
  scheduleHotkeyRegistration(DEFAULT_HOTKEY);
  void waitForServerReady().then(async () => {
    // One request for both keys, instead of a read per key. Skip if the server
    // never answered — the default registered above stands.
    const settings = await getServerSettings();
    if (!settings) return;
    hotkeyActivationMode = hotkeyModeFromSettings(settings);
    const configured = hotkeyFromSettings(settings);
    const accel = configured
      ? normalizeAccelerator(configured)
      : DEFAULT_HOTKEY;
    if (accel !== state.currentHotkeyAccel)
      scheduleHotkeyRegistration(configured);
    // Wait for server settings — don't spawn a listener just to tear it down.
    applyRemixSettings(settings);
    applyLanguageHotkeySettings(settings);
  });

  ipcMain.on("hotkey:set-mode", (_event, mode: string) => {
    hotkeyActivationMode = mode === "toggle" ? "toggle" : "hold";
    state.hotkeyPressed = false;
    clearHotkeyStuckWatchdog();
    scheduleHotkeyRegistration(state.currentHotkeyAccel ?? undefined);
  });

  // Remix: the settings UI writes the setting, then tells us to re-read it.
  ipcMain.on("remix-hotkey:reload", () => {
    void getServerSettings().then((settings) => {
      if (!settings) return;
      applyRemixSettings(settings);
    });
  });

  // Language hotkeys: the settings UI pushes the whole map directly (no
  // reload round-trip needed — it already has the value it just persisted).
  ipcMain.on(
    "language-hotkeys:update",
    (_event, map: Record<string, string>) => {
      scheduleLanguageHotkeysRegistration(map);
    },
  );
}

/** The configured hotkey accelerator from a settings map, if valid. */
function hotkeyFromSettings(
  settings: Record<string, string>,
): string | undefined {
  const value = settings[SETTINGS_KEYS.hotkey];
  return value && isValidAccelerator(value) ? value : undefined;
}

/** The hotkey activation mode from a settings map (defaults to "hold"). */
function hotkeyModeFromSettings(
  settings: Record<string, string>,
): "hold" | "toggle" {
  return settings[SETTINGS_KEYS.hotkeyMode] === "toggle" ? "toggle" : "hold";
}

function sendHotkeyDown(language?: string | null): void {
  const missingPermission = getMissingDictationPermission();
  if (missingPermission) {
    state.hotkeyPressed = false;
    activeDictationLanguage = null;
    clearHotkeyStuckWatchdog();
    void showRequiredPermissionDialog(missingPermission);
    return;
  }
  showPill();
  const payload = language ? { language } : undefined;
  if (state.pillReadyPromise) {
    // The pill window is still loading — defer IPC until it can receive it.
    void state.pillReadyPromise.then(() => {
      broadcastToWindows("hotkey:down", payload);
    });
    return;
  }
  broadcastToWindows("hotkey:down", payload);
}

function sendHotkeyUp(): void {
  if (state.pillReadyPromise) {
    // Preserve IPC ordering: hotkey:up must arrive after hotkey:down.
    void state.pillReadyPromise.then(() => {
      broadcastToWindows("hotkey:up");
    });
    return;
  }
  broadcastToWindows("hotkey:up");
}

function armHotkeyStuckWatchdog(): void {
  clearHotkeyStuckWatchdog();
  state.hotkeyStuckTimer = setTimeout(() => {
    state.hotkeyStuckTimer = null;
    if (!state.hotkeyPressed) return;
    hotkeyLog.warn(
      "Hold-mode hotkey saw no key-up for 5 minutes; forcing release.",
    );
    state.hotkeyPressed = false;
    activeDictationLanguage = null;
    sendHotkeyUp();
  }, HOTKEY_STUCK_TIMEOUT_MS);
}

/**
 * Shared press state machine for every dictation-starting hotkey — the
 * default hotkey (`language` undefined) and every per-language hotkey
 * (§5, specs/dictation-language-hotkeys.md) alike. `hotkeyPressed` remains
 * the single flag gating whether a dictation session is in progress, so only
 * one can run at a time regardless of which hotkey started it.
 */
export function handleDictationHotkeyDown(language?: string): void {
  if (hotkeyActivationMode === "toggle") {
    if (!state.hotkeyPressed) {
      state.hotkeyPressed = true;
      activeDictationLanguage = language ?? null;
      sendHotkeyDown(activeDictationLanguage);
    } else {
      state.hotkeyPressed = false;
      activeDictationLanguage = null;
      sendHotkeyUp();
    }
    return;
  }

  if (!state.hotkeyPressed) {
    state.hotkeyPressed = true;
    activeDictationLanguage = language ?? null;
    armHotkeyStuckWatchdog();
    sendHotkeyDown(activeDictationLanguage);
  }
  // hotkeyPressed already true: a second hotkey (default or another
  // language) pressed mid-recording is a no-op in hold mode, same as today's
  // "press the same hotkey twice" case — only one dictation session at a
  // time, matching the single hotkeyPressed flag's existing semantics.
}

export function handleDictationHotkeyUp(language?: string): void {
  if (hotkeyActivationMode === "toggle") return;

  // Only the hotkey that started the session ends it — a stray key-up from a
  // *different* language hotkey (e.g. the user's finger slipped) is ignored
  // rather than ending someone else's hold.
  if (state.hotkeyPressed && (language ?? null) === activeDictationLanguage) {
    state.hotkeyPressed = false;
    activeDictationLanguage = null;
    clearHotkeyStuckWatchdog();
    sendHotkeyUp();
  }
}

// Notify once per session when hold-to-talk degrades to toggle mode, so the
// user isn't left wondering why holding the hotkey stopped working.
let hotkeyDegradedNotified = false;
function notifyHotkeyDegraded(accel: string, nativeError: string): void {
  if (hotkeyDegradedNotified || hotkeyActivationMode !== "hold") return;
  hotkeyDegradedNotified = true;
  let fix = "";
  if (
    process.platform === "linux" &&
    nativeError.includes("No accessible input devices")
  ) {
    fix =
      " To enable hold-to-talk, run: sudo usermod -aG input $USER — then log out and back in.";
  }
  const body = `Hold-to-talk isn't available, so "${accel}" now toggles recording on and off.${fix}`;
  hotkeyLog.warn(body);
  notify("Openstyle is in toggle mode", body);
}

/** Electron globalShortcut rejects some combos (e.g. Alt+Super on Linux). */
const LINUX_GLOBAL_SHORTCUT_FALLBACK = "F9";

/** The accelerator the toggle fallback holds now, or null when none. */
let fallbackShortcut: string | null = null;
/** Cancels the pending native retry for the dictation listener. */
let cancelDictationRetry: (() => void) | null = null;
/** The last error text from the dictation listener. */
let lastNativeError = "";

function registerGlobalShortcutToggle(accel: string): string | null {
  const onToggle = (): void => {
    if (!state.hotkeyPressed) {
      state.hotkeyPressed = true;
      sendHotkeyDown();
    } else {
      state.hotkeyPressed = false;
      sendHotkeyUp();
    }
  };

  const candidates =
    process.platform === "linux" && /super/i.test(accel)
      ? [accel, LINUX_GLOBAL_SHORTCUT_FALLBACK]
      : [accel];

  for (const candidate of candidates) {
    try {
      if (globalShortcut.register(candidate, onToggle)) {
        if (candidate !== accel) {
          hotkeyLog.warn(
            `globalShortcut does not support "${accel}"; using "${candidate}" instead.`,
          );
        }
        fallbackShortcut = candidate;
        return candidate;
      }
    } catch (err) {
      hotkeyLog.warn(
        `globalShortcut.register failed for "${candidate}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}

function createDictationListener(accel: string): NativeKeyListener {
  const listener = new NativeKeyListener({
    hotkey: accel,
    onKeyDown: () => handleDictationHotkeyDown(),
    onKeyUp: () => handleDictationHotkeyUp(),
    onError: (error) => {
      lastNativeError = error;
      hotkeyLog.error(`Native key listener error: ${error}`);
    },
    onReady: () => {
      hotkeyLog.debug(`Native key listener ready for "${accel}"`);
    },
    onPermanentFailure: () => {
      if (state.keyListener !== listener) return;
      hotkeyLog.error(
        "Native key listener permanently failed; falling back to Electron globalShortcut (toggle mode).",
      );
      listener.stop();
      state.keyListener = null;
      if (state.hotkeyPressed) {
        state.hotkeyPressed = false;
        clearHotkeyStuckWatchdog();
        sendHotkeyUp();
      }
      const registeredAccel = registerGlobalShortcutToggle(accel);
      if (registeredAccel) {
        notifyHotkeyDegraded(accel, lastNativeError);
      } else {
        const errorPayload = {
          message: `The hotkey listener stopped working and "${accel}" could not be re-registered. Restart Openstyle or pick a different combination in Settings.`,
        };
        broadcastToWindows("hotkey:error", errorPayload);
      }
      startDictationRetry(accel);
    },
  });
  return listener;
}

/**
 * Keep the toggle fallback and try the native listener again every 60 s.
 * On READY the fallback goes away and hold mode works again.
 */
function startDictationRetry(accel: string): void {
  cancelDictationRetry?.();
  cancelDictationRetry = startNativeRetry({
    label: "Dictation",
    attempt: async () => {
      const listener = createDictationListener(accel);
      state.keyListener = listener;
      const started = await listener.start();
      if (started && state.keyListener === listener) return true;
      listener.stop();
      if (state.keyListener === listener) state.keyListener = null;
      return false;
    },
    onRecovered: () => {
      cancelDictationRetry = null;
      if (fallbackShortcut) globalShortcut.unregister(fallbackShortcut);
      fallbackShortcut = null;
      if (state.hotkeyPressed) {
        state.hotkeyPressed = false;
        clearHotkeyStuckWatchdog();
        sendHotkeyUp();
      }
      state.accessibilityConfirmed = true;
      hotkeyDegradedNotified = false;
    },
  });
}

export function scheduleHotkeyRegistration(hotkey?: string): void {
  void registerHotkey(hotkey).catch((err) => {
    hotkeyLog.error(
      `Hotkey registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function registerHotkey(hotkey?: string): Promise<void> {
  try {
    // Tear down previous listener
    if (state.keyListener) {
      state.keyListener.stop();
      state.keyListener = null;
    }
    state.hotkeyPressed = false;
    activeDictationLanguage = null;
    clearHotkeyStuckWatchdog();
    globalShortcut.unregisterAll();
    fallbackShortcut = null;
    cancelDictationRetry?.();
    cancelDictationRetry = null;

    if (!hotkey) {
      // Unreachable server yields no map; registration falls back to the
      // default accelerator below.
      hotkey = hotkeyFromSettings((await getServerSettings()) ?? {});
    }

    const normalized =
      hotkey && isValidAccelerator(hotkey)
        ? normalizeAccelerator(hotkey)
        : null;
    const accel = normalized ?? DEFAULT_HOTKEY;
    state.currentHotkeyAccel = accel;

    // Try native key listener binary first (all platforms)
    lastNativeError = "";
    const listener = createDictationListener(accel);
    state.keyListener = listener;

    const started = await listener.start();

    // Another registerHotkey call may have replaced keyListener while we
    // were awaiting — if so, abandon this attempt.
    if (state.keyListener !== listener) {
      listener.stop();
      return;
    }

    if (started) {
      state.accessibilityConfirmed = true;
      hotkeyDegradedNotified = false;
      // Dictation hotkey moved — re-resolve remix (may free or steal a chord).
      if (state.remixInitialized) scheduleRemixHotkeyRegistration();
    } else {
      hotkeyLog.warn(
        "Native key listener unavailable, falling back to Electron globalShortcut (toggle mode).",
      );
      listener.stop();
      state.keyListener = null;

      // Fallback: globalShortcut has no key-up — always use toggle semantics
      const registeredAccel = registerGlobalShortcutToggle(accel);
      if (registeredAccel) {
        // Do NOT latch accessibilityConfirmed here. Registering a global
        // shortcut requires no Accessibility permission on macOS, so a
        // successful registration proves nothing about whether the app can
        // post CGEvents / send Apple Events. Latching it here would make
        // permissions:check-accessibility report a false positive, hide the
        // "grant Accessibility" prompt during onboarding, and leave paste
        // silently broken in the notarized prod build. Only the native key
        // listener starting (above) is real proof of Accessibility.
        notifyHotkeyDegraded(accel, lastNativeError);
      } else {
        let message = `Could not register hotkey "${accel}". Try a different key combination in Settings.`;
        if (
          process.platform === "linux" &&
          lastNativeError.includes("No accessible input devices")
        ) {
          message = `Hotkey "${accel}" requires access to input devices. Run: sudo usermod -aG input $USER — then log out and back in.`;
        }
        const errorPayload = { message };
        broadcastToWindows("hotkey:error", errorPayload);
      }
      startDictationRetry(accel);
    }
  } catch (err) {
    hotkeyLog.error(
      `registerHotkey failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Cancels the pending native retry for each language hotkey. */
const languageRetries = new Map<string, () => void>();

function cancelLanguageRetry(lang: string): void {
  languageRetries.get(lang)?.();
  languageRetries.delete(lang);
}

/** End the session this language hotkey started, if it is still held. */
function releaseLanguageSession(lang: string): void {
  if (activeDictationLanguage !== lang) return;
  activeDictationLanguage = null;
  if (state.hotkeyPressed) {
    state.hotkeyPressed = false;
    clearHotkeyStuckWatchdog();
    sendHotkeyUp();
  }
}

function createLanguageListener(
  lang: string,
  accel: string,
): NativeKeyListener {
  const listener = new NativeKeyListener({
    hotkey: accel,
    onKeyDown: () => handleDictationHotkeyDown(lang),
    onKeyUp: () => handleDictationHotkeyUp(lang),
    onError: (error) =>
      hotkeyLog.error(`Language hotkey listener error (${lang}): ${error}`),
    onPermanentFailure: () => {
      if (state.languageKeyListeners.get(lang) !== listener) return;
      hotkeyLog.error(
        `Language hotkey listener for "${lang}" permanently failed; retrying every 60 s.`,
      );
      listener.stop();
      state.languageKeyListeners.delete(lang);
      releaseLanguageSession(lang);
      startLanguageRetry(lang, accel);
    },
  });
  return listener;
}

/** Try the native listener again every 60 s. No fallback exists for a language hotkey. */
function startLanguageRetry(lang: string, accel: string): void {
  cancelLanguageRetry(lang);
  languageRetries.set(
    lang,
    startNativeRetry({
      label: `Language hotkey "${lang}"`,
      attempt: async () => {
        const listener = createLanguageListener(lang, accel);
        state.languageKeyListeners.set(lang, listener);
        const started = await listener.start();
        if (started && state.languageKeyListeners.get(lang) === listener) {
          return true;
        }
        listener.stop();
        if (state.languageKeyListeners.get(lang) === listener) {
          state.languageKeyListeners.delete(lang);
        }
        return false;
      },
      onRecovered: () => languageRetries.delete(lang),
    }),
  );
}

/**
 * Reconcile the running per-language hotkey listeners against a desired
 * language→accelerator map (§5, specs/dictation-language-hotkeys.md). Same
 * pattern as `registerHotkey` — "stop, then rebuild" — scaled to a map
 * instead of a single instance, via `diffLanguageHotkeys` (hotkey-utils.ts).
 */
async function registerLanguageHotkeys(
  map: Record<string, string> | undefined,
): Promise<void> {
  const desired = map ?? {};
  const { toRemove, toAdd } = diffLanguageHotkeys(
    desired,
    state.languageHotkeyAccels,
  );

  for (const lang of toRemove) {
    cancelLanguageRetry(lang);
    state.languageKeyListeners.get(lang)?.stop();
    state.languageKeyListeners.delete(lang);
    state.languageHotkeyAccels.delete(lang);
    releaseLanguageSession(lang);
  }

  for (const [lang, hotkey] of toAdd) {
    const normalized = isValidAccelerator(hotkey)
      ? normalizeAccelerator(hotkey)
      : null;
    if (!normalized) continue; // invalid stored value; skip silently (§8)

    const taken = isLanguageHotkeyTaken(normalized, {
      dictationAccel: state.currentHotkeyAccel,
      remixAccel: state.currentRemixAccel,
      claimedLanguageAccels: state.languageHotkeyAccels.values(),
    });
    if (taken) {
      hotkeyLog.warn(
        `Language hotkey "${normalized}" for "${lang}" conflicts with an existing binding; disabled.`,
      );
      continue;
    }

    cancelLanguageRetry(lang);
    const listener = createLanguageListener(lang, normalized);
    state.languageKeyListeners.set(lang, listener);
    state.languageHotkeyAccels.set(lang, normalized);

    const started = await listener.start();
    // Another registerLanguageHotkeys call may have replaced this entry
    // while we were awaiting — if so, abandon this attempt.
    if (state.languageKeyListeners.get(lang) !== listener) {
      listener.stop();
      continue;
    }
    if (!started) {
      hotkeyLog.warn(
        `Language hotkey listener unavailable for "${lang}"; retrying every 60 s.`,
      );
      listener.stop();
      state.languageKeyListeners.delete(lang);
      startLanguageRetry(lang, normalized);
    }
  }
}

function scheduleLanguageHotkeysRegistration(
  map: Record<string, string> | undefined,
): void {
  void registerLanguageHotkeys(map).catch((err) => {
    hotkeyLog.error(
      `Language hotkey registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/** Parse the `language_hotkeys` setting and reconcile the listeners against it. */
function applyLanguageHotkeySettings(settings: Record<string, string>): void {
  const raw = settings[SETTINGS_KEYS.languageHotkeys];
  let map: Record<string, string> = {};
  try {
    if (raw) map = JSON.parse(raw);
  } catch {
    map = {};
  }
  scheduleLanguageHotkeysRegistration(map);
}
