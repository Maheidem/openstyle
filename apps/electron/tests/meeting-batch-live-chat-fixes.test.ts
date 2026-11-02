import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page, test } from "@playwright/test";
import { type Booted, boot, put } from "./helpers/ask-app";
import { closeApp } from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// Fixes found on Dev 2.25.0-alpha.16 (fictional data, no audio, no model):
//   1. A closed finished batch box stays closed after a tab change and a
//      reload. A new batch shows the box again.
//   2. Live chat with a cloud provider answers. A provider error shows its text,
//      never an endless "Thinking...".
//   3. A reply with trailing junk and inline [F] markers shows clean text and
//      a cite chip, never raw JSON.
// The cloud provider is OpenRouter, pointed at a fake OpenAI-compatible server
// by the E2E seam OPENSTYLE_E2E_OPENROUTER_URL (E2E runs only).
// Set OPENSTYLE_EVIDENCE_DIR for light and dark screenshots.
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;
const MODEL = "openrouter/anthropic/claude-test";
const FOLDER_ID = "fix-folder-orchid";
const FOLDER_NAME = "Orchid project";
const OWNER_SAMPLE =
  '{"answer": "Dana owns the beta launch [F].", "cites": ["F"]}И}';
const PROVIDER_ERROR = "Fictional provider is down";

let mode: "junk" | "error" = "junk";
let fake: Server;
let b: Booted;
let page: Page;

function startFake(): Promise<number> {
  fake = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (mode === "error") {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: PROVIDER_ERROR } }));
        return;
      }
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          created: 1,
          model: "claude-test",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: OWNER_SAMPLE },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    });
  });
  return new Promise((done) =>
    fake.listen(0, "127.0.0.1", () =>
      done((fake.address() as AddressInfo).port),
    ),
  );
}

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(b.userDataDir, "freestyle.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

async function setTheme(name: "Light" | "Dark"): Promise<void> {
  await page.goto("app://renderer/settings#display");
  await page.getByRole("radio", { name, exact: true }).click();
  if (name === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function shot(name: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  await page.screenshot({ path: join(EVIDENCE_DIR, `${name}.png`) });
}

test.beforeAll(async () => {
  const port = await startFake();
  b = await boot("openstyle-e2e-fixes-", {
    OPENSTYLE_E2E_FAKE_MEETING_CAPTURE: "1",
    OPENSTYLE_E2E_OPENROUTER_URL: `http://127.0.0.1:${port}/v1`,
  });
  page = b.page;
  // Three fictional recorded meetings with no audio, in one folder.
  withDb((db) => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO meeting_folders (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      FOLDER_ID,
      FOLDER_NAME,
      "Fictional launch planning for the orchid app.",
      now,
      now,
    );
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO meetings (id, title, started_at, ended_at, duration_ms,
           status, audio_dir, folder_id, created_at)
         VALUES (?, ?, ?, ?, 60000, 'recorded', NULL, ?, ?)`,
      ).run(
        `fix-m-${i}`,
        `Orchid sync ${i}`,
        now - i * 3_600_000,
        now - i * 3_600_000 + 60_000,
        FOLDER_ID,
        now - i * 3_600_000,
      );
    }
  });
});

test.afterAll(async () => {
  if (b) {
    await closeApp(b.app);
    rmSync(b.userDataDir, { recursive: true, force: true });
  }
  fake?.close();
});

async function runBatch(): Promise<string> {
  const res = await b.api("POST", "/meetings/batch", {
    stage: "transcribe",
    meeting_ids: ["fix-m-1", "fix-m-2", "fix-m-3"],
  });
  expect(res.status).toBe(202);
  const started = (await res.json()) as { id: string };
  await expect
    .poll(
      async () =>
        (
          (await (await b.api("GET", "/meetings/batch")).json()) as {
            active: boolean;
          }
        ).active,
      { timeout: 20_000 },
    )
    .toBe(false);
  return started.id;
}

async function openMeetings(): Promise<void> {
  await page.goto("app://renderer/meetings");
  await page.waitForLoadState("load");
}

/** Opens Meetings and waits until the batch state has loaded and rendered, so
 * "no box" is a real result and not a page that has not loaded it yet. */
async function openMeetingsSettled(): Promise<void> {
  const loaded = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" && /\/api\/meetings\/batch$/.test(r.url()),
  );
  await openMeetings();
  await loaded;
  await expect(page.getByText("Orchid sync 1").first()).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(800);
}

test("bug 1: a closed finished batch stays closed, a new batch shows the box", async () => {
  test.setTimeout(120_000);
  const first = await runBatch();
  await openMeetings();
  const box = page.getByTestId("batch-progress");
  await expect(box).toBeVisible({ timeout: 20_000 });
  await expect(box).toContainText("Batch finished");
  await expect(box).toContainText("3 of 3");
  for (const theme of ["Light", "Dark"] as const) {
    await setTheme(theme);
    await openMeetings();
    await expect(box).toBeVisible();
    await shot(`batch-box-${theme.toLowerCase()}`);
  }
  await box.getByRole("button", { name: "Close" }).click();
  await expect(box).toHaveCount(0);
  // Another tab and back: the box stays closed.
  await page.goto("app://renderer/import");
  await page.waitForLoadState("load");
  await openMeetingsSettled();
  await expect(box).toHaveCount(0);
  // A reload (a new page process) keeps it closed. The id is stored.
  const reloaded = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" && /\/api\/meetings\/batch$/.test(r.url()),
  );
  await page.reload();
  await reloaded;
  await page.waitForTimeout(800);
  await expect(box).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("openstyle.meetings.closedBatch"),
    ),
  ).toBe(first);
  // A new batch has a new id and shows the box again.
  const second = await runBatch();
  expect(second).not.toBe(first);
  await page.goto("app://renderer/import");
  await openMeetings();
  await expect(box).toBeVisible({ timeout: 20_000 });
});

test("bugs 2 and 3: live chat answers with a cloud model, shows clean text and errors", async () => {
  test.setTimeout(180_000);
  await setTheme("Light");
  await put(b, "live_chat_enabled", "true");
  expect(
    (
      await b.api("POST", "/keys", {
        provider: "openrouter",
        key: "sk-fiction",
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await b.api("POST", "/models/configured", {
        provider: "openrouter",
        model_id: MODEL,
        model_name: "Claude test",
        type: "llm",
        is_default: true,
      })
    ).ok,
  ).toBe(true);
  await put(
    b,
    "llm_task_assignments",
    JSON.stringify({
      liveChat: {
        mode: "auto",
        modelOverride: { provider: "openrouter", model_id: MODEL },
      },
    }),
  );
  await openMeetings();
  // The orphan sweep runs 3 s after the start (live-testing skill, step 13).
  await page.waitForTimeout(5000);
  await page.getByRole("button", { name: "Start recording" }).first().click();
  const detail = page.getByTestId("meetings-detail-column");
  await expect(detail.getByTestId("live-chat")).toBeVisible({
    timeout: 20_000,
  });
  // The meeting sits in the folder, so [F] is a valid source.
  const id = await page.evaluate(
    async () => (await window.api.getMeetingStatus()).meetingId as string,
  );
  withDb((db) =>
    db
      .prepare("UPDATE meetings SET folder_id = ? WHERE id = ?")
      .run(FOLDER_ID, id),
  );
  const chat = detail.getByTestId("live-chat");
  const ask = async (q: string): Promise<void> => {
    await chat.getByTestId("live-chat-input").fill(q);
    await chat.getByTestId("live-chat-send").click();
  };

  // The panel names the provider and model that get the live text.
  await expect(chat.getByTestId("live-chat-model")).toContainText("openrouter");
  await expect(chat.getByTestId("live-chat-model")).toContainText(MODEL);

  // Bug 3: the fake returns the owner sample (JSON + trailing "И}" + marker).
  mode = "junk";
  await ask("Who owns the beta launch?");
  const answer = chat.getByTestId("live-chat-assistant");
  await expect(answer).toContainText("Dana owns the beta launch.", {
    timeout: 60_000,
  });
  const text = (await answer.innerText()) ?? "";
  expect(text).not.toContain("{");
  expect(text).not.toContain("И");
  expect(text).not.toContain("[F]");
  await expect(chat.getByTestId("live-chat-cite")).toContainText("F");
  await expect(chat.getByTestId("live-chat-thinking")).toHaveCount(0);

  // Bug 2: a provider error shows its text, and the loading text goes away.
  // The error is not saved with the chat, so each theme asks again.
  mode = "error";
  for (const theme of ["Light", "Dark"] as const) {
    await setTheme(theme);
    await openMeetings();
    await expect(detail.getByTestId("live-chat")).toBeVisible({
      timeout: 20_000,
    });
    await ask("And who is the backup?");
    const error = chat.getByTestId("live-chat-error");
    await expect(error).toContainText("The answer failed", { timeout: 60_000 });
    await expect(error).toContainText(PROVIDER_ERROR);
    await expect(chat.getByTestId("live-chat-thinking")).toHaveCount(0);
    await expect(chat.getByTestId("live-chat-warming")).toHaveCount(0);
    await shot(`live-chat-error-${theme.toLowerCase()}`);
  }

  await page.getByRole("button", { name: "Stop", exact: true }).first().click();
  await expect
    .poll(
      async () =>
        page.evaluate(async () => (await window.api.getMeetingStatus()).status),
      { timeout: 20_000 },
    )
    .toBe("idle");
});
