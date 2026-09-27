/**
 * The user-facing fix for "meeting summarization always times out on a local
 * engine": one global, user-settable `meeting_summary_timeout_seconds`.
 *
 * Three things are pinned here, because the bug was a bound the user could
 * neither see nor widen:
 *  1. the bounds + the seconds→ms conversion (pure, `@openstyle/validations`);
 *  2. the settings route accepting a sane value and rejecting nonsense with a
 *     400 instead of storing a row that would be silently ignored;
 *  3. `resolveTaskCall()` reading the row *fresh at call time*, and that
 *     resolved number being what actually reaches `AbortSignal.timeout()` —
 *     captured at the `postProcess` boundary (`llm-call.ts` → `postProcess` →
 *     `generateText({ abortSignal })`), so no real LLM is involved.
 */

import {
  DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
  MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
  MEETING_SUMMARY_TIMEOUT_SECONDS_MIN,
  MEETING_SUMMARY_TIMEOUT_SETTING_KEY,
  meetingSummaryTimeoutMs,
  parseMeetingSummaryTimeoutSeconds,
} from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { getDb, readSetting } from "../src/lib/db.js";
import {
  LLM_TASK_PROFILES,
  resolveTaskCall,
} from "../src/lib/llm/task-profiles.js";
import { resolveDefaultChatCall } from "../src/lib/meetings/llm-call.js";
import type { MergedSegment } from "../src/lib/meetings/merge.js";
import {
  MAX_SUMMARIZE_CALLS,
  plannedSummarizeCalls,
  summarizeJobDeadlineMs,
  summarizeJobPlan,
} from "../src/lib/meetings/summarize.js";

/** What `postProcess` was handed — the abort signal is the load-bearing bit. */
interface CapturedCall {
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

const captured = vi.hoisted(() => {
  const calls: { signal?: AbortSignal; maxOutputTokens?: number }[] = [];
  return {
    calls,
    postProcessSpy: vi.fn(async (opts: CapturedCall) => {
      calls.push(opts);
      return {
        cleaned: "# Summary\n- ok",
        model: "local-llm/mock-summary-model",
        inputTokens: 1200,
        outputTokens: 800,
      };
    }),
  };
});

vi.mock("@openstyle/stt", () => ({ postProcess: captured.postProcessSpy }));

function capturedCalls(): CapturedCall[] {
  return captured.calls;
}

function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

function deleteSetting(key: string): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

function putSetting(value: string): Promise<Response> {
  return createApp().request(
    `/api/settings/${MEETING_SUMMARY_TIMEOUT_SETTING_KEY}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    },
  );
}

beforeEach(() => {
  deleteSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY);
  // A default chat model + a configured local endpoint, so `resolveTaskCall`
  // and `createChatModel` resolve exactly the way they do for a user who
  // points openstyle at their own llama.cpp / oMLX server.
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES ('local-llm', 'local-llm/mock-summary-model', 'mock-summary-model', 'llm', 1)`,
  ).run();
  setSetting("local_llm_url", "http://127.0.0.1:4321/v1");
  captured.calls.length = 0;
});

afterEach(() => {
  deleteSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY);
  vi.restoreAllMocks();
});

describe("meeting_summary_timeout_seconds — bounds and seconds→ms", () => {
  it("accepts whole seconds inside the bounds and reads them back exactly", () => {
    for (const value of ["30", "60", "600", "1800", "3600", " 900 "]) {
      expect(parseMeetingSummaryTimeoutSeconds(value), value).toBe(
        Number(value.trim()),
      );
    }
  });

  it("rejects nonsense instead of coercing it: below min, above max, non-integer, non-numeric, empty, nullish", () => {
    for (const value of [
      "",
      "   ",
      "0",
      "1",
      "5",
      "29",
      "3601",
      "86400",
      "4.5",
      "-60",
      "60s",
      "abc",
      "null",
    ]) {
      expect(parseMeetingSummaryTimeoutSeconds(value), value).toBeNull();
    }
    expect(parseMeetingSummaryTimeoutSeconds(null)).toBeNull();
    expect(parseMeetingSummaryTimeoutSeconds(undefined)).toBeNull();
  });

  it("converts seconds to milliseconds exactly once, at the read site", () => {
    expect(meetingSummaryTimeoutMs("30")).toBe(30_000);
    expect(meetingSummaryTimeoutMs("600")).toBe(600_000);
    expect(meetingSummaryTimeoutMs("3600")).toBe(3_600_000);
  });

  it("falls back to the new default when unset, blank, malformed or out of bounds — never an unbounded wait", () => {
    const fallback = DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS * 1000;
    expect(fallback).toBe(600_000);
    for (const value of [
      undefined,
      null,
      "",
      "   ",
      "0",
      "1",
      "29",
      "3601",
      "99999",
      "abc",
      "-100",
      "60.5",
    ]) {
      expect(meetingSummaryTimeoutMs(value), String(value)).toBe(fallback);
    }
  });

  it("keeps the code-defined profile equal to the unset behaviour, and the other tasks untouched", () => {
    // Profile == what "unset" means, so the two can't drift apart.
    expect(LLM_TASK_PROFILES.meetingSummarize.timeoutMs).toBe(
      meetingSummaryTimeoutMs(undefined),
    );
    // The bounds are the documented arithmetic (packages/validations/src/
    // settings.ts): 60 s could only ever deliver 600 tokens at 10 tok/s of a
    // 4096-token budget, which is why the default had to move.
    expect(MEETING_SUMMARY_TIMEOUT_SECONDS_MIN).toBe(30);
    expect(MEETING_SUMMARY_TIMEOUT_SECONDS_MAX).toBe(3600);
    expect(
      MEETING_SUMMARY_TIMEOUT_SECONDS_MIN <
        DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
    ).toBe(true);
    expect(
      DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS <
        MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
    ).toBe(true);
    // Scope: summarization only.
    expect(LLM_TASK_PROFILES.cleanup.timeoutMs).toBe(20_000);
    expect(LLM_TASK_PROFILES.remix.timeoutMs).toBe(30_000);
    expect(LLM_TASK_PROFILES.meetingEnhance.timeoutMs).toBe(60_000);
  });
});

describe(`PUT /api/settings/${MEETING_SUMMARY_TIMEOUT_SETTING_KEY}`, () => {
  it("stores an in-bounds value verbatim and echoes it back", async () => {
    const res = await putSetting("900");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe("900");
    expect(readSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY)).toBe("900");
  });

  it("400s nonsense with the bound in the message, and stores nothing", async () => {
    for (const value of ["1", "5", "29", "3601", "0", "abc", "4.5"]) {
      const res = await putSetting(value);
      expect(res.status, value).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /30.*3600/,
      );
      expect(readSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY), value).toBe(
        undefined,
      );
    }
  });

  it("accepts empty as 'no preference' — the resolver then uses the default", async () => {
    const res = await putSetting("");
    expect(res.status).toBe(200);
    expect(
      meetingSummaryTimeoutMs(readSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY)),
    ).toBe(600_000);
  });

  it("is visible in the bulk listing (the Settings page seeds from it)", async () => {
    await putSetting("1234");
    const all = (await (
      await createApp().request("/api/settings")
    ).json()) as Record<string, string>;
    expect(all[MEETING_SUMMARY_TIMEOUT_SETTING_KEY]).toBe("1234");
  });

  it("chains end to end: a PUT through the route is what the very next resolver call uses", async () => {
    // No restart, no re-import, no cache bust — route → settings row →
    // resolveTaskCall → AbortSignal.timeout, on the same process.
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(600_000);
    expect((await putSetting("1500")).status).toBe(200);
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(
      1_500_000,
    );
    expect((await putSetting("")).status).toBe(200);
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(600_000);
  });
});

describe("resolveTaskCall honours the setting, read fresh on every call", () => {
  it("uses the default when the setting is unset", async () => {
    deleteSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY);
    const resolved = await resolveTaskCall("meetingSummarize");
    expect(resolved.timeoutMs).toBe(600_000);
  });

  it("picks up a raised value on the next call with no restart and no re-import of the module", async () => {
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(600_000);
    // Same module instance, same process — only the DB row changed.
    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "1800");
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(
      1_800_000,
    );
    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "45");
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(45_000);
    // Deleting the row falls straight back to the default.
    deleteSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY);
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(600_000);
  });

  it("clamps defensively server-side: a junk row never reaches the wire", async () => {
    // Written straight to the DB, i.e. behind the route's 400 guard.
    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "999999");
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(600_000);
    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "seven");
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(600_000);
    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "0");
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(600_000);
  });

  it("leaves cleanup/remix/meetingEnhance on their code-defined timeouts", async () => {
    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "1800");
    // cleanup/remix carry an "auto" output budget, so they need the caller's
    // number — irrelevant here, only timeoutMs is under test.
    expect(
      (await resolveTaskCall("cleanup", { autoMaxOutputTokens: 512 }))
        .timeoutMs,
    ).toBe(20_000);
    expect(
      (await resolveTaskCall("remix", { autoMaxOutputTokens: 512 })).timeoutMs,
    ).toBe(30_000);
    expect(
      (await resolveTaskCall("meetingEnhance", { autoMaxOutputTokens: 512 }))
        .timeoutMs,
    ).toBe(60_000);
  });
});

describe("the resolved timeout is the number that reaches AbortSignal.timeout()", () => {
  async function callSummarize(
    taskId: "meetingSummarize" | "meetingEnhance",
  ): Promise<void> {
    await resolveDefaultChatCall({
      system: "You summarize meetings.",
      prompt: "Speaker 1: hello",
      maxOutputTokens: 4096,
      taskId,
    });
  }

  it("passes the user's raised window to the abort signal of the summary call", async () => {
    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "1200");
    const spy = vi.spyOn(AbortSignal, "timeout");

    await callSummarize("meetingSummarize");

    expect(spy).toHaveBeenCalledWith(1_200_000);
    const call = capturedCalls().at(-1);
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    // The signal handed to postProcess is the one the timeout produced, and
    // postProcess forwards it as `abortSignal` to generateText
    // (packages/stt/src/post-process.ts:133) — this is the whole window the
    // generation has to land in, and it is now the user's number.
    expect(call?.signal?.aborted).toBe(false);
    expect(call?.maxOutputTokens).toBe(4096);
  });

  it("uses the 600 s default when nothing is configured, and still leaves enhance alone", async () => {
    deleteSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY);
    const spy = vi.spyOn(AbortSignal, "timeout");

    await callSummarize("meetingSummarize");
    expect(spy).toHaveBeenLastCalledWith(600_000);

    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "1200");
    await callSummarize("meetingEnhance");
    expect(spy).toHaveBeenLastCalledWith(60_000);
  });
});

/**
 * §5.8's job-level ceiling, pinned at the seam the async summarize job reads
 * it from (`summarizeJobPlan`, called by `runSummarizeJob` in
 * `routes/meetings.ts`). The per-call timeout above bounds ONE generation;
 * this bounds the RUN — map/reduce is calls × per-call, and without a job
 * ceiling a saturated local engine holds the lane slot, the meeting's job
 * slot and the user's attention indefinitely.
 */
describe("summarizeJobPlan — the §5.8 ceiling the summarize job enforces", () => {
  const CONTEXT_BUDGET_KEY = "meeting_summary_context_budget";

  afterEach(() => {
    deleteSetting(CONTEXT_BUDGET_KEY);
  });

  function seg(text: string): MergedSegment {
    return { speaker: "Me", startMs: 0, endMs: 1000, text };
  }

  it("single pass: 1 planned call and the 2 x perCall floor (600 s -> 1,200 s)", async () => {
    const plan = await summarizeJobPlan([seg("hello")]);
    expect(plan.perCallMs).toBe(DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS * 1000);
    expect(plan.plannedCalls).toBe(1);
    expect(plan.deadlineMs).toBe(1_200_000);
    // The floor is what binds here, not the product: a call that merely hits
    // its own 600 s timeout must not kill the job on first attempt.
    expect(plan.deadlineMs).toBe(2 * plan.perCallMs);
  });

  it("reads a raised per-call timeout fresh, and scales the ceiling by it", async () => {
    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "1200");
    const plan = await summarizeJobPlan([seg("hello")]);
    expect(plan.perCallMs).toBe(1_200_000);
    expect(plan.deadlineMs).toBe(2_400_000);
  });

  it("multi-chunk transcript: plannedCalls = map + 1 reduce, deadline = perCall x calls", async () => {
    // Budget 1,000 tok -> overlap min(400, 10%) = 100 -> 900 fresh tokens per
    // chunk. 40 lines of 400 chars ≈ 102 tok each ≈ 4,080 tok -> 5 map
    // chunks -> 6 calls; at the 45 s minimum-ish timeout that is 270 s.
    setSetting(CONTEXT_BUDGET_KEY, "1000");
    setSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "45");
    const segments = Array.from({ length: 40 }, () => seg("x".repeat(400)));

    const plan = await summarizeJobPlan(segments);
    expect(plan.contextBudgetTokens).toBe(1000);
    expect(plan.perCallMs).toBe(45_000);
    expect(plan.transcriptTokens).toBeGreaterThan(plan.contextBudgetTokens);
    expect(plan.plannedCalls).toBeGreaterThan(1);
    expect(plan.plannedCalls).toBeLessThanOrEqual(MAX_SUMMARIZE_CALLS);
    expect(plan.deadlineMs).toBe(plan.perCallMs * plan.plannedCalls);
    expect(plan.deadlineMs).toBeGreaterThanOrEqual(2 * plan.perCallMs);
  });

  it("clamps at 4 h instead of running unbounded (worst legal transcript)", () => {
    expect(
      summarizeJobDeadlineMs(
        DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS * 1000,
        24,
      ),
    ).toBe(4 * 60 * 60 * 1000);
    expect(plannedSummarizeCalls(10_000_000, 8000)).toBe(MAX_SUMMARIZE_CALLS);
  });
});
