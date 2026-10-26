// The context guard before the send (specs/llm-runtime-tuning.md 9 item 5)
// in a real graph run. CJK text has about 4 times more tokens than the old
// `chars / 4` plan expects, so a chunk that the plan accepts can be too long
// for the window. The gateway stops it before the send and the length route
// splits it. The real graph, gateway and saver run over a scripted model; a
// test seam sets the context window of the profiles. Fictional text only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { estimateCallTokens } from "../src/lib/llm/token-budget.js";
import { okReply } from "./helpers/fake-model.js";
import {
  makeFakeRecorder,
  makeTestDeps,
  makeTestRunContext,
  type RecordedRequest,
  resetWorkflowTables,
  runScriptedGraph,
  seedFixtureMeeting,
  seedTestModel,
} from "./helpers/workflow-harness.js";

let windowTokens: number | null = null;

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/lib/llm/model-profiles.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/lib/llm/model-profiles.js")>();
  return {
    ...real,
    resolveModels: async (a: Parameters<typeof real.resolveModels>[0]) => {
      const models = await real.resolveModels(a);
      for (const p of Object.values(models)) p.contextWindow = windowTokens;
      return models;
    },
  };
});

const NONE = okReply('{"corrections":[]}');
const CJK =
  "我们在三月十四日发布测试版，塔科马的仓库还有两千四百个旧适配器，需要召回预算。";

function cjkMeeting(id: string) {
  const f = seedFixtureMeeting({ chunks: 1, speakers: 1, meetingId: id });
  const update = getDb().prepare(
    "UPDATE meeting_segments SET text = ? WHERE id = ?",
  );
  // Each segment gets other text: the merge drops repeated lines.
  f.segments.forEach((s, i) => {
    const turn = CJK.slice(i * 5) + CJK.slice(0, i * 5);
    update.run(`第${i}段。${turn.repeat(8)}`, s.id);
  });
  return f;
}

async function run(id: string) {
  const recorder = makeFakeRecorder();
  const ctx = makeTestRunContext({ meetingId: id });
  const { deps } = makeTestDeps({ recorder });
  const out = await runScriptedGraph({
    deps,
    meetingId: id,
    stages: ["enhance"],
    script: () => NONE,
    ctx,
  });
  return { ...out, recorder, ctx };
}

const cost = (r: RecordedRequest) =>
  estimateCallTokens({
    instructions: r.system,
    messages: [{ content: r.user }],
  }) + (r.maxOutputTokens ?? 0);

beforeEach(() => {
  windowTokens = null;
  resetWorkflowTables();
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  seedTestModel();
});

describe("the context guard in a graph run", () => {
  it("CB-W1: with a window that holds the chunk, the requests are the same as with no window", async () => {
    const a = await run(cjkMeeting("m-cbw1a").meeting.id);
    resetWorkflowTables();
    windowTokens = 32_768;
    const b = await run(cjkMeeting("m-cbw1a").meeting.id);
    // One correctChunk call, and one retranscribeLines call: the CJK lines
    // are not in the pinned meeting language "en".
    expect(a.requests).toHaveLength(2);
    expect(b.requests).toEqual(a.requests);
  });

  it("CB-W2: a chunk over the window is not sent; its halves are sent and fit", async () => {
    const free = await run(cjkMeeting("m-cbw2a").meeting.id);
    const whole = free.requests[0] as RecordedRequest;
    resetWorkflowTables();
    // One token less than the whole chunk needs.
    windowTokens = cost(whole) - 1;
    const r = await run(cjkMeeting("m-cbw2a").meeting.id);
    // The whole chunk was never sent: no record, no lost record.
    const chunkCalls = r.recorder.calls.filter(
      (c) => c.node === "correctChunk",
    );
    expect(chunkCalls.map((c) => c.unitKey)).toEqual([
      "chunk:0/0",
      "chunk:0/1",
    ]);
    expect(r.ctx.lostRecords).toBe(0);
    for (const req of r.requests) {
      expect(cost(req)).toBeLessThanOrEqual(windowTokens);
    }
    expect(r.finalState.corrections[0]?.status).toBe("ok");
    expect(r.finalState.corrections[0]?.units.map((u) => u.status)).toEqual([
      "ok",
      "ok",
    ]);
  });
});
