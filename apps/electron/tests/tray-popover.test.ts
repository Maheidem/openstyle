import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import {
  type Answer,
  bootEnhanceApp,
  type ChatRequest,
  defaultSegments,
  type EnhanceApp,
  FakeLlm,
  RIGHT_WORD,
  seedMeeting,
  WRONG_WORD,
} from "./helpers/enhance-fixture";

// ---------------------------------------------------------------------------
// Tray popover, step 1 (issue #317). A left click on the tray icon toggles a
// small panel: header with the hotkey, meeting Start/Stop with the live time,
// the last 3 dictations with Copy, and a footer with the version.
//
// OPENSTYLE_E2E_TRAY=1 makes the tray and the popover in quiet E2E mode
// (macOS). The E2E-only IPC "e2e:tray-popover-toggle" does what a left click
// on the icon does. The meeting uses the fake capture
// (OPENSTYLE_E2E_FAKE_MEETING_CAPTURE): no mic, no system audio, no helper.
// Linux CI is not in quiet mode and makes the tray as usual.
//
// Set OPENSTYLE_PROOF_SHOTS=<dir> to save light and dark screenshots of each
// popover state in <dir>. CI does not set it.
// ---------------------------------------------------------------------------

const SHOTS_DIR = process.env.OPENSTYLE_PROOF_SHOTS;
const APP_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as {
    version: string;
  }
).version;
const MAC = process.platform === "darwin";

test.describe.configure({ mode: "serial" });

let app: ElectronApplication | undefined;
let dashboard: Page;
let userDataDir: string;

// Fictional dictations, newest first. The popover shows the first three.
const DICTATIONS = [
  "Send the invoice to Accounting by end of day and copy Dana on the thread so she can approve it.",
  "Can we move the design review with Priya to Thursday afternoon? She is out on Wednesday, and I want her feedback on the onboarding flow first.",
  "Draft a short reply that thanks the team for the release notes and asks for the rollout dates.",
  "Book a room for the quarterly planning session next Tuesday morning.",
];

/** "m:ss" or "h:mm:ss" to seconds. */
function seconds(label: string): number {
  return label
    .trim()
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}

function popoverPage(): Page {
  const page = app!.windows().find((w) => w.url().includes("tray-popover"));
  if (!page) throw new Error("The tray popover window does not exist");
  return page;
}

async function popoverVisible(): Promise<boolean> {
  return app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => w.webContents.getURL().includes("tray-popover") && w.isVisible(),
    ),
  );
}

/** The same as a left click on the tray icon. */
async function toggle(): Promise<void> {
  await app!.evaluate(({ ipcMain }) => {
    ipcMain.emit("e2e:tray-popover-toggle");
  });
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
  if (!(await popoverVisible())) await toggle();
  await expect.poll(popoverVisible, { timeout: 10_000 }).toBe(true);
  const page = popoverPage();
  await expect(page.getByTestId("tray-popover-version")).toContainText(
    "Openstyle",
    { timeout: 10_000 },
  );
  return page;
}

async function meetingStatus(): Promise<string> {
  return dashboard.evaluate(
    async () => (await window.api.getMeetingStatus()).status,
  );
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  // No hover look on the last button that was clicked.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(SHOTS_DIR, name) });
}

function seedHistory(): void {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const insert = db.prepare(
      `INSERT INTO transcription_history
         (raw_text, cleaned_text, voice_provider, voice_model, duration_ms, created_at)
       VALUES (?, ?, 'mlx', 'qwen3-asr', 4200, ?)`,
    );
    // Oldest first, so the newest row has the highest id and time.
    [...DICTATIONS].reverse().forEach((text, i) => {
      const at = new Date(Date.now() - (DICTATIONS.length - i) * 7 * 60_000);
      const sqlTime = at.toISOString().slice(0, 19).replace("T", " ");
      insert.run(text, text, sqlTime);
    });
  } finally {
    db.close();
  }
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-tray-popover-"));
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
      OPENSTYLE_E2E_FAKE_CALENDAR: "1",
      OPENSTYLE_E2E_TRAY: "1",
    },
  });
  dashboard = await waitForDashboardWindow(app, 15_000);
  await dashboard.waitForLoadState("load");
  seedHistory();
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

test("a toggle shows the popover with the header, the hotkey and Start", async () => {
  expect(await popoverVisible()).toBe(false);
  const popover = await openPopover();

  // The window can never take focus.
  expect(
    await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("tray-popover"))
        ?.isFocusable(),
    ),
  ).toBe(false);

  await expect(popover.getByText("Openstyle", { exact: true })).toBeVisible();
  const hotkey = popover.getByTestId("tray-popover-hotkey");
  if (MAC) await expect(hotkey).toHaveText("Hold \u2303\u2325 to dictate");
  else await expect(hotkey).toHaveText(/^Hold \S+ to dictate$/);
  await expect(popover.getByTestId("tray-popover-status")).toHaveText("Ready");
  await expect(
    popover.getByRole("button", { name: "Start meeting recording" }),
  ).toBeVisible();
  // The Openstyle version from package.json, never the Electron version.
  await expect(popover.getByTestId("tray-popover-version")).toHaveText(
    `Openstyle ${APP_VERSION} · Up to date`,
  );
  for (const name of ["Open Openstyle", "Settings", "Quit Openstyle"]) {
    await expect(popover.getByRole("button", { name })).toBeVisible();
  }
});

test("the first toggle makes the popover window and shows it when the window does not exist yet", async () => {
  // Linux makes the window on the first toggle only (menus.ts). Remove the
  // window, so this platform takes the same path: the toggle makes the
  // window, and the show waits for the end of the page load.
  if (await popoverVisible()) await toggle();
  await app!.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().includes("tray-popover")) w.destroy();
    }
  });
  await expect
    .poll(() => app!.windows().some((w) => w.url().includes("tray-popover")))
    .toBe(false);
  await toggle();
  await expect.poll(popoverVisible, { timeout: 10_000 }).toBe(true);
  await expect(popoverPage().getByTestId("tray-popover-version")).toContainText(
    "Openstyle",
    { timeout: 10_000 },
  );
  await toggle();
  await expect.poll(popoverVisible).toBe(false);
});

test("the last 3 dictations show newest first, and Copy writes the clipboard in main", async () => {
  const popover = await openPopover();
  const rows = popover.getByTestId("tray-popover-dictation");
  await expect(rows).toHaveCount(3, { timeout: 10_000 });
  for (let i = 0; i < 3; i++) {
    await expect(rows.nth(i)).toContainText(DICTATIONS[i]);
  }

  // Keep what the person at the screen has on the clipboard, and put it back.
  await app!.evaluate(({ clipboard }) => {
    (globalThis as unknown as { __clip: unknown }).__clip = {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      image: clipboard.readImage(),
    };
  });
  try {
    await rows.nth(1).getByRole("button", { name: "Copy dictation" }).click();
    await expect
      .poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(DICTATIONS[1]);
    await expect(
      popover.getByRole("status").getByText("Copied"),
    ).toBeAttached();
  } finally {
    await app!.evaluate(({ clipboard }) => {
      const saved = (
        globalThis as unknown as {
          __clip: { text: string; html: string; image: Electron.NativeImage };
        }
      ).__clip;
      clipboard.clear();
      clipboard.write({
        text: saved.text,
        html: saved.html || undefined,
        image: saved.image.isEmpty() ? undefined : saved.image,
      });
    });
  }

  // A new dictation refreshes the list (the pill sends transcription:done).
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    db.prepare(
      `INSERT INTO transcription_history
         (raw_text, cleaned_text, voice_provider, voice_model, created_at)
       VALUES (?, ?, 'mlx', 'qwen3-asr', ?)`,
    ).run(
      "Remind me to water the plants.",
      "Remind me to water the plants.",
      now,
    );
  } finally {
    db.close();
  }
  await app!.evaluate(({ ipcMain }) => {
    ipcMain.emit("transcription:done", {});
  });
  await expect(rows.first()).toContainText("Remind me to water the plants.", {
    timeout: 10_000,
  });
});

test("the popover never takes focus when its Copy and Start buttons are clicked", async () => {
  test.setTimeout(90_000);
  // A separate window stands for the app that the user dictates into.
  await app!.evaluate(({ app: electronApp, BrowserWindow }, quiet) => {
    const g = globalThis as unknown as {
      __probe: Electron.BrowserWindow;
      __focusLog: string[];
    };
    g.__focusLog = [];
    const probe = new BrowserWindow({ width: 320, height: 200, show: false });
    g.__probe = probe;
    void probe.loadURL("data:text/html,<title>focus-probe</title>");
    // Quiet E2E (macOS): focus would take the keyboard from the person at
    // the screen, so the probe is not focused there.
    if (!quiet) {
      probe.show();
      probe.focus();
    }
    const popover = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("tray-popover"),
    );
    popover?.on("focus", () => g.__focusLog.push("popover-focus"));
    electronApp.on("browser-window-focus", (_e, w) =>
      g.__focusLog.push(w === popover ? "popover" : `window ${w.id}`),
    );
  }, MAC);

  const focusState = (): Promise<{
    focused: number | null;
    probe: number;
    popoverFocused: boolean;
    log: string[];
  }> =>
    app!.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as {
        __probe: Electron.BrowserWindow;
        __focusLog: string[];
      };
      const popover = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("tray-popover"),
      );
      return {
        focused: BrowserWindow.getFocusedWindow()?.id ?? null,
        probe: g.__probe.id,
        popoverFocused: popover?.isFocused() ?? false,
        log: g.__focusLog,
      };
    });

  // On a platform that allows it, wait until the probe has focus.
  let probeHasFocus = false;
  if (!MAC) {
    const deadline = Date.now() + 5_000;
    while (!probeHasFocus && Date.now() < deadline) {
      const now = await focusState();
      probeHasFocus = now.focused === now.probe;
      if (!probeHasFocus) await new Promise((r) => setTimeout(r, 200));
    }
    if (!probeHasFocus) {
      console.log("FOCUS_PROOF the probe window got no focus on this display");
    }
  }
  const before = await focusState();

  const popover = await openPopover();
  await popover
    .getByTestId("tray-popover-dictation")
    .first()
    .getByRole("button", { name: "Copy dictation" })
    .click();
  await popover
    .getByRole("button", { name: "Start meeting recording" })
    .click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("recording");
  await expect.poll(trayIcon).toBe("recording");

  const after = await focusState();
  console.log("FOCUS_PROOF", JSON.stringify({ before, after, probeHasFocus }));
  expect(after.popoverFocused).toBe(false);
  expect(after.log).not.toContain("popover");
  expect(after.log).not.toContain("popover-focus");
  if (probeHasFocus) expect(after.focused).toBe(after.probe);
  // Quiet E2E: no Openstyle window had focus before, and none has it now.
  if (MAC) expect([before.focused, after.focused]).toEqual([null, null]);

  // The recording card shows the live time, and it advances.
  const elapsed = popover.getByTestId("tray-popover-elapsed");
  await expect(elapsed).toBeVisible();
  await expect
    .poll(async () => seconds(await elapsed.innerText()), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3);
  await expect(popover.getByTestId("tray-popover-status")).toHaveText(
    "Recording",
  );

  // Stop ends the meeting, and Start comes back.
  await popover.getByRole("button", { name: "Stop meeting recording" }).click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("idle");
  await expect(
    popover.getByRole("button", { name: "Start meeting recording" }),
  ).toBeVisible();
  expect((await focusState()).popoverFocused).toBe(false);

  const res = await fetch(`${embeddedServerUrl(app!)}/api/meetings`);
  const { items } = (await res.json()) as { items: { status: string }[] };
  expect(items).toHaveLength(1);
  expect(items[0].status).toBe("recorded");

  await app!.evaluate(() => {
    (
      globalThis as unknown as { __probe: Electron.BrowserWindow }
    ).__probe.destroy();
  });
});

test("Escape and a second toggle close the popover", async () => {
  await openPopover();
  // The popover holds Escape only while it shows.
  expect(
    await app!.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered("Escape"),
    ),
  ).toBe(true);
  await popoverPage().keyboard.press("Escape");
  await expect.poll(popoverVisible, { timeout: 5_000 }).toBe(false);
  expect(
    await app!.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered("Escape"),
    ),
  ).toBe(false);

  await openPopover();
  await toggle();
  await expect.poll(popoverVisible, { timeout: 5_000 }).toBe(false);
});

test("History opens the Transcriptions page and closes the popover", async () => {
  const popover = await openPopover();
  await popover.getByRole("button", { name: "History" }).click();
  await expect.poll(popoverVisible, { timeout: 5_000 }).toBe(false);
  const main = await waitForDashboardWindow(app!, 10_000);
  await expect.poll(() => main.url(), { timeout: 10_000 }).toContain("/today");
});

// ---------------------------------------------------------------------------
// Step 3: "Next event" and "Record when it starts". OPENSTYLE_E2E_FAKE_CALENDAR
// gives the calendar helpers fictional events with no EventKit call. The
// E2E-only IPC "e2e:fake-calendar-set" replaces them. The calendar setting is
// on only for these tests.
// ---------------------------------------------------------------------------

const PLANNING = {
  id: "e2e-quarterly-planning",
  title: "Quarterly planning review",
};

async function setCalendar(on: boolean): Promise<void> {
  const res = await fetch(
    `${embeddedServerUrl(app!)}/api/settings/calendar_enabled`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: on ? "true" : "false" }),
    },
  );
  expect(res.ok, "PUT /api/settings/calendar_enabled").toBe(true);
}

/** One event that starts in `inMs`, and the planning review later today. */
async function setEvents(id: string, title: string, inMs: number) {
  const now = Date.now();
  const events = [
    { id, title, start: now + inMs, end: now + inMs + 30 * 60_000 },
    {
      ...PLANNING,
      start: now + 229 * 60_000,
      end: now + 259 * 60_000,
    },
  ];
  await app!.evaluate(({ ipcMain }, list) => {
    ipcMain.emit("e2e:fake-calendar-set", {}, list);
  }, events);
  return events[0];
}

/** Hide and show the popover, so it reads the calendar again. */
async function reopenPopover(): Promise<Page> {
  if (await popoverVisible()) await toggle();
  await expect.poll(popoverVisible).toBe(false);
  return openPopover();
}

async function listMeetings(): Promise<{ id: string; status: string }[]> {
  const res = await fetch(`${embeddedServerUrl(app!)}/api/meetings`);
  return ((await res.json()) as { items: never[] }).items;
}

/** The id of the calendar event that a meeting links, or null. */
async function linkedEventId(meetingId: string | null): Promise<string | null> {
  const res = await fetch(
    `${embeddedServerUrl(app!)}/api/meetings/${meetingId}`,
  );
  const body = (await res.json()) as { calendar: { id: string } | null };
  return body.calendar?.id ?? null;
}

async function pillShowsRecording(): Promise<boolean> {
  const pill = app!.windows().find((w) => w.url().includes("pill"));
  if (!pill) return false;
  const shown = await app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => w.webContents.getURL().includes("pill") && w.isVisible(),
    ),
  );
  return shown && (await pill.getByTestId("pill-meeting").isVisible());
}

async function stopMeeting(popover: Page): Promise<void> {
  await popover.getByRole("button", { name: "Stop meeting recording" }).click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("idle");
}

/** Light and dark shots of the popover, for the step-3 proof. */
async function themedShots(
  popover: Page,
  name: string,
  ready: () => Promise<void>,
): Promise<void> {
  if (!SHOTS_DIR) return;
  for (const theme of ["light", "dark"] as const) {
    await popover.evaluate((v) => localStorage.setItem("theme", v), theme);
    await popover.reload();
    await ready();
    await popover.waitForTimeout(400);
    await shot(popover, `${name}-${theme}.png`);
  }
  await popover.evaluate(() => localStorage.removeItem("theme"));
  await popover.reload();
  await ready();
}

test("the Next event card shows the next event of today", async () => {
  await setCalendar(true);
  await setEvents("e2e-roadmap-check-in", "Roadmap check-in", 90_000);
  const popover = await reopenPopover();
  const card = popover.getByTestId("tray-popover-next-event");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(popover.getByTestId("tray-popover-event-title")).toHaveText(
    "Roadmap check-in",
  );
  await expect(popover.getByTestId("tray-popover-event-time")).toHaveText(
    /^\S+.* – \S+.* · in 2 min$/,
  );
  await expect(
    popover.getByRole("button", { name: "Record Roadmap check-in now" }),
  ).toBeVisible();
  const toggleArm = popover.getByRole("switch", {
    name: "Record Roadmap check-in when it starts",
  });
  await expect(toggleArm).not.toBeChecked();
  await themedShots(popover, "1-next-event", async () => {
    await expect(popover.getByTestId("tray-popover-event-title")).toBeVisible({
      timeout: 10_000,
    });
  });
});

test("Record on the card starts a meeting now with the event linked", async () => {
  const popover = await reopenPopover();
  const before = (await listMeetings()).length;
  await popover
    .getByRole("button", { name: "Record Roadmap check-in now" })
    .click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("recording");
  const meetings = await listMeetings();
  expect(meetings).toHaveLength(before + 1);
  const { meetingId } = await dashboard.evaluate(() =>
    window.api.getMeetingStatus(),
  );
  expect(meetings.some((m) => m.id === meetingId)).toBe(true);
  expect(await linkedEventId(meetingId)).toBe("e2e-roadmap-check-in");
  await stopMeeting(popover);
});

test("Record when it starts starts the meeting at the event start, linked, with the pill", async () => {
  test.setTimeout(90_000);
  const event = await setEvents("e2e-design-standup", "Design standup", 9_000);
  const popover = await reopenPopover();
  const before = (await listMeetings()).length;
  await popover
    .getByRole("switch", { name: "Record Design standup when it starts" })
    .click();
  await expect(popover.getByTestId("tray-popover-armed")).toHaveText(
    /^Recording will start at /,
  );
  await expect(
    popover.getByRole("status").filter({ hasText: "Recording will start at" }),
  ).toBeAttached();
  await themedShots(popover, "2-armed", async () => {
    await expect(popover.getByTestId("tray-popover-armed")).toBeVisible({
      timeout: 10_000,
    });
  });
  // Nothing starts before the event.
  expect(await meetingStatus()).toBe("idle");

  await expect
    .poll(meetingStatus, { timeout: event.start - Date.now() + 40_000 })
    .toBe("recording");
  const startedAt = Date.now();
  console.log("AUTO_START_DELAY_MS", startedAt - event.start);
  expect(startedAt).toBeGreaterThanOrEqual(event.start);
  const meetings = await listMeetings();
  expect(meetings).toHaveLength(before + 1);
  const { meetingId } = await dashboard.evaluate(() =>
    window.api.getMeetingStatus(),
  );
  expect(await linkedEventId(meetingId)).toBe("e2e-design-standup");
  await expect.poll(pillShowsRecording, { timeout: 10_000 }).toBe(true);
  // The arm is cleared when the event starts.
  await expect(popover.getByTestId("tray-popover-armed")).toHaveCount(0, {
    timeout: 10_000,
  });
  await themedShots(popover, "3-auto-started", async () => {
    await expect(popover.getByTestId("tray-popover-elapsed")).toBeVisible({
      timeout: 10_000,
    });
  });
  await stopMeeting(popover);
});

test("a disarmed watch starts nothing", async () => {
  test.setTimeout(60_000);
  const event = await setEvents("e2e-budget-sync", "Budget sync", 6_000);
  const popover = await reopenPopover();
  const before = (await listMeetings()).length;
  const arm = popover.getByRole("switch", {
    name: "Record Budget sync when it starts",
  });
  await arm.click();
  await expect(arm).toBeChecked();
  await arm.click();
  await expect(arm).not.toBeChecked();
  await expect(popover.getByTestId("tray-popover-armed")).toHaveCount(0);
  // Wait past the start time.
  await popover.waitForTimeout(event.start - Date.now() + 4_000);
  expect(await meetingStatus()).toBe("idle");
  expect(await listMeetings()).toHaveLength(before);
});

test("the card shows the armed event, also when an earlier event comes first", async () => {
  const now = Date.now();
  const planning = {
    ...PLANNING,
    start: now + 229 * 60_000,
    end: now + 259 * 60_000,
  };
  const emit = (list: object[]) =>
    app!.evaluate(({ ipcMain }, events) => {
      ipcMain.emit("e2e:fake-calendar-set", {}, events);
    }, list);
  await emit([planning]);
  let popover = await reopenPopover();
  const arm = () =>
    popover.getByRole("switch", {
      name: "Record Quarterly planning review when it starts",
    });
  await arm().click();
  await expect(arm()).toBeChecked();

  // A new event comes before the armed one.
  await emit([
    {
      id: "e2e-early-sync",
      title: "Early sync",
      start: now + 10 * 60_000,
      end: now + 40 * 60_000,
    },
    planning,
  ]);
  popover = await reopenPopover();
  await expect(popover.getByTestId("tray-popover-event-title")).toHaveText(
    PLANNING.title,
    { timeout: 10_000 },
  );
  await expect(arm()).toBeChecked();
  await expect(popover.getByTestId("tray-popover-armed")).toBeVisible();
  await themedShots(popover, "2-armed-later", async () => {
    await expect(popover.getByTestId("tray-popover-armed")).toBeVisible({
      timeout: 10_000,
    });
  });
  // Disarm: the card goes back to the first event that comes.
  await arm().click();
  await expect(popover.getByTestId("tray-popover-armed")).toHaveCount(0);
  await expect(popover.getByTestId("tray-popover-event-title")).toHaveText(
    "Early sync",
  );
});

test("the start time does nothing while a meeting already records", async () => {
  test.setTimeout(60_000);
  const popover = await reopenPopover();
  await popover
    .getByRole("button", { name: "Start meeting recording" })
    .click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("recording");
  const { meetingId } = await dashboard.evaluate(() =>
    window.api.getMeetingStatus(),
  );
  const before = (await listMeetings()).length;

  const event = await setEvents("e2e-client-call", "Client call", 6_000);
  const again = await reopenPopover();
  const arm = again.getByRole("switch", {
    name: "Record Client call when it starts",
  });
  await arm.click();
  await expect(arm).toBeChecked();
  await again.waitForTimeout(event.start - Date.now() + 4_000);
  // The same meeting records, no second one exists, and the arm is gone.
  expect(await meetingStatus()).toBe("recording");
  const now = await dashboard.evaluate(() => window.api.getMeetingStatus());
  expect(now.meetingId).toBe(meetingId);
  expect(await listMeetings()).toHaveLength(before);
  // The arm is gone. The card now shows the next event, not the started one.
  await expect(again.getByTestId("tray-popover-armed")).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(again.getByTestId("tray-popover-event-title")).toHaveText(
    PLANNING.title,
  );
  // Main logged why.
  await expect
    .poll(() => {
      try {
        return readFileSync(join(userDataDir, "logs", "openstyle.log"), "utf8");
      } catch {
        return "";
      }
    })
    .toContain("a meeting already records");
  await stopMeeting(again);
  await setCalendar(false);
});

test("screenshots of each popover state in light and dark (proof only)", async () => {
  test.skip(!SHOTS_DIR, "Only with OPENSTYLE_PROOF_SHOTS.");
  test.setTimeout(180_000);
  const base = embeddedServerUrl(app!);

  /** Open the popover in a theme and wait for its data. */
  const openIn = async (theme: "light" | "dark"): Promise<Page> => {
    const popover = await openPopover();
    await popover.evaluate((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    await popover.reload();
    await expect(popover.getByTestId("tray-popover-dictation")).toHaveCount(3, {
      timeout: 10_000,
    });
    await popover.waitForTimeout(400);
    return popover;
  };

  for (const theme of ["light", "dark"] as const) {
    const popover = await openIn(theme);
    await shot(popover, `1-${theme}-idle.png`);

    await popover
      .getByRole("button", { name: "Start meeting recording" })
      .click();
    await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("recording");
    const { meetingId } = await dashboard.evaluate(() =>
      window.api.getMeetingStatus(),
    );
    await fetch(`${base}/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Weekly product sync" }),
    });
    // A reload reads the full state again, the title included.
    await popover.reload();
    await expect(popover.getByTestId("tray-popover-meeting-title")).toHaveText(
      "Weekly product sync",
      { timeout: 10_000 },
    );
    await expect
      .poll(
        async () =>
          seconds(
            await popover.getByTestId("tray-popover-elapsed").innerText(),
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(2);
    await shot(popover, `2-${theme}-recording.png`);
    await popover
      .getByRole("button", { name: "Stop meeting recording" })
      .click();
    await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("idle");
  }

  await app!.evaluate(({ ipcMain }) => {
    ipcMain.emit("e2e:tray-popover-update-ready");
  });
  for (const theme of ["light", "dark"] as const) {
    const popover = await openIn(theme);
    await expect(
      popover.getByRole("button", { name: "Restart to update" }),
    ).toBeVisible();
    await shot(popover, `3-${theme}-update-ready.png`);
  }
  await popoverPage().evaluate(() => localStorage.removeItem("theme"));
});

test("the active models line names the default voice model and LLM", async () => {
  // No meeting records after this test: a default voice model would
  // transcribe a stopped meeting, and a test must not start an MLX worker.
  const base = embeddedServerUrl(app!);
  for (const model of [
    {
      provider: "local-mlx",
      model_id: "local-mlx/qwen3-0.6b-8bit",
      model_name: "Qwen3 Fast",
      type: "voice",
    },
    {
      provider: "local-mlx-llm",
      model_id: "local-mlx-llm/gemma-4-e2b-qat-4bit",
      model_name: "Gemma 4 E2B",
      type: "llm",
    },
  ]) {
    const res = await fetch(`${base}/api/models/configured`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...model, is_default: true }),
    });
    expect(res.ok, `POST /api/models/configured ${model.type}`).toBe(true);
  }
  // The server keeps an MLX voice default only where MLX runs: Apple
  // silicon with the worker or the Python runtime. Elsewhere GET
  // /api/models/configured switches it to the local Whisper fallback
  // base-q5_1 (server lib/mlx-asr/reconcile.ts), and the line shows that
  // model. A hosted macOS CI runner has no MLX runtime, so ask the server.
  const { canRun: mlx } = (await (
    await fetch(`${base}/api/mlx-asr/status`)
  ).json()) as { canRun: boolean };
  const voiceLabel = mlx ? "Qwen3 Fast" : "base-q5_1";
  const configured = (await (
    await fetch(`${base}/api/models/configured`)
  ).json()) as { model_id: string; type: string; is_default: number }[];
  expect(
    configured.find((m) => m.type === "voice" && m.is_default)?.model_id,
  ).toBe(mlx ? "local-mlx/qwen3-0.6b-8bit" : "local-whisper/base-q5_1");
  const popover = await reopenPopover();
  const names = popover.getByTestId("tray-popover-models-names");
  await expect(names).toHaveText(`${voiceLabel} · Gemma 4 E2B`, {
    timeout: 10_000,
  });
  await expect(popover.getByTestId("tray-popover-models")).toContainText(
    "Active models:",
  );
  await themedShots(popover, "4-idle-models", async () => {
    await expect(names).toBeVisible({ timeout: 10_000 });
  });
});

test("Restart to update runs the restart path of main", async () => {
  // The seam marks a downloaded update. In E2E, restartAndUpdate (menus.ts)
  // sends an app event and returns: no install and no quit.
  await app!.evaluate(({ app: electronApp, ipcMain }) => {
    const g = globalThis as unknown as { __restartCalls: number };
    g.__restartCalls = 0;
    electronApp.on("e2e:restart-and-update" as "ready", () => {
      g.__restartCalls += 1;
    });
    ipcMain.emit("e2e:tray-popover-update-ready");
  });
  // No job and no meeting: the menu bar shows the badge dot.
  await expect.poll(trayIcon).toBe("update");
  if (await popoverVisible()) await toggle();
  const popover = await openPopover();
  const restart = popover.getByRole("button", {
    name: "Update ready, Restart to update",
  });
  await expect(restart).toHaveText("Restart to update");
  await restart.click();
  await expect
    .poll(() =>
      app!.evaluate(
        () =>
          (globalThis as unknown as { __restartCalls: number }).__restartCalls,
      ),
    )
    .toBe(1);
  expect(
    await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => !w.isDestroyed()),
    ),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Step 2: the Jobs section. One fake own server (FakeLlm) runs Enhance. Its
// lane has one slot, so a held chunk call of the first meeting makes the
// second meeting wait in the real lane (the pattern of
// meeting-queued-badge.test.ts). OPENSTYLE_E2E_FAKE_MODEL_JOBS adds a fake
// download of Gemma 4 E2B and a fake load of Qwen3 Fast in GET /api/jobs.
// Nothing downloads.
// ---------------------------------------------------------------------------

test.describe("the Jobs section", () => {
  const RUN_ID = "e2e-tray-run";
  const RUN_TITLE = "Weekly product sync";
  const WAIT_ID = "e2e-tray-wait";
  const WAIT_TITLE = "Design review with Priya";
  const fake = new FakeLlm();
  let env: EnhanceApp;

  function goodAnswer(req: ChatRequest): Answer {
    switch (req.step) {
      case "correct_chunk":
        return {
          content: JSON.stringify({
            corrections: req.ids.map((id) => ({
              id,
              text: (req.lines.get(id) ?? "").replace(WRONG_WORD, RIGHT_WORD),
            })),
          }),
        };
      case "identify_speakers":
        return { content: JSON.stringify({ speakers: [] }) };
      case "meeting_tags":
        return { content: JSON.stringify({ tags: ["launch plan"] }) };
      default:
        return {
          content: JSON.stringify({
            overview: "The team moved the launch date to Friday.",
            keyPoints: ["The launch date moved."],
            decisions: [],
            actionItems: [],
            openQuestions: [],
          }),
        };
    }
  }

  const isRunChunk = (req: ChatRequest): boolean =>
    req.step === "correct_chunk" &&
    req.ids.some((id) => id.startsWith(`${RUN_ID}-`));

  /** Answer the held chunk call of the run meeting. */
  function releaseRunChunk(): void {
    const req = fake.requests.filter(isRunChunk).at(-1);
    if (!req) throw new Error("no held chunk call");
    fake.releaseHeld(goodAnswer(req));
  }

  test.beforeAll(async () => {
    // This part needs the fake LLM set-up, so it uses its own app.
    if (app) await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
    await fake.start();
    env = await bootEnhanceApp(fake, {
      advancedMode: false,
      prefix: "openstyle-e2e-tray-jobs-",
      env: { OPENSTYLE_E2E_TRAY: "1", OPENSTYLE_E2E_FAKE_MODEL_JOBS: "1" },
    });
    app = env.app;
    dashboard = env.page;
  });

  test.afterAll(async () => {
    if (env) {
      await closeApp(env.app);
      app = undefined;
      rmSync(env.userDataDir, { recursive: true, force: true });
    }
    await fake.stop();
  });

  test("running and queued meeting jobs and the model jobs show, and the percent moves", async () => {
    test.setTimeout(180_000);
    seedMeeting(env.userDataDir, RUN_ID, RUN_TITLE, defaultSegments(4));
    seedMeeting(env.userDataDir, WAIT_ID, WAIT_TITLE, defaultSegments(2));
    fake.script = (req) => (isRunChunk(req) ? "hold" : goodAnswer(req));

    const run = await env.api("POST", `/meetings/${RUN_ID}/enhance`);
    expect(run.status, "POST enhance of the run meeting").toBe(202);
    await expect.poll(() => fake.heldCount(), { timeout: 30_000 }).toBe(1);
    const wait = await env.api("POST", `/meetings/${WAIT_ID}/enhance`);
    expect(wait.status, "POST enhance of the waiting meeting").toBe(202);

    const popover = await openPopover();
    const jobs = popover.getByTestId("tray-popover-jobs");
    await expect(jobs).toBeVisible({ timeout: 10_000 });
    const rows = popover.getByTestId("tray-popover-job");
    const running = rows.filter({ hasText: `Enhancing ${RUN_TITLE}` });
    const queued = rows.filter({ hasText: WAIT_TITLE });
    await expect(running).toBeVisible({ timeout: 10_000 });
    await expect(queued).toHaveText(`Queued · Enhance · ${WAIT_TITLE}`, {
      timeout: 15_000,
    });
    await expect(queued).toHaveAttribute("data-queued", "true");
    await expect(queued).not.toContainText("%");
    await expect(queued).toHaveAccessibleName(
      `Queued · Enhance · ${WAIT_TITLE}. Open the meeting.`,
    );
    await expect(running).toHaveAccessibleName(
      new RegExp(`^Enhancing ${RUN_TITLE}, \\d+%\\. Open the meeting\\.$`),
    );

    // The model rows of the seam: real catalog names and sizes.
    const models = popover.getByTestId("tray-popover-model-job");
    const download = models.filter({ hasText: "Downloading Gemma 4 E2B" });
    await expect(download).toContainText(/\d\.\d of 4\.4 GB/);
    await expect(download).toContainText(/\d+%/);
    await expect(
      models.filter({ hasText: "Loading Qwen3 Fast…" }),
    ).toBeVisible();

    // The menu bar shows the job ring.
    await expect.poll(trayIcon, { timeout: 10_000 }).toBe("job");

    // The percent of the run moves when its held chunk call is answered.
    const percent = async (): Promise<number> =>
      Number(
        /(\d+)%/.exec((await running.innerText()) ?? "")?.[1] ?? Number.NaN,
      );
    const before = await percent();
    releaseRunChunk();
    await expect.poll(() => fake.heldCount(), { timeout: 30_000 }).toBe(1);
    await expect.poll(percent, { timeout: 10_000 }).toBeGreaterThan(before);
    console.log(
      "JOB_PERCENT",
      JSON.stringify({ before, after: await percent() }),
    );
    await shot(popover, "jobs-light.png");
  });

  test("screenshots of the Jobs section in dark (proof only)", async () => {
    test.skip(!SHOTS_DIR, "Only with OPENSTYLE_PROOF_SHOTS.");
    const popover = await openPopover();
    await popover.evaluate(() => localStorage.setItem("theme", "dark"));
    await popover.reload();
    await expect(popover.getByTestId("tray-popover-job")).toHaveCount(2, {
      timeout: 10_000,
    });
    await popover.waitForTimeout(400);
    await shot(popover, "jobs-dark.png");
    await popover.evaluate(() => localStorage.removeItem("theme"));
    await popover.reload();
    await expect(popover.getByTestId("tray-popover-job")).toHaveCount(2, {
      timeout: 10_000,
    });
  });

  test("a click on a meeting job opens that meeting in the main window", async () => {
    const popover = await openPopover();
    await popover
      .getByTestId("tray-popover-job")
      .filter({ hasText: `Enhancing ${RUN_TITLE}` })
      .click();
    await expect.poll(popoverVisible, { timeout: 5_000 }).toBe(false);
    await expect(dashboard.getByTestId("meetings-job-line")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      dashboard.getByTestId("meetings-segment").first(),
    ).toBeVisible();
    expect(new URL(dashboard.url()).pathname).toBe("/meetings");
  });

  test("when the meeting jobs end, only the model jobs stay", async () => {
    test.setTimeout(120_000);
    fake.script = goodAnswer;
    releaseRunChunk();
    const popover = await openPopover();
    await expect(popover.getByTestId("tray-popover-job")).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(popover.getByTestId("tray-popover-model-job")).toHaveCount(2);
    await shot(popover, "models-light.png");
    await popover.evaluate(() => localStorage.setItem("theme", "dark"));
    await popover.reload();
    await expect(popover.getByTestId("tray-popover-model-job")).toHaveCount(2, {
      timeout: 10_000,
    });
    await popover.waitForTimeout(400);
    await shot(popover, "models-dark.png");
    await popover.evaluate(() => localStorage.removeItem("theme"));
  });
});
