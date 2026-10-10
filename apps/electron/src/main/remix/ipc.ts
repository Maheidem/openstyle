// Remix IPC handlers. The main process registers each remix:* channel here.
// Call registerRemixIpc() last in whenReady, after registerHotkeyIpc().
import { setTimeout as wait } from "node:timers/promises";
import { createAppLogger } from "@openstyle/utils";
import { REMIX_CLIPBOARD_LIMIT } from "@openstyle/validations";
import { clipboard, ipcMain } from "electron";
import {
  getFrontmostContext,
  getOpenstyleAppExclusions,
} from "../active-window";
import { setRemixRouteKeys } from "../hotkeys/stuck-release";
import {
  isSecureInputActive,
  runKeystrokeScript,
  runMacAxCaps,
  runMacAxKey,
  runMacAxRead,
  runMacAxSelect,
  sendChordToFocusedApp,
  sendSelectAllToFocusedApp,
} from "../mac-ax";
import { state } from "../main-state";
import { notifyPasteFailed } from "../notifications";
import {
  copySelectionFromFocusedApp,
  pasteClipboardIntoFocusedApp,
  pasteIntoFocusedApp,
} from "../paste";
import { isRemixTargetAllowed } from "../remix-target";
import { hidePill } from "../windows/pill-window";
import {
  clipboardPreviewFields,
  fetchRemixImage,
  REMIX_PRESSABLE_KEYS,
  withFocusedAnchor,
} from "./helpers";
import { handleRemixBarOpen } from "./hotkey";

const hotkeyLog = createAppLogger("hotkey");

export function registerRemixIpc(): void {
  // Paste over selection — not deliverOutput (no trailing space).
  ipcMain.handle("remix:paste", async (_event, text: string) => {
    if (typeof text !== "string" || !text.trim()) return false;
    if (await isSecureInputActive()) {
      notifyPasteFailed();
      hotkeyLog.warn("Remix paste refused: secure input is active.");
      return false;
    }
    try {
      await pasteIntoFocusedApp(
        text,
        async () => {
          hidePill();
          await wait(0);
        },
        { trailingSpace: false },
      );
      return true;
    } catch (err) {
      notifyPasteFailed();
      hotkeyLog.error(`Remix paste failed: ${err}`);
      return false;
    }
  });

  // Remix primitives — focus the document before injecting keystrokes.

  ipcMain.handle("remix:get-context", async () => {
    if (await isSecureInputActive()) {
      return { ok: false, reason: "secure-input" };
    }
    const pill = state.mainWindow;
    if (pill && !pill.isDestroyed() && pill.isFocused()) {
      pill.blur();
      await wait(140);
    }
    const front = await getFrontmostContext();
    const ours = getOpenstyleAppExclusions();
    if (!isRemixTargetAllowed(front.appName, ours, state.remixPracticeTarget)) {
      return { ok: false, reason: "document-not-in-front" };
    }
    state.remixAnchor = { ...front, capturedAt: Date.now() };
    const [selection, caps] = await Promise.all([
      copySelectionFromFocusedApp().catch(() => null),
      runMacAxCaps(),
    ]);
    hotkeyLog.info(
      `remix get-context: "${front.appName}"${selection ? ` · ${selection.length} chars selected` : " · no selection"} · precise=${caps?.settable ?? false}`,
    );
    const preview = clipboardPreviewFields();
    return {
      ok: true,
      appName: front.appName,
      windowTitle: front.windowTitle,
      url: front.url,
      selection,
      preciseSelection: caps?.settable ?? false,
      docLength: caps && caps.length >= 0 ? caps.length : null,
      clipboardPreview: preview.clipboard,
      clipboardLength: preview.clipboardLength,
    };
  });

  // AX read keeps the highlight; canvas editors return unsupported.
  ipcMain.handle("remix:read-document", async () => {
    return withFocusedAnchor(async () => {
      const ax = await runMacAxRead();
      if (!ax?.text) return { ok: false, reason: "unsupported" };
      hotkeyLog.info(
        `remix read-document: ${ax.text.length} chars via accessibility`,
      );
      return {
        ok: true,
        text: ax.text.slice(0, 60_000),
        truncated: ax.text.length > 60_000,
        selStart: ax.selStart,
        selLen: ax.selLen,
      };
    });
  });

  ipcMain.handle("remix:select-all", async () => {
    return withFocusedAnchor(async () => {
      if (!(await sendSelectAllToFocusedApp())) {
        return { ok: false, reason: "inject-failed" };
      }
      return { ok: true };
    });
  });

  ipcMain.handle("remix:collapse-selection", async () => {
    return withFocusedAnchor(async () => {
      if (
        !(await runMacAxKey(124)) &&
        !(await runKeystrokeScript(["key code 124"]))
      ) {
        return { ok: false, reason: "inject-failed" };
      }
      return { ok: true };
    });
  });

  ipcMain.handle("remix:copy", async () => {
    return withFocusedAnchor(async () => {
      // Whole-document copy after select_all can be slow in rich editors.
      const text = await copySelectionFromFocusedApp({
        timeoutsMs: [600, 2_000],
      }).catch(() => null);
      if (text === null) return { ok: false, reason: "nothing-copied" };
      return {
        ok: true,
        text: text.slice(0, 60_000),
        truncated: text.length > 60_000,
      };
    });
  });

  ipcMain.handle("remix:set-clipboard", (_event, text: unknown) => {
    if (
      typeof text !== "string" ||
      !text ||
      text.length > REMIX_CLIPBOARD_LIMIT
    ) {
      return { ok: false, reason: "bad-text" };
    }
    clipboard.writeText(text);
    hotkeyLog.info(`remix set-clipboard: ${text.length} chars`);
    return { ok: true };
  });

  ipcMain.handle("remix:set-clipboard-image", async (_event, url: unknown) => {
    if (typeof url !== "string" || !url)
      return { ok: false, reason: "bad-url" };
    const image = await fetchRemixImage(url);
    if (!image) return { ok: false, reason: "fetch-failed" };
    clipboard.writeImage(image);
    return { ok: true };
  });

  ipcMain.handle("remix:paste-clipboard", async () => {
    return withFocusedAnchor(async () => {
      // Log length only — distinguishes empty clipboard from inject failure.
      hotkeyLog.info(
        `remix paste: injecting (clipboard: ${clipboard.readText().length} chars)`,
      );
      try {
        await pasteClipboardIntoFocusedApp();
        if (state.remixPracticeTarget) {
          state.settingsWindow?.webContents.send("remix:practice-delivered");
        }
        return { ok: true };
      } catch (err) {
        hotkeyLog.error(`Remix paste failed: ${err}`);
        return { ok: false, reason: "paste-failed" };
      }
    });
  });

  ipcMain.handle(
    "remix:select-text",
    async (_event, text: unknown, occurrence: unknown) => {
      if (typeof text !== "string" || !text.trim() || text.length > 20_000) {
        return { ok: false, reason: "failed" };
      }
      const wanted =
        typeof occurrence === "number" &&
        Number.isInteger(occurrence) &&
        occurrence >= 1
          ? occurrence
          : null;
      return withFocusedAnchor(async () => {
        const ax = await runMacAxRead();
        if (!ax?.text || !ax.settable) {
          return { ok: false, reason: "unsupported" };
        }
        // Ambiguous matches error unless occurrence is named — wrong twin corrupts text.
        const positions: number[] = [];
        for (
          let at = ax.text.indexOf(text);
          at >= 0 && positions.length <= 50;
          at = ax.text.indexOf(text, at + 1)
        ) {
          positions.push(at);
        }
        if (positions.length === 0) return { ok: false, reason: "not-found" };
        if (wanted === null && positions.length > 1) {
          return { ok: false, reason: "ambiguous", matches: positions.length };
        }
        const index = positions[(wanted ?? 1) - 1];
        if (index === undefined) {
          return { ok: false, reason: "not-found", matches: positions.length };
        }
        if (!(await runMacAxSelect(index, text.length))) {
          return { ok: false, reason: "failed" };
        }
        if (state.remixAnchor) state.remixAnchor.capturedAt = Date.now();
        return { ok: true };
      });
    },
  );

  // Undo/redo via native chord binary (non-QWERTY-safe); osascript fallback.
  ipcMain.handle("remix:undo", async () => {
    return withFocusedAnchor(async () => {
      if (!(await sendChordToFocusedApp("z", false))) {
        return { ok: false, reason: "inject-failed" };
      }
      return { ok: true };
    });
  });

  ipcMain.handle("remix:redo", async () => {
    return withFocusedAnchor(async () => {
      if (!(await sendChordToFocusedApp("z", true))) {
        return { ok: false, reason: "inject-failed" };
      }
      return { ok: true };
    });
  });

  ipcMain.handle(
    "remix:press-key",
    async (_event, key: unknown, times: unknown) => {
      const code =
        typeof key === "string" ? REMIX_PRESSABLE_KEYS[key] : undefined;
      if (code === undefined) return { ok: false, reason: "bad-key" };
      const count =
        typeof times === "number" && Number.isInteger(times)
          ? Math.min(Math.max(times, 1), 50)
          : 1;
      return withFocusedAnchor(async () => {
        for (let i = 0; i < count; i++) {
          if (
            !(await runMacAxKey(code)) &&
            !(await runKeystrokeScript([`key code ${code}`]))
          ) {
            return { ok: false, reason: "inject-failed", pressed: i };
          }
          if (count > 1) await wait(25);
        }
        return { ok: true };
      });
    },
  );

  ipcMain.handle("remix:get-clipboard", () => {
    const text = clipboard.readText();
    return {
      ok: true,
      text: text.slice(0, 60_000),
      truncated: text.length > 60_000,
    };
  });

  // Preset chips: replace selection, preserve clipboard.
  ipcMain.handle("remix:paste-text", async (_event, text: unknown) => {
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, reason: "bad-text" };
    }
    return withFocusedAnchor(async () => {
      try {
        await pasteIntoFocusedApp(text, undefined, { trailingSpace: false });
        if (state.remixPracticeTarget) {
          state.settingsWindow?.webContents.send("remix:practice-delivered");
        }
        return { ok: true };
      } catch (err) {
        hotkeyLog.error(`Remix paste-text failed: ${err}`);
        return { ok: false, reason: "paste-failed" };
      }
    });
  });

  // Re-read selection for typed follow-ups (document may have changed).
  ipcMain.handle("remix:recapture", async () => {
    // Pill may be key window while typing — yield before Copy or we read our own input.
    const pill = state.mainWindow;
    if (pill && !pill.isDestroyed() && pill.isFocused()) {
      pill.blur();
      await wait(140);
    }
    const front = await getFrontmostContext();
    const ours = getOpenstyleAppExclusions();
    const inDocument = isRemixTargetAllowed(
      front.appName,
      ours,
      state.remixPracticeTarget,
    );
    if (inDocument) {
      state.remixAnchor = { ...front, capturedAt: Date.now() };
      const selection = (await isSecureInputActive())
        ? null
        : await copySelectionFromFocusedApp().catch(() => null);
      hotkeyLog.info(
        `remix recapture: ${selection ? `${selection.length} chars` : "no selection"} in "${front.appName}"`,
      );
      return {
        selection,
        ...clipboardPreviewFields(),
        ...state.remixAnchor,
        stale: false,
      };
    }
    hotkeyLog.info("remix recapture: document not in front; keeping anchor");
    return {
      selection: null,
      appName: state.remixAnchor?.appName ?? null,
      windowTitle: state.remixAnchor?.windowTitle ?? null,
      url: state.remixAnchor?.url ?? null,
      ...clipboardPreviewFields(),
      capturedAt: state.remixAnchor?.capturedAt ?? Date.now(),
      stale: true,
    };
  });

  // Onboarding practice: allow targeting Openstyle's own window.
  ipcMain.on("remix:set-practice-target", (event, active: unknown) => {
    if (event.sender !== state.settingsWindow?.webContents) return;
    state.remixPracticeTarget = active === true;
    hotkeyLog.info(`remix practice target: ${state.remixPracticeTarget}`);
  });

  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") {
    ipcMain.handle(
      "e2e:remix-practice-target",
      () => state.remixPracticeTarget,
    );
  }

  // Chat card releases digit routes while open.
  ipcMain.on("remix:set-route-keys", (_event, open: unknown) => {
    setRemixRouteKeys(open === true);
  });

  // The persistent bar was hovered: open the Remix chat where the user is.
  ipcMain.on("remix:bar-hover", () => {
    handleRemixBarOpen();
  });

  // Exception to focusable:false — allow focus only while the chat card is up.
  ipcMain.on("remix:set-chat-focus", (_event, focus: unknown) => {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return;
    if (focus === true) {
      if (!win.isFocusable()) win.setFocusable(true);
    } else {
      if (win.isFocused()) win.blur();
      if (win.isFocusable()) win.setFocusable(false);
    }
  });
}
