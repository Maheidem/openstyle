import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  closeApp,
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// The owner name field in Settings > Meetings (setting `owner_name`, the
// first term of the meeting ASR bias). Type a name, press Enter, read it back
// from the API and from the isolated profile DB, open the page again and see
// the stored name. Mac only: the Meetings section shows only on macOS.
// Fictional name only. Screenshots go to OPENSTYLE_EVIDENCE_DIR when set.
// ---------------------------------------------------------------------------

test.skip(process.platform !== "darwin", "the Meetings section is Mac only");

const NAME = "Ana Silva";
const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;

let app: ElectronApplication | undefined;
let page: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-owner-name-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    `${JSON.stringify({ version: 1, flags: { meetings: true } }, null, 2)}\n`,
  );
  app = await launchOpenstyle({ userDataDir });
  await app.context().addInitScript(() => {
    localStorage.setItem("i18nextLng", "en");
  });
  page = await waitForDashboardWindow(app, 15_000);
  await page.waitForLoadState("load");
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

async function storedName(): Promise<{ status: number; value?: string }> {
  const res = await fetch(
    `${embeddedServerUrl(app as ElectronApplication)}/api/settings/owner_name`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const body = res.ok ? ((await res.json()) as { value: string }) : null;
  return { status: res.status, value: body?.value };
}

test("Settings > Meetings saves the owner name and shows it again", async () => {
  await page.goto("app://renderer/settings#meetings");
  const field = page.getByTestId("settings-owner-name");
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("");
  expect((await storedName()).status).toBe(404);

  await field.fill(`  ${NAME}  `);
  await field.press("Enter");
  await expect(field).toHaveValue(NAME);
  await expect.poll(async () => (await storedName()).value).toBe(NAME);

  // The isolated profile DB holds the trimmed value.
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"), {
    readOnly: true,
  });
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'owner_name'")
    .get() as { value: string } | undefined;
  db.close();
  expect(row?.value).toBe(NAME);

  // A new page load reads the stored name back into the field.
  await page.goto("app://renderer/today");
  await page.goto("app://renderer/settings#meetings");
  await expect(page.getByTestId("settings-owner-name")).toHaveValue(NAME);
  if (EVIDENCE_DIR) {
    await page.screenshot({
      path: join(EVIDENCE_DIR, "owner-name-settings.png"),
    });
  }

  // An empty field clears the name.
  await page.getByTestId("settings-owner-name").fill("");
  await page.getByTestId("settings-owner-name").blur();
  await expect.poll(async () => (await storedName()).value).toBe("");
});
