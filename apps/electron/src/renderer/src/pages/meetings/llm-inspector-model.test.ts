import type {
  LlmLinkInfo,
  LlmParamsLedger,
  LlmRunInfo,
  LlmStepInfo,
} from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import {
  errorTextKey,
  failureCall,
  failureEntries,
  finishText,
  groupLedger,
  isAdvancedMode,
  isCurrentLink,
  isModelMismatch,
  linkBadgeKey,
  missingCalls,
  producingCall,
  reduceNeedsDetail,
  stepLabel,
  verdictTextKey,
} from "./llm-inspector-model";

function link(over: Partial<LlmLinkInfo> = {}): LlmLinkInfo {
  return {
    id: 1,
    callId: 10,
    targetType: "segment",
    targetId: "seg-1",
    outcome: "applied",
    reason: null,
    appliedText: "Hello there.",
    verdict: null,
    staleLabels: false,
    ...over,
  };
}

function step(over: Partial<LlmStepInfo>): LlmStepInfo {
  return {
    key: "chunk:0",
    node: "correctChunk",
    status: "succeeded",
    seq: 1,
    attempts: 1,
    recordedCalls: 1,
    errorKind: null,
    errorDetail: null,
    startedAt: 1,
    finishedAt: 2,
    ...over,
  };
}

function run(over: Partial<LlmRunInfo>): LlmRunInfo {
  return {
    id: "run-1",
    scope: "meeting",
    scopeId: "m1",
    kind: "enhance",
    startedBy: "button",
    resumeCount: 0,
    status: "succeeded",
    graphVersion: 1,
    startedAt: 100,
    finishedAt: 200,
    errorKind: null,
    errorDetail: null,
    callCount: 0,
    failedCallCount: 0,
    llmStepCount: 0,
    failedStepCount: 0,
    correctedCount: null,
    droppedCount: null,
    suggestionCount: null,
    lostRecords: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    steps: [],
    ...over,
  };
}

describe("isAdvancedMode", () => {
  it('is true only for the text "true"', () => {
    expect(isAdvancedMode("true")).toBe(true);
    expect(isAdvancedMode("false")).toBe(false);
    expect(isAdvancedMode(undefined)).toBe(false);
    expect(isAdvancedMode(null)).toBe(false);
    expect(isAdvancedMode("")).toBe(false);
    expect(isAdvancedMode("TRUE")).toBe(false);
    expect(isAdvancedMode("1")).toBe(false);
    expect(isAdvancedMode("garbage")).toBe(false);
  });
});

describe("errorTextKey", () => {
  it("maps a known kind to its key", () => {
    expect(errorTextKey("length")).toBe("meetings.llmError.length");
    expect(errorTextKey("provider_timeout")).toBe(
      "meetings.llmError.provider_timeout",
    );
  });

  it("falls back to unknown for a kind with no text", () => {
    expect(errorTextKey("brand_new_kind")).toBe("meetings.llmError.unknown");
    expect(errorTextKey(null)).toBe("meetings.llmError.unknown");
    expect(errorTextKey(undefined)).toBe("meetings.llmError.unknown");
  });
});

describe("verdictTextKey", () => {
  it("builds the verdict key", () => {
    expect(verdictTextKey("conflict_lost")).toBe(
      "meetings.inspector.verdict.conflict_lost",
    );
  });
});

describe("verdictTextKey fallback", () => {
  it("maps an unknown or empty code to the unknown text", () => {
    expect(verdictTextKey("made_up")).toBe(
      "meetings.inspector.verdict.unknown",
    );
    expect(verdictTextKey("")).toBe("meetings.inspector.verdict.unknown");
  });
});

describe("linkBadgeKey", () => {
  it("gives Kept, Dropped, or no badge", () => {
    expect(linkBadgeKey("applied")).toBe("meetings.inspector.kept");
    expect(linkBadgeKey("dropped")).toBe("meetings.inspector.dropped");
    expect(linkBadgeKey("unknown")).toBeNull();
  });
});

describe("groupLedger", () => {
  const ledger: LlmParamsLedger = {
    topLevel: {
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_schema" },
    },
    extraBody: { chat_template_kwargs: { enable_thinking: false }, top_k: 20 },
    dropped: [{ name: "top_p", value: 0.9, reason: "not_supported" }],
    source: { mode: "preset", presetId: "p1" },
    capturedFrom: "wire",
    warnings: ["one line"],
    structuredMode: "json_schema_strict",
  };

  it("keeps request fields under their top-level names", () => {
    const view = groupLedger(ledger);
    expect(view?.topLevel.map((r) => r.name)).toEqual([
      "temperature",
      "max_tokens",
      "response_format",
    ]);
    expect(view?.topLevel[0]).toEqual({ name: "temperature", value: "0" });
    expect(view?.topLevel[2].value).toBe('{"type":"json_schema"}');
  });

  it("flattens extra body fields to dotted names", () => {
    expect(groupLedger(ledger)?.extraBody).toEqual([
      { name: "chat_template_kwargs.enable_thinking", value: "false" },
      { name: "top_k", value: "20" },
    ]);
  });

  it("lists dropped fields with their reason and keeps source and warnings", () => {
    const view = groupLedger(ledger);
    expect(view?.dropped).toEqual([
      { name: "top_p", value: "0.9", reason: "not_supported" },
    ]);
    expect(view?.source).toEqual({ mode: "preset", presetId: "p1" });
    expect(view?.warnings).toEqual(["one line"]);
    expect(view?.structuredMode).toBe("json_schema_strict");
  });

  it("returns null when the ledger did not parse", () => {
    expect(groupLedger(null)).toBeNull();
    expect(groupLedger(undefined)).toBeNull();
  });

  it("reads a ledger with missing groups as empty", () => {
    const view = groupLedger({
      source: { mode: "auto" },
      capturedFrom: "sdk_request",
      structuredMode: "prompt_only",
    } as unknown as LlmParamsLedger);
    expect(view?.topLevel).toEqual([]);
    expect(view?.extraBody).toEqual([]);
    expect(view?.dropped).toEqual([]);
    expect(view?.warnings).toEqual([]);
  });
});

describe("isCurrentLink", () => {
  it("marks an applied link whose text equals the suggestion", () => {
    expect(isCurrentLink(link({ appliedText: "Ana" }), "Ana")).toBe(true);
  });

  it("does not mark a different name, a dropped link or no suggestion", () => {
    expect(isCurrentLink(link({ appliedText: "Ana" }), "Bob")).toBe(false);
    expect(
      isCurrentLink(link({ outcome: "dropped", appliedText: "Ana" }), "Ana"),
    ).toBe(false);
    expect(isCurrentLink(link({ appliedText: "Ana" }), null)).toBe(false);
    expect(isCurrentLink(link({ appliedText: null }), null)).toBe(false);
  });
});

describe("producingCall", () => {
  it("returns the call with an applied link to the segment", () => {
    const calls = [
      { id: 1, links: [link({ targetId: "other" })] },
      { id: 2, links: [link({ targetId: "seg-1" })] },
    ];
    expect(producingCall(calls, "seg-1")?.id).toBe(2);
  });

  it("returns null for a dropped link or no call", () => {
    expect(
      producingCall([{ links: [link({ outcome: "dropped" })] }], "seg-1"),
    ).toBeNull();
    expect(producingCall([], "seg-1")).toBeNull();
  });
});

describe("stepLabel", () => {
  it("labels the summary steps", () => {
    expect(stepLabel("single")).toEqual({ kind: "single" });
    expect(stepLabel("map:0")).toEqual({ kind: "map", n: 1 });
    expect(stepLabel("map:2")).toEqual({ kind: "map", n: 3 });
    expect(stepLabel("reduce:0:0")).toEqual({
      kind: "reduce",
      level: 1,
      group: 1,
    });
  });

  it("reads a half as a part of its step", () => {
    expect(stepLabel("map:2/0")).toEqual({ kind: "map", n: 3 });
    expect(stepLabel("chunk:3/1")).toEqual({ kind: "chunk", n: 4 });
  });

  it("counts chunks from 1 and keeps other keys", () => {
    expect(stepLabel("chunk:0")).toEqual({ kind: "chunk", n: 1 });
    expect(stepLabel("candidates")).toEqual({
      kind: "other",
      key: "candidates",
    });
  });
});

describe("reduceNeedsDetail", () => {
  it("is false for one reduce step and true for several", () => {
    expect(reduceNeedsDetail(["map:0", "map:1", "reduce:0:0"])).toBe(false);
    expect(reduceNeedsDetail(["reduce:0:0", "reduce:0:0"])).toBe(false);
    expect(reduceNeedsDetail(["reduce:0:0", "reduce:0:1", "reduce:1:0"])).toBe(
      true,
    );
  });
});

describe("failureEntries", () => {
  it("lists the bad steps of the newest run of each kind in start order", () => {
    const old = run({
      id: "old",
      startedAt: 10,
      steps: [step({ key: "chunk:0", status: "failed", seq: 1 })],
    });
    const newEnhance = run({
      id: "new",
      startedAt: 50,
      steps: [
        step({ key: "chunk:1", status: "failed", seq: 3 }),
        step({ key: "chunk:0", status: "succeeded", seq: 2 }),
        step({ key: "identify", status: "partial", seq: 4 }),
        step({ key: "save", status: "interrupted", seq: 5 }),
      ],
    });
    const summarize = run({
      id: "sum",
      kind: "summarize",
      startedAt: 40,
      steps: [step({ key: "single", node: "summarize", status: "failed" })],
    });
    const entries = failureEntries([newEnhance, summarize, old]);
    expect(entries.map((e) => `${e.run.id}:${e.step.key}`)).toEqual([
      "new:chunk:1",
      "new:identify",
      "new:save",
      "sum:single",
    ]);
  });

  it("returns nothing when no step failed", () => {
    expect(failureEntries([run({ steps: [step({})] })])).toEqual([]);
    expect(failureEntries([])).toEqual([]);
  });
});

describe("failureCall", () => {
  it("returns the last attempt of a plain step", () => {
    const calls = [
      { stepKey: "chunk:3", errorKind: "length", id: 1 },
      { stepKey: "chunk:3", errorKind: "schema", id: 2 },
    ];
    expect(failureCall(calls)?.id).toBe(2);
  });

  it("returns the last attempt of the first failed half", () => {
    const calls = [
      { stepKey: "chunk:3/0", errorKind: null, id: 1 },
      { stepKey: "chunk:3/1", errorKind: "length", id: 2 },
      { stepKey: "chunk:3/1", errorKind: "schema", id: 3 },
      { stepKey: "chunk:3/2", errorKind: "length", id: 4 },
    ];
    expect(failureCall(calls)?.id).toBe(3);
  });

  it("skips a half that a retry fixed", () => {
    const calls = [
      { stepKey: "chunk:3/0", errorKind: "length", id: 1 },
      { stepKey: "chunk:3/0", errorKind: null, id: 2 },
      { stepKey: "chunk:3/1", errorKind: "schema", id: 3 },
    ];
    expect(failureCall(calls)?.id).toBe(3);
  });

  it("returns null for a step with no call row", () => {
    expect(failureCall([])).toBeNull();
  });
});

describe("missingCalls, finishText, isModelMismatch", () => {
  it("counts calls that left no record", () => {
    expect(missingCalls({ attempts: 3, recordedCalls: 1 })).toBe(2);
    expect(missingCalls({ attempts: 1, recordedCalls: 1 })).toBe(0);
    expect(missingCalls({ attempts: 1, recordedCalls: 2 })).toBe(0);
  });

  it("shows the raw finish reason only when it differs", () => {
    expect(finishText({ finishUnified: "stop", finishRaw: "stop" })).toBe(
      "stop",
    );
    expect(
      finishText({ finishUnified: "length", finishRaw: "max_tokens" }),
    ).toBe("length (max_tokens)");
    expect(finishText({ finishUnified: null, finishRaw: "eos" })).toBe("eos");
    expect(finishText({ finishUnified: null, finishRaw: null })).toBeNull();
  });

  it("flags a served model that differs from the requested model", () => {
    expect(isModelMismatch({ requestedModel: "a", servedModel: "b" })).toBe(
      true,
    );
    expect(isModelMismatch({ requestedModel: "a", servedModel: "a" })).toBe(
      false,
    );
    expect(isModelMismatch({ requestedModel: "a", servedModel: null })).toBe(
      false,
    );
  });
});
