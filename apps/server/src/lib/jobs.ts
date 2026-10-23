import type {
  JobsResponse,
  MeetingJobItem,
  ModelJobItem,
} from "@openstyle/validations";
import { getDb } from "./db.js";
import { listJobs } from "./meetings/job-registry.js";
import { isAppleSiliconMac } from "./mlx-asr/constants.js";
import {
  getAllMlxModelStatuses,
  getMlxCatalogModels,
  type MlxModelDownloadState,
} from "./mlx-asr/models.js";
import { getMlxAsrWorkerState } from "./mlx-asr/server.js";
import { getAllMlxEmbedModelStatuses } from "./mlx-embed/models.js";
import { getMlxEmbedWorkerState } from "./mlx-embed/server.js";
import { getMlxLlmModel } from "./mlx-llm/constants.js";
import { getAllMlxLlmModelStatuses } from "./mlx-llm/models.js";
import { getMlxLlmWorkerState } from "./mlx-llm/server.js";

// The data of GET /api/jobs (issue #317): the meeting jobs of the job
// registry and the state of the built-in MLX models. It reads the same
// functions as GET /api/meetings and the /status routes of mlx-asr, mlx-llm
// and mlx-embed. It changes nothing.

interface WorkerState {
  model: string | null;
  state: string;
}

function meetingJobs(): MeetingJobItem[] {
  const jobs = listJobs();
  if (jobs.length === 0) return [];
  const ids = jobs.map((job) => job.id);
  const rows = getDb()
    .prepare(
      `SELECT id, title FROM meetings WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<{ id: string; title: string | null }>;
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  return jobs.map((job) => ({
    meeting_id: job.id,
    title: titles.get(job.id)?.trim() || null,
    kind: job.kind,
    phase: job.phase ?? null,
    done: job.done,
    total: job.total,
    queued: job.queued ? { ahead: job.queued.ahead } : null,
  }));
}

function modelJob(
  type: ModelJobItem["type"],
  state: MlxModelDownloadState,
  worker: WorkerState,
): ModelJobItem {
  const progress = state.downloadProgress;
  const status: ModelJobItem["status"] =
    state.status === "ready" &&
    worker.model === state.model &&
    worker.state === "starting"
      ? "loading"
      : state.status;
  return {
    type,
    model: state.model,
    display_name: state.displayName,
    status,
    size_bytes: state.sizeBytes,
    download:
      state.status === "downloading" && progress
        ? {
            bytes_done: progress.bytesDownloaded,
            bytes_total: progress.bytesTotal,
            percent: Math.max(0, Math.min(100, progress.percent)),
          }
        : null,
  };
}

function modelJobs(): ModelJobItem[] {
  if (!isAppleSiliconMac()) return [];
  const voice = getMlxAsrWorkerState();
  const llm = getMlxLlmWorkerState();
  const embed = getMlxEmbedWorkerState();
  return [
    ...getAllMlxModelStatuses().map((s) => modelJob("voice", s, voice)),
    ...getAllMlxLlmModelStatuses().map((s) => modelJob("llm", s, llm)),
    ...getAllMlxEmbedModelStatuses().map((s) =>
      modelJob("embedding", s, embed),
    ),
  ];
}

const fakeStartedAt = Date.now();

/**
 * E2E seam (OPENSTYLE_E2E=1 and OPENSTYLE_E2E_FAKE_MODEL_JOBS=1): a fake
 * download of Gemma 4 E2B and a fake load of Qwen3 Fast, with the real
 * catalog sizes. Nothing downloads or starts. The download starts at 1.9 GB
 * and grows by 25 MB per second, so a test can see the percent change.
 */
function fakeModelJobs(): ModelJobItem[] {
  if (
    process.env.OPENSTYLE_E2E !== "1" ||
    process.env.OPENSTYLE_E2E_FAKE_MODEL_JOBS !== "1"
  ) {
    return [];
  }
  const gemma = getMlxLlmModel("gemma-4-e2b-qat-4bit");
  const qwen = getMlxCatalogModels().find((m) => m.id === "qwen3-0.6b-8bit");
  if (!gemma || !qwen) return [];
  const seconds = (Date.now() - fakeStartedAt) / 1000;
  const done = Math.min(gemma.sizeBytes, 1.9e9 + seconds * 25e6);
  return [
    {
      type: "llm",
      model: gemma.id,
      display_name: gemma.displayName,
      status: "downloading",
      size_bytes: gemma.sizeBytes,
      download: {
        bytes_done: done,
        bytes_total: gemma.sizeBytes,
        percent: (done / gemma.sizeBytes) * 100,
      },
    },
    {
      type: "voice",
      model: qwen.id,
      display_name: qwen.displayName,
      status: "loading",
      size_bytes: qwen.sizeBytes,
      download: null,
    },
  ];
}

export function readJobs(): JobsResponse {
  const fake = fakeModelJobs();
  const fakeIds = new Set(fake.map((m) => m.model));
  return {
    meetings: meetingJobs(),
    models: [...modelJobs().filter((m) => !fakeIds.has(m.model)), ...fake],
  };
}
