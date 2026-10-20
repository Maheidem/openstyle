import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenstyleApi } from "../preload/index";
import type { MeetingRecorder } from "./meeting-recorder";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  api: null as OpenstyleApi | null,
  start: vi.fn(async () => "meeting-1"),
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
  registerMeetingIpc({
    getMeetingRecorder: () =>
      ({ start: mocks.start }) as unknown as MeetingRecorder,
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
