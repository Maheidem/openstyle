import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type Booted,
  boot,
  hfCacheDir,
  put,
  settingValue,
} from "./helpers/ask-app";
import {
  FakeAskLlm,
  FERRY_QUESTION,
  FOLDER_ID,
  FOLDER_NAME,
  HARBOR_FOLDER_ID,
  HARBOR_FOLDER_NAME,
  MEETINGS,
  seedAskMeetings,
} from "./helpers/ask-fixture";
import { closeApp } from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// Chat agent P2 (specs/meeting-chat-agent.md 11.6, decision D19): the Ask
// page, the folder Ask tab, search wider and the bubble. A fake
// OpenAI-compatible LLM server answers, so CI needs no model and no GPU.
// Retrieval is off, so the lookups of folder and Everything scope find
// nothing, and the list questions (SQL tools) give the answers.
//
// Real mode (OPENSTYLE_E2E_ASK_REAL=1): the local MLX model and the embedding
// model answer, so a lookup finds text, a cite chip opens the transcript at
// the cited time, and a question that is not found at a meeting is found after
// the clicks of "search wider". It needs the GPU lock (see the live-testing
// skill).
//
// The bubble opens through the E2E seam `e2e:trigger-chat-hotkey`, which runs
// the same code as the native key listener. A real key press needs the Input
// Monitoring permission, which an isolated test must not ask for. The seam
// does not cover the native listener itself: the guard logic is covered by
// src/main/hotkeys/chat-guard.test.ts (both paths), and this spec drives the
// "K inside the window" path in the real app.
//
// All data is fictional. Set OPENSTYLE_EVIDENCE_DIR for the light and dark
// screenshots.
// ---------------------------------------------------------------------------

const REAL = process.env.OPENSTYLE_E2E_ASK_REAL === "1";
const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;
// Names the files of the screenshots of the real run apart from the fake run.
const SUFFIX = REAL ? "-real" : "";
const WEEKLY = MEETINGS[0];
if (!WEEKLY) throw new Error("The fixture has no meeting.");

const Q_LIST = "Which action items are open?";
const Q_DECISION = "What did we decide about the beta launch date?";
const Q_FERRY = FERRY_QUESTION;

/** A chat answer element, then wait for it. */
async function ask(page: Page, question: string): Promise<Locator> {
  const answers = page.getByTestId("meeting-ask-assistant");
  const before = await answers.count();
  await page.getByTestId("meeting-ask-input").fill(question);
  await page.getByTestId("meeting-ask-send").click();
  await expect(answers).toHaveCount(before + 1, { timeout: 30_000 });
  return answers.nth(before);
}

async function setTheme(page: Page, name: "Light" | "Dark"): Promise<void> {
  await page.goto("app://renderer/settings#display");
  await page.getByRole("radio", { name, exact: true }).click();
  if (name === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

/**
 * Opens the Meetings page and selects a folder in the rail. The page opens the
 * newest meeting first, so the test waits for it before it clicks the folder.
 */
async function openFolderPanel(page: Page, folderName: string): Promise<void> {
  await page.goto("app://renderer/meetings");
  await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible({
    timeout: 20_000,
  });
  // The folder row has a toggle ("Collapse <name>") and a select button
  // (<name>). The label "Records into <name>" is not a button.
  await page
    .getByTestId("meetings-list-column")
    .getByRole("button", { name: folderName, exact: true })
    .click();
  await expect(page.getByTestId("folder-tab-overview")).toBeVisible({
    timeout: 20_000,
  });
}

interface HotkeyState {
  registered: string | null;
  dictating: boolean;
  waiting: boolean;
  armed: boolean;
}

function hotkeyState(page: Page): Promise<HotkeyState> {
  return page.evaluate(
    () =>
      window.electron.ipcRenderer.invoke(
        "e2e:chat-hotkey-state",
      ) as Promise<HotkeyState>,
  );
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

/** A screenshot of one element: the folder header is taller than the window. */
async function shootElement(target: Locator, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await target.page().waitForTimeout(600);
  await target.screenshot({ path: join(EVIDENCE_DIR, name) });
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  // Let the tab underline and the theme transitions end.
  await page.waitForTimeout(600);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE_DIR, name) });
}

function defineFake(): void {
  test.describe.configure({ mode: "serial" });

  let b: Booted;
  let fake: FakeAskLlm;
  let page: Page;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    fake = new FakeAskLlm();
    fake.requireOverlap = true;
    await fake.start();
    b = await boot("openstyle-e2e-ask-p2-", {});
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
    seedAskMeetings(b.userDataDir, { extra: true });
  });

  test.afterAll(async () => {
    if (b?.app) await closeApp(b.app);
    if (b) rmSync(b.userDataDir, { recursive: true, force: true });
    await fake?.stop();
  });

  test("setting off: no Ask page in the sidebar, no hotkey, a notice on the page", async () => {
    test.setTimeout(60_000);
    expect(await settingValue(b, "meeting_chat_enabled")).not.toBe("true");
    await page.goto("app://renderer/meetings");
    await expect(page.getByRole("link", { name: "Meetings" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("link", { name: /^Ask\b/ })).toHaveCount(0);
    // The hotkey is not registered while the switch is off.
    expect((await hotkeyState(page)).registered).toBeNull();
    // A direct visit shows the notice and no conversation.
    await page.goto("app://renderer/ask");
    await expect(page.getByTestId("ask-page-off")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("meeting-ask")).toHaveCount(0);
    // The turn route refuses with 409 off. Use a meeting that no later test
    // uses, so its empty thread disturbs no thread list.
    const created = await b.api("POST", "/chat/threads", {
      scope: { kind: "meeting", id: "ask-m-roadmap" },
    });
    expect(created.status).toBe(200);
    const { thread } = (await created.json()) as { thread: { id: string } };
    const turn = await b.api("POST", `/chat/threads/${thread.id}/messages`, {
      question: Q_LIST,
    });
    expect(turn.status).toBe(409);
    expect(fake.requests).toHaveLength(0);
  });

  test("the Settings switch adds the Ask page next to Meetings and registers the hotkey", async () => {
    test.setTimeout(60_000);
    await page.goto("app://renderer/settings#meetings");
    const sw = page.getByTestId("settings-meeting-chat");
    await expect(sw).toBeVisible({ timeout: 15_000 });
    await sw.click();
    await expect
      .poll(() => settingValue(b, "meeting_chat_enabled"))
      .toBe("true");
    const nav = page.getByRole("navigation").getByRole("link");
    await expect(page.getByRole("link", { name: /^Ask\b/ })).toBeVisible();
    // Ask is the sidebar item right after Meetings.
    const names = (await nav.allInnerTexts()).map((t) =>
      t.replace(/\s+/g, " ").trim(),
    );
    const meetings = names.findIndex((t) => t.startsWith("Meetings"));
    expect(names[meetings + 1]).toMatch(/^Ask/);
    // Main registered the default hotkey. The native listener may not start in
    // every environment, so the test reads the registered accelerator.
    await expect
      .poll(async () => (await hotkeyState(page)).registered, {
        timeout: 15_000,
      })
      .toBe("Control+Alt+K");
  });

  test("Settings, Ask: the shortcut row shows the default, and a change registers again", async () => {
    test.setTimeout(60_000);
    await page.goto("app://renderer/settings#ask");
    await expect(page.getByTestId("settings-ask")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Global shortcut")).toBeVisible();
    // A new accelerator through the server, then the same refresh the page sends.
    await put(b, "chat_hotkey", "Control+Alt+J");
    await page.evaluate(() => window.api.refreshChatHotkey());
    await expect
      .poll(async () => (await hotkeyState(page)).registered)
      .toBe("Control+Alt+J");
    // A chord with no key is refused: nothing is registered.
    await put(b, "chat_hotkey", "Control+Alt");
    await page.evaluate(() => window.api.refreshChatHotkey());
    await expect
      .poll(async () => (await hotkeyState(page)).registered)
      .toBeNull();
    // Empty means the default again.
    await put(b, "chat_hotkey", "");
    await page.evaluate(() => window.api.refreshChatHotkey());
    await expect
      .poll(async () => (await hotkeyState(page)).registered)
      .toBe("Control+Alt+K");
  });

  test("Ask page, Everything: a list question gives a cited list and a thread", async () => {
    test.setTimeout(90_000);
    await page.goto("app://renderer/ask");
    await expect(page.getByTestId("ask-page")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("meeting-ask")).toHaveAttribute(
      "data-scope",
      "all",
    );
    await expect(page.getByTestId("meeting-ask-scope")).toHaveText(
      "All meetings",
    );
    await expect(page.getByTestId("ask-thread-item")).toHaveCount(0);
    const answer = await ask(page, Q_LIST);
    const list = answer.getByTestId("meeting-ask-block-list");
    await expect(list).toBeVisible();
    // Open items of the three Orchid meetings, the Harbor folder and the unfiled one.
    expect(
      await answer.getByTestId("meeting-ask-list-item").count(),
    ).toBeGreaterThanOrEqual(5);
    expect(
      await answer.getByTestId("meeting-ask-cite").count(),
    ).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("ask-thread-item")).toHaveCount(1);
    await expect(page.getByTestId("ask-thread-item").first()).toContainText(
      Q_LIST,
    );
    // The trail says how the answer was found.
    await answer.getByTestId("meeting-ask-trail").locator("summary").click();
    await expect(answer.getByTestId("meeting-ask-trail")).toContainText(
      /listed/,
    );
  });

  test("Ask page: a cite chip opens the cited meeting", async () => {
    test.setTimeout(60_000);
    const chip = page.getByTestId("meeting-ask-cite").first();
    const label = (await chip.getAttribute("aria-label")) ?? "";
    expect(label).toMatch(/^Open meeting /);
    await chip.click();
    await expect(page).toHaveURL(/meetings/, { timeout: 15_000 });
    // The Meetings page opened a meeting: its tabs are there.
    await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("the Meetings page opens a meeting at a time from a link (cite jump to the transcript)", async () => {
    test.setTimeout(60_000);
    // 12 s per line in the fixture: line 5 starts at 60 s.
    await page.goto(`app://renderer/meetings?meeting=${WEEKLY.id}&at=60000`);
    await expect(page.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 20_000 },
    );
    const hit = page.locator(
      '[data-testid="meetings-segment"][data-search-hit="true"]',
    );
    await expect(hit).toHaveCount(1, { timeout: 15_000 });
  });

  test("Ask page, Folder: threads of the scope only, a new thread appears in its list", async () => {
    test.setTimeout(90_000);
    await page.goto("app://renderer/ask");
    await expect(page.getByTestId("ask-page")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("radio", { name: "A folder" }).click();
    await expect(page.getByTestId("ask-pick-hint")).toBeVisible();
    await page.getByTestId("ask-pick-folder").click();
    await page.getByRole("option", { name: FOLDER_NAME }).click();
    await expect(page.getByTestId("meeting-ask")).toHaveAttribute(
      "data-scope",
      `folder:${FOLDER_ID}`,
    );
    // The thread of the Everything scope is not in this list.
    await expect(page.getByTestId("ask-thread-item")).toHaveCount(0);
    const answer = await ask(page, Q_LIST);
    await expect(answer.getByTestId("meeting-ask-block-list")).toBeVisible();
    // Only the open items of the Orchid folder.
    await expect(answer).toContainText("vendor contract draft");
    await expect(answer).not.toContainText("badge printer");
    await expect(page.getByTestId("ask-thread-item")).toHaveCount(1);
  });

  test("Ask page, Meeting: a fact question gives a text answer; new chat makes a second thread, newest first", async () => {
    test.setTimeout(90_000);
    await page.getByRole("radio", { name: "A meeting" }).click();
    await page.getByTestId("ask-pick-meeting").click();
    await page.getByRole("option", { name: WEEKLY.title }).click();
    await expect(page.getByTestId("meeting-ask")).toHaveAttribute(
      "data-scope",
      `meeting:${WEEKLY.id}`,
    );
    const first = await ask(page, Q_DECISION);
    await expect(first.getByTestId("meeting-ask-block-text")).toContainText(
      "Friday 14 November",
    );
    await page.getByTestId("meeting-ask-new").click();
    await expect(page.getByTestId("meeting-ask-assistant")).toHaveCount(0);
    await ask(page, Q_LIST);
    const items = page.getByTestId("ask-thread-item");
    await expect(items).toHaveCount(2);
    // Newest first: the list question is on top.
    await expect(items.nth(0)).toContainText(Q_LIST);
    await expect(items.nth(1)).toContainText(Q_DECISION);
    // The first thread opens again with its answer.
    await items.nth(1).click();
    await expect(page.getByTestId("meeting-ask-assistant")).toHaveCount(1);
    await expect(page.getByTestId("meeting-ask-block-text")).toContainText(
      "Friday 14 November",
    );
  });

  test("not found, then search wider: one step per confirm, never alone", async () => {
    test.setTimeout(120_000);
    await page.goto("app://renderer/ask");
    await page.getByRole("radio", { name: "A meeting" }).click();
    await page.getByTestId("ask-pick-meeting").click();
    await page.getByRole("option", { name: WEEKLY.title }).click();
    await page.getByTestId("meeting-ask-new").click();
    const callsBefore = fake.requests.length;
    const nf = await ask(page, Q_FERRY);
    await expect(nf.getByTestId("meeting-ask-block-not-found")).toBeVisible();
    // The offer names the folder of the meeting.
    const widen = nf.getByTestId("meeting-ask-widen");
    await expect(widen).toHaveAttribute("data-wider", "folder");
    await expect(widen).toContainText(FOLDER_NAME);
    // Nothing widened alone: one thread, one question, one answer so far.
    const threadId = (
      (await (
        await b.api("GET", `/chat/threads?meeting_id=${WEEKLY.id}`)
      ).json()) as {
        threads: { id: string }[];
      }
    ).threads[0]?.id as string;
    const afterFirst = (await (
      await b.api("GET", `/chat/threads/${threadId}`)
    ).json()) as {
      messages: { role: string }[];
    };
    expect(afterFirst.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    await shoot(page, "ask-page-not-found.png");

    // Click 1: the folder. The same question runs again. No second user bubble.
    await widen.click();
    const nf2 = page.getByTestId("meeting-ask-assistant").nth(1);
    await expect(nf2).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("meeting-ask-user")).toHaveCount(1);
    await expect(nf2.getByTestId("meeting-ask-block-not-found")).toBeVisible();
    await expect(nf2.getByTestId("meeting-ask-scope-note")).toContainText(
      FOLDER_NAME,
    );
    // The old answer has no button any more: only the last answer can widen.
    await expect(page.getByTestId("meeting-ask-widen")).toHaveCount(1);
    const widen2 = nf2.getByTestId("meeting-ask-widen");
    await expect(widen2).toHaveAttribute("data-wider", "all");

    // Click 2: everything. There is no wider scope after it.
    await widen2.click();
    const nf3 = page.getByTestId("meeting-ask-assistant").nth(2);
    await expect(nf3).toBeVisible({ timeout: 30_000 });
    await expect(nf3.getByTestId("meeting-ask-scope-note")).toContainText(
      "everything",
    );
    await expect(page.getByTestId("meeting-ask-widen")).toHaveCount(0);
    const done = (await (
      await b.api("GET", `/chat/threads/${threadId}`)
    ).json()) as {
      messages: { role: string; trace: { scope?: { kind: string } } | null }[];
    };
    expect(done.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
    ]);
    expect(done.messages.map((m) => m.trace?.scope?.kind)).toEqual([
      undefined,
      "meeting",
      "folder",
      "all",
    ]);
    // The widen turns made model calls (a new turn each), not before the click.
    expect(fake.requests.length).toBeGreaterThan(callsBefore);
    // The server refuses a widen with no offer.
    const refused = await b.api("POST", `/chat/threads/${threadId}/messages`, {
      widen: true,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: "widen_not_offered" });
  });

  test("the folder Ask tab: a tab in the folder panel, scope F, answers a list question", async () => {
    test.setTimeout(90_000);
    await openFolderPanel(page, FOLDER_NAME);
    const tab = page.getByTestId("folder-tab-ask");
    await expect(tab).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("folder-tab-overview")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("folder-tab-overview")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(page.getByTestId("meeting-ask")).toHaveAttribute(
      "data-scope",
      `folder:${FOLDER_ID}`,
    );
    await expect(page.getByTestId("meeting-ask-scope")).toContainText(
      FOLDER_NAME,
    );
    // The folder thread of the Ask page shows here: one list per scope.
    await page.getByTestId("meeting-ask-threads").click();
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Escape");
    const answer = await ask(page, "Show all decisions");
    await expect(
      answer.locator('[data-testid^="meeting-ask-block-"]').first(),
    ).toBeVisible();
    await shoot(page, "folder-tab.png");
  });

  test("the bubble: the Meetings selection sets the scope; widen; open in Ask; Escape", async () => {
    test.setTimeout(120_000);
    // Select a meeting of the Harbor folder on the Meetings page.
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
    // The hotkey (the seam runs the same code as the native listener).
    await page.evaluate(() =>
      window.electron.ipcRenderer.send("e2e:trigger-chat-hotkey"),
    );
    const bubble = await bubblePage(b);
    await expect(bubble.getByTestId("chat-bubble")).toBeVisible({
      timeout: 20_000,
    });
    await expect(bubble.getByTestId("chat-bubble")).toHaveAttribute(
      "data-scope",
      "meeting:ask-m-pricing",
    );
    await expect(bubble.getByTestId("chat-bubble-scope")).toContainText(
      "Pricing review",
    );
    // One action widens the scope: the folder of the meeting.
    const widen = bubble.getByTestId("chat-bubble-widen");
    await expect(widen).toContainText(HARBOR_FOLDER_NAME);
    await widen.click();
    await expect(bubble.getByTestId("chat-bubble")).toHaveAttribute(
      "data-scope",
      /^folder:/,
    );
    await expect(bubble.getByTestId("chat-bubble-scope")).toContainText(
      HARBOR_FOLDER_NAME,
    );
    await expect(bubble.getByTestId("chat-bubble-widen")).toContainText(
      "everything",
    );
    // Ask a list question at the folder scope. The answer has cite chips.
    await bubble.getByTestId("chat-bubble-input").fill(Q_LIST);
    await bubble.getByTestId("chat-bubble-send").click();
    const answer = bubble.getByTestId("chat-bubble-answer");
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(answer).toContainText("ferry");
    expect(
      await answer.getByTestId("meeting-ask-cite").count(),
    ).toBeGreaterThanOrEqual(1);
    await shoot(bubble, "bubble.png");

    // Open in Ask: the main window shows the Ask page with this thread.
    await bubble.getByTestId("chat-bubble-open-in-ask").click();
    await expect(page.getByTestId("ask-page")).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/ask/);
    await expect(page.getByTestId("meeting-ask")).toHaveAttribute(
      "data-scope",
      /^folder:/,
    );
    await expect(page.getByTestId("meeting-ask-user")).toContainText(Q_LIST);
    expect(
      await page.getByTestId("ask-thread-item").count(),
    ).toBeGreaterThanOrEqual(1);
    // The bubble closed.
    expect(
      await page.evaluate(() =>
        window.electron.ipcRenderer.invoke("e2e:chat-bubble-visible"),
      ),
    ).toBe(false);
  });

  test("the bubble with nothing selected asks everything, and Escape closes it", async () => {
    test.setTimeout(90_000);
    await page.goto("app://renderer/meetings");
    await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible({
      timeout: 20_000,
    });
    // Back to the empty selection (the Meetings page lists; nothing is chosen).
    await page.evaluate(() => window.api.setChatSelection(null));
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.electron.ipcRenderer.invoke("e2e:chat-selection"),
        ),
      )
      .toBeNull();
    await page.evaluate(() =>
      window.electron.ipcRenderer.send("e2e:trigger-chat-hotkey"),
    );
    const bubble = await bubblePage(b);
    await expect(bubble.getByTestId("chat-bubble")).toHaveAttribute(
      "data-scope",
      "all",
    );
    await expect(bubble.getByTestId("chat-bubble-scope")).toContainText(
      "all meetings",
    );
    // Scope A has nothing wider.
    await expect(bubble.getByTestId("chat-bubble-widen")).toHaveCount(0);
    await expect(bubble.getByTestId("chat-bubble-input")).toBeFocused();
    await bubble.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.electron.ipcRenderer.invoke("e2e:chat-bubble-visible"),
        ),
      )
      .toBe(false);
  });

  test("the hotkey guard in the app: the chat key inside the window cancels the dictation start", async () => {
    test.setTimeout(60_000);
    const state = await hotkeyState(page);
    // The guard waits only when the native chat listener started. Without the
    // Input Monitoring permission it did not, and the test says so.
    test.skip(!state.armed, "The native chat key listener did not start here.");
    const result = await page.evaluate(async () => {
      const ipc = window.electron.ipcRenderer;
      // One evaluate: both messages go out within a few ms, inside the 150 ms window.
      ipc.send("e2e:trigger-hotkey-down");
      const waiting = (await ipc.invoke("e2e:chat-hotkey-state")) as {
        waiting: boolean;
        dictating: boolean;
      };
      ipc.send("e2e:trigger-chat-hotkey");
      await new Promise((r) => setTimeout(r, 400));
      const after = (await ipc.invoke("e2e:chat-hotkey-state")) as {
        waiting: boolean;
        dictating: boolean;
      };
      const visible = (await ipc.invoke("e2e:chat-bubble-visible")) as boolean;
      ipc.send("e2e:trigger-hotkey-up");
      return { waiting, after, visible };
    });
    expect(result.waiting.waiting).toBe(true);
    expect(result.waiting.dictating).toBe(false);
    expect(result.after.waiting).toBe(false);
    expect(result.after.dictating).toBe(false);
    expect(result.visible).toBe(true);
    await page.evaluate(() =>
      window.electron.ipcRenderer.send("chat-bubble:hide"),
    );
  });

  test("screenshots in light and dark: Ask page, folder tab, bubble", async () => {
    test.skip(!EVIDENCE_DIR, "Set OPENSTYLE_EVIDENCE_DIR for the screenshots.");
    test.setTimeout(180_000);
    // A taller viewport: the folder header is tall, and the tab must show whole.
    await page.setViewportSize({ width: 1280, height: 1100 });
    for (const theme of ["Light", "Dark"] as const) {
      const suffix = theme.toLowerCase();
      await setTheme(page, theme);
      // Settings, Ask: the shortcut row.
      await page.goto("app://renderer/settings#ask");
      await expect(page.getByTestId("settings-ask")).toBeVisible({
        timeout: 15_000,
      });
      await shoot(page, `settings-ask-${suffix}.png`);
      // The Ask page: Everything scope with the list answer visible.
      await page.goto("app://renderer/ask");
      await expect(page.getByTestId("ask-page")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole("radio", { name: "Everything" }).click();
      await page.getByTestId("ask-thread-item").first().click();
      await expect(
        page.getByTestId("meeting-ask-assistant").first(),
      ).toBeVisible({ timeout: 20_000 });
      await shoot(page, `ask-page-${suffix}.png`);
      // The folder tab.
      await openFolderPanel(page, FOLDER_NAME);
      await page.getByTestId("folder-tab-ask").click();
      await expect(
        page.getByTestId("meeting-ask-assistant").first(),
      ).toBeVisible({ timeout: 20_000 });
      await shoot(page, `folder-tab-${suffix}.png`);
      await shootElement(
        page.locator('[data-slot="tabs"]').last(),
        `folder-tab-panel-${suffix}.png`,
      );
      // The bubble, with a long answer in it.
      await page.goto("app://renderer/meetings?meeting=ask-m-pricing");
      await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible({
        timeout: 20_000,
      });
      await page.evaluate(() =>
        window.electron.ipcRenderer.send("e2e:trigger-chat-hotkey"),
      );
      const bubble = await bubblePage(b);
      await expect(bubble.getByTestId("chat-bubble")).toBeVisible();
      await bubble
        .getByTestId("chat-bubble-input")
        .fill("Which action items are open?");
      await bubble.getByTestId("chat-bubble-send").click();
      await expect(bubble.getByTestId("chat-bubble-answer")).toBeVisible({
        timeout: 30_000,
      });
      await shoot(bubble, `bubble-${suffix}.png`);
      await bubble.keyboard.press("Escape");
    }
  });
}

function defineReal(): void {
  test.describe.configure({ mode: "serial" });

  let b: Booted;
  let page: Page;
  const MEETING_COUNT = MEETINGS.length + 3;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const worker =
      process.env.OPENSTYLE_MLX_LLM_WORKER ?? "/tmp/chatp1/run-worker.sh";
    b = await boot("openstyle-e2e-ask-p2-real-", {
      OPENSTYLE_MLX_LLM_WORKER: worker,
      OPENSTYLE_MLX_EMBED_WORKER:
        process.env.OPENSTYLE_MLX_EMBED_WORKER ?? worker,
      OPENSTYLE_MLX_RERANK_WORKER:
        process.env.OPENSTYLE_MLX_RERANK_WORKER ?? worker,
      OPENSTYLE_MLX_LLM_NATIVE_TOOLS: "1",
      HUGGINGFACE_HUB_CACHE: hfCacheDir(),
      HF_HUB_OFFLINE: "1",
    });
    page = b.page;
    const model = await b.api("POST", "/models/configured", {
      provider: "local-mlx-llm",
      model_id: "local-mlx-llm/gemma-4-e2b-qat-4bit",
      model_name: "gemma-4-e2b-qat-4bit",
      type: "llm",
      is_default: true,
    });
    expect(model.ok, "POST /api/models/configured (local)").toBe(true);
    await put(b, "mlx_llm_keep_alive_minutes", "-1");
    await put(b, "meeting_enhance_prompt_seen", "true");
    await put(b, "meeting_chat_enabled", "true");
    seedAskMeetings(b.userDataDir, { extra: true });
    await put(b, "search_embedding_model", "embeddinggemma-2-bf16-text");
  });

  test.afterAll(async () => {
    if (b?.app) await closeApp(b.app);
    if (b) rmSync(b.userDataDir, { recursive: true, force: true });
  });

  test("real mode: the search index holds all meetings", async () => {
    test.setTimeout(600_000);
    await expect
      .poll(
        async () => {
          const st = (await (await b.api("GET", "/search/status")).json()) as {
            state: string;
            meetings: { eligible: number; indexed: number };
          };
          return st.state === "on" && st.meetings.indexed === MEETING_COUNT;
        },
        { timeout: 540_000, intervals: [5_000] },
      )
      .toBe(true);
  });

  test("Ask page, Everything: a lookup finds the text, and the chip jumps to the transcript", async () => {
    test.setTimeout(300_000);
    await page.goto("app://renderer/ask");
    await expect(page.getByTestId("ask-page")).toBeVisible({ timeout: 20_000 });
    const answer = await ask(
      page,
      "How much is the ferry quote for the harbor crane?",
    );
    const text = answer.getByTestId("meeting-ask-block-text");
    await expect(text).toBeVisible();
    console.log(`EVERYTHING answer: ${(await text.innerText()).trim()}`);
    await expect(text).toContainText("48");
    const chip = answer.getByTestId("meeting-ask-cite").first();
    const label = (await chip.getAttribute("aria-label")) ?? "";
    console.log(`EVERYTHING chip: ${label}`);
    expect(label).toMatch(/Quote check/);
    await shoot(page, `ask-page-answer${SUFFIX}.png`);
    await chip.click();
    await expect(page.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 20_000 },
    );
    const hit = page.locator(
      '[data-testid="meetings-segment"][data-search-hit="true"]',
    );
    await expect(hit).toHaveCount(1, { timeout: 15_000 });
    await expect(hit).toContainText("48");
  });

  test("not found at the meeting, then wider: found at the scope that holds it", async () => {
    test.setTimeout(480_000);
    await page.goto("app://renderer/ask");
    await page.getByRole("radio", { name: "A meeting" }).click();
    await page.getByTestId("ask-pick-meeting").click();
    await page.getByRole("option", { name: WEEKLY.title }).click();
    // The meeting has no chat yet: the panel starts an empty one.
    const first = await ask(
      page,
      "What is the ferry quote for the harbor crane?",
    );
    console.log(
      `WIDEN first: ${(await first.innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
    );
    await expect(
      first.getByTestId("meeting-ask-block-not-found"),
    ).toBeVisible();
    let clicks = 0;
    const answers = page.getByTestId("meeting-ask-assistant");
    while (clicks < 2) {
      const last = answers.last();
      const widen = last.getByTestId("meeting-ask-widen");
      if ((await widen.count()) === 0) break;
      console.log(
        `WIDEN click ${clicks + 1}: ${(await widen.innerText()).trim()}`,
      );
      const before = await answers.count();
      await widen.click();
      await expect(answers).toHaveCount(before + 1, { timeout: 240_000 });
      clicks++;
      if (
        (await answers
          .last()
          .getByTestId("meeting-ask-block-not-found")
          .count()) === 0
      )
        break;
    }
    const final = answers.last();
    console.log(
      `WIDEN final after ${clicks} clicks: ${(await final.innerText()).replace(/\s+/g, " ").slice(0, 240)}`,
    );
    await expect(final.getByTestId("meeting-ask-block-text")).toContainText(
      "48",
    );
    await expect(final.getByTestId("meeting-ask-scope-note")).toBeVisible();
    expect(clicks).toBeGreaterThanOrEqual(1);
    await shoot(page, `ask-page-widened${SUFFIX}.png`);
  });

  test("the folder Ask tab answers from its meetings", async () => {
    test.setTimeout(300_000);
    await openFolderPanel(page, HARBOR_FOLDER_NAME);
    await page.getByTestId("folder-tab-ask").click();
    await expect(page.getByTestId("meeting-ask")).toHaveAttribute(
      "data-scope",
      `folder:${HARBOR_FOLDER_ID}`,
    );
    const answer = await ask(page, "What did we decide about the ferry order?");
    const text = (await answer.innerText()).replace(/\s+/g, " ");
    console.log(`FOLDER answer: ${text.slice(0, 240)}`);
    expect(
      await answer.getByTestId("meeting-ask-cite").count(),
    ).toBeGreaterThanOrEqual(1);
    await shoot(page, `folder-tab-answer${SUFFIX}.png`);
  });

  test("the bubble answers, and its chip opens the transcript in the main window", async () => {
    test.setTimeout(300_000);
    await page.goto("app://renderer/meetings?meeting=ask-m-quote");
    await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible({
      timeout: 20_000,
    });
    await page.evaluate(() =>
      window.electron.ipcRenderer.send("e2e:trigger-chat-hotkey"),
    );
    const bubble = await bubblePage(b);
    await expect(bubble.getByTestId("chat-bubble")).toHaveAttribute(
      "data-scope",
      "meeting:ask-m-quote",
      { timeout: 20_000 },
    );
    await bubble
      .getByTestId("chat-bubble-input")
      .fill("How much is the ferry quote for the harbor crane?");
    await bubble.getByTestId("chat-bubble-send").click();
    const answer = bubble.getByTestId("chat-bubble-answer");
    await expect(answer).toBeVisible({ timeout: 240_000 });
    await expect(answer).toContainText("48");
    await shoot(bubble, `bubble-answer${SUFFIX}.png`);
    const chip = answer.getByTestId("meeting-ask-cite").first();
    await chip.click();
    await expect(page.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 20_000 },
    );
    await expect(
      page.locator('[data-testid="meetings-segment"][data-search-hit="true"]'),
    ).toHaveCount(1, { timeout: 15_000 });
  });

  test("screenshots in light and dark with real answers", async () => {
    test.skip(!EVIDENCE_DIR, "Set OPENSTYLE_EVIDENCE_DIR for the screenshots.");
    test.setTimeout(600_000);
    // A taller viewport: the folder header is tall, and the tab must show whole.
    await page.setViewportSize({ width: 1280, height: 1100 });
    for (const theme of ["Light", "Dark"] as const) {
      const suffix = theme.toLowerCase();
      await setTheme(page, theme);
      await page.goto("app://renderer/ask");
      await expect(page.getByTestId("ask-page")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole("radio", { name: "Everything" }).click();
      await page.getByTestId("ask-thread-item").first().click();
      await expect(
        page.getByTestId("meeting-ask-assistant").first(),
      ).toBeVisible({ timeout: 20_000 });
      await shoot(page, `ask-page-${suffix}${SUFFIX}.png`);
      await openFolderPanel(page, HARBOR_FOLDER_NAME);
      await page.getByTestId("folder-tab-ask").click();
      await expect(
        page.getByTestId("meeting-ask-assistant").first(),
      ).toBeVisible({ timeout: 20_000 });
      await shoot(page, `folder-tab-${suffix}${SUFFIX}.png`);
      await shootElement(
        page.locator('[data-slot="tabs"]').last(),
        `folder-tab-panel-${suffix}${SUFFIX}.png`,
      );
      await page.goto("app://renderer/meetings?meeting=ask-m-quote");
      await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible({
        timeout: 20_000,
      });
      await page.evaluate(() =>
        window.electron.ipcRenderer.send("e2e:trigger-chat-hotkey"),
      );
      const bubble = await bubblePage(b);
      await expect(bubble.getByTestId("chat-bubble")).toBeVisible();
      await bubble
        .getByTestId("chat-bubble-input")
        .fill("What did we decide about the ferry order?");
      await bubble.getByTestId("chat-bubble-send").click();
      await expect(bubble.getByTestId("chat-bubble-answer")).toBeVisible({
        timeout: 240_000,
      });
      await shoot(bubble, `bubble-${suffix}${SUFFIX}.png`);
      await bubble.keyboard.press("Escape");
    }
  });
}

if (REAL) defineReal();
else defineFake();
