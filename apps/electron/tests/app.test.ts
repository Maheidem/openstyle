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
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let app: ElectronApplication | undefined;
let dashboardPage: Page;

const DEFAULT_PORT = 4649;

test.beforeAll(async () => {
  // Skip (rather than silently reusing) a foreign server on the default port
  // — the app's boot probe would find it and this suite's embedded-server
  // assertions would read (and PUT into) that real instance's DB. Same guard
  // as tests/meeting-cancel-transcribe.test.ts.
  let foreign = false;
  try {
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    foreign = res.ok;
  } catch {
    // nothing listening — clean environment, proceed with the embedded server
  }
  // Call the skip outside the try: the bare catch would swallow its throw.
  test.skip(
    foreign,
    `Another Openstyle server is listening on ${DEFAULT_PORT}; the app would reuse it and touch its DB. Stop it, or run this suite against an isolated server.`,
  );

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
  const health = await app!.evaluate(async (_electron, port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.json() as Promise<{ status: string; name: string }>;
  }, DEFAULT_PORT);
  expect(health).toEqual({ status: "ok", name: "openstyle" });
});

test("settings API works via embedded server", async () => {
  await app!.evaluate(async (_electron, port) => {
    await fetch(`http://127.0.0.1:${port}/api/settings/e2e_test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    });
  }, DEFAULT_PORT);

  const result = await app!.evaluate(async (_electron, port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/e2e_test`);
    return res.json() as Promise<{ key: string; value: string }>;
  }, DEFAULT_PORT);
  expect(result).toEqual({ key: "e2e_test", value: "hello" });
});

test("dashboard renders content", async () => {
  const body = dashboardPage.locator("body");
  await body.waitFor({ state: "visible" });
  expect((await body.innerText()).length).toBeGreaterThan(0);
});

// Runs LAST among the dashboard tests: completing onboarding changes the
// window's route, which the earlier tests must not inherit.
test("onboarding flow reaches the draft and remix steps and completes", async () => {
  const page = dashboardPage;

  // Permissions step, now first — E2E bypasses the OS grants.
  await page.getByRole("button", { name: "Continue" }).click();

  // Language step.
  await page.getByRole("button", { name: "Continue" }).click();

  // Draft step — the Gmail mockup. Typing into the body enables Continue.
  await page.getByText("New Message").waitFor({ state: "visible" });
  const continueButton = page.getByRole("button", { name: "Continue" });
  await expect(continueButton).toBeDisabled();
  const body = page.locator('[role="textbox"]');
  await body.click();
  await body.fill("Happy birthday Sam — cake on Friday.");
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  // Remix step — renders the non-interactive scripted variant under E2E.
  await page
    .getByText("Remix needs an assistant model", { exact: false })
    .waitFor({ state: "visible", timeout: 15_000 });

  await page.getByRole("button", { name: "Start using Openstyle" }).click();

  // Enhance step (specs/meeting-transcription-v2.md §3.2) — the new final
  // step before /today. Skip it: it must not write the auto-run setting.
  await page.getByTestId("onboarding-enhance-skip").click();
  await page.waitForURL(/\/today/, { timeout: 15_000 });

  // Skip writes ONLY the seen flag — the auto-run key must stay absent
  // (a missing row means "off"). 404 = the row was never created.
  const autoRunStatus = await app!.evaluate(async (_electron, port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/settings/meeting_enhance_auto_run`,
    );
    return res.status as number;
  }, DEFAULT_PORT);
  expect(autoRunStatus).toBe(404);
  const seenStatus = await app!.evaluate(async (_electron, port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/settings/meeting_enhance_prompt_seen`,
    );
    const body = res.ok ? ((await res.json()) as { value: string }) : null;
    return { status: res.status, value: body?.value };
  }, DEFAULT_PORT);
  expect(seenStatus.status).toBe(200);
  expect(seenStatus.value).toBe("true");

  // Practice-target mode must be off once onboarding is done.
  const practiceTarget = await page.evaluate(() =>
    (
      window as unknown as {
        electron: {
          ipcRenderer: { invoke: (channel: string) => Promise<boolean> };
        };
      }
    ).electron.ipcRenderer.invoke("e2e:remix-practice-target"),
  );
  expect(practiceTarget).toBe(false);
});
