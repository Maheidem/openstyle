import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { e2eCounter } from "./e2e-helpers";
import {
  closeApp,
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";
import { openMeeting, seedMeeting } from "./helpers/enhance-fixture";
import { pcm16Wav } from "./helpers/wav";

// ---------------------------------------------------------------------------
// The selected local model is not on the disk (owner report 2026-11-05: "I had
// absolutely no visual cue that it was not working, that the model was not
// there"). The app has the built-in LLM Gemma 4 E2B selected and an EMPTY
// Hugging Face cache. The spec proves in the real app:
//   1. GET /api/models/missing names the model and its tasks;
//   2. the sidebar shows Models with a badge (advanced mode is off);
//   3. Today and Ask show the banner;
//   4. a real Enhance run fails with the kind model_missing, and the card says
//      "<Model> is not downloaded. Download it in Models." with the button;
//      it never says "internal error";
//   5. the button opens the Models page at the model: the Download card;
//   6. a dictation (fake own STT server) keeps the raw text, the main process
//      gets ONE notification for the session, the history row says
//      cleanup_skipped and the History page shows the mark;
//   7. a fake model folder in the isolated cache removes every cue.
// All data is fictional. Screenshots (light and dark) go to
// OPENSTYLE_EVIDENCE_DIR when it is set.
// ---------------------------------------------------------------------------

const MODEL_ID = "gemma-4-e2b-qat-4bit";
const MODEL_NAME = "Gemma 4 E2B";
const MODEL_HF = "mlx-community/gemma-4-E2B-it-qat-4bit";
const SEEDED_ID = "e2e-model-missing";
const SEEDED_TITLE = "Pricing workshop";
const STT_TEXT = "um we should send the pricing sheet to the pilot team today";

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let hubDir: string;
let base: string;

let stt: Server | undefined;
let sttPort = 0;
const sttSockets = new Set<Socket>();

function startStt(): Promise<void> {
  return new Promise((done) => {
    stt = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        const isStatus = req.url.startsWith("/v1/models/status");
        res.writeHead(isStatus ? 404 : 200, {
          "Content-Type": "application/json",
        });
        res.end(
          isStatus ? "{}" : JSON.stringify({ data: [{ id: "fake-stt" }] }),
        );
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: STT_TEXT }));
      });
    });
    stt.on("connection", (socket) => {
      sttSockets.add(socket);
      socket.on("close", () => sttSockets.delete(socket));
    });
    stt.listen(0, "127.0.0.1", () => {
      const address = stt?.address();
      sttPort = typeof address === "object" && address ? address.port : 0;
      done();
    });
  });
}

async function stopStt(): Promise<void> {
  if (!stt) return;
  for (const socket of sttSockets) socket.destroy();
  await new Promise<void>((done) => stt?.close(() => done()));
  stt = undefined;
}

function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function putSetting(key: string, value: string): Promise<void> {
  const res = await api("PUT", `/settings/${key}`, { value });
  expect(res.status, `PUT /api/settings/${key}`).toBe(200);
}

async function setTheme(theme: "light" | "dark"): Promise<void> {
  await page.evaluate((t) => localStorage.setItem("theme", t), theme);
  await page.reload();
  await page.waitForLoadState("load");
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(theme === "dark");
}

/** One screenshot in each theme. The page keeps its URL across the reload. */
async function shootBoth(name: string, ready: () => Promise<void>) {
  const dir = process.env.OPENSTYLE_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await ready();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(dir, `${name}-${theme}.png`) });
  }
  await setTheme("light");
}

/** The model folder that the app checks: a snapshot with two files. */
function putFakeModel(): void {
  const snapshot = join(
    hubDir,
    `models--${MODEL_HF.replaceAll("/", "--")}`,
    "snapshots",
    "e2e",
  );
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, "config.json"), "{}");
  writeFileSync(join(snapshot, "model.safetensors"), "w");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await startStt();
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-model-missing-"));
  hubDir = join(userDataDir, "hf", "hub");
  mkdirSync(hubDir, { recursive: true });
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  // An empty Hugging Face cache of its own: the real cache is never read.
  app = await launchOpenstyle({
    userDataDir,
    env: {
      HF_HOME: join(userDataDir, "hf"),
      HUGGINGFACE_HUB_CACHE: hubDir,
    },
  });
  page = await waitForDashboardWindow(app, 15_000);
  try {
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  } catch {
    await page.waitForLoadState("load", { timeout: 10_000 });
  }
  // Main's boot orphan sweep runs 3 s after the server starts.
  await new Promise((r) => setTimeout(r, 3500));
  base = embeddedServerUrl(app);

  // A voice model on an own server (the fake STT), so a dictation can run.
  const added = await api("POST", "/servers", {
    url: `http://127.0.0.1:${sttPort}`,
  });
  expect(added.status, "POST /api/servers").toBe(201);
  const { id: serverId } = (await added.json()) as { id: string };
  const voice = await api("POST", "/models/configured", {
    provider: "server",
    model_id: `server/${serverId}/fake-stt`,
    model_name: "Fake STT",
    type: "voice",
    is_default: true,
  });
  expect(voice.ok, "POST voice model").toBe(true);
  // The selected LLM: the built-in Gemma 4 E2B, which is not on the disk.
  const llm = await api("POST", "/models/configured", {
    provider: "local-mlx-llm",
    model_id: `local-mlx-llm/${MODEL_ID}`,
    model_name: MODEL_NAME,
    type: "llm",
    is_default: true,
  });
  expect(llm.ok, "POST llm model").toBe(true);
  await putSetting("llm_cleanup", "true");
  await putSetting("cleanup_intensity", "medium");
  await putSetting("meeting_enhance_prompt_seen", "true");
  await putSetting("meeting_chat_enabled", "true");

  seedMeeting(userDataDir, SEEDED_ID, SEEDED_TITLE, [
    {
      source: "mic",
      label: null,
      text: "We should review the pricing sheet before the pilot starts.",
    },
    {
      source: "system",
      label: "1",
      text: "The pilot team wants the new tiers by Friday.",
    },
  ]);
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  await stopStt();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test("the server names the missing model and its tasks", async () => {
  const res = await api("GET", "/models/missing");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{
    engine: string;
    defId: string;
    name: string;
    tasks: string[];
  }>;
  expect(body).toHaveLength(1);
  expect(body[0]).toMatchObject({
    engine: "mlx-llm",
    defId: MODEL_ID,
    name: MODEL_NAME,
  });
  expect(body[0]?.tasks).toEqual(
    expect.arrayContaining([
      "cleanup",
      "meetingEnhance",
      "meetingSummarize",
      "ask",
    ]),
  );
});

test("the sidebar shows Models with a badge, also with advanced mode off", async () => {
  const advanced = await (await api("GET", "/settings")).json();
  expect((advanced as Record<string, string>).advanced_mode).not.toBe("true");
  await page.goto("app://renderer/today");
  await page.waitForLoadState("load");
  const link = page.getByRole("link", { name: /^Models/ });
  await expect(link).toBeVisible({ timeout: 15_000 });
  const badge = page.getByTestId("nav-models-missing-badge");
  await expect(badge).toHaveText("1");
  await expect(badge).toHaveAttribute("aria-label", "Not downloaded: 1");
  await shootBoth("1-nav-badge", async () => {
    await expect(page.getByTestId("nav-models-missing-badge")).toBeVisible();
  });
});

test("Today shows the banner with the model name", async () => {
  await page.goto("app://renderer/today");
  await page.waitForLoadState("load");
  const banner = page.getByTestId("missing-model-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(`${MODEL_NAME} is not downloaded.`);
  await expect(banner).toContainText("Text cleanup");
  await shootBoth("2-today-banner", async () => {
    await expect(page.getByTestId("missing-model-banner")).toBeVisible();
  });
});

test("a real Enhance run fails with model_missing and the card says so", async () => {
  test.setTimeout(120_000);
  await openMeeting(page, SEEDED_TITLE);
  const enhance = page.getByRole("button", { name: "Enhance", exact: true });
  await expect(enhance).toBeEnabled({ timeout: 15_000 });
  // The meeting page shows the banner before any run.
  await expect(page.getByTestId("missing-model-banner")).toContainText(
    MODEL_NAME,
  );
  await enhance.click();

  const notice = page.getByTestId("meetings-run-notice-enhance");
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice).toContainText(
    `${MODEL_NAME} is not downloaded. Download it in Models.`,
  );
  await expect(notice).not.toContainText(/internal error/i);
  await expect(page.getByTestId("meetings-run-download-model")).toBeVisible();
  await expect(page.getByTestId("meetings-enhance-retry")).toContainText(
    "Start again",
  );

  // The run record holds the typed kind, not "internal".
  const runs = (await (
    await api("GET", `/meetings/${SEEDED_ID}/llm-runs?latest=1`)
  ).json()) as {
    runs: Array<{
      kind: string;
      status: string;
      errorKind: string | null;
      steps: Array<{ status: string; errorKind: string | null }>;
    }>;
  };
  const run = runs.runs.find((r) => r.kind === "enhance");
  expect(run?.status).toBe("failed");
  const failed = run?.steps.filter((s) => s.status === "failed") ?? [];
  expect(failed.length).toBeGreaterThan(0);
  for (const step of failed) expect(step.errorKind).toBe("model_missing");

  await shootBoth("3-meeting-enhance-card", async () => {
    await expect(page.getByTestId("meetings-run-notice-enhance")).toBeVisible({
      timeout: 15_000,
    });
  });
});

test("the Download button opens the Models page at the model", async () => {
  await page.getByTestId("meetings-run-download-model").click();
  await page.waitForURL(/\/settings\/models\?missing=/);
  expect(decodeURIComponent(page.url())).toContain(
    `missing=mlx-llm:${MODEL_ID}`,
  );
  const row = page.getByTestId("missing-model-row");
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute("data-model", `mlx-llm:${MODEL_ID}`);
  await expect(row).toContainText(`${MODEL_NAME} is not downloaded.`);
  await expect(page.getByTestId("missing-model-card-download")).toBeEnabled();
  // The pair card warns on the cleanup side too.
  await expect(page.getByText("This model is not downloaded.")).toBeVisible();
  await shootBoth("4-models-page", async () => {
    await expect(page.getByTestId("missing-models-card")).toBeVisible();
  });
});

test("Ask shows the banner", async () => {
  await page.goto("app://renderer/ask");
  await page.waitForLoadState("load");
  const banner = page.getByTestId("missing-model-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText("Ask");
  await shootBoth("5-ask-banner", async () => {
    await expect(page.getByTestId("missing-model-banner")).toBeVisible();
  });
});

test("a dictation keeps the raw text, tells once, and marks the history row", async () => {
  test.setTimeout(120_000);
  const samples = new Int16Array(16_000);
  const wav = pcm16Wav(samples, 16_000);
  const dictate = async () => {
    const res = await fetch(`${base}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav),
    });
    expect(res.status, "POST /api/transcribe").toBe(200);
    return (await res.json()) as { raw: string; cleaned: string };
  };
  const first = await dictate();
  expect(first.cleaned).toContain("pricing sheet");

  // The notification goes from the server process to main: one for the session.
  await expect
    .poll(() => e2eCounter(app, "cleanupSkippedNotifications"), {
      timeout: 15_000,
    })
    .toBe(1);
  await dictate();
  await dictate();
  await page.waitForTimeout(1500);
  expect(await e2eCounter(app, "cleanupSkippedNotifications")).toBe(1);

  const history = (await (await api("GET", "/history?limit=10")).json()) as {
    items: Array<{ cleanup_skipped: string | null }>;
  };
  expect(history.items).toHaveLength(3);
  for (const item of history.items) {
    expect(item.cleanup_skipped).toBe("model_missing");
  }

  await page.goto("app://renderer/today");
  await page.waitForLoadState("load");
  const mark = page.getByTestId("history-cleanup-skipped").first();
  await expect(mark).toBeVisible({ timeout: 15_000 });
  await expect(mark).toContainText("Cleanup skipped: model missing");
  await shootBoth("6-history-mark", async () => {
    const shown = page.getByTestId("history-cleanup-skipped").first();
    await expect(shown).toBeVisible();
    await shown.scrollIntoViewIfNeeded();
  });
});

test("the cue goes away when the model folder is there", async () => {
  putFakeModel();
  const body = (await (
    await api("GET", "/models/missing")
  ).json()) as unknown[];
  expect(body).toEqual([]);

  await page.goto("app://renderer/today");
  await page.waitForLoadState("load");
  await expect(page.getByTestId("missing-model-banner")).toHaveCount(0);
  await expect(page.getByTestId("nav-models-missing-badge")).toHaveCount(0);
  // Models stays in the sidebar with advanced mode off. The badge is gone.
  await expect(page.getByRole("link", { name: /^Models/ })).toBeVisible();

  await page.goto("app://renderer/settings/models");
  await page.waitForLoadState("load");
  await expect(page.getByTestId("missing-models-card")).toHaveCount(0);
  await expect(page.getByText("This model is not downloaded.")).toHaveCount(0);

  await openMeeting(page, SEEDED_TITLE);
  await expect(page.getByTestId("missing-model-banner")).toHaveCount(0);

  await page.goto("app://renderer/today");
  await page.waitForLoadState("load");
  await shootBoth("7-cue-gone", async () => {
    await expect(page.getByTestId("nav-models-missing-badge")).toHaveCount(0);
  });
});
