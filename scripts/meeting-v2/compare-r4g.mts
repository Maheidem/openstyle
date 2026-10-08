// Regenerate the
// R0d-vs-R4g compare files. The R0d side is rebuilt offline exactly as for
// R0d-vs-R4: R0 chunk boundaries/text (the r3a dump — R3a == R0 output)
// plus the old winner-overlap labels computed on the stored diarizer
// turns. Chunks are aligned by DP (identical = same start/end/text/label);
// changed = total chunk lines in the diff regions. Writes markdown only;
// prints path + line count + change count (never transcript text).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { assignSpeakerLabels, sanitizeDiarizerTurns } = await import(
  "../../apps/server/src/lib/meetings/diarize.js"
);

// The scratch compare dir (dumps live there; section 7 of the spec).
const cmp = process.env.MEETING_CMP_DIR ?? "/tmp/meeting-v2/compare";
// id8 pairs, from argv (default: the two original proof meetings).
const meetings = (
  process.argv.length > 2 ? process.argv.slice(2) : ["2943c36a", "9243bea0"]
).map((s) => [s, s] as const);

type Chunk = {
  source: string;
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  label: string | null;
};

const key = (c: Chunk) =>
  `${c.source}|${c.start_ms}|${c.end_ms}|${c.text}|${c.label ?? "-"}`;

/** DP alignment: returns pairs [i0, j0, i1, j1] where equal chunks matched.
 * Simpler: build the match matrix and walk it (edit distance, gap cost 1). */
function align(a: Chunk[], b: Chunk[]): Array<[number | null, number | null]> {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = min cost aligning a[0..i), b[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = 0; i <= n; i++) dp[i]![0] = i;
  for (let j = 0; j <= m; j++) dp[0]![j] = j;
  const ka = a.map(key);
  const kb = b.map(key);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = ka[i - 1] === kb[j - 1];
      dp[i]![j] = Math.min(
        dp[i - 1]![j - 1]! + (same ? 0 : 1), // match/substitute
        dp[i - 1]![j]! + 1, // delete a[i-1]
        dp[i]![j - 1]! + 1, // insert b[j-1]
      );
    }
  }
  const out: Array<[number | null, number | null]> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      dp[i]![j]! === dp[i - 1]![j - 1]! + (ka[i - 1] === kb[j - 1] ? 0 : 1)
    ) {
      // match or substitute, following the DP table
      out.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (i > 0 && dp[i]![j]! === dp[i - 1]![j]! + 1) {
      out.unshift([i - 1, null]);
      i--;
    } else {
      out.unshift([null, j - 1]);
      j--;
    }
  }
  return out;
}

let selfCheckFailures = 0;
for (const [short] of meetings) {
  const r0Raw = JSON.parse(
    readFileSync(join(cmp, `r3a-${short}.json`), "utf8"),
  );
  // The R4g side must come from the R4g run's OWN stored rows (council
  // bug, 2026-10-07: this line used to read r4e-<id>.json — the stale
  // R4e dump — because the copy of compare-r4e.mts only replaced the
  // literal "compare/r4e-" and this line builds the name with join()).
  const r4bRaw = JSON.parse(
    readFileSync(join(cmp, `r4g-${short}.json`), "utf8"),
  );
  const turnRows = JSON.parse(
    readFileSync(join(cmp, `turns-${short}.json`), "utf8"),
  );
  const turns = sanitizeDiarizerTurns(
    turnRows.map((t) => ({
      speakerId: t.speaker_id,
      startTimeSeconds: t.start_ms / 1000,
      endTimeSeconds: t.end_ms / 1000,
    })),
  );
  if (!turns) throw new Error(`no turns for ${short}`);

  // Simpler: rebuild maps keyed by source:idx
  const mkRebuilt = (raw: typeof r0Raw) => {
    // R0d side: the old pipeline is gone from the code, so the labels
    // are rebuilt with the old winner-overlap rule on the stored turns.
    // MIC chunks are never labeled by the app (diarize.ts:
    // "system-channel-only") — the rebuild shows them as no label.
    const asg = assignSpeakerLabels(
      raw.map((c) => ({
        id: `${c.source}:${c.idx}`,
        startMs: c.start_ms,
        endMs: c.end_ms,
      })),
      turns,
    );
    const byId = new Map(asg.map((l) => [l.id, l]));
    return raw.map((c) => ({
      source: c.source,
      idx: c.idx,
      start_ms: c.start_ms,
      end_ms: c.end_ms,
      text: c.text,
      label:
        c.source === "mic"
          ? null
          : (byId.get(`${c.source}:${c.idx}`)?.speakerLabel ?? null),
    }));
  };
  const mkStored = (raw: typeof r0Raw) => {
    // The new run's side: the run's OWN stored labels (the split parts
    // share the original chunk idx, so a per-idx rebuild would give
    // both parts the same label — the review bug in the old compare).
    return raw.map((c) => ({
      source: c.source,
      idx: c.idx,
      start_ms: c.start_ms,
      end_ms: c.end_ms,
      text: c.text,
      label: (c as { speaker_label?: string | null }).speaker_label ?? null,
    }));
  };
  const r0 = mkRebuilt(r0Raw);
  const r4b = mkStored(r4bRaw);

  // Self-check (council, 2026-10-07): the rendered R4g side must equal
  // the r4g-<id>.json dump EXACTLY on (source, idx, start, end, label)
  // for every row. The reference is re-read INDEPENDENTLY from disk, so
  // a stale dump (e.g. the r4e file) or a wrong path is caught. Exits
  // non-zero on failure; no compare file is written for a bad side.
  {
    const ref = JSON.parse(
      readFileSync(join(cmp, `r4g-${short}.json`), "utf8"),
    );
    const refT = ref.map(
      (c: {
        source: string;
        idx: number;
        start_ms: number;
        end_ms: number;
        speaker_label?: string | null;
      }) =>
        `${c.source}|${c.idx}|${c.start_ms}|${c.end_ms}|${c.speaker_label ?? "-"}`,
    );
    const sideT = r4b.map(
      (c) => `${c.source}|${c.idx}|${c.start_ms}|${c.end_ms}|${c.label ?? "-"}`,
    );
    const bad = sideT
      .map((x, k) => (x !== refT[k] ? k : -1))
      .filter((k) => k >= 0);
    if (refT.length !== sideT.length || bad.length > 0) {
      selfCheckFailures += 1;
      const k = bad[0];
      console.error(
        `SELF-CHECK FAIL ${short}: rendered side != r4g-${short}.json (${sideT.length} vs ${refT.length} rows` +
          (k !== undefined
            ? `; first mismatch row ${k}: side idx=${r4b[k]!.idx} ref idx=${ref[k]!.idx})`
            : ")"),
      );
      continue; // do not write a compare file from a bad side
    }
    console.log(
      `self-check ${short}: OK (${refT.length} rows match r4g-${short}.json)`,
    );
  }

  const pairs = align(r0, r4b);
  let labelOnly = 0;
  const lines: string[] = [];
  let changed = 0;
  for (const [ia, jb] of pairs) {
    const a = ia === null ? null : r0[ia];
    const b = jb === null ? null : r4b[jb];
    const same = a !== null && b !== null && key(a) === key(b);
    if (same) continue;
    changed += 1;
    if (
      a !== null &&
      b !== null &&
      a.source === b.source &&
      a.start_ms === b.start_ms &&
      a.end_ms === b.end_ms &&
      a.text === b.text
    ) {
      labelOnly += 1;
    }
    if (b) {
      lines.push(
        `- [R4g] ${b.source} #${b.idx} ${b.start_ms}-${b.end_ms}ms speaker=${b.label ?? "-"} status=ok`,
      );
      lines.push(`  ${b.text}`);
    }
    if (a) {
      lines.push(
        `- [R0d] ${a.source} #${a.idx} ${a.start_ms}-${a.end_ms}ms speaker=${a.label ?? "-"} status=ok`,
      );
      lines.push(`  ${a.text}`);
    }
  }
  const sys0 = r0.filter((c) => c.source === "system").length;
  const sys4 = r4b.filter((c) => c.source === "system").length;
  const header = [
    `# R0d vs R4g — meeting ${short}`,
    "",
    `R0d chunks: ${r0.length} (system ${sys0})   R4g chunks: ${r4b.length} (system ${sys4})   changed: ${changed}`,
    "",
    ...(changed ? lines : ["No changed chunks."]),
    "",
  ];
  const out = join(cmp, `R0d-vs-R4g-${short}.md`);
  writeFileSync(out, header.join("\n"));
  console.log(
    `wrote ${out} (${header.length} lines), changed: ${changed}, label-only: ${labelOnly}`,
  );
}
if (selfCheckFailures > 0) {
  console.error(`self-check: ${selfCheckFailures} meeting(s) failed`);
  process.exit(1);
}
