/**
 * Single source of truth for the default push-to-talk hotkey.
 *
 * - macOS: Control+Alt — a bare modifier chord in hold mode. Only the
 *   native key listener sees it (Electron globalShortcut cannot register a
 *   modifier-only accelerator). Fn (Globe) stays a choice in Settings.
 * - Windows: Right Alt — a single dedicated key, no modifier chord needed
 * - Linux: Control+Alt+Space — no Super key, so the OS launcher /
 *   Start menu never fires alongside dictation, and the real key lets the
 *   native listeners suppress the chord from reaching the focused app
 *
 * Imported by both the main process and the preload script (which exposes it
 * to the renderer as `window.api.defaultHotkey`).
 */
export function getDefaultHotkey(platform: string = process.platform): string {
  switch (platform) {
    case "darwin":
      return "Control+Alt";
    case "win32":
      return "RightAlt";
    default:
      return "Control+Alt+Space";
  }
}
