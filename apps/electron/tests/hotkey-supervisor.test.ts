import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { freeLoopbackPort, waitForDashboardWindow } from "./helpers/e2e-app";

test.skip(
  process.platform !== "darwin",
  "The supervisor test drives the macOS key listener helper.",
);

const HELPER = resolve(
  __dirname,
  "../resources/bin/darwin-arm64/macos-key-listener",
);
const RETRY_MS = 3_000;

/** PIDs of the helpers that belong to this app. Filter by the hotkey argument. */
function helperPids(appPid: number, hotkey?: string): number[] {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], {
    encoding: "utf8",
  }).split("\n");
  const pids: number[] = [];
  for (const row of rows) {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, args] = match;
    const own = hotkey
      ? args === `${HELPER} ${hotkey}`
      : args.startsWith(HELPER);
    if (Number(ppid) === appPid && own) {
      pids.push(Number(pid));
    }
  }
  return pids;
}

test("dictation helper is retried after a permanent failure and hold mode returns", async () => {
  test.setTimeout(120_000);

  const testDir = mkdtempSync(join(tmpdir(), "openstyle-supervisor-e2e-"));
  const userDataDir = join(testDir, "user-data");
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  const helperMode = statSync(HELPER).mode;

  const app = await electron.launch({
    args: [
      resolve(__dirname, "fixtures/permission-main.cjs"),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    env: {
      ...process.env,
      NODE_ENV: "development",
      OPENSTYLE_E2E: "1",
      OPENSTYLE_E2E_ACCESSIBILITY: "granted",
      OPENSTYLE_E2E_MICROPHONE: "granted",
      OPENSTYLE_E2E_HOTKEY_RETRY_MS: String(RETRY_MS),
      OPENSTYLE_USER_DATA: userDataDir,
      OPENSTYLE_SERVER_PORT: String(await freeLoopbackPort()),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    timeout: 30_000,
  });
  const proc = app.process();
  const appPid = proc.pid as number;
  let log = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  const count = (text: string): number => log.split(text).length - 1;

  try {
    await app.firstWindow();
    const dashboard = await waitForDashboardWindow(app);

    // 1. The helper starts. (The "ready" line is a debug line and the built
    // app does not print debug lines, so the process is the proof here.)
    await expect
      .poll(() => helperPids(appPid, "Fn").length, { timeout: 20_000 })
      .toBe(1);
    const [firstPid] = helperPids(appPid, "Fn");
    expect(firstPid).toBeGreaterThan(0);

    // 2. A restart that reaches READY resets the restart counter, so killing
    // a healthy helper again and again never ends in a permanent failure.
    // Make every new start fail (no execute bit), then kill the helper once.
    // Main restarts it 5 times (2 s x attempt), each start fails, and the
    // listener gives up.
    chmodSync(HELPER, 0o644);
    process.kill(firstPid, "SIGKILL");
    await expect
      .poll(() => count("Key listener exceeded max restart attempts"), {
        timeout: 90_000,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          count(
            "Native key listener permanently failed; falling back to Electron globalShortcut (toggle mode).",
          ),
        { timeout: 5_000 },
      )
      .toBe(1);
    expect(helperPids(appPid, "Fn")).toEqual([]);

    // 3. While the helper cannot start, each retry fails and the fallback
    // stays. A failed retry logs at debug level only, so the log gets no new
    // error line. Step 4 proves that the retries run.
    const errorsBefore = count("Key listener process error");
    await new Promise((done) => setTimeout(done, RETRY_MS * 2 + 1_000));
    expect(count("Key listener process error")).toBe(errorsBefore);
    expect(count("Dictation key listener recovered")).toBe(0);
    expect(helperPids(appPid, "Fn")).toEqual([]);

    // 4. The helper works again. The next retry restores hold mode.
    chmodSync(HELPER, helperMode & 0o777);
    await expect
      .poll(
        () => count("Dictation key listener recovered; hold mode restored."),
        {
          timeout: RETRY_MS * 4,
        },
      )
      .toBe(1);
    const recoveredPids = helperPids(appPid, "Fn");
    expect(recoveredPids).toHaveLength(1);
    expect(recoveredPids[0]).not.toBe(firstPid);

    // 5. After recovery no further retry runs (one recovery line only).
    await new Promise((done) => setTimeout(done, RETRY_MS * 2));
    expect(count("Dictation key listener recovered")).toBe(1);
    expect(helperPids(appPid, "Fn")).toEqual(recoveredPids);

    // 6. The hotkey IPC path still delivers down and up to the windows.
    await dashboard.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __hotkeySeen: string[] }).__hotkeySeen = seen;
      window.api.onHotkeyDown(() => seen.push("down"));
      window.api.onHotkeyUp(() => seen.push("up"));
      window.electron.ipcRenderer.send("e2e:trigger-hotkey-down");
    });
    await dashboard.waitForTimeout(300);
    await dashboard.evaluate(() => {
      window.electron.ipcRenderer.send("e2e:trigger-hotkey-up");
    });
    await expect
      .poll(() =>
        dashboard.evaluate(
          () => (window as unknown as { __hotkeySeen: string[] }).__hotkeySeen,
        ),
      )
      .toEqual(["down", "up"]);
  } catch (error) {
    console.log(`App log:\n${log}`);
    throw error;
  } finally {
    chmodSync(HELPER, helperMode & 0o777);
    // Stop the helpers of this app only, by PID, before the app itself.
    for (const pid of helperPids(appPid)) process.kill(pid, "SIGTERM");
    const exited = new Promise<void>((done) => proc.once("exit", () => done()));
    proc.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((done) => setTimeout(done, 5_000)),
    ]);
  }
});
