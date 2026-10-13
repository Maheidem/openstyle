import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEETINGS_DIR_NAME, SYNC_JSON } from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRecorderDeps } from "./meeting-recorder";

/** The options that the recorder passes to the native helper. */
interface FakeHelperOptions {
  onFrame: (channel: "M" | "S", pcm: Buffer) => void;
  onReady?: () => void;
  onError?: (error: string) => void;
}

const mocks = vi.hoisted(() => ({
  userData: "",
  helpers: [] as {
    options: FakeHelperOptions;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[],
  systemCaptures: [] as {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userData },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));

// The disk guard reads the free space of the real volume. A fixed value keeps
// the tests the same on every machine.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  statfs: async () => ({ bavail: 1_000_000_000, bsize: 4096 }),
}));

vi.mock("./meeting-capture-helper", () => ({
  MeetingCaptureHelper: class {
    start = vi.fn(() => true);
    stop = vi.fn();
    constructor(public options: FakeHelperOptions) {
      mocks.helpers.push(this);
    }
  },
}));

vi.mock("./system-audio-capture", () => ({
  isSystemAudioCaptureSupported: () => true,
  SystemAudioCapture: class {
    start = vi.fn(() => true);
    stop = vi.fn();
    constructor() {
      mocks.systemCaptures.push(this);
    }
  },
}));

// Import after the mocks, so the recorder gets the fakes.
const { MeetingRecorder } = await import("./meeting-recorder");

/** 100 ms of silence: 16 kHz mono PCM16. */
const FRAME = Buffer.alloc(3200);

function fakeCaptureWindow() {
  return {
    on: vi.fn(),
    isDestroyed: () => false,
    destroy: vi.fn(),
    webContents: { id: 1 },
  };
}

function createRecorder() {
  const createCaptureWindow = vi.fn(fakeCaptureWindow);
  const recorder = new MeetingRecorder({
    serverFetch: async () => new Response("{}"),
    createCaptureWindow:
      createCaptureWindow as unknown as MeetingRecorderDeps["createCaptureWindow"],
    resolveMicLabel: async () => null,
    broadcastLevel: vi.fn(),
    broadcastStatus: vi.fn(),
  });
  return { recorder, createCaptureWindow };
}

/** Start a recording and wait until the recorder has made its native helper. */
async function startWithHelper(recorder: InstanceType<typeof MeetingRecorder>) {
  const started = recorder.start();
  await vi.waitFor(() => expect(mocks.helpers).toHaveLength(1));
  return { started, helper: mocks.helpers[0] };
}

function readJournal(meetingId: string) {
  const path = join(mocks.userData, MEETINGS_DIR_NAME, meetingId, SYNC_JSON);
  return JSON.parse(readFileSync(path, "utf-8")) as {
    micT0: number | null;
    systemT0: number | null;
    sharedClock: boolean;
    epochs: { reason: string }[];
  };
}

describe("MeetingRecorder capture start", () => {
  beforeEach(() => {
    mocks.userData = mkdtempSync(join(tmpdir(), "openstyle-recorder-test-"));
    mocks.helpers.length = 0;
    mocks.systemCaptures.length = 0;
  });

  afterEach(() => {
    rmSync(mocks.userData, { recursive: true, force: true });
  });

  it("stamps one shared T0 on both channels from the first native frame", async () => {
    const { recorder, createCaptureWindow } = createRecorder();
    const { started, helper } = await startWithHelper(recorder);

    helper.options.onReady?.();
    const meetingId = await started;
    // The first frame is a system frame. The mic channel gets the same T0.
    helper.options.onFrame("S", FRAME);
    helper.options.onFrame("M", FRAME);
    await recorder.stop();

    const journal = readJournal(meetingId);
    expect(journal.micT0).not.toBeNull();
    expect(journal.systemT0).not.toBeNull();
    expect(journal.micT0).toBe(journal.systemT0);
    expect(journal.sharedClock).toBe(true);
    // The native path does not start the fallback.
    expect(createCaptureWindow).not.toHaveBeenCalled();
    expect(mocks.systemCaptures).toHaveLength(0);
  });

  it("starts the fallback when the helper prints ERR_ before READY", async () => {
    const { recorder, createCaptureWindow } = createRecorder();
    const { started, helper } = await startWithHelper(recorder);

    helper.options.onError?.("ERR_PERMISSION_DENIED");
    const meetingId = await started;
    await recorder.stop();

    expect(helper.stop).toHaveBeenCalled();
    expect(createCaptureWindow).toHaveBeenCalledTimes(1);
    expect(mocks.systemCaptures).toHaveLength(1);
    expect(mocks.systemCaptures[0].start).toHaveBeenCalled();
    const journal = readJournal(meetingId);
    expect(journal.sharedClock).toBe(false);
    expect(journal.epochs.map((e) => e.reason)).toEqual(["start"]);
  });

  it("starts the fallback and stamps a fallback epoch when the helper fails after READY", async () => {
    const { recorder, createCaptureWindow } = createRecorder();
    const { started, helper } = await startWithHelper(recorder);

    helper.options.onReady?.();
    const meetingId = await started;
    helper.options.onFrame("M", FRAME);
    helper.options.onError?.("ERR_DEVICE_LOST");
    await recorder.stop();

    expect(helper.stop).toHaveBeenCalled();
    expect(createCaptureWindow).toHaveBeenCalledTimes(1);
    expect(mocks.systemCaptures).toHaveLength(1);
    const journal = readJournal(meetingId);
    expect(journal.epochs.map((e) => e.reason)).toEqual(["start", "fallback"]);
  });

  it("keeps the native path when only the mic is lost after READY", async () => {
    const { recorder, createCaptureWindow } = createRecorder();
    const { started, helper } = await startWithHelper(recorder);

    helper.options.onReady?.();
    const meetingId = await started;
    helper.options.onError?.("ERR_MIC_LOST");
    await recorder.stop();

    expect(createCaptureWindow).not.toHaveBeenCalled();
    expect(mocks.systemCaptures).toHaveLength(0);
    expect(readJournal(meetingId).epochs.map((e) => e.reason)).toEqual([
      "start",
    ]);
  });
});
