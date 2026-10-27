// Text of the confirm dialog for the switch from a Dev (alpha) build to
// Stable. While a meeting records, the dialog says that the switch stops the
// recording (owner decision 2026-10-27: no wait, no queue).
export function stableSwitchDialogKeys(recording: boolean): {
  desc: string;
  action: string;
} {
  return recording
    ? {
        desc: "settings.application.updateChannelStableRecordingDesc",
        action: "settings.application.updateChannelStableRecordingAction",
      }
    : {
        desc: "settings.application.updateChannelStableDesc",
        action: "settings.application.updateChannelStableAction",
      };
}
