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
 *     The tests spy on it at the gateway (`callStructured`) over a scripted
 *     model (specs/meeting-enhance-agentic.md 5.7). No real LLM runs.
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
import type { CallSink } from "../src/lib/llm/call-record.js";
import { callStructured } from "../src/lib/llm/gateway.js";
import {
  __clearModeCacheForTests,
  resolveCallProfile,
} from "../src/lib/llm/model-profiles.js";
import {
  LLM_TASK_PROFILES,
  resolveTaskCall,
} from "../src/lib/llm/task-profiles.js";
import {
  CORRECT_CHUNK_STEP_SCHEMA,
  summaryStageStepSchema,
} from "../src/lib/meetings/workflow/schemas.js";
import { insertOwnServer } from "../src/lib/own-servers.js";
import { okReply, scriptedModel, seamFor } from "./helpers/fake-model.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

async function putSetting(key: string, value: string): Promise<Response> {
  return createApp().request(`/api/settings/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

/** `meetingEnhance`'s profile budget is "auto", so the caller must supply one. */
const ENHANCE_BUDGET = { autoMaxOutputTokens: 512 } as const;

const NO_SINK: CallSink = {
  startAttempt: () => undefined,
  recordCall: () => null,
};

/** The max output tokens that the last scripted model got. */
let lastMaxOutput: number | undefined;

/**
 * One call through the real gateway over a scripted model. The call timeout
 * of the task profile is read by `resolveTaskCall` and put on
 * `AbortSignal.timeout()` (5.7).
 */
async function callGateway(
  taskId: "meetingEnhance" | "meetingSummarize",
  maxOutputTokens = 4096,
): Promise<void> {
  const enhance = taskId === "meetingEnhance";
  const profile = await resolveCallProfile({
    taskId,
    step: enhance ? "correctChunk" : "summarize",
    maxReasoningTokens: 0,
  });
  const fake = scriptedModel("mock-meeting-model", [
    okReply(enhance ? '{"corrections":[]}' : JSON.stringify({ overview: "x" })),
  ]);
  const common = {
    runId: "run-timeouts",
    unitKey: enhance ? "chunk:0" : "overview",
    chunkIndex: null,
    instructions: "Fictional instructions.",
    messages: [{ role: "user" as const, content: "[abc123] Me: hello" }],
    profile,
    maxOutputTokens,
    signal: new AbortController().signal,
    sink: NO_SINK,
    createModel: seamFor(fake.model),
  };
  if (enhance) {
    await callStructured({
      ...common,
      step: "correctChunk",
      schema: CORRECT_CHUNK_STEP_SCHEMA,
    });
  } else {
    await callStructured({
      ...common,
      step: "summarize",
      schema: summaryStageStepSchema("overview"),
    });
  }
  lastMaxOutput = fake.calls[0]?.maxOutputTokens;
}

const callEnhance = (maxOutputTokens = 4096) =>
  callGateway("meetingEnhance", maxOutputTokens);
const callSummarize = () => callGateway("meetingSummarize");

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
  // A default chat model + an own server, so `resolveTaskCall` and
  // `createChatModel` resolve exactly the way they do for a user who points
  // openstyle at their own llama.cpp / oMLX server.
  const db = getDb();
  db.exec("DELETE FROM own_servers");
  const server = insertOwnServer({
    baseUrl: "http://127.0.0.1:4321",
    apiKey: null,
    flavor: "openai",
  });
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES ('server', ?, 'mock-meeting-model', 'llm', 1)`,
  ).run(`server/${server.id}/mock-meeting-model`);
  __clearModeCacheForTests();
  lastMaxOutput = undefined;
});

afterEach(() => {
  deleteSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY);
  deleteSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY);
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
 * layer down, in what the call layer puts on `AbortSignal.timeout()`.
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
    // The output budget stays per call, untouched by the timeout.
    expect(lastMaxOutput).toBe(4096);
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
    // Only cleanup stays code-defined. Both meeting tasks are
    // user-bounded now.
    expect(LLM_TASK_PROFILES.cleanup.timeoutMs).toBe(20_000);
    expect(LLM_TASK_PROFILES.meetingEnhance.timeoutMs).toBe(
      meetingEnhanceTimeoutMs(undefined),
    );
    expect(LLM_TASK_PROFILES.meetingEnhance.timeoutMs).toBe(600_000);
  });

  it("leaves cleanup on its code-defined timeout and gives enhance its own", async () => {
    writeSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY, "1800");
    // cleanup carries an "auto" output budget, so it needs the caller's
    // number. It does not matter here: only timeoutMs is under test.
    expect((await resolveTaskCall("cleanup", ENHANCE_BUDGET)).timeoutMs).toBe(
      20_000,
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
