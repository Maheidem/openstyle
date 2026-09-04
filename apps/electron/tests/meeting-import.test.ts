import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { _electron as electron } from "playwright";

// ---------------------------------------------------------------------------
// Meeting import (specs/meeting-import.md §5): mirrors tests/import-screen.test.ts
// — same launch harness, same synthesized-WAV fixture, same env-var picker seam
// (OPENSTYLE_E2E_MEETING_IMPORT_FILE). The meetings page itself is feature-flagged
// (config.flags.meetings), so beforeAll pre-seeds config.freestyle.json next to
// the throwaway DB the same way import-screen pre-seeds settings.json.
//
// Environment notes:
// - The app *reuses* an already-running Openstyle server on the default port
//   4649 (main/index.ts's single-instance probe). If one is healthy there at
//   launch — e.g. the developer's installed app is running — this suite would
//   silently read and WRITE that real server's DB, so it skips instead. CI is
//   always clean.
// - To run the suite anyway while another Openstyle occupies 4649, point it
//   at an isolated standalone server (apps/server dist/startup.js) via
//   OPENSTYLE_E2E_SERVER_URL (+ OPENSTYLE_E2E_SERVER_TOKEN). That routes the
//   app's configured-server path (settings.json serverUrl/serverToken) at it;
//   the operator seeds its DB dir with config.freestyle.json (meetings flag)
//   before starting it.
// ---------------------------------------------------------------------------

const EXTERNAL_SERVER_URL = process.env.OPENSTYLE_E2E_SERVER_URL?.replace(
  /\/+$/,
  "",
);
const EXTERNAL_SERVER_TOKEN = process.env.OPENSTYLE_E2E_SERVER_TOKEN ?? "";

let app: ElectronApplication | undefined;
let dashboardPage: Page;
let serverPort: number;
let userDataDir: string;

const DEFAULT_PORT = 4649;

/**
 * Wait for a window whose URL is neither the pill nor the remix bar —
 * that's the dashboard / onboarding window (mirrors import-screen.test.ts).
 */
async function waitForDashboardWindow(
  electronApp: ElectronApplication,
  timeoutMs = 10_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const win of electronApp.windows()) {
      const url = win.url();
      if (
        !url.includes("pill") &&
        !url.includes("bar.html") &&
        url.length > 0
      ) {
        await win.waitForLoadState("domcontentloaded");
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return electronApp.windows()[0];
}

/** Writes a minimal valid 1 s, 16 kHz mono, 16-bit PCM WAV file (silence). */
function writeSilentWav(path: string): void {
  const sampleRate = 16_000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const durationSec = 1;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  // Data section left as zeros (silence) from Buffer.alloc.

  writeFileSync(path, buffer);
}

interface MeetingListRow {
  id: string;
  title: string | null;
  status: string;
}

async function listMeetings(): Promise<MeetingListRow[]> {
  const res = await fetch(`${apiBase()}/api/meetings`, {
    headers: apiHeaders(),
  });
  expect(res.ok, `GET ${apiBase()}/api/meetings -> ${res.status}`).toBe(true);
  const body = (await res.json()) as { items: MeetingListRow[] };
  return body.items;
}

function apiBase(): string {
  return EXTERNAL_SERVER_URL ?? `http://127.0.0.1:${serverPort}`;
}

function apiHeaders(): Record<string, string> {
  return EXTERNAL_SERVER_TOKEN
    ? { Authorization: `Bearer ${EXTERNAL_SERVER_TOKEN}` }
    : {};
}

async function meetingImportCalls(): Promise<number> {
  return app.evaluate(() => {
    const g = globalThis as {
      __openstyleE2E?: { meetingImportCalls?: number };
    };
    return g.__openstyleE2E?.meetingImportCalls ?? 0;
  });
}

async function navigateToMeetings(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Meetings" }).click();
  await page.waitForURL(/\/meetings/);
}

test.beforeAll(async () => {
  // Skip (rather than silently reusing) a foreign server on the default
  // port: the app's single-instance probe would attach this suite to the
  // developer's real DB. Only the opt-in external-server mode may proceed.
  if (!EXTERNAL_SERVER_URL) {
    let foreign = false;
    try {
      const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      foreign = res.ok;
    } catch {
      // nothing listening — clean environment, proceed with the embedded server
    }
    test.skip(
      foreign,
      `Another Openstyle server is listening on ${DEFAULT_PORT}; the app would reuse it and touch its DB. Stop it, or point this suite at an isolated server via OPENSTYLE_E2E_SERVER_URL.`,
    );
  }

  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-meeting-import-"));
  const dbPath = join(userDataDir, "freestyle.db");

  // Skip onboarding (mirrors import-screen.test.ts) …
  const settings: Record<string, unknown> = { onboardingComplete: true };
  // … route the app at the isolated external server when asked to …
  if (EXTERNAL_SERVER_URL) {
    settings.serverUrl = EXTERNAL_SERVER_URL;
    if (EXTERNAL_SERVER_TOKEN) settings.serverToken = EXTERNAL_SERVER_TOKEN;
  }
  writeFileSync(join(userDataDir, "settings.json"), JSON.stringify(settings));
  // … and enable the meetings feature flag. Flags are server-owned and live
  // in config.freestyle.json next to the DB (apps/server/src/lib/config.ts
  // resolveConfigPath), written before launch so the first read sees it.
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );

  // The meetings flag must be on for whichever server answers BEFORE the
  // app launches: the renderer caches GET /api/config for the session, so a
  // flag flipped after first read would keep the nav entry hidden until a
  // manual reload. Embedded mode gets it from the seeded config file above;
  // external mode needs it set over HTTP against the operator's server.
  if (EXTERNAL_SERVER_URL) {
    const res = await fetch(
      `${EXTERNAL_SERVER_URL}/api/config/flags/meetings`,
      {
        method: "PUT",
        headers: {
          ...apiHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: true }),
      },
    );
    if (!res.ok) {
      throw new Error(
        `Seeding the meetings flag on ${EXTERNAL_SERVER_URL} failed (HTTP ${res.status}) — is OPENSTYLE_E2E_SERVER_URL/TOKEN correct and is that server isolated?`,
      );
    }
  }

  try {
    app = await electron.launch({
      args: [resolve(__dirname, "../out/main/index.js")],
      env: {
        ...process.env,
        NODE_ENV: "development",
        OPENSTYLE_DB_PATH: dbPath,
        // main/index.ts unconditionally rewrites OPENSTYLE_DB_PATH from
        // app.getPath("userData") before starting the server — isolation
        // depends on OPENSTYLE_USER_DATA (mirrors import-screen.test.ts).
        OPENSTYLE_USER_DATA: userDataDir,
        OPENSTYLE_E2E: "1",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 30_000,
    });

    await app.firstWindow();

    dashboardPage = await waitForDashboardWindow(app, 15_000);
    try {
      await dashboardPage.waitForLoadState("networkidle", {
        timeout: 15_000,
      });
    } catch {
      await dashboardPage.waitForLoadState("load", { timeout: 10_000 });
    }

    // Same port resolution as import-screen.test.ts: probe the default
    // loopback port from inside the app, falling back to it unchanged (the
    // e2e env never races a second instance onto 4649). Unused in external
    // mode (all API traffic follows the configured serverUrl).
    const portResult = await app.evaluate(async (_electron, port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return port;
      } catch {
        // port not available
      }
      return 0;
    }, DEFAULT_PORT);

    serverPort = portResult || DEFAULT_PORT;
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
  const proc = app.process();
  const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  try {
    await app.close();
  } catch (error) {
    console.warn("Error closing app:", error);
    proc.kill("SIGKILL");
  } finally {
    clearTimeout(killTimer);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("rejects a .txt drop before any upload", async () => {
  test.setTimeout(30_000);
  await navigateToMeetings(dashboardPage);

  // Empty DB → first-run layout with the dashed drop-zone card.
  await expect(
    dashboardPage.getByTestId("meetings-import-dropzone"),
  ).toBeVisible({ timeout: 10_000 });

  const meetingsBefore = await listMeetings();
  expect(meetingsBefore.length).toBe(0);
  const callsBefore = await meetingImportCalls();

  // Synthetic drop of a non-audio file — rejected client-side before any
  // IPC upload (same shape as import-screen's .txt test; a real drag isn't
  // needed because rejection happens before path resolution).
  await dashboardPage.evaluate(() => {
    const dropzone = document.querySelector(
      '[data-testid="meetings-import-dropzone"]',
    ) as HTMLElement;
    const file = new File(["hi"], "note.txt", { type: "text/plain" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const dropEvent = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    });
    dropzone.dispatchEvent(dropEvent);
  });

  const alert = dashboardPage.getByTestId("meetings-import-error");
  await expect(alert).toBeVisible({ timeout: 5_000 });
  const alertText = (await alert.textContent()) ?? "";
  // en.json: "meetings.importUnsupported" renders the extension (not the
  // whole filename) — read the source of truth rather than duplicating the
  // phrasing.
  expect(alertText).toContain("txt files aren't supported");

  const meetingsAfter = await listMeetings();
  expect(meetingsAfter.length).toBe(0);
  expect(await meetingImportCalls()).toBe(callsBefore);
});

test("picker import from the empty state creates and selects a meeting", async () => {
  test.setTimeout(45_000);
  await navigateToMeetings(dashboardPage);

  const wavPath = join(userDataDir, "imported-meeting.wav");
  writeSilentWav(wavPath);
  expect(existsSync(wavPath)).toBe(true);

  await app.evaluate((_electron, path) => {
    process.env.OPENSTYLE_E2E_MEETING_IMPORT_FILE = path;
  }, wavPath);

  await dashboardPage.getByTestId("meetings-import-choose-file").click();

  // The import is one synchronous request; on success the page flips from
  // the first-run layout to master-detail with the new meeting selected.
  // Assert on the title (the filename stem) — the auto-fired transcribe job
  // makes `status` flappy between recorded/transcribing/failed depending on
  // whether a voice model is configured, so never assert on it.
  await expect(
    dashboardPage.getByText("imported-meeting", { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });

  // Detail pane opened on the imported meeting. Which action is live depends
  // on the auto-fired transcribe job: when a *configured, reachable* voice
  // model exists (the import-screen suite seeds one into the shared external
  // server whenever a local oMLX answers on 127.0.0.1:8123), the silent
  // clip transcribes in milliseconds and the row is already `transcribed` —
  // the button then reads "Re-transcribe". With no model (CI) the job fails
  // or stays pending and the button reads "Transcribe". Either terminal
  // posture proves the detail view's action bar rendered; never assert on
  // `status` itself (same rationale as the title check above).
  const transcribeAction = dashboardPage
    .getByRole("button", { name: "Transcribe", exact: true })
    .or(dashboardPage.getByRole("button", { name: "Re-transcribe" }));
  await expect(transcribeAction.first()).toBeVisible({ timeout: 10_000 });

  // Server-side row exists in the same shape a recording produces.
  const meetings = await listMeetings();
  expect(meetings.length).toBe(1);
  expect(meetings[0].title).toBe("imported-meeting");
  expect(
    meetings[0].status === "recorded" ||
      meetings[0].status === "transcribing" ||
      meetings[0].status === "transcribed" ||
      meetings[0].status === "failed",
  ).toBe(true);

  expect(await meetingImportCalls()).toBe(1);

  await app.evaluate(() => {
    delete process.env.OPENSTYLE_E2E_MEETING_IMPORT_FILE;
  });
});

test("picker import from the master-detail rail adds another meeting", async () => {
  test.setTimeout(45_000);
  await navigateToMeetings(dashboardPage);

  // Non-empty list → rail layout. Its Import button shares the testid with
  // the empty-state one (only one layout renders at a time).
  const railButton = dashboardPage.getByTestId("meetings-import-choose-file");
  await expect(railButton).toBeVisible({ timeout: 10_000 });

  const wavPath = join(userDataDir, "second-meeting.wav");
  writeSilentWav(wavPath);

  await app.evaluate((_electron, path) => {
    process.env.OPENSTYLE_E2E_MEETING_IMPORT_FILE = path;
  }, wavPath);

  await railButton.click();

  await expect(
    dashboardPage.getByText("second-meeting", { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });

  const meetings = await listMeetings();
  expect(meetings.length).toBe(2);
  expect(meetings.some((m) => m.title === "second-meeting")).toBe(true);

  expect(await meetingImportCalls()).toBe(2);

  await app.evaluate(() => {
    delete process.env.OPENSTYLE_E2E_MEETING_IMPORT_FILE;
  });
});
