import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: vi.fn(),
}));
vi.mock("./native-binary", () => ({
  getNativeBinaryPath: () => "/fake/macos-meeting-capture",
}));
vi.mock("./system-audio-capture", () => ({
  isSystemAudioCaptureSupported: () => true,
}));

// Import after the mocks, so the module gets the fakes.
const { listAudioDevices } = await import("./meeting-capture-helper");

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** Make the fake execFile end with an error or with one stdout line. */
function execFileEnds(result: { err: Error } | { stdout: string }) {
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _options: object, cb: ExecCallback) => {
      if ("err" in result) cb(result.err, "", "");
      else cb(null, result.stdout, "");
    },
  );
}

describe("listAudioDevices", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it("kills a stuck helper with SIGKILL, because the helper ignores SIGTERM", async () => {
    execFileEnds({ stdout: '{"inputs":[],"outputs":[]}' });
    await listAudioDevices();

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = mocks.execFile.mock.calls[0];
    expect(file).toBe("/fake/macos-meeting-capture");
    expect(args).toEqual(["--list-devices"]);
    expect(options).toMatchObject({ timeout: 3000, killSignal: "SIGKILL" });
  });

  it("parses the device line", async () => {
    execFileEnds({
      stdout:
        '{"defaultInput":"mic","defaultOutput":null,"inputs":[{"uid":"mic","name":"Mic","transport":"usb "}],"outputs":[]}\n',
    });
    expect(await listAudioDevices()).toEqual({
      defaultInput: "mic",
      defaultOutput: null,
      inputs: [{ uid: "mic", name: "Mic", transport: "usb " }],
      outputs: [],
    });
  });

  it("returns null when the helper fails or is killed on timeout", async () => {
    execFileEnds({ err: new Error("Command failed: SIGKILL") });
    expect(await listAudioDevices()).toBeNull();
  });
});
