import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Live transcript and chat (issue #375, specs/live-chat.md). Experimental,
// off by default. This spec needs no model and no audio device: the app runs
// with the E2E fake capture (silence). It proves two things:
//   1. With the setting off, the right pane has no live view, the card has no
//      link, the live route answers "off" and the chat route answers 409.
//   2. With the setting on and no local transcription model, the start opens
//      the live view in the right pane (not in the card). The transcript
//      column says "unavailable" and the recording goes on. The card has the
//      "Open live view" link. A click on the recording row opens the view
//      again. After the stop the pane shows the normal meeting detail.
// The real-model proof (latency, chat answers) is in the pull request of #375.
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let dashboard: Page;
let userDataDir: string;
let base: string;

async function meetingId(): Promise<string> {
  return dashboard.evaluate(
    async () => (await window.api.getMeetingStatus()).meetingId as string,
  );
}

async function startMeeting(): Promise<string> {
  await dashboard.goto("app://renderer/meetings");
  await dashboard
    .getByRole("button", { name: "Start recording" })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        dashboard.evaluate(
          async () => (await window.api.getMeetingStatus()).status,
        ),
      { timeout: 15_000 },
    )
    .toBe("recording");
  return meetingId();
}

async function stopMeeting(): Promise<void> {
  await dashboard
    .getByRole("button", { name: "Stop", exact: true })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        dashboard.evaluate(
          async () => (await window.api.getMeetingStatus()).status,
        ),
      { timeout: 20_000 },
    )
    .toBe("idle");
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-live-chat-"));
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
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

test("setting off: no live view, live route off, chat route 409", async () => {
  test.setTimeout(90_000);
  const id = await startMeeting();
  await expect(
    dashboard.getByTestId("meeting-recording-elapsed"),
  ).toBeVisible();
  await expect(dashboard.getByTestId("live-view")).toHaveCount(0);
  await expect(dashboard.getByTestId("live-transcript")).toHaveCount(0);
  await expect(dashboard.getByTestId("live-chat")).toHaveCount(0);
  await expect(dashboard.getByTestId("open-live-view")).toHaveCount(0);
  const live = await fetch(`${base}/api/meetings/${id}/live`);
  expect(await live.json()).toMatchObject({ status: "off", lines: [] });
  const chat = await fetch(`${base}/api/meetings/${id}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Is this on?" }),
  });
  expect(chat.status).toBe(409);
  await stopMeeting();
});

test("setting on, no local model: the live view opens in the right pane and says unavailable", async () => {
  test.setTimeout(90_000);
  const put = await fetch(`${base}/api/settings/live_chat_enabled`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "true" }),
  });
  expect(put.ok).toBe(true);
  // A folder to click away to. It exists before the page loads.
  const folder = await fetch(`${base}/api/meetings/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Proof folder" }),
  });
  expect(folder.ok).toBe(true);
  const id = await startMeeting();
  // Auto-open: the live view fills the right pane.
  const detail = dashboard.getByTestId("meetings-detail-column");
  await expect(detail.getByTestId("live-view")).toBeVisible({
    timeout: 15_000,
  });
  await expect(detail.getByTestId("live-view-elapsed")).toBeVisible();
  await expect(detail.getByTestId("live-transcript")).toBeVisible();
  await expect(detail.getByTestId("live-chat")).toBeVisible();
  await expect(detail.getByTestId("live-unavailable")).toBeVisible({
    timeout: 15_000,
  });
  // The small card keeps the timer and Stop, and has the link. It has no
  // live panel.
  const list = dashboard.getByTestId("meetings-list-column");
  await expect(list.getByTestId("meeting-recording-elapsed")).toBeVisible();
  await expect(list.getByTestId("live-transcript")).toHaveCount(0);
  await expect(list.getByTestId("live-chat")).toHaveCount(0);
  await expect(list.getByTestId("open-live-view")).toBeVisible();
  const live = await (await fetch(`${base}/api/meetings/${id}/live`)).json();
  expect(live.status).toBe("unavailable");
  // Click away to the folder page, then back with the link of the card.
  await list.getByRole("button", { name: "Proof folder", exact: true }).click();
  await expect(dashboard.getByTestId("live-view")).toHaveCount(0);
  await list.getByTestId("open-live-view").click();
  await expect(detail.getByTestId("live-view")).toBeVisible();
  await stopMeeting();
  // After the stop the pane shows the normal meeting detail.
  await expect(dashboard.getByTestId("live-view")).toHaveCount(0);
  await expect(dashboard.getByTestId("open-live-view")).toHaveCount(0);
  // The live entry is gone after the stop.
  const after = await (await fetch(`${base}/api/meetings/${id}/live`)).json();
  expect(after.status).toBe("off");
});
