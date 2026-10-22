import type {
  LlmRunInfo,
  LlmRunStatus,
  LlmStepInfo,
  LlmStepStatus,
} from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import en from "../../locales/en.json";
import {
  chunkNumber,
  enhanceNoteOf,
  formatChunkList,
  isSummarizeCancelled,
  llmErrorKey,
  nodeLabelKey,
  noticeLines,
  noticeTextKey,
  runNotice,
  SKIP_REASONS,
  skipReasonKey,
} from "./run-notice";

function step(
  key: string,
  status: LlmStepStatus,
  errorKind: string | null,
  seq: number,
  node = key.startsWith("chunk") ? "correctChunk" : "summarize",
): LlmStepInfo {
  return {
    key,
    node,
    status,
    seq,
    attempts: 1,
    recordedCalls: 1,
    errorKind,
    errorDetail: null,
    skipReason: null,
    startedAt: 1,
    finishedAt: 2,
  };
}

function run(over: Partial<LlmRunInfo> = {}): LlmRunInfo {
  return {
    id: "run-1",
    scope: "meeting",
    scopeId: "m1",
    kind: "enhance",
    startedBy: "button",
    resumeCount: 0,
    status: "failed",
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

describe("chunkNumber", () => {
  it("counts from 1 for a person (the key counts from 0)", () => {
    expect(chunkNumber("chunk:0")).toBe(1);
    expect(chunkNumber("chunk:3")).toBe(4);
  });
  it("reads a half as its chunk", () => {
    expect(chunkNumber("chunk:3/0")).toBe(4);
    expect(chunkNumber("chunk:3/0/1")).toBe(4);
  });
  it("returns null for a step that is not a chunk", () => {
    expect(chunkNumber("candidates")).toBeNull();
    expect(chunkNumber("map:2")).toBeNull();
    expect(chunkNumber("chunk:x")).toBeNull();
  });
});

describe("formatChunkList", () => {
  it("joins the numbers with a comma", () => {
    expect(formatChunkList([4, 7])).toBe("4, 7");
    expect(formatChunkList([2])).toBe("2");
  });
});

describe("llmErrorKey", () => {
  it("names the key of a known kind", () => {
    expect(llmErrorKey("length")).toBe("meetings.llmError.length");
    expect(llmErrorKey("deadline_exceeded")).toBe(
      "meetings.llmError.deadline_exceeded",
    );
  });
  it("falls back to unknown for a kind with no text", () => {
    expect(llmErrorKey("brand_new_kind")).toBe("meetings.llmError.unknown");
    expect(llmErrorKey(null)).toBe("meetings.llmError.unknown");
    expect(llmErrorKey(undefined)).toBe("meetings.llmError.unknown");
  });
});

describe("skipReasonKey (issue #300)", () => {
  /** The en.json text of a dotted key, or undefined. */
  function enText(key: string): unknown {
    return key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object"
            ? (node as Record<string, unknown>)[part]
            : undefined,
        en,
      );
  }

  it("gives every known skip reason its own key with an English text", () => {
    const reasons = Object.keys(SKIP_REASONS);
    expect(reasons.length).toBeGreaterThanOrEqual(9);
    const texts = new Set<string>();
    for (const reason of reasons) {
      const key = skipReasonKey(reason);
      expect(key).toBe(`meetings.skipReason.${reason}`);
      const text = enText(key);
      expect(typeof text, key).toBe("string");
      texts.add(text as string);
    }
    // Each reason has its own text.
    expect(texts.size).toBe(reasons.length);
    expect(skipReasonKey("no_labels")).toBe("meetings.skipReason.no_labels");
    expect(enText("meetings.skipReason.no_labels")).toBe(
      "No speaker turns to name.",
    );
  });

  it("reads a missing or new reason as the neutral other text, never as an unknown error", () => {
    for (const reason of [null, undefined, "", "a_future_reason", "toString"]) {
      const key = skipReasonKey(reason);
      expect(key).toBe("meetings.skipReason.other");
      expect(key).not.toBe(llmErrorKey(null));
    }
    expect(typeof enText("meetings.skipReason.other")).toBe("string");
  });

  it("a skipped step never adds a line to a run notice", () => {
    const lines = noticeLines(
      run({
        status: "partial",
        steps: [
          {
            ...step("candidates", "skipped", null, 1, "identifySpeakers"),
            skipReason: "no_labels",
          },
          step("chunk:0", "failed", "length", 2),
        ],
      }),
    );
    expect(lines).toEqual([
      { node: "correctChunk", chunks: [1], kind: "length" },
    ]);
  });
});

describe("nodeLabelKey and noticeTextKey", () => {
  it("names a node label only for a node that has one", () => {
    expect(nodeLabelKey("correctChunk")).toBe(
      "meetings.llmRun.node.correctChunk",
    );
    expect(nodeLabelKey("verifyEvidence")).toBeNull();
  });
  it("names the headline key of a kind and a status", () => {
    expect(noticeTextKey("summarize", "interrupted")).toBe(
      "meetings.llmRun.summarize.interrupted",
    );
  });
});

describe("noticeLines", () => {
  it("makes one line for each node and error kind, with the chunk numbers", () => {
    const lines = noticeLines(
      run({
        steps: [
          step("chunk:6", "failed", "length", 8),
          step("chunk:3", "failed", "length", 5),
          step("chunk:4", "partial", "content_filter", 6),
          step("chunk:3", "failed", "length", 5),
        ],
      }),
    );
    expect(lines).toEqual([
      { node: "correctChunk", chunks: [4, 7], kind: "length" },
      { node: "correctChunk", chunks: [5], kind: "content_filter" },
    ]);
  });

  it("counts a partial step as failed", () => {
    const lines = noticeLines(
      run({ steps: [step("chunk:1", "partial", "length", 3)] }),
    );
    expect(lines).toEqual([
      { node: "correctChunk", chunks: [2], kind: "length" },
    ]);
  });

  it("ignores steps that did not fail", () => {
    const lines = noticeLines(
      run({
        steps: [
          step("chunk:0", "succeeded", null, 2),
          step("chunk:1", "cancelled", null, 3),
          step("chunk:2", "skipped", null, 4),
          step("chunk:3", "failed", "schema", 5),
        ],
      }),
    );
    expect(lines).toEqual([
      { node: "correctChunk", chunks: [4], kind: "schema" },
    ]);
  });

  it("keeps nodes apart and gives a node with no chunks an empty list", () => {
    const lines = noticeLines(
      run({
        steps: [
          step("chunk:0", "failed", "provider_timeout", 2),
          step(
            "candidates",
            "failed",
            "provider_timeout",
            9,
            "identifySpeakers",
          ),
          step("map:1", "failed", "deadline_exceeded", 11),
          step("map:2", "failed", "deadline_exceeded", 12),
        ],
      }),
    );
    expect(lines).toEqual([
      { node: "correctChunk", chunks: [1], kind: "provider_timeout" },
      { node: "identifySpeakers", chunks: [], kind: "provider_timeout" },
      { node: "summarize", chunks: [], kind: "deadline_exceeded" },
    ]);
  });

  it("reads a step with no error kind as unknown", () => {
    expect(
      noticeLines(run({ steps: [step("chunk:0", "failed", null, 2)] })),
    ).toEqual([{ node: "correctChunk", chunks: [1], kind: "unknown" }]);
  });

  it("falls back to run.errorKind when no step failed", () => {
    expect(noticeLines(run({ errorKind: "budget_exceeded" }))).toEqual([
      { node: null, chunks: [], kind: "budget_exceeded" },
    ]);
  });

  it("gives the unknown line when nothing names the failure", () => {
    expect(noticeLines(run())).toEqual([
      { node: null, chunks: [], kind: "unknown" },
    ]);
  });
});

describe("runNotice", () => {
  it("hides only failed model-unavailable notices when no default LLM exists", () => {
    const failed = run({ status: "failed", errorKind: "model_unavailable" });
    expect(runNotice(failed, false, [], false)).toBeNull();
    expect(runNotice(failed, false, [], true)).not.toBeNull();
    expect(
      runNotice(
        run({ status: "failed", errorKind: "provider_auth" }),
        false,
        [],
        false,
      ),
    ).not.toBeNull();
    expect(
      runNotice(
        run({ status: "interrupted", errorKind: "model_unavailable" }),
        false,
        [],
        false,
      ),
    ).not.toBeNull();
  });
  it("shows a destructive notice with Start again for a failed run", () => {
    const n = runNotice(
      run({
        status: "failed",
        steps: [step("chunk:0", "failed", "length", 2)],
      }),
      false,
    );
    expect(n).toMatchObject({
      runId: "run-1",
      kind: "enhance",
      status: "failed",
      tone: "destructive",
      canResume: false,
      startAgainDiscards: false,
    });
    expect(n?.lines).toHaveLength(1);
  });

  it("takes the counts of a partial run from the server fields", () => {
    const n = runNotice(
      run({
        status: "partial",
        llmStepCount: 6,
        failedStepCount: 2,
        // Only one failed step in the list: the counts must not come from it.
        steps: [step("chunk:2", "failed", "length", 4)],
      }),
      false,
    );
    expect(n).toMatchObject({
      status: "partial",
      tone: "destructive",
      failedSteps: 2,
      totalSteps: 6,
      canResume: false,
    });
  });

  it("shows a neutral notice with Resume and a discarding Start again for an interrupted run", () => {
    const n = runNotice(run({ status: "interrupted" }), false);
    expect(n).toMatchObject({
      status: "interrupted",
      tone: "neutral",
      canResume: true,
      startAgainDiscards: true,
      lines: [],
    });
  });

  it("lists the line of an interrupted run that has a failure", () => {
    const n = runNotice(
      run({ status: "interrupted", errorKind: "internal" }),
      false,
    );
    expect(n?.lines).toEqual([{ node: null, chunks: [], kind: "internal" }]);
  });

  it("shows the errorKind line of a run that a resume guard failed", () => {
    for (const kind of ["graph_changed", "transcript_changed"]) {
      const n = runNotice(
        run({ kind: "summarize", status: "failed", errorKind: kind }),
        false,
      );
      expect(n?.lines).toEqual([{ node: null, chunks: [], kind }]);
      expect(n?.canResume).toBe(false);
    }
  });

  it("shows no notice for the other statuses", () => {
    const others: LlmRunStatus[] = [
      "running",
      "succeeded",
      "cancelled",
      "unknown",
    ];
    for (const status of others) {
      expect(runNotice(run({ status }), false)).toBeNull();
    }
  });

  it("shows no notice while a job holds the slot, or without a run", () => {
    expect(runNotice(run({ status: "failed" }), true)).toBeNull();
    expect(runNotice(undefined, false)).toBeNull();
  });
});

describe("enhanceNoteOf", () => {
  const done = run({
    status: "succeeded",
    finishedAt: 500,
    correctedCount: 3,
  });

  it("gives the corrected count of a run that ended after the page opened", () => {
    expect(enhanceNoteOf(done, false, 400)).toEqual({
      key: "enhanceResult",
      n: 3,
    });
    expect(
      enhanceNoteOf(run({ ...done, status: "partial" }), false, 400),
    ).toEqual({ key: "enhanceResult", n: 3 });
  });

  it("says no segment needed correction only when the model suggested nothing", () => {
    const none = { key: "enhanceNoneCorrected", n: 0 };
    expect(
      enhanceNoteOf(run({ ...done, correctedCount: 0 }), false, 400),
    ).toEqual(none);
    expect(
      enhanceNoteOf(
        run({ ...done, correctedCount: 0, droppedCount: 0 }),
        false,
        400,
      ),
    ).toEqual(none);
  });

  it("says the checks dropped every suggestion when nothing applied but entries came back", () => {
    expect(
      enhanceNoteOf(
        run({ ...done, correctedCount: 0, droppedCount: 5 }),
        false,
        400,
      ),
    ).toEqual({ key: "enhanceAllDropped", n: 5 });
    // An applied correction wins over dropped ones.
    expect(
      enhanceNoteOf(run({ ...done, droppedCount: 5 }), false, 400),
    ).toEqual({ key: "enhanceResult", n: 3 });
  });

  it("gives null for a run that ended before the page opened", () => {
    expect(enhanceNoteOf(done, false, 500)).toBeNull();
    expect(enhanceNoteOf(done, false, 900)).toBeNull();
  });

  it("gives null for a failed run, a Summarize run, a busy slot or no count", () => {
    expect(
      enhanceNoteOf(run({ ...done, status: "failed" }), false, 400),
    ).toBeNull();
    expect(
      enhanceNoteOf(run({ ...done, kind: "summarize" }), false, 400),
    ).toBeNull();
    expect(enhanceNoteOf(done, true, 400)).toBeNull();
    expect(
      enhanceNoteOf(run({ ...done, correctedCount: null }), false, 400),
    ).toBeNull();
    expect(
      enhanceNoteOf(run({ ...done, finishedAt: null }), false, 400),
    ).toBeNull();
    expect(enhanceNoteOf(undefined, false, 400)).toBeNull();
  });
});

describe("isSummarizeCancelled", () => {
  it("is true for a cancelled Summarize run with a free slot", () => {
    const r = run({ kind: "summarize", status: "cancelled" });
    expect(isSummarizeCancelled(r, false)).toBe(true);
    expect(isSummarizeCancelled(r, true)).toBe(false);
  });
  it("is false for an Enhance run or another status", () => {
    expect(
      isSummarizeCancelled(
        run({ kind: "enhance", status: "cancelled" }),
        false,
      ),
    ).toBe(false);
    expect(
      isSummarizeCancelled(run({ kind: "summarize", status: "failed" }), false),
    ).toBe(false);
    expect(isSummarizeCancelled(undefined, false)).toBe(false);
  });
});

describe("a Summarize notice after a newer chained run", () => {
  const oldSummarize = (status: LlmRunStatus) =>
    run({ id: "s1", kind: "summarize", status, startedAt: 100 });
  const chained = (startedAt: number) =>
    run({
      id: "e1",
      kind: "enhance",
      status: "succeeded",
      startedAt,
      steps: [step("summarize", "succeeded", null, 1)],
    });

  it("hides the failed notice when a newer Enhance run has a Summarize step", () => {
    const s = oldSummarize("failed");
    expect(runNotice(s, false, [chained(300), s])).toBeNull();
    expect(runNotice(s, false, [s])).not.toBeNull();
  });
  it("hides the cancelled note the same way", () => {
    const s = oldSummarize("cancelled");
    expect(isSummarizeCancelled(s, false, [chained(300), s])).toBe(false);
    expect(isSummarizeCancelled(s, false, [s])).toBe(true);
  });
  it("keeps the notice when the other run is older or has no Summarize step", () => {
    const s = oldSummarize("failed");
    expect(runNotice(s, false, [chained(50), s])).not.toBeNull();
    const noSummary = run({ id: "e2", startedAt: 300, steps: [] });
    expect(runNotice(s, false, [noSummary, s])).not.toBeNull();
  });
});
