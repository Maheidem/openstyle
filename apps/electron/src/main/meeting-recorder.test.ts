import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEETINGS_DIR_NAME,
  MIC_WAV,
  SYNC_JSON,
  SYSTEM_WAV,
  trackRatioWarning,
} from "@openstyle/validations";
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
    exited: ReturnType<typeof vi.fn>;
  }[],
  systemCaptures: [] as {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[],
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@openstyle/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openstyle/utils")>()),
  createAppLogger: () => mocks.log,
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
    exited = vi.fn(async () => {});
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
  const broadcastStatus = vi.fn();
  const recorder = new MeetingRecorder({
    serverFetch: extra.serverFetch ?? (async () => new Response("{}")),
    findCurrentEvent: extra.findCurrentEvent ?? (async () => null),
    createCaptureWindow:
      createCaptureWindow as unknown as MeetingRecorderDeps["createCaptureWindow"],
    resolveMicLabel: async () => null,
    listAudioDevices: extra.listAudioDevices ?? (async () => null),
    broadcastLevel: vi.fn(),
    broadcastStatus,
  });
  return { recorder, createCaptureWindow, broadcastStatus };
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
    micSamples: number;
    systemSamples: number;
    epochs: {
      reason: string;
      wallclockMs: number;
      micSamples: number;
      systemSamples: number;
    }[];
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

  it.each([
    "folder-1",
    null,
    undefined,
  ])("sends the folder target %s in the start body", async (folderId) => {
    const calls: { path: string; body: unknown }[] = [];
    const { recorder } = createRecorder({ serverFetch: recordingFetch(calls) });
    const started = recorder.start(undefined, folderId);
    await vi.waitFor(() => expect(mocks.helpers).toHaveLength(1));
    mocks.helpers[0].options.onReady?.();
    await started;
    if (folderId === undefined)
      expect(startBody(calls)).not.toHaveProperty("folder_id");
    else expect(startBody(calls)).toHaveProperty("folder_id", folderId);
    await recorder.stop();
  });

  it("does not start capture when the server rejects the folder", async () => {
    const { recorder } = createRecorder({
      serverFetch: async (path) =>
        new Response("{}", { status: path === "/meetings/start" ? 404 : 200 }),
    });
    await expect(recorder.start(undefined, "missing-folder")).rejects.toThrow(
      "HTTP 404",
    );
    expect(mocks.helpers).toHaveLength(0);
    expect(recorder.status).toBe("idle");
  });

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

  it("broadcasts the start time that it sends to the server", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const { recorder, broadcastStatus } = createRecorder({
      serverFetch: recordingFetch(calls),
    });
    const { started, helper } = await startWithHelper(recorder);
    helper.options.onReady?.();
    await started;
    const startedAt = startBody(calls).started_at;
    expect(typeof startedAt).toBe("number");
    expect(recorder.recordingStartedAt).toBe(startedAt);
    expect(broadcastStatus.mock.calls).toEqual([
      ["recording", startedAt, null],
    ]);

    await recorder.stop();
    expect(recorder.recordingStartedAt).toBeNull();
    expect(broadcastStatus.mock.calls.slice(1)).toEqual([
      ["finalizing", null, null],
      ["idle", null, null],
    ]);
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

describe("MeetingRecorder track length check (issue #170)", () => {
  beforeEach(() => {
    mocks.userData = mkdtempSync(join(tmpdir(), "openstyle-recorder-test-"));
    mocks.helpers.length = 0;
    mocks.systemCaptures.length = 0;
    mocks.log.warn.mockClear();
  });

  afterEach(() => {
    rmSync(mocks.userData, { recursive: true, force: true });
  });

  /** Record `micFrames` and `systemFrames` frames of 100 ms, then stop. */
  async function recordFrames(micFrames: number, systemFrames: number) {
    const { recorder } = createRecorder();
    const { started, helper } = await startWithHelper(recorder);
    helper.options.onReady?.();
    await started;
    for (let i = 0; i < micFrames; i++) helper.options.onFrame("M", FRAME);
    for (let i = 0; i < systemFrames; i++) helper.options.onFrame("S", FRAME);
    await recorder.stop();
  }

  const trackWarnings = () =>
    mocks.log.warn.mock.calls.filter(([line]) =>
      String(line).startsWith("Track length check failed"),
    );

  it("logs a warning when the system track is 1/3 of the mic track", async () => {
    await recordFrames(600, 200); // 60 s mic, 20 s system
    expect(trackWarnings()).toHaveLength(1);
    expect(String(trackWarnings()[0][0])).toContain("system/mic = 0.333");
  });

  it("logs nothing when both tracks have the same length", async () => {
    await recordFrames(600, 600);
    expect(trackWarnings()).toHaveLength(0);
  });
});

describe("MeetingRecorder E2E fake capture", () => {
  beforeEach(() => {
    mocks.userData = mkdtempSync(join(tmpdir(), "openstyle-recorder-test-"));
    mocks.helpers.length = 0;
    mocks.systemCaptures.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(mocks.userData, { recursive: true, force: true });
  });

  it("writes silence to both tracks and opens no device", async () => {
    vi.stubEnv("OPENSTYLE_E2E", "1");
    vi.stubEnv("OPENSTYLE_E2E_FAKE_MEETING_CAPTURE", "1");
    const listAudioDevices = vi.fn(async () => null);
    const { recorder, createCaptureWindow } = createRecorder({
      listAudioDevices,
    });

    const meetingId = await recorder.start();
    expect(recorder.status).toBe("recording");
    await vi.waitFor(() => expect(readJournal(meetingId).micT0).not.toBeNull());
    await recorder.stop();

    expect(mocks.helpers).toHaveLength(0);
    expect(mocks.systemCaptures).toHaveLength(0);
    expect(createCaptureWindow).not.toHaveBeenCalled();
    expect(listAudioDevices).not.toHaveBeenCalled();
    const journal = readJournal(meetingId);
    expect(journal.systemT0).toBe(journal.micT0);
    expect(journal.sharedClock).toBe(true);
  });

  it("ignores the flag without OPENSTYLE_E2E=1", async () => {
    vi.stubEnv("OPENSTYLE_E2E", "");
    vi.stubEnv("OPENSTYLE_E2E_FAKE_MEETING_CAPTURE", "1");
    const { recorder } = createRecorder();
    const { started, helper } = await startWithHelper(recorder);
    helper.options.onReady?.();
    await started;
    expect(mocks.helpers).toHaveLength(1);
    await recorder.stop();
  });
});

/** A 16 kHz mono PCM16 WAV with a header and `samples` (value 1000). */
function toneWav(samples: number): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(1000, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("MeetingRecorder live chat (issue #375)", () => {
  beforeEach(() => {
    mocks.userData = mkdtempSync(join(tmpdir(), "openstyle-recorder-live-"));
    mocks.helpers.length = 0;
    mocks.systemCaptures.length = 0;
    vi.stubEnv("OPENSTYLE_E2E", "1");
    vi.stubEnv("OPENSTYLE_E2E_FAKE_MEETING_CAPTURE", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(mocks.userData, { recursive: true, force: true });
  });

  function wavPath(meetingId: string, name: string) {
    return join(mocks.userData, MEETINGS_DIR_NAME, meetingId, name);
  }

  function liveFetch(flag: string | null): MeetingRecorderDeps["serverFetch"] {
    return async (path) =>
      path === "/settings/live_chat_enabled"
        ? new Response(JSON.stringify(flag === null ? {} : { value: flag }))
        : new Response("{}");
  }

  it("flushes the WAV about every second when the setting is on", async () => {
    const { recorder } = createRecorder({ serverFetch: liveFetch("true") });
    const meetingId = await recorder.start();
    await vi.waitFor(
      () =>
        expect(statSync(wavPath(meetingId, MIC_WAV)).size).toBeGreaterThan(44),
      { timeout: 2500, interval: 100 },
    );
    await recorder.stop();
  });

  it("keeps the 5 s flush when the setting is off", async () => {
    const { recorder } = createRecorder({ serverFetch: liveFetch(null) });
    const meetingId = await recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(statSync(wavPath(meetingId, MIC_WAV)).size).toBe(44);
    await recorder.stop();
  });

  it("streams OPENSTYLE_E2E_FAKE_MEETING_AUDIO into the mic track only", async () => {
    const file = join(mocks.userData, "speech.wav");
    writeFileSync(file, toneWav(16000));
    vi.stubEnv("OPENSTYLE_E2E_FAKE_MEETING_AUDIO", file);
    const { recorder } = createRecorder({ serverFetch: liveFetch("true") });
    const meetingId = await recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await recorder.stop();
    const mic = readFileSync(wavPath(meetingId, MIC_WAV)).subarray(44);
    const system = readFileSync(wavPath(meetingId, SYSTEM_WAV)).subarray(44);
    expect(mic.readInt16LE(0)).toBe(1000);
    expect(system.some((b) => b !== 0)).toBe(false);
  });

  it("ignores the audio file without OPENSTYLE_E2E=1", async () => {
    const file = join(mocks.userData, "speech.wav");
    writeFileSync(file, toneWav(16000));
    vi.stubEnv("OPENSTYLE_E2E", "");
    vi.stubEnv("OPENSTYLE_E2E_FAKE_MEETING_AUDIO", file);
    const { readFakeMeetingAudioPcm } = await import("./fake-meeting-capture");
    expect(readFakeMeetingAudioPcm()).toBeNull();
  });
});

describe("MeetingRecorder pause and resume", () => {
  beforeEach(() => {
    mocks.userData = mkdtempSync(join(tmpdir(), "openstyle-recorder-test-"));
    mocks.helpers.length = 0;
    mocks.systemCaptures.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(mocks.userData, { recursive: true, force: true });
  });

  interface Call {
    path: string;
    method?: string;
    body: Record<string, unknown> | undefined;
  }

  function fetchWith(calls: Call[], settings: Record<string, string> = {}) {
    return async (path: string, init?: RequestInit) => {
      calls.push({
        path,
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (path.startsWith("/settings/")) {
        const value = settings[path.slice("/settings/".length)];
        if (value !== undefined) {
          return new Response(JSON.stringify({ value }));
        }
      }
      return new Response("{}");
    };
  }

  /** Start with the native helper that has printed READY. */
  async function startRunning(
    extra: Parameters<typeof createRecorder>[0] = {},
  ) {
    const made = createRecorder(extra);
    const { started, helper } = await startWithHelper(made.recorder);
    helper.options.onReady?.();
    const meetingId = await started;
    return { ...made, meetingId, helper };
  }

  /** Start the helper of a resume() and print READY. */
  async function resumeWithReady(
    recorder: InstanceType<typeof MeetingRecorder>,
    helperCount: number,
  ) {
    const resumed = recorder.resume();
    await vi.waitFor(() => expect(mocks.helpers).toHaveLength(helperCount));
    mocks.helpers[helperCount - 1].options.onReady?.();
    await resumed;
    return mocks.helpers[helperCount - 1];
  }

  /** Wait for a condition on the real timers. A fake Date stays still. */
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(cond()).toBe(true);
  }

  const wavBytes = (id: string, name: string) =>
    statSync(join(mocks.userData, MEETINGS_DIR_NAME, id, name)).size;

  it("closes the helper on pause, waits for its exit and broadcasts the paused time", async () => {
    const calls: Call[] = [];
    const { recorder, helper, broadcastStatus, meetingId } = await startRunning(
      { serverFetch: fetchWith(calls) },
    );
    helper.options.onFrame("M", FRAME);
    helper.options.onFrame("S", FRAME);

    await recorder.pause();

    expect(helper.stop).toHaveBeenCalledTimes(1);
    expect(helper.exited).toHaveBeenCalledTimes(1);
    expect(recorder.status).toBe("recording");
    expect(recorder.isPaused).toBe(true);
    const last = broadcastStatus.mock.calls.at(-1) as [
      string,
      number,
      number | null,
    ];
    expect(last[0]).toBe("recording");
    expect(last[2]).toBe(recorder.recordingPausedAt);
    expect(typeof last[2]).toBe("number");
    // The server learns about the pause. The meeting row stays "recording".
    expect(
      calls.find((c) => c.path === `/meetings/${meetingId}/paused`)?.body,
    ).toEqual({ paused: true });
    await recorder.stop();
  });

  it("drops late frames while paused", async () => {
    const { recorder, helper, meetingId } = await startRunning();
    helper.options.onFrame("M", FRAME);
    helper.options.onFrame("S", FRAME);
    await recorder.pause();
    helper.options.onFrame("M", FRAME);
    helper.options.onFrame("S", FRAME);
    await recorder.stop();
    expect(readJournal(meetingId).micSamples).toBe(1600);
    expect(readJournal(meetingId).systemSamples).toBe(1600);
  });

  it("adds the same silence to the shorter track at the pause, so the tracks stay aligned", async () => {
    const { recorder, helper, meetingId } = await startRunning();
    // The two channels stop at slightly different samples: 3 vs 2 frames.
    for (let i = 0; i < 3; i++) helper.options.onFrame("M", FRAME);
    for (let i = 0; i < 2; i++) helper.options.onFrame("S", FRAME);
    await recorder.pause();

    const resumeHelper = await resumeWithReady(recorder, 2);
    for (let i = 0; i < 4; i++) resumeHelper.options.onFrame("M", FRAME);
    for (let i = 0; i < 4; i++) resumeHelper.options.onFrame("S", FRAME);
    await recorder.stop();

    const journal = readJournal(meetingId);
    // 3 + 4 frames on each track, 1600 samples per 100 ms frame.
    expect(journal.micSamples).toBe(7 * 1600);
    expect(journal.systemSamples).toBe(7 * 1600);
    expect(journal.micSamples).toBe(journal.systemSamples);
    // Both files hold the same bytes: 44 byte header + 2 byte samples.
    expect(wavBytes(meetingId, MIC_WAV)).toBe(44 + 7 * 3200);
    expect(wavBytes(meetingId, SYSTEM_WAV)).toBe(44 + 7 * 3200);
    // The ratio check of packages/validations finds no problem.
    expect(
      trackRatioWarning(journal.micSamples, journal.systemSamples, 16000),
    ).toBeNull();
    // The paused time is not in the tracks: no silence for the gap.
    expect(journal.epochs.map((e) => e.reason)).toEqual([
      "start",
      "pause",
      "resume",
    ]);
    expect(journal.epochs[1]).toMatchObject({
      micSamples: 3 * 1600,
      systemSamples: 3 * 1600,
    });
    expect(journal.epochs[2]).toMatchObject({
      micSamples: 3 * 1600,
      systemSamples: 3 * 1600,
    });
    expect(journal.sharedClock).toBe(true);
  });

  it("opens the same mic again on resume", async () => {
    const { recorder, helper } = await startRunning();
    await recorder.pause();
    const again = await resumeWithReady(recorder, 2);
    expect(again.options.mic).toEqual(helper.options.mic);
    expect(recorder.isPaused).toBe(false);
    await recorder.stop();
  });

  it("counts recorded time only: the clock and the saved duration skip the paused time", async () => {
    const calls: Call[] = [];
    const { recorder, helper } = await startRunning({
      serverFetch: fetchWith(calls),
    });
    const startedAt = recorder.recordingStartedAt as number;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAt + 10_000);
    await recorder.pause();
    expect(recorder.recordingPausedAt).toBe(startedAt + 10_000);
    // The clock of the UI is frozen: pausedAt - startedAt = 10 s.
    expect((recorder.recordingPausedAt as number) - startedAt).toBe(10_000);

    vi.setSystemTime(startedAt + 70_000);
    const resumed = recorder.resume();
    await until(() => mocks.helpers.length === 2);
    mocks.helpers[1].options.onReady?.();
    await resumed;
    // 60 s were paused. The start time moves 60 s later.
    expect(recorder.recordingStartedAt).toBe(startedAt + 60_000);
    expect(recorder.recordingPausedAt).toBeNull();

    vi.setSystemTime(startedAt + 80_000);
    await recorder.stop();
    const stop = calls.find((c) => c.path.endsWith("/stop"));
    // 80 s on the wall clock, 60 s paused: 20 s recorded.
    expect(stop?.body?.duration_ms).toBe(20_000);
    expect(stop?.body?.ended_at).toBe(startedAt + 80_000);
    void helper;
  });

  it("a stop during a pause ends the pause and saves the recorded time", async () => {
    const calls: Call[] = [];
    const { recorder, meetingId } = await startRunning({
      serverFetch: fetchWith(calls),
    });
    const startedAt = recorder.recordingStartedAt as number;
    vi.useFakeTimers({ toFake: ["Date"], now: startedAt + 5_000 });
    await recorder.pause();
    vi.setSystemTime(startedAt + 305_000);
    await recorder.stop();
    const stop = calls.find((c) => c.path.endsWith("/stop"));
    expect(stop?.body).toMatchObject({
      duration_ms: 5_000,
      status: "recorded",
    });
    expect(recorder.status).toBe("idle");
    expect(recorder.isPaused).toBe(false);
    expect(readJournal(meetingId).epochs.map((e) => e.reason)).toEqual([
      "start",
      "pause",
    ]);
  });

  it("does not count the paused time toward the max duration", async () => {
    const calls: Call[] = [];
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const { recorder } = await startRunning({
      serverFetch: fetchWith(calls, { meeting_max_duration_hours: "1" }),
    });
    const HOUR = 3_600_000;
    const longTimers = () =>
      timeouts.mock.calls
        .map(([, ms]) => ms as number)
        .filter((ms) => ms > 1_000_000);
    expect(longTimers().at(-1)).toBeGreaterThan(HOUR - 5_000);
    const timerAtStart = (recorder as unknown as { maxDurationTimer: unknown })
      .maxDurationTimer;
    expect(timerAtStart).not.toBeNull();

    const startedAt = recorder.recordingStartedAt as number;
    vi.useFakeTimers({ toFake: ["Date"], now: startedAt + 600_000 });
    await recorder.pause();
    // No ceiling timer runs while paused.
    expect(
      (recorder as unknown as { maxDurationTimer: unknown }).maxDurationTimer,
    ).toBeNull();

    // Pause for two hours. Then resume: 10 min of the hour are used.
    vi.setSystemTime(startedAt + 600_000 + 2 * HOUR);
    const resumed = recorder.resume();
    await until(() => mocks.helpers.length === 2);
    mocks.helpers[1].options.onReady?.();
    await resumed;
    const left = longTimers().at(-1) as number;
    expect(left).toBeLessThanOrEqual(HOUR - 600_000);
    expect(left).toBeGreaterThan(HOUR - 600_000 - 5_000);
    expect(recorder.status).toBe("recording");
    await recorder.stop();
  });

  it("does not stamp a sleep epoch while paused", async () => {
    const electron = await import("electron");
    const { recorder, meetingId } = await startRunning();
    const onCall = (electron.powerMonitor.on as ReturnType<typeof vi.fn>).mock
      .calls;
    const listener = onCall.filter(([name]) => name === "resume").at(-1)?.[1] as
      | (() => void)
      | undefined;
    expect(listener).toBeTypeOf("function");
    await recorder.pause();
    listener?.();
    await recorder.stop();
    expect(readJournal(meetingId).epochs.map((e) => e.reason)).toEqual([
      "start",
      "pause",
    ]);
  });

  it("falls back to the old capture path when the helper does not start again", async () => {
    const { recorder, createCaptureWindow, meetingId } = await startRunning();
    await recorder.pause();
    const resumed = recorder.resume();
    await vi.waitFor(() => expect(mocks.helpers).toHaveLength(2));
    mocks.helpers[1].options.onError?.("ERR_DEVICE_LOST");
    await resumed;

    expect(createCaptureWindow).toHaveBeenCalledTimes(1);
    expect(mocks.systemCaptures).toHaveLength(1);
    expect(recorder.isPaused).toBe(false);
    await recorder.stop();
    expect(readJournal(meetingId).epochs.map((e) => e.reason)).toEqual([
      "start",
      "pause",
      "fallback",
      "resume",
    ]);
  });

  it("stays paused with a clear message when no capture starts, and the recording can still be stopped and saved", async () => {
    const calls: Call[] = [];
    const { recorder, createCaptureWindow, helper, meetingId } =
      await startRunning({ serverFetch: fetchWith(calls) });
    helper.options.onFrame("M", FRAME);
    helper.options.onFrame("S", FRAME);
    await recorder.pause();
    createCaptureWindow.mockImplementation(() => {
      throw new Error("no window");
    });

    const resumed = recorder.resume();
    await vi.waitFor(() => expect(mocks.helpers).toHaveLength(2));
    mocks.helpers[1].options.onError?.("ERR_MIC_NOT_FOUND");
    await expect(resumed).rejects.toThrow(/microphone did not start again/);

    // Still paused, still "recording", no half-started capture.
    expect(recorder.status).toBe("recording");
    expect(recorder.isPaused).toBe(true);

    await recorder.stop();
    const stop = calls.find((c) => c.path.endsWith("/stop"));
    expect(stop?.body).toMatchObject({ status: "recorded" });
    expect(recorder.status).toBe("idle");
    // The audio from before the pause is on disk.
    expect(wavBytes(meetingId, MIC_WAV)).toBe(44 + 3200);
    expect(wavBytes(meetingId, SYSTEM_WAV)).toBe(44 + 3200);
  });

  it("can resume again after a failed resume", async () => {
    const { recorder, createCaptureWindow } = await startRunning();
    await recorder.pause();
    createCaptureWindow.mockImplementationOnce(() => {
      throw new Error("no window");
    });
    const failed = recorder.resume();
    await vi.waitFor(() => expect(mocks.helpers).toHaveLength(2));
    mocks.helpers[1].options.onError?.("ERR_MIC_NOT_FOUND");
    await expect(failed).rejects.toThrow();
    expect(recorder.isPaused).toBe(true);

    // The usesFallback flag is now set, so the next try uses the window.
    await recorder.resume();
    expect(recorder.isPaused).toBe(false);
    await recorder.stop();
  });

  it("refuses pause and resume when nothing records, and ignores a double pause", async () => {
    const { recorder } = createRecorder();
    await expect(recorder.pause()).rejects.toThrow(/no running recording/);
    await expect(recorder.resume()).rejects.toThrow(/no running recording/);

    const running = await startRunning();
    await running.recorder.resume(); // not paused: no-op
    await running.recorder.pause();
    await running.recorder.pause(); // already paused: no-op
    expect(running.helper.stop).toHaveBeenCalledTimes(1);
    await running.recorder.stop();
  });

  it("pauses and resumes the fallback capture without padding the gap", async () => {
    const { recorder, createCaptureWindow } = createRecorder();
    const { started, helper } = await startWithHelper(recorder);
    helper.options.onError?.("ERR_PERMISSION_DENIED"); // native fails: fallback
    const meetingId = await started;
    expect(createCaptureWindow).toHaveBeenCalledTimes(1);
    const windowAtStart = createCaptureWindow.mock.results[0].value;

    recorder.handleMicChunk(FRAME);
    await recorder.pause();
    expect(windowAtStart.destroy).toHaveBeenCalled();
    expect(mocks.systemCaptures[0].stop).toHaveBeenCalled();
    // A late chunk from the closed window is dropped.
    recorder.handleMicChunk(FRAME);

    await recorder.resume();
    expect(createCaptureWindow).toHaveBeenCalledTimes(2);
    expect(mocks.systemCaptures).toHaveLength(2);
    recorder.handleMicChunk(FRAME);
    await recorder.stop();

    // 2 mic chunks only: the pause gap has no silence.
    expect(readJournal(meetingId).micSamples).toBe(2 * 1600);
    expect(readJournal(meetingId).epochs.map((e) => e.reason)).toEqual([
      "start",
      "pause",
      "resume",
    ]);
  });

  it("pauses and resumes the E2E fake capture", async () => {
    vi.stubEnv("OPENSTYLE_E2E", "1");
    vi.stubEnv("OPENSTYLE_E2E_FAKE_MEETING_CAPTURE", "1");
    const { recorder } = createRecorder();
    const meetingId = await recorder.start();
    await vi.waitFor(() => expect(readJournal(meetingId).micT0).not.toBeNull());
    await recorder.pause();
    expect(recorder.isPaused).toBe(true);
    await recorder.resume();
    expect(recorder.isPaused).toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    await recorder.stop();
    expect(mocks.helpers).toHaveLength(0);
    const journal = readJournal(meetingId);
    expect(journal.epochs.map((e) => e.reason)).toEqual([
      "start",
      "pause",
      "resume",
    ]);
    expect(journal.micSamples).toBe(journal.systemSamples);
  });
});
