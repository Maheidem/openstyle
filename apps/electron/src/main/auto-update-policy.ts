export type UpdateDownloadState = "idle" | "downloading" | "downloaded";

/**
 * True when the main process must start the update download by itself, with no
 * click on the update banner. The "Automatic updates" setting turns this on.
 *
 * The state check stops a second download while one runs or is done. The
 * self-update check stops a background download where only the releases page
 * can work (dev builds, Windows, Linux): that path opens a browser, and a
 * background task must not do that.
 */
export function shouldStartAutoDownload(input: {
  autoUpdateEnabled: boolean;
  downloadState: UpdateDownloadState;
  selfUpdateUnavailableReason: string | null;
}): boolean {
  return (
    input.autoUpdateEnabled &&
    input.downloadState === "idle" &&
    input.selfUpdateUnavailableReason === null
  );
}
