import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { dropFile, e2eCounter, withPickerFile } from "./e2e-helpers";
import {
  closeApp,
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";
import { pcm16Wav, writeSilentWav } from "./helpers/wav";

// ---------------------------------------------------------------------------
// Meeting import (specs/meeting-import.md §5): mirrors tests/import-screen.test.ts
// — same launch harness, same synthesized-WAV fixture, same env-var picker seam
// (OPENSTYLE_E2E_MEETING_IMPORT_FILE). The meetings page itself is feature-flagged
// (config.flags.meetings), so beforeAll pre-seeds config.freestyle.json next to
// the throwaway DB the same way import-screen pre-seeds settings.json.
//
// Environment notes:
// - The app runs its embedded server on its own free port against a
//   throwaway userData dir (launchOpenstyle), so an installed Openstyle on
//   port 4649 is never touched.
// - To run against an isolated standalone server (apps/server
//   dist/startup.js) instead, set OPENSTYLE_E2E_SERVER_URL
//   (+ OPENSTYLE_E2E_SERVER_TOKEN). That routes the app's configured-server
//   path (settings.json serverUrl/serverToken) at it.
// ---------------------------------------------------------------------------

const EXTERNAL_SERVER_URL = process.env.OPENSTYLE_E2E_SERVER_URL?.replace(
  /\/+$/,
  "",
);
const EXTERNAL_SERVER_TOKEN = process.env.OPENSTYLE_E2E_SERVER_TOKEN ?? "";
// Set OPENSTYLE_PROOF_SHOTS=<dir> to save light and dark screenshots of the
// calendar dialog in <dir>. CI does not set it.
const SHOTS_DIR = process.env.OPENSTYLE_PROOF_SHOTS;

let app: ElectronApplication | undefined;
let dashboardPage: Page;
let userDataDir: string;

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
  return EXTERNAL_SERVER_URL ?? embeddedServerUrl(app!);
}

function apiHeaders(): Record<string, string> {
  return EXTERNAL_SERVER_TOKEN
    ? { Authorization: `Bearer ${EXTERNAL_SERVER_TOKEN}` }
    : {};
}

async function navigateToMeetings(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Meetings" }).click();
  await page.waitForURL(/\/meetings/);
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-meeting-import-"));

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
    // The fake calendar (fictional events, no EventKit) matters only while
    // the calendar setting is on: the calendar tests below turn it on.
    app = await launchOpenstyle({
      userDataDir,
      env: { OPENSTYLE_E2E_FAKE_CALENDAR: "1" },
    });

    dashboardPage = await waitForDashboardWindow(app, 15_000);
    try {
      await dashboardPage.waitForLoadState("networkidle", {
        timeout: 15_000,
      });
    } catch {
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

test("rejects a .txt drop before any upload", async () => {
  test.setTimeout(30_000);
  await navigateToMeetings(dashboardPage);

  // Empty DB → first-run layout with the dashed drop-zone card.
  await expect(
    dashboardPage.getByTestId("meetings-import-dropzone"),
  ).toBeVisible({ timeout: 10_000 });

  const meetingsBefore = await listMeetings();
  expect(meetingsBefore.length).toBe(0);
  const callsBefore = await e2eCounter(app!, "meetingImportCalls");

  // Synthetic drop of a non-audio file — rejected client-side before any
  // IPC upload (same shape as import-screen's .txt test; a real drag isn't
  // needed because rejection happens before path resolution).
  await dropFile(
    dashboardPage,
    "meetings-import-dropzone",
    "note.txt",
    "text/plain",
  );

  const alert = dashboardPage.getByTestId("meetings-import-error");
  await expect(alert).toBeVisible({ timeout: 5_000 });
  const alertText = (await alert.textContent()) ?? "";
  // en.json: "meetings.importUnsupported" renders the extension (not the
  // whole filename) — read the source of truth rather than duplicating the
  // phrasing.
  expect(alertText).toContain("txt files aren't supported");

  const meetingsAfter = await listMeetings();
  expect(meetingsAfter.length).toBe(0);
  expect(await e2eCounter(app!, "meetingImportCalls")).toBe(callsBefore);
});

test("picker import from the empty state creates and selects a meeting", async () => {
  test.setTimeout(45_000);
  await navigateToMeetings(dashboardPage);

  const wavPath = join(userDataDir, "imported-meeting.wav");
  writeSilentWav(wavPath);
  expect(existsSync(wavPath)).toBe(true);

  await withPickerFile(
    app!,
    "OPENSTYLE_E2E_MEETING_IMPORT_FILE",
    wavPath,
    async () => {
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
      // the primary button then reads "Enhance" (issue #262: Re-transcribe
      // is in the "..." menu). With no model (CI) the job fails or stays
      // pending and the primary button reads "Transcribe". Either terminal
      // posture proves the detail view's action bar rendered; never assert on
      // `status` itself (same rationale as the title check above).
      const transcribeAction = dashboardPage
        .getByRole("button", { name: "Transcribe", exact: true })
        .or(
          dashboardPage.getByRole("button", { name: "Enhance", exact: true }),
        );
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

      expect(await e2eCounter(app!, "meetingImportCalls")).toBe(1);
    },
  );
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

  await withPickerFile(
    app!,
    "OPENSTYLE_E2E_MEETING_IMPORT_FILE",
    wavPath,
    async () => {
      await railButton.click();

      await expect(
        dashboardPage.getByText("second-meeting", { exact: true }).first(),
      ).toBeVisible({ timeout: 15_000 });

      const meetings = await listMeetings();
      expect(meetings.length).toBe(2);
      expect(meetings.some((m) => m.title === "second-meeting")).toBe(true);

      expect(await e2eCounter(app!, "meetingImportCalls")).toBe(2);
    },
  );
});

// ---------------------------------------------------------------------------
// Calendar link at import (issue #445). The fake calendar gives fictional
// events. The fixture is a real Chrome MediaRecorder WebM/Opus file (the
// Krisp shape: no duration in the header), recorded in the renderer from an
// oscillator. No microphone and no speaker is used. With no bundled ffmpeg
// (the CI E2E job), the fixture is a WAV (see writeFixture).
// ---------------------------------------------------------------------------

async function setCalendar(on: boolean): Promise<void> {
  const res = await fetch(`${apiBase()}/api/settings/calendar_enabled`, {
    method: "PUT",
    headers: { ...apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ value: on ? "true" : "false" }),
  });
  expect(res.ok, "PUT /api/settings/calendar_enabled").toBe(true);
}

/** Two fictional events today: a matching one and an earlier other one. */
async function setTodayEvents(): Promise<{
  match: { id: string; title: string; start: number; end: number };
}> {
  const d = new Date();
  const at = (h: number, m: number) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  const match = {
    id: "e2e-atlas-weekly",
    title: "Atlas Weekly Sync",
    start: at(10, 0),
    end: at(10, 45),
    attendees: [
      { name: "Ana Souza", email: "ana@example.test", isOrganizer: true },
      { name: "Bruno Lima", email: "bruno@example.test", isOrganizer: false },
      { name: "Carla Dias", email: "carla@example.test", isOrganizer: false },
    ],
  };
  const other = {
    id: "e2e-team-standup",
    title: "Team standup",
    start: at(9, 0),
    end: at(9, 15),
    attendees: [
      { name: "Ana Souza", email: "ana@example.test", isOrganizer: false },
    ],
  };
  await app!.evaluate(
    ({ ipcMain }, list) => {
      ipcMain.emit("e2e:fake-calendar-set", {}, list);
    },
    [other, match],
  );
  return { match };
}

// The server decodes a WebM file with the bundled ffmpeg. It looks for
// resources/bin/<platform>-<arch>/ffmpeg under its cwd, which is the cwd of
// this run (apps/server/src/lib/audio/decode.ts ffmpegBinaryCandidates). The
// macOS E2E job in CI does not fetch ffmpeg, so there a WebM import gets 422
// AUDIO_DECODE_FAILED (binary_missing) and makes no meeting. Without ffmpeg,
// the calendar tests import a 16 kHz WAV, which needs no decode. The dialog,
// the link and Skip are the same for both formats.
const BUNDLED_FFMPEG = existsSync(
  join(
    process.cwd(),
    "resources",
    "bin",
    `${process.platform}-${process.arch}`,
    "ffmpeg",
  ),
);
const FIXTURE_EXT = BUNDLED_FFMPEG ? "webm" : "wav";

/** Write the import fixture: a recorder WebM, or a WAV with no ffmpeg. */
async function writeFixture(path: string): Promise<void> {
  test.info().annotations.push({
    type: "fixture",
    description: BUNDLED_FFMPEG
      ? "MediaRecorder WebM/Opus (bundled ffmpeg found)"
      : "16 kHz WAV (no bundled ffmpeg, the WebM decode is not checked)",
  });
  if (BUNDLED_FFMPEG) {
    await writeRecorderWebm(path);
    return;
  }
  // 1.5 s of a 440 Hz sine, the same length as the recorder WebM.
  const samples = new Int16Array(24_000);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  }
  writeFileSync(path, pcm16Wav(samples));
}

/** Record 1.5 s of a sine with MediaRecorder and write it as a .webm. */
async function writeRecorderWebm(path: string): Promise<void> {
  const base64 = await dashboardPage.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const rec = new MediaRecorder(dest.stream, {
      mimeType: "audio/webm;codecs=opus",
    });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise<void>((r) => {
      rec.onstop = () => r();
    });
    rec.start(250);
    await new Promise((r) => setTimeout(r, 1500));
    rec.stop();
    await done;
    osc.stop();
    await ctx.close();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  const buf = Buffer.from(base64, "base64");
  // EBML magic: a Matroska/WebM file.
  expect(buf.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  expect(buf.length).toBeGreaterThan(1000);
  writeFileSync(path, buf);
}

async function meetingDetail(id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase()}/api/meetings/${id}`, {
    headers: apiHeaders(),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function proofShot(name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await dashboardPage.mouse.move(0, 0);
  // Let the dialog open animation end.
  await dashboardPage.waitForTimeout(400);
  await dashboardPage.screenshot({ path: join(SHOTS_DIR, name) });
}

async function setTheme(theme: "light" | "dark"): Promise<void> {
  await dashboardPage.evaluate((v) => localStorage.setItem("theme", v), theme);
  await dashboardPage.reload();
}

test("calendar on: the dialog links the matching event before transcription", async () => {
  test.setTimeout(90_000);
  await setCalendar(true);
  try {
    const { match } = await setTodayEvents();
    await navigateToMeetings(dashboardPage);
    const fileName = `Atlas Weekly Sync (1).${FIXTURE_EXT}`;
    const filePath = join(userDataDir, fileName);
    await writeFixture(filePath);
    const before = (await listMeetings()).length;
    const callsBefore = await e2eCounter(app!, "meetingImportCalls");
    const dialog = dashboardPage.getByTestId("import-calendar-dialog");

    await withPickerFile(
      app!,
      "OPENSTYLE_E2E_MEETING_IMPORT_FILE",
      filePath,
      async () => {
        // 1. Escape cancels: no import.
        await dashboardPage.getByTestId("meetings-import-choose-file").click();
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await proofShot("import-calendar-dialog-light.png");
        await dashboardPage.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        expect(await e2eCounter(app!, "meetingImportCalls")).toBe(callsBefore);
        expect((await listMeetings()).length).toBe(before);

        if (SHOTS_DIR) {
          await setTheme("dark");
          await navigateToMeetings(dashboardPage);
        }

        // 2. Open again. The matching event ranks first, with the pill.
        await dashboardPage.getByTestId("meetings-import-choose-file").click();
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await expect(dialog).toContainText("Which meeting is this?");
        await expect(dialog).toContainText(fileName);
        const rows = dialog.getByTestId("import-calendar-event");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("Atlas Weekly Sync");
        await expect(rows.nth(0)).toContainText("Matches file name");
        await expect(rows.nth(0)).toContainText("3");
        await expect(rows.nth(1)).toContainText("Team standup");
        await expect(rows.nth(1)).not.toContainText("Matches file name");
        const link = dialog.getByTestId("import-calendar-link");
        await expect(link).toBeDisabled();

        // 3. The next day has no events; the arrows still work.
        const day = await dialog.getByTestId("import-calendar-day").innerText();
        await dialog.getByTestId("import-calendar-next-day").click();
        await expect(dialog).toContainText("No events on this day.");
        await expect(dialog.getByTestId("import-calendar-day")).not.toHaveText(
          day,
        );
        await proofShot("import-calendar-dialog-empty-dark.png");
        await dialog.getByTestId("import-calendar-prev-day").click();
        await expect(dialog.getByTestId("import-calendar-day")).toHaveText(day);
        await expect(rows).toHaveCount(2);

        // 4. Select the match and import.
        await rows.nth(0).click();
        await expect(rows.nth(0)).toHaveAttribute("aria-pressed", "true");
        await expect(link).toBeEnabled();
        await proofShot("import-calendar-dialog-dark.png");
        await link.click();
        await expect(dialog).toBeHidden();

        await expect
          .poll(async () => (await listMeetings()).length, { timeout: 15_000 })
          .toBe(before + 1);
      },
    );

    const created = (await listMeetings()).find(
      (m) => m.title === "Atlas Weekly Sync",
    );
    expect(created, "a meeting with the event title").toBeTruthy();
    const detail = await meetingDetail(created!.id);
    expect(detail).toMatchObject({
      title: "Atlas Weekly Sync",
      title_source: "calendar",
      started_at: match.start,
    });
    const calendar = detail.calendar as {
      id: string;
      start: number;
      attendees: { name: string }[];
    };
    expect(calendar.id).toBe(match.id);
    expect(calendar.start).toBe(match.start);
    expect(calendar.attendees.map((a) => a.name)).toEqual([
      "Ana Souza",
      "Bruno Lima",
      "Carla Dias",
    ]);
    // The file decoded: a real duration (about 1.5 s) from the WAV header.
    expect(detail.duration_ms as number).toBeGreaterThan(1000);
    expect(detail.duration_ms as number).toBeLessThan(2500);
    expect(await e2eCounter(app!, "meetingImportCalls")).toBe(callsBefore + 1);
  } finally {
    if (SHOTS_DIR) await setTheme("light");
    await setCalendar(false);
  }
});

test("calendar on: Skip imports with no link and the file-name title", async () => {
  test.setTimeout(60_000);
  await setCalendar(true);
  try {
    await setTodayEvents();
    await navigateToMeetings(dashboardPage);
    const filePath = join(userDataDir, `skip-check.${FIXTURE_EXT}`);
    await writeFixture(filePath);
    const before = (await listMeetings()).length;
    const dialog = dashboardPage.getByTestId("import-calendar-dialog");

    await withPickerFile(
      app!,
      "OPENSTYLE_E2E_MEETING_IMPORT_FILE",
      filePath,
      async () => {
        await dashboardPage.getByTestId("meetings-import-choose-file").click();
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        // No event matches this file name.
        await expect(dialog).not.toContainText("Matches file name");
        await dialog.getByTestId("import-calendar-skip").click();
        await expect(dialog).toBeHidden();
        await expect
          .poll(async () => (await listMeetings()).length, { timeout: 15_000 })
          .toBe(before + 1);
      },
    );

    const created = (await listMeetings()).find(
      (m) => m.title === "skip-check",
    );
    expect(created, "a meeting with the file-name title").toBeTruthy();
    const detail = await meetingDetail(created!.id);
    expect(detail).toMatchObject({ title_source: "file", calendar: null });
  } finally {
    await setCalendar(false);
  }
});
