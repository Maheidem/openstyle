// Entry of the stdio bridge (out/main/mcp-bridge.js). The launcher
// resources/mcp/openstyle-mcp starts it (specs/mcp.md 7.1). The bridge does
// not exit when the app is not running: it answers each request with an error
// and the next request works again when the app runs.
import { createInterface } from "node:readline";
import { createBridge, resolveUserDataDir } from "./bridge";

const bridge = createBridge({
  userDataDir: resolveUserDataDir(process.argv.slice(2), process.env),
  write: (line) => process.stdout.write(`${line}\n`),
  logError: (text) => process.stderr.write(`${text}\n`),
});

const pending = new Set<Promise<void>>();
const lines = createInterface({ input: process.stdin, terminal: false });

lines.on("line", (line) => {
  const job = bridge
    .handleLine(line)
    .catch((err) => {
      process.stderr.write(`openstyle-mcp: ${String(err)}\n`);
    })
    .finally(() => pending.delete(job));
  pending.add(job);
});

// The agent closed stdin: write the open answers, then exit.
lines.on("close", () => {
  void Promise.allSettled([...pending]).then(() => process.exit(0));
});
