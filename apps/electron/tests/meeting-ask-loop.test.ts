import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type Booted, boot, put, settingValue } from "./helpers/ask-app";
import {
  FakeAskLlm,
  FERRY_QUESTION,
  HARBOR_FOLDER_NAME,
  NOT_FOUND_MARK,
  seedAskMeetings,
  seedClarifyExtras,
} from "./helpers/ask-fixture";
import { closeApp } from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// Chat agent, decision D22 (specs/meeting-chat-agent.md 11.10): the Ask tool
// loop behind the setting chat_engine. The settings row, the Ask page on a
// folder (a cited answer, the step text, the not-found card, the clarifying
// question, a thread that survives a page change) and the bubble all run with
// chat_engine=loop. The model id holds "e2b", so the profile of code forces
// list_meetings as the first call (no search index is needed). A fake OpenAI-compatible server answers, so CI needs no
// model and no GPU. All data is fictional. Set OPENSTYLE_EVIDENCE_DIR for the
// light and dark screenshots.
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;
const Q_FACT = "Who owns the vendor contract draft?";
const Q_AMBIGUOUS = "What is the status of Harbor?";

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
  b = await boot("openstyle-e2e-ask-loop-", {});
  page = b.page;
  const added = await b.api("POST", "/servers", { url: fake.url });
  expect(added.status, "POST /api/servers").toBe(201);
  const { id: serverId } = (await added.json()) as { id: string };
  const model = await b.api("POST", "/models/configured", {
    provider: "server",
    model_id: `server/${serverId}/fake-gemma-4-e2b`,
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

const THEMES = EVIDENCE_DIR
  ? (["Light", "Dark"] as const)
  : (["Light"] as const);

test("the Ask settings page has the answer method: the tool loop by default, it writes chat_engine", async () => {
  test.setTimeout(60_000);
  await page.goto("app://renderer/settings#ask");
  const select = page.getByTestId("settings-ask-engine");
  await expect(select).toBeVisible({ timeout: 15_000 });
  await expect(select).toContainText("Tool loop");
  expect(await settingValue(b, "chat_engine")).toBeUndefined();
  await select.click();
  await page.getByRole("option", { name: "Classic" }).click();
  await expect.poll(() => settingValue(b, "chat_engine")).toBe("pipeline");
  await expect(select).toContainText("Classic");
  await shoot(page, "loop-settings.png");
});

for (const theme of THEMES) {
  test(`Ask page, folder tab (${theme}): the loop answers a fact with a cite chip and a step text`, async () => {
    test.setTimeout(120_000);
    await put(b, "chat_engine", "loop");
    await setTheme(page, theme);
    await openFolderAsk(page);
    fake.reflectDelayMs = 2500;
    const loopBefore = fake.ofKind("native").length;
    const index = await send(page, Q_FACT);
    // The step text names the round of the loop (the model of the test is an E2B: 3 rounds).
    await expect(page.getByTestId("meeting-ask-status")).toContainText(
      /Looking for the answer, round 1 of 3/,
      { timeout: 30_000 },
    );
    await shoot(page, `loop-step-text-${theme.toLowerCase()}.png`);
    const turn = await answerAt(page, index);
    fake.reflectDelayMs = 0;
    // The engine ran the loop: a tool turn with the four tools, then the loop answer.
    const steps = fake.ofKind("native").slice(loopBefore);
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(
      fake.ofKind("chat_loop_answer").length,
      JSON.stringify(fake.requests.map((r) => [r.kind, r.answered])),
    ).toBeGreaterThanOrEqual(1);
    // Code owns the cites: the schema of the answer step has no cite field.
    const answerCall = fake.ofKind("chat_loop_answer").at(-1);
    expect(JSON.stringify(answerCall?.body ?? {})).not.toContain('"cites"');
    const text = turn.getByTestId("meeting-ask-block-text");
    await expect(text.first()).toBeVisible();
    // The fake answer copies a source, so the attribution finds it and a chip shows.
    expect(
      await turn.getByTestId("meeting-ask-cite").count(),
    ).toBeGreaterThanOrEqual(1);
    await shoot(page, `loop-answer-${theme.toLowerCase()}.png`);
  });
}

test("the not-found card: a question that no source answers", async () => {
  test.setTimeout(90_000);
  await put(b, "chat_engine", "loop");
  await openFolderAsk(page);
  const index = await send(page, `What is the plan for the ${NOT_FOUND_MARK}?`);
  const turn = await answerAt(page, index);
  await expect(turn.getByTestId("meeting-ask-block-not-found")).toBeVisible();
  await shoot(page, "loop-not-found.png");
});

for (const theme of THEMES) {
  test(`the clarifying question still comes first (${theme}) and a chip answers through the loop`, async () => {
    test.setTimeout(120_000);
    await put(b, "chat_engine", "loop");
    await setTheme(page, theme);
    await page.goto("app://renderer/ask");
    await expect(page.getByTestId("ask-page")).toBeVisible({ timeout: 15_000 });
    await newChat(page);
    const callsBefore = fake.requests.length;
    const index = await send(page, Q_AMBIGUOUS);
    const turn = await answerAt(page, index);
    const block = turn.getByTestId("meeting-ask-block-clarify");
    await expect(block).toBeVisible();
    // The clarify block is code only: the turn made no model call.
    expect(fake.requests.length).toBe(callsBefore);
    await shoot(page, `loop-clarify-${theme.toLowerCase()}.png`);
    const options = block.getByTestId("meeting-ask-clarify-option");
    await options.nth(1).click();
    const next = page.getByTestId("meeting-ask-assistant").nth(1);
    await expect(next).toBeVisible({ timeout: 30_000 });
    await expect(next.getByTestId("meeting-ask-block-clarify")).toHaveCount(0);
    expect(fake.ofKind("chat_loop_answer").length).toBeGreaterThanOrEqual(1);
  });
}

test("a thread survives a page change with the loop", async () => {
  test.setTimeout(120_000);
  await put(b, "chat_engine", "loop");
  await openFolderAsk(page);
  const index = await send(page, Q_FACT);
  await answerAt(page, index);
  await page.goto("app://renderer/settings#display");
  await page.waitForTimeout(1000);
  await page.goto("app://renderer/ask");
  await expect(page.getByTestId("ask-page")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("radio", { name: "A folder" }).click();
  await page.getByTestId("ask-pick-folder").click();
  await page.getByRole("option", { name: "Orchid project" }).click();
  await expect(page.getByTestId("meeting-ask-user").first()).toContainText(
    Q_FACT,
    { timeout: 20_000 },
  );
  expect(
    await page.getByTestId("meeting-ask-cite").count(),
  ).toBeGreaterThanOrEqual(1);
});

for (const theme of THEMES) {
  test(`the bubble (${theme}): the Meetings selection sets the scope and the loop answers with chips`, async () => {
    test.setTimeout(120_000);
    await put(b, "chat_engine", "loop");
    await setTheme(page, theme);
    await page.goto("app://renderer/meetings?meeting=ask-m-pricing");
    await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.electron.ipcRenderer.invoke("e2e:chat-selection"),
        ),
      )
      .toEqual({ kind: "meeting", id: "ask-m-pricing" });
    await page.evaluate(() =>
      window.electron.ipcRenderer.send("e2e:trigger-chat-hotkey"),
    );
    const bubble = await bubblePage(b);
    await expect(bubble.getByTestId("chat-bubble")).toBeVisible({
      timeout: 20_000,
    });
    const widen = bubble.getByTestId("chat-bubble-widen");
    await expect(widen).toContainText(HARBOR_FOLDER_NAME);
    await widen.click();
    await expect(bubble.getByTestId("chat-bubble")).toHaveAttribute(
      "data-scope",
      /^folder:/,
    );
    await bubble.getByTestId("chat-bubble-input").fill(FERRY_QUESTION);
    await bubble.getByTestId("chat-bubble-send").click();
    const answer = bubble.getByTestId("chat-bubble-answer");
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(answer).toContainText("ferry");
    expect(
      await answer.getByTestId("meeting-ask-cite").count(),
    ).toBeGreaterThanOrEqual(1);
    await shoot(bubble, `loop-bubble-${theme.toLowerCase()}.png`);
    await bubble.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.electron.ipcRenderer.invoke("e2e:chat-bubble-visible"),
        ),
      )
      .toBe(false);
  });
}
