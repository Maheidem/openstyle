/**
 * Pure helpers for the meeting run-compare tool
 * (`scripts/meeting-v2/compare.mts`, PR #34).
 *
 * The compare tool renders the changed chunks of two runs (the `from` run
 * and the `to` run) of the same meeting into markdown. Everything that is
 * not file I/O lives here so it is unit-testable without a database or the
 * scratch profile.
 *
 * The self-check contract (council, 2026-10-07, meeting-benchmarks skill):
 * for BOTH sides the rendered rows must equal the run's stored dump
 * EXACTLY on (source, idx, start_ms, end_ms, speaker_label) for every row.
 * On a mismatch the tool exits non-zero and writes nothing. The 2026-10-07
 * false findings came from a copy-edited compare script that kept a stale
 * dump path; `selfCheckSide` is the guard that catches that class of bug.
 */

/** One rendered chunk row (the dump fields plus the resolved label). */
export interface CompareRow {
  source: string;
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  label: string | null;
}

/**
 * Alignment identity key: two chunks are "equal" (not a change) when their
 * source, boundaries, text and label all match. The idx is NOT part of the
 * key: split parts share the original chunk idx, so an idx would hide
 * label changes inside a split.
 */
export function rowKey(c: CompareRow): string {
  return `${c.source}|${c.start_ms}|${c.end_ms}|${c.text}|${c.label ?? "-"}`;
}

/** The self-check tuple: (source, idx, start_ms, end_ms, speaker_label). */
export function rowSignature(c: CompareRow): string {
  return `${c.source}|${c.idx}|${c.start_ms}|${c.end_ms}|${c.label ?? "-"}`;
}

export interface SelfCheckResult {
  ok: boolean;
  renderedCount: number;
  refCount: number;
  /** Index of the first rendered row whose tuple differs (or length gap). */
  firstMismatch: number | null;
}

/**
 * The compare self-check. `reference` is the side re-read INDEPENDENTLY
 * from the stored dump (see the contract at the top of this file).
 */
export function selfCheckSide(
  rendered: CompareRow[],
  reference: CompareRow[],
): SelfCheckResult {
  let firstMismatch: number | null = null;
  for (let k = 0; k < rendered.length; k++) {
    if (
      k >= reference.length ||
      rowSignature(rendered[k]) !== rowSignature(reference[k])
    ) {
      firstMismatch = k;
      break;
    }
  }
  return {
    ok: firstMismatch === null && rendered.length === reference.length,
    renderedCount: rendered.length,
    refCount: reference.length,
    firstMismatch,
  };
}

/**
 * DP alignment (edit distance, gap cost 1) of the two row sets.
 * Returns one pair per step: [fromIndex, toIndex], null for a gap.
 * Deterministic: the backtrace prefers a match/substitute, then a deletion
 * of the from side, then an insertion from the to side.
 */
export function alignChunks(
  a: CompareRow[],
  b: CompareRow[],
): Array<[number | null, number | null]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = 0; i <= n; i++) dp[i]![0] = i;
  for (let j = 0; j <= m; j++) dp[0]![j] = j;
  const ka = a.map(rowKey);
  const kb = b.map(rowKey);
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

export interface CompareRender {
  markdown: string;
  changed: number;
  /** Changed pairs whose text/boundaries match and only the label differs. */
  labelOnly: number;
}

function systemCount(rows: CompareRow[]): number {
  return rows.filter((c) => c.source === "system").length;
}

/**
 * Render the compare markdown for one meeting. The format is byte-stable
 * (the council judges these files):
 *
 *   # <from> vs <to> — meeting <id8>
 *
 *   <from> chunks: N [(system K)]   <to> chunks: N [(system K)]   changed: C
 *
 *   - [<to>] source #idx start-endms speaker=label status=ok
 *     <text>
 *   - [<from>] ...
 *   (the `to` side of each changed pair first; "No changed chunks." when
 *   nothing changed)
 *
 * `systemCounts` adds the per-side system chunk count to the summary line
 * — the R0d-style files (where the R0d side is rebuilt from the r3a dump
 * plus the stored turns) carry it; the run-vs-run files do not.
 */
export function renderCompare(opts: {
  fromName: string;
  toName: string;
  meetingId8: string;
  from: CompareRow[];
  to: CompareRow[];
  systemCounts: boolean;
}): CompareRender {
  const { fromName, toName, meetingId8, from, to, systemCounts } = opts;
  const pairs = alignChunks(from, to);
  const lines: string[] = [];
  let changed = 0;
  let labelOnly = 0;
  for (const [ia, jb] of pairs) {
    const a = ia === null ? null : from[ia];
    const b = jb === null ? null : to[jb];
    if (a !== null && b !== null && rowKey(a) === rowKey(b)) continue;
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
        `- [${toName}] ${b.source} #${b.idx} ${b.start_ms}-${b.end_ms}ms speaker=${b.label ?? "-"} status=ok`,
      );
      lines.push(`  ${b.text}`);
    }
    if (a) {
      lines.push(
        `- [${fromName}] ${a.source} #${a.idx} ${a.start_ms}-${a.end_ms}ms speaker=${a.label ?? "-"} status=ok`,
      );
      lines.push(`  ${a.text}`);
    }
  }
  const summary = systemCounts
    ? `${fromName} chunks: ${from.length} (system ${systemCount(from)})   ${toName} chunks: ${to.length} (system ${systemCount(to)})   changed: ${changed}`
    : `${fromName} chunks: ${from.length}   ${toName} chunks: ${to.length}   changed: ${changed}`;
  const header = [
    `# ${fromName} vs ${toName} — meeting ${meetingId8}`,
    "",
    summary,
    "",
    ...(changed ? lines : ["No changed chunks."]),
    "",
  ];
  return { markdown: header.join("\n"), changed, labelOnly };
}
