// The app part of the MCP harness (specs/mcp.md 9.4). run.mjs starts this
// file through the Test Runner (scripts/test-runner/run.sh), so macOS checks
// the runner and not Claude Code. It launches the packaged app in quiet mode
// on an isolated profile, then serves a small control API on 127.0.0.1 for
// run.mjs: IPC invoke calls into the app and the quit.
//
// Usage: node app-host.mjs <job.json>
// job.json: { appExe, userDataDir, readyFile, env }
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { _electron: electron } = createRequire(
  join(REPO, "apps/electron/package.json"),
)("playwright");

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const say = (text) => console.log(`[app-host] ${text}`);

function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const isAux = (url) =>
  url.includes("pill") ||
  url.includes("tray-popover") ||
  url.includes("chat-bubble");

async function dashboard(app) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const win = app.windows().find((w) => w.url() && !isAux(w.url()));
    if (win) {
      await win.waitForLoadState("domcontentloaded");
      return win;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return app.windows()[0];
}

mkdirSync(job.userDataDir, { recursive: true });
writeFileSync(
  join(job.userDataDir, "settings.json"),
  JSON.stringify({ onboardingComplete: true }),
);
writeFileSync(
  join(job.userDataDir, "config.freestyle.json"),
  JSON.stringify({ version: 1, flags: { meetings: true } }),
);

const serverPort = await freePort();
const app = await electron.launch({
  executablePath: job.appExe,
  args: [],
  env: {
    ...process.env,
    ...job.env,
    OPENSTYLE_DB_PATH: join(job.userDataDir, "freestyle.db"),
    OPENSTYLE_USER_DATA: job.userDataDir,
    OPENSTYLE_SERVER_PORT: String(serverPort),
    OPENSTYLE_E2E: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  timeout: 60_000,
});
const pid = app.process().pid;
await app.firstWindow();
const page = await dashboard(app);
try {
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
} catch {
  // A long poll can keep the network busy. The load state is enough.
}
// The boot sweep of orphans runs 3 s after the start (main/index.ts).
await new Promise((r) => setTimeout(r, 3500));

let closing = false;
async function quit() {
  if (closing) return;
  closing = true;
  const killTimer = setTimeout(() => app.process().kill("SIGKILL"), 10_000);
  try {
    await app.close();
  } catch {
    app.process().kill("SIGKILL");
  } finally {
    clearTimeout(killTimer);
  }
}

const control = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", async () => {
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.url === "/invoke") {
        const { channel, args = [] } = JSON.parse(body || "{}");
        const result = await page.evaluate(
          ([c, a]) => window.electron.ipcRenderer.invoke(c, ...a),
          [channel, args],
        );
        send(200, { result });
      } else if (req.url === "/quit") {
        await quit();
        send(200, { ok: true });
        control.close();
      } else {
        send(404, { error: "unknown" });
      }
    } catch (error) {
      send(500, { error: String(error) });
    }
  });
});
control.listen(0, "127.0.0.1", () => {
  const { port } = control.address();
  writeFileSync(
    job.readyFile,
    JSON.stringify({ controlPort: port, serverPort, pid }),
  );
  say(`ready: app pid ${pid}, server port ${serverPort}, control ${port}`);
});
// Never outlive the harness: quit after the time box.
setTimeout(
  async () => {
    say("time box reached, quitting the app");
    await quit();
    process.exit(1);
  },
  (job.maxMinutes ?? 120) * 60_000,
).unref();
control.on("close", () => {
  say("app closed");
  process.exit(0);
});
