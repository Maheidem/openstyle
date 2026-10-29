// Load the silver keys with the repo's own loader (gold.mts, read-only).
// Prints ids and loader errors only (the loader errors name fields, never text).
// usage: pnpm meeting:silver:load-check   (SILVER_KEYS, SILVER_MEETINGS as in README.md)
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadGold, parseGold } from "../../gold.mts";

const DIR =
  process.env.SILVER_KEYS || join(homedir(), ".openstyle-eval", "gold-silver");
const IDS = process.env.SILVER_MEETINGS
  ? process.env.SILVER_MEETINGS.split(/[\s,]+/).filter(Boolean)
  : readdirSync(DIR)
      .filter((f) => /^[0-9a-f]{8}\.json$/.test(f))
      .map((f) => f.slice(0, 8))
      .sort();
let ok = 0;
for (const id of IDS) {
  try {
    const txt = readFileSync(`${DIR}/${id}.json`, "utf8");
    const g = parseGold(txt, id);
    ok++;
    console.log(
      id,
      "OK",
      "turns",
      g.transcript!.mic.length + g.transcript!.system.length,
    );
  } catch (e) {
    console.log(id, "FAIL", (e as Error).message);
  }
}
console.log(`parseGold: ${ok}/${IDS.length} pass`);
try {
  loadGold(IDS, DIR);
  console.log("loadGold (folder mode + all files): pass");
} catch (e) {
  console.log("loadGold: FAIL", (e as Error).message);
}
