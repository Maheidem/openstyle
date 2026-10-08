// compare.mts — the one committed meeting run-compare tool (PR #34).
//
// Replaces the copy-edited per-run compare scripts (compare-r4f.mts,
// compare-r4g.mts, ...): the run names are CLI arguments, so a stale
// `r4e-` path can no longer survive a copy (council bug, 2026-10-07: three
// false findings came from exactly that). The pure diff/self-check logic
// lives in apps/server/src/lib/meetings/compare-rows.ts (unit tested).
//
// Usage (from the repo root; the --import registers the .js→.ts resolver
// the server source needs under Node type stripping):
//   node --import ./scripts/meeting-v2/ts-register.mjs scripts/meeting-v2/compare.mts \
//     --from R4f --to R4g --meeting all [--out-dir <dir>] [--only-changed]
//
// Stored dumps (default dir /tmp/meeting-v2/compare, override with the
// MEETING_CMP_DIR env var):
//   <run-lowercase>-<id8>.json  the run's meeting_segments rows
//   turns-<id8>.json            the diarizer turns (needed by R0d)
//
// The R0d special case: R0d was the R0 output plus the diarizer labels,
// and the old pipeline is gone from the code — so the R0d side is rebuilt
// OFFLINE from the r3a dump (R3a == R0 output: same chunks) plus the
// stored turns with assignSpeakerLabels, and MIC chunks are never
// labeled (the app labels the system channel only).
//
// Self-check (meeting-benchmarks skill, "Compare tools must check
// themselves"): for BOTH sides this tool re-reads the stored dump from
// disk INDEPENDENTLY and asserts (source, idx, start_ms, end_ms,
// speaker_label) of every rendered row equals it. On a mismatch it exits
// 1 and writes nothing.
//
// Output: <FROM>-vs-<TO>-<id8>.md in --out-dir (default: the dump dir),
// byte-identical format to the old compare-r4g.mts files. Prints paths,
// counts and statuses only — never transcript text.
//
// Exit codes: 0 ok; 1 self-check failure or missing dump; 2 usage.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  type CompareRow,
  renderCompare,
  type SelfCheckResult,
  selfCheckSide,
} from "../../apps/server/src/lib/meetings/compare-rows.ts";
import {
  assignSpeakerLabels,
  sanitizeDiarizerTurns,
} from "../../apps/server/src/lib/meetings/diarize.ts";

// --- CLI ------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const fromRun = arg("from");
const toRun = arg("to");
const meetingArg = arg("meeting");
const outDirArg = arg("out-dir");
const onlyChanged = process.argv.includes("--only-changed");

if (!fromRun || !toRun || !meetingArg) {
  console.error(
    "usage: compare.mts --from <RUN> --to <RUN> --meeting <id8|uuid|all> [--out-dir <dir>] [--only-changed]",
  );
  process.exit(2);
}
const dumpDir = process.env.MEETING_CMP_DIR ?? "/tmp/meeting-v2/compare";
const outDir = outDirArg ?? dumpDir;

const id8Of = (s: string) => (s.includes("-") ? s.slice(0, 8) : s);

// --- Dumps ----------------------------------------------------------------

/** One stored meeting_segments row (the dump JSON). */
interface DumpRow {
  source: string;
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker_label?: string | null;
}

const toStoredRow = (c: DumpRow): CompareRow => ({
  source: c.source,
  idx: c.idx,
  start_ms: c.start_ms,
  end_ms: c.end_ms,
  text: c.text,
  label: c.speaker_label ?? null,
});

/** Rebuild the R0d rows: r3a chunks + winner-overlap labels on the turns. */
function rebuildR0d(rows: DumpRow[], turnRows: unknown[]): CompareRow[] {
  const turns = sanitizeDiarizerTurns(
    (
      turnRows as Array<{
        speaker_id: string;
        start_ms: number;
        end_ms: number;
      }>
    ).map((t) => ({
      speakerId: t.speaker_id,
      startTimeSeconds: t.start_ms / 1000,
      endTimeSeconds: t.end_ms / 1000,
    })),
  );
  if (!turns) throw new Error("no usable diarizer turns in the turns dump");
  const asg = assignSpeakerLabels(
    rows.map((c) => ({
      id: `${c.source}:${c.idx}`,
      startMs: c.start_ms,
      endMs: c.end_ms,
    })),
    turns,
  );
  const byId = new Map(asg.map((l) => [l.id, l]));
  return rows.map((c) => ({
    source: c.source,
    idx: c.idx,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    text: c.text,
    // MIC chunks are never labeled by the app (system-channel-only).
    label:
      c.source === "mic"
        ? null
        : (byId.get(`${c.source}:${c.idx}`)?.speakerLabel ?? null),
  }));
}

const dumpBase = (run: string) =>
  run.toLowerCase() === "r0d" ? "r3a" : run.toLowerCase();

function dumpFiles(run: string, id8: string): string[] {
  const files = [join(dumpDir, `${dumpBase(run)}-${id8}.json`)];
  if (run.toLowerCase() === "r0d")
    files.push(join(dumpDir, `turns-${id8}.json`));
  return files;
}

/** Read the side's rows from its dump(s). Throws with a clear message on a
 * missing file (a copy-edited stale path is the bug this tool exists for). */
function loadSide(run: string, id8: string): CompareRow[] {
  for (const f of dumpFiles(run, id8)) {
    if (!existsSync(f)) {
      throw new Error(`missing dump ${f} for run ${run} (id8 ${id8})`);
    }
  }
  if (run.toLowerCase() === "r0d") {
    const rows = JSON.parse(
      readFileSync(join(dumpDir, `r3a-${id8}.json`), "utf8"),
    ) as DumpRow[];
    const turnRows = JSON.parse(
      readFileSync(join(dumpDir, `turns-${id8}.json`), "utf8"),
    ) as unknown[];
    return rebuildR0d(rows, turnRows);
  }
  const rows = JSON.parse(
    readFileSync(join(dumpDir, `${dumpBase(run)}-${id8}.json`), "utf8"),
  ) as DumpRow[];
  return rows.map(toStoredRow);
}

/** Re-read the side's dump(s) INDEPENDENTLY for the self-check reference. */
function loadReference(run: string, id8: string): CompareRow[] {
  if (run.toLowerCase() === "r0d") {
    const rows = JSON.parse(
      readFileSync(join(dumpDir, `r3a-${id8}.json`), "utf8"),
    ) as DumpRow[];
    const turnRows = JSON.parse(
      readFileSync(join(dumpDir, `turns-${id8}.json`), "utf8"),
    ) as unknown[];
    return rebuildR0d(rows, turnRows);
  }
  return (
    JSON.parse(
      readFileSync(join(dumpDir, `${dumpBase(run)}-${id8}.json`), "utf8"),
    ) as DumpRow[]
  ).map(toStoredRow);
}

// --- Meetings ---------------------------------------------------------------

let ids: string[];
if (meetingArg === "all") {
  const reFrom = new RegExp(`^${dumpBase(fromRun)}-([0-9a-f]{8})\\.json$`);
  const reTo = new RegExp(`^${dumpBase(toRun)}-([0-9a-f]{8})\\.json$`);
  const reTurns = /^turns-([0-9a-f]{8})\.json$/;
  const files = readdirSync(dumpDir);
  const fromIds = new Set(
    files.map((f) => f.match(reFrom)?.[1]).filter((x): x is string => !!x),
  );
  const toIds = new Set(
    files.map((f) => f.match(reTo)?.[1]).filter((x): x is string => !!x),
  );
  const turnsIds = new Set(
    files.map((f) => f.match(reTurns)?.[1]).filter((x): x is string => !!x),
  );
  ids = [...fromIds]
    .filter(
      (id) =>
        toIds.has(id) && (toRun.toLowerCase() !== "r0d" || turnsIds.has(id)),
    )
    .filter((id) => fromRun.toLowerCase() !== "r0d" || turnsIds.has(id))
    .sort();
  if (ids.length === 0) {
    console.error(
      `no meetings have dumps for both ${fromRun} and ${toRun} in ${dumpDir}`,
    );
    process.exit(1);
  }
} else {
  ids = [id8Of(meetingArg)];
}

// --- Self-check BOTH sides BEFORE writing anything -------------------------

const systemCounts =
  fromRun.toLowerCase() === "r0d" || toRun.toLowerCase() === "r0d";

interface Side {
  rows: CompareRow[];
  check: SelfCheckResult;
}
const sides = new Map<string, { from: Side; to: Side }>();
let failures = 0;
for (const id8 of ids) {
  let from: CompareRow[];
  let to: CompareRow[];
  try {
    from = loadSide(fromRun, id8);
    to = loadSide(toRun, id8);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${id8}: ${(err as Error).message}`);
    continue;
  }
  const checkFrom = selfCheckSide(from, loadReference(fromRun, id8));
  const checkTo = selfCheckSide(to, loadReference(toRun, id8));
  sides.set(id8, {
    from: { rows: from, check: checkFrom },
    to: { rows: to, check: checkTo },
  });
  if (!checkFrom.ok) {
    failures += 1;
    console.error(
      `SELF-CHECK FAIL ${id8}: rendered ${fromRun} side != ${dumpBase(fromRun)}-${id8}.json ` +
        `(${checkFrom.renderedCount} vs ${checkFrom.refCount} rows` +
        (checkFrom.firstMismatch !== null
          ? `; first mismatch row ${checkFrom.firstMismatch}`
          : "") +
        ")",
    );
  }
  if (!checkTo.ok) {
    failures += 1;
    console.error(
      `SELF-CHECK FAIL ${id8}: rendered ${toRun} side != ${dumpBase(toRun)}-${id8}.json ` +
        `(${checkTo.renderedCount} vs ${checkTo.refCount} rows` +
        (checkTo.firstMismatch !== null
          ? `; first mismatch row ${checkTo.firstMismatch}`
          : "") +
        ")",
    );
  }
}
if (failures > 0) {
  console.error(`self-check: ${failures} side(s) failed; nothing written`);
  process.exit(1);
}

// --- Render and write --------------------------------------------------------

mkdirSync(outDir, { recursive: true });
for (const id8 of ids) {
  const side = sides.get(id8)!;
  const { markdown, changed, labelOnly } = renderCompare({
    fromName: fromRun,
    toName: toRun,
    meetingId8: id8,
    from: side.from.rows,
    to: side.to.rows,
    systemCounts,
  });
  if (onlyChanged && changed === 0) {
    console.log(`skip ${id8}: no changed chunks`);
    continue;
  }
  const out = join(outDir, `${fromRun}-vs-${toRun}-${id8}.md`);
  writeFileSync(out, markdown);
  console.log(
    `self-check ${id8}: OK (${side.from.check.refCount} rows match ${dumpBase(fromRun)}-${id8}.json; ` +
      `${side.to.check.refCount} rows match ${dumpBase(toRun)}-${id8}.json)`,
  );
  console.log(
    `wrote ${out} (${markdown.split("\n").length} lines), changed: ${changed}, label-only: ${labelOnly}`,
  );
}
