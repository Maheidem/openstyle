import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  closeApp,
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// Search hits by kind (#286, specs/local-semantic-search.md 4.6, 7.4, 9.2) in
// the real app with the real embedding worker and model, fictional meetings:
//   1. select the search model on the Models page; wait for 3 indexed;
//   2. a word only in a meeting title finds that meeting (a meta hit);
//   3. a word only in a summary finds that meeting (a summary hit), and a
//      click opens the Summary tab;
//   4. a click on a transcript hit scrolls the transcript: the segment at
//      the hit's start_ms is in view and marked;
//   5. screenshots of 2 and 4 in the light and the dark theme (set in
//      Settings > Display);
//   6. delete the search model on the Models page: sqlite3 reads 0 rows in
//      meeting_chunks, meeting_chunk_vec and meeting_index_state.
//
// Mac only. Needs a worker build with the embed mode and a scratch HF cache:
//   OPENSTYLE_MLX_ASR_WORKER=<path>/mlx_asr_worker
//   OPENSTYLE_MLX_EMBED_WORKER=<same path> (no managed-runtime refresh)
//   HUGGINGFACE_HUB_CACHE=<scratch>/hf
// Run it through the Test Runner, in quiet mode, under the GPU lock
// (.claude/skills/live-testing/SKILL.md). It downloads about 579 MB unless
// the scratch cache has the model. Screenshots go to OPENSTYLE_EVIDENCE_DIR.
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

const WORKER = process.env.OPENSTYLE_MLX_ASR_WORKER;
const HF_CACHE = process.env.HUGGINGFACE_HUB_CACHE;
test.skip(
  process.platform !== "darwin" || process.arch !== "arm64" || !WORKER,
  "Mac only: needs OPENSTYLE_MLX_ASR_WORKER with a worker build that has the embed mode",
);
test.skip(
  !HF_CACHE || HF_CACHE.includes("/.cache/huggingface"),
  "needs a scratch HUGGINGFACE_HUB_CACHE (never the real cache)",
);

const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;
const VEC_DYLIB = resolve(__dirname, "../resources/bin/darwin-arm64/vec0");
/** A sqlite3 that can load extensions (Homebrew). The macOS one cannot. */
const SQLITE3 = existsSync("/opt/homebrew/opt/sqlite/bin/sqlite3")
  ? "/opt/homebrew/opt/sqlite/bin/sqlite3"
  : null;

const TITLE_MEETING = "quokka-kickoff";
const SUMMARY_MEETING = "orchard-review";
const LONG_MEETING = "weekly-standup";
const HIT_LINE =
  "Tomas confirmed that the glacier survey drone returns from repair on Thursday.";
const LONG_LINES = Array.from({ length: 60 }, (_, i) =>
  i === 52
    ? HIT_LINE
    : `Item ${i + 1}: the team reviewed ticket ${100 + i} of the billing dashboard and agreed on the next small step.`,
);
const MEETINGS = [
  {
    id: TITLE_MEETING,
    title: "Quokka partnership kickoff",
    lines: [
      "We met the new partner team for the first time today.",
      "Both sides agreed to share the launch plan next week.",
      "Rita will send the contract draft to legal.",
    ],
    summary: null,
  },
  {
    id: SUMMARY_MEETING,
    title: "Orchard review",
    lines: [
      "The apple harvest was smaller than last year.",
      "Leo wants to test a new irrigation schedule.",
    ],
    summary:
      "## Decisions\n- The bakery order of marzipan cakes moves to the spring fair.\n\n## Action items\n- Leo tests the new irrigation schedule.",
  },
  {
    id: LONG_MEETING,
    title: "Weekly standup",
    lines: LONG_LINES,
    summary: null,
  },
];

interface Hit {
  chunk_id: number;
  kind: "transcript" | "meta" | "summary";
  meeting_id: string;
  score: number;
  start_ms: number | null;
  snippet: string;
}

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let base: string;
const dbPath = () => join(userDataDir, "freestyle.db");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status, path).toBeLessThan(300);
  return (await res.json()) as T;
}

const searchStatus = () =>
  api<{ state: string; reason: string | null; meetings: { indexed: number } }>(
    "/api/search/status",
  );

async function searchApi(query: string): Promise<Hit[]> {
  const res = await api<{ status: string; hits: Hit[] }>(
    "/api/search/meetings",
    { method: "POST", body: JSON.stringify({ query }) },
  );
  expect(res.status).toBe("ok");
  return res.hits;
}

const results = () => page.getByRole("region", { name: "Search results" });

async function searchUi(query: string): Promise<void> {
  await page.goto("app://renderer/meetings");
  const box = page.getByRole("searchbox", { name: "Search meetings" });
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(query);
  await box.press("Enter");
  await expect(results().getByRole("listitem")).not.toHaveCount(0, {
    timeout: 60_000,
  });
}

async function setTheme(name: "Light" | "Dark"): Promise<void> {
  await page.goto("app://renderer/settings#display");
  await page.getByRole("radio", { name, exact: true }).click();
  if (name === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

/** A screenshot of the visible part of one element (no recorder card). */
async function shot(name: string, selector: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  const box = await page.locator(selector).first().boundingBox();
  const view =
    page.viewportSize() ??
    (await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })));
  if (!box) throw new Error(`no box for ${selector}`);
  const top = Math.max(box.y, 0);
  const bottom = Math.min(box.y + box.height, view.height);
  await page.screenshot({
    path: join(EVIDENCE_DIR, `${name}.png`),
    clip: { x: box.x, y: top, width: box.width, height: bottom - top },
  });
}

test.beforeAll(async () => {
  if (EVIDENCE_DIR) mkdirSync(EVIDENCE_DIR, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-hits-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  app = await launchOpenstyle({ userDataDir, timeout: 60_000 });
  page = await waitForDashboardWindow(app, 25_000);
  base = embeddedServerUrl(app);
  await api("/api/settings/meeting_enhance_prompt_seen", {
    method: "PUT",
    body: JSON.stringify({ value: "true" }),
  });
  const db = new DatabaseSync(dbPath());
  db.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  MEETINGS.forEach((m, i) => {
    db.prepare(
      `INSERT INTO meetings (id, title, status, started_at, created_at, duration_ms, language)
       VALUES (?, ?, ?, ?, ?, 600000, 'en')`,
    ).run(
      m.id,
      m.title,
      m.summary ? "summarized" : "transcribed",
      now - i * 86_400_000,
      now,
    );
    m.lines.forEach((text, j) => {
      db.prepare(
        `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
         VALUES (?, ?, 'system', ?, ?, ?, ?, 'ok')`,
      ).run(`${m.id}:system:${j}`, m.id, j, j * 8000, j * 8000 + 7000, text);
    });
    if (m.summary) {
      db.prepare(
        "INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES (?, ?, ?)",
      ).run(m.id, m.summary, now);
    }
  });
  db.close();
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

test("search hits open the meeting at the hit; a model delete purges the index", async () => {
  test.setTimeout(20 * 60_000);

  // 1. Select the search model; wait for the index.
  await page.goto("app://renderer/settings/models");
  const section = page.getByTestId("search-model-section");
  await expect(section).toBeVisible({ timeout: 20_000 });
  const download = section.getByRole("button", {
    name: "Download",
    exact: true,
  });
  if (await download.isVisible()) await download.click();
  const use = section.getByRole("button", { name: "Use", exact: true });
  await expect(use).toBeVisible({ timeout: 15 * 60_000 });
  await use.click();
  await expect(section).toContainText("Selected", { timeout: 60_000 });
  await expect
    .poll(async () => (await searchStatus()).meetings.indexed, {
      timeout: 5 * 60_000,
      intervals: [1000],
    })
    .toBe(3);
  const kinds = new DatabaseSync(dbPath(), { readOnly: true });
  console.log(
    `READBACK chunk kinds ${JSON.stringify(
      kinds
        .prepare(
          "SELECT meeting_id, kind, COUNT(*) AS n FROM meeting_chunks GROUP BY meeting_id, kind ORDER BY meeting_id, kind",
        )
        .all(),
    )}`,
  );
  kinds.close();

  for (const theme of ["Light", "Dark"] as const) {
    await setTheme(theme);
    const t = theme.toLowerCase();

    // 2. A word only in a title: the meta hit of that meeting comes first.
    await searchUi("quokka");
    const first = results().getByRole("listitem").first();
    await expect(first).toContainText("Quokka partnership kickoff");
    await expect(first).toContainText("Title and tags");
    await shot(
      `${t}-01-results-title-word`,
      "section[aria-label='Search results']",
    );
    const byTitle = await searchApi("quokka");
    console.log(
      `READBACK title-word hits ${byTitle.map((h) => `${h.meeting_id}:${h.kind}:${h.score.toFixed(4)}`).join(",")}`,
    );
    expect(byTitle[0]).toMatchObject({
      meeting_id: TITLE_MEETING,
      kind: "meta",
    });

    // 3. A word only in a summary: the summary hit; a click opens Summary.
    await searchUi("marzipan");
    const sFirst = results().getByRole("listitem").first();
    await expect(sFirst).toContainText("Orchard review");
    await expect(sFirst).toContainText("Summary");
    const bySummary = await searchApi("marzipan");
    console.log(
      `READBACK summary-word hits ${bySummary.map((h) => `${h.meeting_id}:${h.kind}:${h.score.toFixed(4)}`).join(",")}`,
    );
    expect(bySummary[0]).toMatchObject({
      meeting_id: SUMMARY_MEETING,
      kind: "summary",
    });
    await sFirst.getByRole("button").click();
    await expect(page.getByRole("tab", { name: "Summary" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 20_000 },
    );
    await expect(page.getByText("marzipan cakes")).toBeVisible();

    // 4. A transcript hit scrolls the transcript to its segment.
    const query = "glacier survey drone repair";
    const byText = await searchApi(query);
    const hit = byText[0] as Hit;
    console.log(
      `READBACK transcript hit ${hit.meeting_id}:${hit.kind} start_ms=${hit.start_ms} score=${hit.score.toFixed(4)}`,
    );
    expect(hit).toMatchObject({ meeting_id: LONG_MEETING, kind: "transcript" });
    await searchUi(query);
    await expect(results().getByRole("listitem").first()).toContainText(
      "Weekly standup",
    );
    await shot(
      `${t}-02-results-transcript`,
      "section[aria-label='Search results']",
    );
    await results().getByRole("listitem").first().getByRole("button").click();
    const target = page.locator(
      `[data-testid="meetings-segment"][data-start-ms="${hit.start_ms}"]`,
    );
    await expect(target).toHaveAttribute("data-search-hit", "true", {
      timeout: 20_000,
    });
    await expect(target.locator("p")).toBeInViewport();
    // The first segment of the meeting is out of view: the view scrolled.
    await expect(
      page.locator('[data-testid="meetings-segment"][data-start-ms="0"] p'),
    ).not.toBeInViewport();
    const seen = await target.locator("p").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        h: window.innerHeight,
      };
    });
    console.log(
      `READBACK scrolled segment start_ms=${hit.start_ms} rect=${JSON.stringify(seen)}`,
    );
    await shot(`${t}-03-transcript-scrolled`, "[role='tabpanel']");
  }

  // 6. Delete the search model on the Models page: the index is purged.
  await page.goto("app://renderer/settings/models");
  await expect(section).toBeVisible({ timeout: 20_000 });
  await section
    .getByRole("button", { name: "Remove downloaded model from disk" })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .poll(async () => (await searchStatus()).reason, { timeout: 30_000 })
    .toBe("no_model");
  const sql =
    "select count(*) from meeting_chunks; select count(*) from meeting_chunk_vec; select count(*) from meeting_index_state;";
  const args = SQLITE3
    ? ["-readonly", "-cmd", `.load ${VEC_DYLIB}`, dbPath(), sql]
    : [
        "-readonly",
        dbPath(),
        sql.replace("meeting_chunk_vec;", "meeting_chunk_vec_rowids;"),
      ];
  const out = execFileSync(SQLITE3 ?? "sqlite3", args, { encoding: "utf8" });
  console.log(`READBACK sqlite3 ${SQLITE3 ?? "sqlite3"} "${sql}"\n${out}`);
  expect(out.trim().split("\n")).toEqual(["0", "0", "0"]);
});
