/**
 * System Audio Capture (macOS)
 *
 * Spawns the `macos-system-audio` helper (a Core Audio process tap), which
 * emits raw PCM16 (16 kHz mono) on stdout and a text protocol on stderr:
 *
 *   READY                          tap running, samples flowing soon
 *   LEVEL <rms>                    ~200 ms RMS level (0..1)
 *   SYNC <wallclock_ms> <samples>  wallclock/sample-count marker every 60 s
 *   OVERRUN <n>                    ring-buffer overruns (dropped frames)
 *   ERR_UNSUPPORTED_OS / ERR_TAP_CREATE / ERR_AGG_CREATE / ERR_START <code>
 *
 * Requires macOS >= 14.4 (Core Audio process taps). Modeled on the removed
 * always-on mic-listener (see git history; the native helper sources are kept
 * under native/).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createAppLogger } from "@openstyle/utils";
import { getNativeBinaryPath } from "./native-binary";

const log = createAppLogger("system-audio");

export const SYSTEM_AUDIO_SAMPLE_RATE = 16000;

/** Grace period between SIGTERM and SIGKILL when stopping the helper. */
const KILL_GRACE_MS = 3000;

/** Core Audio process taps landed in macOS 14.4 (Darwin 23.4). */
export function isSystemAudioCaptureSupported(): boolean {
  if (process.platform !== "darwin") return false;
  const [major, minor] = process
    .getSystemVersion()
    .split(".")
    .map((p) => Number(p));
  if (!Number.isFinite(major)) return false;
  return major > 14 || (major === 14 && (minor ?? 0) >= 4);
}

export interface SyncMarker {
  wallclockMs: number;
  totalSamples: number;
}

interface SystemAudioCaptureOptions {
  /** Raw PCM16 (16 kHz mono) buffers as delivered by the helper. */
  onData: (chunk: Buffer) => void;
  onReady?: () => void;
  /** ~200 ms RMS level, 0..1. */
  onLevel?: (rms: number) => void;
  /** 60 s wallclock/sample-count markers for merge-time drift correction. */
  onSync?: (marker: SyncMarker) => void;
  onOverrun?: (count: number) => void;
  /** Fatal helper errors (ERR_* lines, spawn failures, unexpected exits). */
  onError?: (error: string) => void;
}

export class SystemAudioCapture {
  private process: ChildProcess | null = null;
  private options: SystemAudioCaptureOptions;
  private stopped = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SystemAudioCaptureOptions) {
    this.options = options;
  }

  get running(): boolean {
    return this.process !== null;
  }

  /**
   * Spawn the helper and start streaming. Returns false when unsupported,
   * the binary is missing, or the spawn fails (onError is called for the
   * latter).
   */
  start(): boolean {
    if (this.process || this.stopped) return false;

    if (!isSystemAudioCaptureSupported()) {
      this.options.onError?.(
        "System audio capture requires macOS 14.4 or later",
      );
      return false;
    }

    const binaryPath = getNativeBinaryPath("macos-system-audio");
    if (!binaryPath) {
      this.options.onError?.("macos-system-audio binary not found");
      return false;
    }

    try {
      this.process = spawn(binaryPath, [], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.options.onError?.(
        `Failed to spawn system audio helper: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.process = null;
      return false;
    }

    this.setupProcessHandlers();
    return true;
  }

  private setupProcessHandlers(): void {
    if (!this.process) return;

    // stdout is a raw PCM16 byte stream — forward buffers as delivered.
    this.process.stdout?.on("data", (chunk: Buffer) => {
      if (!this.stopped) this.options.onData(chunk);
    });

    // stderr carries the newline-delimited text protocol.
    let lineBuffer = "";
    this.process.stderr?.on("data", (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        this.handleLine(line.trim());
      }
    });

    this.process.on("close", (code, signal) => {
      this.process = null;
      this.clearKillTimer();
      // A stop-initiated exit is expected; anything else is a fault.
      if (!this.stopped && code !== 0) {
        this.options.onError?.(
          `System audio helper exited (code=${code}, signal=${signal})`,
        );
      }
    });

    this.process.on("error", (err) => {
      this.process = null;
      this.clearKillTimer();
      if (!this.stopped) {
        this.options.onError?.(`System audio helper error: ${err.message}`);
      }
    });
  }

  private handleLine(line: string): void {
    if (line.length === 0) return;

    if (line === "READY") {
      log.debug("System audio tap ready");
      this.options.onReady?.();
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
      log.warn(`System audio overrun (${count} dropped)`);
      this.options.onOverrun?.(Number.isFinite(count) ? count : 1);
      return;
    }
    if (line.startsWith("ERR_")) {
      log.error(`System audio helper: ${line}`);
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

  /**
   * Stop capturing: SIGTERM, escalating to SIGKILL after a grace period.
   */
  stop(): void {
    this.stopped = true;
    const proc = this.process;
    if (!proc) return;

    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }
    this.killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may already be dead
      }
    }, KILL_GRACE_MS);
    // Don't keep the app alive just to deliver the SIGKILL.
    this.killTimer.unref?.();
  }
}
