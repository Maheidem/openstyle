import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type Booted, boot, put } from "./helpers/ask-app";
import {
  FakeAskLlm,
  LONG_FOLDER_NAME,
  seedAskMeetings,
  seedClarifyExtras,
} from "./helpers/ask-fixture";
import { closeApp } from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// Chat agent, decision D20 (specs/meeting-chat-agent.md 11.8): the clarifying
// question (chips on the Ask page and in the bubble, "Answer anyway", the
// setting) and the map-reduce answer for a big folder. A fake OpenAI-compatible
// server answers, so CI needs no model and no GPU. All data is fictional.
// Set OPENSTYLE_EVIDENCE_DIR for the light and dark screenshots.
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;
const Q_AMBIGUOUS = "What is the status of Harbor?";
const Q_STORY = "Tell me the story of this folder.";

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

/** "New chat" is disabled while the thread is empty. */
async function newChat(page: Page): Promise<void> {
  const button = page.getByTestId("meeting-ask-new");
  if (await button.isEnabled()) await button.click();
  await expect(page.getByTestId("meeting-ask-assistant")).toHaveCount(0);
}

async function ask(page: Page, question: string): Promise<Locator> {
  const answers = page.getByTestId("meeting-ask-assistant");
  const before = await answers.count();
  await page.getByTestId("meeting-ask-input").fill(question);
  await page.getByTestId("meeting-ask-send").click();
  await expect(answers).toHaveCount(before + 1, { timeout: 30_000 });
  return answers.nth(before);
}

async function bubblePage(b: Booted): Promise<Page> {
  const find = (): Page | undefined =>
    b.app.windows().find((w) => w.url().includes("chat-bubble"));
  const found = find();
  if (found) return found;
  return await b.app.waitForEvent("window", {
    predicate: (w) => w.url().includes("chat-bubble"),
    timeout: 20_000,
  });
}

test.describe.configure({ mode: "serial" });

let b: Booted;
let fake: FakeAskLlm;
let page: Page;

test.beforeAll(async () => {
  test.setTimeout(90_000);
  fake = new FakeAskLlm();
  await fake.start();
  b = await boot("openstyle-e2e-ask-clarify-", {});
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
  seedAskMeetings(b.userDataDir, { extra: true });
  seedClarifyExtras(b.userDataDir);
});

test.afterAll(async () => {
  if (b?.app) await closeApp(b.app);
  if (b) rmSync(b.userDataDir, { recursive: true, force: true });
  await fake?.stop();
});

for (const theme of ["Light", "Dark"] as const) {
  test(`Ask page, Everything (${theme}): two folders share a word, the answer is a question with chips; a chip click answers in the same thread`, async () => {
    test.setTimeout(120_000);
    await setTheme(page, theme);
    await page.goto("app://renderer/ask");
    await expect(page.getByTestId("ask-page")).toBeVisible({ timeout: 15_000 });
    await newChat(page);
    const callsBefore = fake.requests.length;
    const turn = await ask(page, Q_AMBIGUOUS);
    const block = turn.getByTestId("meeting-ask-block-clarify");
    await expect(block).toBeVisible();
    // Two folder chips and "Answer anyway". The turn made no model call.
    const options = block.getByTestId("meeting-ask-clarify-option");
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveText("Harbor crane");
    await expect(options.nth(1)).toHaveText("Harbor pricing");
    await expect(block.getByTestId("meeting-ask-clarify-anyway")).toBeVisible();
    expect(fake.requests.length).toBe(callsBefore);
    await shoot(page, `clarify-ask-page-${theme.toLowerCase()}.png`);

    await options.nth(1).click();
    const next = page.getByTestId("meeting-ask-assistant").nth(1);
    await expect(next).toBeVisible({ timeout: 30_000 });
    // Same thread: two user messages, two answers. The second is not a question.
    await expect(page.getByTestId("meeting-ask-user")).toHaveCount(2);
    await expect(next.getByTestId("meeting-ask-block-clarify")).toHaveCount(0);
    // The first block is answered: its chips are disabled.
    await expect(
      page
        .getByTestId("meeting-ask-assistant")
        .nth(0)
        .getByTestId("meeting-ask-clarify-option")
        .first(),
    ).toBeDisabled();
    expect(fake.requests.length).toBeGreaterThan(callsBefore);
  });
}

test("Ask page: a question with no topic asks for the intent, and Answer anyway runs it", async () => {
  test.setTimeout(120_000);
  await page.goto("app://renderer/ask");
  await newChat(page);
  const turn = await ask(page, "status?");
  const block = turn.getByTestId("meeting-ask-block-clarify");
  await expect(block).toBeVisible();
  await expect(block.getByTestId("meeting-ask-clarify-option")).toHaveCount(4);
  await block.getByTestId("meeting-ask-clarify-anyway").click();
  const next = page.getByTestId("meeting-ask-assistant").nth(1);
  await expect(next).toBeVisible({ timeout: 30_000 });
  await expect(next.getByTestId("meeting-ask-block-clarify")).toHaveCount(0);
  // The same question ran again: one user message in the thread twice.
  await expect(page.getByTestId("meeting-ask-user")).toHaveCount(2);
  // The second answer has a block of its own (a status or a not found).
  expect(
    await next.locator("[data-testid^='meeting-ask-block']").count(),
  ).toBeGreaterThan(0);
});

test("Ask page: the setting off turns the question off", async () => {
  test.setTimeout(90_000);
  await put(b, "chat_clarify", "false");
  await page.goto("app://renderer/ask");
  await newChat(page);
  const turn = await ask(page, Q_AMBIGUOUS);
  await expect(turn.getByTestId("meeting-ask-block-clarify")).toHaveCount(0);
  await put(b, "chat_clarify", "true");
});

for (const theme of ["Light", "Dark"] as const) {
  test(`the bubble shows the chips too (${theme}), and a chip click answers`, async () => {
    test.setTimeout(120_000);
    await setTheme(page, theme);
    await page.goto("app://renderer/meetings");
    await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible({
      timeout: 20_000,
    });
    await page.evaluate(() => window.api.setChatSelection(null));
    await page.evaluate(() =>
      window.electron.ipcRenderer.send("e2e:trigger-chat-hotkey"),
    );
    const bubble = await bubblePage(b);
    await expect(bubble.getByTestId("chat-bubble")).toHaveAttribute(
      "data-scope",
      "all",
    );
    await bubble.getByTestId("chat-bubble-input").fill(Q_AMBIGUOUS);
    await bubble.getByTestId("chat-bubble-send").click();
    const answer = bubble.getByTestId("chat-bubble-answer");
    const block = answer.getByTestId("meeting-ask-block-clarify");
    await expect(block).toBeVisible({ timeout: 30_000 });
    await expect(block.getByTestId("meeting-ask-clarify-option")).toHaveCount(
      2,
    );
    await shoot(bubble, `clarify-bubble-${theme.toLowerCase()}.png`);
    await block.getByTestId("meeting-ask-clarify-option").first().click();
    await expect(
      bubble
        .getByTestId("chat-bubble-answer")
        .getByTestId("meeting-ask-block-clarify"),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(bubble.getByTestId("chat-bubble-answer")).toBeVisible();
  });
}

for (const theme of ["Light", "Dark"] as const) {
  test(`Ask page, big folder (${theme}): map notes shorten the digest, the answer has bullets with real cites`, async () => {
    test.setTimeout(150_000);
    await setTheme(page, theme);
    await page.goto("app://renderer/ask");
    await page.getByRole("radio", { name: "A folder" }).click();
    await page.getByTestId("ask-pick-folder").click();
    await page.getByRole("option", { name: LONG_FOLDER_NAME }).click();
    await newChat(page);
    const mapBefore = fake.ofKind("chat_map_notes").length;
    const turn = await ask(page, Q_STORY);
    const texts = turn.getByTestId("meeting-ask-block-text");
    expect(await texts.count()).toBeGreaterThanOrEqual(3);
    // The map step ran, and the final calls read the notes (one per date slice).
    expect(fake.ofKind("chat_map_notes").length).toBeGreaterThan(mapBefore);
    const synth = fake.ofKind("chat_synthesis");
    expect(synth.length).toBeGreaterThanOrEqual(2);
    const last = synth.at(-1)?.user ?? "";
    expect(last).toContain("Program step 30");
    expect(synth.some((r) => r.user.includes("Program step 1,"))).toBe(true);
    // Every cite chip opens a meeting of the folder.
    expect(
      await turn.getByTestId("meeting-ask-cite").count(),
    ).toBeGreaterThanOrEqual(2);
    await turn.getByTestId("meeting-ask-trail").locator("summary").click();
    await expect(turn.getByTestId("meeting-ask-trail")).toContainText(
      /shortened 30 meeting summaries/,
    );
    await shoot(page, `map-reduce-answer-${theme.toLowerCase()}.png`);
  });
}
