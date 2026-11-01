// The global hotkey of the Ask bubble (specs/meeting-chat-agent.md 11.6.2).
// OS-level hotkeys go through the main process. One native key listener runs
// for the chat hotkey, like one runs for each language hotkey. It is
// registered only while the setting `meeting_chat_enabled` is "true".
import { createAppLogger } from "@openstyle/utils";
import { ipcMain } from "electron";
import { SETTINGS_KEYS } from "../../shared/settings-keys";
import { chatHotkeyFromSettings, isLanguageHotkeyTaken } from "../hotkey-utils";
import { NativeKeyListener } from "../key-listener";
import { state } from "../main-state";
import { getServerSettings } from "../server-target";
import { openChatBubble } from "../windows/chat-bubble-window";
import { dictationStartGuard } from "./dictation";
import { startNativeRetry } from "./native-retry";

const log = createAppLogger("hotkey");

let listener: NativeKeyListener | null = null;
/** The accelerator the listener runs for, or null when none runs. */
let registered: string | null = null;
let cancelRetry: (() => void) | null = null;

/** The chat key went down. The guard decides whether the bubble opens. */
function onChatKeyDown(): void {
  // A hotkey recording in Settings must not open the bubble.
  if (state.hotkeyRecorder) return;
  if (!dictationStartGuard.chatKeyDown()) {
    log.debug("Chat hotkey ignored: a dictation runs.");
    return;
  }
  openChatBubble("hotkey");
}

function stopListener(): void {
  cancelRetry?.();
  cancelRetry = null;
  listener?.stop();
  listener = null;
  registered = null;
  dictationStartGuard.setChatAccel(null);
}

function createListener(
  accel: string,
  quiet: () => boolean = () => false,
): NativeKeyListener {
  const created: NativeKeyListener = new NativeKeyListener({
    hotkey: accel,
    onKeyDown: onChatKeyDown,
    onKeyUp: () => {},
    onError: (error) => {
      const text = `Chat hotkey listener error: ${error}`;
      if (quiet()) log.debug(text);
      else log.error(text);
    },
    onPermanentFailure: () => {
      if (listener !== created) return;
      log.error(
        "Chat hotkey listener permanently failed; retrying every 60 s.",
      );
      created.stop();
      listener = null;
      // No key can come: dictation must not wait for it.
      dictationStartGuard.setChatAccel(null);
      startRetry(accel);
    },
  });
  return created;
}

function startRetry(accel: string): void {
  cancelRetry?.();
  cancelRetry = startNativeRetry({
    label: "Chat hotkey",
    attempt: async () => {
      let attempting = true;
      const retry = createListener(accel, () => attempting);
      listener = retry;
      const started = await retry.start().finally(() => {
        attempting = false;
      });
      if (started && listener === retry) return true;
      retry.stop();
      if (listener === retry) listener = null;
      return false;
    },
    onRecovered: () => {
      cancelRetry = null;
      dictationStartGuard.setChatAccel(accel);
    },
  });
}

/**
 * Reconcile the chat hotkey listener with the settings: on when the switch is
 * on, with the saved accelerator or the default. A hotkey that equals the
 * dictation hotkey or a language hotkey is refused (dictation wins).
 */
export async function applyChatHotkey(
  settings: Record<string, string>,
): Promise<void> {
  const accel = chatHotkeyFromSettings(settings);
  if (accel === registered) return;
  stopListener();
  if (!accel) {
    log.info("Chat hotkey off.");
    return;
  }
  if (
    isLanguageHotkeyTaken(accel, {
      dictationAccel: state.currentHotkeyAccel,
      claimedLanguageAccels: state.languageHotkeyAccels.values(),
    })
  ) {
    log.warn(
      `Chat hotkey "${accel}" conflicts with a dictation hotkey; disabled.`,
    );
    return;
  }
  const created = createListener(accel);
  listener = created;
  registered = accel;
  const started = await created.start();
  // Another call may have replaced the listener while we waited.
  if (listener !== created) {
    created.stop();
    return;
  }
  if (!started) {
    log.warn("Chat hotkey listener unavailable; retrying every 60 s.");
    created.stop();
    listener = null;
    startRetry(accel);
    return;
  }
  dictationStartGuard.setChatAccel(accel);
  log.info(`Chat hotkey "${accel}" registered.`);
}

/** Read the settings from the server and apply them. */
export async function refreshChatHotkey(): Promise<void> {
  const settings = await getServerSettings();
  if (!settings) return;
  await applyChatHotkey(settings);
}

/**
 * IPC of the chat hotkey. The Settings page sends `chat-hotkey:refresh` after
 * it saves the switch or the hotkey. The main process reads the server value,
 * so the renderer cannot register an accelerator the validator would refuse.
 */
export function registerChatHotkeyIpc(): void {
  ipcMain.on("chat-hotkey:refresh", () => {
    void refreshChatHotkey().catch((err) => {
      log.error(
        `Chat hotkey refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });

  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") {
    // The chat key going down, as the native listener reports it. The guard
    // and the bubble run as for a real key. A real key press needs the
    // Input Monitoring permission, which an isolated test must not ask for.
    ipcMain.on("e2e:trigger-chat-hotkey", () => onChatKeyDown());
    ipcMain.handle("e2e:chat-hotkey-state", () => ({
      registered,
      dictating: state.hotkeyPressed,
      waiting: dictationStartGuard.waiting,
      armed: dictationStartGuard.armed,
      setting: SETTINGS_KEYS.chatHotkey,
    }));
  }
}
