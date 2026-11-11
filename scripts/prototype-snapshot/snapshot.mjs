// Prototype snapshot: a standalone HTML copy of one real Openstyle screen.
//
// Run from the repo root, through the Test Runner (live-testing skill):
//   scripts/test-runner/run.sh "$PWD" -- node scripts/prototype-snapshot/snapshot.mjs \
//     --out /tmp/proto-snap --name meeting [--theme dark|light] [--size 1440x900] \
//     [--route /meetings] [--click "button:Summary instructions"] \
//     [--setting meeting_summary_instructions=@file.txt]
//
// The run is isolated: its own server on 127.0.0.1:8791, a throwaway profile
// and HOME in a temp dir, fictional seed data (site-captures seed plus the
// extra folders below). It writes into --out:
//   <name>.html       standalone page: DOM + all CSS + fonts/images as data: URIs
//   <name>.frag.html  the same DOM as a fragment (wrapper div), assets as files
//   <name>.css        the scoped CSS, asset urls relative (assets/<file>)
//   assets/           fonts and images that the CSS and DOM use
//   <name>.real.png   CDP screenshot of the real app window
//   <name>.snap.png   screenshot of <name>.html, rendered by the same Electron
//   <name>.diff.png   changed pixels in red
// and prints one line: "DIFF <name> exact=<pct>% over16=<pct>% size=WxH".
//
// See .claude/skills/prototype-snapshot/SKILL.md.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { seedDatabase } from "../site-captures/seed-data.mjs";

const { values: opt } = parseArgs({
  options: {
    out: { type: "string" },
    name: { type: "string", default: "screen" },
    theme: { type: "string", default: "dark" },
    size: { type: "string", default: "1440x900" },
    route: { type: "string", default: "/meetings" },
    click: { type: "string", multiple: true, default: [] },
    setting: { type: "string", multiple: true, default: [] },
  },
});
if (!opt.out) {
  console.error("missing --out <dir>");
  process.exit(1);
}
const [W, H] = opt.size.split("x").map(Number);
const OUT = resolve(opt.out);
mkdirSync(join(OUT, "assets"), { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ELECTRON_DIR = join(REPO, "apps/electron");
const MAIN_JS = join(ELECTRON_DIR, "out/main/index.js");
const SERVER_JS = join(REPO, "apps/server/dist/startup.js");
const PORT = 8791;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "prototype-snapshot-token-0123456789abcdef0123456789ab";
// The glass surfaces are translucent and a page capture has no native
// vibrancy. Both shots get the same flat desktop color behind the window.
const BACKDROP = opt.theme === "dark" ? "#0c0d0f" : "#e8e9ec";

for (const f of [MAIN_JS, SERVER_JS]) {
  if (!existsSync(f)) {
    console.error(`missing build output: ${f} (live-testing skill, Build)`);
    process.exit(1);
  }
}
const { _electron: electron } = createRequire(
  join(ELECTRON_DIR, "package.json"),
)("playwright");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[prototype-snapshot] ${m}`);

// ---------------------------------------------------------------------------
// Isolated backend (same pattern as scripts/site-captures/capture.mjs)
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "openstyle-proto-snap-"));
const userData = join(scratch, "user-data");
const dbPath = join(userData, "openstyle.db");
mkdirSync(userData, { recursive: true });
mkdirSync(join(scratch, "home"), { recursive: true });
const workerStandIn = join(scratch, "mlx-worker-stand-in");
writeFileSync(workerStandIn, "#!/bin/sh\nexec sleep 20\n", { mode: 0o755 });
for (const hfId of [
  "mlx-community/Qwen3-ASR-0.6B-8bit",
  "mlx-community/gemma-4-E2B-it-qat-4bit",
]) {
  const snap = join(
    scratch,
    "hf",
    "hub",
    `models--${hfId.replaceAll("/", "--")}`,
    "snapshots",
    "stub",
  );
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "model.safetensors"), "");
}

let serverProc = null;
process.on("exit", () => {
  try {
    serverProc?.kill("SIGKILL");
  } catch {}
  rmSync(scratch, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => process.exit(130));
setTimeout(() => {
  console.error("watchdog: 4 minutes passed, aborting");
  process.exit(3);
}, 240000).unref();

async function waitHttp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
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

serverProc = spawn("node", [SERVER_JS], {
  cwd: ELECTRON_DIR,
  stdio: "ignore",
  env: {
    ...process.env,
    OPENSTYLE_DB_PATH: dbPath,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    OPENSTYLE_AUTH_TOKEN: TOKEN,
    HOME: join(scratch, "home"),
    HF_HOME: join(scratch, "hf"),
    HUGGINGFACE_HUB_CACHE: join(scratch, "hf", "hub"),
    OPENSTYLE_MLX_ASR_WORKER: workerStandIn,
    OPENSTYLE_E2E_OMLX_URL: "http://127.0.0.1:1",
  },
});
await waitHttp(`${SERVER_URL}/api/health`);
for (const [provider, model_id, model_name, type] of [
  ["local-mlx", "local-mlx/qwen3-0.6b-8bit", "Qwen3 Fast", "voice"],
  ["local-mlx-llm", "local-mlx-llm/gemma-4-e2b-qat-4bit", "Gemma 4 E2B", "llm"],
]) {
  await api("/api/models/configured", {
    provider,
    model_id,
    model_name,
    type,
    is_default: true,
  });
}
seedDatabase(dbPath);
seedExtra(dbPath, opt.setting);
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
say("isolated server and fictional data ready");

// Extra fictional data so the meeting list looks like a busy account:
// colored folders with several meetings each, a few unfiled meetings, and
// the --setting key=value pairs (value "@path" reads a file).
function seedExtra(path, settings) {
  const db = new DatabaseSync(path);
  const MIN = 60000;
  const now = Date.now();
  try {
    const color = db.prepare(
      "UPDATE meeting_folders SET color = ? WHERE id = ?",
    );
    color.run("blue", "folder_product");
    color.run("orange", "folder_customers");
    color.run("green", "folder_hiring");
    db.prepare(
      `INSERT INTO meeting_folders (id, name, description, color, created_at, updated_at)
       VALUES ('folder_personal', 'Personal', NULL, 'violet', ?, ?)`,
    ).run(now - 40 * 24 * 60 * MIN, now);
    const meet = db.prepare(
      `INSERT INTO meetings
         (id, title, started_at, ended_at, duration_ms, status, audio_dir,
          stt_provider, stt_model, language, context, folder_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'summarized', NULL, 'local-mlx',
               'local-mlx/qwen3-0.6b-8bit', 'en', NULL, ?, ?)`,
    );
    const seg = db.prepare(
      `INSERT INTO meeting_segments
         (id, meeting_id, source, idx, start_ms, end_ms, text, status, speaker_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', NULL)`,
    );
    // [title, folder, days ago, minutes]
    const EXTRA = [
      ["Sprint planning", "folder_product", 3, 47],
      ["Design review: settings page", "folder_product", 6, 38],
      ["Roadmap check-in", "folder_product", 9, 29],
      ["Release retro", "folder_product", 13, 41],
      ["Onboarding call with Lumen Labs", "folder_customers", 4, 33],
      ["Support escalation review", "folder_customers", 8, 21],
      ["Phone screen: backend role", "folder_hiring", 5, 26],
      ["Dentist reschedule", "folder_personal", 7, 6],
      ["Bank call notes", "folder_personal", 11, 14],
      ["Quick sync", null, 2, 9],
      ["Vendor demo", null, 10, 35],
    ];
    EXTRA.forEach(([title, folder, days, minutes], i) => {
      const id = `meet_extra_${i}`;
      const start = now - days * 24 * 60 * MIN - 3 * 60 * MIN;
      meet.run(
        id,
        title,
        start,
        start + minutes * MIN,
        minutes * MIN,
        folder,
        start,
      );
      seg.run(`${id}-s0`, id, "mic", 0, 2000, 9000, "Okay, let us start.");
      seg.run(`${id}-s1`, id, "system", 1, 9000, 16000, "Sounds good.");
    });
    // No speaker names in the main meeting: the other side shows as
    // "Them 1" / "Them 2" (the app never shows a bare "Them").
    db.prepare(
      "DELETE FROM meeting_speakers WHERE meeting_id = 'meet_demo_product_sync'",
    ).run();
    for (const s of settings) {
      const eq = s.indexOf("=");
      const key = s.slice(0, eq);
      let value = s.slice(eq + 1);
      if (value.startsWith("@")) value = readFileSync(value.slice(1), "utf8");
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The in-page serializer. Runs in the real renderer after the screen is
// ready. Returns the scoped CSS, the wrapper fragment and the asset list.
// Scoping: `html` and `:root` become `.os-root`, `body` becomes `.os-body`,
// so the CSS works inside any page (a canvas artboard) with no global
// selectors of its own. `vh` lengths become `var(--os-vh)` multiples, so the
// frame height sets them.
// ---------------------------------------------------------------------------
const SERIALIZE = async ({ W, H, backdrop }) => {
  const assets = []; // { token, url }
  const tokenFor = (raw, base) => {
    if (raw.startsWith("data:")) return raw;
    let url;
    try {
      url = new URL(raw, base).href;
    } catch {
      return raw;
    }
    let a = assets.find((x) => x.url === url);
    if (!a) {
      a = { token: `__ASSET_${assets.length}__`, url };
      assets.push(a);
    }
    return a.token;
  };
  const urls = (text, base) =>
    text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, u) =>
      u.startsWith("#") ? m : `url("${tokenFor(u, base)}")`,
    );
  const vh = (text) =>
    text.replace(
      /(-?\d*\.?\d+)(?:d|s|l)?vh\b/g,
      (_m, n) => `calc(${n} * var(--os-vh, 1vh))`,
    );
  const TYPE = String.raw`(^|[\s,(>+~])`;
  const AFTER = String.raw`(?=$|[\s.:#[,>+~)])`;
  const scopeSel = (sel) =>
    sel
      .replace(/:root\b/g, ".os-root")
      .replace(new RegExp(`${TYPE}html${AFTER}`, "g"), "$1.os-root")
      .replace(new RegExp(`${TYPE}body${AFTER}`, "g"), "$1.os-body");
  const loadedFamilies = new Set(
    [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => f.family.replace(/^["']|["']$/g, "")),
  );
  const notes = [];
  const ser = (rules, base) => {
    let out = "";
    for (const r of rules) {
      if (r instanceof CSSStyleRule) {
        const inner =
          vh(urls(r.style.cssText, base)) +
          (r.cssRules?.length ? ser(r.cssRules, base) : "");
        out += `${scopeSel(r.selectorText)}{${inner}}\n`;
      } else if (r instanceof CSSImportRule) {
        if (r.styleSheet)
          out += ser(r.styleSheet.cssRules, r.styleSheet.href || base);
      } else if (r instanceof CSSFontFaceRule) {
        const fam = r.style
          .getPropertyValue("font-family")
          .replace(/^["']|["']$/g, "");
        if (loadedFamilies.has(fam)) out += `${urls(r.cssText, base)}\n`;
      } else if (r.cssRules && "conditionText" in r) {
        // @media, @supports, @container
        const head = r.cssText.slice(0, r.cssText.indexOf("{"));
        out += `${head}{\n${ser(r.cssRules, base)}}\n`;
      } else if (
        typeof CSSLayerBlockRule !== "undefined" &&
        r instanceof CSSLayerBlockRule
      ) {
        out += `@layer ${r.name}{\n${ser(r.cssRules, base)}}\n`;
      } else {
        // @keyframes, @property, @layer statements, @font-feature-values...
        out += `${r.cssText}\n`;
      }
    }
    return out;
  };
  let css = "";
  for (const sheet of [
    ...document.styleSheets,
    ...document.adoptedStyleSheets,
  ]) {
    if (sheet.ownerNode?.dataset?.snapHelper) continue;
    try {
      css += ser(sheet.cssRules, sheet.href || location.href);
    } catch (e) {
      notes.push(`stylesheet not readable: ${sheet.href} (${e})`);
    }
  }
  // Freeze motion: the shot shows the end state at once.
  css +=
    ".os-root *,.os-root *::before,.os-root *::after{animation-delay:0s!important;animation-duration:0s!important;transition:none!important}\n";

  // DOM: clone the body and copy live state the markup does not hold.
  const live = [...document.body.querySelectorAll("*")];
  const clone = document.body.cloneNode(true);
  const copy = [...clone.querySelectorAll("*")];
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    const b = copy[i];
    if (a.tagName === "TEXTAREA") b.textContent = a.value;
    if (a.tagName === "INPUT") {
      b.setAttribute("value", a.value);
      if (a.checked) b.setAttribute("checked", "");
      else b.removeAttribute("checked");
    }
    if (a.tagName === "SELECT") {
      for (const [k, o] of [...b.options].entries()) {
        if (k === a.selectedIndex) o.setAttribute("selected", "");
        else o.removeAttribute("selected");
      }
    }
    if (a.tagName === "CANVAS") {
      try {
        const img = document.createElement("img");
        img.src = a.toDataURL();
        img.setAttribute("style", a.getAttribute("style") || "");
        img.className = a.className;
        b.replaceWith(img);
      } catch {}
    }
    if (a.tagName === "IMG" && a.currentSrc)
      b.setAttribute("src", tokenFor(a.currentSrc, location.href));
    if (b.hasAttribute?.("srcset")) b.removeAttribute("srcset");
    if (b.hasAttribute?.("style"))
      b.setAttribute("style", vh(urls(b.getAttribute("style"), location.href)));
    if (a.scrollTop || a.scrollLeft) {
      notes.push(
        `scrolled element lost its scroll: ${a.tagName}.${String(a.className).slice(0, 60)} top=${a.scrollTop}`,
      );
    }
    if (a.shadowRoot) notes.push(`shadow root not copied: ${a.tagName}`);
  }
  for (const n of clone.querySelectorAll(
    "script,noscript,style,link,meta,iframe,template",
  )) {
    n.remove();
  }
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const de = document.documentElement;
  const htmlAttrs = [...de.attributes]
    .filter((x) => !["class", "style"].includes(x.name))
    .map((x) => ` ${x.name}="${esc(x.value)}"`)
    .join("");
  const bodyAttrs = [...document.body.attributes]
    .filter((x) => !["class", "style"].includes(x.name))
    .map((x) => ` ${x.name}="${esc(x.value)}"`)
    .join("");
  const rootStyle =
    vh(de.getAttribute("style") || "") +
    `;position:relative;overflow:hidden;width:${W}px;height:${H}px;transform:translateZ(0);--os-vh:${H / 100}px;background:${backdrop}`;
  const frag =
    `<div class="os-root ${esc(de.className)}"${htmlAttrs} style="${esc(rootStyle)}">` +
    `<div class="os-body ${esc(document.body.className)}"${bodyAttrs} style="${esc(vh(document.body.getAttribute("style") || ""))}">` +
    clone.innerHTML +
    "</div></div>";
  const rootFont = getComputedStyle(de).fontSize;
  if (rootFont !== "16px")
    notes.push(
      `html font-size is ${rootFont}, not 16px: rem sizes differ in a host page`,
    );
  if (document.activeElement && document.activeElement !== document.body) {
    notes.push(
      `focus was on ${document.activeElement.tagName}: :focus styles are not in the copy`,
    );
  }
  // Asset bytes, read in the page (app:// urls only resolve here).
  for (const a of assets) {
    try {
      const res = await fetch(a.url);
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      for (let k = 0; k < buf.length; k += 0x8000)
        bin += String.fromCharCode(...buf.subarray(k, k + 0x8000));
      a.b64 = btoa(bin);
      a.type = res.headers.get("content-type") || "";
    } catch (e) {
      notes.push(`asset not read: ${a.url} (${e})`);
    }
  }
  return { css, frag, assets, notes };
};

// Files: assets by content hash, a scoped CSS + fragment that point at them,
// and a standalone page with everything inline. Returns the page path.
function writeOutputs(result) {
  const EXT = {
    "font/woff2": "woff2",
    "font/woff": "woff",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  let css = result.css;
  let frag = result.frag;
  let cssInline = result.css;
  let fragInline = result.frag;
  for (const a of result.assets) {
    if (!a.b64) continue;
    const buf = Buffer.from(a.b64, "base64");
    const ext =
      EXT[a.type.split(";")[0]] ||
      a.url.split(".").pop().split(/[?#]/)[0] ||
      "bin";
    const file = `${createHash("sha256").update(buf).digest("hex").slice(0, 16)}.${ext}`;
    writeFileSync(join(OUT, "assets", file), buf);
    const dataUrl = `data:${a.type.split(";")[0] || "application/octet-stream"};base64,${a.b64}`;
    css = css.replaceAll(a.token, `assets/${file}`);
    frag = frag.replaceAll(a.token, `assets/${file}`);
    cssInline = cssInline.replaceAll(a.token, dataUrl);
    fragInline = fragInline.replaceAll(a.token, dataUrl);
  }
  writeFileSync(join(OUT, `${opt.name}.css`), css);
  writeFileSync(join(OUT, `${opt.name}.frag.html`), frag);
  const standalone = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${opt.name}</title>
<style>html,body{margin:0;padding:0;background:${BACKDROP}}</style>
<style>${cssInline}</style></head>
<body>${fragInline}</body></html>
`;
  const standalonePath = join(OUT, `${opt.name}.html`);
  writeFileSync(standalonePath, standalone);
  return standalonePath;
}

// ---------------------------------------------------------------------------
// Launch, navigate, set up, capture
// ---------------------------------------------------------------------------
const app = await electron.launch({
  // sRGB: the offscreen copy renders in sRGB, so the real window must too,
  // or wide-gamut colors (oklch) differ on a P3 display.
  args: [
    MAIN_JS,
    "--force-device-scale-factor=1",
    "--force-color-profile=srgb",
  ],
  env: {
    ...process.env,
    NODE_ENV: "development",
    OPENSTYLE_DB_PATH: dbPath,
    OPENSTYLE_USER_DATA: userData,
    OPENSTYLE_E2E: "1",
    OPENSTYLE_E2E_OMLX_URL: "http://127.0.0.1:1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  timeout: 60000,
});
const isDash = (u) => u && !u.includes("pill") && !u.includes("bar");
async function dashWindow() {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    for (const w of app.windows()) {
      try {
        if (isDash(w.url())) return w;
      } catch {}
    }
    await sleep(250);
  }
  throw new Error("dashboard window not found");
}
let result;
let snapB64;
try {
  const dash = await dashWindow();
  await dash.waitForLoadState("domcontentloaded");
  const sizeAndFocus = () =>
    app.evaluate(
      ({ BrowserWindow }, { W, H }) => {
        const w = BrowserWindow.getAllWindows().find((x) => {
          const u = x.webContents.getURL();
          return !u.includes("pill") && !u.includes("bar");
        });
        w?.setMinimumSize(200, 200);
        w?.setContentSize(W, H);
        w?.focus();
      },
      { W, H },
    );
  await sizeAndFocus();
  await dash.evaluate((t) => localStorage.setItem("theme", t), opt.theme);
  await dash.reload({ waitUntil: "domcontentloaded" });
  await sleep(2500);
  await dash.evaluate((r) => {
    history.pushState({}, "", r);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, opt.route);
  await sleep(3000);
  for (const c of opt.click) {
    const i = c.indexOf(":");
    const role = c.slice(0, i);
    const name = c.slice(i + 1);
    await dash
      .getByRole(role, { name, exact: true })
      .first()
      .click({ timeout: 15000 });
    await sleep(1200);
  }
  await sizeAndFocus();
  // No hover or focus state: both shots must show the same thing.
  await dash.mouse.move(W - 2, H - 2);
  await dash.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  // Helper styles for the real shot only. The serializer skips them
  // (data-snap-helper): the copy gets the backdrop on its wrapper.
  await dash.evaluate((bg) => {
    const st = document.createElement("style");
    st.dataset.snapHelper = "1";
    st.textContent = `html{background:${bg}!important}*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;transition:none!important}`;
    document.head.appendChild(st);
  }, BACKDROP);
  await sleep(1200);
  const view = await dash.evaluate(() => [innerWidth, innerHeight]);
  if (view[0] !== W || view[1] !== H)
    throw new Error(`viewport is ${view}, wanted ${W}x${H}`);
  await dash.screenshot({ path: join(OUT, `${opt.name}.real.png`) });
  result = await dash.evaluate(SERIALIZE, { W, H, backdrop: BACKDROP });
  const standalonePath = writeOutputs(result);
  // Render the standalone page in the same Electron (same Chromium, same
  // font stack) in an offscreen window, so the diff shows the copy, not the
  // engine.
  snapB64 = await app.evaluate(
    async ({ BrowserWindow }, { file, W, H }) => {
      const win = new BrowserWindow({
        width: W,
        height: H,
        show: false,
        useContentSize: true,
        webPreferences: { offscreen: true, javascript: false },
      });
      await win.loadFile(file);
      await new Promise((r) => setTimeout(r, 2000));
      const img = await win.webContents.capturePage({
        x: 0,
        y: 0,
        width: W,
        height: H,
      });
      win.destroy();
      return img.toPNG().toString("base64");
    },
    { file: standalonePath, W, H },
  );
} finally {
  const proc = app.process();
  const t = setTimeout(() => proc.kill("SIGKILL"), 10000);
  try {
    await app.close();
  } catch {
    proc.kill("SIGKILL");
  }
  clearTimeout(t);
}
writeFileSync(
  join(OUT, `${opt.name}.snap.png`),
  Buffer.from(snapB64, "base64"),
);

// Pixel diff with Pillow (python3 -I: no local modules).
const PY = `
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size:
    print(f"SIZE_MISMATCH real={a.size} snap={b.size}"); b = b.resize(a.size)
d = ImageChops.difference(a, b)
px = list(d.get_flattened_data() if hasattr(d, 'get_flattened_data') else d.getdata()); n = len(px)
exact = sum(1 for p in px if max(p) > 0)
over = sum(1 for p in px if max(p) > 16)
mask = Image.new("RGB", a.size, (0, 0, 0))
mask.putdata([(255, 0, 0) if max(p) > 16 else (0, 0, 0) for p in px])
Image.blend(a, mask, 0.6).save(sys.argv[3])
print(f"exact={100*exact/n:.3f}% over16={100*over/n:.3f}%")
`;
const diff = spawnSync(
  "python3",
  [
    "-I",
    "-c",
    PY,
    join(OUT, `${opt.name}.real.png`),
    join(OUT, `${opt.name}.snap.png`),
    join(OUT, `${opt.name}.diff.png`),
  ],
  { encoding: "utf8" },
);
for (const n of result.notes) say(`note: ${n}`);
say(
  `css ${Math.round(result.css.length / 1024)} KB, fragment ${Math.round(result.frag.length / 1024)} KB, ${result.assets.length} assets`,
);
console.log(
  `DIFF ${opt.name} ${diff.stdout.trim() || diff.stderr.trim()} size=${W}x${H}`,
);
process.exit(0);
