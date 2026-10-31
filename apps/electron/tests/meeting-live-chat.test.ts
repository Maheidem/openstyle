import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
//   3. The chat is saved with the meeting (live mode fixes). With no model
//      the chat cannot answer, so the test writes one saved question and
//      answer into the profile DB. The chat stays when the user clicks
//      away and back, and after the stop it has a tab in the meeting detail.
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
  // One saved question and answer (the chat model is not available here).
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  const add = db.prepare(
    `INSERT INTO meeting_chat_messages
       (meeting_id, role, content, cites_json, ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  add.run(id, "user", "Who owns the beta?", null, null, now);
  add.run(
    id,
    "assistant",
    "Dana owns the beta.",
    JSON.stringify([{ label: "L1", kind: "live", timeMs: 5000 }]),
    120,
    now + 1,
  );
  db.close();
  const saved = await (await fetch(`${base}/api/meetings/${id}/chat`)).json();
  expect(saved.messages.map((m: { role: string }) => m.role)).toEqual([
    "user",
    "assistant",
  ]);
  // The panel shows the saved chat after a reload of the page (a new mount).
  await dashboard.goto("app://renderer/meetings");
  await expect(detail.getByTestId("live-chat-user")).toContainText(
    "Who owns the beta?",
    { timeout: 15_000 },
  );
  await expect(detail.getByTestId("live-chat-assistant")).toContainText(
    "Dana owns the beta.",
  );
  // Click away to the folder page, then back with the link of the card. The
  // chat is still there.
  await list.getByRole("button", { name: "Proof folder", exact: true }).click();
  await expect(dashboard.getByTestId("live-view")).toHaveCount(0);
  await list.getByTestId("open-live-view").click();
  await expect(detail.getByTestId("live-view")).toBeVisible();
  await expect(detail.getByTestId("live-chat-user")).toContainText(
    "Who owns the beta?",
  );
  await expect(detail.getByTestId("live-chat-assistant")).toContainText(
    "Dana owns the beta.",
  );
  await stopMeeting();
  // After the stop the pane shows the normal meeting detail.
  await expect(dashboard.getByTestId("live-view")).toHaveCount(0);
  await expect(dashboard.getByTestId("open-live-view")).toHaveCount(0);
  // The saved chat has a tab in the meeting detail and can be read there.
  await expect(dashboard.getByTestId("meeting-chat-tab")).toBeVisible({
    timeout: 15_000,
  });
  await dashboard.getByTestId("meeting-chat-tab").click();
  const history = dashboard.getByTestId("meeting-chat-history");
  await expect(history).toContainText("Who owns the beta?");
  await expect(history).toContainText("Dana owns the beta.");
  // No live text was read (no model), so no transcript is saved from live.
  await expect(dashboard.getByTestId("meeting-from-live")).toHaveCount(0);
  // The live entry is gone after the stop.
  const after = await (await fetch(`${base}/api/meetings/${id}/live`)).json();
  expect(after.status).toBe("off");
});
