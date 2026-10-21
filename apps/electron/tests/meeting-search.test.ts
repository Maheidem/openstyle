import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Meeting search E2E (#86, specs/local-semantic-search.md 12.3) in the real
// app with the real embedding worker and model, fictional meetings only:
//   0. with no search model, the search box is off and says why;
//   1. download the search model on the Models page and press Use;
//   2. wait for meetings.indexed = 6 in GET /api/search/status;
//   3. search "when is the release date" in folder Aurora: the first hit is
//      the "Friday" chunk; read back its chunk_id from meeting_chunks;
//   4. move that meeting to Atlas: the vec0 row has folder_id = Atlas, the
//      vector bytes are equal, and no embedding call ran;
//   5. search in Aurora again (the meeting is gone) and in Atlas (it is there);
//   6. restart the app: 6 indexed, queue 0, no chunk embedded again.
//
// Mac only. It needs a worker build with the embed mode, a scratch HF cache
// and a scratch HOME, so it is skipped on Linux CI and when these are not set:
//   OPENSTYLE_MLX_ASR_WORKER=<repo>/dist/mlx_asr_worker/mlx_asr_worker
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

const MODEL = "embeddinggemma-2-bf16-text";
const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;
const VEC_DYLIB = resolve(
  __dirname,
  "../resources/bin/darwin-arm64/vec0.dylib",
);
const QUERY = "when is the release date";

// Six fictional meetings (12.3): 3 in Aurora (PT and EN), 2 in Atlas, 1
// unfiled. FRIDAY says "the launch moves to Friday" in other words.
const FRIDAY = "aurora-ship-date";
const MEETINGS: {
  id: string;
  folder: "Aurora" | "Atlas" | null;
  title: string;
  language: string;
  lines: string[];
}[] = [
  {
    id: FRIDAY,
    folder: "Aurora",
    title: "Aurora vendor sync",
    language: "en",
    lines: [
      "Lena said the firmware vendor needs two more days.",
      "So we will put Aurora in the hands of customers on Friday, not Wednesday.",
      "Marco will tell the support team about the new day.",
    ],
  },
  {
    id: "aurora-budget",
    folder: "Aurora",
    title: "Orçamento do Aurora",
    language: "pt",
    lines: [
      "Revisamos o orçamento do projeto Aurora para o próximo trimestre.",
      "A Júlia pediu mais verba para os testes de bateria.",
      "O custo dos protótipos ficou acima do plano.",
    ],
  },
  {
    id: "aurora-design",
    folder: "Aurora",
    title: "Aurora design review",
    language: "en",
    lines: [
      "The team compared two colors for the Aurora case.",
      "Priya prefers the matte finish because it hides fingerprints.",
      "We agreed to print three samples of each finish.",
    ],
  },
  {
    id: "atlas-onboarding",
    folder: "Atlas",
    title: "Atlas onboarding",
    language: "en",
    lines: [
      "Atlas needs a shorter onboarding guide for new users.",
      "Omar will remove the account setup screen.",
    ],
  },
  {
    id: "atlas-precos",
    folder: "Atlas",
    title: "Preços do Atlas",
    language: "pt",
    lines: [
      "Discutimos a tabela de preços do Atlas para escolas.",
      "O desconto anual fica em quinze por cento.",
    ],
  },
  {
    id: "team-lunch",
    folder: null,
    title: "Team lunch plan",
    language: "en",
    lines: [
      "We picked the noodle place near the station for the team lunch.",
      "Sofia will book a table for twelve people.",
    ],
  },
];

interface SearchStatus {
  state: string;
  reason: string | null;
  model_id: string | null;
  vec_version: string | null;
  meetings: {
    eligible: number;
    indexed: number;
    failed: number;
    queued: number;
  };
  index: { db_bytes: number; vector_chunks: number; embedded_chunks: number };
}
interface Hit {
  chunk_id: number;
  meeting_id: string;
  score: number;
  snippet: string;
}

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let base: string;
const folderIds: Record<string, string> = {};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status, path).toBeLessThan(300);
  return (await res.json()) as T;
}

const searchStatus = () => api<SearchStatus>("/api/search/status");

async function searchApi(folderId: string): Promise<Hit[]> {
  const res = await api<{ status: string; hits: Hit[] }>(
    "/api/search/meetings",
    {
      method: "POST",
      body: JSON.stringify({ query: QUERY, folder_id: folderId }),
    },
  );
  expect(res.status).toBe("ok");
  return res.hits;
}

async function shot(name: string, locator = page.locator("main")) {
  if (!EVIDENCE_DIR) return;
  await locator.screenshot({ path: join(EVIDENCE_DIR, `${name}.png`) });
}

/** Open the DB read-only with the vec0 module (test process only). */
function openDb(): DatabaseSync {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"), {
    readOnly: true,
    allowExtension: true,
  });
  db.loadExtension(VEC_DYLIB);
  db.enableLoadExtension(false);
  return db;
}

async function start(): Promise<void> {
  app = await launchOpenstyle({ userDataDir, timeout: 60_000 });
  page = await waitForDashboardWindow(app, 25_000);
  base = embeddedServerUrl(app);
}

async function searchInFolder(name: string): Promise<void> {
  await page.goto("app://renderer/meetings");
  await page.getByRole("button", { name, exact: true }).click();
  const box = page.getByRole("searchbox", { name: "Search meetings" });
  await expect(box).toBeEnabled();
  await box.fill(QUERY);
  await box.press("Enter");
  await expect(
    page.getByRole("region", { name: "Search results" }).getByRole("listitem"),
  ).not.toHaveCount(0, { timeout: 60_000 });
}

test.beforeAll(async () => {
  if (EVIDENCE_DIR) mkdirSync(EVIDENCE_DIR, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-search-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  await start();
  await api("/api/settings/meeting_enhance_prompt_seen", {
    method: "PUT",
    body: JSON.stringify({ value: "true" }),
  });
  for (const name of ["Aurora", "Atlas"]) {
    const f = await api<{ id: string }>("/api/meetings/folders", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    folderIds[name] = f.id;
  }
  // The isolated DB of this run (WAL, busy timeout): meetings and segments.
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  MEETINGS.forEach((m, i) => {
    db.prepare(
      `INSERT INTO meetings (id, title, status, started_at, created_at, duration_ms, folder_id, language)
       VALUES (?, ?, 'transcribed', ?, ?, 60000, ?, ?)`,
    ).run(
      m.id,
      m.title,
      now - i * 86_400_000,
      now,
      m.folder ? folderIds[m.folder] : null,
      m.language,
    );
    m.lines.forEach((text, j) => {
      db.prepare(
        `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
         VALUES (?, ?, 'system', ?, ?, ?, ?, 'ok')`,
      ).run(`${m.id}:system:${j}`, m.id, j, j * 6000, j * 6000 + 5000, text);
    });
  });
  db.close();
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

test("search index end to end", async () => {
  test.setTimeout(20 * 60_000);

  // 0. No search model: the box is off and names the reason (9.1).
  const off = await searchStatus();
  expect(off).toMatchObject({
    state: "off",
    reason: "no_model",
    vec_version: "v0.1.9",
  });
  await page.goto("app://renderer/meetings");
  const box = page.getByRole("searchbox", { name: "Search meetings" });
  await expect(box).toBeDisabled();
  await expect(
    page.getByText("Download a search model in Models."),
  ).toBeVisible();
  await shot("00-search-off-no-model");

  // 1. Download the search model on the Models page and press Use.
  await page.goto("app://renderer/settings/models");
  const section = page.getByTestId("search-model-section");
  await expect(section).toBeVisible({ timeout: 20_000 });
  // exact: the row of a model on disk has "Remove downloaded model".
  const download = section.getByRole("button", {
    name: "Download",
    exact: true,
  });
  if (await download.isVisible()) await download.click();
  await expect(
    section.getByRole("button", { name: "Use", exact: true }),
  ).toBeVisible({
    timeout: 15 * 60_000,
  });
  await section.getByRole("button", { name: "Use", exact: true }).click();
  await expect(section).toContainText("Selected", { timeout: 60_000 });
  await shot("01-search-model-selected", section);

  // 2. Wait for meetings.indexed = 6.
  await expect
    .poll(async () => (await searchStatus()).meetings.indexed, {
      timeout: 5 * 60_000,
      intervals: [1000],
    })
    .toBe(6);
  const indexed = await searchStatus();
  console.log(`READBACK status-indexed ${JSON.stringify(indexed)}`);
  expect(indexed).toMatchObject({
    state: "on",
    model_id: MODEL,
    meetings: { eligible: 6, indexed: 6, failed: 0 },
  });

  // 3. Search in Aurora: the first hit is the Friday chunk.
  await searchInFolder("Aurora");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.getByRole("listitem").first()).toContainText(
    "Aurora vendor sync",
  );
  await expect(results.getByRole("listitem").first()).toContainText("Friday");
  await shot("02-results-aurora");
  const aurora = await searchApi(folderIds.Aurora);
  expect(aurora[0]?.meeting_id).toBe(FRIDAY);
  const hitId = aurora[0]?.chunk_id as number;
  const db = openDb();
  const chunkRow = db
    .prepare(
      "SELECT id, meeting_id, model_id, segment_ids FROM meeting_chunks WHERE id = ?",
    )
    .get(hitId);
  console.log(
    `READBACK hit chunk_id=${hitId} score=${aurora[0]?.score.toFixed(4)} row=${JSON.stringify(chunkRow)} hits=${aurora.map((h) => `${h.meeting_id}:${h.score.toFixed(4)}`).join(",")}`,
  );
  expect(chunkRow).toMatchObject({
    id: hitId,
    meeting_id: FRIDAY,
    model_id: MODEL,
  });
  const vecRow = (id: number) =>
    db
      .prepare(
        "SELECT folder_id, hex(embedding) AS hex FROM meeting_chunk_vec WHERE chunk_id = ?",
      )
      .get(BigInt(id)) as { folder_id: string; hex: string };
  const before = vecRow(hitId);
  expect(before.folder_id).toBe(folderIds.Aurora);
  const embeddedBefore = (await searchStatus()).index.embedded_chunks;

  // 4. Move the meeting to Atlas: same vector bytes, new partition, no embed.
  await api("/api/meetings/move", {
    method: "POST",
    body: JSON.stringify({ meeting_ids: [FRIDAY], folder_id: folderIds.Atlas }),
  });
  const after = vecRow(hitId);
  expect(after.folder_id).toBe(folderIds.Atlas);
  expect(after.hex).toBe(before.hex);
  // Give the indexer loop time to see the move, then check no embed ran.
  await page.waitForTimeout(4000);
  const moved = await searchStatus();
  expect(moved.index.embedded_chunks).toBe(embeddedBefore);
  expect(moved.meetings.indexed).toBe(6);
  console.log(
    `READBACK move folder ${before.folder_id}->${after.folder_id} bytesEqual=${after.hex === before.hex} embedded_chunks=${embeddedBefore}->${moved.index.embedded_chunks}`,
  );
  db.close();

  // 5. Aurora no longer has it; Atlas has it first.
  const auroraAfter = await searchApi(folderIds.Aurora);
  expect(auroraAfter.map((h) => h.meeting_id)).not.toContain(FRIDAY);
  const atlas = await searchApi(folderIds.Atlas);
  expect(atlas[0]?.meeting_id).toBe(FRIDAY);
  await searchInFolder("Aurora");
  await expect(results).not.toContainText("Aurora vendor sync");
  await shot("03-results-aurora-after-move");
  await searchInFolder("Atlas");
  await expect(results.getByRole("listitem").first()).toContainText(
    "Aurora vendor sync",
  );
  await shot("04-results-atlas-after-move");
  console.log(
    `READBACK after-move aurora=${auroraAfter.map((h) => h.meeting_id).join(",")} atlas=${atlas.map((h) => h.meeting_id).join(",")}`,
  );

  // A click on a result opens the meeting.
  await results.getByRole("listitem").first().getByRole("button").click();
  await expect(page.getByText("Lena said the firmware vendor")).toBeVisible({
    timeout: 20_000,
  });
  await shot("05-opened-from-result");

  // 6. Restart: 6 indexed, queue 0, nothing embedded again.
  await closeApp(app);
  await start();
  await page.waitForTimeout(10_000);
  const restarted = await searchStatus();
  console.log(`READBACK restart ${JSON.stringify(restarted)}`);
  expect(restarted).toMatchObject({
    state: "on",
    meetings: { eligible: 6, indexed: 6, failed: 0, queued: 0 },
  });
  expect(restarted.index.embedded_chunks).toBe(0);
});
