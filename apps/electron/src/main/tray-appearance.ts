/**
 * The look of the tray (menu-bar) icon. It has no Electron import, so a unit
 * test can check it.
 */
export interface TrayAppearance {
  /** "recording" is the red icon. "default" is the normal logo. */
  icon: "default" | "recording";
  /**
   * macOS recolors a template image to match the menu bar. The red icon must
   * not be a template image, or macOS removes the red.
   */
  template: boolean;
  tooltip: string;
}

/** The tray look while a meeting records (`recording`), or at other times. */
export function trayAppearance(recording: boolean): TrayAppearance {
  return recording
    ? {
        icon: "recording",
        template: false,
        tooltip: "Openstyle — recording meeting",
      }
    : { icon: "default", template: true, tooltip: "Openstyle" };
}
