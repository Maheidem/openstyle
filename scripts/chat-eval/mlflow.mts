// mlflow.mts: MLflow logging of the chat eval, by the eval-lab conventions
// (.claude/skills/eval-lab/SKILL.md): numbers and ids only, the server URI from
// the environment only, and every run read back from the server. A run
// counts only after the read back.

import { spawnSync } from "node:child_process";
import { diffRun, Mlflow } from "../meeting-v2/eval/lab/ledger.mts";
import { repoRoot } from "../meeting-v2/eval/runtime.mts";

/** The spec names no experiment for the chat eval; this follows `openstyle-lab-<stage>`. */
export const EXPERIMENT = "openstyle-lab-chat-agent-p0";

export function chatMlflowUri(): string {
  const u = (
    process.env.CHAT_EVAL_MLFLOW_URI ||
    process.env.LAB_MLFLOW_URI ||
    process.env.SILVER_MLFLOW_URI ||
    process.env.OKTO_NEURON_MLFLOW_TRACKING_URI ||
    process.env.MLFLOW_TRACKING_URI ||
    ""
  ).trim();
  if (!/^https?:\/\//.test(u))
    throw new Error(
      "set CHAT_EVAL_MLFLOW_URI (or LAB_MLFLOW_URI) to the MLflow server (http://host:port)",
    );
  return u.replace(/\/+$/, "");
}

export function gitTags(): Record<string, string> {
  const git = (...a: string[]) =>
    spawnSync("git", a, { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  return {
    "chat.git_sha": git("rev-parse", "HEAD"),
    "chat.git_branch": git("rev-parse", "--abbrev-ref", "HEAD"),
    "chat.git_dirty": git("status", "--porcelain", "--", "scripts", "apps").length > 0 ? "true" : "false",
  };
}

const num = (x: number) => Math.round(x * 1e6) / 1e6;

/** Log one run, then read it back. Throws when the server lost or changed a value. */
export async function logRun(
  name: string,
  params: Record<string, string | number | boolean>,
  tags: Record<string, string>,
  metrics: Record<string, number>,
): Promise<{ runId: string; experiment: string; n: number }> {
  const ml = new Mlflow(chatMlflowUri());
  const exp = (await ml.experimentId(EXPERIMENT)) as string;
  const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const t = { ...gitTags(), ...tags };
  const m: Record<string, number> = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (Number.isFinite(v)) m[k.replace(/[^A-Za-z0-9_\-. /]/g, "_")] = num(v);
  }
  const runId = await ml.createRun(exp, name, t);
  await ml.logBatch(runId, p, {}, m);
  await ml.endRun(runId, "FINISHED");
  const got = await ml.getRun(runId);
  const bad = diffRun(got, { params: p, tags: t, metrics: m, status: "FINISHED" });
  if (bad.length > 0) {
    await ml.endRun(runId, "FAILED");
    throw new Error(`MLflow read-back of run ${runId} differs: ${bad.slice(0, 5).join(", ")}`);
  }
  return { runId, experiment: EXPERIMENT, n: Object.keys(m).length };
}
