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
// Live captions in the recording pill (issue #375, specs/live-chat.md
// section 9). The spec needs no model and no audio device: the app runs with
// the E2E fake capture (silence), and the test answers the pill's request of
// `GET /api/meetings/:id/live` with fixed lines (the seam is the network
// route of the pill page). It proves:
//   1. Setting off: the pill has no caption box and keeps its 160 x 60 size.
//   2. Setting on: the final line and the partial line show, the window grows
//      and the capsule does not move on the screen.
//   3. A line that is too long keeps its end (ellipsis at the start).
//   4. No new text for 8 s, or no text at all (a silence): the captions hide
//      and the window shrinks back.
// The real-model proof (latency, screenshots) is in the pull request.
//
// Set OPENSTYLE_PROOF_SHOTS=<dir> to save screenshots of the pill in <dir>.
// ---------------------------------------------------------------------------

const SHOTS_DIR = process.env.OPENSTYLE_PROOF_SHOTS;

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let dashboard: Page;
let userDataDir: string;
let base: string;

interface InjectedLine {
  source: "mic" | "system";
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
}
let injected: { status: string; lines: InjectedLine[] } = {
  status: "ready",
  lines: [],
};

function line(text: string, startMs: number, final: boolean): InjectedLine {
  return { source: "mic", startMs, endMs: startMs + 2000, text, final };
}

async function pillPage(): Promise<Page> {
  const page = app.windows().find((w) => w.url().includes("pill"));
  if (!page) throw new Error("The pill window does not exist");
  return page;
}

async function meetingStatus(): Promise<string> {
  return dashboard.evaluate(
    async () => (await window.api.getMeetingStatus()).status,
  );
}

/** The size of the pill window and the screen position of the capsule. */
async function pillGeometry(pill: Page): Promise<{
  w: number;
  h: number;
  capsuleCenter: number;
  capsuleBottom: number;
}> {
  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().includes("pill"),
    );
    return win?.getBounds() ?? null;
  });
  if (!bounds) throw new Error("The pill window does not exist");
  const box = await pill.getByTestId("pill-meeting").boundingBox();
  if (!box) throw new Error("The capsule has no box");
  return {
    w: bounds.width,
    h: bounds.height,
    capsuleCenter: bounds.x + box.x + box.width / 2,
    capsuleBottom: bounds.y + box.y + box.height,
  };
}

async function putSetting(key: string, value: string): Promise<void> {
  const res = await fetch(`${base}/api/settings/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  expect(res.ok).toBe(true);
}

async function startMeeting(): Promise<Page> {
  await dashboard.goto("app://renderer/meetings");
  await dashboard
    .getByRole("button", { name: "Start recording" })
    .first()
    .click();
  await expect.poll(meetingStatus, { timeout: 15_000 }).toBe("recording");
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some(
            (w) => w.webContents.getURL().includes("pill") && w.isVisible(),
          ),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const pill = await pillPage();
  await expect(pill.getByTestId("pill-meeting")).toBeVisible({
    timeout: 10_000,
  });
  // The arrival motion of the capsule must end before a position is read.
  await pill.waitForTimeout(800);
  return pill;
}

async function stopMeeting(): Promise<void> {
  await dashboard
    .getByRole("button", { name: "Stop", exact: true })
    .first()
    .click();
  await expect.poll(meetingStatus, { timeout: 20_000 }).toBe("idle");
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, name) });
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-live-captions-"));
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
    env: { OPENSTYLE_E2E_FAKE_MEETING_CAPTURE: "1" },
  });
  dashboard = await waitForDashboardWindow(app, 15_000);
  base = embeddedServerUrl(app);
  const pill = await pillPage();
  await pill.route(/\/api\/meetings\/[^/]+\/live$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...injected, skippedTicks: 0 }),
    }),
  );
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

test("setting off: the pill has no captions and keeps its size", async () => {
  test.setTimeout(90_000);
  injected = {
    status: "ready",
    lines: [line("This text must not show.", 0, true)],
  };
  const pill = await startMeeting();
  // Wait longer than two polls. Nothing may appear.
  await pill.waitForTimeout(2500);
  await expect(pill.getByTestId("pill-captions")).toHaveCount(0);
  const geometry = await pillGeometry(pill);
  expect(geometry.w).toBe(160);
  expect(geometry.h).toBe(60);
  await shot(pill, "pill-captions-off.png");
  await stopMeeting();
});

test("setting on: two caption lines, the capsule does not move, they hide", async () => {
  test.setTimeout(120_000);
  await putSetting("live_chat_enabled", "true");
  await putSetting("live_captions_pill", "true");
  injected = { status: "ready", lines: [] };
  const pill = await startMeeting();
  const before = await pillGeometry(pill);
  expect(before.w).toBe(160);
  // No text yet: no caption box content, same size (a silence gives no text).
  await pill.waitForTimeout(1500);
  await expect(pill.getByTestId("pill-caption-final")).toHaveCount(0);
  expect((await pillGeometry(pill)).h).toBe(60);

  // Text arrives: the last final line and the newest partial line.
  injected = {
    status: "ready",
    lines: [
      line("First sentence of the fictional call.", 1000, true),
      line("Second sentence of the call.", 4000, true),
      line("and the third one is still gr", 7000, false),
    ],
  };
  const finalLine = pill.getByTestId("pill-caption-final");
  const partialLine = pill.getByTestId("pill-caption-partial");
  await expect(finalLine).toHaveText("Second sentence of the call.", {
    timeout: 5000,
  });
  await expect(partialLine).toHaveText("and the third one is still gr");
  await expect(pill.getByTestId("pill-captions")).toHaveAttribute(
    "data-show",
    "true",
    { timeout: 3000 },
  );
  await expect.poll(async () => (await pillGeometry(pill)).h).toBe(96);
  const during = await pillGeometry(pill);
  expect(during.w).toBe(360);
  // The capsule stays at the same place on the screen.
  expect(
    Math.abs(during.capsuleBottom - before.capsuleBottom),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(during.capsuleCenter - before.capsuleCenter),
  ).toBeLessThanOrEqual(1);
  await shot(pill, "pill-captions-on.png");

  // A long line keeps its end. The start is cut.
  const long =
    "This is a very long fictional sentence that goes on and on about the quarterly plan and ends with the word LASTWORD";
  injected = { status: "ready", lines: [line(long, 9000, true)] };
  await expect(finalLine).toHaveText(long, { timeout: 5000 });
  const cut = await finalLine.evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth,
    style: getComputedStyle(el).textOverflow,
  }));
  expect(cut).toEqual({ clipped: true, style: "ellipsis" });
  await shot(pill, "pill-captions-long.png");

  // The same text for 8 s: the captions hide and the window shrinks.
  await expect(pill.getByTestId("pill-captions")).toHaveAttribute(
    "data-show",
    "false",
    { timeout: 12_000 },
  );
  await expect.poll(async () => (await pillGeometry(pill)).h).toBe(60);
  const after = await pillGeometry(pill);
  expect(after.w).toBe(160);
  expect(
    Math.abs(after.capsuleBottom - before.capsuleBottom),
  ).toBeLessThanOrEqual(1);

  // New text brings them back. Empty text (a silence) hides them at once.
  injected = { status: "ready", lines: [line("Back again.", 20_000, true)] };
  await expect(pill.getByTestId("pill-captions")).toHaveAttribute(
    "data-show",
    "true",
    { timeout: 5000 },
  );
  injected = { status: "ready", lines: [] };
  await expect(pill.getByTestId("pill-captions")).toHaveAttribute(
    "data-show",
    "false",
    { timeout: 5000 },
  );
  await stopMeeting();
});

test("live chat off: the captions option does nothing", async () => {
  test.setTimeout(90_000);
  await putSetting("live_chat_enabled", "false");
  injected = { status: "ready", lines: [line("Must not show.", 0, true)] };
  const pill = await startMeeting();
  await pill.waitForTimeout(2500);
  await expect(pill.getByTestId("pill-captions")).toHaveCount(0);
  expect((await pillGeometry(pill)).h).toBe(60);
  await stopMeeting();
});
