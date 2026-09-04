import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:http";
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
// Meeting transcribe Cancel (T1-1 renderer half, specs/lean-audit-2026-09.md
// §3): while a meeting sits in 'transcribing' the only exit used to be the
// ungated Delete. The detail view now carries a Cancel button inside the
// progress card; POST /:id/cancel-transcribe winds the job down, keeps every
// written segment, and flips the row to failed/"Cancelled by user" — the UI
// must then say the partial transcript survived and light Retry failed /
// Re-transcribe back up.
//
// Deterministically "sticking" the job needs a transcription provider whose
// requests we control the resolution of: the default voice model is pointed
// at oMLX (local-llm-ish OpenAI-compatible provider, no API key needed) with
// a base URL at a hold-server this test owns. The hold-server parks every
// request until the test releases it, so the job reliably sits at 0/2 with
// both chunk requests in flight when Cancel is clicked.
//
// Fixture WAV: two 1s 440 Hz bursts separated by a 6 s gap — same shape the
// server-side cancel tests use (tests/meetings-routes.test.ts
// buildMultiBurstWav); the 6 s gap exceeds the segmenter's 4 s merge ceiling,
// so the imported (system-channel-only) meeting deterministically produces
// exactly 2 chunks.
//
// Environment notes (mirrors tests/meeting-import.test.ts):
// - The app reuses an already-running Openstyle server on port 4649; if one
//   is healthy there at launch this suite would touch that real DB, so it
//   skips instead.
// - The copy assertions assume the English locale (like the other suites —
//   i18next falls back to en and CI runners are en).
// ---------------------------------------------------------------------------

const EXTERNAL_SERVER_URL = process.env.OPENSTYLE_E2E_SERVER_URL?.replace(
  /\/+$/,
  "",
);
const EXTERNAL_SERVER_TOKEN = process.env.OPENSTYLE_E2E_SERVER_TOKEN ?? "";

const DEFAULT_PORT = 4649;
const SAMPLE_RATE = 16_000;

let app: ElectronApplication | undefined;
let dashboardPage: Page;
let serverPort: number;
let userDataDir: string;

/** Parks every request until released; then answers exactly one pending
 * request with a valid transcription and everything else with a 500 (so the
 * second in-flight chunk fails after its retries and "Retry failed (1)" has
 * something real to retry). */
let holdServer: Server | undefined;
let holdServerPort = 0;
const parked: Array<{ res: import("node:http").ServerResponse }> = [];
let released = false;
let okAnswered = 0;

function startHoldServer(): Promise<void> {
  return new Promise((resolvePromise) => {
    holdServer = createServer((_req, res) => {
      if (!released) {
        parked.push({ res });
        return;
      }
      if (okAnswered === 0) {
        // Exactly one chunk — whichever it is — succeeds and persists, which
        // is what makes the post-cancel note read "(1 of 2 …)".
        okAnswered++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "kept partial transcript" }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "released by test" }));
    });
    holdServer.on("connection", (socket: Socket) => {
      heldSockets.add(socket);
      socket.on("close", () => heldSockets.delete(socket));
    });
    holdServer.listen(0, "127.0.0.1", () => {
      const address = holdServer?.address();
      holdServerPort =
        typeof address === "object" && address ? address.port : 0;
      resolvePromise();
    });
  });
}

const heldSockets = new Set<Socket>();

function releaseHoldServer(): void {
  released = true;
  for (const { res } of parked.splice(0)) {
    if (okAnswered === 0) {
      okAnswered++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "kept partial transcript" }));
    } else {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "released by test" }));
    }
  }
}

async function stopHoldServer(): Promise<void> {
  if (!holdServer) return;
  for (const socket of heldSockets) socket.destroy();
  await new Promise<void>((r) => holdServer?.close(() => r()));
  holdServer = undefined;
}

function apiBase(): string {
  return EXTERNAL_SERVER_URL ?? `http://127.0.0.1:${serverPort}`;
}

function apiHeaders(): Record<string, string> {
  return EXTERNAL_SERVER_TOKEN
    ? { Authorization: `Bearer ${EXTERNAL_SERVER_TOKEN}` }
    : {};
}

/** Two 1 s 440 Hz bursts with a 6 s gap (see header comment). */
function writeTwoBurstWav(path: string): void {
  const leadMs = 2000;
  const burstMs = 1000;
  const gapMs = 6000;
  const bursts = 2;
  const totalMs = leadMs + bursts * burstMs + (bursts - 1) * gapMs;
  const totalSamples = Math.round((totalMs / 1000) * SAMPLE_RATE);
  const data = Buffer.alloc(totalSamples * 2);
  for (let b = 0; b < bursts; b++) {
    const start = Math.round(
      ((leadMs + b * (burstMs + gapMs)) / 1000) * SAMPLE_RATE,
    );
    const end = Math.round(
      ((leadMs + b * (burstMs + gapMs) + burstMs) / 1000) * SAMPLE_RATE,
    );
    for (let i = start; i < end; i++) {
      const s = Math.round(
        8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE),
      );
      data.writeInt16LE(s, i * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

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

interface MeetingDetailRow {
  id: string;
  status: string;
  error: string | null;
  job: { done: number; total: number; failed: number } | null;
  segment_counts: { total: number; failed: number };
}

async function getMeeting(id: string): Promise<MeetingDetailRow> {
  const res = await fetch(`${apiBase()}/api/meetings/${id}`, {
    headers: apiHeaders(),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as MeetingDetailRow;
}

test.beforeAll(async () => {
  // Skip (rather than silently reusing) a foreign server on the default
  // port — mirrors tests/meeting-import.test.ts.
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

  await startHoldServer();

  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-meeting-cancel-"));
  const dbPath = join(userDataDir, "freestyle.db");

  const settings: Record<string, unknown> = { onboardingComplete: true };
  if (EXTERNAL_SERVER_URL) {
    settings.serverUrl = EXTERNAL_SERVER_URL;
    if (EXTERNAL_SERVER_TOKEN) settings.serverToken = EXTERNAL_SERVER_TOKEN;
  }
  writeFileSync(join(userDataDir, "settings.json"), JSON.stringify(settings));
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
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
        `Seeding the meetings flag on ${EXTERNAL_SERVER_URL} failed (HTTP ${res.status}).`,
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
        OPENSTYLE_USER_DATA: userDataDir,
        OPENSTYLE_E2E: "1",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 30_000,
    });

    await app.firstWindow();
    dashboardPage = await waitForDashboardWindow(app, 15_000);
    try {
      await dashboardPage.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      await dashboardPage.waitForLoadState("load", { timeout: 10_000 });
    }

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

    // Wait out main's one-shot boot orphan sweep (setTimeout(3000) after
    // server-up): the import below can otherwise start its transcribe job
    // inside that window, and the fixture must not depend on sweep timing.
    // (The server also excludes live jobs from /orphans — this wait keeps
    // the test deterministic regardless.)
    await new Promise((r) => setTimeout(r, 3500));

    // Point the default voice model at the hold-server via oMLX: no API key
    // required (oMLX is a local STT provider server-side), and every chunk
    // request parks until the test releases it. The renderer app and this
    // test process share the loopback interface, also in external-server
    // mode (the hold-server is reached by the *server*, not the renderer).
    const base = `http://127.0.0.1:${holdServerPort}`;
    const putBase = await fetch(`${apiBase()}/api/settings/omlx_base_url`, {
      method: "PUT",
      headers: { ...apiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ value: base }),
    });
    expect(putBase.ok, `PUT omlx_base_url -> ${putBase.status}`).toBe(true);
    const putModel = await fetch(`${apiBase()}/api/models/configured`, {
      method: "POST",
      headers: { ...apiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "omlx",
        model_id: "omlsx/hold-test-model",
        model_name: "oMLX hold-test model",
        type: "voice",
        is_default: true,
      }),
    });
    expect(putModel.ok, `POST models/configured -> ${putModel.status}`).toBe(
      true,
    );
  } catch (error) {
    console.error("Failed to launch Electron app:", error);
    if (app) {
      await app.close().catch(console.error);
      app = undefined;
    }
    await stopHoldServer();
    throw error;
  }
});

test.afterAll(async () => {
  if (!app) {
    await stopHoldServer();
    return;
  }
  const proc = app.process();
  const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  try {
    await app.close();
  } catch (error) {
    console.warn("Error closing app:", error);
    proc.kill("SIGKILL");
  } finally {
    clearTimeout(killTimer);
    await stopHoldServer();
  }
});

test("cancelling a running transcribe job keeps the partial transcript", async () => {
  test.setTimeout(120_000);
  await dashboardPage.getByRole("link", { name: "Meetings" }).click();
  await dashboardPage.waitForURL(/\/meetings/);

  const wavPath = join(userDataDir, "cancel-test.wav");
  writeTwoBurstWav(wavPath);
  await app.evaluate((_electron, path) => {
    process.env.OPENSTYLE_E2E_MEETING_IMPORT_FILE = path;
  }, wavPath);

  await dashboardPage.getByTestId("meetings-import-choose-file").click();

  // Import → detail view opens on the new meeting and auto-fires the
  // transcribe job, which parks both chunks on the hold-server: the progress
  // card is up with a 0/2 counter and the Cancel button enabled.
  const cancelButton = dashboardPage.getByTestId("meetings-cancel-transcribe");
  await expect(cancelButton).toBeVisible({ timeout: 20_000 });
  await expect(cancelButton).toBeEnabled();
  await expect(dashboardPage.getByText("Transcribing…")).toBeVisible();

  // The meeting is stuck mid-job server-side: 0 of 2 done, both in flight.
  const meetingsRes = await fetch(`${apiBase()}/api/meetings`, {
    headers: apiHeaders(),
  });
  const list = (await meetingsRes.json()) as {
    items: Array<{ id: string; title: string | null; status: string }>;
  };
  const meeting = list.items.find((m) => m.title === "cancel-test");
  expect(meeting?.status).toBe("transcribing");
  const detail = await getMeeting(meeting.id);
  expect(detail.job?.total).toBe(2);
  expect(detail.job?.done).toBe(0);

  // Cancel from the UI. waitForResponse gives the ordering guarantee the
  // release below needs: by the time the 202 is back, the server has latched
  // the cancellation flag — no race between the click and the release.
  const cancelResponse = dashboardPage.waitForResponse(
    (r) =>
      r.url().includes("/cancel-transcribe") && r.request().method() === "POST",
  );
  await cancelButton.click();
  expect((await cancelResponse).status()).toBe(202);

  // Wind-down state: the card says cancelling and the button is spent.
  await expect(dashboardPage.getByText("Cancelling…")).toBeVisible({
    timeout: 5_000,
  });
  await expect(cancelButton).toBeDisabled();

  // Release the parked chunks: exactly one succeeds (its segment persists),
  // the other fails through its retries. The job then stops launching
  // anything further and lands in failed/"Cancelled by user".
  releaseHoldServer();

  // The note must say the partial transcript survived, with real counts.
  await expect(
    dashboardPage.getByText("Cancelled — partial transcript kept"),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    dashboardPage.getByText("(1 of 2 segments transcribed)"),
  ).toBeVisible();

  // Both recovery actions are live immediately — no stale disabled state.
  await expect(
    dashboardPage.getByRole("button", { name: "Retry 1 failed" }),
  ).toBeEnabled();
  await expect(
    dashboardPage.getByRole("button", { name: "Transcribe", exact: true }),
  ).toBeEnabled();

  // Server-side truth: failed with the canonical cancel error, both segments
  // kept (one ok, one failed).
  const final = await getMeeting(meeting.id);
  expect(final.status).toBe("failed");
  expect(final.error).toBe("Cancelled by user");
  expect(final.segment_counts).toEqual({ total: 2, failed: 1 });
  // The merged transcript carries only the ok segment (failed chunks are
  // kept in meeting_segments — segment_counts above — but render empty);
  // the kept partial text is exactly what survived the cancel.
  const transcriptRes = await fetch(
    `${apiBase()}/api/meetings/${meeting.id}/transcript`,
    { headers: apiHeaders() },
  );
  const transcript = (await transcriptRes.json()) as {
    segments: Array<{ text: string }>;
  };
  expect(transcript.segments.length).toBe(1);
  expect(transcript.segments[0]?.text).toBe("kept partial transcript");

  await app.evaluate(() => {
    delete process.env.OPENSTYLE_E2E_MEETING_IMPORT_FILE;
  });
});
