import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
// Pause and resume of a meeting recording (specs/meeting-mode.md, "Pause and
// resume"). The user records, pauses in the pill, the Meetings page and the
// tray popover, resumes, and stops. A pause closes the capture, so the saved
// meeting holds recorded time only. The Meetings page, the pill and the tray
// popover show a clear Paused state.
//
// The app runs with the E2E fake capture (OPENSTYLE_E2E_FAKE_MEETING_CAPTURE).
// It writes silence and opens no mic, no system audio and no native helper,
// so no macOS privacy dialog can appear. The real mic capture is proved in
// the recorder unit tests with a fake helper, and by hand on a Mac.
//
// Set OPENSTYLE_PROOF_SHOTS=<dir> to save light and dark screenshots of the
// Paused state in <dir>. CI does not set it.
// ---------------------------------------------------------------------------

const SHOTS_DIR = process.env.OPENSTYLE_PROOF_SHOTS;

test.describe.configure({ mode: "serial" });

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

function auxPage(name: "pill" | "tray-popover"): Page {
  const page = app!.windows().find((w) => w.url().includes(name));
  if (!page) throw new Error(`The ${name} window does not exist`);
  return page;
}

async function windowVisible(name: "pill" | "tray-popover"): Promise<boolean> {
  return app!.evaluate(({ BrowserWindow }, part) => {
    return BrowserWindow.getAllWindows().some(
      (w) => w.webContents.getURL().includes(part) && w.isVisible(),
    );
  }, name);
}

async function meetingStatus(): Promise<{
  status: string;
  meetingId: string | null;
  pausedAt: number | null;
}> {
  return dashboard.evaluate(() => window.api.getMeetingStatus());
}

/** The tray look that main shows now (E2E-only IPC). */
async function trayIcon(): Promise<string> {
  return dashboard.evaluate(async () => {
    const look = (await window.electron.ipcRenderer.invoke(
      "e2e:tray-appearance",
    )) as { icon: string };
    return look.icon;
  });
}

async function openPopover(): Promise<Page> {
  if (!(await windowVisible("tray-popover"))) {
    await app!.evaluate(({ ipcMain }) => {
      ipcMain.emit("e2e:tray-popover-toggle");
    });
  }
  await expect.poll(() => windowVisible("tray-popover")).toBe(true);
  const page = auxPage("tray-popover");
  await expect(page.getByTestId("tray-popover-version")).toContainText(
    "Openstyle",
    { timeout: 10_000 },
  );
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(SHOTS_DIR, name) });
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((value) => localStorage.setItem("theme", value), theme);
  await page.reload();
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-pause-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  app = await launchOpenstyle({
    userDataDir,
    env: {
      OPENSTYLE_E2E_FAKE_MEETING_CAPTURE: "1",
      OPENSTYLE_E2E_TRAY: "1",
    },
  });
  dashboard = await waitForDashboardWindow(app, 15_000);
  await dashboard.waitForLoadState("load");
  // The boot sweep of orphans runs 3 s after the start. A recording that
  // starts before it is marked "interrupted".
  await dashboard.waitForTimeout(6_000);
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

interface MeetingRow {
  id: string;
  status: string;
  duration_ms: number | null;
  audio_dir: string | null;
}

async function listMeetings(): Promise<MeetingRow[]> {
  const res = await fetch(`${embeddedServerUrl(app!)}/api/meetings`);
  expect(res.ok).toBe(true);
  return ((await res.json()) as { items: MeetingRow[] }).items;
}

/** The seconds of a 16 kHz mono PCM16 WAV file. */
function wavSeconds(path: string): number {
  return (statSync(path).size - 44) / 32_000;
}

test("pause in the pill and the Meetings page, resume, stop: the saved meeting holds recorded time only", async () => {
  test.setTimeout(150_000);

  await dashboard.getByRole("link", { name: "Meetings" }).click();
  await dashboard.waitForURL(/\/meetings/);
  const startedWall = Date.now();
  await dashboard
    .getByRole("button", { name: "Start recording" })
    .first()
    .click();
  await expect
    .poll(async () => (await meetingStatus()).status, { timeout: 15_000 })
    .toBe("recording");
  const meetingId = (await meetingStatus()).meetingId as string;
  await expect
    .poll(() => windowVisible("pill"), { timeout: 10_000 })
    .toBe(true);
  const pill = auxPage("pill");
  const capsule = pill.getByTestId("pill-meeting");
  await expect(capsule).toBeVisible({ timeout: 10_000 });
  await expect(capsule).toHaveAttribute("data-paused", "false");
  expect(await trayIcon()).toBe("recording");

  // Record about 3 s.
  const pillElapsed = pill.getByTestId("pill-meeting-elapsed");
  await expect
    .poll(async () => seconds(await pillElapsed.innerText()), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(3);

  // --- Pause in the pill ---------------------------------------------------
  const pausedWall = Date.now();
  await pill.getByRole("button", { name: "Pause meeting recording" }).click();
  await expect(capsule).toHaveAttribute("data-paused", "true", {
    timeout: 10_000,
  });
  await expect(pill.getByTestId("pill-meeting-paused")).toHaveText("Paused");
  // The status is still "recording" (the guards, the quit and the update
  // flow use it), and the row is not paused.
  const during = await meetingStatus();
  expect(during.status).toBe("recording");
  expect(during.pausedAt).not.toBeNull();
  // The tray icon is not the red recording icon: the mic is closed.
  expect(await trayIcon()).toBe("default");

  // The Meetings page shows Paused and the same frozen time.
  const state = dashboard.getByTestId("meeting-recording-state");
  await expect(state).toHaveText("Paused");
  await expect(state).toHaveAttribute("data-paused", "true");
  await expect(dashboard.getByTestId("meeting-paused-hint")).toBeVisible();
  const cardElapsed = dashboard.getByTestId("meeting-recording-elapsed");
  const frozen = await cardElapsed.innerText();
  expect(await pillElapsed.innerText()).toBe(frozen);

  // The tray popover shows Paused too.
  const popover = await openPopover();
  const recordingCard = popover.getByTestId("tray-popover-recording");
  await expect(recordingCard).toHaveAttribute("data-paused", "true");
  await expect(popover.getByTestId("tray-popover-paused")).toHaveText("Paused");
  await expect(popover.getByTestId("tray-popover-status")).toHaveAttribute(
    "data-status",
    "paused",
  );
  expect(await popover.getByTestId("tray-popover-elapsed").innerText()).toBe(
    frozen,
  );

  if (SHOTS_DIR) {
    for (const theme of ["light", "dark"] as const) {
      await setTheme(pill, theme);
      await expect(pill.getByTestId("pill-meeting-paused")).toBeVisible();
      await setTheme(dashboard, theme);
      await expect(dashboard.getByTestId("meeting-recording-state")).toHaveText(
        "Paused",
      );
      await setTheme(popover, theme);
      await expect(popover.getByTestId("tray-popover-paused")).toBeVisible();
      await pill.waitForTimeout(500);
      await shot(pill, `pill-paused-${theme}.png`);
      await shot(dashboard, `meetings-paused-${theme}.png`);
      await shot(popover, `popover-paused-${theme}.png`);
    }
    for (const page of [pill, dashboard, popover]) {
      await page.evaluate(() => localStorage.removeItem("theme"));
      await page.reload();
    }
    await expect(dashboard.getByTestId("meeting-recording-state")).toHaveText(
      "Paused",
    );
  }

  // The clock stays still while paused (4 s).
  await dashboard.waitForTimeout(4_000);
  expect(await cardElapsed.innerText()).toBe(frozen);
  expect(await pillElapsed.innerText()).toBe(frozen);

  // --- Resume on the Meetings page ----------------------------------------
  await dashboard.getByTestId("meeting-pause-toggle").click();
  const resumedWall = Date.now();
  await expect(state).toHaveText("Recording", { timeout: 10_000 });
  await expect(capsule).toHaveAttribute("data-paused", "false");
  await expect(pill.getByTestId("pill-meeting-paused")).toHaveCount(0);
  expect((await meetingStatus()).pausedAt).toBeNull();
  expect(await trayIcon()).toBe("recording");
  // The clock goes on from the frozen time, not from the wall clock.
  const afterResume = seconds(await cardElapsed.innerText());
  expect(afterResume - seconds(frozen)).toBeLessThanOrEqual(3);
  await expect
    .poll(async () => seconds(await cardElapsed.innerText()), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(seconds(frozen) + 3);

  // --- Stop in the pill ----------------------------------------------------
  await pill.getByRole("button", { name: "Stop meeting recording" }).click();
  const stoppedWall = Date.now();
  await expect
    .poll(async () => (await meetingStatus()).status, { timeout: 15_000 })
    .toBe("idle");

  const meeting = (await listMeetings()).find((m) => m.id === meetingId);
  expect(meeting).toBeDefined();
  // Stop queues the full pass (PR #420), so the meeting leaves "recorded".
  expect(["transcribing", "failed", "transcribed"]).toContain(meeting?.status);

  // The saved length is the wall time without the paused time.
  const pausedMs = resumedWall - pausedWall;
  const expectedMs = stoppedWall - startedWall - pausedMs;
  expect(pausedMs).toBeGreaterThanOrEqual(4_000);
  const duration = meeting?.duration_ms ?? 0;
  expect(Math.abs(duration - expectedMs)).toBeLessThan(3_000);
  expect(duration).toBeLessThan(stoppedWall - startedWall - 3_500);

  // The files hold recorded time only, and both tracks have the same length.
  const dir = meeting?.audio_dir as string;
  const mic = wavSeconds(join(dir, "mic.wav"));
  const system = wavSeconds(join(dir, "system.wav"));
  expect(Math.abs(mic - system)).toBeLessThan(0.05);
  expect(Math.abs(mic * 1000 - duration)).toBeLessThan(2_500);
  const journal = JSON.parse(readFileSync(join(dir, "sync.json"), "utf8")) as {
    epochs: { reason: string }[];
    micSamples: number;
    systemSamples: number;
  };
  expect(journal.epochs.map((e) => e.reason)).toEqual([
    "start",
    "pause",
    "resume",
  ]);
  expect(journal.micSamples).toBe(journal.systemSamples);
});

test("pause in the tray popover, then stop while paused: the recording is saved", async () => {
  test.setTimeout(90_000);
  const popover = await openPopover();
  await popover
    .getByRole("button", { name: "Start meeting recording" })
    .click();
  await expect
    .poll(async () => (await meetingStatus()).status, { timeout: 15_000 })
    .toBe("recording");
  const meetingId = (await meetingStatus()).meetingId as string;
  const startedWall = Date.now();

  await expect(popover.getByTestId("tray-popover-recording")).toBeVisible();
  await popover.waitForTimeout(2_500);
  await popover
    .getByRole("button", { name: "Pause meeting recording" })
    .click();
  await expect(popover.getByTestId("tray-popover-paused")).toBeVisible({
    timeout: 10_000,
  });
  const pausedWall = Date.now();
  await popover.waitForTimeout(3_500);

  // The popover button says Resume now.
  await expect(
    popover.getByRole("button", { name: "Resume meeting recording" }),
  ).toBeVisible();

  // Stop while paused.
  await popover.getByRole("button", { name: "Stop meeting recording" }).click();
  const stoppedWall = Date.now();
  await expect
    .poll(async () => (await meetingStatus()).status, { timeout: 15_000 })
    .toBe("idle");

  const meeting = (await listMeetings()).find((m) => m.id === meetingId);
  expect(["transcribing", "failed", "transcribed"]).toContain(meeting?.status);
  // About 2.5 s were recorded. The 3.5 s pause is not in the length.
  const duration = meeting?.duration_ms ?? 0;
  const expectedMs = pausedWall - startedWall;
  expect(Math.abs(duration - expectedMs)).toBeLessThan(2_500);
  expect(duration).toBeLessThan(stoppedWall - startedWall - 3_000);
});
