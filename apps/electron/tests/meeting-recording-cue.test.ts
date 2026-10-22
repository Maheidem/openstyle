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
// the Meetings card time come from the same start time in main. On a stop,
// the capsule plays its quiet exit before the pill hides, a dictation that
// starts during the exit keeps the pill, and a fallback hides the pill when
// the renderer never ends the exit (issue #288).
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

// The tests share one app and run in order. The last one drops a handler.
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

/**
 * Records, in main, when the pill gets the first status after a stop, when
 * the renderer's `pill:meeting-exit-done` arrives, and when the pill window
 * hides. With `showDictationOnStop`, a dictation takes
 * the pill at once when that status arrives, so it starts during the exit.
 */
async function armPillTrace(showDictationOnStop = false): Promise<void> {
  await app!.evaluate(({ BrowserWindow, ipcMain }, dictation) => {
    const g = globalThis as unknown as {
      __pillTrace: {
        stopAt?: number;
        doneAt?: number;
        hideAt?: number;
        dictation: boolean;
      };
      __pillTraced?: boolean;
    };
    g.__pillTrace = { dictation };
    const w = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes("pill"),
    );
    if (!w || g.__pillTraced) return;
    g.__pillTraced = true;
    // First in line, so it runs before main's own handler hides the pill.
    ipcMain.prependListener("pill:meeting-exit-done", () => {
      g.__pillTrace.doneAt ??= Date.now();
    });
    const hide = w.hide.bind(w);
    w.hide = () => {
      g.__pillTrace.hideAt ??= Date.now();
      hide();
    };
    const wc = w.webContents;
    const send = wc.send.bind(wc);
    wc.send = (channel: string, ...args: unknown[]) => {
      send(channel, ...args);
      if (
        channel === "meeting:status-changed" &&
        args[0] !== "recording" &&
        g.__pillTrace.stopAt === undefined
      ) {
        g.__pillTrace.stopAt = Date.now();
        if (g.__pillTrace.dictation) ipcMain.emit("e2e:pill-show-dictation");
      }
    };
  }, showDictationOnStop);
}

async function pillTrace(): Promise<{
  stopAt?: number;
  doneAt?: number;
  hideAt?: number;
}> {
  return app!.evaluate(
    () =>
      (
        globalThis as unknown as {
          __pillTrace: { stopAt?: number; doneAt?: number; hideAt?: number };
        }
      ).__pillTrace,
  );
}

/** Notes, in the pill page, when the capsule first shows data-exit="quiet". */
async function watchCapsuleExit(pill: Page): Promise<void> {
  await pill.evaluate(() => {
    const g = window as unknown as { __exitAt: number | null };
    g.__exitAt = null;
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="pill-meeting"]');
      if (g.__exitAt === null && el?.getAttribute("data-exit") === "quiet")
        g.__exitAt = Date.now();
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-exit"],
    });
  });
}

async function startMeeting(): Promise<Page> {
  await dashboard
    .getByRole("button", { name: "Start recording" })
    .first()
    .click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("recording");
  await expect.poll(pillVisible, { timeout: 10_000 }).toBe(true);
  const pill = await pillPage();
  await expect(pill.getByTestId("pill-meeting")).toBeVisible({
    timeout: 10_000,
  });
  return pill;
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

  // Stop in the pill stops the recording. The capsule plays the quiet exit
  // first, then the pill hides (issue #288).
  await armPillTrace();
  await watchCapsuleExit(pill);
  await stop.click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("idle");
  await expect.poll(pillVisible, { timeout: 10_000 }).toBe(false);
  const exitAt = await pill.evaluate(
    () => (window as unknown as { __exitAt: number | null }).__exitAt,
  );
  const trace = await pillTrace();
  expect(exitAt).not.toBeNull();
  expect(trace.stopAt).toBeDefined();
  expect(trace.hideAt).toBeDefined();
  const gap = (trace.hideAt ?? 0) - (trace.stopAt ?? 0);
  console.log(
    "MEETING_EXIT_TRACE_MS",
    JSON.stringify({
      exitShown: (exitAt ?? 0) - (trace.stopAt ?? 0),
      done: (trace.doneAt ?? 0) - (trace.stopAt ?? 0),
      hide: gap,
    }),
  );
  // The renderer's message came first, and the hide waited for the exit
  // (QUIET_MS is 120). No upper bound: a slow CI machine can delay timers.
  expect(trace.doneAt).toBeDefined();
  expect(trace.doneAt ?? 0).toBeLessThanOrEqual(trace.hideAt ?? 0);
  expect(gap).toBeGreaterThanOrEqual(120);

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

test("a dictation that starts during the meeting exit keeps the pill", async () => {
  test.setTimeout(90_000);
  const pill = await startMeeting();

  // A real dictation needs the key helper and the mic. The seam gives the
  // pill to a dictation in main, as a hotkey press does, without the mic.
  await armPillTrace(true);
  await pill.getByRole("button", { name: "Stop meeting recording" }).click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("idle");

  // Well past the exit and the fallback, the pill is still up for the
  // dictation, and Escape (registered only for a dictation) is live.
  await pill.waitForTimeout(1_000);
  expect(await pillVisible()).toBe(true);
  expect((await pillTrace()).hideAt).toBeUndefined();
  expect(
    await app!.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered("Escape"),
    ),
  ).toBe(true);

  // The dictation ends: its hide request hides the pill.
  await app!.evaluate(({ ipcMain }) => {
    ipcMain.emit("pill:hide", {});
  });
  await expect.poll(pillVisible, { timeout: 5_000 }).toBe(false);
});

test("screenshots of the capsule during its exit (proof only)", async () => {
  test.skip(!SHOTS_DIR, "Only with OPENSTYLE_PROOF_SHOTS.");
  test.setTimeout(120_000);
  for (const theme of ["light", "dark"] as const) {
    const pill = await startMeeting();
    await pill.evaluate((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    await pill.reload();
    await expect(pill.getByTestId("pill-meeting")).toBeVisible({
      timeout: 10_000,
    });
    await pill.waitForTimeout(500);
    await shot(pill, `2-${theme}-pill-before-stop.png`);
    await pill.getByRole("button", { name: "Stop meeting recording" }).click();
    await pill.waitForSelector(
      '[data-testid="pill-meeting"][data-exit="quiet"]',
      {
        timeout: 2_000,
      },
    );
    // The exit lasts 120 ms, so the shot catches it part way.
    await shot(pill, `2-${theme}-pill-exit.png`).catch(() => {});
    await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("idle");
    await expect.poll(pillVisible, { timeout: 5_000 }).toBe(false);
  }
  const pill = await pillPage();
  await pill.evaluate(() => localStorage.removeItem("theme"));
});

test("the fallback hides the pill when the exit message never comes", async () => {
  test.setTimeout(90_000);
  const pill = await startMeeting();

  // Drop main's handler, so the renderer's message has no effect. Keep this
  // test last: the handler does not come back.
  await app!.evaluate(({ ipcMain }) => {
    ipcMain.removeAllListeners("pill:meeting-exit-done");
  });
  await armPillTrace();
  await pill.getByRole("button", { name: "Stop meeting recording" }).click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("idle");
  await expect.poll(pillVisible, { timeout: 5_000 }).toBe(false);
  const trace = await pillTrace();
  const gap = (trace.hideAt ?? 0) - (trace.stopAt ?? 0);
  console.log("MEETING_EXIT_FALLBACK_GAP_MS", gap);
  expect(trace.doneAt).toBeUndefined();
  expect(gap).toBeGreaterThanOrEqual(290);
});
