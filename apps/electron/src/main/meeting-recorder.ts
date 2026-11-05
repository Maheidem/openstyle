/**
 * Meeting Recorder
 *
 * Owns a dual-channel meeting recording session. It has two capture paths:
 *   - native (first choice): the macos-meeting-capture helper records the mic
 *             and the system audio on one Core Audio clock. Both channels
 *             arrive as 16 kHz mono PCM16 frames on its stdout.
 *   - fallback: used when the native helper fails to start.
 *     - mic:    a hidden BrowserWindow running the PCM AudioWorklet capture
 *               (meeting-capture.html), streaming PCM16 over IPC.
 *     - system: the macos-system-audio helper via SystemAudioCapture.
 *
 * Both channels append into their own WAV file under
 * `<userData>/meetings/<id>/` (mic.wav / system.wav). Wallclock anchors,
 * SYNC markers and suspend/resume epochs are journaled to `sync.json` for
 * merge-time drift correction.
 *
 * DB rows are server-owned: the recorder talks to the in-process Openstyle
 * server over HTTP (POST /api/meetings/*), mirroring how the rest of the main
 * process reads server-owned data (see serverClient() in index.ts).
 *
 * State machine: idle -> recording -> finalizing -> idle.
 *
 * Pause is a flag inside "recording", not a status. A pause closes the mic and
 * the system capture. Both tracks get no samples while paused, so the saved
 * audio holds recorded time only (specs/meeting-mode.md, "Pause and resume").
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { mkdir, readdir, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  type CalendarEvent,
  DEFAULT_MEETING_MAX_DURATION_HOURS,
  MEETINGS_DIR_NAME,
  MIC_WAV,
  parseMeetingMaxDurationHours,
  SYNC_JSON,
  SYSTEM_WAV,
  TRACK_RATIO_MAX,
  TRACK_RATIO_MIN,
  trackRatioWarning,
} from "@openstyle/validations";
import { app, type BrowserWindow, powerMonitor } from "electron";
import type {
  ConfirmedDevices,
  MeetingDevicePlan,
} from "../shared/meeting-devices";
import type { ServerFetch } from "../shared/server-auth";
import { SETTINGS_KEYS } from "../shared/settings-keys";
import {
  isFakeMeetingCapture,
  readFakeMeetingAudioPcm,
} from "./fake-meeting-capture";
import {
  MeetingCaptureHelper,
  type MicRequest,
} from "./meeting-capture-helper";
import { silenceGapSamples } from "./meeting-capture-protocol";
import {
  type DeviceSnapshot,
  needsConfirmation,
  parseDeviceMemory,
  planMeetingDevices,
  rememberDefaultInput,
  rememberMeeting,
} from "./meeting-devices";
import {
  isSystemAudioCaptureSupported,
  type SyncMarker,
  SystemAudioCapture,
} from "./system-audio-capture";

const log = createAppLogger("meeting-recorder");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
/** Buffered PCM is flushed to disk (and fsynced) about every 5 s. */
const FLUSH_INTERVAL_MS = 5000;
/** With live chat on (issue #375), the live reader needs fresh PCM: 1 s. */
const LIVE_FLUSH_INTERVAL_MS = 1000;
/** Refuse to start a recording with less than 2 GB free on the volume. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;
// The most the recording start waits for the calendar lookup.
const CALENDAR_LOOKUP_MAX_MS = 1500;
/** Mic RMS is forwarded to the UI at the same cadence as system LEVELs. */
const LEVEL_INTERVAL_MS = 200;
/**
 * The most that a pause waits for the capture helper to exit. The helper
 * needs this time to close the mic. The recorder shows "Paused" after that.
 */
const PAUSE_EXIT_WAIT_MS = 4000;
/**
 * The native helper must print READY within this time, or the recorder
 * stops waiting. A mic permission prompt can delay READY, so a late READY
 * is not an error. Only an error or an exit before this time starts the
 * fallback.
 */
const NATIVE_START_WINDOW_MS = 5000;

export type MeetingRecorderStatus = "idle" | "recording" | "finalizing";

export interface MeetingLevelEvent {
  meetingId: string;
  source: "mic" | "system";
  rms: number;
}

interface SyncEpoch {
  /**
   * Why this epoch was stamped. "fallback": the native helper stopped.
   * "pause": the user paused. "resume": the capture runs again after a
   * pause or after a sleep. A pause gap holds no samples in the tracks.
   */
  reason: "start" | "resume" | "fallback" | "pause";
  wallclockMs: number;
  micSamples: number;
  systemSamples: number;
}

interface SyncJournal {
  meetingId: string;
  sampleRate: number;
  /** Wallclock ms of the FIRST delivered sample per channel (not spawn time). */
  micT0: number | null;
  systemT0: number | null;
  micSamples: number;
  systemSamples: number;
  /** 60 s wallclock/sample markers (system sample count). */
  syncMarkers: SyncMarker[];
  /**
   * True when the native helper records both channels on one clock. The
   * channels cannot drift apart, so the merge skips the drift correction.
   */
  sharedClock: boolean;
  /** Frames that the native helper dropped (ring buffer overrun). */
  droppedFrames: number;
  /** New timeline anchors: recording start + every powerMonitor resume. */
  epochs: SyncEpoch[];
}

/**
 * Append-only 16 kHz mono s16 WAV writer: placeholder RIFF header up front,
 * PCM appended behind it, sizes patched into the header on finalize.
 */
class WavWriter {
  private fd: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  dataBytes = 0;

  constructor(readonly path: string) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, buildWavHeader(0));
  }

  append(chunk: Buffer): void {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
  }

  flush(): void {
    if (this.pendingBytes === 0) return;
    const buf = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    writeSync(this.fd, buf, 0, buf.length, WAV_HEADER_BYTES + this.dataBytes);
    this.dataBytes += buf.length;
    try {
      fsyncSync(this.fd);
    } catch {
      // fsync is best-effort; the data is already in the page cache.
    }
  }

  finalize(): void {
    this.flush();
    writeSync(this.fd, buildWavHeader(this.dataBytes), 0, WAV_HEADER_BYTES, 0);
    try {
      fsyncSync(this.fd);
    } catch {
      // best-effort
    }
    closeSync(this.fd);
  }
}

function buildWavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * The devices differ from the previous meeting, and the user has not
 * confirmed them. The caller shows the plan and starts again with the keys.
 */
export class MeetingDevicesChangedError extends Error {
  constructor(readonly plan: MeetingDevicePlan) {
    super("The meeting audio devices changed. Confirm them to record.");
    this.name = "MeetingDevicesChangedError";
  }
}

/**
 * The devices of a new recording. `mic` is the request for the native
 * helper. `undefined` means: use the fallback path, which opens the exact
 * Chromium device id.
 */
interface PreparedDevices {
  plan: MeetingDevicePlan | null;
  mic: MicRequest | undefined;
}

export interface MeetingRecorderDeps {
  /** Fetch bound to the in-process/configured Openstyle server (adds auth). */
  serverFetch: ServerFetch;
  /**
   * Create the hidden mic-capture BrowserWindow (show:false) loading
   * meeting-capture.html. Owned (and closed) by the recorder.
   */
  createCaptureWindow: (micLabel?: string | null) => BrowserWindow;
  /**
   * Return the device label for a Chromium mic device id. It asks an open
   * renderer. It returns null when no renderer can answer.
   */
  resolveMicLabel: (deviceId: string) => Promise<string | null>;
  /** The Core Audio devices, or null when the list is not available. */
  listAudioDevices: () => Promise<DeviceSnapshot | null>;
  /** Broadcast a `meeting:level` event to interested renderer windows. */
  broadcastLevel: (event: MeetingLevelEvent) => void;
  /**
   * Broadcast a `meeting:status` change to interested renderer windows.
   * `startedAt` is the recording start time (epoch ms) while the status is
   * "recording", else null. While a recording is paused, `pausedAt` is the
   * time (epoch ms) of the pause, else null. The clock shows
   * `(pausedAt ?? now) - startedAt`.
   */
  broadcastStatus: (
    status: MeetingRecorderStatus,
    startedAt: number | null,
    pausedAt: number | null,
  ) => void;
  /**
   * The calendar event that runs now, or null (specs/calendar-eventkit.md).
   * It returns null at once when the user has not turned on the calendar.
   */
  findCurrentEvent: () => Promise<CalendarEvent | null>;
}

export class MeetingRecorder {
  private deps: MeetingRecorderDeps;
  private _status: MeetingRecorderStatus = "idle";

  private meetingId: string | null = null;
  private meetingDir: string | null = null;
  private startedAt = 0;
  /** The time (epoch ms) of the running pause, or null. */
  private pausedAt: number | null = null;
  /** The total of the finished pauses, in ms. */
  private pausedTotalMs = 0;
  /** The recorded-time ceiling, in ms. Set when the recording starts. */
  private maxDurationMs = 0;
  /** True while resume() starts the capture. */
  private resuming = false;
  /** True while pause() waits for the capture helper to exit. */
  private pausing = false;
  /** True when the fallback path captures (set at start or at failover). */
  private usesFallback = false;
  /** The audio position of the fake capture, in samples. */
  private fakeAudioPos = 0;
  private micWav: WavWriter | null = null;
  private systemWav: WavWriter | null = null;
  private systemCapture: SystemAudioCapture | null = null;
  private captureWindow: BrowserWindow | null = null;
  private nativeCapture: MeetingCaptureHelper | null = null;
  private journal: SyncJournal | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  /** The E2E fake capture timer (see fake-meeting-capture.ts). */
  private fakeCaptureTimer: ReturnType<typeof setInterval> | null = null;
  private lastMicLevelAt = 0;
  private lastError: string | null = null;
  private resumeListener: (() => void) | null = null;
  /**
   * Set when the native helper fails after start and the fallback takes
   * over. The first fallback chunk of a channel then pads the gap with
   * silence, so the channel stays aligned with the other one.
   */
  private micNeedsPad = false;
  private systemNeedsPad = false;
  /** The devices of the running recording. */
  private devices: PreparedDevices | null = null;
  /**
   * True while start() runs. The status stays "idle" while start() waits for
   * the device list, so a second start() needs this flag to be refused.
   */
  private starting = false;

  constructor(deps: MeetingRecorderDeps) {
    this.deps = deps;
  }

  get status(): MeetingRecorderStatus {
    return this._status;
  }

  /** True while start() runs and the status is still "idle". */
  get isStarting(): boolean {
    return this.starting;
  }

  get currentMeetingId(): string | null {
    return this.meetingId;
  }

  /**
   * The start time (epoch ms) of the running recording, or null when the
   * status is not "recording". The paused time is added, so
   * `now - recordingStartedAt` is the recorded time. All timers show the
   * elapsed time from it.
   */
  get recordingStartedAt(): number | null {
    return this._status === "recording"
      ? this.startedAt + this.pausedTotalMs
      : null;
  }

  /** The time (epoch ms) of the running pause, or null. */
  get recordingPausedAt(): number | null {
    return this._status === "recording" ? this.pausedAt : null;
  }

  /** True while the recording is paused. */
  get isPaused(): boolean {
    return this._status === "recording" && this.pausedAt !== null;
  }

  /**
   * webContents id of the hidden capture window, or null when not recording.
   * IPC handlers use it to drop meeting:mic-chunk / meeting:capture-error
   * messages from any other renderer.
   */
  get captureWebContentsId(): number | null {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return null;
    return this.captureWindow.webContents.id;
  }

  /** True while the recording with this id is running. */
  private isRecording(meetingId: string): boolean {
    return this._status === "recording" && this.meetingId === meetingId;
  }

  private setStatus(status: MeetingRecorderStatus): void {
    this._status = status;
    this.broadcast();
  }

  private broadcast(): void {
    this.deps.broadcastStatus(
      this._status,
      this.recordingStartedAt,
      this.recordingPausedAt,
    );
  }

  private async api(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    return this.deps.serverFetch(path, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  /** Max duration from settings (hours), falling back to the default. */
  private async readMaxDurationMs(): Promise<number> {
    let raw: string | null = null;
    try {
      const res = await this.api(
        `/settings/${SETTINGS_KEYS.meetingMaxDurationHours}`,
      );
      if (res.ok) {
        raw = ((await res.json()) as { value?: string }).value ?? null;
      }
    } catch {
      // unset or unreachable — use the default
    }
    const hours = raw
      ? parseMeetingMaxDurationHours(raw)
      : DEFAULT_MEETING_MAX_DURATION_HOURS;
    return hours * 60 * 60 * 1000;
  }

  private async readSetting(key: string): Promise<string | null> {
    try {
      const res = await this.api(`/settings/${key}`);
      if (!res.ok) return null;
      return ((await res.json()) as { value?: string }).value ?? null;
    } catch {
      return null;
    }
  }

  private async writeSetting(key: string, value: string): Promise<void> {
    try {
      await this.api(`/settings/${key}`, { method: "PUT", body: { value } });
    } catch (err) {
      log.warn(`Failed to save ${key}: ${errorMessage(err)}`);
    }
  }

  /**
   * Decide the mic and read the output device (issue #169). It also
   * remembers the macOS default input when it is not a transient Bluetooth
   * default. It opens no audio device.
   */
  private async prepareDevices(): Promise<PreparedDevices> {
    // The fake capture reads no device list and asks no renderer.
    if (isFakeMeetingCapture()) return { plan: null, mic: undefined };
    const chosen = await this.resolveMicName();
    // No label for the chosen mic: the fallback opens the exact device id.
    if (!chosen) return { plan: null, mic: undefined };
    const byName: MicRequest = chosen.micName ? { name: chosen.micName } : null;
    let snapshot: DeviceSnapshot | null = null;
    try {
      snapshot = await this.deps.listAudioDevices();
    } catch (err) {
      log.warn(`Audio device list failed: ${errorMessage(err)}`);
    }
    // No device list: keep the old start path.
    if (!snapshot) return { plan: null, mic: byName };
    const raw = await this.readSetting(SETTINGS_KEYS.meetingAudioDevices);
    const memory = rememberDefaultInput(parseDeviceMemory(raw), snapshot);
    const next = JSON.stringify(memory);
    if (next !== raw) {
      await this.writeSetting(SETTINGS_KEYS.meetingAudioDevices, next);
    }
    const plan = planMeetingDevices({
      snapshot,
      chosenMicName: chosen.micName,
      memory,
    });
    if (plan.skippedInput) {
      log.warn(
        `Skipped the transient Bluetooth default input "${plan.skippedInput.name}". Using "${plan.input?.name}".`,
      );
    }
    return { plan, mic: plan.input ? { uid: plan.input.uid } : byName };
  }

  /** The devices that the next recording uses, or null when unknown. */
  async previewDevices(): Promise<MeetingDevicePlan | null> {
    return (await this.prepareDevices()).plan;
  }

  /** Save the devices of a recording that started. */
  private async rememberMeetingDevices(plan: MeetingDevicePlan): Promise<void> {
    const raw = await this.readSetting(SETTINGS_KEYS.meetingAudioDevices);
    const memory = rememberMeeting(parseDeviceMemory(raw), plan);
    await this.writeSetting(
      SETTINGS_KEYS.meetingAudioDevices,
      JSON.stringify(memory),
    );
  }

  /**
   * Start a recording. Throws with a user-facing message on refusal. Throws
   * MeetingDevicesChangedError when the devices differ from the previous
   * meeting and `confirmed` does not hold the same devices.
   */
  async start(
    confirmed?: ConfirmedDevices | null,
    folderId?: string | null,
  ): Promise<string> {
    if (this._status !== "idle" || this.starting) {
      throw new Error("A meeting recording is already in progress");
    }
    // Set the flag before the first await. Clear it on every exit.
    this.starting = true;
    try {
      return await this.startRecording(confirmed, folderId);
    } finally {
      this.starting = false;
    }
  }

  private async startRecording(
    confirmed?: ConfirmedDevices | null,
    folderId?: string | null,
  ): Promise<string> {
    const fake = isFakeMeetingCapture();
    if (!fake && !isSystemAudioCaptureSupported()) {
      throw new Error("Meeting recording requires macOS 14.4 or later");
    }

    const devices = await this.prepareDevices();
    if (devices.plan && needsConfirmation(devices.plan, confirmed)) {
      throw new MeetingDevicesChangedError(devices.plan);
    }

    const userData = app.getPath("userData");

    // Disk guard: refuse to start on a nearly-full volume.
    try {
      const stats = await statfs(userData);
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (free < MIN_FREE_BYTES) {
        throw new Error(
          `Not enough disk space to record (need 2 GB free, have ${(free / 1024 ** 3).toFixed(1)} GB)`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Not enough disk")) {
        throw err;
      }
      // statfs unsupported — don't block a legitimate recording on the probe.
    }

    const id = randomUUID();
    const dir = join(userData, MEETINGS_DIR_NAME, id);
    await mkdir(dir, { recursive: true });

    // A calendar problem never stops a recording, and a slow calendar never
    // delays it for long. The wait ends before startedAt is read, so the
    // timeline stays aligned with the audio.
    let calendar: CalendarEvent | null = null;
    try {
      calendar = await Promise.race([
        this.deps.findCurrentEvent(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), CALENDAR_LOOKUP_MAX_MS).unref?.();
        }),
      ]);
    } catch {
      calendar = null;
    }
    const startedAt = Date.now();
    const res = await this.api("/meetings/start", {
      method: "POST",
      body: {
        id,
        audio_dir: dir,
        started_at: startedAt,
        ...(folderId !== undefined ? { folder_id: folderId } : {}),
        ...(calendar ? { calendar } : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to create meeting row (HTTP ${res.status})`);
    }

    this.meetingId = id;
    this.meetingDir = dir;
    this.startedAt = startedAt;
    this.pausedAt = null;
    this.pausedTotalMs = 0;
    this.resuming = false;
    this.usesFallback = false;
    this.fakeAudioPos = 0;
    this.lastError = null;
    this.micNeedsPad = false;
    this.systemNeedsPad = false;
    this.devices = devices;
    this.micWav = new WavWriter(join(dir, MIC_WAV));
    this.systemWav = new WavWriter(join(dir, SYSTEM_WAV));
    this.journal = {
      meetingId: id,
      sampleRate: SAMPLE_RATE,
      micT0: null,
      systemT0: null,
      micSamples: 0,
      systemSamples: 0,
      syncMarkers: [],
      sharedClock: false,
      droppedFrames: 0,
      epochs: [
        {
          reason: "start",
          wallclockMs: startedAt,
          micSamples: 0,
          systemSamples: 0,
        },
      ],
    };
    this.setStatus("recording");

    // Capture sources: the native helper first, then the fallback path.
    // The E2E fake capture uses neither.
    const nativeStarted =
      !fake && (await this.startNativeCapture(id, devices.mic));
    // The user may stop the recording while the capture helper starts.
    if (!this.isRecording(id)) return id;
    if (fake) {
      log.info("Meeting capture path: E2E fake (silence, no audio device)");
      this.startFakeCapture();
    } else if (nativeStarted) {
      log.info("Meeting capture path: native (macos-meeting-capture)");
    } else {
      log.info(
        "Meeting capture path: fallback (hidden capture window + macos-system-audio)",
      );
      this.usesFallback = true;
      this.startFallbackCapture();
    }

    // Periodic PCM flush. Live chat reads the growing WAV, so it flushes faster.
    const liveChat =
      (await this.readSetting(SETTINGS_KEYS.liveChatEnabled)) === "true";
    this.flushTimer = setInterval(
      () => {
        try {
          this.micWav?.flush();
          this.systemWav?.flush();
        } catch (err) {
          log.error(`WAV flush failed: ${String(err)}`);
          void this.stop("failed", `wav flush failed: ${String(err)}`);
        }
      },
      liveChat ? LIVE_FLUSH_INTERVAL_MS : FLUSH_INTERVAL_MS,
    );

    // Auto-stop ceiling. It counts recorded time only: a pause stops it.
    this.maxDurationMs = await this.readMaxDurationMs();
    this.armMaxDurationTimer();

    // On resume from sleep, stamp a new timeline epoch: the channels carry no
    // samples for the gap, so the merge must re-anchor to wallclock here.
    this.resumeListener = () => {
      // A paused recording has no capture. The resume() call stamps its own epoch.
      if (!this.journal || this.pausedAt !== null) return;
      this.journal.epochs.push({
        reason: "resume",
        wallclockMs: Date.now(),
        micSamples: this.journal.micSamples,
        systemSamples: this.journal.systemSamples,
      });
      void this.writeJournal();
    };
    powerMonitor.on("resume", this.resumeListener);

    await this.writeJournal();
    if (devices.plan) await this.rememberMeetingDevices(devices.plan);
    log.info(`Meeting recording started: ${id}`);
    return id;
  }

  /** Stop the recording at the ceiling of the recorded time. */
  private armMaxDurationTimer(): void {
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    const left = this.maxDurationMs - this.recordedMs(Date.now());
    this.maxDurationTimer = setTimeout(
      () => {
        log.info("Max meeting duration reached; auto-stopping");
        void this.stop();
      },
      Math.max(0, left),
    );
  }

  /** The recorded time at `now`, in ms. A running pause does not count. */
  private recordedMs(now: number): number {
    const running = this.pausedAt === null ? 0 : now - this.pausedAt;
    return now - this.startedAt - this.pausedTotalMs - running;
  }

  /**
   * Read the chosen mic and return its Core Audio device name. Return
   * `{ micName: null }` for "System default". Return null when a mic is
   * chosen but its name is unknown. The recorder must then use the old path,
   * which opens the exact device id. It must not use another mic in silence.
   */
  private async resolveMicName(): Promise<{ micName: string | null } | null> {
    let deviceId = "";
    try {
      const res = await this.api(`/settings/${SETTINGS_KEYS.micDeviceId}`);
      if (res.ok) {
        deviceId = ((await res.json()) as { value?: string }).value ?? "";
      }
    } catch {
      // unset or unreachable: use the default input
    }
    if (!deviceId || deviceId === "default") return { micName: null };
    let label: string | null = null;
    try {
      label = await this.deps.resolveMicLabel(deviceId);
    } catch (err) {
      log.warn(`Mic label lookup failed: ${errorMessage(err)}`);
    }
    if (!label) {
      log.warn(
        "No open renderer gave a label for the chosen mic. Using the old capture path.",
      );
      return null;
    }
    return { micName: label };
  }

  /**
   * Start the native helper. Resolve true when it is running (READY, or no
   * error within NATIVE_START_WINDOW_MS). Resolve false when `mic` is
   * undefined (the chosen mic has no known name), or the helper is missing,
   * fails to spawn, exits before READY or prints ERR_* before READY. In
   * that case the helper is stopped and the caller starts the fallback
   * path. A fault after the start also starts the fallback path (see
   * failOverToFallback).
   */
  private async startNativeCapture(
    meetingId: string,
    mic: MicRequest | undefined,
  ): Promise<boolean> {
    if (!this.isRecording(meetingId)) return false;
    if (mic === undefined) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => settle(true), NATIVE_START_WINDOW_MS);
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      const capture = new MeetingCaptureHelper({
        mic,
        onFrame: (channel, pcm) => this.handleNativeFrame(channel, pcm),
        onReady: () => settle(true),
        onLevel: (rms) => this.broadcastLevel("system", rms),
        onLevelMic: (rms) => this.broadcastLevel("mic", rms),
        onSync: (marker) => {
          this.journal?.syncMarkers.push(marker);
          void this.writeJournal();
        },
        onOverrun: (count) => {
          // The count is the total so far. A dropped frame shifts one
          // channel against the other, so the journal keeps the count.
          if (!this.journal) return;
          this.journal.droppedFrames = Math.max(
            this.journal.droppedFrames,
            count,
          );
          void this.writeJournal();
        },
        onError: (error) => {
          if (!settled) {
            log.warn(`Native meeting capture failed to start: ${error}`);
            settle(false);
            return;
          }
          log.error(`Capture error: ${error}`);
          this.lastError = this.lastError ?? `capture: ${error}`;
          // The helper goes on with the system channel after a mic loss.
          // Any other fault leaves empty audio, so the fallback takes over.
          if (error !== "ERR_MIC_LOST") this.failOverToFallback(capture);
        },
      });
      this.nativeCapture = capture;

      if (!capture.start()) {
        // start() has called onError, so settle(false) ran already.
        settle(false);
      }
    }).then((ok) => {
      if (ok) {
        if (this.journal) this.journal.sharedClock = true;
      } else {
        this.nativeCapture?.stop();
        this.nativeCapture = null;
        // The helper can print SYNC before it fails. Those markers do not
        // belong to the fallback path.
        if (this.journal) this.journal.syncMarkers = [];
      }
      return ok;
    });
  }

  /**
   * The native helper failed after it started. Start the old path. The
   * audio that exists stays. Each channel gets silence for the gap when its
   * first fallback chunk arrives. If the fallback cannot start, the
   * recording stops as failed.
   */
  private failOverToFallback(capture: MeetingCaptureHelper): void {
    if (this._status !== "recording" || this.nativeCapture !== capture) return;
    log.warn("Native meeting capture failed after start. Using the fallback.");
    capture.stop();
    this.nativeCapture = null;
    this.usesFallback = true;
    this.micNeedsPad = true;
    this.systemNeedsPad = true;
    this.journal?.epochs.push({
      reason: "fallback",
      wallclockMs: Date.now(),
      micSamples: this.journal.micSamples,
      systemSamples: this.journal.systemSamples,
    });
    if (!this.startFallbackCapture()) {
      void this.stop("failed", "capture: native helper and fallback failed");
      return;
    }
    void this.writeJournal();
  }

  /**
   * Append silence so that the channel is as long as the wallclock says,
   * measured from the shared T0. `untilMs` is the wallclock of the first
   * sample of the next chunk.
   */
  private padChannel(channel: "mic" | "system", untilMs: number): void {
    const journal = this.journal;
    const wav = channel === "mic" ? this.micWav : this.systemWav;
    const t0 = channel === "mic" ? journal?.micT0 : journal?.systemT0;
    if (!journal || !wav || t0 === null || t0 === undefined) return;
    const have = channel === "mic" ? journal.micSamples : journal.systemSamples;
    // The paused time is not in the tracks, so it is not in the gap.
    const gap = silenceGapSamples(
      t0,
      untilMs - this.pausedTotalMs,
      have,
      SAMPLE_RATE,
    );
    if (gap === 0) return;
    wav.append(Buffer.alloc(gap * BYTES_PER_SAMPLE));
    if (channel === "mic") journal.micSamples += gap;
    else journal.systemSamples += gap;
  }

  /**
   * Today's path: system helper plus the hidden mic capture window. Returns
   * false when the mic capture window cannot be created.
   */
  private startFallbackCapture(): boolean {
    // System channel.
    this.systemCapture = new SystemAudioCapture({
      onData: (chunk) => this.handleSystemChunk(chunk),
      onLevel: (rms) => this.broadcastLevel("system", rms),
      onSync: (marker) => {
        // After a native start, the markers of the native helper count from
        // another origin. The merge ignores all markers then.
        if (!this.journal || this.journal.sharedClock) return;
        this.journal.syncMarkers.push(marker);
        void this.writeJournal();
      },
      onError: (error) => {
        // System audio failing doesn't abort the meeting — the mic channel
        // keeps recording. Remember the fault for the stop row.
        log.error(`System channel error: ${error}`);
        this.lastError = this.lastError ?? `system: ${error}`;
      },
    });
    this.systemCapture.start();

    // Mic channel: hidden capture window streaming worklet chunks over IPC.
    try {
      // A skipped transient default must not come back in the fallback.
      const plan = this.devices?.plan;
      this.captureWindow = this.deps.createCaptureWindow(
        plan?.skippedInput ? plan.inputName : null,
      );
      this.captureWindow.on("closed", () => {
        this.captureWindow = null;
      });
    } catch (err) {
      log.error(`Failed to create mic capture window: ${errorMessage(err)}`);
      this.lastError = this.lastError ?? "mic: capture window failed";
      return false;
    }
    return true;
  }

  /**
   * E2E fake capture: write silence to both tracks at the real sample rate,
   * from the wallclock. It goes through the native frame path, so both
   * tracks share one T0.
   */
  private startFakeCapture(): void {
    if (this.journal) this.journal.sharedClock = true;
    const t0 = Date.now();
    let written = 0;
    // Optional file for the mic track (issue #375). Silence after its end.
    // After a pause, the file goes on where it stopped.
    const audio = readFakeMeetingAudioPcm();
    this.fakeCaptureTimer = setInterval(() => {
      const due =
        Math.floor(((Date.now() - t0) * SAMPLE_RATE) / 1000) - written;
      if (due <= 0) return;
      const silence = Buffer.alloc(due * BYTES_PER_SAMPLE);
      let mic = silence;
      if (audio && this.fakeAudioPos * BYTES_PER_SAMPLE < audio.length) {
        const from = this.fakeAudioPos * BYTES_PER_SAMPLE;
        mic = Buffer.concat([
          audio.subarray(from, from + silence.length),
          silence,
        ]).subarray(0, silence.length);
      }
      written += due;
      this.fakeAudioPos += due;
      this.handleNativeFrame("M", mic);
      this.handleNativeFrame("S", silence);
    }, 100);
  }

  private broadcastLevel(source: "mic" | "system", rms: number): void {
    if (!this.meetingId) return;
    this.deps.broadcastLevel({ meetingId: this.meetingId, source, rms });
  }

  /**
   * One frame from the native helper. Both channels share one clock, so
   * the first frame stamps the same T0 for both channels.
   */
  private handleNativeFrame(channel: "M" | "S", pcm: Buffer): void {
    if (this._status !== "recording" || !this.journal) return;
    if (this.isCaptureClosed()) return;
    if (pcm.length === 0) return;
    if (this.journal.micT0 === null && this.journal.systemT0 === null) {
      const t0 = Date.now();
      this.journal.micT0 = t0;
      this.journal.systemT0 = t0;
      void this.writeJournal();
    }
    if (channel === "M") {
      // The helper sends LEVEL_MIC lines, so no RMS is computed here.
      if (!this.micWav) return;
      this.micWav.append(pcm);
      this.journal.micSamples += Math.floor(pcm.length / BYTES_PER_SAMPLE);
    } else {
      if (!this.systemWav) return;
      this.systemWav.append(pcm);
      this.journal.systemSamples += Math.floor(pcm.length / BYTES_PER_SAMPLE);
    }
  }

  /**
   * True while a pause holds the capture closed. A chunk that arrives then
   * is a late one from the closed capture, and it is dropped. While the
   * capture starts again (resume), chunks are accepted.
   */
  private isCaptureClosed(): boolean {
    return this.pausedAt !== null && !this.resuming;
  }

  /** Mic PCM16 chunk delivered from the capture window over IPC. */
  handleMicChunk(chunk: Buffer): void {
    if (this._status !== "recording" || !this.micWav || !this.journal) return;
    if (this.isCaptureClosed()) return;
    if (this.journal.micT0 === null) {
      // t0 = wallclock of the FIRST delivered sample, not window-spawn time.
      this.journal.micT0 = Date.now();
      void this.writeJournal();
    }
    if (this.micNeedsPad) {
      this.micNeedsPad = false;
      this.padChannel("mic", Date.now() - chunkDurationMs(chunk));
    }
    this.micWav.append(chunk);
    this.journal.micSamples += Math.floor(chunk.length / BYTES_PER_SAMPLE);

    // Compute mic RMS for the UI meter at LEVEL cadence.
    const now = Date.now();
    if (now - this.lastMicLevelAt >= LEVEL_INTERVAL_MS && this.meetingId) {
      this.lastMicLevelAt = now;
      this.deps.broadcastLevel({
        meetingId: this.meetingId,
        source: "mic",
        rms: pcm16Rms(chunk),
      });
    }
  }

  private handleSystemChunk(chunk: Buffer): void {
    if (this._status !== "recording" || !this.systemWav || !this.journal)
      return;
    if (this.isCaptureClosed()) return;
    if (this.journal.systemT0 === null) {
      this.journal.systemT0 = Date.now();
      void this.writeJournal();
    }
    if (this.systemNeedsPad) {
      this.systemNeedsPad = false;
      this.padChannel("system", Date.now() - chunkDurationMs(chunk));
    }
    this.systemWav.append(chunk);
    this.journal.systemSamples += Math.floor(chunk.length / BYTES_PER_SAMPLE);
  }

  /**
   * Close every capture source: the fake timer, the native helper, the
   * system helper and the mic window. It is synchronous. The WAV files stay
   * open. Returns the native helper that was stopped, or null.
   */
  private stopCaptureSources(): MeetingCaptureHelper | null {
    if (this.fakeCaptureTimer) clearInterval(this.fakeCaptureTimer);
    this.fakeCaptureTimer = null;
    const native = this.nativeCapture;
    native?.stop();
    this.nativeCapture = null;
    this.systemCapture?.stop();
    this.systemCapture = null;
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      this.captureWindow.destroy();
    }
    this.captureWindow = null;
    return native;
  }

  /**
   * Stop the timers and capture sources, then finalize the WAV files. It is
   * synchronous and does not change the status. Returns the finalize error,
   * or null.
   */
  private teardown(): unknown {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;
    if (this.resumeListener) {
      powerMonitor.removeListener("resume", this.resumeListener);
      this.resumeListener = null;
    }
    this.stopCaptureSources();

    let finalizeError: unknown = null;
    try {
      this.micWav?.finalize();
      this.systemWav?.finalize();
    } catch (err) {
      finalizeError = err;
    }
    this.micWav = null;
    this.systemWav = null;
    return finalizeError;
  }

  /** Tell the server about a pause or a resume. A failure is not fatal. */
  private async notifyPaused(paused: boolean): Promise<void> {
    if (!this.meetingId) return;
    try {
      await this.api(`/meetings/${this.meetingId}/paused`, {
        method: "PUT",
        body: { paused },
      });
    } catch (err) {
      log.warn(`Failed to send the paused flag: ${errorMessage(err)}`);
    }
  }

  /**
   * Add silence to the shorter track, so that both tracks hold the same
   * number of samples. The two captures stop at slightly different samples.
   * This keeps the tracks aligned across the pause.
   */
  private equalizeTracks(): void {
    const journal = this.journal;
    if (!journal) return;
    const diff = journal.micSamples - journal.systemSamples;
    if (diff === 0) return;
    const shorter = diff > 0 ? this.systemWav : this.micWav;
    shorter?.append(Buffer.alloc(Math.abs(diff) * BYTES_PER_SAMPLE));
    if (diff > 0) journal.systemSamples += diff;
    else journal.micSamples -= diff;
  }

  /**
   * Pause the recording. It closes the mic and the system capture, so the
   * macOS mic indicator goes off. Both tracks get no samples until
   * resume(). Throws with a user-facing message on refusal.
   */
  async pause(): Promise<void> {
    if (this._status !== "recording" || this.starting || !this.journal) {
      throw new Error("There is no running recording to pause");
    }
    if (this.pausedAt !== null) return;
    if (this.resuming) throw new Error("The recording is starting again");
    const now = Date.now();
    // The pause starts here. Frames that arrive later are dropped.
    this.pausedAt = now;
    this.pausing = true;
    const native = this.stopCaptureSources();
    try {
      if (native) {
        // Wait until the helper process has exited: then the mic is closed.
        await Promise.race([
          native.exited(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, PAUSE_EXIT_WAIT_MS).unref?.();
          }),
        ]);
      }
    } finally {
      this.pausing = false;
    }
    // The user may have stopped the recording while the helper exited.
    if (this.pausedAt !== now || !this.journal) return;
    try {
      this.micWav?.flush();
      this.systemWav?.flush();
    } catch (err) {
      log.error(`WAV flush failed: ${String(err)}`);
    }
    // The shared clock of the native helper makes the tracks the same length.
    // The fallback tracks have their own T0, so their lengths differ by design.
    if (!this.usesFallback) this.equalizeTracks();
    this.journal.epochs.push({
      reason: "pause",
      wallclockMs: now,
      micSamples: this.journal.micSamples,
      systemSamples: this.journal.systemSamples,
    });
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;
    await this.writeJournal();
    await this.notifyPaused(true);
    log.info(`Meeting recording paused: ${this.meetingId}`);
    this.broadcast();
  }

  /**
   * Resume a paused recording. It starts the capture again. When the capture
   * cannot start, it throws with a user-facing message. The recording then
   * stays paused: the user can try again or stop it, and the audio that
   * exists is saved.
   */
  async resume(): Promise<void> {
    const meetingId = this.meetingId;
    if (this._status !== "recording" || !meetingId || !this.journal) {
      throw new Error("There is no running recording to resume");
    }
    if (this.pausedAt === null) return;
    if (this.resuming || this.pausing) {
      throw new Error("The recording is changing state. Try again.");
    }
    const pausedAt = this.pausedAt;
    this.resuming = true;
    try {
      const started = await this.startCaptureAfterPause(meetingId);
      // The user may have stopped the recording while the capture started.
      if (!this.resuming || !this.isRecording(meetingId)) return;
      if (!started) {
        this.stopCaptureSources();
        const message =
          "The microphone did not start again. Check the microphone, then try Resume. You can also stop the recording: the audio so far is saved.";
        this.lastError = this.lastError ?? "capture: resume failed";
        throw new Error(message);
      }
      // The pause ends when the capture runs, so the start time of the
      // helper is paused time, not recorded time.
      const now = Date.now();
      this.pausedTotalMs += now - pausedAt;
      this.pausedAt = null;
      if (this.journal) {
        this.journal.epochs.push({
          reason: "resume",
          wallclockMs: now,
          micSamples: this.journal.micSamples,
          systemSamples: this.journal.systemSamples,
        });
      }
      this.armMaxDurationTimer();
      await this.writeJournal();
      await this.notifyPaused(false);
      log.info(`Meeting recording resumed: ${meetingId}`);
      this.broadcast();
    } finally {
      this.resuming = false;
    }
  }

  /**
   * Start the capture after a pause. Same order as at the start: the native
   * helper first, then the fallback path. Returns false when nothing runs.
   */
  private async startCaptureAfterPause(meetingId: string): Promise<boolean> {
    if (isFakeMeetingCapture()) {
      this.startFakeCapture();
      return true;
    }
    if (!this.usesFallback) {
      const mic = this.devices?.mic;
      if (
        mic !== undefined &&
        (await this.startNativeCapture(meetingId, mic))
      ) {
        return true;
      }
      if (!this.isRecording(meetingId) || !this.resuming) return false;
      log.warn(
        "Native capture did not start after the pause. Using the fallback.",
      );
      this.usesFallback = true;
      this.journal?.epochs.push({
        reason: "fallback",
        wallclockMs: Date.now(),
        micSamples: this.journal.micSamples,
        systemSamples: this.journal.systemSamples,
      });
    }
    return this.startFallbackCapture();
  }

  /** Stop the recording and finalize files + DB row. */
  async stop(
    status: "recorded" | "failed" = "recorded",
    error?: string,
  ): Promise<void> {
    if (this._status !== "recording") return;
    const meetingId = this.meetingId;
    // A stop during a pause ends the pause now. The paused time is not
    // recorded time.
    this.resuming = false;
    const endedAt = Date.now();
    if (this.pausedAt !== null) {
      this.pausedTotalMs += endedAt - this.pausedAt;
      this.pausedAt = null;
    }
    this.setStatus("finalizing");

    const finalizeError = this.teardown();
    if (finalizeError) {
      log.error(`WAV finalize failed: ${String(finalizeError)}`);
      status = "failed";
      error = error ?? `wav finalize failed: ${String(finalizeError)}`;
    }

    await this.writeJournal();
    if (this.journal) logTrackRatio(this.journal);

    if (meetingId) {
      try {
        await this.api(`/meetings/${meetingId}/stop`, {
          method: "POST",
          body: {
            ended_at: endedAt,
            // Recorded time only: the paused time is not in it.
            duration_ms: endedAt - this.startedAt - this.pausedTotalMs,
            status,
            error: error ?? this.lastError ?? undefined,
          },
        });
      } catch (err) {
        log.error(`Failed to persist meeting stop: ${String(err)}`);
      }
    }

    this.meetingId = null;
    this.meetingDir = null;
    this.journal = null;
    this.devices = null;
    this.pausedAt = null;
    this.pausedTotalMs = 0;
    this.setStatus("idle");
    log.info(`Meeting recording stopped: ${meetingId} (${status})`);
  }

  /**
   * Synchronous teardown for app quit: finalize WAV headers and kill the
   * capture processes without awaiting the server. The DB row stays
   * 'recording'; the next boot's orphan sweep marks it 'interrupted' (the
   * header repair there is idempotent, so already-finalized files are fine).
   */
  stopSync(): void {
    if (this._status !== "recording") return;
    this._status = "finalizing";
    const finalizeError = this.teardown();
    if (finalizeError) {
      log.error(`WAV finalize failed during quit: ${String(finalizeError)}`);
    }
    this._status = "idle";
  }

  private async writeJournal(): Promise<void> {
    if (!this.journal || !this.meetingDir) return;
    try {
      await writeFile(
        join(this.meetingDir, SYNC_JSON),
        `${JSON.stringify(this.journal, null, 2)}\n`,
        "utf-8",
      );
    } catch (err) {
      log.warn(`Failed to write ${SYNC_JSON}: ${String(err)}`);
    }
  }

  /**
   * Boot-time orphan sweep: any meeting row a crash left in 'recording' gets
   * its WAV headers finalized from the on-disk file sizes and its row marked
   * 'interrupted'; any row left in 'transcribing' (the in-process server died
   * mid-job, so the job is gone for good) is marked 'failed' with a named
   * cause — its partial transcript survives and stays retryable. Call once
   * after the server is reachable. After a restart of the server process, pass
   * `transcribingOnly`: the jobs died with the old process, but a live
   * recording is still running in this process and stays untouched.
   */
  async sweepOrphans({
    transcribingOnly = false,
  }: {
    transcribingOnly?: boolean;
  } = {}): Promise<void> {
    let orphans: { id: string; status: string; audio_dir: string | null }[] =
      [];
    try {
      const res = await this.api("/meetings/orphans");
      if (!res.ok) return;
      orphans = ((await res.json()) as { items: typeof orphans }).items ?? [];
    } catch {
      return; // server not up yet; next boot will retry
    }

    for (const orphan of orphans) {
      if (transcribingOnly && orphan.status !== "transcribing") continue;
      // A quit mid-transcription leaves no recorder state to repair (the
      // WAVs were finalized when the recording stopped) — the row just
      // flips to 'failed'. The server endpoint is strict: only valid from
      // 'transcribing'.
      if (orphan.status === "transcribing") {
        try {
          await this.api(`/meetings/${orphan.id}/transcribe-interrupted`, {
            method: "POST",
          });
          log.info(
            `Marked orphaned transcription failed (app quit mid-job): ${orphan.id}`,
          );
        } catch (err) {
          log.warn(
            `Failed to mark orphan transcription interrupted for ${orphan.id}: ${String(err)}`,
          );
        }
        continue;
      }
      let durationMs: number | undefined;
      if (orphan.audio_dir) {
        try {
          durationMs = await repairWavHeaders(orphan.audio_dir);
        } catch (err) {
          log.warn(`Orphan WAV repair failed for ${orphan.id}: ${String(err)}`);
        }
      }
      try {
        await this.api(`/meetings/${orphan.id}/interrupted`, {
          method: "POST",
          body: { duration_ms: durationMs },
        });
        log.info(`Marked orphaned meeting interrupted: ${orphan.id}`);
      } catch (err) {
        log.warn(`Failed to mark orphan interrupted: ${String(err)}`);
      }
    }
  }
}

/**
 * Issue #170 guard: the system track must be about as long as the mic track.
 * The server reads the same counts from sync.json, and the meeting page then
 * shows a warning.
 */
function logTrackRatio(journal: SyncJournal): void {
  const ratio = trackRatioWarning(
    journal.micSamples,
    journal.systemSamples,
    journal.sampleRate,
  );
  if (ratio === null) return;
  log.warn(
    `Track length check failed for ${journal.meetingId}: system/mic = ${ratio.toFixed(3)} ` +
      `(allowed ${TRACK_RATIO_MIN}-${TRACK_RATIO_MAX}; mic ${journal.micSamples}, ` +
      `system ${journal.systemSamples} samples). The two tracks should have the same length.`,
  );
}

/** Duration of a PCM16 chunk in ms. */
function chunkDurationMs(chunk: Buffer): number {
  return (chunk.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
}

/** RMS (0..1) of a PCM16 little-endian buffer. */
function pcm16Rms(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / BYTES_PER_SAMPLE);
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const s = chunk.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / samples);
}

/**
 * Rewrite the RIFF/data sizes of every *.wav in `dir` from the file size on
 * disk (the crash left the placeholder zeros). Returns the longest channel's
 * duration in ms.
 */
async function repairWavHeaders(dir: string): Promise<number | undefined> {
  let maxDurationMs: number | undefined;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined; // dir deleted — nothing to repair
  }
  for (const name of entries) {
    if (!name.endsWith(".wav")) continue;
    const path = join(dir, name);
    const size = (await stat(path)).size;
    if (size < WAV_HEADER_BYTES) continue;
    const dataBytes = size - WAV_HEADER_BYTES;
    const fd = openSync(path, "r+");
    try {
      writeSync(fd, buildWavHeader(dataBytes), 0, WAV_HEADER_BYTES, 0);
    } finally {
      closeSync(fd);
    }
    const durationMs = Math.round(
      (dataBytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000,
    );
    maxDurationMs = Math.max(maxDurationMs ?? 0, durationMs);
  }
  return maxDurationMs;
}
