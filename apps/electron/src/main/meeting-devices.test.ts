import { describe, expect, it } from "vitest";
import { type AudioDevice, planKeys } from "../shared/meeting-devices";
import {
  type DeviceMemory,
  type DeviceSnapshot,
  EMPTY_DEVICE_MEMORY,
  isTransientBluetoothDefault,
  needsConfirmation,
  parseDeviceMemory,
  parseDeviceSnapshot,
  planMeetingDevices,
  rememberDefaultInput,
  rememberMeeting,
} from "./meeting-devices";

// Devices from the owner's report (#169). The Bluetooth UIDs follow the
// "<address>:input" / "<address>:output" shape that Core Audio uses.
const yeti: AudioDevice = {
  uid: "AppleUSBAudioEngine:Generic:Blue Microphones:2128BAH02E38:1",
  name: "Yeti Stereo Microphone",
  transport: "usb ",
};
const builtInMic: AudioDevice = {
  uid: "BuiltInMicrophoneDevice",
  name: "MacBook Pro Microphone",
  transport: "bltn",
};
const teams: AudioDevice = {
  uid: "MSLoopbackDriverDevice_UID",
  name: "Microsoft Teams Audio",
  transport: "virt",
};
const sonyIn: AudioDevice = {
  uid: "58-18-62-16-6C-1F:input",
  name: "WH-1000XM6",
  transport: "blue",
};
const sonyOut: AudioDevice = {
  uid: "58-18-62-16-6C-1F:output",
  name: "WH-1000XM6",
  transport: "blue",
};
const speakers: AudioDevice = {
  uid: "BuiltInSpeakerDevice",
  name: "MacBook Pro Speakers",
  transport: "bltn",
};
const airpodsIn: AudioDevice = {
  uid: "A0-AC-69-38-CA-68:input",
  name: "AirPods Pro",
  transport: "blue",
};

function snapshot(
  defaultInput: AudioDevice,
  defaultOutput: AudioDevice,
): DeviceSnapshot {
  return {
    defaultInput: defaultInput.uid,
    defaultOutput: defaultOutput.uid,
    inputs: [builtInMic, teams, yeti, sonyIn, airpodsIn],
    outputs: [speakers, sonyOut],
  };
}

const memoryWithYeti: DeviceMemory = {
  userDefaultInputUid: yeti.uid,
  lastMeeting: {
    input: { uid: yeti.uid, name: yeti.name },
    output: { uid: speakers.uid, name: speakers.name },
  },
};

describe("isTransientBluetoothDefault", () => {
  it("flags the headset mic when the headset is also the output", () => {
    expect(isTransientBluetoothDefault(snapshot(sonyIn, sonyOut))).toBe(true);
  });

  it("does not flag a Bluetooth mic with another output", () => {
    expect(isTransientBluetoothDefault(snapshot(sonyIn, speakers))).toBe(false);
  });

  it("does not flag a mic of another Bluetooth device", () => {
    expect(isTransientBluetoothDefault(snapshot(airpodsIn, sonyOut))).toBe(
      false,
    );
  });

  it("does not flag a wired mic", () => {
    expect(isTransientBluetoothDefault(snapshot(yeti, sonyOut))).toBe(false);
  });
});

describe("planMeetingDevices with System default", () => {
  it("uses the user's default input, not the transient headset mic (#169)", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(sonyIn, sonyOut),
      chosenMicName: null,
      memory: memoryWithYeti,
    });
    expect(plan.input).toEqual(yeti);
    expect(plan.skippedInput).toEqual(sonyIn);
    expect(plan.output).toEqual(sonyOut);
  });

  it("uses the previous meeting mic when no default input is remembered", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(sonyIn, sonyOut),
      chosenMicName: null,
      memory: { ...memoryWithYeti, userDefaultInputUid: null },
    });
    expect(plan.input).toEqual(yeti);
  });

  it("uses the built-in mic, not a virtual device, when nothing is remembered", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(sonyIn, sonyOut),
      chosenMicName: null,
      memory: EMPTY_DEVICE_MEMORY,
    });
    expect(plan.input).toEqual(builtInMic);
    expect(plan.skippedInput).toEqual(sonyIn);
  });

  it("skips a remembered mic that is not connected now", () => {
    const plan = planMeetingDevices({
      snapshot: {
        ...snapshot(sonyIn, sonyOut),
        inputs: [builtInMic, sonyIn],
      },
      chosenMicName: null,
      memory: memoryWithYeti,
    });
    expect(plan.input).toEqual(builtInMic);
  });

  it("keeps the headset mic when it is the only real input", () => {
    const plan = planMeetingDevices({
      snapshot: { ...snapshot(sonyIn, sonyOut), inputs: [teams, sonyIn] },
      chosenMicName: null,
      memory: EMPTY_DEVICE_MEMORY,
    });
    expect(plan.input).toEqual(sonyIn);
    expect(plan.skippedInput).toBeNull();
  });

  it("uses a Bluetooth default input when the output is another device", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(airpodsIn, speakers),
      chosenMicName: null,
      memory: memoryWithYeti,
    });
    expect(plan.input).toEqual(airpodsIn);
    expect(plan.skippedInput).toBeNull();
  });
});

describe("planMeetingDevices with a chosen mic", () => {
  it("uses a Bluetooth mic that the user chose, also with the headset output", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(sonyIn, sonyOut),
      chosenMicName: "WH-1000XM6",
      memory: memoryWithYeti,
    });
    expect(plan.input).toEqual(sonyIn);
    expect(plan.skippedInput).toBeNull();
  });

  it("matches a Chromium label with a 'Default - ' prefix and a tag", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(builtInMic, speakers),
      chosenMicName: "Default - MacBook Pro Microphone (Built-in)",
      memory: EMPTY_DEVICE_MEMORY,
    });
    expect(plan.input).toEqual(builtInMic);
  });

  it("keeps the name when the chosen mic is not in the list", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(builtInMic, speakers),
      chosenMicName: "Old USB Mic",
      memory: EMPTY_DEVICE_MEMORY,
    });
    expect(plan.input).toBeNull();
    expect(plan.inputName).toBe("Old USB Mic");
  });
});

describe("device change confirmation", () => {
  it("asks nothing before the first meeting", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(yeti, speakers),
      chosenMicName: null,
      memory: EMPTY_DEVICE_MEMORY,
    });
    expect(plan.changed).toBe(false);
    expect(needsConfirmation(plan, null)).toBe(false);
  });

  it("asks nothing when the devices are the same as last time", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(yeti, speakers),
      chosenMicName: null,
      memory: memoryWithYeti,
    });
    expect(plan.changed).toBe(false);
  });

  it("asks when the output changed, and accepts the confirmed keys", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(sonyIn, sonyOut),
      chosenMicName: null,
      memory: memoryWithYeti,
    });
    expect(plan.changed).toBe(true);
    expect(plan.previous?.output?.name).toBe(speakers.name);
    expect(needsConfirmation(plan, null)).toBe(true);
    expect(needsConfirmation(plan, planKeys(plan))).toBe(false);
  });

  it("asks again when the devices change after the confirmation", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(sonyIn, sonyOut),
      chosenMicName: null,
      memory: memoryWithYeti,
    });
    expect(
      needsConfirmation(plan, { input: yeti.uid, output: speakers.uid }),
    ).toBe(true);
  });

  it("asks when the mic changed", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(builtInMic, speakers),
      chosenMicName: null,
      memory: memoryWithYeti,
    });
    expect(plan.changed).toBe(true);
  });
});

describe("device memory", () => {
  it("remembers a default input that the user chose", () => {
    const memory = rememberDefaultInput(
      EMPTY_DEVICE_MEMORY,
      snapshot(yeti, sonyOut),
    );
    expect(memory.userDefaultInputUid).toBe(yeti.uid);
  });

  it("does not remember a transient headset default", () => {
    const memory = rememberDefaultInput(
      memoryWithYeti,
      snapshot(sonyIn, sonyOut),
    );
    expect(memory).toBe(memoryWithYeti);
  });

  it("stores the devices of a meeting and reads them back", () => {
    const plan = planMeetingDevices({
      snapshot: snapshot(sonyIn, sonyOut),
      chosenMicName: null,
      memory: memoryWithYeti,
    });
    const stored = JSON.stringify(rememberMeeting(memoryWithYeti, plan));
    expect(parseDeviceMemory(stored)).toEqual({
      userDefaultInputUid: yeti.uid,
      lastMeeting: {
        input: { uid: yeti.uid, name: yeti.name },
        output: { uid: sonyOut.uid, name: sonyOut.name },
      },
    });
  });

  it("reads a bad value as the empty memory", () => {
    expect(parseDeviceMemory("not json")).toEqual(EMPTY_DEVICE_MEMORY);
    expect(parseDeviceMemory(null)).toEqual(EMPTY_DEVICE_MEMORY);
  });
});

describe("parseDeviceSnapshot", () => {
  it("parses the helper line and drops bad entries", () => {
    const line = JSON.stringify({
      defaultInput: sonyIn.uid,
      defaultOutput: null,
      inputs: [sonyIn, { uid: 5 }],
      outputs: [sonyOut],
    });
    expect(parseDeviceSnapshot(line)).toEqual({
      defaultInput: sonyIn.uid,
      defaultOutput: null,
      inputs: [sonyIn],
      outputs: [sonyOut],
    });
  });

  it("returns null for a bad line", () => {
    expect(parseDeviceSnapshot("ERR")).toBeNull();
    expect(parseDeviceSnapshot("{}")).toBeNull();
  });
});
