// check-summary.mts — automatic pre-merge check of a stored meeting summary
// (specs/meeting-enhance-agentic.md section 4.5.6, decision Q11).
//
// Reads the `meeting_summaries` row (`markdown`, `summary_json`) of one
// meeting from a database, read-only, and runs five checks:
//   1. The Markdown holds the five headings of `renderSummaryMarkdown`, in order.
//   2. `overview` is not blank.
//   3. For each list, the count of list lines equals the array length in
//      `summary_json` ("None." = 0).
//   4. No Markdown line except the five headings starts with "#".
//   5. `summary_json` parses, passes the field types, and equals the object
//      the Markdown was rendered from.
// This file keeps its own copy of the render format on purpose. WP6 test SW3
// compares the stored Markdown with the real function, so a drift in either
// copy fails loudly.
//
// Old arm (`--arm old`): the old Markdown has four sections and `summary_json`
// is NULL. The tool counts from the Markdown only and gates nothing.
//
// Usage (from the repo root):
//   pnpm meeting:check-summary --db <db> --meeting <id> --arm <old|new> --out <metrics.json>
//
// It prints one line of JSON with numbers and booleans only, never meeting
// text. Exit codes: 0 pass; 1 a check failed; 2 wrong usage or unreadable
// database or row.

import { writeFileSync } from "node:fs";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const HEADINGS = [
  "## Overview",
  "## Key Points",
  "## Decisions",
  "## Action Items",
  "## Open Questions",
] as const;

interface ActionItem {
  task: string;
  owner: string | null;
  due: string | null;
}
interface Summary {
  overview: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: ActionItem[];
  openQuestions: string[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const dbPath = arg("db");
const meetingId = arg("meeting");
const arm = arg("arm");
const outPath = arg("out");
if (!dbPath || !meetingId || !outPath || (arm !== "old" && arm !== "new")) {
  console.error(
    "usage: check-summary.mts --db <db> --meeting <id> --arm <old|new> --out <metrics.json>",
  );
  process.exit(2);
}

// --- Own copy of the render format (4.5.6) --------------------------------
const oneLine = (s: string): string => s.replace(/\r?\n|\r/g, " ");
const paragraphs = (s: string): string =>
  s
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"))
    .join("\n");
function render(s: Summary): string {
  const list = (a: string[]): string =>
    a.length ? a.map((t) => `- ${oneLine(t)}`).join("\n") : "None.";
  const act = s.actionItems.map((a) => {
    const meta = [
      a.owner && `Owner: ${oneLine(a.owner)}`,
      a.due && `Due: ${oneLine(a.due)}`,
    ].filter(Boolean);
    return `- ${oneLine(a.task)}${meta.length ? ` (${meta.join("; ")})` : ""}`;
  });
  return [
    `## Overview\n${paragraphs(s.overview)}`,
    `## Key Points\n${list(s.keyPoints)}`,
    `## Decisions\n${list(s.decisions)}`,
    `## Action Items\n${act.length ? act.join("\n") : "None."}`,
    `## Open Questions\n${list(s.openQuestions)}`,
  ].join("\n\n");
}

// --- Field types of 4.5.1 -------------------------------------------------
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
function parseSummary(json: string | null): Summary | null {
  if (json === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.overview !== "string" ||
    !isStrings(o.keyPoints) ||
    !isStrings(o.decisions) ||
    !isStrings(o.openQuestions) ||
    !Array.isArray(o.actionItems)
  )
    return null;
  for (const a of o.actionItems) {
    if (typeof a !== "object" || a === null) return null;
    const r = a as Record<string, unknown>;
    if (
      typeof r.task !== "string" ||
      !isNullableString(r.owner) ||
      !isNullableString(r.due)
    )
      return null;
  }
  return o as unknown as Summary;
}

// --- Markdown counting ------------------------------------------------------
/** Lines of each "## " section, keyed by the heading line. */
function sections(lines: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      cur = [];
      map.set(line, cur);
    } else if (cur) cur.push(line);
  }
  return map;
}
const countBullets = (body: string[] | undefined): number =>
  body ? body.filter((l) => l.startsWith("- ")).length : 0;

// --- Read the row -----------------------------------------------------------
let markdown: string;
let summaryJson: string | null;
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const cols = db
    .prepare("PRAGMA table_info(meeting_summaries)")
    .all() as unknown as { name: string }[];
  const hasJson = cols.some((c) => c.name === "summary_json");
  const row = db
    .prepare(
      `SELECT markdown, ${hasJson ? "summary_json" : "NULL AS summary_json"}
       FROM meeting_summaries WHERE meeting_id = ?`,
    )
    .get(meetingId) as
    | { markdown: string | null; summary_json: string | null }
    | undefined;
  db.close();
  if (!row || row.markdown === null) {
    console.error("no meeting_summaries row with Markdown for this meeting");
    process.exit(2);
  }
  markdown = row.markdown;
  summaryJson = row.summary_json;
} catch (e) {
  console.error(`cannot read the database: ${(e as Error).message}`);
  process.exit(2);
}

const lines = markdown.split("\n");
const sec = sections(lines);
const expectedHeadings = arm === "new" ? HEADINGS : HEADINGS.slice(0, 4);
const headingSet = new Set<string>(expectedHeadings);
const hashLines = lines.filter((l) => l.startsWith("#"));
const headingLines = hashLines.filter((l) => headingSet.has(l));
const strayHashLines = hashLines.length - headingLines.length;
const headingsInOrder =
  headingLines.length === expectedHeadings.length &&
  expectedHeadings.every((h, i) => headingLines[i] === h);

const counts = {
  summaryKeyPoints: countBullets(sec.get("## Key Points")),
  summaryDecisions: countBullets(sec.get("## Decisions")),
  summaryActionItems: countBullets(sec.get("## Action Items")),
  summaryOpenQuestions:
    arm === "new" ? countBullets(sec.get("## Open Questions")) : null,
};
const base = {
  arm,
  headingsInOrder,
  strayHashLines,
  summarySections: sec.size,
  ...counts,
  summaryChars: markdown.length,
};

let result: Record<string, unknown>;
let pass: boolean;
if (arm === "new") {
  const s = parseSummary(summaryJson);
  const overviewNonBlank = s !== null && s.overview.trim().length > 0;
  const listCountsMatch =
    s !== null &&
    counts.summaryKeyPoints === s.keyPoints.length &&
    counts.summaryDecisions === s.decisions.length &&
    counts.summaryActionItems === s.actionItems.length &&
    counts.summaryOpenQuestions === s.openQuestions.length;
  const summaryRenderMatches = s !== null && render(s) === markdown;
  pass =
    headingsInOrder &&
    overviewNonBlank &&
    listCountsMatch &&
    strayHashLines === 0 &&
    summaryRenderMatches;
  result = {
    arm,
    headingsInOrder,
    overviewNonBlank,
    listCountsMatch,
    strayHashLines,
    summaryRenderMatches,
    summarySections: base.summarySections,
    summaryKeyPoints: counts.summaryKeyPoints,
    summaryDecisions: counts.summaryDecisions,
    summaryActionItems: counts.summaryActionItems,
    summaryOpenQuestions: counts.summaryOpenQuestions,
    summaryChars: base.summaryChars,
    pass,
  };
} else {
  // Old arm: measured, not gated. Checks 3 and 5 need `summary_json`: null.
  pass = true;
  const overview = sec.get("## Overview") ?? [];
  result = {
    arm,
    headingsInOrder,
    overviewNonBlank: overview.join("").trim().length > 0,
    listCountsMatch: null,
    strayHashLines,
    summaryRenderMatches: null,
    summarySections: base.summarySections,
    summaryKeyPoints: counts.summaryKeyPoints,
    summaryDecisions: counts.summaryDecisions,
    summaryActionItems: counts.summaryActionItems,
    summaryOpenQuestions: null,
    summaryChars: base.summaryChars,
    pass: null,
  };
}

const json = JSON.stringify(result);
writeFileSync(outPath, `${json}\n`);
console.log(json);
process.exit(pass ? 0 : 1);
