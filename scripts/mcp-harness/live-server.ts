// A standalone Openstyle server with a seeded live transcript store, for the
// harness journey J15 (specs/mcp.md 10). run.mjs bundles this file with
// esbuild, so the server and the live store share one module graph. The
// store gets one new final line every LIVE_LINE_MS, so a second poll with
// since_ms sees new lines. All text is fictional.
//
// Env: OPENSTYLE_DB_PATH, OPENSTYLE_MCP_TOKEN, LIVE_USER_DATA (the folder for
// mcp.json), LIVE_PORT.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../../apps/server/src/index.js";
import {
  addFinalLine,
  openLive,
  setLiveStatus,
  setPartialLine,
} from "../../apps/server/src/lib/meetings/live/store.js";

const MEETING_ID = "meet_live_harbor";
const LINES: [source: "mic" | "system", text: string][] = [
  ["mic", "Good morning, the pier crew is ready."],
  ["system", "The crane inspection ends at ten."],
  ["mic", "Then the first ferry loads at half past ten."],
  ["system", "We keep the north gate closed until noon."],
  ["mic", "Please send the berth plan to Dana before lunch."],
  ["system", "The tug captain confirms the new schedule."],
  ["mic", "Good, that closes the harbor update."],
  ["system", "One more thing: the fuel barge comes at two."],
  ["mic", "Noted, the east berth stays free for it."],
  ["system", "The weather report says light wind all day."],
  ["mic", "Thanks everyone, see you tomorrow at eight."],
];
/** A new final line comes every LIVE_LINE_MS. */
const LINE_MS = Number(process.env.LIVE_LINE_MS ?? 3000);

const port = Number(process.env.LIVE_PORT);
const userData = process.env.LIVE_USER_DATA ?? "";
const token = process.env.OPENSTYLE_MCP_TOKEN ?? "";

const server = await startServer({ port, host: "127.0.0.1" });

const db = new DatabaseSync(process.env.OPENSTYLE_DB_PATH ?? "");
db.exec("PRAGMA busy_timeout = 5000");
const now = Date.now();
db.prepare(
  `INSERT OR IGNORE INTO meetings (id, title, started_at, status, created_at)
   VALUES (?, 'Harbor morning stand-up', ?, 'recording', ?)`,
).run(MEETING_ID, now, now);
db.close();

openLive(MEETING_ID);
setLiveStatus(MEETING_ID, "ready");
let next = 0;
function addLine(): void {
  if (next >= LINES.length) return;
  const [source, text] = LINES[next];
  const startMs = next * LINE_MS;
  addFinalLine(MEETING_ID, {
    source,
    startMs,
    endMs: startMs + LINE_MS - 200,
    text,
    final: true,
  });
  next++;
  const tail = LINES[next];
  setPartialLine(
    MEETING_ID,
    tail ? tail[0] : "mic",
    tail
      ? {
          source: tail[0],
          startMs: next * LINE_MS,
          endMs: next * LINE_MS + 800,
          text: tail[1].split(" ").slice(0, 2).join(" "),
        }
      : null,
  );
  console.log(`[live] line ${next}: ${text}`);
}
addLine();
addLine();
setInterval(addLine, LINE_MS);

writeFileSync(
  join(userData, "mcp.json"),
  `${JSON.stringify({ port: server.port, token, name: "openstyle-dev", version: "harness" }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`[live] ready on ${server.port}`);
