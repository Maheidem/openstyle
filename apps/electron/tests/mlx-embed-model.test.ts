import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// The built-in search model (#233, specs/local-semantic-search.md 5.5,
// 12.4 item 6) in the real app, with the real worker and the real model:
//   1. the Models page shows the "Search model" group with the
//      EmbeddingGemma 2 row; Download fetches the model from Hugging Face
//      with progress until the row is ready;
//   2. Use makes it the search model and loads it: GET /api/mlx-embed/status
//      reads back the worker as ready with 768 dims;
//   3. POST /v1/embeddings on the worker returns 768-dim unit vectors for
//      fictional text, and the query finds the matching sentence;
//   4. the run count is read back from the worker log lines in the app
//      output;
//   5. Delete removes the model and clears the search model.
// No LLM model is set up (D6).
//
// Mac only. It needs a worker build with the embed mode and a scratch HF
// cache, so it is skipped on Linux CI and when these are not set:
//   OPENSTYLE_MLX_ASR_WORKER=<repo>/dist/mlx_asr_worker/mlx_asr_worker
//   HUGGINGFACE_HUB_CACHE=<scratch>/hf
// Run it through the Test Runner, in quiet mode, under the GPU lock
// (.claude/skills/live-testing/SKILL.md). It downloads about 579 MB.
// Screenshots go to OPENSTYLE_EVIDENCE_DIR when set.
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
const DOCS = [
  "The lighthouse keeper painted the door blue every spring.",
  "A small robot named Pip sorts red and green marbles.",
  "On Tuesday the bakery on Maple Street sold forty lemon tarts.",
];
const QUERY = "who sold lemon tarts";
const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let base: string;
const output: string[] = [];

interface EmbedStatus {
  selected: string | null;
  models: Array<{
    model: string;
    status: string;
    selected: boolean;
    downloadProgress?: { percent: number };
    error?: string;
  }>;
  worker: {
    model: string | null;
    state: string;
    port: number | null;
    dims: number | null;
    error?: string;
  };
}

async function status(): Promise<EmbedStatus> {
  const res = await fetch(`${base}/api/mlx-embed/status`);
  expect(res.status).toBe(200);
  return (await res.json()) as EmbedStatus;
}

async function poll(
  what: string,
  check: (s: EmbedStatus) => boolean,
  ms: number,
): Promise<EmbedStatus> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await status();
    if (check(s)) return s;
    const row = s.models[0];
    if (row?.status === "error") throw new Error(`${what}: ${row.error}`);
    if (s.worker.state === "error") {
      throw new Error(`${what}: ${s.worker.error}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`${what}: timeout, last ${JSON.stringify(s)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function shot(name: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  await section().screenshot({ path: join(EVIDENCE_DIR, `${name}.png`) });
}

function section() {
  return page.getByTestId("search-model-section");
}

/** Worker log lines of embedding requests that got a 200. */
function embedRunCount(): number {
  return (
    output.join("").match(/"POST \/v1\/embeddings HTTP\/1\.1" 200/g) ?? []
  ).length;
}

async function embed(port: number, input: string[]) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
    openstyle: { tokens: number[] };
  };
}

test.beforeAll(async () => {
  if (EVIDENCE_DIR) mkdirSync(EVIDENCE_DIR, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-embed-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  app = await launchOpenstyle({ userDataDir, timeout: 60_000 });
  // The server process writes its log lines (and the worker log) to the
  // stdout of main.
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  }
  page = await waitForDashboardWindow(app, 25_000);
  base = embeddedServerUrl(app);
});

test.afterAll(async () => {
  if (EVIDENCE_DIR) {
    writeFileSync(join(EVIDENCE_DIR, "app-output.log"), output.join(""));
  }
  if (app) await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
});

test("download, Use, embed, read back, delete", async () => {
  test.setTimeout(15 * 60_000);
  const before = await status();
  expect(before.selected).toBeNull();
  expect(before.models.map((m) => m.model)).toEqual([MODEL]);

  await page.goto("app://renderer/settings/models");
  await expect(section()).toBeVisible({ timeout: 20_000 });
  await expect(section()).toContainText("Search model");
  await expect(section()).toContainText("EmbeddingGemma 2");
  await shot("01-not-downloaded");

  // 1. Download with progress.
  await section().getByRole("button", { name: "Download" }).click();
  const progress = await poll(
    "download progress",
    (s) =>
      (s.models[0]?.downloadProgress?.percent ?? 0) > 0 ||
      s.models[0]?.status === "ready",
    60_000,
  );
  if (progress.models[0]?.status !== "ready") {
    await expect(section()).toContainText("%");
    await shot("02-downloading");
  }
  await poll("download", (s) => s.models[0]?.status === "ready", 12 * 60_000);
  await expect(section().getByRole("button", { name: "Use" })).toBeVisible({
    timeout: 10_000,
  });
  await shot("03-ready");

  // 2. Use: the search model is set and loads once.
  await section().getByRole("button", { name: "Use" }).click();
  const used = await poll(
    "worker load",
    (s) => s.worker.state === "ready",
    3 * 60_000,
  );
  expect(used.selected).toBe(MODEL);
  expect(used.models[0]?.selected).toBe(true);
  expect(used.worker).toMatchObject({ model: MODEL, dims: 768 });
  await expect(section()).toContainText("Selected");
  await shot("04-selected");

  // 3. POST /v1/embeddings on the worker. The server adds the prompts in
  // the app (spec S10); this direct call adds them itself.
  const port = used.worker.port ?? 0;
  expect(port).toBeGreaterThan(0);
  const runsBefore = embedRunCount();
  const docs = await embed(
    port,
    DOCS.map((d) => `title: none | text: ${d}`),
  );
  const query = await embed(port, [`task: search result | query: ${QUERY}`]);
  expect(docs.data.map((d) => d.index)).toEqual([0, 1, 2]);
  const vectors = docs.data.map((d) => d.embedding);
  for (const v of [...vectors, query.data[0].embedding]) {
    expect(v).toHaveLength(768);
    expect(v.every(Number.isFinite)).toBe(true);
    expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-3);
  }
  const q = query.data[0].embedding;
  const scores = vectors.map((v) => v.reduce((sum, x, i) => sum + x * q[i], 0));
  expect(scores.indexOf(Math.max(...scores))).toBe(2);

  // 4. Read back: dims from the status, run count from the worker log.
  await expect.poll(embedRunCount, { timeout: 10_000 }).toBe(runsBefore + 2);
  const after = await status();
  expect(after.worker).toMatchObject({ state: "ready", dims: 768 });
  console.log(
    `READBACK dims=${after.worker.dims} runs=${embedRunCount()} scores=${scores
      .map((s) => s.toFixed(4))
      .join(",")} tokens=${docs.openstyle.tokens.join(",")}`,
  );

  // 5. Delete: the files go and the search model is cleared.
  await section()
    .getByRole("button", { name: /Remove downloaded model/ })
    .click();
  await page
    .getByRole("button", { name: /Delete/ })
    .last()
    .click();
  const deleted = await poll(
    "delete",
    (s) => s.models[0]?.status === "not_downloaded",
    30_000,
  );
  expect(deleted.selected).toBeNull();
  await expect(section().getByRole("button", { name: "Download" })).toBeVisible(
    {
      timeout: 10_000,
    },
  );
  await shot("05-deleted");
});
