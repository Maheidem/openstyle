import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  if (MAC) await expect(hotkey).toHaveText("Hold Fn to dictate");
  else await expect(hotkey).toHaveText(/^Hold \S+ to dictate$/);
  await expect(popover.getByTestId("tray-popover-status")).toHaveText("Ready");
  await expect(
    popover.getByRole("button", { name: "Start meeting recording" }),
  ).toBeVisible();
  await expect(popover.getByTestId("tray-popover-version")).toContainText(
    "Up to date",
  );
  for (const name of ["Open Openstyle", "Settings", "Quit Openstyle"]) {
    await expect(popover.getByRole("button", { name })).toBeVisible();
  }
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
