/**
 * The look of the tray (menu-bar) icon. It has no Electron import, so a unit
 * test can check it.
 */
export interface TrayAppearance {
  /**
   * "recording" is the red icon. "job" is the logo in a ring. "update" is the
   * logo with a badge dot. "default" is the normal logo.
   */
  icon: "default" | "recording" | "job" | "update";
  /**
   * macOS recolors a template image to match the menu bar. The red icon must
   * not be a template image, or macOS removes the red.
   */
  template: boolean;
  tooltip: string;
}

export interface TrayStatus {
  /** A meeting records. */
  recording: boolean;
  /** A meeting job or a model download or load runs or waits. */
  job: boolean;
  /** An update is downloaded and waits for a restart. */
  updateReady: boolean;
}

/**
 * The tray look for a status. The recording state wins over a job, and a job
 * wins over a ready update.
 */
export function trayAppearance(status: TrayStatus): TrayAppearance {
  if (status.recording) {
    return {
      icon: "recording",
      template: false,
      tooltip: "Openstyle — recording meeting",
    };
  }
  if (status.job) {
    return { icon: "job", template: true, tooltip: "Openstyle — working" };
  }
  if (status.updateReady) {
    return {
      icon: "update",
      template: true,
      tooltip: "Openstyle — update ready",
    };
  }
  return { icon: "default", template: true, tooltip: "Openstyle" };
}
