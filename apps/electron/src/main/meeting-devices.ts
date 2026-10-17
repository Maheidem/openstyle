/**
 * Meeting audio devices: which mic a recording opens, and whether the user
 * must confirm the devices first (issue #169).
 *
 * The native helper lists the devices with `--list-devices`. This module has
 * no I/O, so unit tests cover all of the rules.
 *
 * The transient default: when the user sends the OUTPUT to a Bluetooth
 * headset, coreaudiod can make the headset mic the default input by itself
 * ("SetDefaultDevice: 'dIn ' | transient"). Sound settings still show the
 * mic that the user chose. Core Audio has no public property for this
 * (AudioHardware.h has only kAudioHardwarePropertyDefaultInputDevice). So
 * the rule uses the pattern: with "System default", a Bluetooth default input
 * that is the same device as the Bluetooth default output is a suspect.
 * Openstyle then uses the last default input that was not a suspect, then
 * the mic of the previous meeting, then the built-in mic or another mic that
 * is not Bluetooth or virtual. When no such mic exists, it keeps the headset
 * mic. A Bluetooth mic that the user chooses in Settings is always used.
 */

import {
  type AudioDevice,
  type ConfirmedDevices,
  type DeviceRef,
  type MeetingDevicePlan,
  planKeys,
} from "../shared/meeting-devices";

export interface DeviceSnapshot {
  defaultInput: string | null;
  defaultOutput: string | null;
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}

/** Stored in the `meeting_audio_devices` setting as JSON. */
export interface DeviceMemory {
  /** The last macOS default input that was not a transient suspect. */
  userDefaultInputUid: string | null;
  /** The devices of the last recording that started. */
  lastMeeting: MeetingDevicePlan["previous"];
}

export const EMPTY_DEVICE_MEMORY: DeviceMemory = {
  userDefaultInputUid: null,
  lastMeeting: null,
};

// kAudioDeviceTransportTypeBluetooth / ...BluetoothLE / ...BuiltIn /
// ...Virtual (AudioHardwareBase.h).
const BLUETOOTH = new Set(["blue", "blea"]);
const BUILT_IN = "bltn";
const VIRTUAL = "virt";

function isDevice(value: unknown): value is AudioDevice {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.uid === "string" &&
    v.uid.length > 0 &&
    typeof v.name === "string" &&
    typeof v.transport === "string"
  );
}

/** Parse the `--list-devices` line. Return null for a bad line. */
export function parseDeviceSnapshot(text: string): DeviceSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.inputs) || !Array.isArray(r.outputs)) return null;
  return {
    defaultInput: typeof r.defaultInput === "string" ? r.defaultInput : null,
    defaultOutput: typeof r.defaultOutput === "string" ? r.defaultOutput : null,
    inputs: r.inputs.filter(isDevice),
    outputs: r.outputs.filter(isDevice),
  };
}

function isRef(value: unknown): value is DeviceRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.uid === "string" && typeof v.name === "string";
}

/** Parse the stored memory. A missing or bad value gives the empty memory. */
export function parseDeviceMemory(raw: string | null): DeviceMemory {
  if (!raw) return EMPTY_DEVICE_MEMORY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_DEVICE_MEMORY;
  }
  if (typeof value !== "object" || value === null) return EMPTY_DEVICE_MEMORY;
  const v = value as Record<string, unknown>;
  const last = v.lastMeeting as Record<string, unknown> | null | undefined;
  return {
    userDefaultInputUid:
      typeof v.userDefaultInputUid === "string" ? v.userDefaultInputUid : null,
    lastMeeting:
      typeof last === "object" && last !== null
        ? {
            input: isRef(last.input) ? last.input : null,
            output: isRef(last.output) ? last.output : null,
          }
        : null,
  };
}

function isBluetooth(device: AudioDevice): boolean {
  return BLUETOOTH.has(device.transport);
}

/**
 * True when two Bluetooth devices are the two halves of one headset. Core
 * Audio gives them UIDs like "58-18-62-16-6C-1F:input" and
 * "58-18-62-16-6C-1F:output" (the Bluetooth address), and the same name.
 */
function sameHeadset(input: AudioDevice, output: AudioDevice): boolean {
  if (!isBluetooth(input) || !isBluetooth(output)) return false;
  const address = (uid: string): string =>
    uid.includes(":") ? uid.slice(0, uid.lastIndexOf(":")) : uid;
  return (
    address(input.uid) === address(output.uid) || input.name === output.name
  );
}

function findDevice(
  devices: AudioDevice[],
  uid: string | null | undefined,
): AudioDevice | null {
  if (!uid) return null;
  return devices.find((d) => d.uid === uid) ?? null;
}

/**
 * True when the default input is the mic of the Bluetooth headset that is
 * also the default output. macOS sets this default by itself when the
 * output goes to the headset.
 */
export function isTransientBluetoothDefault(snapshot: DeviceSnapshot): boolean {
  const input = findDevice(snapshot.inputs, snapshot.defaultInput);
  const output = findDevice(snapshot.outputs, snapshot.defaultOutput);
  return input !== null && output !== null && sameHeadset(input, output);
}

/**
 * Drop a "Default - " prefix and trailing "(...)" tags. Chromium adds them to
 * the Core Audio name. Same rule as normalizedMicName in the Swift helper.
 */
function normalizedMicName(name: string): string {
  let text = name.trim();
  if (text.startsWith("Default - ")) text = text.slice("Default - ".length);
  while (text.endsWith(")")) {
    const open = text.lastIndexOf("(");
    if (open < 0) break;
    const head = text.slice(0, open).trim();
    if (head.length === 0) break;
    text = head;
  }
  return text;
}

/** The one input with this name, or null when none or more than one match. */
function inputByName(
  inputs: AudioDevice[],
  wanted: string,
): AudioDevice | null {
  let matches = inputs.filter((d) => d.name === wanted);
  if (matches.length === 0) {
    const normalized = normalizedMicName(wanted);
    matches = inputs.filter((d) => normalizedMicName(d.name) === normalized);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** The mic to use in place of a transient default, or null for none. */
function replacementInput(
  snapshot: DeviceSnapshot,
  memory: DeviceMemory,
  skipped: AudioDevice,
): AudioDevice | null {
  const usable = (d: AudioDevice | null): d is AudioDevice =>
    d !== null && d.uid !== skipped.uid;
  const remembered = [
    findDevice(snapshot.inputs, memory.userDefaultInputUid),
    findDevice(snapshot.inputs, memory.lastMeeting?.input?.uid),
  ].find(usable);
  if (remembered) return remembered;
  const real = snapshot.inputs.filter(
    (d) => usable(d) && !isBluetooth(d) && d.transport !== VIRTUAL,
  );
  return real.find((d) => d.transport === BUILT_IN) ?? real[0] ?? null;
}

function sameRef(
  a: DeviceRef | null | undefined,
  uid: string | null,
  name: string | null,
): boolean {
  if (!a) return uid === null && name === null;
  return uid !== null ? a.uid === uid : a.name === name;
}

/**
 * Decide the devices of a new recording.
 *
 * `chosenMicName` is the label of the mic that the user chose in Settings, or
 * null for "System default".
 */
export function planMeetingDevices({
  snapshot,
  chosenMicName,
  memory,
}: {
  snapshot: DeviceSnapshot;
  chosenMicName: string | null;
  memory: DeviceMemory;
}): MeetingDevicePlan {
  const output = findDevice(snapshot.outputs, snapshot.defaultOutput);
  let input: AudioDevice | null;
  let skippedInput: AudioDevice | null = null;
  if (chosenMicName !== null) {
    input = inputByName(snapshot.inputs, chosenMicName);
  } else {
    input = findDevice(snapshot.inputs, snapshot.defaultInput);
    if (input && isTransientBluetoothDefault(snapshot)) {
      const replacement = replacementInput(snapshot, memory, input);
      if (replacement) {
        skippedInput = input;
        input = replacement;
      }
    }
  }
  const inputName = input?.name ?? chosenMicName;
  const previous = memory.lastMeeting;
  const changed =
    previous !== null &&
    (!sameRef(previous.input, input?.uid ?? null, inputName) ||
      !sameRef(previous.output, output?.uid ?? null, output?.name ?? null));
  return { input, inputName, output, skippedInput, changed, previous };
}

/** Remember the macOS default input when it is not a transient suspect. */
export function rememberDefaultInput(
  memory: DeviceMemory,
  snapshot: DeviceSnapshot,
): DeviceMemory {
  const input = findDevice(snapshot.inputs, snapshot.defaultInput);
  if (!input || isTransientBluetoothDefault(snapshot)) return memory;
  if (memory.userDefaultInputUid === input.uid) return memory;
  return { ...memory, userDefaultInputUid: input.uid };
}

/** Remember the devices of a recording that started. */
export function rememberMeeting(
  memory: DeviceMemory,
  plan: MeetingDevicePlan,
): DeviceMemory {
  const ref = (d: AudioDevice | null): DeviceRef | null =>
    d ? { uid: d.uid, name: d.name } : null;
  return {
    ...memory,
    lastMeeting: {
      input:
        ref(plan.input) ??
        (plan.inputName ? { uid: "", name: plan.inputName } : null),
      output: ref(plan.output),
    },
  };
}

/** True when the user must confirm this plan before the recording starts. */
export function needsConfirmation(
  plan: MeetingDevicePlan,
  confirmed: ConfirmedDevices | null | undefined,
): boolean {
  if (!plan.changed) return false;
  if (!confirmed) return true;
  const keys = planKeys(plan);
  return keys.input !== confirmed.input || keys.output !== confirmed.output;
}
