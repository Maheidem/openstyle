import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  ACTION_TASK,
  DECISION_TEXT,
  FakeAskLlm,
  MEETINGS,
  NOT_FOUND_MARK,
  readActionItems,
  seedAskMeetings,
} from "./helpers/ask-fixture";
import {
  closeApp,
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// The Ask tab of a meeting (specs/meeting-chat-agent.md, P1). One scenario,
// two modes with the same steps:
//
// 1. Default (CI): a fake OpenAI-compatible LLM server, no model, no GPU, no
//    embedding model. Retrieval is off, so the pipeline answers from the
//    summary (the search tool is degraded and the pipeline reads the summary).
//    The cites are summary cites, so a chip opens the Summary tab.
// 2. Real (OPENSTYLE_E2E_ASK_REAL=1): the local MLX model and the embedding
//    model. The answers are model text. The steps assert only structure.
//    Needs the GPU lock. See .claude/skills/live-testing/SKILL.md.
//
// All data is fictional. Set OPENSTYLE_EVIDENCE_DIR for the light and dark
// screenshots (ask-light.png, ask-dark.png).
// ---------------------------------------------------------------------------

const REAL = process.env.OPENSTYLE_E2E_ASK_REAL === "1";
const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;

const SUBJECT = MEETINGS[0];
if (!SUBJECT) throw new Error("The fixture has no meeting.");
const SUBJECT_URL = `app://renderer/meetings?meeting=${SUBJECT.id}`;

const Q_FACT = "What did we decide about the beta launch date?";
const Q_NOT_FOUND = `What is the budget for the ${NOT_FOUND_MARK}?`;
const Q_FOLLOW_UP = "And who owns the vendor contract draft task?";
const Q_WRITE = "Mark the first task as done";

const LONG = REAL ? 240_000 : 30_000;

interface Booted {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  base: string;
  api(method: string, path: string, body?: unknown): Promise<Response>;
}

/** The folder with the models--* folders of the scratch HF cache. */
function hfCacheDir(): string {
  const root = process.env.OPENSTYLE_E2E_ASK_HF ?? "/tmp/chatp1/hf";
  return existsSync(join(root, "hub")) ? join(root, "hub") : root;
}

async function boot(
  prefix: string,
  env: Record<string, string>,
): Promise<Booted> {
  const userDataDir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  const app = await launchOpenstyle({ userDataDir, env });
  const page = await waitForDashboardWindow(app, 15_000);
  try {
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  } catch {
    await page.waitForLoadState("load", { timeout: 10_000 });
  }
  // The boot sweep of orphans runs 3 s after the start (main/index.ts). The
  // seeded meetings are not recording, but wait as the other specs do.
  await new Promise((r) => setTimeout(r, 3500));
  const base = embeddedServerUrl(app);
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, page, userDataDir, base, api };
}

async function put(b: Booted, key: string, value: string): Promise<void> {
  const res = await b.api("PUT", `/settings/${key}`, { value });
  expect(res.status, `PUT /api/settings/${key}`).toBe(200);
}

async function settingValue(
  b: Booted,
  key: string,
): Promise<string | undefined> {
  const all = (await (await b.api("GET", "/settings")).json()) as Record<
    string,
    string
  >;
  return all[key];
}

/** Opens the subject meeting. The list query reads the DB again on a reload. */
async function openSubject(page: Page): Promise<void> {
  await page.goto(SUBJECT_URL);
  await page.reload();
  await page.waitForLoadState("load");
  await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible({
    timeout: 20_000,
  });
}

/** Sends a question in the Ask tab and returns the new assistant message. */
async function ask(page: Page, question: string): Promise<Locator> {
  const answers = page.getByTestId("meeting-ask-assistant");
  const before = await answers.count();
  await page.getByTestId("meeting-ask-input").fill(question);
  await page.getByTestId("meeting-ask-send").click();
  // The live region speaks while the turn runs.
  await expect(answers).toHaveCount(before + 1, { timeout: LONG });
  return answers.nth(before);
}

async function setTheme(page: Page, name: "Light" | "Dark"): Promise<void> {
  await page.goto("app://renderer/settings#display");
  await page.getByRole("radio", { name, exact: true }).click();
  if (name === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

interface StoredMessage {
  role: string;
  blocks: { kind: string; text?: string }[] | null;
  trace: {
    router: string;
    intent: string | null;
    steps: { stage: string; name: string }[];
  } | null;
}

async function threadMessages(
  b: Booted,
  meetingId: string,
): Promise<StoredMessage[]> {
  const list = (await (
    await b.api("GET", `/chat/threads?meeting_id=${meetingId}`)
  ).json()) as { threads: { id: string }[] };
  const id = list.threads[0]?.id;
  expect(id, "the meeting has a chat thread").toBeTruthy();
  const detail = (await (await b.api("GET", `/chat/threads/${id}`)).json()) as {
    messages: StoredMessage[];
  };
  return detail.messages;
}

/** Waits until the server runs a turn for the meeting. Returns the thread id. */
async function waitForRunningTurn(
  b: Booted,
  meetingId: string,
): Promise<string> {
  let id = "";
  await expect
    .poll(
      async () => {
        const list = (await (
          await b.api("GET", `/chat/threads?meeting_id=${meetingId}`)
        ).json()) as { threads: { id: string }[] };
        for (const t of list.threads) {
          const d = (await (
            await b.api("GET", `/chat/threads/${t.id}`)
          ).json()) as {
            pending: boolean;
          };
          if (d.pending) {
            id = t.id;
            return true;
          }
        }
        return false;
      },
      { timeout: 10_000, intervals: [100] },
    )
    .toBe(true);
  return id;
}

function defineScenario(): void {
  test.describe.configure({ mode: "serial" });

  let b: Booted;
  let fake: FakeAskLlm | undefined;
  let page: Page;

  test.beforeAll(async () => {
    test.setTimeout(REAL ? 300_000 : 90_000);
    const env: Record<string, string> = {};
    if (REAL) {
      const worker =
        process.env.OPENSTYLE_MLX_LLM_WORKER ?? "/tmp/chatp1/run-worker.sh";
      env.OPENSTYLE_MLX_LLM_WORKER = worker;
      env.OPENSTYLE_MLX_EMBED_WORKER =
        process.env.OPENSTYLE_MLX_EMBED_WORKER ?? worker;
      env.OPENSTYLE_MLX_RERANK_WORKER =
        process.env.OPENSTYLE_MLX_RERANK_WORKER ?? worker;
      env.OPENSTYLE_MLX_LLM_NATIVE_TOOLS = "1";
      env.HUGGINGFACE_HUB_CACHE = hfCacheDir();
      env.HF_HUB_OFFLINE = "1";
    } else {
      fake = new FakeAskLlm();
      await fake.start();
    }
    b = await boot(
      REAL ? "openstyle-e2e-ask-real-" : "openstyle-e2e-ask-",
      env,
    );
    page = b.page;
    if (fake) {
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
    } else {
      const model = await b.api("POST", "/models/configured", {
        provider: "local-mlx-llm",
        model_id: "local-mlx-llm/gemma-4-e2b-qat-4bit",
        model_name: "gemma-4-e2b-qat-4bit",
        type: "llm",
        is_default: true,
      });
      expect(model.ok, "POST /api/models/configured (local)").toBe(true);
      await put(b, "mlx_llm_keep_alive_minutes", "-1");
    }
    await put(b, "meeting_enhance_prompt_seen", "true");
    seedAskMeetings(b.userDataDir);
    if (REAL) {
      // The embedding model last: the index starts and reads the seeded rows.
      await put(b, "search_embedding_model", "embeddinggemma-2-bf16-text");
    }
  });

  test.afterAll(async () => {
    if (b?.app) await closeApp(b.app);
    if (b) rmSync(b.userDataDir, { recursive: true, force: true });
    await fake?.stop();
  });

  test("real mode: the search index holds all meetings", async () => {
    test.skip(!REAL, "Only in real mode.");
    test.setTimeout(600_000);
    await expect
      .poll(
        async () => {
          const s = (await (await b.api("GET", "/search/status")).json()) as {
            state: string;
            reason: string | null;
            meetings: { eligible: number; indexed: number; failed: number };
          };
          console.log(
            `INDEX state=${s.state} reason=${s.reason} indexed=${s.meetings.indexed}/${s.meetings.eligible} failed=${s.meetings.failed}`,
          );
          return (
            s.state === "on" &&
            s.meetings.eligible === MEETINGS.length &&
            s.meetings.indexed === MEETINGS.length
          );
        },
        { timeout: 540_000, intervals: [5_000] },
      )
      .toBe(true);
  });

  test("setting off: no Ask tab, and the route answers 409 off", async () => {
    test.setTimeout(60_000);
    expect(await settingValue(b, "meeting_chat_enabled")).not.toBe("true");
    await openSubject(page);
    await expect(page.getByTestId("meeting-ask-tab")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /Ask/ })).toHaveCount(0);
    // The thread route works. The turn route refuses.
    const created = await b.api("POST", "/chat/threads", {
      scope: { kind: "meeting", id: SUBJECT.id },
    });
    expect(created.status).toBe(200);
    const { thread } = (await created.json()) as { thread: { id: string } };
    const turn = await b.api("POST", `/chat/threads/${thread.id}/messages`, {
      question: Q_FACT,
    });
    expect(turn.status).toBe(409);
    expect(await turn.json()).toMatchObject({ reason: "off" });
    // The refusal saves nothing, and no model call went out.
    if (fake) expect(fake.requests).toHaveLength(0);
  });

  test("Settings switch turns the Ask tab on", async () => {
    test.setTimeout(60_000);
    await page.goto("app://renderer/settings#meetings");
    const sw = page.getByTestId("settings-meeting-chat");
    await expect(sw).toBeVisible({ timeout: 15_000 });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect
      .poll(() => settingValue(b, "meeting_chat_enabled"))
      .toBe("true");
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(page.getByTestId("settings-meeting-chat")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("the Ask tab is a tab, and its status line is a live region", async () => {
    test.setTimeout(60_000);
    await openSubject(page);
    const tab = page.getByRole("tab", { name: /Ask/ });
    await expect(tab).toBeVisible();
    await expect(page.getByTestId("meeting-ask-tab")).toHaveCount(1);
    await expect(tab).toHaveAttribute("aria-selected", "false");
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(page.getByTestId("meeting-ask")).toBeVisible();
    await expect(page.getByTestId("meeting-ask-scope")).toBeVisible();
    // The role "status" region is always in the page.
    const live = page.getByTestId("meeting-ask-status");
    await expect(live).toHaveAttribute("role", "status");
    await expect(live).toHaveAttribute("aria-live", "polite");
    // The empty state offers the example questions.
    await expect(page.getByTestId("meeting-ask-example").first()).toBeVisible();
  });

  test("a fact question gives a text block with a cite chip", async () => {
    test.setTimeout(REAL ? 300_000 : 90_000);
    const answer = await ask(page, Q_FACT);
    // Print the stored turn first: a failure then shows what the model did.
    const stored = await threadMessages(b, SUBJECT.id);
    const turn = stored.at(-1);
    console.log(
      `FACT stored blocks=${JSON.stringify(turn?.blocks)} router=${turn?.trace?.router} steps=${turn?.trace?.steps.map((x) => `${x.stage}:${x.name}`).join(", ")}`,
    );
    // A real model may route a "decide" question to the decisions list, so
    // it can answer with a list block. Both blocks carry cites.
    const block = answer
      .locator(
        '[data-testid="meeting-ask-block-text"], [data-testid="meeting-ask-block-list"]',
      )
      .first();
    await expect(block).toBeVisible();
    const text = (await block.innerText()).trim();
    console.log(`FACT answer: ${text}`);
    expect(text.length).toBeGreaterThan(10);
    if (fake) {
      await expect(answer.getByTestId("meeting-ask-block-text")).toBeVisible();
    }
    const chips = answer.getByTestId("meeting-ask-cite");
    expect(await chips.count()).toBeGreaterThanOrEqual(1);
    const label = await chips.first().getAttribute("aria-label");
    console.log(`FACT first chip: ${label}`);
    expect(label).toMatch(/^Open meeting Weekly sync/);
    await expect(page.getByTestId("meeting-ask-user").first()).toContainText(
      Q_FACT,
    );
    // The trace shows how the turn was routed.
    const messages = await threadMessages(b, SUBJECT.id);
    const trace = messages.at(-1)?.trace;
    console.log(
      `FACT trace router=${trace?.router} intent=${trace?.intent} steps=${trace?.steps.map((s) => `${s.stage}:${s.name}`).join(", ")}`,
    );
    if (fake) {
      expect(text).toContain("Friday 14 November");
      expect(text).toContain(DECISION_TEXT.replace(/\.$/, ""));
      expect(trace?.router).toBe("native");
      expect(fake.ofKind("native").length).toBeGreaterThanOrEqual(1);
      expect(fake.ofKind("native")[0]?.answered).toBe("search_chunks");
      expect(fake.ofKind("chat_answer").length).toBe(1);
    }
  });

  test("a cite chip opens the cited place and marks it", async () => {
    test.setTimeout(60_000);
    const answer = page.getByTestId("meeting-ask-assistant").first();
    await answer.getByTestId("meeting-ask-cite").first().click();
    const summaryTab = page.getByRole("tab", { name: "Summary", exact: true });
    const transcriptTab = page.getByRole("tab", {
      name: "Transcript",
      exact: true,
    });
    // Retrieval off: the cite is a summary cite. With retrieval on, the model
    // may cite a transcript chunk or the summary.
    await expect
      .poll(async () => {
        if ((await summaryTab.getAttribute("aria-selected")) === "true")
          return "summary";
        if ((await transcriptTab.getAttribute("aria-selected")) === "true")
          return "transcript";
        return "ask";
      })
      .not.toBe("ask");
    const where =
      (await summaryTab.getAttribute("aria-selected")) === "true"
        ? "summary"
        : "transcript";
    console.log(`CHIP opened the ${where} tab`);
    if (fake) expect(where).toBe("summary");
    if (where === "summary") {
      await expect(page.getByText(DECISION_TEXT).first()).toBeVisible();
    } else {
      const hit = page.locator(
        '[data-testid="meetings-segment"][data-search-hit="true"]',
      );
      await expect(hit).toHaveCount(1, { timeout: 15_000 });
      console.log(
        `CHIP marked segment: ${(await hit.innerText()).slice(0, 80).replace(/\s+/g, " ")}`,
      );
    }
    // Back to the Ask tab: the chat is still there.
    await page.getByRole("tab", { name: /Ask/ }).click();
    await expect(page.getByTestId("meeting-ask-assistant")).toHaveCount(1);
  });

  test("a question with no answer in the notes gives the not-found block", async () => {
    test.setTimeout(REAL ? 300_000 : 90_000);
    const answer = await ask(page, Q_NOT_FOUND);
    const notFound = answer.getByTestId("meeting-ask-block-not-found");
    if (fake) {
      await expect(notFound).toBeVisible();
    } else if ((await notFound.count()) === 0) {
      // A model may answer with a text that makes no claim about the topic.
      const t = (await answer.innerText()).trim();
      console.log(`NOT-FOUND (real) gave text instead: ${t}`);
      await expect(answer.getByTestId("meeting-ask-block-text")).toBeVisible();
    } else {
      await expect(notFound).toBeVisible();
    }
    const messages = await threadMessages(b, SUBJECT.id);
    console.log(`NOT-FOUND blocks=${JSON.stringify(messages.at(-1)?.blocks)}`);
    if (fake) {
      expect(messages.at(-1)?.blocks?.[0]?.kind).toBe("not_found");
      // The block shows the nearest sources as chips (by design). It has no
      // answer text.
      await expect(answer.getByTestId("meeting-ask-block-text")).toHaveCount(0);
    }
  });

  test("a follow-up is answered, and the model saw the earlier questions", async () => {
    test.setTimeout(REAL ? 300_000 : 90_000);
    const answer = await ask(page, Q_FOLLOW_UP);
    const blockCount = await answer
      .locator('[data-testid^="meeting-ask-block-"]')
      .count();
    expect(blockCount).toBeGreaterThanOrEqual(1);
    const messages = await threadMessages(b, SUBJECT.id);
    console.log(`FOLLOW-UP blocks=${JSON.stringify(messages.at(-1)?.blocks)}`);
    if (fake) {
      await expect(answer.getByTestId("meeting-ask-block-text")).toContainText(
        "Dana Reyes",
      );
      const answers = fake.ofKind("chat_answer");
      const last = answers.at(-1);
      expect(last?.user).toContain("EARLIER QUESTIONS");
      expect(last?.user).toContain(Q_FACT);
      // The first question had no earlier turn.
      expect(answers[0]?.user).not.toContain("EARLIER QUESTIONS");
      // A plain follow-up makes no native turn (P1.1): code makes the search
      // call, and the earlier question is in the search query and in the answer
      // call above.
      const natives = fake.ofKind("native");
      expect(natives.some((n) => n.user.includes(Q_FOLLOW_UP))).toBe(false);
    }
  });

  test("a write question gives the read-only block and changes no data", async () => {
    test.setTimeout(REAL ? 300_000 : 90_000);
    const before = readActionItems(b.userDataDir, SUBJECT.id);
    const answer = await ask(page, Q_WRITE);
    const readOnly = answer.getByTestId("meeting-ask-block-read-only");
    if (fake) {
      await expect(readOnly).toBeVisible();
    } else {
      console.log(
        `WRITE (real) read-only block shown: ${(await readOnly.count()) > 0}`,
      );
      await expect(
        answer.locator('[data-testid^="meeting-ask-block-"]').first(),
      ).toBeVisible();
    }
    const after = readActionItems(b.userDataDir, SUBJECT.id);
    expect(after.summaryJson).toBe(before.summaryJson);
    expect(after.doneKeys).toEqual(before.doneKeys);
    expect(after.doneKeys).toEqual([]);
    // The action item is still open in the summary data.
    expect(after.summaryJson).toContain(ACTION_TASK);
    const messages = await threadMessages(b, SUBJECT.id);
    console.log(
      `WRITE blocks=${JSON.stringify(messages.at(-1)?.blocks)} router=${messages.at(-1)?.trace?.router}`,
    );
    if (fake) expect(messages.at(-1)?.blocks?.[0]?.kind).toBe("read_only");
    // Four questions, four answers in one thread.
    await expect(page.getByTestId("meeting-ask-assistant")).toHaveCount(4);
    await expect(page.getByTestId("meeting-ask-user")).toHaveCount(4);
  });

  test("real mode: a transcript question can cite a transcript segment", async () => {
    test.skip(!REAL, "Only in real mode.");
    test.setTimeout(600_000);
    await page.getByRole("tab", { name: /Ask/ }).click();
    // Questions whose answer is only in the transcript. The model decides
    // whether it searches, so ask up to three and stop at the first answer
    // with a cite that has a time (a transcript cite).
    const candidates = [
      "Which room is free on the launch Friday, and on which floor?",
      "Who said the smoke checks passed on Monday?",
      "What did they say about the finance answer on the extra test devices?",
    ];
    let timed = -1;
    let answer: Locator | undefined;
    for (const q of candidates) {
      answer = await ask(page, q);
      const stored = (await threadMessages(b, SUBJECT.id)).at(-1);
      console.log(
        `TRANSCRIPT-Q "${q}" blocks=${JSON.stringify(stored?.blocks?.map((x) => x.kind))} steps=${stored?.trace?.steps.map((x) => `${x.stage}:${x.name}`).join(", ")}`,
      );
      await expect(
        answer.locator('[data-testid^="meeting-ask-block-"]').first(),
      ).toBeVisible();
      const labels = await answer
        .getByTestId("meeting-ask-cite")
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute("aria-label") ?? ""),
        );
      console.log(`TRANSCRIPT-Q chips=${JSON.stringify(labels)}`);
      timed = labels.findIndex((l) => / at \d\d:\d\d$/.test(l));
      if (timed >= 0) break;
    }
    if (timed < 0 || !answer) {
      console.log("TRANSCRIPT-Q no transcript cite in three questions");
      return;
    }
    await answer.getByTestId("meeting-ask-cite").nth(timed).click();
    await expect(
      page.getByRole("tab", { name: "Transcript", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const hit = page.locator(
      '[data-testid="meetings-segment"][data-search-hit="true"]',
    );
    await expect(hit).toHaveCount(1, { timeout: 15_000 });
    console.log(
      `TRANSCRIPT-Q marked segment: ${(await hit.innerText()).slice(0, 100).replace(/\s+/g, " ")}`,
    );
    await page.getByRole("tab", { name: /Ask/ }).click();
  });

  test("evidence: the Ask tab in light and dark", async () => {
    test.setTimeout(120_000);
    test.skip(!EVIDENCE_DIR, "OPENSTYLE_EVIDENCE_DIR is not set.");
    const dir = EVIDENCE_DIR as string;
    mkdirSync(dir, { recursive: true });
    const suffix = REAL ? "-real" : "";
    for (const theme of ["Light", "Dark"] as const) {
      const name = theme.toLowerCase();
      await setTheme(page, theme);
      await openSubject(page);
      const askTab = page.getByRole("tab", { name: /Ask/ });
      await askTab.click();
      // Real mode may add up to three transcript questions.
      await expect(
        page.getByTestId("meeting-ask-assistant").nth(3),
      ).toBeVisible();
      // The Ask tab is the selected tab (the pill moves with it).
      await expect(askTab).toHaveAttribute("aria-selected", "true");
      await expect(askTab).toHaveAttribute("data-state", "active");
      // A hidden quiet-mode window does not run CSS transitions: the pill of
      // the old tab would stay in the picture. Switch them off for the shot.
      await page.addStyleTag({
        content:
          "*,*::before,*::after{transition:none!important;animation:none!important}",
      });
      const messages = page.getByTestId("meeting-ask-messages");

      // 1. The first answer: text with a cite chip.
      await messages.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({ path: join(dir, `ask-${name}${suffix}.png`) });

      // 2. The write question: the read-only reply is visible.
      const readOnly = page.getByTestId("meeting-ask-block-read-only").first();
      // Scroll the message list only, not the whole page.
      await readOnly.evaluate((el) => {
        const box = el.closest('[data-testid="meeting-ask-messages"]');
        if (box)
          box.scrollTop +=
            el.getBoundingClientRect().top -
            box.getBoundingClientRect().top -
            160;
      });
      await expect(readOnly).toBeVisible();
      await page.screenshot({
        path: join(dir, `ask-readonly-${name}${suffix}.png`),
      });

      // 3. A click on the first cite chip: the jump target is on the screen.
      await messages.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.getByTestId("meeting-ask-cite").first().click();
      if (REAL) {
        await expect(page.locator('[data-search-hit="true"]')).toHaveCount(1);
        await expect(
          page.getByRole("tab", { name: /Transcript/ }),
        ).toHaveAttribute("aria-selected", "true");
      } else {
        await expect(
          page.getByRole("tab", { name: /Summary/ }),
        ).toHaveAttribute("aria-selected", "true");
      }
      await page.screenshot({
        path: join(dir, `ask-cite-${name}${suffix}.png`),
      });
    }
    await setTheme(page, "Light");
  });

  // P1.2: a turn runs on the server. The owner left the meeting while an
  // answer was generating and the conversation was gone.
  test("a turn goes on when the owner leaves the meeting and comes back", async () => {
    test.skip(!fake, "Needs the fake LLM to hold the answer.");
    test.setTimeout(90_000);
    const slow = fake as FakeAskLlm;
    slow.answerDelayMs = 6000;
    const question = "What did we decide about the beta launch date, again?";
    try {
      await openSubject(page);
      await page.getByRole("tab", { name: /Ask/ }).click();
      await page.getByTestId("meeting-ask-new").click();
      await page.getByTestId("meeting-ask-input").fill(question);
      await page.getByTestId("meeting-ask-send").click();
      // The question is on the screen and the turn runs.
      await expect(page.getByTestId("meeting-ask-user")).toContainText(
        question,
      );
      await expect(page.getByTestId("meeting-ask-status")).not.toBeEmpty();
      // The server holds the turn as pending.
      await waitForRunningTurn(b, SUBJECT.id);
      const other = MEETINGS[1];
      if (!other) throw new Error("The fixture has no second meeting.");
      // Leave: open another meeting in the list (the Ask tab unmounts).
      await page
        .getByTestId("meetings-list-column")
        .getByText(other.title, { exact: false })
        .first()
        .click();
      await expect(page.getByTestId("meeting-ask")).toHaveCount(0);
      // The turn is not lost: the server still says it runs.
      const list = (await (
        await b.api("GET", `/chat/threads?meeting_id=${SUBJECT.id}`)
      ).json()) as { threads: { id: string; title: string | null }[] };
      const thread = list.threads.find((t) =>
        t.title?.startsWith(
          "What did we decide about the beta launch date, again",
        ),
      );
      expect(thread, "the new thread is saved").toBeTruthy();
      const mid = (await (
        await b.api("GET", `/chat/threads/${thread?.id}`)
      ).json()) as {
        pending: boolean;
        messages: { role: string }[];
      };
      expect(mid.pending).toBe(true);
      expect(mid.messages.map((m) => m.role)).toEqual(["user"]);
      // Come back: the thread is there with the question and a running turn.
      await page
        .getByTestId("meetings-list-column")
        .getByText(SUBJECT.title, { exact: false })
        .first()
        .click();
      await page.getByRole("tab", { name: /Ask/ }).click();
      await expect(page.getByTestId("meeting-ask-user")).toContainText(
        question,
      );
      // The answer appears when the turn is done, without a new question.
      await expect(page.getByTestId("meeting-ask-assistant")).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(page.getByTestId("meeting-ask-user")).toHaveCount(1);
      await expect(
        page
          .getByTestId("meeting-ask-assistant")
          .getByTestId("meeting-ask-block-text"),
      ).toContainText("Friday 14 November");
      await expect(page.getByTestId("meeting-ask-status")).toBeEmpty();
      const stored = (await (
        await b.api("GET", `/chat/threads/${thread?.id}`)
      ).json()) as { pending: boolean; messages: { role: string }[] };
      expect(stored.pending).toBe(false);
      expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    } finally {
      slow.answerDelayMs = 0;
    }
  });

  test("a full reload of the window during a turn keeps the thread and the answer", async () => {
    test.skip(!fake, "Needs the fake LLM to hold the answer.");
    test.setTimeout(90_000);
    const slow = fake as FakeAskLlm;
    slow.answerDelayMs = 6000;
    const question =
      "What did we decide about the beta launch date after the reload?";
    try {
      await openSubject(page);
      await page.getByRole("tab", { name: /Ask/ }).click();
      await page.getByTestId("meeting-ask-new").click();
      await page.getByTestId("meeting-ask-input").fill(question);
      await page.getByTestId("meeting-ask-send").click();
      await expect(page.getByTestId("meeting-ask-user")).toContainText(
        question,
      );
      // The turn is on the server. Then the page unloads: the request of the
      // renderer is cut.
      await waitForRunningTurn(b, SUBJECT.id);
      await openSubject(page);
      await page.getByRole("tab", { name: /Ask/ }).click();
      await expect(page.getByTestId("meeting-ask-user")).toContainText(
        question,
      );
      await expect(page.getByTestId("meeting-ask-assistant")).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(
        page
          .getByTestId("meeting-ask-assistant")
          .getByTestId("meeting-ask-block-text"),
      ).toContainText("Friday 14 November");
    } finally {
      slow.answerDelayMs = 0;
    }
  });
}

if (REAL) {
  test.describe("Ask tab, real local model", defineScenario);
} else {
  test.describe("Ask tab, fake LLM server", defineScenario);
}
