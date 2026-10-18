import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LlmParamsLedger, LlmScope } from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallRecord } from "../src/lib/llm/call-record.js";
import {
  createLlmRecorder,
  type LlmRecorder,
} from "../src/lib/llm/recorder.js";
import { initSchema } from "../src/lib/schema.js";

// Checks 5 and 8 of specs/meeting-enhance-agentic.md 10.9. They run on a real
// database file, once with scope "meeting" and once with scope "test".

let dir: string;
let db: DatabaseSync;
let rec: LlmRecorder;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-record-"));
  db = new DatabaseSync(join(dir, "db.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  rec = createLlmRecorder(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const LEDGER: LlmParamsLedger = {
  topLevel: { temperature: 0.2 },
  extraBody: { top_k: 20 },
  dropped: [{ name: "stream", value: false, reason: "denylist" }],
  source: { mode: "preset", presetId: "p1" },
  capturedFrom: "wire",
  warnings: ["w1"],
  structuredMode: "json_schema_strict",
};

function callRecord(over: Partial<CallRecord> = {}): CallRecord {
  return {
    runId: "r1",
    unitKey: "chunk:0",
    node: "correctChunk",
    retryReason: null,
    provider: "server",
    modelRequested: "Qwen3.8-27B",
    modelServed: "Qwen3.8-27B",
    instructions: "You fix speech errors.",
    messages: [{ role: "user", content: "hello wrld" }],
    schema: { name: "corrections", version: 1, json: { type: "object" } },
    params: LEDGER,
    rawText: '{"corrections":[]}',
    parsed: { corrections: [] },
    reasoningChars: 0,
    finishUnified: "stop",
    finishRaw: "stop",
    usage: { input: 10, output: 5, reasoning: 0, cached: 0 },
    queuedMs: 1,
    latencyMs: 20,
    errorKind: null,
    errorDetail: null,
    startedAt: 1000,
    finishedAt: 1020,
    ...over,
  };
}

function count(sql: string, ...args: (string | number)[]): number {
  return (db.prepare(sql).get(...args) as { c: number }).c;
}

describe.each<LlmScope>([
  "meeting",
  "test",
])("LLM recorder, scope %s", (scope) => {
  const scopeId = scope === "meeting" ? "m1" : "sandbox-1";

  beforeEach(() => {
    if (scope === "meeting") {
      db.prepare(
        "INSERT INTO meetings (id, title, status, created_at) VALUES ('m1', 'T', 'transcribed', 1)",
      ).run();
    }
    expect(
      rec.startRun({
        id: "r1",
        scope,
        scopeId,
        kind: "enhance",
        startedBy: "button",
        graphVersion: 1,
        startedAt: 500,
      }),
    ).toBe("ok");
  });

  it("startRun writes the scope; meeting_id is set only for scope meeting", () => {
    const row = db
      .prepare("SELECT * FROM llm_runs WHERE id = 'r1'")
      .get() as Record<string, unknown>;
    expect(row.scope).toBe(scope);
    expect(row.scope_id).toBe(scopeId);
    expect(row.meeting_id).toBe(scope === "meeting" ? "m1" : null);
    expect(row.status).toBe("running");
    expect(row.resume_count).toBe(0);
    expect(row.lost_records).toBe(0);
    expect(row.updated_at).toBe(500);
  });

  it("startStep numbers steps in start order and keeps seq and attempts on a repeat", () => {
    rec.startStep("r1", { key: "prepare", node: "prepare" });
    rec.startStep("r1", { key: "chunk:0", node: "correctChunk" });
    rec.startStep("r1", { key: "chunk:1", node: "correctChunk" });
    rec.startAttempt({ runId: "r1", stepKey: "chunk:0" });
    rec.finishStep("r1", "prepare", "succeeded");
    rec.startStep("r1", { key: "prepare", node: "prepare" });
    const steps = db
      .prepare(
        "SELECT step_key, seq, attempts, status FROM llm_run_steps ORDER BY seq",
      )
      .all();
    expect(steps).toEqual([
      { step_key: "prepare", seq: 1, attempts: 0, status: "running" },
      { step_key: "chunk:0", seq: 2, attempts: 1, status: "running" },
      { step_key: "chunk:1", seq: 3, attempts: 0, status: "running" },
    ]);
    expect(rec.sweepInterrupted()).toBe(1);
    rec.startStep("r1", { key: "candidates", node: "identifySpeakers" });
    const fourth = db
      .prepare("SELECT seq FROM llm_run_steps WHERE step_key = 'candidates'")
      .get() as { seq: number };
    expect(fourth.seq).toBe(4);
  });

  it("startAttempt counts a half of a unit in the step of its prefix", () => {
    rec.startStep("r1", { key: "chunk:3", node: "correctChunk" });
    rec.startStep("r1", { key: "chunk:30", node: "correctChunk" });
    rec.startAttempt({ runId: "r1", stepKey: "chunk:3/0" });
    rec.startAttempt({ runId: "r1", stepKey: "chunk:3" });
    const rows = db
      .prepare("SELECT step_key, attempts FROM llm_run_steps ORDER BY seq")
      .all();
    expect(rows).toEqual([
      { step_key: "chunk:3", attempts: 2 },
      { step_key: "chunk:30", attempts: 0 },
    ]);
  });

  it("recordCall numbers attempts per run and unit key; an unrecorded call takes no number", () => {
    const a1 = rec.recordCall(callRecord());
    const a2 = rec.recordCall(callRecord());
    expect(rec.recordCall(callRecord({ runId: "gone" }))).toBeNull();
    const a3 = rec.recordCall(callRecord());
    const other = rec.recordCall(callRecord({ unitKey: "chunk:1" }));
    expect([a1?.attempt, a2?.attempt, a3?.attempt]).toEqual([1, 2, 3]);
    expect(other?.attempt).toBe(1);
    const stored = db
      .prepare("SELECT attempt FROM llm_calls WHERE id = ?")
      .get(a3?.id as number) as { attempt: number };
    expect(stored.attempt).toBe(3);
  });

  it("finishedCall gives the newest call with no error, and null for unusable rows", () => {
    expect(rec.finishedCall("r1", "chunk:0")).toBeNull();
    rec.recordCall(callRecord({ parsed: { v: 1 } }));
    const second = rec.recordCall(
      callRecord({ parsed: { v: 2 }, finishRaw: "stop" }),
    );
    rec.recordCall(
      callRecord({
        errorKind: "length",
        finishUnified: "length",
        finishRaw: "length",
      }),
    );
    const found = rec.finishedCall("r1", "chunk:0");
    expect(found).toMatchObject({
      callId: second?.id,
      attempt: 2,
      parsed: { v: 2 },
      rawFinishReason: "stop",
      usage: { input: 10, output: 5, reasoning: 0, cached: 0 },
      provider: "server",
      modelRequested: "Qwen3.8-27B",
      modelServed: "Qwen3.8-27B",
      queuedMs: 1,
      latencyMs: 20,
      params: LEDGER,
    });

    // A cut marker: the parsed column is longer than the cap, so it does not parse.
    rec.recordCall(
      callRecord({ unitKey: "cut", parsed: { big: "x".repeat(500_001) } }),
    );
    expect(rec.finishedCall("r1", "cut")).toBeNull();

    // A missing finish_raw.
    rec.recordCall(callRecord({ unitKey: "noraw", finishRaw: null }));
    expect(rec.finishedCall("r1", "noraw")).toBeNull();

    // A params_json that does not parse.
    rec.recordCall(callRecord({ unitKey: "badparams" }));
    db.prepare(
      "UPDATE llm_calls SET params_json = '{nope' WHERE step_key = 'badparams'",
    ).run();
    expect(rec.finishedCall("r1", "badparams")).toBeNull();
  });

  it("linkCall is idempotent per (call, target, seq) and keeps different seq apart", () => {
    const call = rec.recordCall(callRecord());
    const link = {
      targetType: "segment" as const,
      targetId: "m1:system:0",
      seq: 0,
      outcome: "applied" as const,
      reason: null,
      appliedText: "hello world",
      verdict: null,
    };
    rec.linkCall(call?.id as number, [link]);
    rec.linkCall(call?.id as number, [
      { ...link, appliedText: "hello world!" },
    ]);
    expect(count("SELECT count(*) AS c FROM llm_call_links")).toBe(1);
    const row = db.prepare("SELECT * FROM llm_call_links").get() as Record<
      string,
      unknown
    >;
    expect(row.applied_text).toBe("hello world!");
    expect(row.scope).toBe(scope);
    expect(row.scope_id).toBe(scopeId);
    rec.linkCall(call?.id as number, [{ ...link, seq: 1 }]);
    expect(count("SELECT count(*) AS c FROM llm_call_links")).toBe(2);
  });

  it("linkCall for a missing call writes no row and does not throw", () => {
    rec.linkCall(999, [
      {
        targetType: "summary",
        targetId: "m1",
        seq: 0,
        outcome: "applied",
        reason: null,
        appliedText: "1",
        verdict: null,
      },
    ]);
    expect(count("SELECT count(*) AS c FROM llm_call_links")).toBe(0);
  });

  it("round trip: every CallRecord field reads back from its column (check 8)", () => {
    const record = callRecord({
      retryReason: "schema",
      provider: "prov-x",
      modelRequested: "req-model",
      modelServed: "served-model",
      instructions: "SYSTEM TEXT",
      messages: [
        { role: "user", content: "user turn" },
        { role: "assistant", content: "assistant turn" },
      ],
      schema: { name: "sch", version: 7, json: { type: "object", x: 1 } },
      rawText: "RAW",
      parsed: { p: [1, 2] },
      reasoningChars: 42,
      finishUnified: "length",
      finishRaw: "max_tokens",
      usage: { input: 11, output: 22, reasoning: 33, cached: 44 },
      queuedMs: 55,
      latencyMs: 66,
      errorKind: "length",
      errorDetail: "cut at 22 tokens",
      startedAt: 7001,
      finishedAt: 7002,
    });
    const recorded = rec.recordCall(record);
    const row = db
      .prepare("SELECT * FROM llm_calls WHERE id = ?")
      .get(recorded?.id as number) as Record<string, unknown>;
    expect(row).toMatchObject({
      run_id: "r1",
      step_key: "chunk:0",
      node: "correctChunk",
      attempt: recorded?.attempt,
      retry_reason: "schema",
      provider: "prov-x",
      requested_model: "req-model",
      served_model: "served-model",
      schema_name: "sch",
      schema_version: 7,
      raw_text: "RAW",
      finish_unified: "length",
      finish_raw: "max_tokens",
      input_tokens: 11,
      output_tokens: 22,
      reasoning_tokens: 33,
      cached_tokens: 44,
      reasoning_chars: 42,
      queued_ms: 55,
      latency_ms: 66,
      error_kind: "length",
      error_detail: "cut at 22 tokens",
      started_at: 7001,
      finished_at: 7002,
      scope,
      scope_id: scopeId,
    });
    expect(JSON.parse(row.messages_json as string)).toEqual([
      { role: "system", content: "SYSTEM TEXT" },
      { role: "user", content: "user turn" },
      { role: "assistant", content: "assistant turn" },
    ]);
    expect(JSON.parse(row.schema_json as string)).toEqual({
      type: "object",
      x: 1,
    });
    expect(JSON.parse(row.params_json as string)).toEqual(LEDGER);
    expect(JSON.parse(row.parsed_json as string)).toEqual({ p: [1, 2] });
    const cols = (
      db.prepare("PRAGMA table_info(llm_calls)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("meeting_id");
    expect(cols).toContain("scope");
    const run = db
      .prepare("SELECT scope, scope_id FROM llm_runs WHERE id = 'r1'")
      .get() as {
      scope: string;
      scope_id: string;
    };
    expect({ scope: row.scope, scope_id: row.scope_id }).toEqual(run);
  });

  it("unknown token counts are NULL columns, not 0", () => {
    const recorded = rec.recordCall(
      callRecord({
        usage: { input: null, output: null, reasoning: null, cached: null },
        queuedMs: null,
        latencyMs: null,
        reasoningChars: null,
        rawText: null,
        parsed: null,
        finishUnified: null,
        finishRaw: null,
        provider: null,
        modelRequested: null,
        modelServed: null,
      }),
    );
    const row = db
      .prepare("SELECT * FROM llm_calls WHERE id = ?")
      .get(recorded?.id as number) as Record<string, unknown>;
    for (const col of [
      "input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "cached_tokens",
      "reasoning_chars",
      "queued_ms",
      "latency_ms",
      "raw_text",
      "parsed_json",
      "finish_unified",
      "finish_raw",
      "provider",
      "requested_model",
      "served_model",
    ]) {
      expect(row[col], col).toBeNull();
    }
  });

  it("masks Authorization and api_key values in params_json and cuts long text", () => {
    const params = {
      ...LEDGER,
      extraBody: {
        api_key: "sk-secret",
        headers: { Authorization: "Bearer abc" },
      },
    };
    const recorded = rec.recordCall(
      callRecord({ params, rawText: "x".repeat(500_010) }),
    );
    const row = db
      .prepare("SELECT params_json, raw_text FROM llm_calls WHERE id = ?")
      .get(recorded?.id as number) as { params_json: string; raw_text: string };
    expect(row.params_json).not.toContain("sk-secret");
    expect(row.params_json).not.toContain("Bearer abc");
    expect(row.raw_text.endsWith("\n[cut: 10 characters]")).toBe(true);
    expect(row.raw_text.length).toBe(500_000 + "\n[cut: 10 characters]".length);
  });

  it("finishRun, setInputHash and markResumed write the run row", () => {
    rec.setInputHash("r1", "abc");
    rec.finishRun("r1", "partial", {
      errorKind: null,
      errorDetail: null,
      result: { correctedCount: 3, suggestionCount: 1 },
      lostRecords: 2,
      finishedAt: 900,
    });
    const done = db
      .prepare("SELECT * FROM llm_runs WHERE id = 'r1'")
      .get() as Record<string, unknown>;
    expect(done).toMatchObject({
      status: "partial",
      input_hash: "abc",
      lost_records: 2,
      finished_at: 900,
      updated_at: 900,
    });
    expect(JSON.parse(done.result_json as string)).toEqual({
      correctedCount: 3,
      suggestionCount: 1,
    });
    rec.markResumed("r1");
    const resumed = db
      .prepare("SELECT * FROM llm_runs WHERE id = 'r1'")
      .get() as Record<string, unknown>;
    expect(resumed.status).toBe("running");
    expect(resumed.resume_count).toBe(1);
    expect(resumed.finished_at).toBeNull();
    expect(resumed.started_by).toBe("button");
  });

  it("sweepInterrupted turns running runs and their running steps into interrupted", () => {
    rec.startStep("r1", { key: "prepare", node: "prepare" });
    rec.finishStep("r1", "prepare", "succeeded");
    rec.startStep("r1", { key: "chunk:0", node: "correctChunk" });
    rec.startRun({
      id: "r2",
      scope,
      scopeId,
      kind: "summarize",
      startedBy: "auto",
      graphVersion: 1,
      startedAt: 600,
    });
    rec.finishRun("r2", "succeeded", {
      errorKind: null,
      errorDetail: null,
      result: null,
      lostRecords: 0,
      finishedAt: 700,
    });
    rec.startStep("r2", { key: "single", node: "summarize" });
    expect(rec.sweepInterrupted()).toBe(1);
    expect(
      db.prepare("SELECT id, status FROM llm_runs ORDER BY id").all(),
    ).toEqual([
      { id: "r1", status: "interrupted" },
      { id: "r2", status: "succeeded" },
    ]);
    expect(
      db
        .prepare(
          "SELECT run_id, step_key, status FROM llm_run_steps ORDER BY run_id, seq",
        )
        .all(),
    ).toEqual([
      { run_id: "r1", step_key: "prepare", status: "succeeded" },
      { run_id: "r1", step_key: "chunk:0", status: "interrupted" },
      { run_id: "r2", step_key: "single", status: "running" },
    ]);
    expect(rec.sweepInterrupted()).toBe(0);
  });
});

describe("LLM recorder, scope owner gone", () => {
  it("startRun answers no_scope for an unknown meeting and writes nothing", () => {
    expect(
      rec.startRun({
        id: "r9",
        scope: "meeting",
        scopeId: "no-such-meeting",
        kind: "enhance",
        startedBy: "auto",
        graphVersion: 1,
        startedAt: 1,
      }),
    ).toBe("no_scope");
    expect(count("SELECT count(*) AS c FROM llm_runs")).toBe(0);
  });

  it("a duplicate run id answers error and never throws", () => {
    const run = {
      id: "r1",
      scope: "test" as const,
      scopeId: "s",
      kind: "enhance" as const,
      startedBy: "auto" as const,
      graphVersion: 1,
      startedAt: 1,
    };
    expect(rec.startRun(run)).toBe("ok");
    expect(rec.startRun(run)).toBe("error");
  });
});
