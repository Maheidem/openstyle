import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createAppLogger } from "@openstyle/utils";

const log = createAppLogger("whisper");

const PID_FILE_NAME = "whisper-server.pid";
const SERVER_PROCESS_NAME = "whisper-server";

// The file sits next to the database, in the app data directory.
function pidFilePath(): string | null {
  const dbPath = process.env.OPENSTYLE_DB_PATH ?? process.env.FREESTYLE_DB_PATH;
  if (!dbPath) return null;
  return join(dirname(dbPath), PID_FILE_NAME);
}

// The PID file lets the next server process find a whisper-server that the
// last one left behind. The exit hook in server.ts does not run when the
// server process gets SIGKILL.
// The file holds "<whisper PID> <owner PID>". The owner is the server
// process that started the whisper-server. The sweep uses it to find out
// if that server process is still alive.
export function writeWhisperPidFile(pid: number | undefined): void {
  const path = pidFilePath();
  if (!path || pid === undefined) return;
  try {
    writeFileSync(path, `${pid} ${process.pid}`);
  } catch (err) {
    log.warn(`Could not write ${PID_FILE_NAME}: ${(err as Error).message}`);
  }
}

// Remove the file only when it holds this PID. A new whisper-server may
// already have written its own PID.
export function removeWhisperPidFile(pid: number | undefined): void {
  const path = pidFilePath();
  if (!path || pid === undefined) return;
  try {
    if (readFileSync(path, "utf8").trim().split(/\s+/)[0] !== String(pid)) {
      return;
    }
    rmSync(path, { force: true });
  } catch {
    // No file. Nothing to remove.
  }
}

// Command name of a live process, or null when the PID is not alive.
function processName(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const name = basename(out.toString().trim());
    return name || null;
  } catch {
    return null;
  }
}

// True when a process with this PID exists. EPERM means it exists but
// belongs to another user.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kill a whisper-server that a dead server process left behind.
 * Call it once at server boot, before any new whisper-server starts.
 * It kills the PID in the file only when that PID is alive and its command
 * name is whisper-server. It deletes the file, with one exception: when the
 * owner server process is still alive, another app instance uses this data
 * directory. Then it keeps the file and kills nothing.
 */
export function sweepStaleWhisperServer(): void {
  const path = pidFilePath();
  if (!path) return;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }

  const [pidText, ownerText] = raw.trim().split(/\s+/);
  const pid = Number.parseInt(pidText ?? "", 10);
  const owner = Number.parseInt(ownerText ?? "", 10);
  if (
    Number.isInteger(owner) &&
    owner > 1 &&
    owner !== process.pid &&
    isProcessAlive(owner)
  ) {
    log.info(
      `Kept ${PID_FILE_NAME}: its owner (PID ${owner}) is still running`,
    );
    return;
  }

  try {
    rmSync(path, { force: true });
  } catch (err) {
    log.warn(`Could not remove ${PID_FILE_NAME}: ${(err as Error).message}`);
  }

  if (!Number.isInteger(pid) || pid <= 1) {
    log.warn(`Ignored ${PID_FILE_NAME}: it holds no valid PID`);
    return;
  }
  if (process.platform === "win32") {
    log.info(`Removed ${PID_FILE_NAME} (PID ${pid}); no kill on Windows`);
    return;
  }

  const name = processName(pid);
  if (name === null) {
    log.info(`Removed ${PID_FILE_NAME}: PID ${pid} is not running`);
  } else if (name !== SERVER_PROCESS_NAME) {
    log.warn(
      `Removed ${PID_FILE_NAME}: PID ${pid} is "${name}", not ${SERVER_PROCESS_NAME}. Not killed.`,
    );
  } else {
    try {
      process.kill(pid, "SIGTERM");
      log.info(`Killed stale ${SERVER_PROCESS_NAME} (PID ${pid})`);
    } catch (err) {
      log.warn(
        `Could not kill stale ${SERVER_PROCESS_NAME} (PID ${pid}): ${(err as Error).message}`,
      );
    }
  }
}
