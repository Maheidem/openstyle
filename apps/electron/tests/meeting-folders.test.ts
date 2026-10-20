import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import {
  closeApp,
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";

const MEETINGS = [
  { id: "e2e-folders-1", title: "Cabinet sample review" },
  { id: "e2e-folders-2", title: "Tile color plan" },
  { id: "e2e-folders-3", title: "The moon garden reading notes" },
];

let app: ElectronApplication | undefined;
let page: Page;
let base: string;
let userDataDir: string;

interface FolderRow {
  id: string;
  name: string;
  meeting_count: number;
}
interface MeetingRow {
  id: string;
  title: string;
  folder_id: string | null;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(res.ok, `${method} /api${path}: ${res.status}`).toBe(true);
  return res;
}

async function launch(): Promise<void> {
  app = await launchOpenstyle({ userDataDir });
  const pidFile = process.env.OPENSTYLE_E2E_PID_FILE;
  if (pidFile)
    writeFileSync(
      pidFile,
      JSON.stringify({ app: app.process().pid, worker: process.pid }),
    );
  base = embeddedServerUrl(app);
  // This proof must not start the first-run audio probe.
  await app.context().addInitScript(() => {
    localStorage.setItem("meetings_system_audio_probe_done", "1");
    localStorage.setItem("i18nextLng", "en");
  });
  page = await waitForDashboardWindow(app, 15_000);
  await page.waitForLoadState("load");
  await page.setViewportSize({ width: 1440, height: 1000 });
}

function rail(): Locator {
  return page.getByRole("complementary", { name: "Meetings and folders" });
}

function groupRow(name: string): Locator {
  return rail().getByRole("group", { name, exact: true });
}

function group(name: string): Locator {
  return groupRow(name).locator("..");
}

function meeting(groupName: string, title: string): Locator {
  return group(groupName).getByRole("button", { name: new RegExp(title) });
}

function panel(name: string): Locator {
  return page.getByRole("region", { name, exact: true });
}

async function createFolder(name: string): Promise<void> {
  await rail().getByRole("button", { name: "New folder", exact: true }).click();
  const input = rail().getByRole("textbox", {
    name: "Folder name",
    exact: true,
  });
  await input.fill(name);
  await input.press("Enter");
  await expect(groupRow(name)).toBeVisible();
  await expect(input).toHaveCount(0);
}

async function folderAction(
  name: string,
  action: "Rename folder" | "Delete folder",
): Promise<void> {
  await groupRow(name)
    .getByRole("button", { name: `Actions for ${name}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: new RegExp(`^${action}`) }).click();
}

async function moveByContext(
  groupName: string,
  title: string,
  folderName: string | null,
): Promise<void> {
  await meeting(groupName, title).click({ button: "right" });
  await page
    .getByRole("menuitem", {
      name:
        folderName === null
          ? "Remove from folder"
          : new RegExp(`^${folderName}`),
      exact: folderName === null,
    })
    .click();
}

async function shoot(name: string, element: Locator): Promise<void> {
  const dir = process.env.OPENSTYLE_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await element.screenshot({ path: join(dir, name), animations: "disabled" });
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-folders-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  await launch();
  await api("PUT", "/settings/meeting_enhance_prompt_seen", { value: "true" });
  for (const [i, value] of MEETINGS.entries()) {
    const startedAt = Date.UTC(2026, 9, 12 + i, 14);
    const audioDir = join(userDataDir, "meetings", value.id);
    mkdirSync(audioDir, { recursive: true });
    // The API writes rows only. It does not start audio capture.
    await api("POST", "/meetings/start", {
      ...value,
      audio_dir: audioDir,
      started_at: startedAt,
    });
    await api("POST", `/meetings/${value.id}/stop`, {
      ended_at: startedAt + 180_000,
      duration_ms: 180_000,
    });
  }
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test("folders move meetings, block delete, and keep links after restart", async () => {
  test.setTimeout(180_000);
  await page.goto("app://renderer/meetings");
  await expect(meeting("Unfiled", MEETINGS[0].title)).toBeVisible();

  await createFolder("Kitchen renovation");
  await moveByContext("Unfiled", MEETINGS[0].title, "Kitchen renovation");
  await expect(meeting("Kitchen renovation", MEETINGS[0].title)).toBeVisible();

  await meeting("Unfiled", MEETINGS[1].title).click();
  await page
    .getByRole("button", { name: "Move to folder", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^Kitchen renovation/ }).click();
  await expect(groupRow("Kitchen renovation").locator(".mono")).toHaveText("2");
  await expect(groupRow("Unfiled").locator(".mono")).toHaveText("1");
  await expect(meeting("Kitchen renovation", MEETINGS[1].title)).toBeVisible();
  await expect(meeting("Unfiled", MEETINGS[2].title)).toBeVisible();
  await expect(meeting("Unfiled", MEETINGS[0].title)).toHaveCount(0);
  await expect(meeting("Unfiled", MEETINGS[1].title)).toHaveCount(0);
  await shoot("folder-tree.png", rail());

  await groupRow("Kitchen renovation")
    .getByRole("button", { name: "Kitchen renovation", exact: true })
    .click();
  const count = panel("Kitchen renovation")
    .getByText("Meetings", { exact: true })
    .locator("..")
    .locator(".display");
  await expect(count).toHaveText("2");
  await shoot("folder-panel.png", panel("Kitchen renovation"));

  await folderAction("Kitchen renovation", "Rename folder");
  const rename = rail().getByRole("textbox", {
    name: "Folder name",
    exact: true,
  });
  await rename.fill("Kitchen remodel");
  await rename.press("Enter");
  await expect(groupRow("Kitchen remodel")).toBeVisible();
  await expect(groupRow("Kitchen renovation")).toHaveCount(0);

  await folderAction("Kitchen remodel", "Delete folder");
  const blocked = panel("Kitchen remodel").getByRole("alert");
  await expect(blocked).toContainText("You cannot delete this folder.");
  await expect(blocked).toContainText("Meetings in this folder: 2.");
  await expect(blocked).toContainText("Move or remove the meetings first.");
  await shoot("blocked-delete.png", blocked);

  await moveByContext("Kitchen remodel", MEETINGS[0].title, null);
  await expect(groupRow("Kitchen remodel").locator(".mono")).toHaveText("1");
  await moveByContext("Kitchen remodel", MEETINGS[1].title, null);
  await expect(groupRow("Kitchen remodel").locator(".mono")).toHaveText("0");
  await expect(groupRow("Unfiled").locator(".mono")).toHaveText("3");
  await folderAction("Kitchen remodel", "Delete folder");
  const confirm = panel("Kitchen remodel").getByRole("alert");
  await expect(confirm).toContainText("The folder is empty.");
  await confirm
    .getByRole("button", { name: "Delete folder", exact: true })
    .click();
  await expect(groupRow("Kitchen remodel")).toHaveCount(0);

  await createFolder("Book club");
  await moveByContext("Unfiled", MEETINGS[2].title, "Book club");
  await expect(groupRow("Book club").locator(".mono")).toHaveText("1");
  await groupRow("Book club")
    .getByRole("button", { name: "Book club", exact: true })
    .click();
  await expect(
    rail().getByText("Records into", { exact: true }).locator(".."),
  ).toContainText("Book club");

  // Reuse the profile. Do not seed data on the second launch.
  await closeApp(app!);
  app = undefined;
  await launch();
  await page.goto("app://renderer/meetings");
  await expect(groupRow("Book club")).toBeVisible();
  await groupRow("Book club")
    .getByRole("button", { name: "Book club", exact: true })
    .click();
  await expect(meeting("Book club", MEETINGS[2].title)).toBeVisible();
  await expect(groupRow("Book club").locator(".mono")).toHaveText("1");
  await expect(
    rail().getByText("Records into", { exact: true }).locator(".."),
  ).toContainText("Book club");
  await expect(groupRow("Kitchen remodel")).toHaveCount(0);

  const folderBody = (await (await api("GET", "/meetings/folders")).json()) as {
    items: FolderRow[];
  };
  expect(folderBody.items).toHaveLength(1);
  const book = folderBody.items[0];
  expect(book.name).toBe("Book club");
  expect(book.meeting_count).toBe(1);
  const meetingBody = (await (
    await api("GET", `/meetings?folder_id=${encodeURIComponent(book.id)}`)
  ).json()) as { items: MeetingRow[] };
  expect(meetingBody.items).toHaveLength(1);
  expect(meetingBody.items[0]).toMatchObject({
    ...MEETINGS[2],
    folder_id: book.id,
  });
  console.log(
    "FOLDER_DB_READBACK",
    JSON.stringify({
      folder: {
        id: book.id,
        name: book.name,
        meeting_count: book.meeting_count,
      },
      meeting: {
        id: meetingBody.items[0].id,
        title: meetingBody.items[0].title,
        folder_id: meetingBody.items[0].folder_id,
      },
    }),
  );
});
