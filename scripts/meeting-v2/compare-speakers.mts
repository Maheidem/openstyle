// compare-speakers.mts — compare the speaker naming of two enhance runs
// (arm X vs arm Y) on the same transcript. Reads two dump files made by
// scripts/meeting-v2/dump-speakers.mjs.
//
// Per speaker label it renders: suggested name, kind and evidence (cut to
// 6 words) for both arms, then the changed enhanced_text lines (each quote
// cut to 6 words).
//
// Self-check ("Compare tools must check themselves", meeting-benchmarks
// skill): after it writes the file, the tool re-reads BOTH dumps from disk
// and the output file, parses every rendered label, name, kind and evidence
// back, and compares them with the dumps. On any mismatch it deletes the
// output and exits 1.
//
// Usage (from the repo root):
//   pnpm meeting:compare-speakers --x <dump> --y <dump> --x-name <A> \
//     --y-name <B> --out <file.md>
//
// It prints paths and counts only, never transcript text.
// Exit codes: 0 ok; 1 self-check failure or unreadable dump; 2 usage.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

interface Speaker {
  label: string;
  suggested_name: string | null;
  suggested_evidence: string | null;
  suggested_kind: string | null;
}
interface Segment {
  source: string;
  idx: number;
  speaker_label: string | null;
  text: string | null;
  enhanced_text: string | null;
}
interface Dump {
  speakers: Speaker[];
  segments: Segment[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const xPath = arg("x");
const yPath = arg("y");
const xName = arg("x-name");
const yName = arg("y-name");
const outPath = arg("out");
if (!xPath || !yPath || !xName || !yName || !outPath) {
  console.error(
    "usage: compare-speakers.mts --x <dump> --y <dump> --x-name <name> --y-name <name> --out <file.md>",
  );
  process.exit(2);
}

const MAX_WORDS = 6;
const MAX_DIFFS_PER_LABEL = 10;
const NONE = "(none)";

const load = (p: string): Dump => JSON.parse(readFileSync(p, "utf8")) as Dump;
const cut = (s: string): string => {
  const w = s.trim().split(/\s+/).filter(Boolean);
  return w.length <= MAX_WORDS
    ? w.join(" ")
    : `${w.slice(0, MAX_WORDS).join(" ")}...`;
};
const val = (s: string | null | undefined): string => (s?.trim() ? s : NONE);
const effective = (s: Segment): string => s.enhanced_text ?? s.text ?? "";

/** All labels that appear in either dump (speaker rows and segments). */
function labelsOf(...dumps: Dump[]): string[] {
  const set = new Set<string>();
  for (const d of dumps) {
    for (const s of d.speakers) set.add(s.label);
    for (const s of d.segments) if (s.speaker_label) set.add(s.speaker_label);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** The changed words of two lines: common prefix and suffix dropped. */
function changedSpan(a: string, b: string): [string, string] {
  const wa = a.split(/\s+/).filter(Boolean);
  const wb = b.split(/\s+/).filter(Boolean);
  let p = 0;
  while (p < wa.length && p < wb.length && wa[p] === wb[p]) p++;
  let s = 0;
  while (
    s < wa.length - p &&
    s < wb.length - p &&
    wa[wa.length - 1 - s] === wb[wb.length - 1 - s]
  )
    s++;
  return [
    wa.slice(p, wa.length - s).join(" "),
    wb.slice(p, wb.length - s).join(" "),
  ];
}

function render(x: Dump, y: Dump): string {
  const out: string[] = [];
  out.push(`# Speaker naming: ${xName} vs ${yName}`, "");
  out.push(
    `Each label shows arm ${xName} and arm ${yName}. Evidence and quotes are cut to ${MAX_WORDS} words.`,
    "Both arms use the same transcript. LLM output is not repeatable.",
    "",
  );
  const xs = new Map(x.speakers.map((s) => [s.label, s]));
  const ys = new Map(y.speakers.map((s) => [s.label, s]));
  const xseg = new Map(x.segments.map((s) => [`${s.source}:${s.idx}`, s]));
  for (const label of labelsOf(x, y)) {
    out.push(`## Label ${label}`);
    for (const [arm, m] of [
      [xName, xs],
      [yName, ys],
    ] as const) {
      const r = m.get(label);
      out.push(`- ${arm} name: ${JSON.stringify(val(r?.suggested_name))}`);
      out.push(`- ${arm} kind: ${val(r?.suggested_kind)}`);
      out.push(
        `- ${arm} evidence: ${JSON.stringify(cut(val(r?.suggested_evidence)))}`,
      );
    }
    const diffs: string[] = [];
    for (const sy of y.segments) {
      if (sy.speaker_label !== label) continue;
      const sx = xseg.get(`${sy.source}:${sy.idx}`);
      if (!sx) continue;
      const [a, b] = changedSpan(effective(sx), effective(sy));
      if (a === b) continue;
      diffs.push(
        `  - ${sy.source}:${sy.idx} ${xName}: ${JSON.stringify(cut(a) || NONE)} / ${yName}: ${JSON.stringify(cut(b) || NONE)}`,
      );
    }
    out.push(`- enhanced_text changed lines: ${diffs.length}`);
    out.push(...diffs.slice(0, MAX_DIFFS_PER_LABEL));
    if (diffs.length > MAX_DIFFS_PER_LABEL)
      out.push(`  - (+${diffs.length - MAX_DIFFS_PER_LABEL} more)`);
    out.push("");
  }
  // Segments with no speaker label (mostly mic) are in no label group above.
  // Without this section a judge cannot see their changes (round r228).
  const unlabeled: string[] = [];
  for (const sy of y.segments) {
    if (sy.speaker_label) continue;
    const sx = xseg.get(`${sy.source}:${sy.idx}`);
    if (!sx || sx.speaker_label) continue;
    const [a, b] = changedSpan(effective(sx), effective(sy));
    if (a === b) continue;
    unlabeled.push(
      `  - ${sy.source}:${sy.idx} ${xName}: ${JSON.stringify(cut(a) || NONE)} / ${yName}: ${JSON.stringify(cut(b) || NONE)}`,
    );
  }
  out.push("## Segments with no speaker label");
  out.push(`- enhanced_text changed lines: ${unlabeled.length}`);
  out.push(...unlabeled);
  out.push("");
  return out.join("\n");
}

/** Self-check: parse the written file back and compare with fresh dumps. */
function selfCheck(): string[] {
  const errors: string[] = [];
  const md = readFileSync(outPath as string, "utf8").split("\n");
  const x = load(xPath as string);
  const y = load(yPath as string);
  const want = labelsOf(x, y);
  const got = md
    .filter((l) => l.startsWith("## Label "))
    .map((l) => l.slice("## Label ".length));
  if (JSON.stringify(want) !== JSON.stringify(got))
    errors.push(`label list differs: dumps ${want.length}, file ${got.length}`);
  const sides = [
    [xName as string, x],
    [yName as string, y],
  ] as const;
  let cur = "";
  const seen = new Set<string>();
  for (const line of md) {
    if (line.startsWith("## Label ")) {
      cur = line.slice("## Label ".length);
      continue;
    }
    for (const [arm, d] of sides) {
      const row = d.speakers.find((s) => s.label === cur);
      const pre = `- ${arm} `;
      if (!line.startsWith(pre)) continue;
      const rest = line.slice(pre.length);
      const check = (key: string, expected: string) => {
        if (!rest.startsWith(`${key}: `)) return;
        seen.add(`${arm}|${cur}|${key}`);
        const shown = rest.slice(key.length + 2);
        if (shown !== expected)
          errors.push(`label ${cur} arm ${arm} ${key} differs from dump`);
      };
      check("name", JSON.stringify(val(row?.suggested_name)));
      check("kind", val(row?.suggested_kind));
      check("evidence", JSON.stringify(cut(val(row?.suggested_evidence))));
    }
  }
  for (const label of want)
    for (const [arm] of sides)
      for (const key of ["name", "kind", "evidence"])
        if (!seen.has(`${arm}|${label}|${key}`))
          errors.push(`label ${label} arm ${arm} ${key} missing in file`);
  return errors;
}

try {
  const x = load(xPath);
  const y = load(yPath);
  writeFileSync(outPath, render(x, y));
  const errors = selfCheck();
  if (errors.length > 0) {
    rmSync(outPath, { force: true });
    console.error(`SELF-CHECK FAILED (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    process.exit(1);
  }
  const labels = labelsOf(x, y).length;
  console.log(`self-check ok: ${labels} labels -> ${outPath}`);
} catch (e) {
  rmSync(outPath, { force: true });
  console.error(`compare-speakers failed: ${(e as Error).message}`);
  process.exit(1);
}
