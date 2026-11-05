import { mkdtempSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let app: ElectronApplication | undefined;
let dashboardPage: Page;

test.beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-"));

  // Turn Meeting Mode on BEFORE launch (the onboarding auto-Enhance step is
  // gated on `flags.meetings === true`). Pre-seeding the config file in the
  // throwaway userData dir is deterministic — no race with the onboarding
  // page's first config load — and it's isolated to this temp profile.
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    `${JSON.stringify({ version: 1, flags: { meetings: true } }, null, 2)}\n`,
  );

  try {
    app = await launchOpenstyle({ userDataDir });

    // Find the dashboard (non-pill) window.
    dashboardPage = await waitForDashboardWindow(app, 15_000);
    try {
      await dashboardPage.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      // Embedded server keeps connections open; networkidle may never fire.
      await dashboardPage.waitForLoadState("load", { timeout: 10_000 });
    }
  } catch (error) {
    console.error("Failed to launch Electron app:", error);
    if (app) {
      await app.close().catch(console.error);
      app = undefined;
    }
    throw error;
  }
});

test.afterAll(async () => {
  if (!app) return;
  await closeApp(app);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("app launches and creates windows", async () => {
  const windows = app!.windows();
  expect(windows.length).toBeGreaterThanOrEqual(1);
});

test("main process is responsive", async () => {
  const isPackaged = await app!.evaluate(({ app }) => app.isPackaged);
  expect(isPackaged).toBe(false);
});

test("app name is Openstyle", async () => {
  const appName = await app!.evaluate(({ app }) => app.getName());
  expect(appName).toBe("Openstyle");
});

test("app version is defined", async () => {
  const version = await app!.evaluate(({ app }) => app.getVersion());
  expect(version).toBeTruthy();
  expect(version).toMatch(/^\d+\.\d+/);
});

test("dashboard window loads the onboarding route", async () => {
  // A fresh profile has no settings.json, so onboarding is active.
  expect(dashboardPage.url()).toContain("/onboarding");
});

test("dashboard window has a reasonable viewport", async () => {
  const size = dashboardPage.viewportSize();
  if (size) {
    expect(size.width).toBeGreaterThanOrEqual(700);
    expect(size.height).toBeGreaterThanOrEqual(400);
  }
});

test("embedded server is running", async () => {
  const health = await app!.evaluate(async (_electron, base) => {
    const res = await fetch(`${base}/api/health`);
    return res.json() as Promise<{ status: string; name: string }>;
  }, embeddedServerUrl(app!));
  expect(health).toEqual({ status: "ok", name: "openstyle" });
});

test("settings API works via embedded server", async () => {
  await app!.evaluate(async (_electron, base) => {
    await fetch(`${base}/api/settings/e2e_test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    });
  }, embeddedServerUrl(app!));

  const result = await app!.evaluate(async (_electron, base) => {
    const res = await fetch(`${base}/api/settings/e2e_test`);
    return res.json() as Promise<{ key: string; value: string }>;
  }, embeddedServerUrl(app!));
  expect(result).toEqual({ key: "e2e_test", value: "hello" });
});

test("dashboard renders content", async () => {
  // The body is visible before React renders text into it. Retry until the
  // body has visible text (one read can see the empty shell).
  await expect(dashboardPage.locator("body")).toHaveText(/\S/, {
    useInnerText: true,
  });
});
