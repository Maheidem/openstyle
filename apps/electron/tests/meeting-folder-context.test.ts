import { rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { closeApp } from "./helpers/e2e-app";
import {
  bootEnhanceApp,
  type ChatRequest,
  defaultSegments,
  type EnhanceApp,
  FakeLlm,
  RIGHT_WORD,
  seedMeeting,
  WRONG_WORD,
  waitForRun,
} from "./helpers/enhance-fixture";

// ---------------------------------------------------------------------------
// Folder text as prompt context in the real app (issue #230 phase 2). A
// meeting in a folder gets the block `<FOLDER_LABEL> <name> - <description>` after
// its own context in the speaker and tag prompts. The summary prompt gets the
// meeting context only, as before #230 (spec P8b). `correct_chunk` gets no
// context. An unfiled meeting gets no block. The test reads the prompts from
// the fake server log and from the LLM inspector panel. All text is
// fictional.
// ---------------------------------------------------------------------------

const FILED = "e2e-folder-ctx-filed";
const FILED_TITLE = "Greenhouse sensor sync";
const UNFILED = "e2e-folder-ctx-unfiled";
const UNFILED_TITLE = "Bakery shelf sync";
const MEETING_CONTEXT = "Weekly sync of a made-up hardware team.";
const FOLDER_NAME = "Greenhouse Pilot";
const FOLDER_DESCRIPTION = "Pilot of soil sensors in a made-up greenhouse.";
// The label must match FOLDER_CONTEXT_LABEL of the server prompts.
const FOLDER_LABEL =
  "Folder (the user's own label for this group of meetings; it is not a participant, a company or an owner, and it is not a fact from this meeting):";
const BLOCK = `${FOLDER_LABEL} ${FOLDER_NAME} - ${FOLDER_DESCRIPTION}`;
const SUMMARY_OVERVIEW = "The team agreed to move the launch date to Friday.";

const fake = new FakeLlm();
let env: EnhanceApp;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fake.requests.length = 0;
  await fake.start();
  fake.script = (req) => {
    if (req.step === "correct_chunk") {
      const id = req.ids[0] as string;
      const text = (req.lines.get(id) ?? "").replace(WRONG_WORD, RIGHT_WORD);
      return { content: JSON.stringify({ corrections: [{ id, text }] }) };
    }
    if (req.step === "identify_speakers") {
      return { content: JSON.stringify({ speakers: [] }) };
    }
    if (req.step === "meeting_tags") {
      return { content: JSON.stringify({ tags: [] }) };
    }
    return {
      content: JSON.stringify({
        overview: SUMMARY_OVERVIEW,
        keyPoints: ["The launch date moved."],
        decisions: ["Launch on Friday."],
        actionItems: [],
        openQuestions: [],
      }),
    };
  };
  env = await bootEnhanceApp(fake, {
    advancedMode: true,
    prefix: "openstyle-e2e-folder-ctx-",
  });
  seedMeeting(env.userDataDir, FILED, FILED_TITLE, defaultSegments(3));
  seedMeeting(env.userDataDir, UNFILED, UNFILED_TITLE, defaultSegments(3));
  for (const id of [FILED, UNFILED]) {
    const ctx = await env.api("PATCH", `/meetings/${id}`, {
      context: MEETING_CONTEXT,
    });
    expect(ctx.status, `PATCH context of ${id}`).toBe(200);
  }
  const folder = await env.api("POST", "/meetings/folders", {
    name: FOLDER_NAME,
    description: FOLDER_DESCRIPTION,
  });
  expect(folder.status, "POST /meetings/folders").toBe(201);
  const { id: folderId } = (await folder.json()) as { id: string };
  const move = await env.api("POST", "/meetings/move", {
    meeting_ids: [FILED],
    folder_id: folderId,
  });
  expect(move.status, "POST /meetings/move").toBe(200);
});

test.afterAll(async () => {
  if (env) {
    await closeApp(env.app);
    rmSync(env.userDataDir, { recursive: true, force: true });
  }
  await fake.stop();
});

/** Runs Enhance (chained into Summarize) and returns the requests of the run. */
async function runEnhance(meetingId: string): Promise<ChatRequest[]> {
  const from = fake.requests.length;
  const start = await env.api("POST", `/meetings/${meetingId}/enhance`);
  expect(start.status, `POST enhance of ${meetingId}`).toBe(202);
  const run = await waitForRun(env, meetingId, [
    "succeeded",
    "partial",
    "failed",
  ]);
  expect(run.status).toBe("succeeded");
  // The tag step runs after save. Wait for its request too.
  await expect
    .poll(() =>
      fake.requests.slice(from).some((r) => r.step === "meeting_tags"),
    )
    .toBe(true);
  const own = fake.requests.slice(from);
  // Every correct_chunk request carries segment ids of this meeting only.
  for (const r of own.filter((x) => x.step === "correct_chunk")) {
    expect(r.ids[0]?.startsWith(`${meetingId}-seg-`)).toBe(true);
  }
  return own;
}

/** Opens the meeting in its rail group, after a fresh load. */
async function openMeeting(
  page: Page,
  title: string,
  folder: string | null,
): Promise<void> {
  // A folder group starts closed: a click on the folder shows its meetings.
  await page.reload();
  await page.waitForLoadState("load");
  await page.getByRole("link", { name: "Meetings" }).click();
  await page.waitForURL(/\/meetings/);
  const rail = page.getByRole("complementary", {
    name: "Meetings and folders",
  });
  const group = folder ?? "Unfiled";
  const row = rail.getByRole("group", { name: group, exact: true });
  if (folder) {
    await row.getByRole("button", { name: folder, exact: true }).click();
  }
  await row
    .locator("..")
    .getByRole("button", { name: new RegExp(title) })
    .click();
  await expect(page.getByTestId("meetings-segment").first()).toBeVisible({
    timeout: 15_000,
  });
}

/** The messages of one call, as the open inspector panel shows them. */
async function shownMessages(page: Page): Promise<string[]> {
  await expect(page.getByTestId("meetings-inspector-call")).toBeVisible({
    timeout: 15_000,
  });
  const messages = await page
    .getByTestId("meetings-inspector-messages")
    .locator("pre")
    .allTextContents();
  await page.getByTestId("meetings-inspector-close").click();
  return messages;
}

/** The messages of the summary call, as the inspector panel shows them. */
async function inspectorSummaryMessages(
  page: Page,
  title: string,
  folder: string | null,
): Promise<string[]> {
  await openMeeting(page, title, folder);
  await page.getByRole("tab", { name: "Summary" }).click();
  await expect(page.getByText(SUMMARY_OVERVIEW)).toBeVisible();
  await page.getByTestId("meetings-summary-inspect").click();
  const calls = page.getByTestId("meetings-inspector-summary-call");
  await expect(calls).toHaveCount(1, { timeout: 15_000 });
  await calls.click();
  return shownMessages(page);
}

/**
 * The messages of the speaker call of the Enhance run, as the inspector panel
 * shows them: the runs list, the Enhance run, then its Speakers step.
 */
async function inspectorSpeakerMessages(
  page: Page,
  title: string,
  folder: string | null,
): Promise<string[]> {
  await openMeeting(page, title, folder);
  await page.getByTestId("meetings-inspector-open").click();
  await page
    .getByTestId("meetings-inspector-run")
    .filter({ hasText: "Enhance" })
    .first()
    .click();
  await page
    .getByTestId("meetings-inspector-step")
    .filter({ hasText: "Speakers" })
    .click();
  return shownMessages(page);
}

test("a filed meeting: the folder block follows the meeting context in the speaker and tag prompts, not in the summary prompt", async () => {
  test.setTimeout(180_000);
  const requests = await runEnhance(FILED);
  const byStep = (step: ChatRequest["step"]) =>
    requests.filter((r) => r.step === step);
  expect(byStep("correct_chunk").length).toBe(3);
  for (const step of ["identify_speakers", "meeting_tags"] as const) {
    const found = byStep(step);
    expect(found.length, `${step} requests`).toBeGreaterThan(0);
    for (const r of found) {
      expect(r.system, step).toContain(MEETING_CONTEXT);
      expect(r.system, step).toContain(BLOCK);
      expect(r.system.indexOf(MEETING_CONTEXT), step).toBeLessThan(
        r.system.indexOf(BLOCK),
      );
    }
  }
  // The summary prompt has the meeting context and no folder block (P8b).
  for (const r of byStep("meeting_summary")) {
    expect(r.system).toContain(MEETING_CONTEXT);
    expect(r.system).not.toContain(FOLDER_LABEL);
    expect(r.system).not.toContain(FOLDER_NAME);
    expect(r.user).not.toContain(FOLDER_LABEL);
  }
  // correct_chunk had no context before, and gets none now.
  for (const r of byStep("correct_chunk")) {
    expect(r.system).not.toContain(FOLDER_LABEL);
    expect(r.system).not.toContain(MEETING_CONTEXT);
  }

  // The inspector shows the same prompts that the fake server logged: the
  // speaker call with the folder block, the summary call without it.
  const speakerShown = await inspectorSpeakerMessages(
    env.page,
    FILED_TITLE,
    FOLDER_NAME,
  );
  const identify = byStep("identify_speakers")[0] as ChatRequest;
  expect(speakerShown).toEqual(identify.messages);
  expect(speakerShown[0]).toContain(`${MEETING_CONTEXT}\n\n${BLOCK}`);

  const shown = await inspectorSummaryMessages(
    env.page,
    FILED_TITLE,
    FOLDER_NAME,
  );
  const summary = byStep("meeting_summary")[0] as ChatRequest;
  expect(shown).toEqual(summary.messages);
  expect(shown[0]).toContain(MEETING_CONTEXT);
  expect(shown.join("\n")).not.toContain(FOLDER_LABEL);
});

test("an unfiled meeting: no folder block in any prompt", async () => {
  test.setTimeout(180_000);
  const requests = await runEnhance(UNFILED);
  expect(requests.length).toBeGreaterThan(3);
  for (const r of requests) {
    expect(r.system, r.step).not.toContain(FOLDER_LABEL);
    expect(r.user, r.step).not.toContain(FOLDER_LABEL);
  }
  const summary = requests.find((r) => r.step === "meeting_summary");
  expect(summary?.system).toContain(MEETING_CONTEXT);

  const shown = await inspectorSummaryMessages(env.page, UNFILED_TITLE, null);
  expect(shown).toEqual(summary?.messages);
  expect(shown.join("\n")).not.toContain(FOLDER_LABEL);
});
