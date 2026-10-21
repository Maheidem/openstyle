import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { closeApp } from "./helpers/e2e-app";
import {
  type Answer,
  bootEnhanceApp,
  type ChatRequest,
  defaultSegments,
  type EnhanceApp,
  FakeLlm,
  openMeeting,
  RIGHT_WORD,
  seedMeeting,
  segmentId,
  WRONG_WORD,
  waitForRun,
} from "./helpers/enhance-fixture";

// Issue #260: a meeting job that waits for the LLM lane shows "Queued" in the
// list, not "Enhancing 0%". Two fictional meetings run Enhance against one
// fake own server. An own server has a lane of one slot
// (LLM_LANE_CONCURRENCY_LOCAL in apps/server/src/lib/llm/lane.ts), so one
// held call of the first meeting makes the second meeting wait in the real
// lane. Set OPENSTYLE_PROOF_SHOTS=<dir> to save screenshots.

const SHOTS_DIR = process.env.OPENSTYLE_PROOF_SHOTS;
const HOLD_ID = "e2e-queue-hold";
const HOLD_TITLE = "Queue holder sync";
const WAIT_ID = "e2e-queue-wait";
const WAIT_TITLE = "Queue waiter sync";

const fake = new FakeLlm();
let env: EnhanceApp;

test.beforeAll(async () => {
  await fake.start();
  env = await bootEnhanceApp(fake, {
    advancedMode: false,
    prefix: "openstyle-e2e-queued-",
  });
});

test.afterAll(async () => {
  if (env) {
    await closeApp(env.app);
    rmSync(env.userDataDir, { recursive: true, force: true });
  }
  await fake.stop();
});

/** The answer of a well behaved model for every step. */
function goodAnswer(req: ChatRequest): Answer {
  switch (req.step) {
    case "correct_chunk":
      return {
        content: JSON.stringify({
          corrections: req.ids.map((id) => ({
            id,
            text: (req.lines.get(id) ?? "").replace(WRONG_WORD, RIGHT_WORD),
          })),
        }),
      };
    case "identify_speakers":
      return { content: JSON.stringify({ speakers: [] }) };
    case "meeting_tags":
      return { content: JSON.stringify({ tags: ["launch plan"] }) };
    default:
      return {
        content: JSON.stringify({
          overview: "The team moved the launch date to Friday.",
          keyPoints: ["The launch date moved."],
          decisions: [],
          actionItems: [],
          openQuestions: [],
        }),
      };
  }
}

function isChunkOf(req: ChatRequest, meetingId: string): boolean {
  return (
    req.step === "correct_chunk" &&
    [0, 1].some((i) => req.ids.includes(segmentId(meetingId, i)))
  );
}

/** The newest chunk request of a meeting that reached the fake server. */
function lastChunkOf(meetingId: string): ChatRequest {
  const req = fake.requests.filter((r) => isChunkOf(r, meetingId)).at(-1);
  if (!req) throw new Error(`no chunk request of ${meetingId}`);
  return req;
}

function listRow(title: string): Locator {
  return env.page
    .locator("aside")
    .getByRole("button")
    .filter({ hasText: title });
}

interface ListJob {
  kind?: string | null;
  done: number;
  total: number;
  queued?: { ahead: number; sinceMs: number } | null;
}

async function listJobs(): Promise<Record<string, ListJob | null>> {
  const res = await env.api("GET", "/meetings");
  expect(res.status, "GET /api/meetings").toBe(200);
  const body = (await res.json()) as {
    items: Array<{ id: string; job?: ListJob | null }>;
  };
  return Object.fromEntries(body.items.map((m) => [m.id, m.job ?? null]));
}

async function shot(name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await env.page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

test("a meeting that waits for the LLM lane shows Queued, then its job, then its status", async () => {
  test.setTimeout(180_000);
  seedMeeting(env.userDataDir, HOLD_ID, HOLD_TITLE, defaultSegments(2));
  seedMeeting(env.userDataDir, WAIT_ID, WAIT_TITLE, defaultSegments(2));
  // Step 1: the first chunk call of the holder stays open, so it keeps the
  // one lane slot.
  fake.script = (req) => (isChunkOf(req, HOLD_ID) ? "hold" : goodAnswer(req));

  await openMeeting(env.page, HOLD_TITLE);
  await env.page.getByRole("button", { name: "Enhance", exact: true }).click();
  await expect.poll(() => fake.heldCount(), { timeout: 30_000 }).toBe(1);

  await openMeeting(env.page, WAIT_TITLE);
  await env.page.getByRole("button", { name: "Enhance", exact: true }).click();

  // The waiter waits in the real lane: the server says so.
  await expect
    .poll(async () => (await listJobs())[WAIT_ID]?.queued ?? null, {
      timeout: 30_000,
    })
    .not.toBeNull();
  const jobs = await listJobs();
  console.log(
    "GET /api/meetings jobs while the holder holds the lane:",
    JSON.stringify({ [HOLD_ID]: jobs[HOLD_ID], [WAIT_ID]: jobs[WAIT_ID] }),
  );
  expect(jobs[WAIT_ID]).toMatchObject({ kind: "enhance" });
  expect(jobs[WAIT_ID]?.queued?.ahead).toBeGreaterThan(0);
  // The holder has a call in work. Its second chunk waits behind its own
  // call, and that is not a queued job.
  expect(jobs[HOLD_ID]).toMatchObject({ kind: "enhance", queued: null });
  // Only the one held call reached the model.
  expect(fake.requests.filter((r) => r.step === "correct_chunk")).toHaveLength(
    1,
  );

  // The list row of the waiter shows Queued and no percent.
  const waitBadge = listRow(WAIT_TITLE).getByTestId("meetings-job-badge");
  await expect(waitBadge).toHaveText(/^Queued$/i, { timeout: 10_000 });
  await expect(waitBadge).toHaveAttribute("data-queued", "true");
  await expect(waitBadge).not.toContainText("%");
  // The holder keeps its normal job badge.
  const holdBadge = listRow(HOLD_TITLE).getByTestId("meetings-job-badge");
  await expect(holdBadge).toContainText(/Enhancing/i);
  await expect(holdBadge).not.toHaveAttribute("data-queued", "true");

  // The detail card of the waiter names the wait and shows no percent.
  const queuedLine = env.page.getByText(/Waiting for the model to be free/);
  await expect(queuedLine).toBeVisible({ timeout: 10_000 });
  const card = env.page.locator("div", { has: queuedLine }).filter({
    has: env.page.getByTestId("meetings-cancel-enhance"),
  });
  await expect(card.last()).not.toContainText("%");
  await expect(env.page.getByText(/Reading chunk|Preparing/)).toHaveCount(0);
  await shot("queued-list-and-detail");

  // Step 2: let the holder go. Hold the chunk calls of the waiter, so the
  // screen can show its running job.
  fake.script = (req) => (isChunkOf(req, WAIT_ID) ? "hold" : goodAnswer(req));
  fake.releaseHeld(goodAnswer(lastChunkOf(HOLD_ID)));
  await expect
    .poll(() => fake.requests.filter((r) => isChunkOf(r, WAIT_ID)).length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await listJobs())[WAIT_ID]?.queued ?? null, {
      timeout: 10_000,
    })
    .toBeNull();
  await expect(waitBadge).toContainText(/Enhancing/i, { timeout: 10_000 });
  await expect(waitBadge).not.toHaveAttribute("data-queued", "true");
  await expect(queuedLine).toHaveCount(0);
  await shot("running-after-release");

  // Step 3: every call answers. Both runs end, and the rows show the final
  // status.
  fake.script = goodAnswer;
  while (fake.heldCount() > 0) {
    fake.releaseHeld(goodAnswer(lastChunkOf(WAIT_ID)));
    await env.page.waitForTimeout(200);
  }
  for (const id of [HOLD_ID, WAIT_ID]) {
    const run = await waitForRun(env, id, ["succeeded", "partial", "failed"]);
    expect(run.status, `run of ${id}`).toBe("succeeded");
  }
  for (const title of [HOLD_TITLE, WAIT_TITLE]) {
    await expect(
      listRow(title).getByText("Summarized", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(listRow(title).getByTestId("meetings-job-badge")).toHaveCount(
      0,
    );
  }
});
