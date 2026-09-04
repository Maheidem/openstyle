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
import { _electron as electron } from "playwright";

// ---------------------------------------------------------------------------
// Helpers (self-contained, mirrors tests/app.test.ts)
//
// Isolation: with no OPENSTYLE_E2E_SERVER_URL the suite boots the app's
// embedded server against a throwaway userData dir and SKIPS if a foreign
// Openstyle already owns port 4649 (the app would reuse it and touch its
// DB). Point OPENSTYLE_E2E_SERVER_URL (+ _TOKEN) at a standalone isolated
// server to run against that instead — same escape hatch as
// tests/meeting-cancel-transcribe.test.ts.
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

function apiBase(): string {
  return EXTERNAL_SERVER_URL ?? `http://127.0.0.1:${serverPort}`;
}

function apiHeaders(): Record<string, string> {
  return EXTERNAL_SERVER_TOKEN
    ? { Authorization: `Bearer ${EXTERNAL_SERVER_TOKEN}` }
    : {};
}

/**
 * Wait for a window whose URL is neither the pill nor the remix bar —
 * that's the dashboard / onboarding window. The pill (pill.html) and the
 * remix bar (bar.html) are auxiliary windows and may appear first.
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

/** Writes a minimal valid 1 s, 16 kHz mono, 16-bit PCM WAV file. */
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

async function hasDefaultVoiceModel(): Promise<boolean> {
  const res = await fetch(`${apiBase()}/api/models/configured`, {
    headers: apiHeaders(),
  });
  expect(res.ok).toBe(true);
  const rows = (await res.json()) as {
    type: string;
    is_default: number;
  }[];
  const hasRow = rows.some((r) => r.type === "voice" && r.is_default === 1);
  if (!hasRow) return false;
  // The DB row alone doesn't mean the model is actually usable: POST
  // /api/models/configured inserts unconditionally with no health check
  // (apps/server/src/routes/models.ts). On CI there's no oMLX server, so
  // the row exists but every request against it will fail — probe the
  // configured oMLX base URL's /v1/models the same way settings.ts and
  // models.ts do, with a short timeout so an unreachable server fails fast
  // instead of hanging the test.
  return isOmlxReachable();
}

/**
 * Probes a raw oMLX base URL's /v1/models the same way settings.ts and
 * models.ts do, with a short timeout so an unreachable server fails fast
 * instead of hanging beforeAll.
 *
 * Honors OPENSTYLE_E2E_OMLX_URL as an override of the base URL to probe —
 * set it to an unreachable address (e.g. `http://127.0.0.1:1`) to force
 * this suite through the "oMLX unreachable" / config-error branch locally,
 * simulating what CI (no oMLX server) sees:
 *   OPENSTYLE_E2E_OMLX_URL=http://127.0.0.1:1 npx playwright test tests/import-screen.test.ts
 */
async function probeOmlxReachable(defaultBaseUrl: string): Promise<boolean> {
  const base = (process.env.OPENSTYLE_E2E_OMLX_URL || defaultBaseUrl).replace(
    /\/+$/,
    "",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`${base}/v1/models`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function isOmlxReachable(): Promise<boolean> {
  try {
    const settingsRes = await fetch(`${apiBase()}/api/settings/omlx_base_url`, {
      headers: apiHeaders(),
    });
    if (!settingsRes.ok) return false;
    const { value } = (await settingsRes.json()) as { value?: string };
    if (!value) return false;
    const base = value.replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch(`${base}/v1/models`, {
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
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
  // Skip (rather than silently reusing) a foreign server on the default
  // port — the app's boot probe would find it, route test traffic at that
  // real instance, and touch its DB. Mirrors
  // tests/meeting-cancel-transcribe.test.ts.
  if (!EXTERNAL_SERVER_URL) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      test.skip(
        res.ok,
        `Another Openstyle server is listening on ${DEFAULT_PORT}; the app would reuse it and touch its DB. Stop it, or point this suite at an isolated server via OPENSTYLE_E2E_SERVER_URL.`,
      );
    } catch {
      // nothing listening — clean environment, proceed with the embedded server
    }
  }

  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-import-"));
  const dbPath = join(userDataDir, "freestyle.db");

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
    app = await electron.launch({
      args: [resolve(__dirname, "../out/main/index.js")],
      env: {
        ...process.env,
        NODE_ENV: "development",
        OPENSTYLE_DB_PATH: dbPath,
        // main/index.ts unconditionally rewrites OPENSTYLE_DB_PATH from
        // app.getPath("userData") before starting the server, so isolation
        // actually depends on OPENSTYLE_USER_DATA (see main/index.ts:133-138) —
        // without it this run would share the real installed app's userData
        // (and its real DB/history) instead of a throwaway temp dir.
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

    // Probe oMLX reachability FIRST, before seeding anything. Seeding
    // omlx_base_url + a default voice model unconditionally (as this used
    // to do) leaves a real, "configured" model row in the DB even when the
    // oMLX server is unreachable (e.g. in CI) — the app then attempts a
    // real transcription request and surfaces a "transcription failed /
    // server unreachable" error instead of the "no voice model configured"
    // config error the tests expect for that branch. Only seed when the
    // probe succeeds; otherwise leave the DB empty so the server's 400 "No
    // voice model configured…" response (and the matching UI config-error
    // copy) is what actually gets exercised.
    const omlxBaseUrl = "http://127.0.0.1:8123";
    const reachable = await probeOmlxReachable(omlxBaseUrl);

    if (reachable) {
      console.log(
        "import-screen beforeAll: oMLX reachable — seeding default voice model (success branch)",
      );
      try {
        const urlRes = await fetch(`${apiBase()}/api/settings/omlx_base_url`, {
          method: "PUT",
          headers: { ...apiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ value: omlxBaseUrl }),
        });
        if (!urlRes.ok) {
          console.warn(
            `import-screen: oMLX base URL seeding failed (status ${urlRes.status}) — tests will exercise the no-model branch`,
          );
        }

        const res = await fetch(`${apiBase()}/api/models/configured`, {
          method: "POST",
          headers: { ...apiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "omlx",
            model_id: "omlx/Qwen3-ASR",
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

test("rejects a .txt drop before any upload (ts_9e6ec1de)", async () => {
  test.setTimeout(30_000);
  await navigateToImport(dashboardPage);

  const countBefore = await getHistoryCount();
  const callsBefore = await app.evaluate(() => {
    const g = globalThis as { __openstyleE2E?: { importCalls: number } };
    return g.__openstyleE2E?.importCalls ?? 0;
  });

  await dashboardPage.evaluate(() => {
    const dropzone = document.querySelector(
      '[data-testid="import-dropzone"]',
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

  const alert = dashboardPage.getByTestId("import-error");
  await expect(alert).toBeVisible({ timeout: 5_000 });
  const alertText = (await alert.textContent()) ?? "";
  expect(alertText).toContain("Unsupported format");
  expect(alertText).toContain(".txt");

  const countAfter = await getHistoryCount();
  expect(countAfter).toBe(countBefore);

  const callsAfter = await app.evaluate(() => {
    const g = globalThis as { __openstyleE2E?: { importCalls: number } };
    return g.__openstyleE2E?.importCalls ?? 0;
  });
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

  await app.evaluate((_electron, path) => {
    process.env.OPENSTYLE_E2E_IMPORT_FILE = path;
  }, wavPath);

  await dashboardPage.getByTestId("import-choose-file").click();

  // UX-A3 review step: the picker landing shows the staged file and its
  // expected weight before the upload begins; Transcribe file starts it.
  const startButton = dashboardPage.getByTestId("import-start");
  await expect(startButton).toBeVisible({ timeout: 5_000 });
  await expect(dashboardPage.getByTestId("import-review-weight")).toBeVisible();
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
    const clipboardText = await app.evaluate(({ clipboard }) =>
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

    await dashboardPage.getByTestId("import-error").getByRole("button").click();
  }

  await app.evaluate(() => {
    delete process.env.OPENSTYLE_E2E_IMPORT_FILE;
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

  await app.evaluate((_electron, path) => {
    process.env.OPENSTYLE_E2E_IMPORT_FILE = path;
  }, junkPath);

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

  await app.evaluate(() => {
    delete process.env.OPENSTYLE_E2E_IMPORT_FILE;
  });
});

// ---------------------------------------------------------------------------
// UX-04 (specs/lean-audit-2026-09.md §3 T1-2): cancel + completion. Both
// drive the STT backend through a local HTTP server this file owns, so they
// are deterministic in CI (no oMLX server, no `say`) and don't depend on the
// beforeAll oMLX probe outcome: whatever default voice model exists gets its
// omlx_base_url re-pointed at the owned server.
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

/** Point the default voice model's oMLX base URL at `base`, seeding a
 * default oMLX model row first when this environment has none (CI's
 * no-oMLX branch of the beforeAll probe). */
async function pointDefaultVoiceModelAt(
  base: string,
  seedModel: boolean,
): Promise<void> {
  const putBase = await fetch(`${apiBase()}/api/settings/omlx_base_url`, {
    method: "PUT",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ value: base }),
  });
  expect(putBase.ok, `PUT omlx_base_url -> ${putBase.status}`).toBe(true);
  if (!seedModel) return;
  const res = await fetch(`${apiBase()}/api/models/configured`, {
    method: "POST",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "omlx",
      model_id: "omlx/owned-test-model",
      model_name: "oMLX owned-test model",
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
    await pointDefaultVoiceModelAt(
      `http://127.0.0.1:${park.port}`,
      !voiceModelConfigured,
    );

    const wavPath = join(userDataDir, "cancel-import.wav");
    writeSilentWav(wavPath);
    const countBefore = await getHistoryCount();

    await app.evaluate((_electron, path) => {
      process.env.OPENSTYLE_E2E_IMPORT_FILE = path;
    }, wavPath);

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
  } finally {
    await app.evaluate(() => {
      delete process.env.OPENSTYLE_E2E_IMPORT_FILE;
    });
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
    await pointDefaultVoiceModelAt(
      `http://127.0.0.1:${mock.port}`,
      !voiceModelConfigured,
    );

    const wavPath = join(userDataDir, "notify-import.wav");
    writeSilentWav(wavPath);
    const countBefore = await getHistoryCount();
    const notesBefore = await app.evaluate(() => {
      const g = globalThis as {
        __openstyleE2E?: { importNotifications?: number };
      };
      return g.__openstyleE2E?.importNotifications ?? 0;
    });

    await app.evaluate((_electron, path) => {
      process.env.OPENSTYLE_E2E_IMPORT_FILE = path;
    }, wavPath);

    await dashboardPage.getByTestId("import-choose-file").click();
    await dashboardPage.getByTestId("import-start").click();

    await expect(dashboardPage.getByTestId("import-transcript")).toBeVisible({
      timeout: 20_000,
    });

    // The main process raised exactly one "Transcript ready" notification
    // (counted before the OS-support guard so this asserts deterministically
    // even where notifications are suppressed).
    const notesAfter = await app.evaluate(() => {
      const g = globalThis as {
        __openstyleE2E?: { importNotifications?: number };
      };
      return g.__openstyleE2E?.importNotifications ?? 0;
    });
    expect(notesAfter).toBe(notesBefore + 1);

    const countAfter = await getHistoryCount();
    expect(countAfter).toBe(countBefore + 1);

    await dashboardPage.getByTestId("import-reset").click();
  } finally {
    await app.evaluate(() => {
      delete process.env.OPENSTYLE_E2E_IMPORT_FILE;
    });
    await mock.close();
  }
});
