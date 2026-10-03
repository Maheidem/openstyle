import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { AUDIO_CONTROL_CMD_TIMEOUT_MS } from "./audio-control-constants";

const execFileAsync = promisify(execFile);

/** Runs a native binary. Rejects with its stderr text when it fails. */
export function execFileText(path: string, args: string[]): Promise<string> {
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

export function execFileTextSync(path: string, args: string[]): string {
  return execFileSync(path, args, { encoding: "utf8" }).trim();
}

/** Runs a command. Never rejects. Returns `ok: false` when it fails. */
export async function runCmd(
  command: string,
  args: string[],
): Promise<{ stdout: string; ok: boolean }> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: AUDIO_CONTROL_CMD_TIMEOUT_MS,
    });
    return { stdout: stdout.trim(), ok: true };
  } catch {
    return { stdout: "", ok: false };
  }
}

export async function commandExists(command: string): Promise<boolean> {
  const { ok } = await runCmd("sh", ["-c", `command -v ${command}`]);
  return ok;
}
