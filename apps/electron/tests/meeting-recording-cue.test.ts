import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Meeting recording cue (issue #253): while a meeting records, the pill
// shows the Recording state (live dot, elapsed time, Stop). The pill time and
// the Meetings card time come from the same start time in main.
//
// The app runs with the E2E fake capture (OPENSTYLE_E2E_FAKE_MEETING_CAPTURE,
// src/main/fake-meeting-capture.ts). It writes silence and opens no mic, no
// system audio and no native helper, so this spec is safe on a developer Mac
// and runs on the Linux CI job.
//
// Set OPENSTYLE_PROOF_SHOTS=<dir> to save screenshots of the pill and the
// Meetings card in <dir>. CI does not set it.
// ---------------------------------------------------------------------------

const SHOTS_DIR = process.env.OPENSTYLE_PROOF_SHOTS;

let app: ElectronApplication | undefined;
let dashboard: Page;
let userDataDir: string;

/** "m:ss" or "h:mm:ss" to seconds. */
function seconds(label: string): number {
  return label
    .trim()
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}

async function pillPage(): Promise<Page> {
  const page = app!.windows().find((w) => w.url().includes("pill"));
  if (!page) throw new Error("The pill window does not exist");
  return page;
}

/** True when the main process shows the pill window. */
async function pillVisible(): Promise<boolean> {
  return app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => w.webContents.getURL().includes("pill") && w.isVisible(),
    ),
  );
}

async function meetingStatus(): Promise<string> {
  return dashboard.evaluate(
    async () => (await window.api.getMeetingStatus()).status,
  );
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, name) });
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-recording-cue-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  // Flags are server-owned and live in config.freestyle.json next to the DB.
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  app = await launchOpenstyle({
    userDataDir,
    env: { OPENSTYLE_E2E_FAKE_MEETING_CAPTURE: "1" },
  });
  dashboard = await waitForDashboardWindow(app, 15_000);
  await dashboard.waitForLoadState("load");
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

test("the pill shows the meeting Recording state and its Stop ends the meeting", async () => {
  test.setTimeout(90_000);

  await dashboard.getByRole("link", { name: "Meetings" }).click();
  await dashboard.waitForURL(/\/meetings/);
  expect(await pillVisible()).toBe(false);

  // Start the recording the way a user does.
  await dashboard
    .getByRole("button", { name: "Start recording" })
    .first()
    .click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("recording");

  // The pill is shown in the Recording state.
  await expect.poll(pillVisible, { timeout: 10_000 }).toBe(true);
  const pill = await pillPage();
  const capsule = pill.getByTestId("pill-meeting");
  await expect(capsule).toBeVisible({ timeout: 10_000 });
  await expect(capsule.locator(".pill-live-dot")).toBeVisible();
  const stop = pill.getByRole("button", { name: "Stop meeting recording" });
  await expect(stop).toBeVisible();

  // The elapsed time advances.
  const pillElapsed = pill.getByTestId("pill-meeting-elapsed");
  await expect
    .poll(async () => seconds(await pillElapsed.innerText()), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(3);

  // The Meetings card and the pill show the same time (within 1 s).
  const cardElapsed = dashboard.getByTestId("meeting-recording-elapsed");
  await expect(cardElapsed).toBeVisible();
  const [pillTime, cardTime] = await Promise.all([
    pillElapsed.innerText(),
    cardElapsed.innerText(),
  ]);
  expect(Math.abs(seconds(pillTime) - seconds(cardTime))).toBeLessThanOrEqual(
    1,
  );

  await shot(pill, "pill-recording.png");
  await shot(dashboard, "meetings-card-recording.png");

  // The end of a dictation hides the pill. During a meeting, the pill stays
  // up and shows the Recording state again. A real dictation needs the key
  // helper and the mic, so this sends only the renderer's hide request.
  await app!.evaluate(({ ipcMain }) => {
    ipcMain.emit("pill:hide", {});
  });
  expect(await pillVisible()).toBe(true);
  await expect(capsule).toBeVisible();

  // Stop in the pill stops the recording and hides the pill.
  await stop.click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("idle");
  await expect.poll(pillVisible, { timeout: 10_000 }).toBe(false);

  const res = await fetch(`${embeddedServerUrl(app!)}/api/meetings`);
  expect(res.ok).toBe(true);
  const { items } = (await res.json()) as {
    items: { status: string; duration_ms: number | null }[];
  };
  expect(items).toHaveLength(1);
  expect(items[0].status).toBe("recorded");
  // The clock rounds to the nearest second, so "0:03" means 2.5 s or more.
  expect(items[0].duration_ms ?? 0).toBeGreaterThanOrEqual(2_500);
});
