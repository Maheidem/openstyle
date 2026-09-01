import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
// ---------------------------------------------------------------------------

let app: ElectronApplication | undefined;
let dashboardPage: Page;
let serverPort: number;
let userDataDir: string;

const DEFAULT_PORT = 4649;

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

async function getHistoryCount(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/history?limit=1`);
  expect(res.ok).toBe(true);
  const json = (await res.json()) as { total: number };
  return json.total;
}

async function hasDefaultVoiceModel(port: number): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/api/models/configured`);
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
  return isOmlxReachable(port);
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

async function isOmlxReachable(port: number): Promise<boolean> {
  try {
    const settingsRes = await fetch(
      `http://127.0.0.1:${port}/api/settings/omlx_base_url`,
    );
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
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-import-"));
  const dbPath = join(userDataDir, "freestyle.db");

  // Fresh userData means onboarding is active by default (main/index.ts
  // isOnboardingActive), which would route the dashboard window to
  // /onboarding instead of the app shell this suite navigates. Pre-seed
  // settings.json so the app opens straight to the dashboard, matching the
  // "already onboarded real user" scenario these tests exercise.
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
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
        const urlRes = await fetch(
          `http://127.0.0.1:${serverPort}/api/settings/omlx_base_url`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: omlxBaseUrl }),
          },
        );
        if (!urlRes.ok) {
          console.warn(
            `import-screen: oMLX base URL seeding failed (status ${urlRes.status}) — tests will exercise the no-model branch`,
          );
        }

        const res = await fetch(
          `http://127.0.0.1:${serverPort}/api/models/configured`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: "omlx",
              model_id: "omlx/Qwen3-ASR",
              model_name: "Qwen3-ASR",
              type: "voice",
              is_default: true,
            }),
          },
        );
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

  const countBefore = await getHistoryCount(serverPort);
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

  const countAfter = await getHistoryCount(serverPort);
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

  voiceModelConfigured = await hasDefaultVoiceModel(serverPort);

  const countBefore = await getHistoryCount(serverPort);

  await app.evaluate((_electron, path) => {
    process.env.OPENSTYLE_E2E_IMPORT_FILE = path;
  }, wavPath);

  await dashboardPage.getByTestId("import-choose-file").click();

  if (voiceModelConfigured) {
    // The transcription round trip to a real oMLX server takes long enough
    // that the transient "uploading" status is reliably observable.
    await expect(dashboardPage.getByTestId("import-status")).toBeVisible({
      timeout: 5_000,
    });
  } else {
    // The no-model-configured error is a fast local rejection (same
    // rationale as the corrupt-file test below) — it can resolve before
    // the next Playwright poll observes the transient "uploading" status,
    // so assert the terminal error state directly instead of racing it.
  }

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

    const countAfter = await getHistoryCount(serverPort);
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

    const countAfter = await getHistoryCount(serverPort);
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

  const countBefore = await getHistoryCount(serverPort);

  await app.evaluate((_electron, path) => {
    process.env.OPENSTYLE_E2E_IMPORT_FILE = path;
  }, junkPath);

  await dashboardPage.getByTestId("import-choose-file").click();
  // No status-visible assertion here: unlike the network round trip in the
  // picker test above, local decode failure can resolve before the next
  // Playwright poll observes the transient "uploading" status — go straight
  // to the terminal error state.
  const alert = dashboardPage.getByTestId("import-error");
  await expect(alert).toBeVisible({ timeout: 15_000 });
  const alertText = (await alert.textContent()) ?? "";
  expect(alertText).toContain("Could not decode this file");

  const countAfter = await getHistoryCount(serverPort);
  expect(countAfter).toBe(countBefore);

  await app.evaluate(() => {
    delete process.env.OPENSTYLE_E2E_IMPORT_FILE;
  });
});
