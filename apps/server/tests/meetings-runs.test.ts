import type {
  LlmCallsResponse,
  LlmRunListResponse,
} from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import type { CallRecord } from "../src/lib/llm/call-record.js";
import { createLlmRecorder } from "../src/lib/llm/recorder.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";

// The two read routes of the LLM call record (specs/meeting-enhance-agentic.md
// 8.3; checks 2, 4 and 9 of 10.9). Real server code on a real database file.

const app = createApp();
const SENTINEL = "SENTINEL-PROMPT-7f3a";

function insertMeeting(id: string): void {
  getDb()
    .prepare(
      "INSERT INTO meetings (id, title, status, created_at) VALUES (?, 'Test meeting', 'transcribed', ?)",
    )
    .run(id, Date.now());
}

beforeEach(() => {
  insertMeeting("m1");
});

afterEach(() => {
  resetMeetingTables();
  // Runs of scope "test" have no meeting_id, so a meeting delete leaves them.
  getDb().exec("DELETE FROM llm_runs");
});

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

const recorder = () => createLlmRecorder(getDb());

function startRun(
  id: string,
  scopeId = "m1",
  kind: "enhance" | "summarize" = "enhance",
  startedAt = 1000,
): void {
  const scope = scopeId === "sandbox" ? "test" : "meeting";
  expect(
    recorder().startRun({
      id,
      scope,
      scopeId,
      kind,
      startedBy: "button",
      graphVersion: 1,
      startedAt,
    }),
  ).toBe("ok");
}

function step(
  runId: string,
  key: string,
  node: string,
  status: "succeeded" | "failed" | "partial",
): void {
  const rec = recorder();
  rec.startStep(runId, { key, node });
  rec.finishStep(
    runId,
    key,
    status,
    status === "succeeded" ? undefined : { kind: "length", detail: "cut" },
  );
}

function call(runId: string, over: Partial<CallRecord> = {}): number {
  const recorded = recorder().recordCall({
    runId,
    unitKey: "chunk:0",
    node: "correctChunk",
    retryReason: null,
    provider: "server",
    modelRequested: "Qwen3.8-27B",
    modelServed: "Qwen3.8-27B",
    instructions: SENTINEL,
    messages: [{ role: "user", content: "hello wrld" }],
    schema: { name: "corrections", version: 1, json: { type: "object" } },
    params: {
      topLevel: { temperature: 0.2 },
      extraBody: {},
      dropped: [],
      source: { mode: "auto" },
      capturedFrom: "wire",
      warnings: [],
      structuredMode: "json_schema",
    },
    rawText: `${SENTINEL} raw`,
    parsed: { corrections: [] },
    reasoningChars: 0,
    finishUnified: "stop",
    finishRaw: "stop",
    usage: { input: 10, output: 5, reasoning: 0, cached: 0 },
    queuedMs: 1,
    latencyMs: 20,
    errorKind: null,
    errorDetail: null,
    startedAt: 2000,
    finishedAt: 2020,
    ...over,
  });
  expect(recorded).not.toBeNull();
  return recorded?.id as number;
}

function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe("GET /api/meetings/:id/llm-runs and llm-calls: empty record", () => {
  it("answers an empty list when no run exists (no server gate on advanced_mode)", async () => {
    const runs = await getJson<LlmRunListResponse>("/api/meetings/m1/llm-runs");
    expect(runs).toEqual({ status: 200, body: { runs: [] } });
    const latest = await getJson<LlmRunListResponse>(
      "/api/meetings/m1/llm-runs?latest=1",
    );
    expect(latest.body.runs).toEqual([]);
    const calls = await getJson<{ calls: unknown[] }>(
      "/api/meetings/m1/llm-calls",
    );
    expect(calls.status).toBe(200);
    expect(calls.body.calls).toEqual([]);
  });

  it("answers 404 for an unknown meeting and for an unknown run id", async () => {
    expect((await app.request("/api/meetings/nope/llm-runs")).status).toBe(404);
    expect((await app.request("/api/meetings/nope/llm-calls")).status).toBe(
      404,
    );
    expect(
      (await app.request("/api/meetings/m1/llm-runs?run_id=nope")).status,
    ).toBe(404);
  });
});

describe("step counts (check 9)", () => {
  function seedSteps(): void {
    startRun("r1");
    step("r1", "prepare", "prepare", "succeeded");
    step("r1", "chunk:0", "correctChunk", "succeeded");
    step("r1", "chunk:1", "correctChunk", "succeeded");
    step("r1", "chunk:2", "correctChunk", "failed");
    step("r1", "chunk:3", "correctChunk", "partial");
    step("r1", "candidates", "identifySpeakers", "succeeded");
    step("r1", "verify", "verify", "succeeded");
    step("r1", "save", "save", "succeeded");
  }

  it("latest=1 counts 5 LLM steps and 2 failed, and lists only the failed ones", async () => {
    seedSteps();
    const { status, body } = await getJson<LlmRunListResponse>(
      "/api/meetings/m1/llm-runs?latest=1",
    );
    expect(status).toBe(200);
    expect(body.runs).toHaveLength(1);
    const run = body.runs[0];
    expect(run).toMatchObject({
      id: "r1",
      scope: "meeting",
      scopeId: "m1",
      kind: "enhance",
      llmStepCount: 5,
      failedStepCount: 2,
    });
    expect(run?.steps.map((s) => s.key)).toEqual(["chunk:2", "chunk:3"]);
  });

  it("the run read with run_id gives the same counts and all steps in seq order", async () => {
    seedSteps();
    const { body } = await getJson<LlmRunListResponse>(
      "/api/meetings/m1/llm-runs?run_id=r1",
    );
    const run = body.runs[0];
    expect(run).toMatchObject({ llmStepCount: 5, failedStepCount: 2 });
    expect(run?.steps.map((s) => [s.key, s.seq])).toEqual([
      ["prepare", 1],
      ["chunk:0", 2],
      ["chunk:1", 3],
      ["chunk:2", 4],
      ["chunk:3", 5],
      ["candidates", 6],
      ["verify", 7],
      ["save", 8],
    ]);
    const list = await getJson<LlmRunListResponse>("/api/meetings/m1/llm-runs");
    expect(list.body.runs[0]).toMatchObject({
      llmStepCount: 5,
      failedStepCount: 2,
    });
    expect(list.body.runs[0]?.steps.map((s) => s.key)).toEqual([
      "chunk:2",
      "chunk:3",
    ]);
  });

  it("matches the two count queries read back with SQL", () => {
    seedSteps();
    const db = getDb();
    const total = db
      .prepare(
        "SELECT count(*) AS c FROM llm_run_steps WHERE run_id = 'r1' AND node IN ('correctChunk','identifySpeakers','summarize')",
      )
      .get() as { c: number };
    const failed = db
      .prepare(
        "SELECT count(*) AS c FROM llm_run_steps WHERE run_id = 'r1' AND node IN ('correctChunk','identifySpeakers','summarize') AND status IN ('failed','partial')",
      )
      .get() as { c: number };
    expect([total.c, failed.c]).toEqual([5, 2]);
  });

  it("a run with no step row returns 0 and 0", async () => {
    startRun("r0");
    const { body } = await getJson<LlmRunListResponse>(
      "/api/meetings/m1/llm-runs?run_id=r0",
    );
    expect(body.runs[0]).toMatchObject({
      llmStepCount: 0,
      failedStepCount: 0,
      steps: [],
    });
  });

  it("latest=1 gives the newest run of each kind", async () => {
    startRun("old-enhance", "m1", "enhance", 1000);
    startRun("new-enhance", "m1", "enhance", 3000);
    startRun("sum", "m1", "summarize", 2000);
    const { body } = await getJson<LlmRunListResponse>(
      "/api/meetings/m1/llm-runs?latest=1",
    );
    expect(body.runs.map((r) => r.id)).toEqual(["new-enhance", "sum"]);
    const list = await getJson<LlmRunListResponse>(
      "/api/meetings/m1/llm-runs?limit=2",
    );
    expect(list.body.runs.map((r) => r.id)).toEqual(["new-enhance", "sum"]);
  });
});

describe("skipped steps (issue #300)", () => {
  it("a skip row reads as a skip reason, never as an unknown error", async () => {
    startRun("r1");
    const rec = recorder();
    const skip = (key: string, node: string, detail: string) => {
      rec.startStep("r1", { key, node });
      rec.finishStep("r1", key, "skipped", { kind: "skipped", detail });
    };
    skip("candidates", "identifySpeakers", "no_labels");
    skip("verify", "verify", "speakers_skipped");
    skip("tags", "suggestTags", "a_future_reason");
    rec.startStep("r1", { key: "chunk:0", node: "correctChunk" });
    rec.finishStep("r1", "chunk:0", "skipped");
    step("r1", "chunk:1", "correctChunk", "failed");
    const { body } = await getJson<LlmRunListResponse>(
      "/api/meetings/m1/llm-runs?run_id=r1",
    );
    const steps = body.runs[0]?.steps ?? [];
    expect(
      steps.map((s) => [s.key, s.status, s.errorKind, s.skipReason]),
    ).toEqual([
      ["candidates", "skipped", null, "no_labels"],
      ["verify", "skipped", null, "speakers_skipped"],
      ["tags", "skipped", null, null],
      ["chunk:0", "skipped", null, null],
      // A real error stays as it was.
      ["chunk:1", "failed", "length", null],
    ]);
    expect(steps[4]?.errorDetail).toBe("cut");
  });
});

describe("no prompt text in meeting routes (check 2)", () => {
  it("a sentinel in messages_json and raw_text is in no meeting route and no llm-runs answer", async () => {
    startRun("r1");
    step("r1", "chunk:0", "correctChunk", "succeeded");
    call("r1");
    const db = getDb();
    const stored = db
      .prepare("SELECT messages_json, raw_text FROM llm_calls")
      .get() as { messages_json: string; raw_text: string };
    expect(stored.messages_json).toContain(SENTINEL);
    expect(stored.raw_text).toContain(SENTINEL);
    for (const path of [
      "/api/meetings",
      "/api/meetings/m1",
      "/api/meetings/m1/llm-runs",
      "/api/meetings/m1/llm-runs?latest=1",
      "/api/meetings/m1/llm-runs?run_id=r1",
      "/api/meetings/m1/llm-calls",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      expect(text, path).not.toContain(SENTINEL);
    }
  });

  it("the read types and answers name no meeting field", async () => {
    startRun("r1");
    step("r1", "chunk:0", "correctChunk", "succeeded");
    const id = call("r1");
    recorder().linkCall(id, [
      {
        targetType: "segment",
        targetId: "m1:system:0",
        seq: 0,
        outcome: "applied",
        reason: null,
        appliedText: "x",
        verdict: null,
      },
    ]);
    const runs = await getJson<unknown>("/api/meetings/m1/llm-runs?run_id=r1");
    const calls = await getJson<unknown>(
      `/api/meetings/m1/llm-calls?call_id=${id}&detail=full`,
    );
    for (const key of [...keysOf(runs.body), ...keysOf(calls.body)]) {
      expect(key).not.toMatch(/meeting/i);
    }
  });
});

describe("GET /api/meetings/:id/llm-calls", () => {
  it("a run of another scope never appears", async () => {
    startRun("rt", "sandbox");
    step("rt", "chunk:0", "correctChunk", "succeeded");
    call("rt");
    startRun("r1");
    const all = await getJson<LlmCallsResponse>("/api/meetings/m1/llm-calls");
    expect(all.body.calls).toEqual([]);
    const byRun = await getJson<LlmCallsResponse>(
      "/api/meetings/m1/llm-calls?run_id=rt",
    );
    expect(byRun.body.calls).toEqual([]);
    const runs = await getJson<LlmRunListResponse>(
      "/api/meetings/m1/llm-runs?run_id=rt",
    );
    expect(runs.status).toBe(404);
  });

  it("returns the summary of a call by call_id, the full call with the system turn first, and attempts", async () => {
    startRun("r1");
    step("r1", "chunk:0", "correctChunk", "failed");
    const first = call("r1", {
      errorKind: "length",
      finishUnified: "length",
      finishRaw: "length",
      parsed: null,
    });
    const second = call("r1", { retryReason: "length" });
    const summary = await getJson<LlmCallsResponse>(
      `/api/meetings/m1/llm-calls?call_id=${second}`,
    );
    expect(summary.body.detail).toBe("summary");
    expect(summary.body.calls[0]).toMatchObject({
      id: second,
      runId: "r1",
      stepKey: "chunk:0",
      attempt: 2,
      retryReason: "length",
      inputTokens: 10,
      links: [],
    });
    const full = await getJson<LlmCallsResponse>(
      `/api/meetings/m1/llm-calls?call_id=${second}&detail=full`,
    );
    expect(full.body.detail).toBe("full");
    const c = full.body.calls[0];
    if (!c || !("messages" in c)) throw new Error("expected a full call");
    expect(c.messages[0]).toEqual({ role: "system", content: SENTINEL });
    expect(c.messages[1]).toEqual({ role: "user", content: "hello wrld" });
    expect(c.rawText).toContain(SENTINEL);
    expect(c.schema).toEqual({
      name: "corrections",
      version: 1,
      json: { type: "object" },
    });
    expect(c.params?.structuredMode).toBe("json_schema");
    expect(c.attempts.map((a) => [a.callId, a.attempt, a.errorKind])).toEqual([
      [first, 1, "length"],
      [second, 2, null],
    ]);
    const byStep = await getJson<LlmCallsResponse>(
      "/api/meetings/m1/llm-calls?run_id=r1&step_key=chunk:0",
    );
    expect(byStep.body.calls.map((x) => x.id)).toEqual([first, second]);
    const failed = await getJson<LlmCallsResponse>(
      "/api/meetings/m1/llm-calls?failed=1",
    );
    expect(failed.body.calls.map((x) => x.id)).toEqual([first]);
    expect(failed.body.calls[0]?.errorKind).toBe("length");
  });

  it("a stored JSON column that does not parse reads as null; an unknown status reads as unknown", async () => {
    startRun("r1");
    step("r1", "chunk:0", "correctChunk", "succeeded");
    const id = call("r1");
    getDb()
      .prepare(
        "UPDATE llm_calls SET params_json = '{bad', parsed_json = '{bad', messages_json = '{bad'",
      )
      .run();
    getDb()
      .prepare("UPDATE llm_runs SET status = 'weird', error_kind = 'new_kind'")
      .run();
    getDb().prepare("UPDATE llm_run_steps SET status = 'weird'").run();
    const full = await getJson<LlmCallsResponse>(
      `/api/meetings/m1/llm-calls?call_id=${id}&detail=full`,
    );
    const c = full.body.calls[0];
    if (!c || !("messages" in c)) throw new Error("expected a full call");
    expect(c.params).toBeNull();
    expect(c.parsed).toBeNull();
    expect(c.messages).toEqual([]);
    const run = await getJson<LlmRunListResponse>(
      "/api/meetings/m1/llm-runs?run_id=r1",
    );
    expect(run.body.runs[0]).toMatchObject({
      status: "unknown",
      errorKind: "unknown",
    });
    expect(run.body.runs[0]?.steps[0]?.status).toBe("unknown");
  });

  it("rejects a mixed selector, a missing target_id, and detail=full without a selector", async () => {
    for (const q of [
      "call_id=1&run_id=r1",
      "call_id=1&failed=1",
      "run_id=r1&target_type=summary",
      "run_id=r1&failed=1",
      "step_key=chunk:0",
      "target_id=x",
      "target_type=segment",
      "target_type=speaker",
      "detail=full",
      "failed=1&detail=full",
      "run_id=r1&detail=full",
      "call_id=1&detail=full&limit=11",
      "limit=51",
      "limit=0",
      "target_type=nope&target_id=x",
    ]) {
      const res = await app.request(`/api/meetings/m1/llm-calls?${q}`);
      expect(res.status, q).toBe(400);
    }
    for (const q of ["latest=1&run_id=r1", "latest=1&limit=3", "limit=51"]) {
      const res = await app.request(`/api/meetings/m1/llm-runs?${q}`);
      expect(res.status, q).toBe(400);
    }
    // Valid selectors still pass.
    for (const q of [
      "target_type=summary",
      "call_id=1",
      "run_id=r1&step_key=x&detail=full",
      "failed=1",
    ]) {
      const res = await app.request(`/api/meetings/m1/llm-calls?${q}`);
      expect(res.status, q).toBe(200);
    }
  });

  describe("targets (7.8)", () => {
    function segment(id: string, enhanced: string | null): void {
      getDb()
        .prepare(
          `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status, enhanced_text)
           VALUES (?, 'm1', 'system', 0, 0, 900, 'raw', 'ok', ?)`,
        )
        .run(id, enhanced);
    }

    it("a segment target returns the call whose applied text is the current enhanced_text", async () => {
      segment("m1:system:0", "fixed text");
      startRun("r1");
      step("r1", "chunk:0", "correctChunk", "succeeded");
      const id = call("r1");
      recorder().linkCall(id, [
        {
          targetType: "segment",
          targetId: "m1:system:0",
          seq: 0,
          outcome: "applied",
          reason: null,
          appliedText: "fixed text",
          verdict: null,
        },
        {
          targetType: "segment",
          targetId: "m1:system:9",
          seq: 1,
          outcome: "dropped",
          reason: "unknown_id",
          appliedText: null,
          verdict: null,
        },
      ]);
      const hit = await getJson<LlmCallsResponse>(
        "/api/meetings/m1/llm-calls?target_type=segment&target_id=m1:system:0",
      );
      expect(hit.body.calls.map((c) => c.id)).toEqual([id]);
      expect(hit.body.calls[0]?.links).toMatchObject([
        {
          targetId: "m1:system:0",
          outcome: "applied",
          appliedText: "fixed text",
        },
      ]);

      // The text changed after the run: the link is no longer true.
      getDb()
        .prepare(
          "UPDATE meeting_segments SET enhanced_text = 'someone else' WHERE id = 'm1:system:0'",
        )
        .run();
      const stale = await getJson<LlmCallsResponse>(
        "/api/meetings/m1/llm-calls?target_type=segment&target_id=m1:system:0",
      );
      expect(stale.body.calls).toEqual([]);
      // After a re-transcribe: same id, NULL enhanced_text.
      getDb().prepare("UPDATE meeting_segments SET enhanced_text = NULL").run();
      const none = await getJson<LlmCallsResponse>(
        "/api/meetings/m1/llm-calls?target_type=segment&target_id=m1:system:0",
      );
      expect(none.body.calls).toEqual([]);
    });

    it("a speaker target returns the proposal calls of the producing run, with a dropped proposal and the stale flag", async () => {
      getDb()
        .prepare(
          "INSERT INTO meeting_speakers (meeting_id, speaker_label, suggested_name, updated_at) VALUES ('m1', 'SPEAKER_00', 'Ana', 1)",
        )
        .run();
      startRun("r1");
      recorder().setInputHash("r1", "some-old-hash");
      step("r1", "candidates", "identifySpeakers", "succeeded");
      const id = call("r1", {
        unitKey: "candidates",
        node: "identifySpeakers",
      });
      recorder().linkCall(id, [
        {
          targetType: "speaker",
          targetId: "SPEAKER_00",
          seq: 0,
          outcome: "applied",
          reason: null,
          appliedText: "Ana",
          verdict: { label: "SPEAKER_00", status: "kept" },
        },
        {
          targetType: "speaker",
          targetId: "SPEAKER_00",
          seq: 1,
          outcome: "dropped",
          reason: "no_quote",
          appliedText: null,
          verdict: {
            label: "SPEAKER_00",
            status: "dropped",
            reason: "no_quote",
          },
        },
        {
          targetType: "speaker",
          targetId: "SPEAKER_01",
          seq: 2,
          outcome: "applied",
          reason: null,
          appliedText: "Bob",
          verdict: null,
        },
      ]);
      const res = await getJson<LlmCallsResponse>(
        "/api/meetings/m1/llm-calls?target_type=speaker&target_id=SPEAKER_00",
      );
      expect(res.body.calls.map((c) => c.id)).toEqual([id]);
      const links = res.body.calls[0]?.links ?? [];
      expect(links.map((l) => [l.targetId, l.outcome, l.reason])).toEqual([
        ["SPEAKER_00", "applied", null],
        ["SPEAKER_00", "dropped", "no_quote"],
      ]);
      expect(links[1]?.verdict).toMatchObject({
        status: "dropped",
        reason: "no_quote",
      });
      // The stored hash is not the hash of the current rows, so the labels are stale.
      expect(links.every((l) => l.staleLabels)).toBe(true);
    });

    it("a speaker target with only dropped proposals still finds the newest run", async () => {
      startRun("r1");
      step("r1", "candidates", "identifySpeakers", "succeeded");
      const id = call("r1", {
        unitKey: "candidates",
        node: "identifySpeakers",
      });
      recorder().linkCall(id, [
        {
          targetType: "speaker",
          targetId: "SPEAKER_03",
          seq: 0,
          outcome: "dropped",
          reason: "no_quote",
          appliedText: null,
          verdict: null,
        },
      ]);
      const res = await getJson<LlmCallsResponse>(
        "/api/meetings/m1/llm-calls?target_type=speaker&target_id=SPEAKER_03",
      );
      expect(res.body.calls.map((c) => c.id)).toEqual([id]);
    });

    it("a summary target returns the summarize calls of the run that made the current summary", async () => {
      getDb()
        .prepare(
          "INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES ('m1', '# s', 777)",
        )
        .run();
      startRun("r1", "m1", "summarize");
      step("r1", "single", "summarize", "succeeded");
      const sumCall = call("r1", { unitKey: "single", node: "summarize" });
      recorder().linkCall(sumCall, [
        {
          targetType: "summary",
          targetId: "m1",
          seq: 0,
          outcome: "applied",
          reason: null,
          appliedText: "777",
          verdict: null,
        },
      ]);
      const hit = await getJson<LlmCallsResponse>(
        "/api/meetings/m1/llm-calls?target_type=summary",
      );
      expect(hit.body.calls.map((c) => c.id)).toEqual([sumCall]);
      // A newer summary row: the link no longer matches.
      getDb().prepare("UPDATE meeting_summaries SET created_at = 888").run();
      const stale = await getJson<LlmCallsResponse>(
        "/api/meetings/m1/llm-calls?target_type=summary",
      );
      expect(stale.body.calls).toEqual([]);
    });
  });
});

describe("delete with the meeting (accept 3)", () => {
  it("DELETE /api/meetings/:id leaves only the other meeting's rows and the scope test run", async () => {
    insertMeeting("m2");
    for (const [run, scopeId] of [
      ["rm1", "m1"],
      ["rm2", "m2"],
      ["rt", "sandbox"],
    ] as const) {
      startRun(run, scopeId);
      step(run, "chunk:0", "correctChunk", "succeeded");
      const id = call(run);
      recorder().linkCall(id, [
        {
          targetType: "segment",
          targetId: `${scopeId}:system:0`,
          seq: 0,
          outcome: "applied",
          reason: null,
          appliedText: "x",
          verdict: null,
        },
      ]);
    }
    const tables = ["llm_runs", "llm_run_steps", "llm_calls", "llm_call_links"];
    const counts = () =>
      tables.map(
        (t) =>
          (
            getDb().prepare(`SELECT count(*) AS c FROM ${t}`).get() as {
              c: number;
            }
          ).c,
      );
    expect(counts()).toEqual([3, 3, 3, 3]);
    expect(
      (await app.request("/api/meetings/m1", { method: "DELETE" })).status,
    ).toBe(200);
    expect(counts()).toEqual([2, 2, 2, 2]);
    expect(
      (await app.request("/api/meetings/m2", { method: "DELETE" })).status,
    ).toBe(200);
    expect(counts()).toEqual([1, 1, 1, 1]);
    const left = getDb().prepare("SELECT id, scope FROM llm_runs").all();
    expect(left).toEqual([{ id: "rt", scope: "test" }]);
  });
});
