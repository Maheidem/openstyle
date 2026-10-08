import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { writeSilentWav } from "./helpers/wav";

// ---------------------------------------------------------------------------
// Helpers (self-contained, mirrors tests/app.test.ts)
//
// Isolation: with no OPENSTYLE_E2E_SERVER_URL the suite boots the app's
// embedded server against a throwaway userData dir on its own free port
// (launchOpenstyle sets OPENSTYLE_SERVER_PORT), so an installed Openstyle on
// port 4649 is never probed or reused. Point OPENSTYLE_E2E_SERVER_URL
// (+ _TOKEN) at a standalone isolated server to run against that instead.
// ---------------------------------------------------------------------------

const EXTERNAL_SERVER_URL = process.env.OPENSTYLE_E2E_SERVER_URL?.replace(
  /\/+$/,
  "",
);
const EXTERNAL_SERVER_TOKEN = process.env.OPENSTYLE_E2E_SERVER_TOKEN ?? "";

let app: ElectronApplication | undefined;
let dashboardPage: Page;
let userDataDir: string;

function apiBase(): string {
  return EXTERNAL_SERVER_URL ?? embeddedServerUrl(app!);
}

function apiHeaders(): Record<string, string> {
  return EXTERNAL_SERVER_TOKEN
    ? { Authorization: `Bearer ${EXTERNAL_SERVER_TOKEN}` }
    : {};
}

/**
 * Writes a 16 kHz mono WAV of real synthesized speech via macOS `say` +
 * `afconvert` (both present on this Mac). Digital silence is transcribed
 * as empty text by the ASR pipeline, which short-circuits before writing
 * a history row (`transcription-pipeline.ts`'s `!rawText.trim()` early
 * return) — so the ts_f1205eea/ts_12d99b08 "transcript + history row"
 * assertions need actual speech content, not silence. Falls back to the
 * silent WAV (and lets the test skip the history/clipboard assertions
 * naturally via the no-model branch) if `say`/`afconvert` are unavailable.
 */
function writeSpeechWav(path: string): boolean {
  if (!existsSync("/usr/bin/say") || !existsSync("/usr/bin/afconvert")) {
    return false;
  }
  const aiffPath = `${path}.aiff`;
  try {
    execFileSync("/usr/bin/say", [
      "-o",
      aiffPath,
      "This is a test recording for the import screen.",
    ]);
    execFileSync("/usr/bin/afconvert", [
      "-f",
      "WAVE",
      "-d",
      "LEI16@16000",
      "-c",
      "1",
      aiffPath,
      path,
    ]);
    return existsSync(path);
  } catch {
    return false;
  }
}

async function getHistoryCount(): Promise<number> {
  const res = await fetch(`${apiBase()}/api/history?limit=1`, {
    headers: apiHeaders(),
  });
  expect(res.ok).toBe(true);
  const json = (await res.json()) as { total: number };
  return json.total;
}

/** Add an own server and return its id. A 409 answers with the existing id. */
async function addServer(url: string): Promise<string | null> {
  const res = await fetch(`${apiBase()}/api/servers`, {
    method: "POST",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok && res.status !== 409) return null;
  const body = (await res.json()) as { id?: string };
  return body.id ?? null;
}

async function hasDefaultVoiceModel(): Promise<boolean> {
  const res = await fetch(`${apiBase()}/api/models/configured`, {
    headers: apiHeaders(),
  });
  expect(res.ok).toBe(true);
  const rows = (await res.json()) as {
    model_id: string;
    type: string;
    is_default: number;
  }[];
  const row = rows.find((r) => r.type === "voice" && r.is_default === 1);
  if (!row) return false;
  // The DB row alone doesn't mean the model is actually usable: POST
  // /api/models/configured inserts unconditionally with no health check
  // (apps/server/src/routes/models.ts). On CI there's no oMLX server, so
  // the row exists but every request against it will fail. GET /api/servers
  // probes every server live, so its `reachable` flag is the real answer.
  const serverId = row.model_id.split("/")[1];
  const serversRes = await fetch(`${apiBase()}/api/servers`, {
    headers: apiHeaders(),
  });
  if (!serversRes.ok) return false;
  const servers = (await serversRes.json()) as {
    id: string;
    reachable: boolean;
  }[];
  return servers.some((s) => s.id === serverId && s.reachable);
}

/**
 * Probes a raw oMLX base URL's /v1/models with a short timeout, so an
 * unreachable server fails fast instead of hanging the caller.
 */
async function probeOmlxReachable(baseUrl: string): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The exact string the renderer shows for import.error.config (read from
 * the source of truth — en.json — rather than duplicating/guessing it). */
const IMPORT_ERROR_CONFIG_TEXT: string = (() => {
  const en = JSON.parse(
    readFileSync(
      resolve(__dirname, "../src/renderer/src/locales/en.json"),
      "utf-8",
    ),
  ) as { import: { error: { config: string } } };
  return en.import.error.config;
})();

async function navigateToImport(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Import" }).click();
  await page.waitForURL(/\/import/);
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-import-"));

  // Fresh userData means onboarding is active by default (main/index.ts
  // isOnboardingActive), which would route the dashboard window to
  // /onboarding instead of the app shell this suite navigates. Pre-seed
  // settings.json so the app opens straight to the dashboard, matching the
  // "already onboarded real user" scenario these tests exercise.
  const seededSettings: Record<string, unknown> = {
    onboardingComplete: true,
  };
  if (EXTERNAL_SERVER_URL) {
    seededSettings.serverUrl = EXTERNAL_SERVER_URL;
    if (EXTERNAL_SERVER_TOKEN)
      seededSettings.serverToken = EXTERNAL_SERVER_TOKEN;
  }
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify(seededSettings),
  );

  try {
    app = await launchOpenstyle({ userDataDir });

    dashboardPage = await waitForDashboardWindow(app, 15_000);
    try {
      await dashboardPage.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      await dashboardPage.waitForLoadState("load", { timeout: 10_000 });
    }

    // Probe oMLX reachability FIRST, before seeding anything. Seeding
    // a server + a default voice model unconditionally (as this used
    // to do) leaves a real, "configured" model row in the DB even when the
    // oMLX server is unreachable (e.g. in CI) — the app then attempts a
    // real transcription request and surfaces a "transcription failed /
    // server unreachable" error instead of the "no voice model configured"
    // config error the tests expect for that branch. Only seed when the
    // probe succeeds; otherwise leave the DB empty so the server's 400 "No
    // voice model configured…" response (and the matching UI config-error
    // copy) is what actually gets exercised.
    const omlxBaseUrl = "http://127.0.0.1:8123";
    // Set OPENSTYLE_E2E_OMLX_URL to an unreachable address (for example
    // `http://127.0.0.1:1`) to force the "oMLX unreachable" branch. This
    // simulates CI, which has no oMLX server:
    //   OPENSTYLE_E2E_OMLX_URL=http://127.0.0.1:1 npx playwright test tests/import-screen.test.ts
    const reachable = await probeOmlxReachable(
      process.env.OPENSTYLE_E2E_OMLX_URL || omlxBaseUrl,
    );

    if (reachable) {
      console.log(
        "import-screen beforeAll: oMLX reachable — seeding default voice model (success branch)",
      );
      try {
        const serverId = await addServer(omlxBaseUrl);
        if (!serverId) {
          console.warn(
            "import-screen: oMLX server seeding failed — tests will exercise the no-model branch",
          );
        } else {
          const res = await fetch(`${apiBase()}/api/models/configured`, {
            method: "POST",
            headers: { ...apiHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: "server",
              model_id: `server/${serverId}/Qwen3-ASR`,
              model_name: "Qwen3-ASR",
              type: "voice",
              is_default: true,
            }),
          });
          if (!res.ok) {
            console.warn(
              `import-screen: voice model seeding failed (status ${res.status}) — tests will exercise the no-model branch`,
            );
          }
        }
      } catch (seedError) {
        console.warn(
          "import-screen: voice model seeding failed — tests will exercise the no-model branch",
          seedError,
        );
      }
    } else {
      console.log(
        "import-screen beforeAll: oMLX unreachable — seeding nothing (config-error branch)",
      );
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

test("rejects a .txt drop before any upload (ts_9e6ec1de)", async () => {
  test.setTimeout(30_000);
  await navigateToImport(dashboardPage);

  const countBefore = await getHistoryCount();
  const callsBefore = await e2eCounter(app!, "importCalls");

  await dropFile(dashboardPage, "import-dropzone", "note.txt", "text/plain");

  const alert = dashboardPage.getByTestId("import-error");
  await expect(alert).toBeVisible({ timeout: 5_000 });
  const alertText = (await alert.textContent()) ?? "";
  expect(alertText).toContain("Unsupported format");
  expect(alertText).toContain(".txt");

  const countAfter = await getHistoryCount();
  expect(countAfter).toBe(countBefore);

  const callsAfter = await e2eCounter(app!, "importCalls");
  expect(callsAfter).toBe(callsBefore);

  // reset for the next test
  await dashboardPage.getByTestId("import-error").getByRole("button").click();
});

let voiceModelConfigured = false;

test("picker upload transcribes or reports missing voice model (ts_f1205eea / ts_12d99b08)", async () => {
  test.setTimeout(30_000);
  await navigateToImport(dashboardPage);

  const wavPath = join(userDataDir, "sample.wav");
  if (!writeSpeechWav(wavPath)) {
    writeSilentWav(wavPath);
  }

  voiceModelConfigured = await hasDefaultVoiceModel();

  const countBefore = await getHistoryCount();

  await withPickerFile(app!, "OPENSTYLE_E2E_IMPORT_FILE", wavPath, async () => {
    await dashboardPage.getByTestId("import-choose-file").click();

    // UX-A3 review step: the picker landing shows the staged file and its
    // expected weight before the upload begins; Transcribe file starts it.
    const startButton = dashboardPage.getByTestId("import-start");
    await expect(startButton).toBeVisible({ timeout: 5_000 });
    await expect(
      dashboardPage.getByTestId("import-review-weight"),
    ).toBeVisible();
    await startButton.click();

    // No progress-card-visible assertion here: with a reachable oMLX on this
    // machine the whole round trip (upload + STT of a ~1 s clip) can finish
    // before Playwright's first poll observes the transient uploading state —
    // same rationale as the corrupt-file test below. The cancel test below
    // asserts the progress card deterministically against a park server.

    if (voiceModelConfigured) {
      console.log(
        "import-screen test 2: success branch (voice model configured)",
      );
      await expect(dashboardPage.getByTestId("import-transcript")).toBeVisible({
        timeout: 15_000,
      });

      const copyButton = dashboardPage.getByTestId("import-copy");
      await copyButton.click();
      // Wait for the copied-state icon swap so we read the clipboard only
      // after the async navigator.clipboard.writeText() has resolved.
      await expect(copyButton.locator("svg.lucide-check")).toBeVisible({
        timeout: 5_000,
      });
      const clipboardText = await app!.evaluate(({ clipboard }) =>
        clipboard.readText(),
      );
      const transcriptText = await dashboardPage
        .getByTestId("import-transcript")
        .locator("p.select-text")
        .textContent();
      expect(clipboardText).toBe(transcriptText);

      const countAfter = await getHistoryCount();
      expect(countAfter).toBe(countBefore + 1);

      await dashboardPage.getByTestId("import-reset").click();
    } else {
      console.log(
        "import-screen test 2: config-error branch (no default voice model)",
      );
      const alert = dashboardPage.getByTestId("import-error");
      await expect(alert).toBeVisible({ timeout: 15_000 });
      const alertText = (await alert.textContent()) ?? "";
      // The renderer maps HTTP 400 to the generic "not configured" copy
      // (import.error.config) rather than surfacing the server's literal "No
      // voice model configured..." string — result.error is never read by
      // pages/import.tsx, only result.detail, which the 400 response does
      // not set. Documented as a stage limitation rather than fixed here
      // (out of scope for U6). Assert the actual rendered i18n string rather
      // than a substring guess.
      expect(alertText).toContain(IMPORT_ERROR_CONFIG_TEXT);

      const countAfter = await getHistoryCount();
      expect(countAfter).toBe(countBefore);

      await dashboardPage
        .getByTestId("import-error")
        .getByRole("button")
        .click();
    }
  });
});

test("corrupt file reports a decode error (ts_307c89e8)", async () => {
  test.setTimeout(30_000);
  test.skip(
    !voiceModelConfigured,
    "No default voice model configured — decode errors only surface past the model-configured gate, so this scenario is unreachable in this environment.",
  );

  await navigateToImport(dashboardPage);

  const junkPath = join(userDataDir, "junk.mp3");
  const junk = Buffer.alloc(4096);
  for (let i = 0; i < junk.length; i++)
    junk[i] = Math.floor(Math.random() * 256);
  writeFileSync(junkPath, junk);

  const countBefore = await getHistoryCount();

  await withPickerFile(
    app!,
    "OPENSTYLE_E2E_IMPORT_FILE",
    junkPath,
    async () => {
      await dashboardPage.getByTestId("import-choose-file").click();
      await dashboardPage.getByTestId("import-start").click();
      // No status-visible assertion here: unlike the network round trip in the
      // picker test above, local decode failure can resolve before the next
      // Playwright poll observes the transient "uploading" status — go straight
      // to the terminal error state.
      const alert = dashboardPage.getByTestId("import-error");
      await expect(alert).toBeVisible({ timeout: 15_000 });
      const alertText = (await alert.textContent()) ?? "";
      expect(alertText).toContain("Could not decode this file");

      const countAfter = await getHistoryCount();
      expect(countAfter).toBe(countBefore);
    },
  );
});

// ---------------------------------------------------------------------------
// UX-04 (specs/lean-audit-2026-09.md §3 T1-2): cancel + completion. Both
// drive the STT backend through a local HTTP server this file owns, so they
// are deterministic in CI (no oMLX server, no `say`) and don't depend on the
// beforeAll oMLX probe outcome: the owned server is added as an own server and
// one of its models becomes the default voice model.
// ---------------------------------------------------------------------------

interface OwnedSttServer {
  port: number;
  close: () => Promise<void>;
}

/** A loopback server this test owns; every socket is tracked so teardown can
 * sever parked requests instead of waiting out server-side timeouts. */
async function startOwnedSttServer(
  respond: (
    req: import("node:http").IncomingMessage,
    res: ServerResponse,
  ) => void,
): Promise<OwnedSttServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    // Answer the probe of POST /api/servers (the model list) at once. Every
    // other request goes to `respond`.
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      const isStatus = req.url.startsWith("/v1/models/status");
      res.writeHead(isStatus ? 404 : 200, {
        "Content-Type": "application/json",
      });
      res.end(
        isStatus
          ? "{}"
          : JSON.stringify({ data: [{ id: "owned-test-model" }] }),
      );
      return;
    }
    // Consume the (possibly large) multipart body so the request settles.
    req.resume();
    req.on("end", () => respond(req, res));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await new Promise<number>((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Add `base` as an own server, then make a model of it the default voice
 * model. The owned server answers the probe of POST /api/servers. */
async function pointDefaultVoiceModelAt(base: string): Promise<void> {
  const serverId = await addServer(base);
  expect(serverId, `POST /api/servers ${base}`).not.toBeNull();
  const res = await fetch(`${apiBase()}/api/models/configured`, {
    method: "POST",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "server",
      model_id: `server/${serverId}/owned-test-model`,
      model_name: "Owned test model",
      type: "voice",
      is_default: true,
    }),
  });
  expect(res.ok, `POST models/configured -> ${res.status}`).toBe(true);
}

test("cancelling an in-flight import returns to the dropzone (UX-04)", async () => {
  test.setTimeout(60_000);
  await navigateToImport(dashboardPage);

  // Park server: accepts the STT request and never answers, so the import
  // reliably sits mid-pipeline when Cancel is clicked.
  const parked: ServerResponse[] = [];
  const park = await startOwnedSttServer((_req, res) => {
    parked.push(res);
  });
  try {
    await pointDefaultVoiceModelAt(`http://127.0.0.1:${park.port}`);

    const wavPath = join(userDataDir, "cancel-import.wav");
    writeSilentWav(wavPath);
    const countBefore = await getHistoryCount();

    await withPickerFile(
      app!,
      "OPENSTYLE_E2E_IMPORT_FILE",
      wavPath,
      async () => {
        await dashboardPage.getByTestId("import-choose-file").click();
        await dashboardPage.getByTestId("import-start").click();

        // The progress card is up with the elapsed readout and an enabled Cancel;
        // the old static line (bare `import-status` outside a card) is gone.
        const progress = dashboardPage.getByTestId("import-progress");
        await expect(progress).toBeVisible({ timeout: 10_000 });
        await expect(dashboardPage.getByTestId("import-elapsed")).toBeVisible();
        const cancelButton = dashboardPage.getByTestId("import-cancel");
        await expect(cancelButton).toBeEnabled();

        await cancelButton.click();

        // A cancel is not an error: the empty dropzone comes back, no error card,
        // and no history row was written (the parked STT request never finished).
        await expect(dashboardPage.getByTestId("import-dropzone")).toBeVisible({
          timeout: 10_000,
        });
        await expect(progress).toHaveCount(0);
        await expect(dashboardPage.getByTestId("import-error")).toHaveCount(0);
        const countAfter = await getHistoryCount();
        expect(countAfter).toBe(countBefore);
      },
    );
  } finally {
    await park.close();
  }
});

test("a completed import raises the completion notification (UX-04)", async () => {
  test.setTimeout(60_000);
  await navigateToImport(dashboardPage);

  // Mock oMLX: answers the transcription request with a fixed transcript, so
  // the full pipeline (upload → decode → STT → history row) completes without
  // any external dependency — CI included.
  const mock = await startOwnedSttServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ text: "mock transcript from the completion test" }),
    );
  });
  try {
    await pointDefaultVoiceModelAt(`http://127.0.0.1:${mock.port}`);

    const wavPath = join(userDataDir, "notify-import.wav");
    writeSilentWav(wavPath);
    const countBefore = await getHistoryCount();
    const notesBefore = await e2eCounter(app!, "importNotifications");

    await withPickerFile(
      app!,
      "OPENSTYLE_E2E_IMPORT_FILE",
      wavPath,
      async () => {
        await dashboardPage.getByTestId("import-choose-file").click();
        await dashboardPage.getByTestId("import-start").click();

        await expect(
          dashboardPage.getByTestId("import-transcript"),
        ).toBeVisible({
          timeout: 20_000,
        });

        // The main process raised exactly one "Transcript ready" notification
        // (counted before the OS-support guard so this asserts deterministically
        // even where notifications are suppressed).
        const notesAfter = await e2eCounter(app!, "importNotifications");
        expect(notesAfter).toBe(notesBefore + 1);

        const countAfter = await getHistoryCount();
        expect(countAfter).toBe(countBefore + 1);

        await dashboardPage.getByTestId("import-reset").click();
      },
    );
  } finally {
    await mock.close();
  }
});
