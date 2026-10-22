// The social card (site/assets/og-image.png, 1200x630): the name and the
// tagline on the left, the Transcriptions shot on the right, on the page
// color of the site. capture.mjs calls it after the dashboard run.
// Run alone:  node scripts/site-captures/og-image.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHOT = join(REPO, "site/assets/screens/transcriptions.png");
const OUT = join(REPO, "site/assets/og-image.png");

// playwright is a dependency of apps/electron, not of the repo root.
const { chromium } = createRequire(join(REPO, "apps/electron/package.json"))(
  "playwright",
);

const shot = readFileSync(SHOT).toString("base64");
const html = `<!doctype html>
<html><head><style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    background: #edf0f4; color: #18202e;
    font-family: -apple-system, "Helvetica Neue", sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; align-items: center;
  }
  .text { position: absolute; left: 64px; width: 470px; }
  h1 { margin: 0 0 22px; font-size: 78px; font-weight: 800; letter-spacing: -2px; line-height: 1; }
  .tag { margin: 0 0 40px; font-size: 29px; line-height: 1.45; }
  .meta { margin: 0; font-size: 20px; color: #6b7385; }
  img {
    position: absolute; left: 592px; top: 145px; width: 544px; height: 340px;
    border-radius: 14px;
    box-shadow: 0 24px 48px -16px rgba(42, 47, 58, 0.35),
      0 4px 12px -6px rgba(42, 47, 58, 0.2);
  }
</style></head><body>
  <div class="text">
    <h1>Openstyle</h1>
    <p class="tag">Free, local dictation for Mac. Hold a key, talk, let go.</p>
    <p class="meta">Open source &middot; Apple silicon &middot; MLX</p>
  </div>
  <img src="data:image/png;base64,${shot}" alt="">
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: OUT });
  console.log(`[site-captures] wrote ${OUT}`);
} finally {
  await browser.close();
}
