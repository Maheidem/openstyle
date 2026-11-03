import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type Booted, boot, put, settingValue } from "./helpers/ask-app";
import {
  BACKLOG_FOLDER_NAME,
  BACKLOG_TASKS,
  FakeAskLlm,
  seedAskMeetings,
  seedBacklog,
} from "./helpers/ask-fixture";
import { closeApp } from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// Chat agent, decision D21 (specs/meeting-chat-agent.md 11.9): the research
// mode. A question that needs digging runs the graph loop (act, observe,
// reflect). The step text names the round, the answer has a trail line, and
// the details sit under "How I found this". A simple fact stays on the fast
// path, the setting turns the loop off, and a turn survives a page change.
// A fake OpenAI-compatible server answers, so CI needs no model and no GPU.
// All data is fictional. Set OPENSTYLE_EVIDENCE_DIR for the screenshots.
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;
const Q_LIST = "What are the open items in this project?";
const Q_WHY = "Why are these still open?";
const Q_FACT = "Who owns the vendor contract draft?";

async function shoot(page: Page, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  await page.waitForTimeout(600);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE_DIR, name) });
}

async function setTheme(page: Page, name: "Light" | "Dark"): Promise<void> {
  await page.goto("app://renderer/settings#display");
  await page.getByRole("radio", { name, exact: true }).click();
  if (name === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

/** A fresh thread (see meeting-ask-clarify.test.ts for why the check repeats). */
async function newChat(page: Page): Promise<void> {
  const users = page.getByTestId("meeting-ask-user");
  const button = page.getByTestId("meeting-ask-new");
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(700);
    if ((await users.count()) === 0) return;
    if (await button.isEnabled()) await button.click();
  }
  await expect(users).toHaveCount(0);
}

async function openFolderAsk(
  page: Page,
  folder = "Orchid project",
): Promise<void> {
  await page.goto("app://renderer/ask");
  await expect(page.getByTestId("ask-page")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("radio", { name: "A folder" }).click();
  await page.getByTestId("ask-pick-folder").click();
  await page.getByRole("option", { name: folder }).click();
  await newChat(page);
}

async function send(page: Page, question: string): Promise<number> {
  const answers = page.getByTestId("meeting-ask-assistant");
  const before = await answers.count();
  await page.getByTestId("meeting-ask-input").fill(question);
  await page.getByTestId("meeting-ask-send").click();
  return before;
}

async function answerAt(page: Page, index: number): Promise<Locator> {
  const answers = page.getByTestId("meeting-ask-assistant");
  await expect(answers).toHaveCount(index + 1, { timeout: 60_000 });
  return answers.nth(index);
}

test.describe.configure({ mode: "serial" });

let b: Booted;
let fake: FakeAskLlm;
let page: Page;

test.beforeAll(async () => {
  test.setTimeout(90_000);
  fake = new FakeAskLlm();
  await fake.start();
  b = await boot("openstyle-e2e-ask-research-", {});
  page = b.page;
  const added = await b.api("POST", "/servers", { url: fake.url });
  expect(added.status, "POST /api/servers").toBe(201);
  const { id: serverId } = (await added.json()) as { id: string };
  const model = await b.api("POST", "/models/configured", {
    provider: "server",
    model_id: `server/${serverId}/fake-llm`,
    model_name: "Fake LLM",
    type: "llm",
    is_default: true,
  });
  expect(model.ok, "POST /api/models/configured").toBe(true);
  await put(b, "meeting_enhance_prompt_seen", "true");
  await put(b, "meeting_chat_enabled", "true");
  seedAskMeetings(b.userDataDir);
  seedBacklog(b.userDataDir);
});

test.afterAll(async () => {
  if (b?.app) await closeApp(b.app);
  if (b) rmSync(b.userDataDir, { recursive: true, force: true });
  await fake?.stop();
});

// CI runs the light theme only (the E2E step has a 10 minute limit). With an
// evidence folder both themes run, and each one saves its screenshots.
const THEMES = EVIDENCE_DIR
  ? (["Light", "Dark"] as const)
  : (["Light"] as const);

for (const theme of THEMES) {
  test(`research question (${theme}): step text, a trail line and a cited answer from several meetings`, async () => {
    test.setTimeout(150_000);
    await setTheme(page, theme);
    await openFolderAsk(page);
    // Turn 1: the open items. A list answers it, with no model call.
    const first = await send(page, Q_LIST);
    const list = await answerAt(page, first);
    await expect(
      list.getByTestId("meeting-ask-block-list").first(),
    ).toBeVisible();
    // Turn 2: "why are these open?" digs. One worker for each item (11.9.16).
    fake.reflectDelayMs = 1500;
    const workersBefore = fake.ofKind("chat_dig_item").length;
    const second = await send(page, Q_WHY);
    await expect(page.getByTestId("meeting-ask-status")).toContainText(
      /Looking for/,
      { timeout: 30_000 },
    );
    await shoot(page, `research-step-text-${theme.toLowerCase()}.png`);
    const turn = await answerAt(page, second);
    fake.reflectDelayMs = 0;
    expect(fake.ofKind("chat_dig_item").length).toBeGreaterThan(workersBefore);
    // The answer has bullets, and the cites come from more than one meeting.
    expect(
      await turn.getByTestId("meeting-ask-block-text").count(),
    ).toBeGreaterThanOrEqual(3);
    // Every chip names its meeting at folder scope (design gap G1).
    const chips = turn.getByTestId("meeting-ask-cite");
    expect(await chips.count()).toBeGreaterThanOrEqual(2);
    const titles = new Set(
      (await chips.allInnerTexts()).map((t) => t.split("·")[1]?.trim()),
    );
    expect(titles.size).toBeGreaterThanOrEqual(2);
    // The trail line: built from fields, under the answer.
    const trail = turn.getByTestId("meeting-ask-research-trail");
    await expect(trail).toBeVisible();
    await expect(trail).toHaveText(/Looked in [2-9] meetings · \d+ searches?/);
    // The details sit under "How I found this".
    await turn.getByTestId("meeting-ask-trail").locator("summary").click();
    await expect(
      turn.getByTestId("meeting-ask-research-details"),
    ).toContainText(/Research: \d of \d rounds\./);
    await shoot(page, `research-answer-${theme.toLowerCase()}.png`);
  });
}

for (const theme of THEMES) {
  test(`a long list is capped (${theme}): at most 12 items, "more" line, "Show all" gives the rest (11.9.16)`, async () => {
    test.setTimeout(150_000);
    await setTheme(page, theme);
    await openFolderAsk(page, BACKLOG_FOLDER_NAME);
    const first = await send(page, "What are the open items in this folder?");
    const turn = await answerAt(page, first);
    const blocks = turn.getByTestId("meeting-ask-block-list");
    await expect(blocks.first()).toBeVisible();
    const shown = await turn.getByTestId("meeting-ask-list-item").count();
    expect(shown).toBeGreaterThanOrEqual(8);
    expect(shown).toBeLessThanOrEqual(12);
    // The items are grouped by meeting, and the list says how many are left.
    expect(
      await turn.getByTestId("meeting-ask-list-group").count(),
    ).toBeGreaterThanOrEqual(2);
    await expect(turn.getByTestId("meeting-ask-list-more").first()).toHaveText(
      /\d+ more items? not shown/,
    );
    // The best-raised tasks (the first 4, raised twice) are in the short list.
    const text = await turn.innerText();
    for (const task of BACKLOG_TASKS.slice(0, 4)) {
      expect(text).toContain(task);
    }
    // The "more" line is at the end of a long list: scroll to it for the proof.
    await turn
      .getByTestId("meeting-ask-show-all")
      .first()
      .scrollIntoViewIfNeeded();
    await shoot(page, `list-capped-${theme.toLowerCase()}.png`);
    // "Show all": the same question again, with no cap.
    await turn.getByTestId("meeting-ask-show-all").first().click();
    const all = await answerAt(page, first + 1);
    await expect(all.getByTestId("meeting-ask-list-more")).toHaveCount(0);
    expect(
      await all.getByTestId("meeting-ask-list-item").count(),
    ).toBeGreaterThan(shown);
    await shoot(page, `list-show-all-${theme.toLowerCase()}.png`);
  });
}

test("a simple fact stays on the fast path: no reflect call, no trail line", async () => {
  test.setTimeout(90_000);
  await openFolderAsk(page);
  const reflectBefore = fake.ofKind("chat_reflect").length;
  const index = await send(page, Q_FACT);
  const turn = await answerAt(page, index);
  expect(fake.ofKind("chat_reflect").length).toBe(reflectBefore);
  await expect(turn.getByTestId("meeting-ask-research-trail")).toHaveCount(0);
});

test("leaving the Ask page during a research turn keeps the turn", async () => {
  test.setTimeout(120_000);
  await openFolderAsk(page);
  const first = await send(page, Q_LIST);
  await answerAt(page, first);
  fake.reflectDelayMs = 2500;
  const second = await send(page, Q_WHY);
  await expect(page.getByTestId("meeting-ask-status")).toContainText(
    /Looking for/,
    { timeout: 30_000 },
  );
  // Leave while the loop runs, then come back.
  await page.goto("app://renderer/settings#display");
  await page.waitForTimeout(1500);
  await page.goto("app://renderer/ask");
  await expect(page.getByTestId("ask-page")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("radio", { name: "A folder" }).click();
  await page.getByTestId("ask-pick-folder").click();
  await page.getByRole("option", { name: "Orchid project" }).click();
  fake.reflectDelayMs = 0;
  const turn = await answerAt(page, second);
  await expect(turn.getByTestId("meeting-ask-research-trail")).toBeVisible({
    timeout: 60_000,
  });
});

test("the setting turns the loop off: the same question makes no reflect call", async () => {
  test.setTimeout(120_000);
  await put(b, "chat_research", "false");
  try {
    await openFolderAsk(page);
    const first = await send(page, Q_LIST);
    await answerAt(page, first);
    const reflectBefore = fake.ofKind("chat_reflect").length;
    const second = await send(page, Q_WHY);
    const turn = await answerAt(page, second);
    expect(fake.ofKind("chat_reflect").length).toBe(reflectBefore);
    await expect(turn.getByTestId("meeting-ask-research-trail")).toHaveCount(0);
  } finally {
    await put(b, "chat_research", "true");
  }
});

test("the Ask settings page has the research switch: on by default, it writes chat_research", async () => {
  test.setTimeout(60_000);
  await page.goto("app://renderer/settings#ask");
  const sw = page.getByTestId("settings-ask-research");
  await expect(sw).toBeVisible({ timeout: 15_000 });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect.poll(() => settingValue(b, "chat_research")).toBe("false");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect.poll(() => settingValue(b, "chat_research")).toBe("true");
});
