import { getNativeBinaryPath } from "../native-binary";
import { execFileText, execFileTextSync } from "./exec-util";

export class MacosMediaPlayback {
  private active = false;

  async pausePlayback(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    if (this.active) return true;

    const binaryPath = getNativeBinaryPath("macos-media-control");
    if (!binaryPath) return false;

    try {
      await execFileText(binaryPath, ["pause"]);
      this.active = true;
      return true;
    } catch {
      return false;
    }
  }

  async resumePlayback(): Promise<void> {
    if (process.platform !== "darwin") return;
    if (!this.active) return;

    this.active = false;
    const binaryPath = getNativeBinaryPath("macos-media-control");
    if (!binaryPath) return;

    try {
      await execFileText(binaryPath, ["resume"]);
    } catch {
      // A media session may disappear while recording. Nothing to restore then.
    }
  }

  resumePlaybackSync(): void {
    if (process.platform !== "darwin") return;
    if (!this.active) return;

    this.active = false;
    const binaryPath = getNativeBinaryPath("macos-media-control");
    if (!binaryPath) return;

    try {
      execFileTextSync(binaryPath, ["resume"]);
    } catch {
      // Quit cleanup should never block app shutdown on media restore failure.
    }
  }
}
