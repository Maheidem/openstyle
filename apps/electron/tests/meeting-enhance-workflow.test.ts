import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
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
  readRuns,
  readStepRows,
  seedMeeting,
  segmentId,
  WRONG_WORD,
  waitForRun,
} from "./helpers/enhance-fixture";

// ---------------------------------------------------------------------------
// Enhance v3 in the real app (specs/meeting-enhance-agentic.md 10.11.1 and
// 10.11.3, work package WP9). A fake own server stands in for the model, so
// every answer is known. Each meeting is fictional and has one chunk for each
// segment. The floor of the work package:
//   1. happy path: json_schema on the wire, chat_template_kwargs, all steps
//      done, Enhance chains into Summarize;
//   2. a fake `length` answer: the notice shows live and after a reload;
//   3. SIGKILL of the server process during correctChunk: the run completes
//      and no finished chunk gets a second request.
// Left to a follow-up card (10.11.3): the kill during the speaker call, the
// kill in Summarize with a small budget, and a second kill (the run stays
// interrupted and shows Resume).
// ---------------------------------------------------------------------------

const fake = new FakeLlm();
let env: EnhanceApp;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fake.start();
  env = await bootEnhanceApp(fake, {
    advancedMode: false,
    prefix: "openstyle-e2e-enhance-",
  });
});

test.afterAll(async () => {
  if (env) {
    await closeApp(env.app);
    rmSync(env.userDataDir, { recursive: true, force: true });
  }
  await fake.stop();
});

/** The corrected text of a fake answer: the original with one word fixed. */
function fixed(text: string): string {
  return text.replace(WRONG_WORD, RIGHT_WORD);
}

function segmentIndex(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

const SUMMARY_OVERVIEW = "The team agreed to move the launch date to Friday.";

/**
 * The script of a well behaved model. `fix(i)` says whether segment `i`
 * gets a correction. The answers follow the segment ids of the request.
 */
function goodAnswer(
  meetingId: string,
  fix: (index: number) => boolean,
): (req: ChatRequest) => Answer {
  return (req) => {
    if (req.step === "correct_chunk") {
      const corrections = req.ids
        .filter((id) => fix(segmentIndex(id)))
        .map((id) => ({ id, text: fixed(req.lines.get(id) ?? "") }));
      return { content: JSON.stringify({ corrections }) };
    }
    if (req.step === "identify_speakers") {
      return {
        content: JSON.stringify({
          speakers: [
            {
              segmentId: segmentId(meetingId, 1),
              quote: "This is Ana speaking",
              label: "1",
              kind: "name",
              name: "Ana",
            },
          ],
        }),
      };
    }
    return {
      content: JSON.stringify({
        overview: SUMMARY_OVERVIEW,
        keyPoints: ["The launch date moved."],
        decisions: ["Launch on Friday."],
        actionItems: [
          { task: "Post the plan", owner: "Ana", due: "next Friday" },
        ],
        openQuestions: [],
      }),
    };
  };
}

async function transcriptOf(
  meetingId: string,
): Promise<Array<{ id?: string; text: string; enhancedText?: string }>> {
  const res = await env.api("GET", `/meetings/${meetingId}/transcript`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { segments: never[] }).segments;
}

test("happy path: schema on the wire, all steps done, Enhance chains into Summarize", async () => {
  test.setTimeout(120_000);
  const id = "e2e-happy";
  fake.requests.length = 0;
  const base = goodAnswer(id, (i) => i !== 1);
  // Park the summary call: the list card must read Transcribed while the
  // chained Summarize runs, so the later "Summarized" proves a refetch.
  fake.script = (req) => (req.step === "meeting_summary" ? "hold" : base(req));
  seedMeeting(env.userDataDir, id, "Happy path sync", defaultSegments(3));

  await openMeeting(env.page, "Happy path sync");
  const card = env.page
    .locator("aside")
    .getByRole("button")
    .filter({ hasText: "Happy path sync" });
  await env.page.getByRole("button", { name: "Enhance", exact: true }).click();
  await expect.poll(() => fake.heldCount(), { timeout: 30_000 }).toBe(1);
  await expect(card.getByText("Transcribed", { exact: true })).toBeVisible();
  // The one-second poll must see the Summarize job before the call ends.
  await env.page.waitForResponse(async (r) => {
    if (!r.url().endsWith(`/api/meetings/${id}`)) return false;
    const body = (await r.json().catch(() => null)) as {
      job?: { kind?: string } | null;
    } | null;
    return body?.job?.kind === "summarize";
  });
  // Match the list path, also when an open folder adds a query string.
  // The job change must refresh the list before the held summary ends.
  const listRefetch = await env.page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/meetings" &&
      r.request().method() === "GET",
  );
  console.log("Meeting list after job change:", listRefetch.url());
  const held = fake.requests.find((r) => r.step === "meeting_summary");
  if (!held) throw new Error("no summary request");
  fake.releaseHeld(base(held));
  const run = await waitForRun(env, id, ["succeeded", "partial", "failed"]);

  // One run did both jobs. The user clicked once.
  expect(run.status).toBe("succeeded");
  expect(run.kind).toBe("enhance");
  expect(run.startedBy).toBe("button");
  expect(run.correctedCount).toBe(2);
  expect(run.failedStepCount).toBe(0);
  const steps = readStepRows(env.userDataDir, run.id);
  expect(steps.every((s) => s.status === "succeeded")).toBe(true);
  // One chunk for each segment. If the fixture text or CHUNK_TOKENS_MAX
  // changes, this fails first and says why the request counts differ.
  expect(
    steps.map((s) => s.key).filter((k) => k.startsWith("chunk:")),
    "chunk steps of the run",
  ).toEqual(["chunk:0", "chunk:1", "chunk:2"]);
  expect(steps.map((s) => s.key)).toEqual(
    expect.arrayContaining([
      "prepare",
      "chunk:0",
      "chunk:1",
      "chunk:2",
      "candidates",
      "verify",
      "save",
    ]),
  );

  // Requests: 3 chunks, one speaker call, one summary call. Nothing else.
  const count = (step: ChatRequest["step"]) =>
    fake.requests.filter((r) => r.step === step).length;
  expect(count("correct_chunk")).toBe(3);
  expect(count("identify_speakers")).toBe(1);
  expect(count("meeting_summary")).toBe(1);
  expect(count("other")).toBe(0);

  // Every body asks for a json_schema answer. The names are literal: the
  // wire name of each step, not the field that the fake server reads.
  const names = fake.requests.map((req) => {
    const rf = req.body.response_format as {
      type: string;
      json_schema: { name: string; strict?: boolean };
    };
    expect(rf.type, `request ${req.n} response_format.type`).toBe(
      "json_schema",
    );
    expect(
      req.body.chat_template_kwargs,
      `request ${req.n} chat_template_kwargs`,
    ).toBeDefined();
    return rf.json_schema.name;
  });
  expect([...names].sort()).toEqual([
    "correct_chunk",
    "correct_chunk",
    "correct_chunk",
    "identify_speakers",
    "meeting_summary",
  ]);
  const correct = fake.requests.find((r) => r.step === "correct_chunk");
  expect(
    (correct?.body.chat_template_kwargs as Record<string, unknown>)
      .enable_thinking,
  ).toBe(false);

  // The edits are in the transcript, and the summary is on screen.
  const segments = await transcriptOf(id);
  expect(segments[0]?.enhancedText).toBe(fixed(segments[0]?.text ?? ""));
  expect(segments[1]?.enhancedText).toBeUndefined();
  expect(segments[2]?.enhancedText).toBe(fixed(segments[2]?.text ?? ""));
  await env.page.getByRole("tab", { name: "Summary" }).click();
  await expect(env.page.getByText(SUMMARY_OVERVIEW)).toBeVisible({
    timeout: 10_000,
  });
  const detail = (await (await env.api("GET", `/meetings/${id}`)).json()) as {
    status: string;
  };
  expect(detail.status).toBe("summarized");
  // #218 item 2: the list card follows the run without a page reload.
  await expect(card.getByText("Summarized", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  // No failure notice after a clean run.
  await expect(env.page.getByTestId("meetings-run-notice-enhance")).toHaveCount(
    0,
  );
});

test("a length answer shows the notice live and after a reload", async () => {
  test.setTimeout(120_000);
  const id = "e2e-length";
  const good = goodAnswer(id, () => false);
  const cut = segmentId(id, 1);
  fake.requests.length = 0;
  fake.script = (req) =>
    req.step === "correct_chunk" && req.ids.includes(cut)
      ? {
          content: `{"corrections":[{"id":"${cut}","text":"The ${RIGHT_WORD} da`,
          finish: "length",
        }
      : good(req);
  seedMeeting(env.userDataDir, id, "Length sync", defaultSegments(3));

  await openMeeting(env.page, "Length sync");
  await env.page.getByRole("button", { name: "Enhance", exact: true }).click();
  // Live: the notice shows on this page, with no reload, before the test
  // looks at the stored run.
  const notice = env.page.getByTestId("meetings-run-notice-enhance");
  const reason = "The model reached its output limit.";
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice).toHaveAttribute("data-run-status", "partial");
  const run = await waitForRun(env, id, ["succeeded", "partial", "failed"]);
  expect(run.status).toBe("partial");
  const failed = run.steps.filter((s) => s.status === "failed");
  expect(failed.map((s) => [s.key, s.errorKind])).toEqual([
    ["chunk:1", "length"],
  ]);
  // The output limit goes up once, then the chunk fails: 2 requests.
  expect(fake.countFor("correct_chunk", cut)).toBe(2);
  // The other two chunks finished: the run did not stop.
  expect(fake.countFor("correct_chunk", segmentId(id, 0))).toBe(1);
  expect(fake.countFor("correct_chunk", segmentId(id, 2))).toBe(1);

  await expect(notice.getByTestId("meetings-run-notice-line")).toHaveCount(1);
  await expect(notice.getByTestId("meetings-run-notice-line")).toContainText(
    reason,
  );
  await expect(notice).toContainText("1 of");

  // The notice comes from the stored run, so a reload keeps it.
  await env.page.reload();
  await env.page.waitForLoadState("load");
  await openMeeting(env.page, "Length sync");
  const again = env.page.getByTestId("meetings-run-notice-enhance");
  await expect(again).toBeVisible({ timeout: 10_000 });
  await expect(again).toHaveAttribute("data-run-status", "partial");
  await expect(again.getByTestId("meetings-run-notice-line")).toContainText(
    reason,
  );
});

test.describe("kill and resume", () => {
  // A retry would hide a race.
  test.describe.configure({ retries: 0 });

  /** The pid of the server process. */
  async function utilityPid(): Promise<number> {
    const pid = await env.app.evaluate(() => {
      const read = (globalThis as Record<string, unknown>)
        .__openstyleServerHostPid;
      return typeof read === "function" ? (read() as number | null) : null;
    });
    expect(pid).toBeGreaterThan(0);
    return pid as number;
  }

  async function waitFor(
    what: string,
    ok: () => boolean | Promise<boolean>,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await ok()) return;
      } catch {
        // The server may be down for a moment.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timeout waiting for ${what}`);
  }

  test("SIGKILL in correctChunk: the run completes and no finished chunk is asked twice", async () => {
    test.setTimeout(180_000);
    const killId = "e2e-kill";
    const controlId = "e2e-control";
    const chunks = 5;
    seedMeeting(env.userDataDir, killId, "Kill sync", defaultSegments(chunks));
    seedMeeting(
      env.userDataDir,
      controlId,
      "Control sync",
      defaultSegments(chunks),
    );

    // The third chunk request is held. Arrival order is not fixed, so the
    // script reads the held id from the request.
    let heldId: string | null = null;
    let seen = 0;
    const good = goodAnswer(killId, () => true);
    fake.requests.length = 0;
    fake.script = (req) => {
      if (req.step === "correct_chunk" && req.ids[0]?.startsWith(killId)) {
        seen += 1;
        if (seen === 3 && heldId === null) {
          heldId = req.ids[0] ?? null;
          return "hold";
        }
      }
      return good(req);
    };

    const start = await env.api("POST", `/meetings/${killId}/enhance`);
    expect(start.status).toBe(202);
    await waitFor("a held request", () => fake.heldCount() === 1);
    expect(heldId).not.toBeNull();

    // Kill the server process while the third chunk waits for its answer.
    const oldPid = await utilityPid();
    process.kill(oldPid, "SIGKILL");
    await waitFor(
      "a new server process",
      async () => {
        const pid = await utilityPid();
        if (pid === oldPid) return false;
        return (await env.api("GET", "/health")).status === 200;
      },
      15_000,
    );

    // The boot sweep marks the run interrupted. The boot resume (the model
    // answers its probe) sends the held chunk again and finishes the run.
    const run = await waitForRun(env, killId, ["succeeded"], 90_000);
    expect(run.resumeCount).toBe(1);
    expect(run.startedBy).toBe("button");
    expect(run.failedStepCount).toBe(0);
    expect(
      readStepRows(env.userDataDir, run.id).every(
        (s) => s.status === "succeeded",
      ),
    ).toBe(true);

    // One chunk for each segment, or the counts below mean nothing.
    expect(
      readStepRows(env.userDataDir, run.id)
        .map((s) => s.key)
        .filter((k) => k.startsWith("chunk:")),
      "chunk steps of the run",
    ).toEqual(Array.from({ length: chunks }, (_, i) => `chunk:${i}`));

    // G6: every finished chunk reached the fake server once, the held one
    // twice.
    for (let i = 0; i < chunks; i++) {
      const id = segmentId(killId, i);
      const expected = id === heldId ? 2 : 1;
      expect(
        fake.countFor("correct_chunk", id),
        `requests for chunk of ${id}`,
      ).toBe(expected);
    }
    expect(
      fake.requests.filter((r) => r.step === "meeting_summary").length,
    ).toBe(1);

    // A call record is written when the call ends, so the killed call has no
    // row. Each chunk has exactly one final row; the held chunk's only row is
    // the one of its second request.
    const db = new DatabaseSync(join(env.userDataDir, "freestyle.db"), {
      readOnly: true,
    });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const rows = db
        .prepare(
          `SELECT step_key AS key, count(*) AS n, max(attempt) AS attempt
             FROM llm_calls
            WHERE scope = 'meeting' AND scope_id = ? AND node = 'correctChunk'
            GROUP BY step_key ORDER BY step_key`,
        )
        .all(killId) as Array<{ key: string; n: number; attempt: number }>;
      expect(rows.map((r) => [r.key, r.n])).toEqual(
        Array.from({ length: chunks }, (_, i) => [`chunk:${i}`, 1]),
      );
    } finally {
      db.close();
    }

    // The meeting left the transcribing sweep alone and holds its summary.
    const detail = (await (
      await env.api("GET", `/meetings/${killId}`)
    ).json()) as { status: string };
    expect(detail.status).toBe("summarized");

    // A control run on the second meeting, with no kill, gives the same
    // texts.
    fake.script = goodAnswer(controlId, () => true);
    const control = await env.api("POST", `/meetings/${controlId}/enhance`);
    expect(control.status).toBe(202);
    const controlRun = await waitForRun(env, controlId, ["succeeded"], 90_000);
    expect(controlRun.resumeCount).toBe(0);
    const killed = await transcriptOf(killId);
    const plain = await transcriptOf(controlId);
    expect(killed.map((s) => s.enhancedText)).toEqual(
      plain.map((s) => s.enhancedText),
    );
    expect(killed.every((s) => s.enhancedText?.includes(RIGHT_WORD))).toBe(
      true,
    );
    // The record lists exactly one run for the killed meeting.
    expect((await readRuns(env, killId)).length).toBe(1);
  });
});
