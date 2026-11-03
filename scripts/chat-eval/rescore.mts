/**
 * `pnpm chat-eval rescore [--no-mlflow] <result.json...>` (2026-11-03).
 *
 * Scores the saved dig answers again with the fixed pass rule (the blind keys
 * write 2 of 3 as minCov 0.67, and 2/3 < 0.67: `TWO_THIRDS` guard, as in the
 * original set). The answers and the keys do not change. Only the threshold
 * changes. Each re-score is logged to MLflow with the tag `rescore_of=<run id>`.
 *
 * The output of the set `final` is the summary line only: no row, no turn id.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Mlflow } from "../meeting-v2/eval/lab/ledger.mts";
import { buildHeldoutDig, type DigSetName } from "./dig-heldout.mts";
import { chatMlflowUri, EXPERIMENT_P1, logRun } from "./mlflow.mts";
import {
  buildDig,
  type DigQ,
  type DigRow,
  summarizeDig,
  TWO_THIRDS,
} from "./p1-dig.mts";

interface DigPart {
  data: { rows: DigRow[]; metrics: Record<string, number> };
  run: {
    name: string;
    params: Record<string, string | number | boolean>;
    tags: Record<string, string>;
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The pass rule of `runDig`, with the minCov of the key as given. */
function passOf(r: DigRow, minCov: number, wantN: number): boolean {
  const cov = r.covOf === 0 ? 1 : r.covHit / r.covOf;
  const recallOk = r.recall === null || wantN < 2 || r.recall >= 0.5;
  return (
    !r.err &&
    !r.notFound &&
    !r.clarify &&
    cov >= minCov &&
    r.forbidden === 0 &&
    recallOk &&
    r.invalidCites === 0 &&
    r.uncited === 0 &&
    !r.repeat &&
    r.lenOk
  );
}

/** The run of the original file: same name, model and pass rate, nearest start. */
async function findOriginal(
  ml: Mlflow,
  expId: string,
  p: DigPart,
  fileMs: number,
): Promise<string> {
  const model = p.run.tags.model ?? "";
  const arm = p.run.tags["chat.arm"] ?? "";
  const runs = await ml.searchRuns(
    [expId],
    `tags.\`chat.arm\` = '${arm}' and tags.model = '${model}'`,
  );
  const same = runs.filter(
    (r) =>
      !r.tags.rescore_of &&
      r.name === p.run.name &&
      Math.abs((r.metrics.pass ?? -1) - (p.data.metrics.pass ?? -2)) < 1e-6 &&
      (r.tags.backend ?? "") === (p.run.tags.backend ?? ""),
  );
  same.sort((a, b) => Math.abs(a.start - fileMs) - Math.abs(b.start - fileMs));
  return same[0]?.id ?? "unknown";
}

export async function runRescore(files: string[], mlflow: boolean) {
  const ml = mlflow ? new Mlflow(chatMlflowUri()) : null;
  const expId = ml ? ((await ml.experimentId(EXPERIMENT_P1)) as string) : "";
  for (const f of files) {
    const res = JSON.parse(readFileSync(f, "utf8")) as {
      parts?: Record<string, DigPart>;
    };
    const p = res.parts?.dig;
    if (!p) {
      console.log(`${basename(f)}: no dig part, skipped`);
      continue;
    }
    const m = /^p1-dig(?:-(heldout|dev|final))?$/.exec(p.run.name);
    if (!m) {
      console.log(`${basename(f)}: run name ${p.run.name} not known, skipped`);
      continue;
    }
    const set = (m[1] ?? "original") as DigSetName | "original";
    const qs: DigQ[] =
      set === "original" ? buildDig() : buildHeldoutDig(set as DigSetName);
    const key = new Map(qs.map((q) => [q.id, q]));
    const blind = set !== "original";
    const rows = res.parts?.dig?.data.rows ?? [];
    const out: DigRow[] = [];
    const changed: string[] = [];
    let drift = 0;
    for (const r of rows) {
      const t = key.get(r.id)?.turns[r.turn - 1];
      if (!t)
        throw new Error(`${basename(f)}: no key for ${r.id} turn ${r.turn}`);
      // The raw minCov (0.67) is what the old loader gave.
      const raw = t.minCov === TWO_THIRDS && blind ? 0.67 : t.minCov;
      const oldPass = passOf(r, raw, t.meetings.length);
      if (oldPass !== r.pass) drift++;
      const pass = passOf(r, t.minCov, t.meetings.length);
      if (pass !== r.pass) changed.push(`${r.id}t${r.turn}`);
      out.push({
        ...r,
        pass,
        tokens: r.tokens ?? {
          in: 0,
          out: 0,
          cached: 0,
          cacheWrite: 0,
          reasoning: 0,
        },
        usd: r.usd ?? 0,
      });
    }
    const oldM = summarizeDig(
      rows.map((r) => ({
        ...r,
        tokens: r.tokens ?? {
          in: 0,
          out: 0,
          cached: 0,
          cacheWrite: 0,
          reasoning: 0,
        },
        usd: r.usd ?? 0,
      })),
    );
    const newM = summarizeDig(out);
    const dig = (rs: DigRow[]) =>
      rs.filter((r) => !r.control && r.kind !== "fact");
    const nOld = dig(rows).filter((r) => r.pass).length;
    const nNew = dig(out).filter((r) => r.pass).length;
    const tags = p.run.tags;
    let line = `${basename(f)} | model ${tags.model} | backend ${tags.backend} | set ${set} | digging turns ${dig(out).length} | old pass ${pct(oldM.pass as number)} (${nOld}) | new pass ${pct(newM.pass as number)} (${nNew}) | changed turns ${changed.length}`;
    // Rows are never printed for the final set, and no turn id either.
    if (set !== "final") line += ` (${changed.join(",") || "none"})`;
    line += ` | old-rule drift ${drift}`;
    if (ml) {
      const orig = await findOriginal(ml, expId, p, statSync(f).mtimeMs);
      const r = await logRun(
        `${p.run.name}-rescore`,
        { ...p.run.params, rescore_file: basename(f) },
        { ...tags, rescore_of: orig, "chat.rescore": "minCov-two-thirds" },
        newM,
        EXPERIMENT_P1,
      );
      line += ` | rescore_of ${orig} | new run ${r.runId}`;
    }
    console.log(line);
  }
}
