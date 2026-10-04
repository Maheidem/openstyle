import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { _electron as electron } from "playwright";

test.skip(
  process.platform !== "darwin",
  "Permission flow integration tests require macOS permission APIs.",
);

interface RecordedEvent {
  type: string;
  options?: {
    title?: string;
    message?: string;
    detail?: string;
    buttons?: string[];
  };
  url?: string;
}

interface LaunchOptions {
  accessibility: "granted" | "denied";
  microphone?: "granted" | "denied" | "restricted" | "not-determined";
  onboardingComplete: boolean;
  dialogResponse?: number;
}

interface LaunchedApp {
  app: ElectronApplication;
  dashboard: Page;
  eventsPath: string;
}

async function closePermissionApp(app: ElectronApplication): Promise<void> {
  const childProcess = app.process();
  if (childProcess.exitCode !== null || childProcess.signalCode !== null)
    return;

  // This fixture validates startup permissions, not production shutdown.
  // Avoid app.close(), which runs native cleanup that intermittently wedges
  // macOS CI and leaves Playwright waiting through two 60-second timeouts.
  const exited = new Promise<void>((resolve) => {
    childProcess.once("exit", () => resolve());
  });
  childProcess.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 5_000);
    }),
  ]);
}

async function waitForDashboard(app: ElectronApplication): Promise<Page> {
  await app.firstWindow();
  await expect
    .poll(() => app.windows().find((page) => !page.url().includes("pill")))
    .toBeTruthy();
  const dashboard = app.windows().find((page) => !page.url().includes("pill"));
  if (!dashboard) throw new Error("Dashboard window did not open");
  await dashboard.waitForLoadState("domcontentloaded");
  return dashboard;
}

function readEvents(eventsPath: string): RecordedEvent[] {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

function hasEvent(
  eventsPath: string,
  type: string,
  matches: (event: RecordedEvent) => boolean = () => true,
): boolean {
  return readEvents(eventsPath).some(
    (event) => event.type === type && matches(event),
  );
}

async function launchPermissionApp(
  options: LaunchOptions,
): Promise<LaunchedApp> {
  const testDir = mkdtempSync(join(tmpdir(), "openstyle-permissions-e2e-"));
  const userDataDir = join(testDir, "user-data");
  const eventsPath = join(testDir, "events.jsonl");
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: options.onboardingComplete }),
  );

  const app = await electron.launch({
    args: [
      resolve(__dirname, "fixtures/permission-main.cjs"),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    env: {
      ...process.env,
      NODE_ENV: "development",
      OPENSTYLE_E2E: "1",
      OPENSTYLE_E2E_ACCESSIBILITY: options.accessibility,
      OPENSTYLE_E2E_MICROPHONE: options.microphone ?? "granted",
      OPENSTYLE_E2E_DIALOG_RESPONSE: String(options.dialogResponse ?? 1),
      OPENSTYLE_E2E_ONBOARDING_COMPLETE: String(options.onboardingComplete),
      OPENSTYLE_E2E_PERMISSION_EVENTS: eventsPath,
      OPENSTYLE_USER_DATA: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    timeout: 30_000,
  });

  return { app, dashboard: await waitForDashboard(app), eventsPath };
}

async function waitForStartupPermissionChecks(
  eventsPath: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        hasEvent(eventsPath, "accessibility-check") &&
        hasEvent(eventsPath, "media-check"),
    )
    .toBe(true);
}

function permissionDialogs(eventsPath: string): RecordedEvent[] {
  return readEvents(eventsPath).filter((event) => event.type === "dialog");
}

async function triggerHotkeyDown(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.electron.ipcRenderer.send("e2e:trigger-hotkey-down");
  });
}

async function instrumentMicrophoneRequest(
  app: ElectronApplication,
): Promise<void> {
  const pill = app.windows().find((page) => page.url().includes("pill"));
  if (!pill) throw new Error("Pill window did not open");
  await pill.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        window.electron.ipcRenderer.send("e2e:mic-requested");
        return original(constraints);
      },
    });
  });
}

test("startup warns once and opens Accessibility settings when requested", async () => {
  const launched = await launchPermissionApp({
    accessibility: "denied",
    onboardingComplete: true,
    dialogResponse: 0,
  });
  try {
    await waitForStartupPermissionChecks(launched.eventsPath);
    await expect
      .poll(
        () =>
          permissionDialogs(launched.eventsPath).filter(
            (event) =>
              event.options?.title === "Accessibility Permission Required",
          ).length,
      )
      .toBe(1);

    const warning = permissionDialogs(launched.eventsPath)[0]?.options;
    expect(warning?.message).toContain(
      "required for dictation and text insertion",
    );
    expect(warning?.buttons).toContain("Open System Settings");
    expect(
      hasEvent(launched.eventsPath, "open-external", (event) =>
        Boolean(event.url?.includes("Privacy_Accessibility")),
      ),
    ).toBe(true);
  } finally {
    await closePermissionApp(launched.app);
  }
});

test("startup does not warn when Accessibility permission is granted", async () => {
  const launched = await launchPermissionApp({
    accessibility: "granted",
    onboardingComplete: true,
  });
  try {
    await waitForStartupPermissionChecks(launched.eventsPath);
    expect(permissionDialogs(launched.eventsPath)).toHaveLength(0);
  } finally {
    await closePermissionApp(launched.app);
  }
});

test("onboarding does not receive a duplicate startup warning", async () => {
  const launched = await launchPermissionApp({
    accessibility: "denied",
    microphone: "denied",
    onboardingComplete: false,
  });
  try {
    await expect.poll(() => launched.dashboard.url()).toContain("/onboarding");
    await waitForStartupPermissionChecks(launched.eventsPath);
    expect(permissionDialogs(launched.eventsPath)).toHaveLength(0);
  } finally {
    await closePermissionApp(launched.app);
  }
});

test("startup warns for denied Microphone and opens its privacy settings", async () => {
  const launched = await launchPermissionApp({
    accessibility: "granted",
    microphone: "denied",
    onboardingComplete: true,
    dialogResponse: 0,
  });
  try {
    await waitForStartupPermissionChecks(launched.eventsPath);
    await expect
      .poll(() => permissionDialogs(launched.eventsPath).length)
      .toBe(1);

    const warning = permissionDialogs(launched.eventsPath)[0]?.options;
    expect(warning?.title).toBe("Microphone Permission Required");
    expect(warning?.message).toContain(
      "Microphone access is required to record dictation",
    );
    expect(warning?.buttons).toContain("Open System Settings");
    expect(
      hasEvent(launched.eventsPath, "open-external", (event) =>
        Boolean(event.url?.includes("Privacy_Microphone")),
      ),
    ).toBe(true);
    expect(hasEvent(launched.eventsPath, "mic-requested")).toBe(false);
  } finally {
    await closePermissionApp(launched.app);
  }
});

test("startup does not warn when Microphone permission is not-determined", async () => {
  const launched = await launchPermissionApp({
    accessibility: "granted",
    microphone: "not-determined",
    onboardingComplete: true,
  });
  try {
    await waitForStartupPermissionChecks(launched.eventsPath);
    expect(permissionDialogs(launched.eventsPath)).toHaveLength(0);
  } finally {
    await closePermissionApp(launched.app);
  }
});

test("startup combines missing Accessibility and Microphone into one warning", async () => {
  const launched = await launchPermissionApp({
    accessibility: "denied",
    microphone: "denied",
    onboardingComplete: true,
    dialogResponse: 1,
  });
  try {
    await waitForStartupPermissionChecks(launched.eventsPath);
    await expect
      .poll(() => permissionDialogs(launched.eventsPath).length)
      .toBe(1);

    const warning = permissionDialogs(launched.eventsPath)[0]?.options;
    expect(warning?.title).toBe("Permissions Required");
    expect(warning?.message).toContain(
      "Accessibility and Microphone permissions are required",
    );
    expect(warning?.buttons).toEqual([
      "Open Accessibility Settings",
      "Open Microphone Settings",
      "Not Now",
    ]);
    expect(
      readEvents(launched.eventsPath).filter(
        (event) => event.type === "open-external",
      ),
    ).toEqual([
      expect.objectContaining({
        url: expect.stringContaining("Privacy_Microphone"),
      }),
    ]);
    expect(hasEvent(launched.eventsPath, "mic-requested")).toBe(false);
  } finally {
    await closePermissionApp(launched.app);
  }
});

for (const denied of [
  { name: "Accessibility", options: { accessibility: "denied" } },
  {
    name: "Microphone",
    options: { accessibility: "granted", microphone: "denied" },
  },
] as const) {
  test(`denied ${denied.name} blocks dictation before recording starts`, async () => {
    const launched = await launchPermissionApp({
      ...denied.options,
      onboardingComplete: true,
    });
    try {
      await waitForStartupPermissionChecks(launched.eventsPath);
      await instrumentMicrophoneRequest(launched.app);
      const dialogsBefore = permissionDialogs(launched.eventsPath).length;
      await triggerHotkeyDown(launched.dashboard);
      await expect
        .poll(() => permissionDialogs(launched.eventsPath).length)
        .toBe(dialogsBefore + 1);

      expect(hasEvent(launched.eventsPath, "mic-requested")).toBe(false);
      expect(
        await launched.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .filter((window) => window.webContents.getURL().includes("pill"))
            .some((window) => window.isVisible()),
        ),
      ).toBe(false);
    } finally {
      await closePermissionApp(launched.app);
    }
  });
}

test("granted permissions allow the existing dictation flow", async () => {
  const launched = await launchPermissionApp({
    accessibility: "granted",
    microphone: "granted",
    onboardingComplete: true,
  });
  try {
    await waitForStartupPermissionChecks(launched.eventsPath);
    await instrumentMicrophoneRequest(launched.app);
    await triggerHotkeyDown(launched.dashboard);
    await expect
      .poll(() => hasEvent(launched.eventsPath, "mic-requested"))
      .toBe(true);
    await expect
      .poll(() =>
        launched.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .filter((window) => window.webContents.getURL().includes("pill"))
            .some((window) => window.isVisible()),
        ),
      )
      .toBe(true);
  } finally {
    await closePermissionApp(launched.app);
  }
});
