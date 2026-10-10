import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  closeApp,
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";

// The server runs in an Electron utility process. When that process dies,
// main must start a new one and the windows must stay open.

let app: ElectronApplication | undefined;
let dashboardPage: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-host-"));
  app = await launchOpenstyle({ userDataDir });
  dashboardPage = await waitForDashboardWindow(app, 15_000);
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

async function utilityPid(): Promise<number | null> {
  return app!.evaluate(() => {
    const read = (globalThis as Record<string, unknown>)
      .__openstyleServerHostPid;
    return typeof read === "function" ? (read() as number | null) : null;
  });
}

async function healthStatus(base: string): Promise<number | null> {
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.status;
  } catch {
    return null;
  }
}

test("server restarts after the utility process is killed", async () => {
  const base = embeddedServerUrl(app!);

  // The server answers before the kill.
  const oldPid = await utilityPid();
  expect(oldPid).toBeGreaterThan(0);
  expect(await healthStatus(base)).toBe(200);

  process.kill(oldPid as number, "SIGKILL");

  // A new process answers within 10 s. Main restarts it after a 1 s backoff.
  // The restart asks for the last port. If the port changed, main tells the
  // window through the server:port IPC, so read it again from the window.
  let healthy = false;
  const deadline = Date.now() + 10_000;
  let url = base;
  while (Date.now() < deadline && !healthy) {
    healthy = (await healthStatus(url)) === 200;
    if (!healthy) {
      const port = await dashboardPage
        .evaluate(() =>
          (
            window as unknown as { api: { getServerPort(): Promise<number> } }
          ).api.getServerPort(),
        )
        .catch(() => null);
      if (port) url = `http://127.0.0.1:${port}`;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  expect(healthy).toBe(true);

  // The dashboard window is still alive.
  expect(dashboardPage.isClosed()).toBe(false);
  expect(await dashboardPage.evaluate(() => document.readyState)).toBe(
    "complete",
  );

  // A different process serves now.
  const newPid = await utilityPid();
  expect(newPid).toBeGreaterThan(0);
  expect(newPid).not.toBe(oldPid);
});
