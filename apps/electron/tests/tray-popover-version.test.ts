import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { closeApp, launchOpenstyle } from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// The tray popover footer shows "Openstyle <version> · <status>". A long
// version (an alpha build) must not cover the "Restart to update" button.
// OPENSTYLE_E2E_APP_VERSION sets the version; it only works with a feed URL
// (OPENSTYLE_E2E_RELEASES_URL, see update-channel.ts). The URL is never called:
// an unpacked app does not start the updater.
//
// Set OPENSTYLE_PROOF_SHOTS=<dir> to save screenshots. CI does not set it.
// ---------------------------------------------------------------------------

const SHOTS_DIR = process.env.OPENSTYLE_PROOF_SHOTS;

for (const version of ["2.25.0-alpha.1", "12.345.678-alpha.123"]) {
  test(`Restart to update stays clickable with version ${version}`, async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-version-"));
    writeFileSync(
      join(userDataDir, "settings.json"),
      JSON.stringify({ onboardingComplete: true }),
    );
    let app: ElectronApplication | undefined;
    try {
      app = await launchOpenstyle({
        userDataDir,
        env: {
          OPENSTYLE_E2E_TRAY: "1",
          OPENSTYLE_E2E_RELEASES_URL: "http://127.0.0.1:1/openstyle/releases",
          OPENSTYLE_E2E_APP_VERSION: version,
        },
      });
      await app.evaluate(({ app: electronApp, ipcMain }) => {
        const g = globalThis as unknown as { __restartCalls: number };
        g.__restartCalls = 0;
        electronApp.on("e2e:restart-and-update" as "ready", () => {
          g.__restartCalls += 1;
        });
        ipcMain.emit("e2e:tray-popover-update-ready");
        ipcMain.emit("e2e:tray-popover-toggle");
      });
      await expect
        .poll(
          () => app!.windows().some((w) => w.url().includes("tray-popover")),
          { timeout: 15_000 },
        )
        .toBe(true);
      const popover = app
        .windows()
        .find((w) => w.url().includes("tray-popover"))!;
      await expect(popover.getByTestId("tray-popover-version")).toContainText(
        `Openstyle ${version}`,
        { timeout: 10_000 },
      );
      const restart = popover.getByRole("button", {
        name: "Update ready, Restart to update",
      });
      await expect(restart).toHaveText("Restart to update");
      if (SHOTS_DIR) {
        await popover.mouse.move(0, 0);
        for (const theme of ["light", "dark"]) {
          await popover.evaluate(
            (v) => localStorage.setItem("theme", v),
            theme,
          );
          await popover.reload();
          await expect(restart).toBeVisible();
          await popover.waitForTimeout(400);
          await popover.mouse.move(0, 0);
          await popover.screenshot({
            path: join(SHOTS_DIR, `${version}-${theme}.png`),
          });
        }
        await popover.evaluate(() => localStorage.removeItem("theme"));
        await popover.reload();
        await expect(restart).toBeVisible();
      }
      // click() fails when another element covers the button.
      await restart.click({ timeout: 5_000 });
      await expect
        .poll(() =>
          app!.evaluate(
            () =>
              (globalThis as unknown as { __restartCalls: number })
                .__restartCalls,
          ),
        )
        .toBe(1);
    } finally {
      if (app) await closeApp(app);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
