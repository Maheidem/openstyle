import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  removeWhisperPidFile,
  sweepStaleWhisperServer,
  writeWhisperPidFile,
} from "../src/lib/whisper/pid-file.js";

// These tests use real processes. The sweep needs `ps`, so skip on Windows.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

const ORIGINAL_DB_PATH = process.env.OPENSTYLE_DB_PATH;
let dir = "";
let pidFile = "";
const children: ChildProcess[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startSleeper(binary: string): ChildProcess {
  const child = spawn(binary, ["600"], { stdio: "ignore" });
  children.push(child);
  return child;
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "openstyle-whisper-pid-"));
  pidFile = join(dir, "whisper-server.pid");
  process.env.OPENSTYLE_DB_PATH = join(dir, "test.db");
  // A copy of a system binary needs a new ad-hoc signature on macOS.
  // Without it, the system ends the process at start.
  copyFileSync("/bin/sleep", join(dir, "whisper-server"));
  if (process.platform === "darwin") {
    execFileSync(
      "codesign",
      ["-s", "-", "--force", join(dir, "whisper-server")],
      {
        stdio: "ignore",
      },
    );
  }
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
  rmSync(pidFile, { force: true });
});

afterAll(() => {
  process.env.OPENSTYLE_DB_PATH = ORIGINAL_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("whisper-server PID file", () => {
  it("writes the PID next to the database", () => {
    writeWhisperPidFile(4242);
    expect(readFileSync(pidFile, "utf8")).toBe("4242");
  });

  it("removes the file only for the PID that wrote it", () => {
    writeWhisperPidFile(4242);
    removeWhisperPidFile(1111);
    expect(existsSync(pidFile)).toBe(true);
    removeWhisperPidFile(4242);
    expect(existsSync(pidFile)).toBe(false);
  });
});

describeUnix("sweepStaleWhisperServer", () => {
  it("does nothing when there is no file", () => {
    const control = startSleeper("/bin/sleep");
    sweepStaleWhisperServer();
    expect(existsSync(pidFile)).toBe(false);
    expect(isAlive(control.pid as number)).toBe(true);
  });

  it("removes the file when the PID is dead", async () => {
    const gone = spawn("/bin/sleep", ["0"], { stdio: "ignore" });
    await waitForExit(gone);
    writeFileSync(pidFile, String(gone.pid));
    sweepStaleWhisperServer();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("removes the file when it holds no valid PID", () => {
    writeFileSync(pidFile, "not-a-pid");
    sweepStaleWhisperServer();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("kills a live process named whisper-server", async () => {
    const stale = startSleeper(join(dir, "whisper-server"));
    writeFileSync(pidFile, String(stale.pid));
    sweepStaleWhisperServer();
    await waitForExit(stale);
    expect(stale.signalCode).toBe("SIGTERM");
    expect(existsSync(pidFile)).toBe(false);
  });

  it("does not kill a live process with another name", () => {
    const other = startSleeper("/bin/sleep");
    writeFileSync(pidFile, String(other.pid));
    sweepStaleWhisperServer();
    expect(isAlive(other.pid as number)).toBe(true);
    expect(other.signalCode).toBeNull();
    expect(existsSync(pidFile)).toBe(false);
  });
});
