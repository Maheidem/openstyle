import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";
import {
  closeApp,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";

const DB = process.env.PROOF_DB ?? "";
const OUT = process.env.OPENSTYLE_EVIDENCE_DIR ?? "";

test("profiles list", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "longmtg-prof-"));
  copyFileSync(DB, join(userData, "freestyle.db"));
  writeFileSync(
    join(userData, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  mkdirSync(OUT, { recursive: true });
  const app = await launchOpenstyle({ userDataDir: userData });
  try {
    const page = await waitForDashboardWindow(app);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("app://renderer/settings/models");

    await page.waitForTimeout(2500);
    await page.getByText("Meeting enhance", { exact: true }).click();
    await page.waitForTimeout(1000);
    await page.setViewportSize({ width: 1280, height: 1900 });
    await page.waitForTimeout(500);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(OUT, `profiles-page-${scheme}.png`) });
    }
  } finally {
    await closeApp(app);
  }
});
