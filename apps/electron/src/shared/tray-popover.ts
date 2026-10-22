/**
 * The data that the tray popover gets from the main process when it opens.
 * The popover reads the rest (recent dictations, the meeting title) from the
 * server.
 */
export interface TrayPopoverState {
  version: string;
  /** The dictation hotkey accelerator, or null before it is registered. */
  hotkey: string | null;
  hotkeyMode: "hold" | "toggle";
  /** True while a dictation records. */
  dictating: boolean;
  /** True when the meetings flag is on and this Mac can record a meeting. */
  meetingsAvailable: boolean;
  update: "idle" | "downloading" | "downloaded";
}

/**
 * The pages that the popover can open in the main window. "confirmMeeting"
 * is the Meetings page that asks the user to confirm changed devices (#169).
 */
export type TrayPopoverTarget =
  | "app"
  | "settings"
  | "history"
  | "confirmMeeting";
