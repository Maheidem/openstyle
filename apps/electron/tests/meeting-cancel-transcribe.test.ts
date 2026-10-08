import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { withPickerFile } from "./e2e-helpers";
import {
  closeApp,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";
import { pcm16Wav } from "./helpers/wav";

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
// at an own server (OpenAI-compatible provider, no API key needed) whose
// address is a hold-server this test owns.
//
// Staging (since phase 3a the lane is SERIAL — one chunk at a time,
// apps/server/src/lib/meetings/transcriber.ts laneWorker — so a
// single-channel meeting can never have two chunks in flight, and the old
// "park everything" staging ended with zero failed chunks and no Retry
// button): the hold-server fails the first chunk's attempts with immediate
// 500s (the transcriber retries maxAttempts=3 times, so that is exactly 3
// requests), and parks the second chunk — dispatched only after the first
// one has burned all its attempts — until the test releases it. Cancel
// lands with one failed chunk already persisted and one in flight; the
// release answers the in-flight chunk with the single 200. Final state: one
// ok segment (kept partial transcript) + one failed segment (retryable).
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
let userDataDir: string;

let holdServer: Server | undefined;
let holdServerPort = 0;
const parked: Array<{ res: import("node:http").ServerResponse }> = [];
let released = false;
let okAnswered = 0;
let sttRequests = 0;

/** How many transcription requests the FIRST chunk consumes: the
 * transcriber retries every chunk maxAttempts = 3 times
 * (apps/server/src/lib/meetings/transcriber.ts). The lane is serial, so
 * chunk 2 is dispatched only once chunk 1 has burned all three — the
 * 4th request and beyond is chunk 2. (A fresh test app declares no
 * languages, so the Phase A2 language probe — the only other STT call the
 * pipeline can make before the chunks — does not run.) */
const FIRST_CHUNK_ATTEMPTS = 3;

/** The in-flight chunk (the only one ever parked) succeeds and persists —
 * the kept partial transcript, so the post-cancel note reads
 * "(1 of 2 …)". Any other release answer would be a 500. */
function answer(res: import("node:http").ServerResponse): void {
  if (okAnswered === 0) {
    okAnswered++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "kept partial transcript" }));
    return;
  }
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "released by test" }));
}

function startHoldServer(): Promise<void> {
  return new Promise((resolvePromise) => {
    holdServer = createServer((req, res) => {
      // The probe of POST /api/servers lists the models. Answer it at once;
      // only transcription POSTs are counted/staged.
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        const isStatus = req.url.startsWith("/v1/models/status");
        res.writeHead(isStatus ? 404 : 200, {
          "Content-Type": "application/json",
        });
        res.end(
          isStatus
            ? "{}"
            : JSON.stringify({ data: [{ id: "hold-test-model" }] }),
        );
        return;
      }
      sttRequests += 1;
      if (sttRequests <= FIRST_CHUNK_ATTEMPTS) {
        // Chunk 1's attempts: fail at once so the serial lane moves on to
        // chunk 2 quickly (one 500 per attempt, three attempts).
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forced 500 for the cancel test" }));
        return;
      }
      if (!released) {
        // Chunk 2 (and beyond): park until the test releases it.
        parked.push({ res });
        return;
      }
      answer(res);
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
    answer(res);
  }
}

async function stopHoldServer(): Promise<void> {
  if (!holdServer) return;
  for (const socket of heldSockets) socket.destroy();
  await new Promise<void>((r) => holdServer?.close(() => r()));
  holdServer = undefined;
}

function apiBase(): string {
  return EXTERNAL_SERVER_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;
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
  const samples = new Int16Array(totalSamples);
  for (let b = 0; b < bursts; b++) {
    const start = Math.round(
      ((leadMs + b * (burstMs + gapMs)) / 1000) * SAMPLE_RATE,
    );
    const end = Math.round(
      ((leadMs + b * (burstMs + gapMs) + burstMs) / 1000) * SAMPLE_RATE,
    );
    for (let i = start; i < end; i++) {
      samples[i] = Math.round(
        8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE),
      );
    }
  }
  writeFileSync(path, pcm16Wav(samples, SAMPLE_RATE));
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
    app = await launchOpenstyle({ userDataDir });
    dashboardPage = await waitForDashboardWindow(app, 15_000);
    try {
      await dashboardPage.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      await dashboardPage.waitForLoadState("load", { timeout: 10_000 });
    }

    // Wait out main's one-shot boot orphan sweep (setTimeout(3000) after
    // server-up): the import below can otherwise start its transcribe job
    // inside that window, and the fixture must not depend on sweep timing.
    // (The server also excludes live jobs from /orphans — this wait keeps
    // the test deterministic regardless.)
    await new Promise((r) => setTimeout(r, 3500));

    // Point the default voice model at the hold-server as an own server: no
    // API key required, and every chunk request parks until the test
    // releases it. The renderer app and this test process share the loopback
    // interface, also in external-server mode (the hold-server is reached by
    // the *server*, not the renderer).
    const base = `http://127.0.0.1:${holdServerPort}`;
    const addServer = await fetch(`${apiBase()}/api/servers`, {
      method: "POST",
      headers: { ...apiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ url: base }),
    });
    expect(addServer.status, `POST /api/servers -> ${addServer.status}`).toBe(
      201,
    );
    const { id: serverId } = (await addServer.json()) as { id: string };
    const putModel = await fetch(`${apiBase()}/api/models/configured`, {
      method: "POST",
      headers: { ...apiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "server",
        model_id: `server/${serverId}/hold-test-model`,
        model_name: "Hold-test model",
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
  await closeApp(app);
  await stopHoldServer();
});

test("cancelling a running transcribe job keeps the partial transcript", async () => {
  test.setTimeout(120_000);
  await dashboardPage.getByRole("link", { name: "Meetings" }).click();
  await dashboardPage.waitForURL(/\/meetings/);

  const wavPath = join(userDataDir, "cancel-test.wav");
  writeTwoBurstWav(wavPath);
  await withPickerFile(
    app!,
    "OPENSTYLE_E2E_MEETING_IMPORT_FILE",
    wavPath,
    async () => {
      await dashboardPage.getByTestId("meetings-import-choose-file").click();

      // Import → detail view opens on the new meeting and auto-fires the
      // transcribe job: the lane is serial, so chunk 1 burns its attempts on
      // immediate 500s and chunk 2 parks on the hold-server. The progress
      // card is up with the Cancel button enabled.
      const cancelButton = dashboardPage.getByTestId(
        "meetings-cancel-transcribe",
      );
      await expect(cancelButton).toBeVisible({ timeout: 20_000 });
      await expect(cancelButton).toBeEnabled();
      await expect(dashboardPage.getByText("Transcribing…")).toBeVisible();

      // The meeting is stuck mid-job server-side: 2 planned chunks, none
      // finished (chunk 1 is failing through its retries, chunk 2 is about
      // to be dispatched).
      const meetingsRes = await fetch(`${apiBase()}/api/meetings`, {
        headers: apiHeaders(),
      });
      const list = (await meetingsRes.json()) as {
        items: Array<{ id: string; title: string | null; status: string }>;
      };
      const meeting = list.items.find((m) => m.title === "cancel-test");
      expect(meeting?.status).toBe("transcribing");
      const detail = await getMeeting(meeting!.id);
      expect(detail.job?.total).toBe(2);
      expect(detail.job?.done).toBeLessThan(2);

      // Wait until chunk 2 is actually in flight (parked on the hold
      // server): a cancel that lands earlier — during chunk 1's retry
      // backoff — would never dispatch chunk 2, and the meeting would wind
      // down with no in-flight chunk to keep (0 of 2, not 1 of 2).
      const parkDeadline = Date.now() + 30_000;
      while (parked.length < 1) {
        if (Date.now() > parkDeadline) {
          throw new Error("chunk 2 never reached the hold server");
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      // Cancel from the UI. waitForResponse gives the ordering guarantee the
      // release below needs: by the time the 202 is back, the server has latched
      // the cancellation flag — no race between the click and the release.
      const cancelResponse = dashboardPage.waitForResponse(
        (r) =>
          r.url().includes("/cancel-transcribe") &&
          r.request().method() === "POST",
      );
      await cancelButton.click();
      expect((await cancelResponse).status()).toBe(202);

      // Wind-down state: the card says cancelling and the button is spent.
      await expect(dashboardPage.getByText("Cancelling…")).toBeVisible({
        timeout: 5_000,
      });
      await expect(cancelButton).toBeDisabled();

      // Release the in-flight chunk: it succeeds (its segment persists —
      // the kept partial transcript), while chunk 1 is already a failed
      // segment. The job lands in failed/"Cancelled by user" with one ok
      // and one failed chunk.
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
      const final = await getMeeting(meeting!.id);
      expect(final.status).toBe("failed");
      expect(final.error).toBe("Cancelled by user");
      expect(final.segment_counts).toEqual({ total: 2, failed: 1 });
      // The merged transcript carries only the ok segment (failed chunks are
      // kept in meeting_segments — segment_counts above — but render empty);
      // the kept partial text is exactly what survived the cancel.
      const transcriptRes = await fetch(
        `${apiBase()}/api/meetings/${meeting!.id}/transcript`,
        { headers: apiHeaders() },
      );
      const transcript = (await transcriptRes.json()) as {
        segments: Array<{ text: string }>;
      };
      expect(transcript.segments.length).toBe(1);
      expect(transcript.segments[0]?.text).toBe("kept partial transcript");
    },
  );
});
