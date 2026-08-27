/**
 * Normalize user-recorded accelerators to the Electron-style format expected
 * by native binaries and isValidAccelerator.
 */
export function normalizeAccelerator(accel: string): string {
  return accel
    .split("+")
    .map((part) => {
      const p = part.trim();
      if (!p) return p;

      const lower = p.toLowerCase();
      if (lower === "fn" || lower === "globe") return "Fn";
      if (lower === "control" || lower === "ctrl") return "Control";
      if (lower === "command" || lower === "cmd" || lower === "meta")
        return "Command";
      if (lower === "alt" || lower === "option") return "Alt";
      if (lower === "shift") return "Shift";
      if (lower === "commandorcontrol" || lower === "cmdorctrl")
        return "CommandOrControl";
      if (lower === "space") return "Space";
      if (lower === "return" || lower === "enter") return "Return";
      if (lower === "escape" || lower === "esc") return "Escape";
      if (lower === "backspace") return "Backspace";
      if (lower === "delete" || lower === "del") return "Delete";
      if (lower === "tab") return "Tab";
      if (lower === "rightalt" || lower === "rightoption") return "RightAlt";
      if (lower === "rightcontrol" || lower === "rightctrl")
        return "RightControl";
      if (lower === "rightshift") return "RightShift";
      if (lower === "rightcommand" || lower === "rightcmd")
        return "RightCommand";
      if (
        lower === "rightsuper" ||
        lower === "rightwin" ||
        lower === "rightmeta"
      )
        return "RightSuper";
      if (lower === "mousebutton4" || lower === "mouse4") return "MouseButton4";
      if (lower === "mousebutton5" || lower === "mouse5") return "MouseButton5";
      if (/^f\d+$/i.test(p)) return p.toUpperCase();
      if (p.length === 1) return p.toUpperCase();
      if (p === "Up" || p === "Down" || p === "Left" || p === "Right") return p;
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join("+");
}

// ---------------------------------------------------------------------------
// Language hotkeys (per-language dictation hotkeys) — pure helpers.
//
// Kept here rather than inline in index.ts so they're unit-testable: this
// file has no `electron` import (index.ts does, which makes it unimportable
// outside a running Electron process), matching why key-listener.ts and
// hotkey-recorder.ts are already separate from index.ts.
// ---------------------------------------------------------------------------

/**
 * Diff a desired language→accelerator map against the accelerators currently
 * registered, mirroring `registerHotkey`'s own "stop, then rebuild" shape
 * (index.ts) scoped to one map entry at a time instead of one global.
 *
 * `toRemove` is every currently-registered language whose desired
 * accelerator changed or is no longer present at all (removed from the map).
 * `toAdd` is every desired entry that isn't already registered unchanged —
 * i.e. every entry the caller still needs to attempt to (re)register after
 * tearing down `toRemove`. An entry present in both `desired` and `current`
 * with the identical accelerator is left alone ("unchanged, still running").
 */
export function diffLanguageHotkeys(
  desired: Record<string, string>,
  current: ReadonlyMap<string, string>,
): { toRemove: string[]; toAdd: Array<[lang: string, accel: string]> } {
  const toRemove: string[] = [];
  const unchanged = new Set<string>();
  for (const [lang, accel] of current) {
    if (desired[lang] === accel) {
      unchanged.add(lang);
    } else {
      toRemove.push(lang);
    }
  }
  const toAdd: Array<[string, string]> = [];
  for (const [lang, accel] of Object.entries(desired)) {
    if (!unchanged.has(lang)) toAdd.push([lang, accel]);
  }
  return { toRemove, toAdd };
}

/**
 * Whether a normalized accelerator is already claimed by the default
 * dictation hotkey, the remix hotkey, or another already-registered language
 * hotkey. Dictation and remix win on a clash; so does every language hotkey
 * already claimed — same "first writer wins, log and skip" shape
 * `registerRemixHotkey` uses against the dictation hotkey (index.ts).
 */
export function isLanguageHotkeyTaken(
  normalized: string,
  opts: {
    dictationAccel: string | null;
    remixAccel: string | null;
    claimedLanguageAccels: Iterable<string>;
  },
): boolean {
  if (normalized === opts.dictationAccel) return true;
  if (normalized === opts.remixAccel) return true;
  for (const claimed of opts.claimedLanguageAccels) {
    if (normalized === claimed) return true;
  }
  return false;
}
