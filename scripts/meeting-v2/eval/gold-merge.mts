// gold-merge.mts: fold the owner's review answers into the gold key of a
// meeting (`pnpm meeting:eval:gold-merge`).
//
// Usage (from the repo root):
//   pnpm meeting:eval:gold-merge --meeting <id8> --answers <answers.json> [--gold-dir <dir>]
//
// The answers file comes from the review page of gold-clips (review.html,
// "Save"). The gold file is ~/.openstyle-eval/gold/<id8>.json (--gold-dir
// for another folder; the folder must have mode 0700). The merge rules are
// in mergeAnswers (gold.mts): each answer replaces its `from` words in the
// turns near its time with a new turn marked verified. The merge is all or
// nothing. On success the file is written again (mode 0600) with goldVersion
// + 1, then read back and validated.
//
// The console prints counts and answer ids only, never text.
// Exit codes: 0 ok; 1 the merge failed; 2 usage.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  DEFAULT_GOLD_DIR,
  loadGold,
  mergeAnswers,
  parseAnswers,
} from "./gold.mts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const id8 = arg("meeting");
  const answersPath = arg("answers");
  if (!id8 || !/^[0-9a-f]{8}$/.test(id8) || !answersPath) {
    console.error(
      "usage: pnpm meeting:eval:gold-merge --meeting <id8> --answers <answers.json> [--gold-dir <dir>]",
    );
    return 2;
  }
  const dir = resolve(arg("gold-dir") ?? DEFAULT_GOLD_DIR);
  // loadGold checks the folder mode and validates the file.
  const before = loadGold([id8], dir).get(id8);
  if (!before) throw new Error(`no gold for ${id8}`);
  const path = join(dir, `${id8}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const answers = parseAnswers(readFileSync(answersPath, "utf8"), id8);
  const r = mergeAnswers(raw, answers);
  if (r.errors.length > 0) {
    console.error(
      `merge refused (${r.errors.length} errors); the gold is unchanged:`,
    );
    for (const e of r.errors) console.error(`  ${e}`);
    return 1;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r.gold, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  const after = loadGold([id8], dir).get(id8);
  if (
    !after ||
    after.goldVersion !== before.goldVersion + 1 ||
    after.verifiedSpans !== (r.gold.verifiedSpans as number)
  )
    throw new Error(`gold ${path}: the read-back file differs from the merge`);
  console.log(
    `merged ${r.merged} answers into ${path}: goldVersion ${before.goldVersion} -> ${after.goldVersion}, verified turns ${before.verifiedSpans} -> ${after.verifiedSpans}`,
  );
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`gold-merge failed: ${(e as Error).message}`);
  process.exit(1);
}
