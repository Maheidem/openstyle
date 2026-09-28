/**
 * The user-facing fix for the phantom `meeting_enhance_timeout_seconds`.
 *
 * The defect (real log, meeting 9243bea0-567f-443b-bf3b-9980f69993fd): every
 * enhance chunk aborted 60 s apart —
 *   warn [meeting-enhance] enhance chunk call failed, skipping:
 *        TimeoutError: The operation was aborted due to timeout
 * — while the UI reported "No segments needed correction." The setting that
 * was supposed to widen that window shipped in 2.8.0 with a validator, a
 * default (600 s) and a conversion helper, and NO read site: `taskTimeoutMs()`
 * returned the profile's hard-coded 60_000 for anything but `meetingSummarize`
 * and the key was not in `SETTINGS_KEYS` nor handled by the settings route.
 *
 * So this file's acceptance test is not "the validator accepts 900" — that was
 * always true and shipped broken. It is: **PUT the key, and the number that
 * reaches `AbortSignal.timeout()` moves.** Captured at the `postProcess`
 * boundary (`llm-call.ts` → `postProcess` → `generateText({ abortSignal })`),
 * exactly like `meeting-summary-timeout.test.ts` does for Summarize, so no
 * real LLM is involved.
 */

import {
  DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
  MEETING_ENHANCE_TIMEOUT_SECONDS_MAX,
  MEETING_ENHANCE_TIMEOUT_SECONDS_MIN,
  MEETING_ENHANCE_TIMEOUT_SETTING_KEY,
  meetingEnhanceTimeoutMs,
  parseMeetingEnhanceTimeoutSeconds,
} from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { getDb, readSetting } from "../src/lib/db.js";
import {
  LLM_TASK_PROFILES,
  resolveTaskCall,
} from "../src/lib/llm/task-profiles.js";
import { resolveDefaultChatCall } from "../src/lib/meetings/llm-call.js";

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
    postProcessSpy: vi.fn(async (opts: CapturedCall) => {
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
        model: "local-llm/mock-enhance-model",
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
    `/api/settings/${MEETING_ENHANCE_TIMEOUT_SETTING_KEY}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    },
  );
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

beforeEach(() => {
  deleteSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY);
  deleteSetting("meeting_summary_timeout_seconds");
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES ('local-llm', 'local-llm/mock-enhance-model', 'mock-enhance-model', 'llm', 1)`,
  ).run();
  setSetting("local_llm_url", "http://127.0.0.1:4321/v1");
  captured.calls.length = 0;
});

afterEach(() => {
  deleteSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY);
  captured.returnNullModel = false;
  vi.restoreAllMocks();
});

describe("meeting_enhance_timeout_seconds — bounds and seconds→ms", () => {
  it("accepts whole seconds inside the bounds and reads them back exactly", () => {
    for (const value of ["30", "60", "600", "1800", "3600", " 900 "]) {
      expect(parseMeetingEnhanceTimeoutSeconds(value), value).toBe(
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
      expect(parseMeetingEnhanceTimeoutSeconds(value), value).toBeNull();
    }
    expect(parseMeetingEnhanceTimeoutSeconds(null)).toBeNull();
    expect(parseMeetingEnhanceTimeoutSeconds(undefined)).toBeNull();
  });

  it("converts seconds to milliseconds exactly once, at the read site", () => {
    expect(meetingEnhanceTimeoutMs("30")).toBe(30_000);
    expect(meetingEnhanceTimeoutMs("600")).toBe(600_000);
    expect(meetingEnhanceTimeoutMs("3600")).toBe(3_600_000);
  });

  it("falls back to the 600 s default when unset, blank, malformed or out of bounds — never the old 60 s", () => {
    const fallback = DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS * 1000;
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
      expect(meetingEnhanceTimeoutMs(value), String(value)).toBe(fallback);
    }
    // The pre-fix number this whole change removes.
    expect(60_000).not.toBe(fallback);
  });

  it("shares the summarize knob's bounds deliberately, and keeps the profile default equal to unset", () => {
    expect(MEETING_ENHANCE_TIMEOUT_SECONDS_MIN).toBe(30);
    expect(MEETING_ENHANCE_TIMEOUT_SECONDS_MAX).toBe(3600);
    expect(
      MEETING_ENHANCE_TIMEOUT_SECONDS_MIN <
        DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
    ).toBe(true);
    expect(
      DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS <
        MEETING_ENHANCE_TIMEOUT_SECONDS_MAX,
    ).toBe(true);
    expect(LLM_TASK_PROFILES.meetingEnhance.timeoutMs).toBe(
      meetingEnhanceTimeoutMs(undefined),
    );
  });
});

describe(`PUT /api/settings/${MEETING_ENHANCE_TIMEOUT_SETTING_KEY}`, () => {
  it("stores an in-bounds value verbatim and echoes it back", async () => {
    const res = await putSetting("900");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe("900");
    expect(readSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY)).toBe("900");
  });

  it("400s nonsense with the bound in the message, and stores nothing", async () => {
    for (const value of ["1", "5", "29", "3601", "0", "abc", "4.5"]) {
      const res = await putSetting(value);
      expect(res.status, value).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /30.*3600/,
      );
      expect(readSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY), value).toBe(
        undefined,
      );
    }
  });

  it("accepts empty as 'no preference' — the resolver then uses the default", async () => {
    const res = await putSetting("");
    expect(res.status).toBe(200);
    expect(
      meetingEnhanceTimeoutMs(readSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY)),
    ).toBe(600_000);
  });

  it("is visible in the bulk listing (the Settings page seeds from it)", async () => {
    await putSetting("1234");
    const all = (await (
      await createApp().request("/api/settings")
    ).json()) as Record<string, string>;
    expect(all[MEETING_ENHANCE_TIMEOUT_SETTING_KEY]).toBe("1234");
  });

  it("chains end to end: a PUT through the route is what the very next resolver call uses", async () => {
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(600_000);
    expect((await putSetting("1500")).status).toBe(200);
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(1_500_000);
    expect((await putSetting("")).status).toBe(200);
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(600_000);
  });
});

describe("resolveTaskCall honours the enhance setting, read fresh on every call", () => {
  it("defaults to 600000 when the setting is unset — this is the regression that would have caught the phantom", async () => {
    deleteSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY);
    const resolved = await resolveTaskCall("meetingEnhance", {
      autoMaxOutputTokens: 512,
    });
    expect(resolved.timeoutMs).toBe(600_000);
    // And it is NOT the value that shipped: the hard-coded 60 s profile.
    expect(resolved.timeoutMs).not.toBe(60_000);
  });

  it("picks up a raised value on the next call with no restart and no re-import of the module", async () => {
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(600_000);
    setSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "1800");
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(1_800_000);
    setSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "45");
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(45_000);
    deleteSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY);
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(600_000);
  });

  it("clamps defensively server-side: a junk row never reaches the wire", async () => {
    setSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "999999");
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(600_000);
    setSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "seven");
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(600_000);
    setSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "0");
    expect(
      (await resolveTaskCall("meetingEnhance", ENHANCE_BUDGET)).timeoutMs,
    ).toBe(600_000);
  });
});

/**
 * THE acceptance test for Defect 1. The resolver returning a number is not
 * enough — the bug lived one layer down, in what `llm-call.ts` puts on
 * `AbortSignal.timeout()`. Same spy seam as the summarize proof.
 */
describe("the resolved enhance timeout is the number that reaches AbortSignal.timeout()", () => {
  it("passes the user's raised window to the abort signal of the enhance call", async () => {
    setSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "1200");
    const spy = vi.spyOn(AbortSignal, "timeout");

    await callEnhance();

    expect(spy).toHaveBeenCalledWith(1_200_000);
    const call = capturedCalls().at(-1);
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    expect(call?.signal?.aborted).toBe(false);
    // Enhance's budget stays per-chunk ("auto" profile), untouched by this.
    expect(call?.maxOutputTokens).toBe(4096);
  });

  it("uses 600000 when nothing is configured — the old 60_000 never reaches the wire", async () => {
    deleteSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY);
    const spy = vi.spyOn(AbortSignal, "timeout");

    await callEnhance();

    expect(spy).toHaveBeenLastCalledWith(600_000);
    expect(spy).not.toHaveBeenCalledWith(60_000);
  });

  it("round-trips a PUT through the route into the very next abort signal", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");

    expect((await putSetting("3600")).status).toBe(200);
    await callEnhance();
    expect(spy).toHaveBeenLastCalledWith(3_600_000);

    expect((await putSetting("90")).status).toBe(200);
    await callEnhance();
    expect(spy).toHaveBeenLastCalledWith(90_000);

    expect((await putSetting("")).status).toBe(200);
    await callEnhance();
    expect(spy).toHaveBeenLastCalledWith(600_000);
  });

  it("leaves the summarize window alone — the two knobs are independent", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");

    setSetting(MEETING_ENHANCE_TIMEOUT_SETTING_KEY, "120");
    await resolveDefaultChatCall({
      system: "You summarize meetings.",
      prompt: "Speaker 1: hello",
      maxOutputTokens: 4096,
      taskId: "meetingSummarize",
    });
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
