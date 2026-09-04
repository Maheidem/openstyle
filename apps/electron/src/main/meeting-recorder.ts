/**
 * Meeting Recorder
 *
 * Owns a dual-channel meeting recording session:
 *   - mic:    a hidden BrowserWindow running the PCM AudioWorklet capture
 *             (meeting-capture.html), streaming 16 kHz mono PCM16 over IPC.
 *   - system: the macos-system-audio helper via SystemAudioCapture.
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
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { mkdir, readdir, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import {
  DEFAULT_MEETING_MAX_DURATION_HOURS,
  parseMeetingMaxDurationHours,
} from "@openstyle/validations";
import { app, type BrowserWindow, powerMonitor } from "electron";
import { SETTINGS_KEYS } from "../shared/settings-keys";
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
/** Refuse to start a recording with less than 2 GB free on the volume. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;
/** Mic RMS is forwarded to the UI at the same cadence as system LEVELs. */
const LEVEL_INTERVAL_MS = 200;

export type MeetingRecorderStatus = "idle" | "recording" | "finalizing";

export interface MeetingLevelEvent {
  meetingId: string;
  source: "mic" | "system";
  rms: number;
}

interface SyncEpoch {
  /** Why this epoch was stamped ("start" | "resume"). */
  reason: "start" | "resume";
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
  /** 60 s wallclock/sample markers from the system helper. */
  syncMarkers: SyncMarker[];
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

export interface MeetingRecorderDeps {
  /** Base URL + auth for the in-process/configured Openstyle server. */
  getServerBaseUrl: () => string;
  getServerAuthHeaders: () => Record<string, string>;
  /**
   * Create the hidden mic-capture BrowserWindow (show:false) loading
   * meeting-capture.html. Owned (and closed) by the recorder.
   */
  createCaptureWindow: () => BrowserWindow;
  /** Broadcast a `meeting:level` event to interested renderer windows. */
  broadcastLevel: (event: MeetingLevelEvent) => void;
  /** Broadcast a `meeting:status` change to interested renderer windows. */
  broadcastStatus: (status: MeetingRecorderStatus) => void;
}

export class MeetingRecorder {
  private deps: MeetingRecorderDeps;
  private _status: MeetingRecorderStatus = "idle";

  private meetingId: string | null = null;
  private meetingDir: string | null = null;
  private startedAt = 0;
  private micWav: WavWriter | null = null;
  private systemWav: WavWriter | null = null;
  private systemCapture: SystemAudioCapture | null = null;
  private captureWindow: BrowserWindow | null = null;
  private journal: SyncJournal | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMicLevelAt = 0;
  private lastError: string | null = null;
  private resumeListener: (() => void) | null = null;

  constructor(deps: MeetingRecorderDeps) {
    this.deps = deps;
  }

  get status(): MeetingRecorderStatus {
    return this._status;
  }

  get currentMeetingId(): string | null {
    return this.meetingId;
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

  private setStatus(status: MeetingRecorderStatus): void {
    this._status = status;
    this.deps.broadcastStatus(status);
  }

  private async api(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    const res = await fetch(`${this.deps.getServerBaseUrl()}/api${path}`, {
      method: init.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...this.deps.getServerAuthHeaders(),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return res;
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

  /** Start a recording. Throws with a user-facing message on refusal. */
  async start(): Promise<string> {
    if (this._status !== "idle") {
      throw new Error("A meeting recording is already in progress");
    }
    if (!isSystemAudioCaptureSupported()) {
      throw new Error("Meeting recording requires macOS 14.4 or later");
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
    const dir = join(userData, "meetings", id);
    await mkdir(dir, { recursive: true });

    const startedAt = Date.now();
    const res = await this.api("/meetings/start", {
      method: "POST",
      body: { id, audio_dir: dir, started_at: startedAt },
    });
    if (!res.ok) {
      throw new Error(`Failed to create meeting row (HTTP ${res.status})`);
    }

    this.meetingId = id;
    this.meetingDir = dir;
    this.startedAt = startedAt;
    this.lastError = null;
    this.micWav = new WavWriter(join(dir, "mic.wav"));
    this.systemWav = new WavWriter(join(dir, "system.wav"));
    this.journal = {
      meetingId: id,
      sampleRate: SAMPLE_RATE,
      micT0: null,
      systemT0: null,
      micSamples: 0,
      systemSamples: 0,
      syncMarkers: [],
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

    // System channel.
    this.systemCapture = new SystemAudioCapture({
      onData: (chunk) => this.handleSystemChunk(chunk),
      onLevel: (rms) => {
        if (this.meetingId) {
          this.deps.broadcastLevel({
            meetingId: this.meetingId,
            source: "system",
            rms,
          });
        }
      },
      onSync: (marker) => {
        this.journal?.syncMarkers.push(marker);
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
      this.captureWindow = this.deps.createCaptureWindow();
      this.captureWindow.on("closed", () => {
        this.captureWindow = null;
      });
    } catch (err) {
      log.error(
        `Failed to create mic capture window: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.lastError = this.lastError ?? "mic: capture window failed";
    }

    // Periodic PCM flush.
    this.flushTimer = setInterval(() => {
      try {
        this.micWav?.flush();
        this.systemWav?.flush();
      } catch (err) {
        log.error(`WAV flush failed: ${String(err)}`);
        void this.stop("failed", `wav flush failed: ${String(err)}`);
      }
    }, FLUSH_INTERVAL_MS);

    // Auto-stop ceiling.
    const maxMs = await this.readMaxDurationMs();
    this.maxDurationTimer = setTimeout(() => {
      log.info("Max meeting duration reached; auto-stopping");
      void this.stop();
    }, maxMs);

    // On resume from sleep, stamp a new timeline epoch: the channels carry no
    // samples for the gap, so the merge must re-anchor to wallclock here.
    this.resumeListener = () => {
      if (!this.journal) return;
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
    log.info(`Meeting recording started: ${id}`);
    return id;
  }

  /** Mic PCM16 chunk delivered from the capture window over IPC. */
  handleMicChunk(chunk: Buffer): void {
    if (this._status !== "recording" || !this.micWav || !this.journal) return;
    if (this.journal.micT0 === null) {
      // t0 = wallclock of the FIRST delivered sample, not window-spawn time.
      this.journal.micT0 = Date.now();
      void this.writeJournal();
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
    if (this.journal.systemT0 === null) {
      this.journal.systemT0 = Date.now();
      void this.writeJournal();
    }
    this.systemWav.append(chunk);
    this.journal.systemSamples += Math.floor(chunk.length / BYTES_PER_SAMPLE);
  }

  /** Stop the recording and finalize files + DB row. */
  async stop(
    status: "recorded" | "failed" = "recorded",
    error?: string,
  ): Promise<void> {
    if (this._status !== "recording") return;
    const meetingId = this.meetingId;
    this.setStatus("finalizing");

    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;
    if (this.resumeListener) {
      powerMonitor.removeListener("resume", this.resumeListener);
      this.resumeListener = null;
    }

    this.systemCapture?.stop();
    this.systemCapture = null;
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      this.captureWindow.destroy();
    }
    this.captureWindow = null;

    try {
      this.micWav?.finalize();
      this.systemWav?.finalize();
    } catch (err) {
      log.error(`WAV finalize failed: ${String(err)}`);
      status = "failed";
      error = error ?? `wav finalize failed: ${String(err)}`;
    }
    this.micWav = null;
    this.systemWav = null;

    await this.writeJournal();

    const endedAt = Date.now();
    if (meetingId) {
      try {
        await this.api(`/meetings/${meetingId}/stop`, {
          method: "POST",
          body: {
            ended_at: endedAt,
            duration_ms: endedAt - this.startedAt,
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
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;
    if (this.resumeListener) {
      powerMonitor.removeListener("resume", this.resumeListener);
      this.resumeListener = null;
    }
    this.systemCapture?.stop();
    this.systemCapture = null;
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      this.captureWindow.destroy();
    }
    this.captureWindow = null;
    try {
      this.micWav?.finalize();
      this.systemWav?.finalize();
    } catch (err) {
      log.error(`WAV finalize failed during quit: ${String(err)}`);
    }
    this.micWav = null;
    this.systemWav = null;
    this._status = "idle";
  }

  private async writeJournal(): Promise<void> {
    if (!this.journal || !this.meetingDir) return;
    try {
      await writeFile(
        join(this.meetingDir, "sync.json"),
        `${JSON.stringify(this.journal, null, 2)}\n`,
        "utf-8",
      );
    } catch (err) {
      log.warn(`Failed to write sync.json: ${String(err)}`);
    }
  }

  /**
   * Boot-time orphan sweep: any meeting row a crash left in 'recording' gets
   * its WAV headers finalized from the on-disk file sizes and its row marked
   * 'interrupted'; any row left in 'transcribing' (the in-process server died
   * mid-job, so the job is gone for good) is marked 'failed' with a named
   * cause — its partial transcript survives and stays retryable. Call once
   * after the server is reachable.
   */
  async sweepOrphans(): Promise<void> {
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
