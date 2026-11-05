import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";
import {
  installOnboardingFakes,
  type OnboardingFakes,
  serverGet,
  shoot,
} from "./helpers/onboarding-fakes";

// ---------------------------------------------------------------------------
// The first run (specs/onboarding.md), walked in the real app with an isolated
// profile. Downloads, workers and provider calls are fakes at the HTTP layer
// of the renderer (helpers/onboarding-fakes.ts). Permissions are fakes in the
// main process (OPENSTYLE_E2E_PERMISSIONS), so no macOS dialog appears.
// The saves of the user choices go to the real server and are read back.
// ---------------------------------------------------------------------------

interface Configured {
  provider: string;
  model_id: string;
  model_name: string;
  type: string;
  is_default: number;
}

function newProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "openstyle-onboarding-"));
  // Meeting Mode on: the Name and Enhance steps show.
  writeFileSync(
    join(dir, "config.freestyle.json"),
    `${JSON.stringify({ version: 1, flags: { meetings: true } }, null, 2)}\n`,
  );
  return dir;
}

interface Session {
  app: ElectronApplication;
  page: Page;
  fakes: OnboardingFakes;
  userDataDir: string;
}

async function launch(
  userDataDir: string,
  permissions: "granted" | "denied" = "granted",
): Promise<Session> {
  const app = await launchOpenstyle({
    userDataDir,
    env: { OPENSTYLE_E2E_PERMISSIONS: permissions },
  });
  const page = await waitForDashboardWindow(app, 20_000);
  await page.waitForLoadState("domcontentloaded");
  const fakes = await installOnboardingFakes(page);
  return { app, page, fakes, userDataDir };
}

const stepOf = (page: Page) => page.getByTestId("onboarding-root");

async function expectStep(page: Page, step: number): Promise<void> {
  await expect(stepOf(page)).toHaveAttribute("data-step", String(step), {
    timeout: 15_000,
  });
}

async function configured(app: ElectronApplication): Promise<Configured[]> {
  return (await serverGet<Configured[]>(app, "/api/models/configured")).body;
}

function localSettings(userDataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(userDataDir, "settings.json"), "utf8"));
}

async function setting(
  app: ElectronApplication,
  key: string,
): Promise<string | null> {
  const res = await serverGet<{ value: string }>(app, `/api/settings/${key}`);
  return res.status === 200 ? res.body.value : null;
}

let session: Session | undefined;

test.afterEach(async () => {
  if (session) await closeApp(session.app).catch(() => {});
  session = undefined;
});

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// Path 1: the recommended pair on this Mac, the whole flow to the Ready screen.
// ---------------------------------------------------------------------------
test("recommended local path: welcome to ready", async () => {
  session = await launch(newProfile());
  const { app, page, fakes, userDataDir } = session;

  // Step 0: Welcome. Nothing is saved, and nothing downloads.
  await expect(page).toHaveURL(/\/onboarding/);
  await expectStep(page, 0);
  await expect(page.getByText("Talk. Openstyle writes.")).toBeVisible();
  await shoot(page, "01-welcome");
  expect(await configured(app)).toEqual([]);
  await page.getByTestId("onboarding-start").click();

  // Step 1: Language. The OS language is selected. Nothing is saved at mount.
  await expectStep(page, 1);
  await expect(page.getByTestId("onboarding-counter")).toHaveAttribute(
    "data-total",
    "6",
  );
  await expect(page.getByTestId("onboarding-language-note")).toContainText(
    "Your Mac language is English",
  );
  await shoot(page, "02-language");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: Model. One recommendation, one button with the total size.
  await expectStep(page, 2);
  await expect(page.getByTestId("onboarding-rec-voice")).toHaveText(
    "Qwen3 Fast",
  );
  await expect(page.getByTestId("onboarding-rec-text")).toHaveText(
    "Gemma 4 E2B",
  );
  const button = page.getByTestId("onboarding-model-continue");
  // 1,010,773,761 (voice) + 174,000,000 (MLX worker) + 4,361,680,121 (text).
  await expect(button).toContainText("Download 5.5 GB and continue");
  await shoot(page, "03-model-recommended");
  // The page open did not save a default model (the old auto-save is gone).
  expect(await configured(app)).toEqual([]);
  expect(fakes.downloads).toEqual([]);
  await button.click();

  // The press saves both default models and starts both downloads.
  await expectStep(page, 3);
  const saved = await configured(app);
  expect(
    saved.find((m) => m.type === "voice" && m.is_default === 1),
  ).toMatchObject({
    provider: "local-mlx",
    model_id: "local-mlx/qwen3-0.6b-8bit",
  });
  expect(
    saved.find((m) => m.type === "llm" && m.is_default === 1),
  ).toMatchObject({
    provider: "local-mlx-llm",
    model_id: "local-mlx-llm/gemma-4-e2b-qat-4bit",
  });
  expect(fakes.downloads).toEqual(
    expect.arrayContaining([
      "mlx-asr:qwen3-0.6b-8bit",
      "mlx-llm:gemma-4-e2b-qat-4bit",
    ]),
  );
  // The reconcile step on the real server did not flip MLX to Whisper.
  const again = await configured(app);
  expect(again.find((m) => m.type === "voice")?.provider).toBe("local-mlx");
  // The saved step is on disk, so a quit does not lose the flow.
  expect(localSettings(userDataDir).onboardingStep).toBe(3);

  // Footer: the download runs in the background. It starts with the helper
  // engine (the MLX worker), then the weights.
  const footer = page.getByTestId("onboarding-footer");
  await expect(footer).toHaveAttribute("data-state", "running");
  await expect(page.getByTestId("onboarding-footer-text")).toContainText(
    "Installing the helper engine",
  );
  await expect(page.getByTestId("onboarding-footer-text")).toContainText(
    "Downloading Qwen3 Fast",
    { timeout: 15_000 },
  );

  // Step 3: Permissions (fake grants). Both granted, so Continue is on.
  await expect(page.getByTestId("onboarding-perm-mic")).toHaveAttribute(
    "data-granted",
    "true",
  );
  await expect(
    page.getByTestId("onboarding-perm-accessibility"),
  ).toHaveAttribute("data-granted", "true");
  await expect(page.getByTestId("onboarding-continue-without")).toHaveCount(0);
  await shoot(page, "05-permissions");
  await page.getByTestId("onboarding-permissions-continue").click();

  // Step 4: Try it. The model still downloads: the screen says so. Continue
  // waits for a real dictation event. Skip is on.
  await expectStep(page, 4);
  await expect(page.getByTestId("onboarding-try-wait")).toBeVisible();
  await expect(page.getByTestId("onboarding-try-continue")).toBeDisabled();
  await expect(page.getByTestId("onboarding-try-skip")).toBeEnabled();
  await shoot(page, "06-try-it-downloading");
  fakes.finish();
  await expect(footer).toHaveAttribute("data-state", "done", {
    timeout: 15_000,
  });
  // Typing in the email does not unlock Continue (the old gate). A dictation
  // event does.
  const body = page.locator('[role="textbox"]');
  await body.click();
  await body.fill("Happy birthday Sam, I will bring cake on Friday.");
  await expect(page.getByTestId("onboarding-try-continue")).toBeDisabled();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.emit("transcription:done");
  });
  await expect(page.getByTestId("onboarding-try-ok")).toContainText(
    "It worked.",
  );
  await expect(page.getByTestId("onboarding-try-ok")).toContainText(
    "Openstyle typed 9 words.",
  );
  await shoot(page, "07-try-it-done");
  await page.getByTestId("onboarding-try-continue").click();

  // Step 5: Name.
  await expectStep(page, 5);
  await page.getByTestId("onboarding-owner-name").fill("  Ana Silva  ");
  await shoot(page, "08-name");
  await page.getByTestId("onboarding-name-continue").click();

  // Step 6: Enhance is on by default. The corner switch turns it off and on.
  await expectStep(page, 6);
  const enhanceSwitch = page.getByTestId("onboarding-enhance-switch");
  await expect(enhanceSwitch).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("We will enhance your meetings.")).toBeVisible();
  await expect(page.getByTestId("onboarding-enhance-clean")).toBeVisible();
  await expect(page.getByTestId("onboarding-enhance-sub")).toContainText(
    "After each meeting, Openstyle tidies the transcript.",
  );
  await shoot(page, "09-enhance-on");
  await enhanceSwitch.click();
  await expect(page.getByText("Enhance is off.")).toBeVisible();
  await shoot(page, "10-enhance-off");
  await enhanceSwitch.click();
  await expect(enhanceSwitch).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("onboarding-enhance-continue").click();

  // Step 7: Ready. Green chips for what is set. One button.
  await expectStep(page, 7);
  await expect(page.getByText("Everything is ready")).toBeVisible();
  for (const id of ["voice", "text", "mic", "accessibility", "enhance"]) {
    await expect(page.getByTestId(`onboarding-chip-${id}`)).toHaveAttribute(
      "data-tone",
      "ok",
    );
  }
  await expect(page.getByTestId("onboarding-chip-voice")).toContainText(
    "Voice model · this Mac",
  );
  await expect(page.getByTestId("onboarding-ready-line")).toContainText(
    "in any app and speak.",
  );
  await shoot(page, "11-ready");
  await page.getByTestId("onboarding-finish").click();
  await page.waitForURL(/\/today/, { timeout: 15_000 });

  // The settings are in the real database and in the local file.
  expect(await setting(app, "owner_name")).toBe("Ana Silva");
  expect(await setting(app, "meeting_enhance_auto_run")).toBe("true");
  expect(await setting(app, "meeting_enhance_prompt_seen")).toBe("true");
  expect(JSON.parse((await setting(app, "languages")) ?? "[]")).toEqual(["en"]);
  const local = localSettings(userDataDir);
  expect(local.onboardingComplete).toBe(true);
  expect(local.onboardingStep).toBeUndefined();

  // Models is in the sidebar with advanced mode off, and the page has no
  // "Advanced mode is off" banner. It names the selected model.
  expect(await setting(app, "advanced_mode")).toBeNull();
  const modelsLink = page.getByRole("link", { name: /^Models/ });
  await expect(modelsLink).toBeVisible();
  await modelsLink.click();
  await page.waitForURL(/\/settings\/models/);
  await expect(page.getByText("Advanced mode is off")).toHaveCount(0);
  // Both sides name the selected model, also before the weights are on the
  // disk (audit P14). The Cleanup side is off, but it still names its model.
  const pair = page
    .locator("section")
    .filter({ hasText: "Qwen3 Fast" })
    .first();
  await expect(pair).toContainText("Qwen3 Fast", { timeout: 15_000 });
  await expect(pair).toContainText("Gemma 4 E2B");
  await expect(pair.getByText("None selected")).toHaveCount(0);
  await shoot(page, "12-models-page");
});

// ---------------------------------------------------------------------------
// Path 2: voice on this Mac, text with a cloud provider (fake key test), with
// the permissions refused ("Continue without").
// ---------------------------------------------------------------------------
test("voice local and text cloud, permissions refused", async () => {
  session = await launch(newProfile(), "denied");
  const { app, page, fakes } = session;

  await page.getByTestId("onboarding-start").click();
  await expectStep(page, 1);
  await page.getByRole("button", { name: "Continue" }).click();
  await expectStep(page, 2);

  // Choose another: the text model comes from a cloud provider.
  await page.getByTestId("onboarding-choose-another").click();
  await expect(page.getByTestId("onboarding-model-choose")).toBeVisible();
  await shoot(page, "04a-model-choose-another");
  await page.getByTestId("onboarding-text-source-cloud").click();
  const textCloud = page.getByTestId("onboarding-text-cloud");
  await expect(textCloud).toBeVisible();
  // The key is empty: Continue is off.
  await expect(page.getByTestId("onboarding-model-continue")).toBeDisabled();
  // A refused key shows the reason and keeps Continue off.
  fakes.rejectNextKey();
  await page
    .getByTestId("onboarding-text-cloud-key")
    .fill("sk-ant-fake-key-not-valid");
  await page.getByTestId("onboarding-text-cloud-test").click();
  await expect(page.getByTestId("onboarding-text-cloud-error")).toContainText(
    "The provider refused this key.",
  );
  await expect(page.getByTestId("onboarding-model-continue")).toBeDisabled();
  await shoot(page, "04b-model-key-refused");
  // A good key works.
  await page
    .getByTestId("onboarding-text-cloud-key")
    .fill("sk-ant-fake-key-valid");
  await page.getByTestId("onboarding-text-cloud-test").click();
  await expect(page.getByTestId("onboarding-text-cloud-ok")).toContainText(
    "Key works · text model Claude Haiku 4.5",
  );
  await shoot(page, "04c-model-key-works");
  // The total counts the voice model and the helper engine only:
  // 1,010,773,761 + 174,000,000 = 1.2 GB. The cloud model adds 0.
  const button = page.getByTestId("onboarding-model-continue");
  await expect(button).toContainText("Download 1.2 GB and continue");
  // The test did not save the key.
  expect(
    (await serverGet<{ provider: string }[]>(app, "/api/keys")).body,
  ).toEqual([]);
  expect(await configured(app)).toEqual([]);
  await button.click();
  await expectStep(page, 3);

  const saved = await configured(app);
  expect(saved.find((m) => m.type === "voice")).toMatchObject({
    provider: "local-mlx",
    is_default: 1,
  });
  expect(saved.find((m) => m.type === "llm")).toMatchObject({
    provider: "anthropic",
    model_id: "claude-haiku-4-5",
    is_default: 1,
  });
  expect(fakes.downloads).toEqual(["mlx-asr:qwen3-0.6b-8bit"]);
  expect(
    (await serverGet<{ provider: string }[]>(app, "/api/keys")).body.map(
      (k) => k.provider,
    ),
  ).toEqual(["anthropic"]);
  // The draft on disk never holds the key.
  expect(JSON.stringify(localSettings(session.userDataDir))).not.toContain(
    "sk-ant-fake",
  );

  // Step 3: both permissions are denied. The step says why and lets the user
  // continue without them.
  await expect(page.getByTestId("onboarding-mic-denied")).toContainText(
    "Microphone is off for Openstyle.",
  );
  await expect(
    page.getByTestId("onboarding-permissions-continue"),
  ).toBeDisabled();
  await expect(page.getByTestId("onboarding-check-again")).toBeVisible();
  await expect(page.getByTestId("onboarding-continue-without")).toHaveText(
    "Continue without these",
  );
  await shoot(page, "05b-permissions-denied");
  await page.getByTestId("onboarding-continue-without").click();

  // Step 4: Try it shows why a dictation cannot start. Skip works.
  await expectStep(page, 4);
  await expect(page.getByTestId("onboarding-try-perms")).toContainText(
    "Microphone or Accessibility is off.",
  );
  await expect(page.getByTestId("onboarding-try-continue")).toBeDisabled();
  await page.getByTestId("onboarding-try-skip").click();

  // Step 5 and 6.
  await expectStep(page, 5);
  await page.getByTestId("onboarding-name-skip").click();
  await expectStep(page, 6);
  await expect(page.getByTestId("onboarding-enhance-switch")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Turn Enhance off with the corner switch.
  await page.getByTestId("onboarding-enhance-switch").click();
  await page.getByTestId("onboarding-enhance-continue").click();

  await expectStep(page, 7);
  await expect(page.getByTestId("onboarding-chip-text")).toContainText(
    "Text model · Anthropic",
  );
  await expect(page.getByTestId("onboarding-chip-voice")).toContainText(
    "Voice model · this Mac",
  );
  await expect(page.getByTestId("onboarding-chip-mic")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-chip-enhance")).toHaveCount(0);
  await shoot(page, "11b-ready-cloud-text");
  await page.getByTestId("onboarding-finish").click();
  await page.waitForURL(/\/today/, { timeout: 15_000 });
  // Skip name wrote nothing. Enhance off wrote an explicit "false".
  expect(await setting(app, "owner_name")).toBeNull();
  expect(await setting(app, "meeting_enhance_auto_run")).toBe("false");
  // The home screen asks for the missing microphone.
  await expect(page.getByTestId("setup-card-microphone")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Path 3: Decide later. A clear working state: no model saved, nothing
// downloaded, Try it skipped, Enhance off, a card on the first screen.
// ---------------------------------------------------------------------------
test("decide later leaves a working state", async () => {
  session = await launch(newProfile());
  const { app, page, fakes } = session;

  await page.getByTestId("onboarding-start").click();
  await expectStep(page, 1);
  await page.getByRole("button", { name: "Continue" }).click();
  await expectStep(page, 2);
  await page.getByTestId("onboarding-decide-later").click();

  await expectStep(page, 3);
  expect(await configured(app)).toEqual([]);
  expect(fakes.downloads).toEqual([]);
  await expect(page.getByTestId("onboarding-footer")).toHaveCount(0);
  await page.getByTestId("onboarding-permissions-continue").click();

  // Try it has nothing to test, so the flow goes on to Name. The counter has
  // one step less.
  await expectStep(page, 5);
  await expect(page.getByTestId("onboarding-counter")).toHaveAttribute(
    "data-total",
    "5",
  );
  await page.getByTestId("onboarding-name-skip").click();

  // No text model is set, so Enhance starts off.
  await expectStep(page, 6);
  await expect(page.getByTestId("onboarding-enhance-switch")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByText("Enhance is off.")).toBeVisible();
  await shoot(page, "10b-enhance-no-text-model");
  await page.getByTestId("onboarding-enhance-continue").click();

  await expectStep(page, 7);
  await expect(page.getByTestId("onboarding-chip-voice")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-ready-line")).toContainText(
    "Dictation is off.",
  );
  await shoot(page, "11c-ready-decide-later");
  await page.getByTestId("onboarding-finish").click();
  await page.waitForURL(/\/today/, { timeout: 15_000 });

  expect(await configured(app)).toEqual([]);
  expect(fakes.downloads).toEqual([]);
  await expect(page.getByTestId("setup-card-voice")).toContainText(
    "Pick a voice model to start dictating.",
  );
  await shoot(page, "13-home-decide-later");
});

// ---------------------------------------------------------------------------
// Path 4: voice on an own server (a fake server on loopback).
// ---------------------------------------------------------------------------
test("voice on an own server", async () => {
  const fakeServer: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/v1/models")) {
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "whisper-large-v3", object: "model" }],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((done) => fakeServer.listen(0, "127.0.0.1", done));
  const address = fakeServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    session = await launch(newProfile());
    const { app, page, fakes } = session;
    await page.getByTestId("onboarding-start").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expectStep(page, 2);
    await page.getByTestId("onboarding-choose-another").click();
    await page.getByTestId("onboarding-voice-source-server").click();
    // The text model is "Not now".
    await page.getByTestId("onboarding-text-alt").click();
    await page.getByTestId("onboarding-text-row-none").click();

    await page
      .getByTestId("onboarding-voice-server-url")
      .fill(`http://127.0.0.1:${port}`);
    await page.getByTestId("onboarding-voice-server-test").click();
    await expect(page.getByTestId("onboarding-voice-server-ok")).toContainText(
      "Connected · 1 model found",
    );
    await shoot(page, "04d-model-own-server");
    const button = page.getByTestId("onboarding-model-continue");
    // Nothing downloads: the button says Continue.
    await expect(button).toHaveText(/^Continue/);
    await button.click();
    await expectStep(page, 3);

    const saved = await configured(app);
    const voice = saved.find((m) => m.type === "voice");
    expect(voice).toMatchObject({ provider: "server", is_default: 1 });
    expect(voice?.model_id).toMatch(/^server\/.+\/whisper-large-v3$/);
    expect(saved.find((m) => m.type === "llm")).toBeUndefined();
    expect(fakes.downloads).toEqual([]);
    await expect(page.getByTestId("onboarding-footer")).toHaveCount(0);
  } finally {
    fakeServer.close();
  }
});

// ---------------------------------------------------------------------------
// Quit and resume. The first run stays active until it is complete, also when
// a model is saved on the way (the old rule ended it at the first model).
// ---------------------------------------------------------------------------
test("quit and resume", async () => {
  const userDataDir = newProfile();
  session = await launch(userDataDir);
  let { app, page } = session;

  // Quit on the first screen: nothing is saved, onboarding shows again.
  await expectStep(page, 0);
  await closeApp(app);
  session = await launch(userDataDir);
  ({ app, page } = session);
  await expect(page).toHaveURL(/\/onboarding/);
  await expectStep(page, 0);
  expect(await configured(app)).toEqual([]);

  // Go to the model step, press the download button, then quit.
  await page.getByTestId("onboarding-start").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expectStep(page, 2);
  await page.getByTestId("onboarding-model-continue").click();
  await expectStep(page, 3);
  expect((await configured(app)).length).toBe(2);
  await closeApp(app);

  // Next launch: a model is saved, but onboarding is still active and opens
  // on the saved step. The download stopped with the quit, so the footer says
  // so and offers a retry.
  session = await launch(userDataDir);
  ({ app, page } = session);
  await expect(page).toHaveURL(/\/onboarding/);
  await expectStep(page, 3);
  const footer = page.getByTestId("onboarding-footer");
  await expect(footer).toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("onboarding-footer-failed")).toContainText(
    "Download stopped.",
  );
  await shoot(page, "14-resume-download-stopped");
  const before = session.fakes.downloads.length;
  await page.getByTestId("onboarding-footer-retry").click();
  await expect(footer).toHaveAttribute("data-state", "running");
  expect(session.fakes.downloads.length).toBeGreaterThan(before);
  session.fakes.finish();
  await expect(footer).toHaveAttribute("data-state", "done", {
    timeout: 15_000,
  });

  // Finish the rest with the skips.
  await page.getByTestId("onboarding-permissions-continue").click();
  await expectStep(page, 4);
  await page.getByTestId("onboarding-try-skip").click();
  await page.getByTestId("onboarding-name-skip").click();
  await page.getByTestId("onboarding-enhance-continue").click();
  await expectStep(page, 7);
  await page.getByTestId("onboarding-finish").click();
  await page.waitForURL(/\/today/, { timeout: 15_000 });

  // After completion, a new launch opens the app, not onboarding.
  await closeApp(app);
  session = await launch(userDataDir);
  ({ page } = session);
  await expect.poll(() => page.url()).toContain("/today");
});

// ---------------------------------------------------------------------------
// The tray popover shows "Finish setup" until the first run is complete.
// ---------------------------------------------------------------------------
test("the tray popover offers Finish setup while onboarding is open", async () => {
  session = await launch(newProfile());
  const { app } = session;
  await app.evaluate(({ ipcMain }) => {
    ipcMain.emit("e2e:tray-popover-toggle");
  });
  await expect
    .poll(() => app.windows().some((w) => w.url().includes("tray-popover")), {
      timeout: 15_000,
    })
    .toBe(true);
  const popover = app.windows().find((w) => w.url().includes("tray-popover"));
  if (!popover) throw new Error("The tray popover did not open");
  await expect(popover.getByTestId("tray-popover-finish-setup")).toHaveText(
    "Finish setup",
  );
});
