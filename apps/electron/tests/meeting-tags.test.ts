import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page, test } from "@playwright/test";
import {
  closeApp,
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";
import {
  type Answer,
  bootEnhanceApp,
  type ChatRequest,
  defaultSegments,
  type EnhanceApp,
  FakeLlm,
  openMeeting,
  seedMeeting,
  waitForRun,
} from "./helpers/enhance-fixture";

// ---------------------------------------------------------------------------
// Meeting tags in the real app (issue #231). A fake own server stands in for
// the model. The proof:
//   1. Enhance suggests tags: the chips show in the detail header;
//   2. the user removes a tag, types a new one, and adds an existing tag
//      from the suggestions on a meeting with no Enhance run (no LLM);
//   3. the tags persist after a restart: read back from the DB.
// All meetings and words are fictional.
// ---------------------------------------------------------------------------

const ENHANCED = { id: "e2e-tags-1", title: "Garden budget sync" };
const MANUAL = { id: "e2e-tags-2", title: "Shed paint review" };

const fake = new FakeLlm();
let env: EnhanceApp;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fake.start();
  env = await bootEnhanceApp(fake, {
    advancedMode: false,
    prefix: "openstyle-e2e-tags-",
  });
});

test.afterAll(async () => {
  if (env) {
    await closeApp(env.app);
    rmSync(env.userDataDir, { recursive: true, force: true });
  }
  await fake.stop();
});

function answer(req: ChatRequest): Answer {
  if (req.step === "meeting_tags") {
    // Mixed case, extra space and a duplicate: the server normalizes them.
    return {
      content: JSON.stringify({
        tags: ["Garden  Budget", "seed order", "garden budget"],
      }),
    };
  }
  if (req.step === "correct_chunk") {
    return { content: JSON.stringify({ corrections: [] }) };
  }
  if (req.step === "identify_speakers") {
    return { content: JSON.stringify({ speakers: [] }) };
  }
  return {
    content: JSON.stringify({
      overview: "The group checked the garden budget.",
      keyPoints: ["The budget holds."],
      decisions: [],
      actionItems: [],
      openQuestions: [],
    }),
  };
}

function tagChips(page: Page) {
  return page.getByRole("list", { name: "Tags" });
}

function readTagRows(
  userDataDir: string,
): Array<{ meeting_id: string; name: string; source: string }> {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db
      .prepare(
        `SELECT mt.meeting_id, t.name, mt.source
           FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
          ORDER BY mt.meeting_id, t.name`,
      )
      .all() as Array<{ meeting_id: string; name: string; source: string }>;
  } finally {
    db.close();
  }
}

async function waitForTagSave(page: Page, meetingId: string): Promise<void> {
  await page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/meetings/${meetingId}/tags` &&
      r.request().method() === "PUT" &&
      r.ok(),
  );
}

test("Enhance suggests tags, the user edits them, and they persist after a restart", async () => {
  test.setTimeout(180_000);
  fake.requests.length = 0;
  fake.script = answer;
  seedMeeting(env.userDataDir, ENHANCED.id, ENHANCED.title, defaultSegments(2));
  seedMeeting(env.userDataDir, MANUAL.id, MANUAL.title, defaultSegments(1));

  // 1. Enhance suggests tags.
  await openMeeting(env.page, ENHANCED.title);
  await env.page.getByRole("button", { name: "Enhance", exact: true }).click();
  const run = await waitForRun(env, ENHANCED.id, ["succeeded", "partial"]);
  expect(run.status).toBe("succeeded");
  expect(fake.requests.filter((r) => r.step === "meeting_tags")).toHaveLength(
    1,
  );
  const chips = tagChips(env.page);
  await expect(chips.getByText("garden budget", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(chips.getByText("seed order", { exact: true })).toBeVisible();
  expect(readTagRows(env.userDataDir)).toEqual([
    { meeting_id: ENHANCED.id, name: "garden budget", source: "llm" },
    { meeting_id: ENHANCED.id, name: "seed order", source: "llm" },
  ]);

  // 2a. Remove one tag and type a new one.
  let saved = waitForTagSave(env.page, ENHANCED.id);
  await env.page
    .getByRole("button", { name: "Remove the tag seed order" })
    .click();
  await saved;
  await expect(chips.getByText("seed order", { exact: true })).toHaveCount(0);
  const input = env.page.getByRole("textbox", { name: "Add a tag" });
  await input.fill("  Kitchen Plan ");
  saved = waitForTagSave(env.page, ENHANCED.id);
  await input.press("Enter");
  await saved;
  await expect(chips.getByText("kitchen plan", { exact: true })).toBeVisible();

  // 2b. A meeting with no Enhance run: pick an existing tag from the list.
  await openMeeting(env.page, MANUAL.title);
  const manualInput = env.page.getByRole("textbox", { name: "Add a tag" });
  await manualInput.fill("gar");
  saved = waitForTagSave(env.page, MANUAL.id);
  await env.page
    .getByRole("button", { name: "garden budget", exact: true })
    .click();
  await saved;
  await expect(
    tagChips(env.page).getByText("garden budget", { exact: true }),
  ).toBeVisible();

  const before = readTagRows(env.userDataDir);
  expect(before).toEqual([
    { meeting_id: ENHANCED.id, name: "garden budget", source: "llm" },
    { meeting_id: ENHANCED.id, name: "kitchen plan", source: "user" },
    { meeting_id: MANUAL.id, name: "garden budget", source: "user" },
  ]);

  // 3. Restart on the same profile. Seed nothing on the second launch.
  await closeApp(env.app);
  env.app = await launchOpenstyle({ userDataDir: env.userDataDir });
  await env.app.context().addInitScript(() => {
    localStorage.setItem("i18nextLng", "en");
  });
  env.page = await waitForDashboardWindow(env.app, 15_000);
  await env.page.waitForLoadState("load");
  env.base = embeddedServerUrl(env.app);
  const base = env.base;
  env.api = (method: string, path: string, body?: unknown) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  await openMeeting(env.page, ENHANCED.title);
  await expect(
    tagChips(env.page).getByText("garden budget", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    tagChips(env.page).getByText("kitchen plan", { exact: true }),
  ).toBeVisible();
  const detail = (await (
    await env.api("GET", `/meetings/${ENHANCED.id}`)
  ).json()) as { tags: string[] };
  expect(detail.tags).toEqual(["garden budget", "kitchen plan"]);
  const all = (await (await env.api("GET", "/meetings/tags")).json()) as {
    items: Array<{ name: string; meeting_count: number }>;
  };
  expect(all.items).toEqual(
    expect.arrayContaining([
      { name: "garden budget", meeting_count: 2 },
      { name: "kitchen plan", meeting_count: 1 },
    ]),
  );
  const after = readTagRows(env.userDataDir);
  expect(after).toEqual(before);
  console.log("TAGS_DB_READBACK", JSON.stringify(after));
});
