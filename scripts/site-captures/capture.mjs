// Site captures: real screenshots and a pill video of the Openstyle desktop
// app for the landing page, written to site/assets/screens/.
//
// Run from the repo root:  node scripts/site-captures/capture.mjs
// See README.md. The run is isolated: its own server (127.0.0.1:8790), its
// own fake model server (127.0.0.1:8787), a throwaway profile in a temp dir.
// The only contact with a running installed app is the boot health probe the
// app sends to 127.0.0.1:4649.
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModelServer } from "./fake-model-server.mjs";
import { seedDatabase } from "./seed-data.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ELECTRON_DIR = join(REPO, "apps/electron");
const OUT = join(REPO, "site/assets/screens");
const MAIN_JS = join(ELECTRON_DIR, "out/main/index.js");
const SERVER_JS = join(REPO, "apps/server/dist/startup.js");

const SERVER_PORT = 8790;
const MODEL_PORT = 8787;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const TOKEN = "site-captures-token-0123456789abcdef0123456789abcdef";
const PILL_BG = "#18202E"; // video only: webm has no alpha channel

// playwright is a dependency of apps/electron, not of the repo root.
const { _electron: electron } = createRequire(
  join(ELECTRON_DIR, "package.json"),
)("playwright");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => console.log(`[site-captures] ${msg}`);
const run = (cmd, args) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} exited with ${code}`)),
    );
  });

for (const f of [MAIN_JS, SERVER_JS]) {
  if (!existsSync(f)) {
    console.error(`missing build output: ${f}\nSee README.md for the build.`);
    process.exit(1);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "openstyle-site-captures-"));
const userData = join(scratch, "user-data");
const dbPath = join(userData, "openstyle.db");
const videoDir = join(scratch, "video");
mkdirSync(userData, { recursive: true });
mkdirSync(OUT, { recursive: true });

let serverProc = null;
let modelServer = null;
function cleanup() {
  try {
    serverProc?.kill("SIGKILL");
  } catch {}
  try {
    modelServer?.close();
  } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => process.exit(130));
}
setTimeout(() => {
  console.error("watchdog: 5 minutes passed, aborting");
  process.exit(3);
}, 300000).unref();

async function waitHttp(url, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function api(path, body) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}

async function waitForWindow(app, pred, what, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (pred(w.url())) return w;
      } catch {}
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const isPill = (u) => u.includes("pill");
const isDashboard = (u) => u && !u.includes("pill") && !u.includes("bar.html");

async function closeApp(app) {
  const proc = app.process();
  const t = setTimeout(() => proc.kill("SIGKILL"), 10000);
  try {
    await app.close();
  } catch {
    proc.kill("SIGKILL");
  }
  clearTimeout(t);
}

// Synthetic microphone for the pill page: a voice-band tone with a slow
// amplitude wobble, so the bars move. No real microphone is used.
const FAKE_MIC = () => {
  const ctx = new AudioContext();
  void ctx.resume().catch(() => {});
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.frequency.value = 220;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 3.1;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.32;
  lfo.connect(lfoGain);
  lfoGain.connect(gain.gain);
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  lfo.start();
  navigator.mediaDevices.getUserMedia = async () => dest.stream;
};

const written = [];
function record(name) {
  written.push({ name, bytes: statSync(join(OUT, name)).size });
  say(`wrote ${name}`);
}

// ---------------------------------------------------------------------------
// Isolated backend
// ---------------------------------------------------------------------------
modelServer = await startFakeModelServer(MODEL_PORT);
serverProc = spawn("node", [SERVER_JS], {
  cwd: ELECTRON_DIR, // the diarizer and resources resolve from here
  stdio: "ignore",
  env: {
    ...process.env,
    OPENSTYLE_DB_PATH: dbPath,
    PORT: String(SERVER_PORT),
    HOST: "127.0.0.1",
    OPENSTYLE_AUTH_TOKEN: TOKEN,
  },
});
await waitHttp(`${SERVER_URL}/api/health`);

const added = await api("/api/servers", {
  url: `http://127.0.0.1:${MODEL_PORT}`,
});
const defaults = [
  ["Qwen3-ASR", "voice"],
  ["Qwen3.8-27B", "llm"],
];
for (const [name, type] of defaults) {
  await api("/api/models/configured", {
    provider: "server",
    model_id: `server/${added.id}/${name}`,
    model_name: name,
    type,
    is_default: true,
  });
}
seedDatabase(dbPath);

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    onboardingComplete: true,
    serverUrl: SERVER_URL,
    serverToken: TOKEN,
  }),
);
writeFileSync(
  join(userData, "config.freestyle.json"),
  JSON.stringify({ version: 1, flags: { meetings: true } }),
);
say("isolated server, fake model server and demo data ready");

const launchOptions = {
  args: [
    MAIN_JS,
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--force-device-scale-factor=2",
  ],
  env: {
    ...process.env,
    NODE_ENV: "development",
    OPENSTYLE_DB_PATH: dbPath,
    OPENSTYLE_USER_DATA: userData,
    OPENSTYLE_E2E: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  timeout: 60000,
};

// Smallest box around the pill capsule: the largest painted element that is
// smaller than the window.
async function pillBox(pill) {
  return pill.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll("body *")) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      if (!best || r.width * r.height > best.width * best.height) {
        best = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    return best;
  });
}

async function startRecording(pill) {
  await pill.evaluate(FAKE_MIC);
  await pill.evaluate(() =>
    window.electron.ipcRenderer.send("e2e:trigger-hotkey-down"),
  );
}

// ---------------------------------------------------------------------------
// Run 1: dashboard screenshots and the transparent pill still
// ---------------------------------------------------------------------------
{
  const app = await electron.launch(launchOptions);
  try {
    const pill = await waitForWindow(app, isPill, "pill window");
    const dash = await waitForWindow(app, isDashboard, "dashboard window");
    await dash.waitForLoadState("domcontentloaded");

    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => {
        const u = x.webContents.getURL();
        return !u.includes("pill") && !u.includes("bar");
      });
      w?.setSize(1280, 800);
    });
    await dash.evaluate(() => localStorage.setItem("theme", "dark"));
    await pill.evaluate(() => localStorage.setItem("theme", "dark"));
    await dash.reload({ waitUntil: "domcontentloaded" });

    const shoot = async (name, opts = {}) => {
      // An unfocused window loses its vibrancy and paints flat dark.
      await dash.bringToFront();
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => {
          const u = x.webContents.getURL();
          return !u.includes("pill") && !u.includes("bar");
        });
        w?.focus();
      });
      await sleep(900);
      await dash.screenshot({ path: join(OUT, name), ...opts });
      record(name);
    };
    const link = (name) =>
      dash.getByRole("link", { name: new RegExp(`^${name}`) }).first();
    const text = (t, opts = {}) =>
      dash.getByText(t, { exact: false, ...opts }).first();

    // Transcriptions. The first history fetch can race the boot, so reload
    // until the seeded rows show.
    await link("Transcriptions").click();
    for (let i = 0; i < 4; i++) {
      await sleep(2500);
      if (await text("login page is slow on Safari").count()) break;
      await dash.reload({ waitUntil: "domcontentloaded" });
    }
    await text("login page is slow on Safari").waitFor({ timeout: 30000 });
    await shoot("transcriptions.png");

    // Meeting: transcript tab, then summary tab.
    await link("Meetings").click();
    await text("Weekly product sync").click();
    await text("onboarding, the Safari bug").waitFor({ timeout: 30000 });
    await shoot("meeting.png");
    await dash.getByRole("tab", { name: /summary/i }).click();
    await text("Code freeze is next Monday").waitFor({ timeout: 15000 });
    await shoot("meeting-summary.png");

    // Models pages (a client-side route; a reload would not render them).
    await dash.evaluate(() => {
      history.pushState({}, "", "/settings/models");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await text("Qwen3-ASR").waitFor({ timeout: 30000 });
    await sleep(800);
    await dash
      .getByRole("button", { name: /change/i })
      .first()
      .click();
    await text("Built into Openstyle").waitFor({ timeout: 20000 });
    await shoot("models-picker.png");
    await text("Built into Openstyle").click();
    await text("Parakeet").waitFor({ timeout: 20000 });
    await shoot("models-builtin.png");
    await dash.getByLabel("Back to simple view").click();
    await sleep(300);
    await text("Your own server").click();
    await dash.getByText("Qwen3-ASR", { exact: true }).first().waitFor();
    await shoot("models-server.png");

    // Pill recording: the app's own e2e hotkey IPC, synthetic microphone,
    // transparent background, clipped to the capsule.
    await pill.reload({ waitUntil: "domcontentloaded" });
    await sleep(1500);
    await startRecording(pill);
    await sleep(3200);
    const box = await pillBox(pill);
    if (!box) throw new Error("pill capsule not found");
    const pad = 6;
    // Playwright cannot raise the pill to 2x, so ask CDP for a 2x clip with
    // a transparent page background.
    const cdp = await pill.context().newCDPSession(pill);
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: box.width + 2 * pad,
        height: box.height + 2 * pad,
        scale: 2,
      },
    });
    writeFileSync(
      join(OUT, "pill-recording.png"),
      Buffer.from(shot.data, "base64"),
    );
    record("pill-recording.png");
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------------------
// Run 2: pill video (webm has no alpha, so the page gets a solid color)
// ---------------------------------------------------------------------------
{
  const app = await electron.launch({
    ...launchOptions,
    recordVideo: { dir: videoDir, size: { width: 640, height: 240 } },
  });
  let video = null;
  try {
    const pill = await waitForWindow(app, isPill, "pill window");
    await pill.waitForLoadState("domcontentloaded");
    video = pill.video();
    await pill.evaluate(() => localStorage.setItem("theme", "dark"));
    await pill.reload({ waitUntil: "domcontentloaded" });
    await pill.addStyleTag({
      content: `html, body { background: ${PILL_BG} !important; }`,
    });
    await sleep(800);
    await startRecording(pill);
    await sleep(4000);
    await pill.evaluate(() =>
      window.electron.ipcRenderer.send("e2e:trigger-hotkey-up"),
    );
    await sleep(500);
  } finally {
    await closeApp(app);
  }
  let src = null;
  try {
    src = video ? await video.path() : null;
  } catch {}
  if (!src || !existsSync(src)) {
    const files = readdirSync(videoDir)
      .map((f) => join(videoDir, f))
      .sort((a, b) => statSync(a).size - statSync(b).size);
    src = files.at(-1) ?? null;
  }
  if (!src) throw new Error("no pill video was recorded");
  cpSync(src, join(OUT, "pill-recording.webm"));
  record("pill-recording.webm");

  // Crop the pill out of the full recording and render the poster frame.
  // Box: the pill's bounding box in the 640x240 recording, found by reading
  // frames as raw RGB (ffmpeg -f rawvideo -pix_fmt rgb24) and taking the
  // bbox of pixels that differ from the scene bg #18202E: x=62 y=44
  // w=196 h=60, plus a 1px margin.
  const PILL_CROP = { x: 61, y: 43, w: 198, h: 62 };
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    join(OUT, "pill-recording.webm"),
    "-vf",
    `crop=${PILL_CROP.w}:${PILL_CROP.h}:${PILL_CROP.x}:${PILL_CROP.y}`,
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "32",
    "-b:v",
    "0",
    "-an",
    join(OUT, "pill-recording-crop.webm"),
  ]);
  record("pill-recording-crop.webm");
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    "1.5",
    "-i",
    join(OUT, "pill-recording-crop.webm"),
    "-frames:v",
    "1",
    join(OUT, "pill-recording-poster.png"),
  ]);
  record("pill-recording-poster.png");
}

console.log(JSON.stringify(written, null, 2));
process.exit(0); // the exit hook cleans up
