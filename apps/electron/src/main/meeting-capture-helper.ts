/**
 * Meeting Capture Helper (macOS)
 *
 * Spawns the `macos-meeting-capture` helper. The helper records the mic and
 * the system audio on one Core Audio clock. It writes binary frames on stdout
 * (see meeting-capture-protocol.ts) and a text protocol on stderr:
 *
 *   READY                          capture running, samples flow soon
 *   LEVEL <rms>                    ~200 ms RMS level of the system channel
 *   LEVEL_MIC <rms>                ~200 ms RMS level of the mic channel
 *   SYNC <wallclock_ms> <samples>  wallclock/sample-count marker every 60 s
 *   OVERRUN <n>                    ring-buffer overruns (dropped frames)
 *   DEVICE <uid> <name>            the mic that the helper opened
 *   WARN_MIC_NOT_FOUND <name>      the name did not match; default input used
 *   ERR_*                          fatal error
 *
 * The class has the same shape as SystemAudioCapture (the old system-only
 * helper). The recorder uses this class first and falls back to the old
 * path when this one fails to start.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  createFrameParser,
  type MeetingCaptureChannel,
} from "./meeting-capture-protocol";
import { getNativeBinaryPath } from "./native-binary";
import {
  isSystemAudioCaptureSupported,
  type SyncMarker,
} from "./system-audio-capture";

const log = createAppLogger("meeting-capture");

/** Grace period between SIGTERM and SIGKILL when stopping the helper. */
const KILL_GRACE_MS = 3000;

interface MeetingCaptureHelperOptions {
  /** Core Audio device name of the mic, or null for the default input. */
  micName: string | null;
  /** One decoded frame: PCM16 (16 kHz mono) for one channel. */
  onFrame: (channel: MeetingCaptureChannel, pcm: Buffer) => void;
  onReady?: () => void;
  /** ~200 ms RMS level of the system channel, 0..1. */
  onLevel?: (rms: number) => void;
  /** ~200 ms RMS level of the mic channel, 0..1. */
  onLevelMic?: (rms: number) => void;
  /** 60 s wallclock/sample-count markers for merge-time drift correction. */
  onSync?: (marker: SyncMarker) => void;
  onOverrun?: (count: number) => void;
  /** Fatal helper errors: ERR_* lines, spawn failures, exits, bad frames. */
  onError?: (error: string) => void;
}

export class MeetingCaptureHelper {
  private process: ChildProcess | null = null;
  private options: MeetingCaptureHelperOptions;
  private stopped = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MeetingCaptureHelperOptions) {
    this.options = options;
  }

  /**
   * Spawn the helper. Returns false when the platform is unsupported, the
   * binary is missing, or the spawn fails. In those cases `onError` is
   * also called.
   */
  start(): boolean {
    if (this.process || this.stopped) return false;

    if (!isSystemAudioCaptureSupported()) {
      this.options.onError?.("Meeting capture requires macOS 14.4 or later");
      return false;
    }

    const binaryPath = getNativeBinaryPath("macos-meeting-capture");
    if (!binaryPath) {
      this.options.onError?.("macos-meeting-capture binary not found");
      return false;
    }

    const args = this.options.micName
      ? ["--mic-name", this.options.micName]
      : ["--mic", "default"];

    try {
      this.process = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.options.onError?.(
        `Failed to spawn meeting capture helper: ${errorMessage(err)}`,
      );
      this.process = null;
      return false;
    }

    this.setupProcessHandlers();
    return true;
  }

  private setupProcessHandlers(): void {
    const proc = this.process;
    if (!proc) return;

    // stdout is a binary frame stream. A bad frame means the stream is out
    // of sync, so the helper is stopped and reported as failed.
    const parser = createFrameParser((channel, pcm) => {
      if (!this.stopped) this.options.onFrame(channel, pcm);
    });
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (this.stopped) return;
      try {
        parser.push(chunk);
      } catch (err) {
        const message = `Meeting capture protocol error: ${errorMessage(err)}`;
        log.error(message);
        this.options.onError?.(message);
        this.stop();
      }
    });

    // stderr carries the newline-delimited text protocol.
    let lineBuffer = "";
    proc.stderr?.on("data", (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        this.handleLine(line.trim());
      }
    });

    proc.on("close", (code, signal) => {
      this.process = null;
      this.clearKillTimer();
      // A stop-initiated exit is expected. Any other exit is a fault.
      if (!this.stopped) {
        this.options.onError?.(
          `Meeting capture helper exited (code=${code}, signal=${signal})`,
        );
      }
    });

    proc.on("error", (err) => {
      this.process = null;
      this.clearKillTimer();
      if (!this.stopped) {
        this.options.onError?.(`Meeting capture helper error: ${err.message}`);
      }
    });
  }

  private handleLine(line: string): void {
    if (line.length === 0 || this.stopped) return;

    if (line === "READY") {
      log.debug("Meeting capture ready");
      this.options.onReady?.();
      return;
    }
    if (line.startsWith("LEVEL_MIC ")) {
      const rms = Number(line.slice(10));
      if (Number.isFinite(rms)) this.options.onLevelMic?.(rms);
      return;
    }
    if (line.startsWith("LEVEL ")) {
      const rms = Number(line.slice(6));
      if (Number.isFinite(rms)) this.options.onLevel?.(rms);
      return;
    }
    if (line.startsWith("SYNC ")) {
      const [wallclockMs, totalSamples] = line
        .slice(5)
        .split(/\s+/)
        .map(Number);
      if (Number.isFinite(wallclockMs) && Number.isFinite(totalSamples)) {
        this.options.onSync?.({ wallclockMs, totalSamples });
      }
      return;
    }
    if (line.startsWith("OVERRUN ")) {
      const count = Number(line.slice(8));
      log.warn(`Meeting capture overrun (${count} dropped)`);
      this.options.onOverrun?.(Number.isFinite(count) ? count : 1);
      return;
    }
    if (line.startsWith("DEVICE ")) {
      log.info(`Mic opened: ${line.slice(7)}`);
      return;
    }
    if (line.startsWith("WARN_MIC_NOT_FOUND")) {
      log.warn(`Mic not found, the helper used the default input: ${line}`);
      return;
    }
    if (line.startsWith("ERR_")) {
      log.error(`Meeting capture helper: ${line}`);
      this.options.onError?.(line);
      return;
    }
    log.debug(line);
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  /** Stop capturing: SIGTERM, then SIGKILL after a grace period. */
  stop(): void {
    this.stopped = true;
    const proc = this.process;
    if (!proc) return;

    try {
      proc.kill("SIGTERM");
    } catch {
      // The process may be dead already.
    }
    this.killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The process may be dead already.
      }
    }, KILL_GRACE_MS);
    // Do not keep the app alive only to send the SIGKILL.
    this.killTimer.unref?.();
  }
}
