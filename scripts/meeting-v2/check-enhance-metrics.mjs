// check-enhance-metrics.mjs — the numbers no other benchmark tool makes
// (specs/meeting-enhance-agentic.md 10.15). Reads the dumps of several runs
// of ONE arm on one meeting (made by dump-speakers.mjs) and prints:
//   hallucinatedKept  a kept speaker suggestion whose evidence quote is no
//                     substring of any segment `text` of the same dump
//                     (a kept suggestion with no quote counts too)
//   untypedFailures   failed chunks with no typed reason, read from the
//                     metrics-enhance.json that sits beside each dump
//   namedRuns         per label, in how many of the dumps it has a kept name
//
// Self-check ("Compare tools must check themselves", meeting-benchmarks
// skill): after it writes --out, it re-reads the dumps, the metrics files and
// the output from disk, recomputes the numbers with a second method, and
// compares. On any mismatch it deletes the output and exits 1.
//
// Usage:
//   node scripts/meeting-v2/check-enhance-metrics.mjs --dumps <d1> <d2> <d3> --out <file.json>
//
// It prints counts only, never names, quotes or transcript text.
// Exit codes: 0 ok; 1 self-check failure or unreadable input; 2 usage.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const di = argv.indexOf("--dumps");
const oi = argv.indexOf("--out");
const outPath = oi >= 0 ? argv[oi + 1] : undefined;
const dumps = [];
if (di >= 0) {
  for (let i = di + 1; i < argv.length && !argv[i].startsWith("--"); i += 1)
    dumps.push(argv[i]);
}
if (dumps.length === 0 || !outPath) {
  console.error(
    "usage: check-enhance-metrics.mjs --dumps <d1> [<d2> ...] --out <file.json>",
  );
  process.exit(2);
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Method 1: loops. */
function measure(paths) {
  let hallucinatedKept = 0;
  let untypedFailures = 0;
  const namedRuns = {};
  const hallucinatedKeptPerRun = [];
  for (const p of paths) {
    const dump = readJson(p);
    const texts = dump.segments.map((s) => norm(s.text ?? ""));
    let bad = 0;
    for (const sp of dump.speakers) {
      if (!sp.suggested_name?.trim()) continue; // not kept
      namedRuns[sp.label] = (namedRuns[sp.label] ?? 0) + 1;
      const q = norm(sp.suggested_evidence ?? "");
      if (q === "" || !texts.some((t) => t.includes(q))) bad += 1;
    }
    hallucinatedKept += bad;
    hallucinatedKeptPerRun.push(bad);
    const m = readJson(join(dirname(p), "metrics-enhance.json"));
    const typed = Object.entries(m.failureReasons ?? {})
      .filter(([k]) => k !== "unknown")
      .reduce((a, [, n]) => a + n, 0);
    untypedFailures += Math.max(0, m.chunksFailed - typed);
  }
  return {
    runs: paths.length,
    hallucinatedKept,
    hallucinatedKeptPerRun,
    untypedFailures,
    namedRuns,
  };
}

/** Method 2: filter and reduce, on a fresh read of every file. */
function remeasure(paths) {
  const all = paths.map((p) => ({
    d: readJson(p),
    m: readJson(join(dirname(p), "metrics-enhance.json")),
  }));
  const kept = all.map(({ d }) =>
    d.speakers.filter((s) => (s.suggested_name ?? "").trim() !== ""),
  );
  const perRun = kept.map(
    (ks, i) =>
      ks.filter((s) => {
        const q = norm(s.suggested_evidence ?? "");
        return (
          q === "" ||
          !all[i].d.segments.some((g) => norm(g.text ?? "").includes(q))
        );
      }).length,
  );
  const labels = [...new Set(kept.flat().map((s) => s.label))];
  return {
    runs: paths.length,
    hallucinatedKept: perRun.reduce((a, b) => a + b, 0),
    hallucinatedKeptPerRun: perRun,
    untypedFailures: all.reduce((a, { m }) => {
      const typed = Object.keys(m.failureReasons ?? {})
        .filter((k) => k !== "unknown")
        .reduce((x, k) => x + m.failureReasons[k], 0);
      return a + Math.max(0, m.chunksFailed - typed);
    }, 0),
    namedRuns: Object.fromEntries(
      labels.map((l) => [
        l,
        kept.filter((ks) => ks.some((s) => s.label === l)).length,
      ]),
    ),
  };
}

const canon = (o) =>
  JSON.stringify(o, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

try {
  const result = measure(dumps);
  writeFileSync(outPath, `${JSON.stringify(result, null, 1)}\n`);
  const back = readJson(outPath);
  const again = remeasure(dumps);
  if (canon(back) !== canon(again)) {
    rmSync(outPath, { force: true });
    console.error("SELF-CHECK FAILED: output differs from a fresh recount");
    process.exit(1);
  }
  console.log(
    `self-check ok: runs=${result.runs} hallucinatedKept=${result.hallucinatedKept} untypedFailures=${result.untypedFailures} labelsNamed=${Object.keys(result.namedRuns).length} -> ${outPath}`,
  );
} catch (e) {
  rmSync(outPath, { force: true });
  // Only the error class: a JSON parse message can quote file content.
  console.error(`check-enhance-metrics failed: ${e.code ?? e.name}`);
  process.exit(1);
}
