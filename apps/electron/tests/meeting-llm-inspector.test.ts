import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { closeApp } from "./helpers/e2e-app";
import {
  bootEnhanceApp,
  type ChatRequest,
  defaultSegments,
  type EnhanceApp,
  FakeLlm,
  openMeeting,
  RIGHT_WORD,
  readRuns,
  recordRowCounts,
  seedCheckpointRows,
  seedMeeting,
  segmentId,
  WRONG_WORD,
  waitForRun,
} from "./helpers/enhance-fixture";

// ---------------------------------------------------------------------------
// The LLM inspector in the real app (specs/meeting-enhance-agentic.md 10.11.2,
// work package WP9). The gate is the `advanced_mode` setting. With it off the
// view has no inspector control and sends no request for call records. With it
// on, the panel of an edited text shows the system message, the user message
// and the answer that the fake server logged. The panel of a retried chunk
// lists both attempts, the panel of a speaker shows a kept and a dropped
// suggestion, and a meeting delete removes the record, including checkpoints.
// All text is fictional.
// ---------------------------------------------------------------------------

const MEETING = "e2e-inspector";
const TITLE = "Inspector sync";
const SUMMARY_OVERVIEW = "The team agreed to move the launch date to Friday.";

const fake = new FakeLlm();
let env: EnhanceApp;
const callRecordRequests: string[] = [];

test.describe.configure({ mode: "serial" });

function fixed(text: string): string {
  return text.replace(WRONG_WORD, RIGHT_WORD);
}

function segmentIndex(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

/** The last request that carried `id`, of one step. */
function lastRequestFor(step: ChatRequest["step"], id: string): ChatRequest {
  const found = fake.requests.filter(
    (r) => r.step === step && r.ids.includes(id),
  );
  const last = found[found.length - 1];
  if (!last) throw new Error(`no ${step} request for ${id}`);
  return last;
}

/** The answer that the fake server gave to a request, by arrival number. */
const answers = new Map<number, string>();

test.beforeAll(async () => {
  // A CI retry runs this hook again with the same module state. Start clean,
  // or a real failure shows up as a different, misleading failure.
  fake.requests.length = 0;
  answers.clear();
  callRecordRequests.length = 0;
  await fake.start();
  // Chunk 0 and 2 get an edit. Chunk 2 first answers with a wrong type, so
  // its step has two attempts (retry on `schema`).
  const wrongOnce = new Set<string>();
  fake.script = (req) => {
    let content: string;
    if (req.step === "correct_chunk") {
      const id = req.ids[0] as string;
      const index = segmentIndex(id);
      if (index === 2 && !wrongOnce.has(id)) {
        wrongOnce.add(id);
        content = JSON.stringify({ corrections: [{ id, text: 42 }] });
      } else {
        const corrections =
          index === 1 ? [] : [{ id, text: fixed(req.lines.get(id) ?? "") }];
        content = JSON.stringify({ corrections });
      }
    } else if (req.step === "identify_speakers") {
      content = JSON.stringify({
        speakers: [
          {
            segmentId: segmentId(MEETING, 1),
            quote: "This is Ana speaking",
            label: "1",
            kind: "name",
            name: "Ana",
          },
          {
            segmentId: segmentId(MEETING, 2),
            quote: "A line that nobody said",
            label: "2",
            kind: "name",
            name: "Bo",
          },
        ],
      });
    } else if (req.step === "meeting_tags") {
      // The tag step of issue #231. It runs after save.
      content = JSON.stringify({ tags: [] });
    } else {
      content = JSON.stringify({
        overview: SUMMARY_OVERVIEW,
        keyPoints: ["The launch date moved."],
        decisions: ["Launch on Friday."],
        actionItems: [
          { task: "Post the plan", owner: "Ana", due: "next Friday" },
        ],
        openQuestions: [],
      });
    }
    answers.set(req.n, content);
    return { content };
  };
  env = await bootEnhanceApp(fake, {
    advancedMode: false,
    prefix: "openstyle-e2e-inspector-",
  });
  env.page.on("request", (r) => {
    if (/\/llm-calls/.test(r.url())) callRecordRequests.push(r.url());
  });
  seedMeeting(env.userDataDir, MEETING, TITLE, defaultSegments(3));
});

test.afterAll(async () => {
  if (env) {
    await closeApp(env.app);
    rmSync(env.userDataDir, { recursive: true, force: true });
  }
  await fake.stop();
});

/** The content size of every window that is not the pill, by window id. */
async function contentSizes(): Promise<Array<[number, number, number]>> {
  return env.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => !win.webContents.getURL().includes("pill"))
      .map((win) => {
        const [w, h] = win.getContentSize();
        return [win.id, w ?? 0, h ?? 0] as [number, number, number];
      }),
  );
}

/** Sets the content size of one window and waits until the page sees it. */
async function resizeTo(
  page: Page,
  id: number,
  w: number,
  h: number,
): Promise<void> {
  await env.app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.fromId(size.id)?.setContentSize(size.w, size.h);
    },
    { id, w, h },
  );
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), {
      message: `window width after resize to ${w}`,
    })
    .toBe(w);
}

/**
 * Saves a screenshot when OPENSTYLE_EVIDENCE_DIR is set, at both sizes. The
 * window gets its old size back, so the test steps do not depend on the
 * variable.
 */
async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env.OPENSTYLE_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const before = await contentSizes();
  try {
    for (const [w, h] of [
      [1152, 648],
      [720, 480],
    ] as const) {
      for (const [id] of before) await resizeTo(page, id, w, h);
      await page.screenshot({
        path: join(dir, `inspector-${name}-${w}x${h}.png`),
      });
    }
  } finally {
    for (const [id, w, h] of before) await resizeTo(page, id, w, h);
  }
}

/** The text of every `pre` block inside a test id. */
async function blocks(page: Page, testId: string): Promise<string[]> {
  return page.getByTestId(testId).locator("pre").allTextContents();
}

test("gate off: no inspector control and no request for call records", async () => {
  test.setTimeout(120_000);
  const start = await env.api("POST", `/meetings/${MEETING}/enhance`);
  expect(start.status).toBe(202);
  const run = await waitForRun(env, MEETING, [
    "succeeded",
    "partial",
    "failed",
  ]);
  expect(run.status).toBe("succeeded");

  await openMeeting(env.page, TITLE);
  await expect(env.page.getByTestId("meetings-segment").first()).toBeVisible({
    timeout: 15_000,
  });
  await env.page.getByRole("tab", { name: "Summary" }).click();
  await expect(env.page.getByText(SUMMARY_OVERVIEW)).toBeVisible();
  for (const id of [
    "meetings-inspector-open",
    "meetings-segment-inspect",
    "meetings-summary-inspect",
    "meetings-inspector",
  ]) {
    await expect(env.page.getByTestId(id), id).toHaveCount(0);
  }
  expect(callRecordRequests).toEqual([]);
  await shoot(env.page, "gate-off");
});

test("gate on: the panel shows what the fake server logged", async () => {
  test.setTimeout(120_000);
  const put = await env.api("PUT", "/settings/advanced_mode", {
    value: "true",
  });
  expect(put.status).toBe(200);
  await openMeeting(env.page, TITLE);

  // Click the edited text of chunk 0.
  const first = segmentId(MEETING, 0);
  await env.page
    .locator(`[data-segment-id="${first}"]`)
    .getByTestId("meetings-segment-inspect")
    .click();
  const panel = env.page.getByTestId("meetings-inspector");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(env.page.getByTestId("meetings-inspector-call")).toBeVisible();

  // System message, user message and answer equal the logged request.
  const logged = lastRequestFor("correct_chunk", first);
  expect(await blocks(env.page, "meetings-inspector-messages")).toEqual(
    logged.messages,
  );
  expect((await blocks(env.page, "meetings-inspector-raw"))[0]).toBe(
    answers.get(logged.n),
  );

  // The ledger names the params of the wire body.
  const params = env.page.getByTestId("meetings-inspector-params");
  for (const key of ["temperature", "max_tokens", "response_format"]) {
    expect(Object.keys(logged.body), `wire body key ${key}`).toContain(key);
    await expect(params, `panel param ${key}`).toContainText(key);
  }
  expect(
    Object.keys(logged.body.chat_template_kwargs as Record<string, unknown>),
  ).toContain("enable_thinking");
  await expect(params).toContainText("enable_thinking");
  await shoot(env.page, "edit-panel");

  // Chunk 2 had a wrong answer first: the panel lists both attempts in order.
  await env.page.getByTestId("meetings-inspector-close").click();
  await expect(panel).toHaveCount(0);
  const third = segmentId(MEETING, 2);
  await env.page
    .locator(`[data-segment-id="${third}"]`)
    .getByTestId("meetings-segment-inspect")
    .click();
  await expect(env.page.getByTestId("meetings-inspector-call")).toBeVisible({
    timeout: 15_000,
  });
  const attempts = env.page.getByTestId("meetings-inspector-attempt");
  await expect(attempts).toHaveCount(2);
  await expect(attempts.nth(0)).toContainText(
    "The answer did not match the required format.",
  );
  await expect(attempts.nth(1)).toHaveAttribute("aria-current", "true");
  const retry = lastRequestFor("correct_chunk", third);
  expect(fake.countFor("correct_chunk", third)).toBe(2);
  expect(await blocks(env.page, "meetings-inspector-messages")).toEqual(
    retry.messages,
  );
  await shoot(env.page, "retried-chunk");

  // The first attempt shows its own answer.
  await attempts.nth(0).click();
  await expect(attempts.nth(0)).toHaveAttribute("aria-current", "true");
  const firstTry = fake.requests.filter(
    (r) => r.step === "correct_chunk" && r.ids.includes(third),
  )[0] as ChatRequest;
  await expect
    .poll(async () => (await blocks(env.page, "meetings-inspector-raw"))[0])
    .toBe(answers.get(firstTry.n));
  await env.page.getByTestId("meetings-inspector-close").click();

  // The Summary tab links to the summary call.
  await env.page.getByRole("tab", { name: "Summary" }).click();
  await env.page.getByTestId("meetings-summary-inspect").click();
  // One summary call: the list has one row. Open it.
  const summaryCalls = env.page.getByTestId("meetings-inspector-summary-call");
  await expect(summaryCalls).toHaveCount(1, { timeout: 15_000 });
  await summaryCalls.click();
  await expect(env.page.getByTestId("meetings-inspector-call")).toBeVisible({
    timeout: 15_000,
  });
  const summary = fake.requests.find((r) => r.step === "meeting_summary");
  expect(await blocks(env.page, "meetings-inspector-messages")).toEqual(
    summary?.messages,
  );
  await shoot(env.page, "summary-call");
  await env.page.getByTestId("meetings-inspector-close").click();

  // The speaker panel of the kept suggestion: its name, its quote, and the
  // evidence. Label 1 is the speaker that named itself.
  await env.page.getByRole("button", { name: "Speakers", exact: true }).click();
  await env.page.getByTestId("meetings-speaker-inspect").first().click();
  const keptRow = env.page.getByTestId("meetings-inspector-speaker-row");
  await expect(keptRow).toHaveCount(1, { timeout: 15_000 });
  await expect(keptRow).toHaveAttribute("data-outcome", "applied");
  await expect(keptRow).toContainText("Ana");
  await expect(keptRow).toContainText("This is Ana speaking");
  await shoot(env.page, "speaker-kept");

  // The dropped suggestion (label 2, a quote that nobody said) has no row in
  // the Speakers dialog. Its verdict is in the call record of the speaker.
  const droppedRes = await env.api(
    "GET",
    `/meetings/${MEETING}/llm-calls?target_type=speaker&target_id=2&detail=full`,
  );
  expect(droppedRes.status).toBe(200);
  const droppedBody = (await droppedRes.json()) as {
    calls: Array<{
      links: Array<{
        targetId: string;
        outcome: string;
        reason: string | null;
        verdict: { quote: string; proposedName: string } | null;
      }>;
    }>;
  };
  const dropped = droppedBody.calls
    .flatMap((c) => c.links)
    .filter((l) => l.targetId === "2");
  expect(dropped).toHaveLength(1);
  expect(dropped[0]?.outcome).toBe("dropped");
  expect(dropped[0]?.reason).toBe("quote_not_in_segment");
  expect(dropped[0]?.verdict?.quote).toBe("A line that nobody said");
});

test("gate off, then a reload: the controls are gone, and a delete leaves no record", async () => {
  test.setTimeout(120_000);
  const off = await env.api("PUT", "/settings/advanced_mode", {
    value: "false",
  });
  expect(off.status).toBe(200);
  await openMeeting(env.page, TITLE);
  await expect(env.page.getByTestId("meetings-segment").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(env.page.getByTestId("meetings-segment-inspect")).toHaveCount(0);
  await expect(env.page.getByTestId("meetings-inspector")).toHaveCount(0);

  // G7: the record exists before the delete and is gone after it.
  const runIds = (await readRuns(env, MEETING)).map((r) => r.id);
  expect(runIds.length).toBe(1);
  // A finished run keeps no checkpoint. Write one row of each table, so the
  // cascade of the delete is tested for them too.
  seedCheckpointRows(env.userDataDir, runIds);
  const before = recordRowCounts(env.userDataDir, MEETING, runIds);
  for (const table of [
    "llm_runs",
    "llm_run_steps",
    "llm_calls",
    "llm_call_links",
    "llm_checkpoints",
    "llm_checkpoint_writes",
  ] as const) {
    expect(before[table], `${table} before the delete`).toBeGreaterThan(0);
  }
  const del = await env.api("DELETE", `/meetings/${MEETING}`);
  expect(del.status).toBe(200);
  const after = recordRowCounts(env.userDataDir, MEETING, runIds);
  expect(Object.values(after)).toEqual([0, 0, 0, 0, 0, 0]);
});
