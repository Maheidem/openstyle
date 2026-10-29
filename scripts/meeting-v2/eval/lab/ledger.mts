// ledger.mts: the ledger of the Eval Lab.
//
// MLflow (the REST API, no client package) holds one run per cell: params
// = the knob values, tags = the snapshot fields, metrics = the pooled and
// the per-meeting numbers. A private local folder per run
// (<lab home>/runs/<mlflow run id>/) holds the per-item results as JSONL,
// keys and numbers only. Every write is read back from the server; a
// missing or different value is an error.
//
// The server URI comes from the environment only (LAB_MLFLOW_URI, else
// SILVER_MLFLOW_URI, else MLFLOW_TRACKING_URI). There is no default.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { labHome, privateDir, privateWrite } from "./corpus.mts";

export function mlflowUri(): string {
  const u = (
    process.env.LAB_MLFLOW_URI ||
    process.env.SILVER_MLFLOW_URI ||
    process.env.MLFLOW_TRACKING_URI ||
    ""
  ).trim();
  if (!/^https?:\/\//.test(u))
    throw new Error(
      "set LAB_MLFLOW_URI (or SILVER_MLFLOW_URI) to the MLflow server (http://host:port)",
    );
  return u.replace(/\/+$/, "");
}

export const experimentName = (stage: string) => `openstyle-lab-${stage}`;

export interface MlflowRun {
  info: {
    run_id: string;
    run_name?: string;
    experiment_id: string;
    status: string;
    start_time?: number;
    end_time?: number;
  };
  data: {
    params?: { key: string; value: string }[];
    tags?: { key: string; value: string }[];
    metrics?: { key: string; value: number }[];
  };
}

/** A flat view of a run: params, tags and metrics as maps. */
export interface FlatRun {
  id: string;
  name: string;
  status: string;
  start: number;
  params: Record<string, string>;
  tags: Record<string, string>;
  metrics: Record<string, number>;
}

export function flatRun(r: MlflowRun): FlatRun {
  const map = <T,>(xs: { key: string; value: T }[] | undefined) =>
    Object.fromEntries((xs ?? []).map((x) => [x.key, x.value])) as Record<
      string,
      T
    >;
  return {
    id: r.info.run_id,
    name: r.info.run_name ?? "",
    status: r.info.status,
    start: Number(r.info.start_time ?? 0),
    params: map(r.data.params),
    tags: map(r.data.tags),
    metrics: map(r.data.metrics),
  };
}

export class Mlflow {
  readonly uri: string;
  constructor(uri: string) {
    this.uri = uri;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<any> {
    const url = `${this.uri}/api/2.0/mlflow/${path}`;
    const r = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    if (!r.ok)
      throw new Error(
        `MLflow ${method} ${path}: HTTP ${r.status} ${text.slice(0, 200)}`,
      );
    return text ? JSON.parse(text) : {};
  }

  /** The id of the experiment `name`; it is made when it does not exist. */
  async experimentId(name: string, create = true): Promise<string | null> {
    try {
      const r = await this.call(
        "GET",
        `experiments/get-by-name?experiment_name=${encodeURIComponent(name)}`,
      );
      return r.experiment.experiment_id as string;
    } catch (e) {
      if (
        !/HTTP 404/.test(String(e)) &&
        !/RESOURCE_DOES_NOT_EXIST/.test(String(e))
      )
        throw e;
    }
    if (!create) return null;
    const r = await this.call("POST", "experiments/create", { name });
    return r.experiment_id as string;
  }

  async createRun(
    experimentId: string,
    runName: string,
    tags: Record<string, string>,
  ): Promise<string> {
    const r = await this.call("POST", "runs/create", {
      experiment_id: experimentId,
      run_name: runName,
      start_time: Date.now(),
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
    return r.run.info.run_id as string;
  }

  /** Log params, tags and metrics in batches (MLflow limits per request). */
  async logBatch(
    runId: string,
    params: Record<string, string>,
    tags: Record<string, string>,
    metrics: Record<string, number>,
  ): Promise<void> {
    const ts = Date.now();
    const p = Object.entries(params).map(([key, value]) => ({ key, value }));
    const t = Object.entries(tags).map(([key, value]) => ({ key, value }));
    const m = Object.entries(metrics)
      .filter(([, v]) => Number.isFinite(v))
      .map(([key, value]) => ({ key, value, timestamp: ts, step: 0 }));
    for (let i = 0; i < Math.max(p.length, t.length, m.length); i += 100)
      await this.call("POST", "runs/log-batch", {
        run_id: runId,
        params: p.slice(i, i + 100),
        tags: t.slice(i, i + 100),
        metrics: m.slice(i, i + 100),
      });
  }

  async endRun(runId: string, status: "FINISHED" | "FAILED"): Promise<void> {
    await this.call("POST", "runs/update", {
      run_id: runId,
      status,
      end_time: Date.now(),
    });
  }

  async getRun(runId: string): Promise<FlatRun> {
    const r = await this.call(
      "GET",
      `runs/get?run_id=${encodeURIComponent(runId)}`,
    );
    return flatRun(r.run as MlflowRun);
  }

  /** All runs of the experiments that match `filter` (MLflow search syntax). */
  async searchRuns(experimentIds: string[], filter = ""): Promise<FlatRun[]> {
    const out: FlatRun[] = [];
    let token: string | undefined;
    do {
      const r = await this.call("POST", "runs/search", {
        experiment_ids: experimentIds,
        filter,
        max_results: 1000,
        order_by: ["attributes.start_time DESC"],
        ...(token ? { page_token: token } : {}),
      });
      for (const x of r.runs ?? []) out.push(flatRun(x as MlflowRun));
      token = r.next_page_token || undefined;
    } while (token);
    return out;
  }
}

/**
 * Read a run back and compare it with what was written. Returns the list
 * of differences (empty = the server holds every value).
 */
export function diffRun(
  got: FlatRun,
  want: {
    params: Record<string, string>;
    tags: Record<string, string>;
    metrics: Record<string, number>;
    status?: string;
  },
): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(want.params))
    if (got.params[k] !== v) bad.push(`param ${k}`);
  for (const [k, v] of Object.entries(want.tags))
    if (got.tags[k] !== v) bad.push(`tag ${k}`);
  for (const [k, v] of Object.entries(want.metrics))
    if (Number.isFinite(v) && got.metrics[k] !== v) bad.push(`metric ${k}`);
  if (want.status && got.status !== want.status)
    bad.push(`status ${got.status}`);
  return bad;
}

// --- Local items ---------------------------------------------------------------

export const runsDir = () => join(labHome(), "runs");
export const runDir = (runId: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error("bad run id");
  return join(runsDir(), runId);
};

/** Write the private files of a run (0700 folder, 0600 files). */
export function writeItems(
  runId: string,
  files: Record<string, unknown[] | unknown>,
): string {
  const dir = privateDir(runDir(runId));
  for (const [name, data] of Object.entries(files))
    privateWrite(
      join(dir, name),
      Array.isArray(data)
        ? data.map((x) => JSON.stringify(x)).join("\n") +
            (data.length ? "\n" : "")
        : `${JSON.stringify(data, null, 1)}\n`,
    );
  return dir;
}

/** The lines of a JSONL file of a run, or null when the file is absent. */
export function readItems<T>(runId: string, name: string): T[] | null {
  const p = join(runDir(runId), name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}
