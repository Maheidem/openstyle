import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEETINGS_DIR_NAME, SYNC_JSON } from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRecorderDeps } from "./meeting-recorder";

/** The options that the recorder passes to the native helper. */
interface FakeHelperOptions {
  mic: { uid: string } | { name: string } | null;
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
const { MeetingRecorder, MeetingDevicesChangedError } = await import(
  "./meeting-recorder"
);

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

function createRecorder(
  extra: {
    serverFetch?: MeetingRecorderDeps["serverFetch"];
    findCurrentEvent?: MeetingRecorderDeps["findCurrentEvent"];
    listAudioDevices?: MeetingRecorderDeps["listAudioDevices"];
  } = {},
) {
  const createCaptureWindow = vi.fn(fakeCaptureWindow);
  const recorder = new MeetingRecorder({
    serverFetch: extra.serverFetch ?? (async () => new Response("{}")),
    findCurrentEvent: extra.findCurrentEvent ?? (async () => null),
    createCaptureWindow:
      createCaptureWindow as unknown as MeetingRecorderDeps["createCaptureWindow"],
    resolveMicLabel: async () => null,
    listAudioDevices: extra.listAudioDevices ?? (async () => null),
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
    vi.useRealTimers();
    rmSync(mocks.userData, { recursive: true, force: true });
  });

  it("stamps one shared T0 on both channels from the first native frame", async () => {
    const { recorder, createCaptureWindow } = createRecorder();
    const { started, helper } = await startWithHelper(recorder);

    helper.options.onReady?.();
    const meetingId = await started;
    // Fake only Date. The recorder timers and vi.waitFor need real timers.
    // The clock moves between the two frames, so a T0 for each channel differs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    // The first frame is a system frame. The mic channel gets the same T0.
    helper.options.onFrame("S", FRAME);
    vi.setSystemTime(1_700_000_000_500);
    helper.options.onFrame("M", FRAME);
    vi.useRealTimers();
    await recorder.stop();

    const journal = readJournal(meetingId);
    expect(journal.systemT0).toBe(1_700_000_000_000);
    expect(journal.micT0).toBe(1_700_000_000_000);
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

describe("MeetingRecorder calendar link", () => {
  beforeEach(() => {
    mocks.userData = mkdtempSync(join(tmpdir(), "openstyle-recorder-test-"));
    mocks.helpers.length = 0;
    mocks.systemCaptures.length = 0;
  });

  afterEach(() => {
    rmSync(mocks.userData, { recursive: true, force: true });
  });

  /** The JSON body of the POST /meetings/start call. */
  function startBody(calls: { path: string; body: unknown }[]) {
    return calls.find((c) => c.path === "/meetings/start")?.body as Record<
      string,
      unknown
    >;
  }

  function recordingFetch(calls: { path: string; body: unknown }[]) {
    return async (path: string, init?: RequestInit) => {
      calls.push({
        path,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response("{}");
    };
  }

  const EVENT = {
    id: "evt-1",
    title: "Fictional sync",
    start: 1_700_000_000_000,
    end: 1_700_003_600_000,
    url: null,
    attendees: [{ name: "Ana", email: "ana@example.test", isOrganizer: true }],
  };

  it("sends the found event in the start body", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const { recorder } = createRecorder({
      serverFetch: recordingFetch(calls),
      findCurrentEvent: async () => EVENT,
    });
    const { started, helper } = await startWithHelper(recorder);
    helper.options.onReady?.();
    await started;
    expect(startBody(calls).calendar).toEqual(EVENT);
    await recorder.stop();
  });

  it("sends no calendar field when no event is found", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const { recorder } = createRecorder({
      serverFetch: recordingFetch(calls),
    });
    const { started, helper } = await startWithHelper(recorder);
    helper.options.onReady?.();
    await started;
    expect("calendar" in startBody(calls)).toBe(false);
    await recorder.stop();
  });

  it("still records when the calendar lookup throws", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const { recorder } = createRecorder({
      serverFetch: recordingFetch(calls),
      findCurrentEvent: async () => {
        throw new Error("helper crashed");
      },
    });
    const { started, helper } = await startWithHelper(recorder);
    helper.options.onReady?.();
    await started;
    expect("calendar" in startBody(calls)).toBe(false);
    expect(recorder.status).toBe("recording");
    await recorder.stop();
  });
});

describe("MeetingRecorder audio devices (#169)", () => {
  const yeti = { uid: "usb-yeti", name: "Yeti", transport: "usb " };
  const sonyIn = { uid: "58-18:input", name: "WH-1000XM6", transport: "blue" };
  const sonyOut = {
    uid: "58-18:output",
    name: "WH-1000XM6",
    transport: "blue",
  };
  const speakers = { uid: "spk", name: "Speakers", transport: "bltn" };
  /** macOS made the headset mic the default after the output went to it. */
  const transient = {
    defaultInput: sonyIn.uid,
    defaultOutput: sonyOut.uid,
    inputs: [yeti, sonyIn],
    outputs: [speakers, sonyOut],
  };

  beforeEach(() => {
    mocks.userData = mkdtempSync(join(tmpdir(), "openstyle-recorder-test-"));
    mocks.helpers.length = 0;
    mocks.systemCaptures.length = 0;
  });

  afterEach(() => {
    rmSync(mocks.userData, { recursive: true, force: true });
  });

  /** A server fake that keeps settings in a map. */
  function settingsFetch(settings: Map<string, string>) {
    return async (path: string, init?: RequestInit) => {
      const key = path.startsWith("/settings/") ? path.slice(10) : null;
      if (key && init?.method === "PUT") {
        settings.set(key, JSON.parse(init.body as string).value);
      }
      if (key && settings.has(key)) {
        return new Response(JSON.stringify({ value: settings.get(key) }));
      }
      return new Response("{}");
    };
  }

  const lastMeetingWith = (output: { uid: string; name: string }) =>
    JSON.stringify({
      userDefaultInputUid: yeti.uid,
      lastMeeting: { input: { uid: yeti.uid, name: yeti.name }, output },
    });

  it("opens the user's mic, not the transient headset mic", async () => {
    const settings = new Map([
      ["meeting_audio_devices", lastMeetingWith(sonyOut)],
    ]);
    const { recorder } = createRecorder({
      serverFetch: settingsFetch(settings),
      listAudioDevices: async () => transient,
    });
    const { started, helper } = await startWithHelper(recorder);
    expect(helper.options.mic).toEqual({ uid: yeti.uid });
    helper.options.onReady?.();
    await started;
    await recorder.stop();
  });

  it("refuses to start when the devices changed, then starts after the confirmation", async () => {
    const settings = new Map([
      ["meeting_audio_devices", lastMeetingWith(speakers)],
    ]);
    const { recorder } = createRecorder({
      serverFetch: settingsFetch(settings),
      listAudioDevices: async () => transient,
    });

    const error = await recorder.start().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MeetingDevicesChangedError);
    const plan = (error as InstanceType<typeof MeetingDevicesChangedError>)
      .plan;
    expect(plan.input?.uid).toBe(yeti.uid);
    expect(plan.output?.uid).toBe(sonyOut.uid);
    expect(plan.skippedInput?.uid).toBe(sonyIn.uid);
    expect(recorder.status).toBe("idle");
    expect(mocks.helpers).toHaveLength(0);

    const started = recorder.start({ input: yeti.uid, output: sonyOut.uid });
    await vi.waitFor(() => expect(mocks.helpers).toHaveLength(1));
    mocks.helpers[0].options.onReady?.();
    await started;
    await recorder.stop();
    // The new devices are now the devices of the last meeting.
    const stored = JSON.parse(settings.get("meeting_audio_devices") ?? "{}");
    expect(stored.lastMeeting.output.uid).toBe(sonyOut.uid);
  });

  it("opens the replacement mic in the fallback window too", async () => {
    const settings = new Map([
      ["meeting_audio_devices", lastMeetingWith(sonyOut)],
    ]);
    const { recorder, createCaptureWindow } = createRecorder({
      serverFetch: settingsFetch(settings),
      listAudioDevices: async () => transient,
    });
    const { started, helper } = await startWithHelper(recorder);
    helper.options.onError?.("ERR_START -1");
    await started;
    await recorder.stop();
    expect(createCaptureWindow).toHaveBeenCalledWith(yeti.name);
  });

  it("refuses a second start() while the first one waits for the device list", async () => {
    const startCalls: string[] = [];
    let releaseList: (snapshot: typeof transient) => void = () => {};
    const list = new Promise<typeof transient>((resolve) => {
      releaseList = resolve;
    });
    const { recorder } = createRecorder({
      serverFetch: async (path: string) => {
        if (path === "/meetings/start") startCalls.push(path);
        return new Response("{}");
      },
      listAudioDevices: () => list,
    });

    // The status stays "idle" while the first call waits for the list.
    const first = recorder.start();
    expect(recorder.status).toBe("idle");
    await expect(recorder.start()).rejects.toThrow(
      "A meeting recording is already in progress",
    );

    releaseList(transient);
    await vi.waitFor(() => expect(mocks.helpers).toHaveLength(1));
    mocks.helpers[0].options.onReady?.();
    await first;
    expect(startCalls).toHaveLength(1);
    expect(mocks.helpers).toHaveLength(1);
    // The refusal does not stop the recording of the first call.
    expect(recorder.status).toBe("recording");
    await recorder.stop();

    // The flag is clear again: a new start() works.
    const again = recorder.start();
    await vi.waitFor(() => expect(mocks.helpers).toHaveLength(2));
    mocks.helpers[1].options.onReady?.();
    await again;
    await recorder.stop();
  });

  it("clears the start flag when the first start() fails", async () => {
    const { recorder } = createRecorder({
      serverFetch: async () => new Response("{}", { status: 500 }),
    });
    await expect(recorder.start()).rejects.toThrow(
      "Failed to create meeting row (HTTP 500)",
    );
    expect(recorder.status).toBe("idle");
    // A failed start() must not block the next one with "already in progress".
    await expect(recorder.start()).rejects.toThrow(
      "Failed to create meeting row (HTTP 500)",
    );
  });

  it("keeps the old path when the device list is not available", async () => {
    const { recorder } = createRecorder();
    const { started, helper } = await startWithHelper(recorder);
    expect(helper.options.mic).toBeNull();
    helper.options.onReady?.();
    await started;
    await recorder.stop();
  });
});
