import { execFile, execFileSync } from "node:child_process";
import { getNativeBinaryPath } from "../native-binary";
import { DUCKED_VOLUME } from "./audio-control-constants";
import type { DeviceVolumeSnapshot } from "./interfaces/device-volume-snapshot.interface";
import type { VolumeDucker } from "./interfaces/volume-ducker.interface";

function execFileText(path: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const detail = typeof stderr === "string" ? stderr.trim() : "";
        reject(new Error(detail || err.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function execFileTextSync(path: string, args: string[]): string {
  return execFileSync(path, args, { encoding: "utf8" }).trim();
}

interface NativeVolumeDuckerOptions<DeviceId extends string | number> {
  /** Name of the native binary that gets and sets the output volume. */
  binaryName: string;
  /** Returns true when a value has the device id type of this platform. */
  isDeviceId: (value: unknown) => value is DeviceId;
}

export const isNumberDeviceId = (value: unknown): value is number =>
  typeof value === "number";

export const isStringDeviceId = (value: unknown): value is string =>
  typeof value === "string";

/** Ducks the output volume with a native binary (macOS and Windows). */
export class NativeVolumeDucker<DeviceId extends string | number>
  implements VolumeDucker
{
  private snapshot: DeviceVolumeSnapshot<DeviceId> | null = null;
  private active = false;
  private readonly binaryName: string;
  private readonly isDeviceId: (value: unknown) => value is DeviceId;

  constructor(options: NativeVolumeDuckerOptions<DeviceId>) {
    this.binaryName = options.binaryName;
    this.isDeviceId = options.isDeviceId;
  }

  private parseSnapshot(stdout: string): DeviceVolumeSnapshot<DeviceId> {
    const data = JSON.parse(stdout) as {
      deviceId?: unknown;
      volume?: unknown;
    };
    if (!this.isDeviceId(data.deviceId) || typeof data.volume !== "number") {
      throw new Error(`Invalid ${this.binaryName} response`);
    }
    return { deviceId: data.deviceId, previousVolume: data.volume };
  }

  async duck(): Promise<boolean> {
    if (this.active) return true;

    const binaryPath = getNativeBinaryPath(this.binaryName);
    if (!binaryPath) return false;

    const snapshot = this.parseSnapshot(
      await execFileText(binaryPath, ["get"]),
    );
    if (snapshot.previousVolume > DUCKED_VOLUME) {
      await execFileText(binaryPath, [
        "set",
        String(DUCKED_VOLUME),
        String(snapshot.deviceId),
      ]);
    }

    this.snapshot = snapshot;
    this.active = true;
    return true;
  }

  async restore(): Promise<void> {
    if (!this.active) return;

    const snapshot = this.snapshot;
    if (!snapshot) {
      this.active = false;
      return;
    }

    const binaryPath = getNativeBinaryPath(this.binaryName);
    if (!binaryPath) {
      throw new Error(`${this.binaryName} binary is unavailable`);
    }

    try {
      await execFileText(binaryPath, [
        "set",
        String(snapshot.previousVolume),
        String(snapshot.deviceId),
      ]);
    } catch {
      await execFileText(binaryPath, ["set", String(snapshot.previousVolume)]);
    }

    this.snapshot = null;
    this.active = false;
  }

  snapshotForRecovery(): unknown {
    return this.snapshot;
  }

  async recoverFromSnapshot(raw: unknown): Promise<boolean> {
    const snapshot = raw as Partial<DeviceVolumeSnapshot<DeviceId>> | null;
    if (
      typeof snapshot?.previousVolume !== "number" ||
      !this.isDeviceId(snapshot.deviceId) ||
      snapshot.previousVolume <= DUCKED_VOLUME
    ) {
      return false;
    }

    const binaryPath = getNativeBinaryPath(this.binaryName);
    if (!binaryPath) return false;

    const current = this.parseSnapshot(await execFileText(binaryPath, ["get"]));
    if (current.previousVolume > DUCKED_VOLUME + 0.05) return false;

    try {
      await execFileText(binaryPath, [
        "set",
        String(snapshot.previousVolume),
        String(snapshot.deviceId),
      ]);
    } catch {
      await execFileText(binaryPath, ["set", String(snapshot.previousVolume)]);
    }
    return true;
  }

  restoreSync(): boolean {
    if (!this.active) return true;

    const snapshot = this.snapshot;
    if (!snapshot) {
      this.active = false;
      return true;
    }

    const binaryPath = getNativeBinaryPath(this.binaryName);
    if (!binaryPath) return false;

    let restored = false;

    try {
      execFileTextSync(binaryPath, [
        "set",
        String(snapshot.previousVolume),
        String(snapshot.deviceId),
      ]);
      restored = true;
    } catch {
      try {
        execFileTextSync(binaryPath, ["set", String(snapshot.previousVolume)]);
        restored = true;
      } catch {
        // Quit cleanup should never block app shutdown on audio restore failure.
      }
    }

    if (restored) {
      this.snapshot = null;
      this.active = false;
    }
    return restored;
  }
}
