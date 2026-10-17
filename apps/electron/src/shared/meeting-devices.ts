/** Meeting audio device types. Main and the renderer share them (#169). */

export interface AudioDevice {
  uid: string;
  name: string;
  /** Four-character Core Audio transport code, for example "blue" or "bltn". */
  transport: string;
}

/** A device as the app stores it. */
export interface DeviceRef {
  uid: string;
  name: string;
}

export interface MeetingDevicePlan {
  /** The mic to open. Null when the chosen mic is not in the list. */
  input: AudioDevice | null;
  /** The name to show for the mic. */
  inputName: string | null;
  output: AudioDevice | null;
  /** The transient Bluetooth default input that the plan did not use. */
  skippedInput: AudioDevice | null;
  /** True when the devices differ from the previous meeting. */
  changed: boolean;
  /** The devices of the previous meeting, to show next to the new ones. */
  previous: { input: DeviceRef | null; output: DeviceRef | null } | null;
}

/** The device keys that a user confirmed. */
export interface ConfirmedDevices {
  input: string | null;
  output: string | null;
}

export function planKeys(plan: MeetingDevicePlan): ConfirmedDevices {
  return {
    input: plan.input?.uid ?? plan.inputName,
    output: plan.output?.uid ?? null,
  };
}
