// GR24 (b): the Enhance start chains into Summarize in the same run
// (specs/meeting-enhance-agentic.md 10.8). It needs the real `summarize` body
// of WP6, so the file skips while the node is the WP5a stub. It runs on the
// candidate branch and after the rebase on the WP6 merge (11.7).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { SUMMARIZE_IS_STUB } from "../src/lib/meetings/workflow/nodes/summarize.js";
import { startRun } from "../src/lib/meetings/workflow/runner.js";
import { okReply, reply } from "./helpers/fake-model.js";
import {
  correctionText,
  defaultAnswer,
  runnerHarness,
  runRow,
  runsOf,
  stepsOf,
  waitForNoJob,
} from "./helpers/runner-helpers.js";
import {
  type RecordedRequest,
  resetWorkflowTables,
  seedFixtureMeeting,
  seedTestModel,
  sizeFixtureSegments,
} from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const BOTH = ["enhance", "summarize"] as ("enhance" | "summarize")[];
const isSummary = (r: RecordedRequest) =>
  r.system.startsWith("You summarize meeting transcripts");

const SUMMARY = {
  overview: "The team reviewed the rollout plan.",
  keyPoints: ["The rollout plan needs one more review."],
  decisions: [],
  actionItems: [{ task: "Send the draft", owner: null, due: "tomorrow" }],
  openQuestions: [],
};

function seedMeeting(chunks: number) {
  const f = seedFixtureMeeting({
    chunks,
    speakers: 1,
    meetingId: "m-chain",
  });
  sizeFixtureSegments(getDb(), f, 300);
  return f;
}

beforeEach(() => {
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(SUMMARIZE_IS_STUB)(
  "GR24 (b): the chain with the real summarize",
  () => {
    it("one run, one summary row: the summary reads the enhanced_text this run saved", async () => {
      const f = seedMeeting(2);
      const h = runnerHarness({
        answer: (r) =>
          isSummary(r) ? okReply(JSON.stringify(SUMMARY)) : defaultAnswer(r),
      });
      const started = startRun(
        { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
        h.deps,
      );
      if (!started.ok) throw new Error("start failed");
      await waitForNoJob(f.meeting.id);

      expect(runsOf(f.meeting.id)).toHaveLength(1);
      expect(runRow(started.runId).status).toBe("succeeded");
      // The Enhance steps end before the Summarize step starts.
      const steps = stepsOf(started.runId);
      const summaryStep = steps.find((s) => s.node === "summarize");
      expect(summaryStep?.step_key).toBe("single");
      for (const s of steps.filter(
        (x) => x.node !== "summarize" && x.step_key !== "save",
      )) {
        expect(s.seq).toBeLessThan(summaryStep?.seq ?? 0);
      }
      // The summary prompt shows the corrections of this run, not the raw text.
      const summaryRequest = h.requests.find(isSummary);
      for (const chunk of f.segmentIdsByChunk) {
        expect(summaryRequest?.user).toContain(
          correctionText(chunk[0] as string),
        );
      }
      const rows = getDb()
        .prepare(
          "SELECT json_valid(summary_json) AS ok, markdown FROM meeting_summaries WHERE meeting_id = ?",
        )
        .all(f.meeting.id) as { ok: number; markdown: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ok).toBe(1);
      expect(rows[0]?.markdown).toContain(
        "The team reviewed the rollout plan.",
      );
      expect(
        (
          getDb()
            .prepare("SELECT status FROM meetings WHERE id = ?")
            .get(f.meeting.id) as { status: string }
        ).status,
      ).toBe("summarized");
    });

    it("a failed summary step leaves the Enhance results saved and ends the run partial", async () => {
      const f = seedMeeting(2);
      const h = runnerHarness({
        answer: (r) =>
          isSummary(r)
            ? reply("content-filter", "content_filter", "")
            : defaultAnswer(r),
      });
      const started = startRun(
        { meetingId: f.meeting.id, stages: BOTH, trigger: "button" },
        h.deps,
      );
      if (!started.ok) throw new Error("start failed");
      await waitForNoJob(f.meeting.id);

      expect(runRow(started.runId).status).toBe("partial");
      const enhanced = getDb()
        .prepare(
          "SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = ? AND enhanced_text IS NOT NULL",
        )
        .get(f.meeting.id) as { n: number };
      expect(enhanced.n).toBe(2);
      expect(
        (
          getDb()
            .prepare(
              "SELECT count(*) AS n FROM meeting_summaries WHERE meeting_id = ?",
            )
            .get(f.meeting.id) as { n: number }
        ).n,
      ).toBe(0);
      const failed = stepsOf(started.runId).find((s) => s.node === "summarize");
      expect(failed?.status).toBe("failed");
      expect(failed?.error_kind).toBe("content_filter");
    });
  },
);
