/**
 * Tests for the two user-set meeting LLM timeouts:
 * `meeting_summary_timeout_seconds` and `meeting_enhance_timeout_seconds`.
 *
 * The user could not see or widen these bounds. Summarize always timed out on
 * a local engine. The Enhance setting was a phantom: it shipped in 2.8.0 with
 * a validator, a default (600 s) and a conversion helper, but nothing read it.
 * `taskTimeoutMs()` returned the hard-coded 60_000 for every task except
 * `meetingSummarize`. Real log (meeting 9243bea0): every enhance chunk aborted
 * 60 s apart with `TimeoutError`, and the UI said "No segments needed
 * correction."
 *
 * Both knobs share one set of cases (`describe.each`):
 *  1. the bounds and the seconds to ms conversion (pure, `@openstyle/validations`);
 *  2. the settings route accepts a sane value and answers 400 to nonsense;
 *  3. `resolveTaskCall()` reads the row fresh at call time;
 *  4. the resolved number is the number that reaches `AbortSignal.timeout()`.
 *     The tests capture it at the `postProcess` boundary (`llm-call.ts` ->
 *     `postProcess` -> `generateText({ abortSignal })`). No real LLM runs.
 *
 * Cases that exist for one knob only stay in their own blocks below.
 */

import {
  DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
  DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
  MEETING_ENHANCE_TIMEOUT_SECONDS_MAX,
  MEETING_ENHANCE_TIMEOUT_SECONDS_MIN,
  MEETING_ENHANCE_TIMEOUT_SETTING_KEY,
  MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
  MEETING_SUMMARY_TIMEOUT_SECONDS_MIN,
  MEETING_SUMMARY_TIMEOUT_SETTING_KEY,
  meetingEnhanceTimeoutMs,
  meetingSummaryTimeoutMs,
  parseMeetingEnhanceTimeoutSeconds,
  parseMeetingSummaryTimeoutSeconds,
} from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import {
  deleteSetting,
  getDb,
  readSetting,
  writeSetting,
} from "../src/lib/db.js";
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
    // Flip to true to reproduce the `postProcess` failure fallback: the
    // wrapper never throws, it returns the input text with `model: null`.
    returnNullModel: false,
    postProcessSpy: vi.fn(async (opts: CapturedCall & { text?: unknown }) => {
      calls.push(opts);
      if (captured.returnNullModel) {
        return {
          // The echo: the prompt came back verbatim as the "correction".
          cleaned: String(opts.text ?? ""),
          model: null,
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      return {
        cleaned: '{"seg-1":"corrected text"}',
        model: "local-llm/mock-meeting-model",
        inputTokens: 900,
        outputTokens: 300,
      };
    }),
  };
});

vi.mock("@openstyle/stt", () => ({ postProcess: captured.postProcessSpy }));

function capturedCalls(): CapturedCall[] {
  return captured.calls;
}

async function putSetting(key: string, value: string): Promise<Response> {
  return createApp().request(`/api/settings/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

/** `meetingEnhance`'s profile budget is "auto", so the caller must supply one. */
const ENHANCE_BUDGET = { autoMaxOutputTokens: 512 } as const;

/** One Enhance call through the real resolver + the mocked transport. */
async function callEnhance(maxOutputTokens = 4096): Promise<void> {
  await resolveDefaultChatCall({
    system: "You correct meeting transcripts.",
    prompt: "[abc123] Me: hello",
    maxOutputTokens,
    taskId: "meetingEnhance",
  });
}

async function callSummarize(): Promise<void> {
  await resolveDefaultChatCall({
    system: "You summarize meetings.",
    prompt: "Speaker 1: hello",
    maxOutputTokens: 4096,
    taskId: "meetingSummarize",
  });
}

/** The two knobs. Each row feeds the shared `describe.each` blocks. */
const KNOBS = [
  {
    name: "summary",
    settingKey: MEETING_SUMMARY_TIMEOUT_SETTING_KEY,
    parse: parseMeetingSummaryTimeoutSeconds,
    toMs: meetingSummaryTimeoutMs,
    taskId: "meetingSummarize",
    // The summarize profile has a flat budget, so it needs no caller number.
    resolveOpts: {},
    minSeconds: MEETING_SUMMARY_TIMEOUT_SECONDS_MIN,
    maxSeconds: MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
    defaultSeconds: DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
    call: callSummarize,
  },
  {
    name: "enhance",
    settingKey: MEETING_ENHANCE_TIMEOUT_SETTING_KEY,
    parse: parseMeetingEnhanceTimeoutSeconds,
    toMs: meetingEnhanceTimeoutMs,
    taskId: "meetingEnhance",
    resolveOpts: ENHANCE_BUDGET,
    minSeconds: MEETING_ENHANCE_TIMEOUT_SECONDS_MIN,
    maxSeconds: MEETING_ENHANCE_TIMEOUT_SECONDS_MAX,
    defaultSeconds: DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
    call: () => callEnhance(),
  },
] as const;

beforeEach(() => {
  deleteSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY);
  deleteSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY);
  // A default chat model + a configured local endpoint, so `resolveTaskCall`
  // and `createChatModel` resolve exactly the way they do for a user who
  // points openstyle at their own llama.cpp / oMLX server.
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES ('local-llm', 'local-llm/mock-meeting-model', 'mock-meeting-model', 'llm', 1)`,
  ).run();
  writeSetting("local_llm_url", "http://127.0.0.1:4321/v1");
  captured.calls.length = 0;
});

afterEach(() => {
  deleteSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY);
  deleteSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY);
  captured.returnNullModel = false;
  vi.restoreAllMocks();
});

describe.each(KNOBS)("$settingKey — bounds and seconds→ms", ({
  parse,
  toMs,
  taskId,
  minSeconds,
  maxSeconds,
  defaultSeconds,
}) => {
  it("accepts whole seconds inside the bounds and reads them back exactly", () => {
    for (const value of ["30", "60", "600", "1800", "3600", " 900 "]) {
      expect(parse(value), value).toBe(Number(value.trim()));
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
      expect(parse(value), value).toBeNull();
    }
    expect(parse(null)).toBeNull();
    expect(parse(undefined)).toBeNull();
  });

  it("converts seconds to milliseconds exactly once, at the read site", () => {
    expect(toMs("30")).toBe(30_000);
    expect(toMs("600")).toBe(600_000);
    expect(toMs("3600")).toBe(3_600_000);
  });

  it("falls back to the 600 s default when unset, blank, malformed or out of bounds — never the old 60 s", () => {
    const fallback = defaultSeconds * 1000;
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
      expect(toMs(value), String(value)).toBe(fallback);
    }
    // The pre-fix number the change removed.
    expect(60_000).not.toBe(fallback);
  });

  it("has the documented bounds, and keeps the profile default equal to unset", () => {
    // The two knobs share their bounds on purpose.
    expect(minSeconds).toBe(30);
    expect(maxSeconds).toBe(3600);
    expect(minSeconds < defaultSeconds).toBe(true);
    expect(defaultSeconds < maxSeconds).toBe(true);
    // Profile == what "unset" means, so the two cannot drift apart.
    expect(LLM_TASK_PROFILES[taskId].timeoutMs).toBe(toMs(undefined));
  });
});

describe.each(KNOBS)("PUT /api/settings/$settingKey", ({
  settingKey,
  toMs,
  taskId,
  resolveOpts,
}) => {
  it("stores an in-bounds value verbatim and echoes it back", async () => {
    const res = await putSetting(settingKey, "900");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe("900");
    expect(readSetting(settingKey)).toBe("900");
  });

  it("400s nonsense with the bound in the message, and stores nothing", async () => {
    for (const value of ["1", "5", "29", "3601", "0", "abc", "4.5"]) {
      const res = await putSetting(settingKey, value);
      expect(res.status, value).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /30.*3600/,
      );
      expect(readSetting(settingKey), value).toBe(undefined);
    }
  });

  it("accepts empty as 'no preference' — the resolver then uses the default", async () => {
    const res = await putSetting(settingKey, "");
    expect(res.status).toBe(200);
    expect(toMs(readSetting(settingKey))).toBe(600_000);
  });

  it("is visible in the bulk listing (the Settings page seeds from it)", async () => {
    await putSetting(settingKey, "1234");
    const all = (await (
      await createApp().request("/api/settings")
    ).json()) as Record<string, string>;
    expect(all[settingKey]).toBe("1234");
  });

  it("chains end to end: a PUT through the route is what the very next resolver call uses", async () => {
    // No restart, no re-import, no cache bust: route -> settings row ->
    // resolveTaskCall -> AbortSignal.timeout, on the same process.
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(
      600_000,
    );
    expect((await putSetting(settingKey, "1500")).status).toBe(200);
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(
      1_500_000,
    );
    expect((await putSetting(settingKey, "")).status).toBe(200);
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(
      600_000,
    );
  });
});

describe.each(
  KNOBS,
)("resolveTaskCall honours the $name setting, read fresh on every call", ({
  settingKey,
  taskId,
  resolveOpts,
}) => {
  it("defaults to 600000 when the setting is unset — the regression that would have caught the phantom", async () => {
    deleteSetting(settingKey);
    const resolved = await resolveTaskCall(taskId, resolveOpts);
    expect(resolved.timeoutMs).toBe(600_000);
    // And it is NOT the value that shipped: the hard-coded 60 s profile.
    expect(resolved.timeoutMs).not.toBe(60_000);
  });

  it("picks up a raised value on the next call with no restart and no re-import of the module", async () => {
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(
      600_000,
    );
    // Same module instance, same process — only the DB row changed.
    writeSetting(settingKey, "1800");
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(
      1_800_000,
    );
    writeSetting(settingKey, "45");
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(45_000);
    // Deleting the row falls straight back to the default.
    deleteSetting(settingKey);
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(
      600_000,
    );
  });

  it("clamps defensively server-side: a junk row never reaches the wire", async () => {
    // Written straight to the DB, i.e. behind the route's 400 guard.
    writeSetting(settingKey, "999999");
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(
      600_000,
    );
    writeSetting(settingKey, "seven");
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(
      600_000,
    );
    writeSetting(settingKey, "0");
    expect((await resolveTaskCall(taskId, resolveOpts)).timeoutMs).toBe(
      600_000,
    );
  });
});

/**
 * The resolver returning a number is not enough. The enhance bug lived one
 * layer down, in what `llm-call.ts` puts on `AbortSignal.timeout()`.
 */
describe.each(
  KNOBS,
)("the resolved $name timeout is the number that reaches AbortSignal.timeout()", ({
  settingKey,
  call,
}) => {
  it("passes the user's raised window to the abort signal of the call", async () => {
    writeSetting(settingKey, "1200");
    const spy = vi.spyOn(AbortSignal, "timeout");

    await call();

    expect(spy).toHaveBeenCalledWith(1_200_000);
    const last = capturedCalls().at(-1);
    expect(last?.signal).toBeInstanceOf(AbortSignal);
    // The signal handed to postProcess is the one the timeout produced, and
    // postProcess forwards it as `abortSignal` to generateText
    // (packages/stt/src/post-process.ts:133). It is the whole window the
    // generation has to land in, and it is now the user's number.
    expect(last?.signal?.aborted).toBe(false);
    // The output budget stays per call, untouched by the timeout.
    expect(last?.maxOutputTokens).toBe(4096);
  });

  it("uses 600000 when nothing is configured — the old 60_000 never reaches the wire", async () => {
    deleteSetting(settingKey);
    const spy = vi.spyOn(AbortSignal, "timeout");

    await call();

    expect(spy).toHaveBeenLastCalledWith(600_000);
    expect(spy).not.toHaveBeenCalledWith(60_000);
  });

  it("round-trips a PUT through the route into the very next abort signal", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");

    expect((await putSetting(settingKey, "3600")).status).toBe(200);
    await call();
    expect(spy).toHaveBeenLastCalledWith(3_600_000);

    expect((await putSetting(settingKey, "90")).status).toBe(200);
    await call();
    expect(spy).toHaveBeenLastCalledWith(90_000);

    expect((await putSetting(settingKey, "")).status).toBe(200);
    await call();
    expect(spy).toHaveBeenLastCalledWith(600_000);
  });
});

describe("the two knobs are independent", () => {
  it("keeps the other tasks on their code-defined profile timeouts", () => {
    // Only cleanup and remix stay code-defined. Both meeting tasks are
    // user-bounded now.
    expect(LLM_TASK_PROFILES.cleanup.timeoutMs).toBe(20_000);
    expect(LLM_TASK_PROFILES.remix.timeoutMs).toBe(30_000);
    expect(LLM_TASK_PROFILES.meetingEnhance.timeoutMs).toBe(
      meetingEnhanceTimeoutMs(undefined),
    );
    expect(LLM_TASK_PROFILES.meetingEnhance.timeoutMs).toBe(600_000);
  });

  it("leaves cleanup/remix on their code-defined timeouts and gives enhance its own", async () => {
    writeSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "1800");
    // cleanup/remix carry an "auto" output budget, so they need the caller's
    // number. It does not matter here: only timeoutMs is under test.
    expect((await resolveTaskCall("cleanup", ENHANCE_BUDGET)).timeoutMs).toBe(
      20_000,
    );
    expect((await resolveTaskCall("remix", ENHANCE_BUDGET)).timeoutMs).toBe(
      30_000,
    );
    // Enhance ignores the SUMMARY knob — it has its own. Unset here, so its
    // 600 s default: not the old hard-coded 60 s, not summarize's 1800 s.
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(600_000);
    // And its own knob moves it while summarize keeps 1800 s.
    writeSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "90");
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(90_000);
    expect((await resolveTaskCall("meetingSummarize")).timeoutMs).toBe(
      1_800_000,
    );
  });

  it("does not let a raised summarize window reach the enhance abort signal", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");

    // Raising only summarize's knob leaves enhance on its own 600 s default.
    writeSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "1200");
    await callEnhance();
    expect(spy).toHaveBeenLastCalledWith(600_000);

    writeSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "150");
    await callEnhance();
    expect(spy).toHaveBeenLastCalledWith(150_000);
  });

  it("leaves the summarize window alone when only the enhance knob moves", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");

    writeSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "120");
    await callSummarize();
    expect(spy).toHaveBeenLastCalledWith(600_000);

    await callEnhance();
    expect(spy).toHaveBeenLastCalledWith(120_000);
  });
});

/**
 * The other half of the honesty fix, pinned at the same seam: the guard in
 * `llm-call.ts` that turns `postProcess`'s "never throws, returns the input
 * echoed with `model: null`" fallback into a thrown error. Weaken it and every
 * dead-engine chunk becomes a byte-for-byte "correction", the pass reports
 * `chunksSucceeded: N`, and the user is back to a lie — this time a louder one.
 */
describe("the echoed-transcript guard stays intact", () => {
  it("throws instead of returning the echo when postProcess reports model:null", async () => {
    captured.returnNullModel = true;

    await expect(callEnhance()).rejects.toThrow(/Meeting LLM call failed/);
    // The call did go out, with the user's window — the guard fires after the
    // transport, not instead of it.
    expect(capturedCalls().at(-1)?.signal).toBeInstanceOf(AbortSignal);
  });

  it("still returns text on a healthy call (the guard is not over-eager)", async () => {
    await callEnhance();
    expect(capturedCalls()).toHaveLength(1);
    expect(capturedCalls().at(-1)?.signal).toBeInstanceOf(AbortSignal);
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
    writeSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "1200");
    const plan = await summarizeJobPlan([seg("hello")]);
    expect(plan.perCallMs).toBe(1_200_000);
    expect(plan.deadlineMs).toBe(2_400_000);
  });

  it("multi-chunk transcript: plannedCalls = map + 1 reduce, deadline = perCall x calls", async () => {
    // Budget 1,000 tok -> overlap min(400, 10%) = 100 -> 900 fresh tokens per
    // chunk. 40 lines of 400 chars ≈ 102 tok each ≈ 4,080 tok -> 5 map
    // chunks -> 6 calls; at the 45 s minimum-ish timeout that is 270 s.
    writeSetting(CONTEXT_BUDGET_KEY, "1000");
    writeSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "45");
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
