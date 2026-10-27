import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// ---------------------------------------------------------------------------
// update-channel: the update channels (specs/update-channels.md) against a
// LOCAL fake GitHub release feed. The app runs the real electron-updater
// GitHub provider and the real self-updater download. Nothing goes to GitHub.
//
// The fake feed has, newest first:
//   2.25.0-alpha.1 (prerelease), 2.24.0 (stable, "latest"),
//   2.24.0-alpha.2 (prerelease), 2.23.0 (stable).
// Each release has latest-mac.yml (and latest-linux.yml, for the Linux CI
// runner) and one zip. alpha-*.yml gives 404, as on the real releases
// (electron-builder writes latest-mac.yml for alpha builds too).
//
// An unpackaged app has no release version, so OPENSTYLE_E2E_APP_VERSION sets
// it. restartAndUpdate() never installs in an E2E run: it emits
// "e2e:restart-and-update" on the app instead.
//
// Screenshots: OPENSTYLE_EVIDENCE_DIR (default: a temp folder).
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

const OWNER_REPO = "/Maheidem/openstyle";
const STABLE = "2.24.0";
const ALPHA = "2.25.0-alpha.1";
const RELEASES = [ALPHA, STABLE, "2.24.0-alpha.2", "2.23.0"];
const EVIDENCE_DIR =
  process.env.OPENSTYLE_EVIDENCE_DIR ??
  join(tmpdir(), "openstyle-update-channel-evidence");

const zips = new Map<string, Buffer>();
const requests: string[] = [];
let server: Server;
let feedUrl = "";

function zipName(version: string): string {
  return `Openstyle-${version}-${process.arch}.zip`;
}

function sha512(data: Buffer): string {
  return createHash("sha512").update(data).digest("base64");
}

function feedYml(version: string): string {
  const zip = zips.get(version) as Buffer;
  const name = zipName(version);
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${name}`,
    `    sha512: ${sha512(zip)}`,
    `    size: ${zip.length}`,
    `path: ${name}`,
    `sha512: ${sha512(zip)}`,
    "releaseDate: '2026-10-27T00:00:00.000Z'",
    "",
  ].join("\n");
}

function atomFeed(base: string): string {
  const entries = RELEASES.map(
    (tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <updated>2026-10-27T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="${base}${OWNER_REPO}/releases/tag/${tag}"/>
    <title>${tag}</title>
    <content type="html">Fictional release ${tag}</content>
  </entry>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
${entries}
</feed>
`;
}

test.beforeAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const version of RELEASES) zips.set(version, randomBytes(64 * 1024));
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    requests.push(path);
    const base = `http://${req.headers.host}`;
    if (path === `${OWNER_REPO}/releases.atom`) {
      res.writeHead(200, { "content-type": "application/atom+xml" });
      res.end(atomFeed(base));
      return;
    }
    if (path === `/api/v3/repos${OWNER_REPO}/releases/latest`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tag_name: STABLE }));
      return;
    }
    const match = new RegExp(
      `^${OWNER_REPO}/releases/download/([^/]+)/(.+)$`,
    ).exec(path);
    const version = match?.[1] ?? "";
    const file = match?.[2] ?? "";
    if (zips.has(version)) {
      if (file === "latest-mac.yml" || file === "latest-linux.yml") {
        res.writeHead(200, { "content-type": "text/yaml" });
        res.end(feedYml(version));
        return;
      }
      if (file === zipName(version)) {
        const zip = zips.get(version) as Buffer;
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-length": String(zip.length),
        });
        res.end(zip);
        return;
      }
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  feedUrl = `http://127.0.0.1:${port}${OWNER_REPO}/releases`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

async function startApp(
  version: string,
  settings: Record<string, unknown>,
): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-channel-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true, ...settings }),
  );
  requests.length = 0;
  const app = await launchOpenstyle({
    userDataDir,
    env: {
      OPENSTYLE_E2E_RELEASES_URL: feedUrl,
      OPENSTYLE_E2E_APP_VERSION: version,
      // Skip the probe of the owner's model server (live-testing skill).
      OPENSTYLE_E2E_OMLX_URL: "http://127.0.0.1:1",
    },
  });
  const page = await waitForDashboardWindow(app, 15_000);
  return { app, page, userDataDir };
}

function savedSettings(userDataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(userDataDir, "settings.json"), "utf8"));
}

function downloadedZip(userDataDir: string, version: string): string {
  return join(userDataDir, "updates", version, zipName(version));
}

async function setTheme(page: Page, name: "Light" | "Dark"): Promise<void> {
  await page.goto("app://renderer/settings#display");
  await page.getByRole("radio", { name, exact: true }).click();
  if (name === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function openApplication(page: Page): Promise<void> {
  await page.goto("app://renderer/settings#application");
  await expect(
    page.getByText("Automatic updates", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

function advancedSwitch(page: Page) {
  // The Row of the settings page: label block, then the control block.
  return page
    .getByText("Advanced mode", { exact: true })
    .locator("xpath=../..")
    .getByRole("switch");
}

async function shoot(page: Page, file: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(EVIDENCE_DIR, file) });
}

async function chooseChannel(page: Page, label: RegExp): Promise<void> {
  await page.locator("#settings-update-channel").click();
  await page.getByRole("option", { name: label }).click();
}

test("a Stable app sees no alpha; on Dev it finds and downloads the alpha", async () => {
  const { app, page, userDataDir } = await startApp(STABLE, {});
  try {
    // 1. The startup check on Stable reads the "latest" release only.
    await expect
      .poll(
        () =>
          requests.some((p) =>
            p.endsWith(
              `/${STABLE}/latest-${process.platform === "darwin" ? "mac" : "linux"}.yml`,
            ),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(await page.evaluate(() => window.api.checkForUpdate())).toBeNull();
    expect(requests.some((p) => p.includes(ALPHA))).toBe(false);
    expect(requests.some((p) => p.endsWith(".zip"))).toBe(false);

    // 2. The channel menu shows only with Advanced mode on.
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(page, theme);
      await openApplication(page);
      await expect(page.locator("#settings-update-channel")).toHaveCount(0);
      await shoot(page, `advanced-off-${theme.toLowerCase()}.png`);
    }
    await advancedSwitch(page).click();
    await expect(page.locator("#settings-update-channel")).toBeVisible();
    await expect(page.locator("#settings-update-channel")).toContainText(
      "Stable (recommended)",
    );
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(page, theme);
      await openApplication(page);
      await shoot(page, `advanced-on-${theme.toLowerCase()}.png`);
    }

    // 3. Dev: the switch checks at once and finds the newest alpha. With
    // "Automatic updates" on (the default), it downloads the alpha zip from
    // the alpha tag and checks its sha512.
    await chooseChannel(page, /^Dev/);
    await expect
      .poll(() => existsSync(downloadedZip(userDataDir, ALPHA)), {
        timeout: 30_000,
      })
      .toBe(true);
    const zip = readFileSync(downloadedZip(userDataDir, ALPHA));
    expect(sha512(zip)).toBe(sha512(zips.get(ALPHA) as Buffer));
    expect(requests).toContain(
      `${OWNER_REPO}/releases/download/${ALPHA}/latest-mac.yml`,
    );
    expect(requests).toContain(
      `${OWNER_REPO}/releases/download/${ALPHA}/${zipName(ALPHA)}`,
    );
    expect(requests.some((p) => p.includes("/latest/download/"))).toBe(false);
    expect(savedSettings(userDataDir).updateChannel).toBe("dev");
    await expect(
      page.getByText(`Version ${ALPHA} ready to install`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#settings-update-channel")).toContainText("Dev");
    await shoot(page, "dev-alpha-ready-dark.png");
  } finally {
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Dev back to Stable installs the current, older Stable version", async () => {
  // An alpha build on Dev, with "Automatic updates" OFF: the explicit switch
  // must still download and install the Stable version.
  const { app, page, userDataDir } = await startApp(ALPHA, {
    updateChannel: "dev",
    autoUpdate: false,
  });
  try {
    await setTheme(page, "Light");
    await openApplication(page);
    await advancedSwitch(page).click();
    await expect(page.locator("#settings-update-channel")).toContainText("Dev");
    const restart = app.evaluate(
      ({ app: electronApp }) =>
        new Promise<boolean>((done) =>
          (electronApp as NodeJS.EventEmitter).once(
            "e2e:restart-and-update",
            () => done(true),
          ),
        ),
    );

    await chooseChannel(page, /^Stable/);
    // The app asks first, because the Stable version is older.
    await expect(page.getByRole("alertdialog")).toContainText(
      "Switch to Stable?",
    );
    await shoot(page, "switch-to-stable-confirm-light.png");
    await page.getByRole("button", { name: "Install Stable" }).click();

    // It downloads 2.24.0 from the 2.24.0 tag and starts the install.
    expect(await restart).toBe(true);
    const zip = readFileSync(downloadedZip(userDataDir, STABLE));
    expect(sha512(zip)).toBe(sha512(zips.get(STABLE) as Buffer));
    expect(requests).toContain(
      `${OWNER_REPO}/releases/download/${STABLE}/${zipName(STABLE)}`,
    );
    expect(savedSettings(userDataDir).updateChannel).toBe("stable");

    // A normal check after the switch keeps downgrade off: 2.24.0 is older
    // than 2.25.0-alpha.1, so it is not an update.
    expect(await page.evaluate(() => window.api.checkForUpdate())).toBeNull();
    const log = readFileSync(
      join(userDataDir, "logs", "openstyle.log"),
      "utf8",
    );
    expect(log).toContain(
      `Update for version ${ALPHA} is not available (latest version: ${STABLE}, downgrade is disallowed)`,
    );
  } finally {
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("an alpha build on Stable never downgrades by itself", async () => {
  // "Automatic updates" on, channel Stable saved: the startup check finds the
  // older 2.24.0 and must not download it.
  const { app, userDataDir } = await startApp(ALPHA, {
    updateChannel: "stable",
  });
  try {
    await expect
      .poll(
        () => {
          try {
            return readFileSync(
              join(userDataDir, "logs", "openstyle.log"),
              "utf8",
            ).includes("downgrade is disallowed");
          } catch {
            return false;
          }
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    // Give a wrong download time to start.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(requests.some((p) => p.endsWith(".zip"))).toBe(false);
    expect(existsSync(join(userDataDir, "updates", STABLE))).toBe(false);
  } finally {
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
