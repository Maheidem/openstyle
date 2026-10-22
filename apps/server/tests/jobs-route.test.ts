import { jobsResponseSchema } from "@openstyle/validations";
import { afterEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import {
  claimJob,
  releaseJob,
  updateProgress,
} from "../src/lib/meetings/job-registry.js";
import { isAppleSiliconMac } from "../src/lib/mlx-asr/constants.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";

const app = createApp();

function insertMeeting(id: string, title: string | null): void {
  getDb()
    .prepare(
      "INSERT INTO meetings (id, title, status, created_at) VALUES (?, ?, 'transcribed', 1)",
    )
    .run(id, title);
}

async function getJobs() {
  const res = await app.request("/api/jobs");
  expect(res.status).toBe(200);
  return jobsResponseSchema.parse(await res.json());
}

afterEach(() => {
  releaseJob("run");
  releaseJob("wait");
  resetMeetingTables();
  delete process.env.OPENSTYLE_E2E_FAKE_MODEL_JOBS;
});

describe("GET /api/jobs", () => {
  it("lists the running and the queued meeting jobs with their titles", async () => {
    insertMeeting("run", "Weekly product sync");
    insertMeeting("wait", "Design review with Priya");
    claimJob("run", "enhance", { done: 5, total: 8, failed: 0 });
    updateProgress("run", { phase: "reading" });
    claimJob("wait", "enhance", { done: 0, total: 8, failed: 0 });
    updateProgress("wait", { queued: { ahead: 1, sinceMs: Date.now() } });

    const { meetings } = await getJobs();
    expect(meetings).toEqual([
      {
        meeting_id: "run",
        title: "Weekly product sync",
        kind: "enhance",
        phase: "reading",
        done: 5,
        total: 8,
        queued: null,
      },
      {
        meeting_id: "wait",
        title: "Design review with Priya",
        kind: "enhance",
        phase: null,
        done: 0,
        total: 8,
        queued: { ahead: 1 },
      },
    ]);
  });

  it("is empty when no job runs, and the registry stays unchanged", async () => {
    const { meetings } = await getJobs();
    expect(meetings).toEqual([]);
    insertMeeting("run", null);
    claimJob("run", "transcribe", { done: 0, total: 3, failed: 0 });
    expect((await getJobs()).meetings[0]).toMatchObject({
      title: null,
      kind: "transcribe",
    });
    expect((await getJobs()).meetings).toHaveLength(1);
  });

  it("names the built-in models with their catalog names on Apple silicon", async () => {
    const { models } = await getJobs();
    if (!isAppleSiliconMac()) {
      expect(models).toEqual([]);
      return;
    }
    const names = models.map((m) => `${m.type}:${m.display_name}`);
    expect(names).toContain("voice:Qwen3 Fast");
    expect(names).toContain("llm:Gemma 4 E2B");
    expect(names.some((n) => n.startsWith("embedding:EmbeddingGemma"))).toBe(
      true,
    );
    for (const m of models) {
      if (m.status !== "downloading") expect(m.download).toBeNull();
    }
  });

  it("adds a fake download and a fake load only with the E2E seam", async () => {
    const before = await getJobs();
    expect(before.models.some((m) => m.status === "loading")).toBe(false);

    process.env.OPENSTYLE_E2E_FAKE_MODEL_JOBS = "1";
    const saved = process.env.OPENSTYLE_E2E;
    process.env.OPENSTYLE_E2E = "1";
    try {
      const { models } = await getJobs();
      const gemma = models.find((m) => m.model === "gemma-4-e2b-qat-4bit");
      expect(gemma).toMatchObject({
        type: "llm",
        display_name: "Gemma 4 E2B",
        status: "downloading",
        size_bytes: 4_361_680_121,
      });
      expect(gemma?.download?.bytes_total).toBe(4_361_680_121);
      expect(gemma?.download?.bytes_done).toBeGreaterThanOrEqual(1.9e9);
      const qwen = models.find((m) => m.model === "qwen3-0.6b-8bit");
      expect(qwen).toMatchObject({ status: "loading", download: null });
    } finally {
      if (saved === undefined) delete process.env.OPENSTYLE_E2E;
      else process.env.OPENSTYLE_E2E = saved;
    }
  });
});
