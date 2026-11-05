import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenstyleApi } from "../preload/index";
import type { MeetingRecorder } from "./meeting-recorder";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  api: null as OpenstyleApi | null,
  start: vi.fn(async () => "meeting-1"),
  recorder: {} as Partial<MeetingRecorder>,
}));

vi.mock("@electron-toolkit/preload", () => ({ electronAPI: {} }));
vi.mock("electron", () => ({
  app: { getPath: () => "/unused" },
  shell: { showItemInFolder: vi.fn() },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
    on: vi.fn(),
  },
  ipcRenderer: {
    invoke: async (name: string, ...args: unknown[]) =>
      mocks.handlers.get(name)?.({}, ...args),
  },
  contextBridge: {
    exposeInMainWorld: (name: string, value: OpenstyleApi) => {
      if (name === "api") mocks.api = value;
    },
  },
  webUtils: {},
}));
vi.mock("./meeting-recorder", () => ({
  MeetingDevicesChangedError: class extends Error {},
}));
vi.mock("./system-audio-capture", () => ({
  isSystemAudioCaptureSupported: () => true,
}));
vi.mock("./system-audio-probe", () => ({
  openAudioCaptureSettings: vi.fn(),
  probeSystemAudio: vi.fn(),
}));

const { registerMeetingIpc } = await import("./meeting-ipc");
await import("../preload/index");

beforeEach(() => {
  mocks.start.mockClear();
  mocks.handlers.clear();
  mocks.recorder = { start: mocks.start };
  registerMeetingIpc({
    getMeetingRecorder: () => mocks.recorder as MeetingRecorder,
    serverClient: () => {
      throw new Error("unused");
    },
  });
});

describe("meeting folder IPC", () => {
  it.each([
    "folder-1",
    null,
    undefined,
  ])("passes target %s from preload to recorder", async (folderId) => {
    const confirmed = { input: "mic-1", output: "out-1" };
    expect(await mocks.api!.startMeetingRecording(confirmed, folderId)).toEqual(
      { ok: true, id: "meeting-1" },
    );
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(confirmed, folderId);
  });

  it.each([
    "",
    "x".repeat(129),
    123,
    {},
    [],
  ])("rejects an invalid folder target %j", async (folderId) => {
    const res = await mocks.handlers.get("meeting:start")!(
      {},
      undefined,
      folderId,
    );
    expect(res).toEqual({ ok: false, code: "invalid_folder" });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("keeps start calls with no target valid", async () => {
    expect(await mocks.api!.startMeetingRecording()).toEqual({
      ok: true,
      id: "meeting-1",
    });
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(null, undefined);
  });
});

describe("meeting status IPC", () => {
  it("sends the recording start time while a meeting records", async () => {
    mocks.recorder = {
      status: "recording",
      currentMeetingId: "meeting-1",
      recordingStartedAt: 1_760_000_000_000,
      recordingPausedAt: null,
    };
    expect(await mocks.api!.getMeetingStatus()).toEqual({
      status: "recording",
      meetingId: "meeting-1",
      startedAt: 1_760_000_000_000,
      pausedAt: null,
      supported: true,
    });
  });

  it("sends the pause time while a recording is paused", async () => {
    mocks.recorder = {
      status: "recording",
      currentMeetingId: "meeting-1",
      recordingStartedAt: 1_760_000_005_000,
      recordingPausedAt: 1_760_000_020_000,
    };
    expect(await mocks.api!.getMeetingStatus()).toMatchObject({
      startedAt: 1_760_000_005_000,
      pausedAt: 1_760_000_020_000,
    });
  });

  it("sends no start time while no meeting records", async () => {
    mocks.recorder = {
      status: "idle",
      currentMeetingId: null,
      recordingStartedAt: null,
      recordingPausedAt: null,
    };
    expect(await mocks.api!.getMeetingStatus()).toEqual({
      status: "idle",
      meetingId: null,
      startedAt: null,
      pausedAt: null,
      supported: true,
    });
  });
});

describe("meeting pause IPC", () => {
  it("calls pause and resume of the recorder", async () => {
    const pause = vi.fn(async () => {});
    const resume = vi.fn(async () => {});
    mocks.recorder = { pause, resume };
    expect(await mocks.api!.pauseMeetingRecording()).toEqual({ ok: true });
    expect(await mocks.api!.resumeMeetingRecording()).toEqual({ ok: true });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("returns the message of a failed resume", async () => {
    mocks.recorder = {
      resume: vi.fn(async () => {
        throw new Error("The microphone did not start again.");
      }),
    };
    expect(await mocks.api!.resumeMeetingRecording()).toEqual({
      ok: false,
      error: "The microphone did not start again.",
    });
  });
});
