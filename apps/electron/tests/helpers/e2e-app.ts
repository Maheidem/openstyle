import { join, resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron } from "playwright";

/**
 * Starts the built app (out/main/index.js) against a throwaway userData dir
 * and waits for its first window. OPENSTYLE_USER_DATA gives the isolation:
 * main/index.ts rewrites OPENSTYLE_DB_PATH from userData, so without it the
 * run would use the real profile of the developer.
 */
export async function launchOpenstyle(options: {
  userDataDir: string;
  timeout?: number;
}): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [resolve(__dirname, "../../out/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "development",
      OPENSTYLE_DB_PATH: join(options.userDataDir, "freestyle.db"),
      OPENSTYLE_USER_DATA: options.userDataDir,
      OPENSTYLE_E2E: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    timeout: options.timeout ?? 30_000,
  });
  // Wait for the first window so the state of Playwright is ready.
  await app.firstWindow();
  return app;
}

/**
 * Wait for a window whose URL is neither the pill nor the remix bar.
 * That is the dashboard or onboarding window. The pill (pill.html) and the
 * remix bar (bar.html) are auxiliary windows and can appear first.
 */
export async function waitForDashboardWindow(
  electronApp: ElectronApplication,
  timeoutMs = 10_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const win of electronApp.windows()) {
      const url = win.url();
      if (
        !url.includes("pill") &&
        !url.includes("bar.html") &&
        url.length > 0
      ) {
        await win.waitForLoadState("domcontentloaded");
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // Fallback: return the first window that exists.
  return electronApp.windows()[0];
}

/** Closes the app. A hung quit gets SIGKILL after 10 s. */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  try {
    await app.close();
  } catch (error) {
    console.warn("Error closing app:", error);
    proc.kill("SIGKILL");
  } finally {
    clearTimeout(killTimer);
  }
}
