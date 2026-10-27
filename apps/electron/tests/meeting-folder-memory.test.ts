import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
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
// Project memory E2E (#234, specs/local-semantic-search.md 12.4 "#234") in
// the real app with the real embedding model and the built-in Gemma 4 E2B,
// fictional meetings only:
//   1. folder Aurora holds an earlier meeting with the decision "the launch
//      moves to Friday" (transcript and summary); folder Atlas holds another
//      decision; one meeting is unfiled;
//   2. download the search model, press Use, wait until all are indexed;
//   3. Enhance (with the chained Summarize) of a new Aurora meeting: the run
//      record holds the earlier Aurora meeting id and chunk ids, the Summary
//      prompt holds the labeled block with "Friday", the correct prompts hold
//      no chunk text; the inspector shows the ids (light and dark theme);
//   4. the same for a new Atlas meeting and an unfiled meeting: no Aurora
//      chunk, no "Friday" in their prompts;
//   5. with the vec0 dylib renamed, Enhance and Summarize run with no
//      retrieval and no error.
//
// Mac only. It needs a worker build with the embed and llm modes, a scratch
// HF cache that holds gemma-4-E2B-it-qat-4bit, and a scratch HOME:
//   OPENSTYLE_MLX_ASR_WORKER, OPENSTYLE_MLX_LLM_WORKER, OPENSTYLE_MLX_EMBED_WORKER
//   HUGGINGFACE_HUB_CACHE=<scratch>/hf
// Run it through the Test Runner, in quiet mode, under the GPU lock
// (.claude/skills/live-testing/SKILL.md). Screenshots go to
// OPENSTYLE_EVIDENCE_DIR.
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

const WORKER = process.env.OPENSTYLE_MLX_LLM_WORKER;
const HF_CACHE = process.env.HUGGINGFACE_HUB_CACHE;
test.skip(
  process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    !WORKER ||
    !process.env.OPENSTYLE_MLX_EMBED_WORKER,
  "Mac only: needs OPENSTYLE_MLX_LLM_WORKER and OPENSTYLE_MLX_EMBED_WORKER",
);
test.skip(
  !HF_CACHE || HF_CACHE.includes("/.cache/huggingface"),
  "needs a scratch HUGGINGFACE_HUB_CACHE (never the real cache)",
);

const LLM = "gemma-4-e2b-qat-4bit";
const EVIDENCE_DIR = process.env.OPENSTYLE_EVIDENCE_DIR;
const VEC_DYLIB = resolve(
  __dirname,
  "../resources/bin/darwin-arm64/vec0.dylib",
);
const LABEL = "Earlier meetings in this folder";

interface Seed {
  id: string;
  folder: "Aurora" | "Atlas" | null;
  title: string;
  daysAgo: number;
  lines: [string, string][];
  summary?: string;
}

// Fictional meetings. AURORA_OLD holds the decision. The new meetings refer
// to "the day we agreed" without the day.
const AURORA_OLD = "aurora-vendor-sync";
const AURORA_NEW = "aurora-press-check";
const ATLAS_NEW = "atlas-press-check";
const LOOSE_NEW = "loose-press-check";
const MEETINGS: Seed[] = [
  {
    id: AURORA_OLD,
    folder: "Aurora",
    title: "Aurora vendor sync",
    daysAgo: 7,
    lines: [
      ["Me", "Lena, what did the firmware vendor say?"],
      ["Them", "They need two more days for the battery fix."],
      [
        "Me",
        "Then we decide it now: the Aurora launch moves to Friday, not Wednesday.",
      ],
      ["Them", "Agreed. Marco tells the support team about Friday."],
    ],
    summary:
      "## Decisions\n- The Aurora launch moves to Friday, not Wednesday, because the firmware vendor needs two more days.\n\n## Action items\n- Marco tells the support team about the new launch day.",
  },
  {
    id: "atlas-pricing",
    folder: "Atlas",
    title: "Atlas pricing",
    daysAgo: 6,
    lines: [
      ["Me", "Omar, where are we on the school price for Atlas?"],
      ["Them", "We keep the yearly discount at fifteen percent."],
      ["Me", "Good. Then the Atlas school price stays as it is."],
    ],
  },
  {
    id: AURORA_NEW,
    folder: "Aurora",
    title: "Aurora press check",
    daysAgo: 0,
    lines: [
      ["Me", "Quick check on the Aurora press note."],
      [
        "Them",
        "The launch day that we agreed in the vendor meeting still holds.",
      ],
      ["Me", "Good. Then the press note goes out one day before the launch."],
      ["Them", "I will send the draft to Marco tomorrow."],
    ],
  },
  {
    id: ATLAS_NEW,
    folder: "Atlas",
    title: "Atlas press check",
    daysAgo: 0,
    lines: [
      ["Me", "Quick check on the Atlas press note."],
      [
        "Them",
        "The launch day that we agreed in the vendor meeting still holds.",
      ],
      ["Me", "Good. Then the press note goes out one day before the launch."],
    ],
  },
  {
    id: LOOSE_NEW,
    folder: null,
    title: "Press check",
    daysAgo: 0,
    lines: [
      ["Me", "Quick check on the press note."],
      [
        "Them",
        "The launch day that we agreed in the vendor meeting still holds.",
      ],
    ],
  },
];

interface Retrieval {
  modelId: string;
  meetingIds: string[];
  chunkIds: number[];
}
interface RunInfo {
  id: string;
  status: string;
  errorKind: string | null;
  retrieval: Retrieval | null;
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

async function start(): Promise<void> {
  app = await launchOpenstyle({ userDataDir, timeout: 60_000 });
  page = await waitForDashboardWindow(app, 25_000);
  base = embeddedServerUrl(app);
}

/** Read-only DB rows of the test process (no vec0 table read). */
function readDb<T>(sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"), {
    readOnly: true,
  });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** Enhance with the chained Summarize. Waits for the run and returns it. */
async function enhance(meetingId: string): Promise<RunInfo> {
  const started = await api<{ runId: string }>(
    `/api/meetings/${meetingId}/enhance`,
    { method: "POST" },
  );
  await expect
    .poll(
      async () =>
        (await api<{ job: unknown }>(`/api/meetings/${meetingId}`)).job ?? null,
      { timeout: 15 * 60_000, intervals: [2000] },
    )
    .toBeNull();
  const { runs } = await api<{ runs: RunInfo[] }>(
    `/api/meetings/${meetingId}/llm-runs?run_id=${started.runId}`,
  );
  expect(runs).toHaveLength(1);
  return runs[0] as RunInfo;
}

/** The system and user text of every call of a run, by node. */
function promptsOf(
  runId: string,
): { node: string; step: string; text: string }[] {
  return readDb<{ node: string; step_key: string; messages_json: string }>(
    "SELECT node, step_key, messages_json FROM llm_calls WHERE run_id = ? ORDER BY id",
    runId,
  ).map((r) => ({ node: r.node, step: r.step_key, text: r.messages_json }));
}

function summaryOf(meetingId: string): string {
  return (
    readDb<{ markdown: string | null }>(
      "SELECT markdown FROM meeting_summaries WHERE meeting_id = ?",
      meetingId,
    )[0]?.markdown ?? ""
  );
}

async function setTheme(name: "Light" | "Dark"): Promise<void> {
  await page.goto("app://renderer/settings#display");
  await page.getByRole("radio", { name, exact: true }).click();
  if (name === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

/** Open a filed meeting, the inspector and its newest run. */
async function openRunInInspector(
  title: string,
  folder: string,
): Promise<void> {
  // A folder group starts closed: a click on the folder shows its meetings.
  await page.goto("app://renderer/meetings");
  const rail = page.getByRole("complementary", {
    name: "Meetings and folders",
  });
  const row = rail.getByRole("group", { name: folder, exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const item = row
    .locator("..")
    .getByRole("button", { name: new RegExp(title) });
  if (!(await item.isVisible())) {
    await row.getByRole("button", { name: folder, exact: true }).click();
  }
  await item.click();
  await expect(page.getByTestId("meetings-segment").first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId("meetings-inspector-open").click();
  await page.getByTestId("meetings-inspector-run").first().click();
  await expect(page.getByTestId("meetings-inspector-retrieval")).toBeVisible({
    timeout: 20_000,
  });
}

test.beforeAll(async () => {
  if (EVIDENCE_DIR) mkdirSync(EVIDENCE_DIR, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-memory-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  await start();
  for (const [key, value] of [
    ["meeting_enhance_prompt_seen", "true"],
    ["advanced_mode", "true"],
    ["mlx_llm_keep_alive_minutes", "-1"],
    // Project memory is on by default (#234): the row is left unset.
  ]) {
    await api(`/api/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  }
  await api("/api/models/configured", {
    method: "POST",
    body: JSON.stringify({
      provider: "local-mlx-llm",
      model_id: `local-mlx-llm/${LLM}`,
      model_name: LLM,
      type: "llm",
      is_default: true,
    }),
  });
  for (const name of ["Aurora", "Atlas"]) {
    const f = await api<{ id: string }>("/api/meetings/folders", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    folderIds[name] = f.id;
  }
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  for (const m of MEETINGS) {
    const at = now - m.daysAgo * 86_400_000;
    db.prepare(
      `INSERT INTO meetings (id, title, status, started_at, created_at, duration_ms, folder_id, language)
       VALUES (?, ?, 'transcribed', ?, ?, 60000, ?, 'en')`,
    ).run(
      m.id,
      m.title,
      at,
      at,
      m.folder ? (folderIds[m.folder] as string) : null,
    );
    m.lines.forEach(([who, text], j) => {
      db.prepare(
        `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ok')`,
      ).run(
        `${m.id}:${j}`,
        m.id,
        who === "Me" ? "mic" : "system",
        j,
        j * 6000,
        j * 6000 + 5000,
        text,
      );
    });
    if (m.summary) {
      db.prepare(
        "INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES (?, ?, ?)",
      ).run(m.id, m.summary, at);
    }
  }
  db.close();
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  if (existsSync(`${VEC_DYLIB}.off`)) renameSync(`${VEC_DYLIB}.off`, VEC_DYLIB);
  rmSync(userDataDir, { recursive: true, force: true });
});

test("project memory end to end", async () => {
  test.setTimeout(45 * 60_000);

  // 2. The search model: download, Use, wait for the index.
  await page.goto("app://renderer/settings/models");
  const section = page.getByTestId("search-model-section");
  await expect(section).toBeVisible({ timeout: 20_000 });
  const download = section.getByRole("button", {
    name: "Download",
    exact: true,
  });
  if (await download.isVisible()) await download.click();
  await expect(
    section.getByRole("button", { name: "Use", exact: true }),
  ).toBeVisible({ timeout: 15 * 60_000 });
  await section.getByRole("button", { name: "Use", exact: true }).click();
  await expect(section).toContainText("Selected", { timeout: 60_000 });
  await expect
    .poll(
      async () =>
        (await api<{ meetings: { indexed: number } }>("/api/search/status"))
          .meetings.indexed,
      { timeout: 5 * 60_000, intervals: [1000] },
    )
    .toBe(MEETINGS.length);

  // 3. The new Aurora meeting.
  const aurora = await enhance(AURORA_NEW);
  console.log(
    `READBACK aurora run=${aurora.id} status=${aurora.status} error=${aurora.errorKind} retrieval=${JSON.stringify(aurora.retrieval)}`,
  );
  expect(aurora.status).toBe("succeeded");
  expect(aurora.retrieval?.meetingIds).toEqual([AURORA_OLD]);
  expect(aurora.retrieval?.chunkIds.length).toBeGreaterThan(0);
  const chunkRows = readDb<{ id: number; meeting_id: string; kind: string }>(
    `SELECT id, meeting_id, kind FROM meeting_chunks WHERE id IN (${aurora.retrieval?.chunkIds.map(() => "?").join(", ")})`,
    ...(aurora.retrieval?.chunkIds ?? []),
  );
  console.log(`READBACK aurora chunks ${JSON.stringify(chunkRows)}`);
  expect(chunkRows).toHaveLength(aurora.retrieval?.chunkIds.length ?? -1);
  for (const row of chunkRows) {
    expect(row.meeting_id).toBe(AURORA_OLD);
    expect(["summary", "transcript"]).toContain(row.kind);
  }
  const auroraPrompts = promptsOf(aurora.id);
  // Project memory goes to the overview call only (graph version 10): the
  // stage calls list the items of this meeting only.
  const summaryPrompts = auroraPrompts.filter((p) => p.node === "summarize");
  expect(summaryPrompts.length).toBeGreaterThan(0);
  for (const p of summaryPrompts) {
    const isOverview = p.step === "overview";
    expect(p.text.includes(LABEL), p.step).toBe(isOverview);
    if (isOverview) expect(p.text).toContain("moves to Friday");
  }
  const correctPrompts = auroraPrompts.filter((p) => p.node === "correctChunk");
  expect(correctPrompts.length).toBeGreaterThan(0);
  for (const p of correctPrompts) {
    expect(p.text).not.toContain(LABEL);
    expect(p.text).not.toContain("moves to Friday");
    expect(p.text).not.toContain("firmware vendor");
  }
  const auroraSummary = summaryOf(AURORA_NEW);
  console.log(
    `READBACK aurora summary chars=${auroraSummary.length} cites-friday=${/friday/i.test(auroraSummary)}`,
  );
  console.log(`READBACK aurora summary text=${JSON.stringify(auroraSummary)}`);

  // Inspector, light and dark.
  for (const theme of ["Light", "Dark"] as const) {
    await setTheme(theme);
    await openRunInInspector("Aurora press check", "Aurora");
    const panel = page.getByTestId("meetings-inspector-retrieval");
    await expect(panel).toContainText(AURORA_OLD);
    await expect(panel).toContainText(String(aurora.retrieval?.chunkIds[0]));
    if (EVIDENCE_DIR) {
      await page.getByTestId("meetings-inspector").screenshot({
        path: join(
          EVIDENCE_DIR,
          `inspector-retrieval-${theme.toLowerCase()}.png`,
        ),
      });
    }
  }
  await setTheme("Light");

  // 4. Outside the folder: Atlas gets only Atlas, unfiled gets nothing.
  const atlas = await enhance(ATLAS_NEW);
  console.log(
    `READBACK atlas run=${atlas.id} status=${atlas.status} retrieval=${JSON.stringify(atlas.retrieval)}`,
  );
  expect(atlas.status).toBe("succeeded");
  expect(atlas.retrieval?.meetingIds ?? []).not.toContain(AURORA_OLD);
  for (const p of promptsOf(atlas.id)) {
    // The base prompt has "next Friday" as an example: check the decision.
    expect(p.text).not.toContain("moves to Friday");
    expect(p.text).not.toContain("firmware vendor");
  }
  const loose = await enhance(LOOSE_NEW);
  console.log(
    `READBACK loose run=${loose.id} status=${loose.status} retrieval=${JSON.stringify(loose.retrieval)}`,
  );
  expect(loose.status).toBe("succeeded");
  expect(loose.retrieval).toBeNull();
  for (const p of promptsOf(loose.id)) {
    expect(p.text).not.toContain(LABEL);
    // The base prompt has "next Friday" as an example: check the decision.
    expect(p.text).not.toContain("moves to Friday");
    expect(p.text).not.toContain("firmware vendor");
  }

  // 5. Search off: the dylib renamed in this checkout.
  await closeApp(app);
  renameSync(VEC_DYLIB, `${VEC_DYLIB}.off`);
  try {
    await start();
    const status = await api<{ state: string; reason: string | null }>(
      "/api/search/status",
    );
    console.log(`READBACK off status=${JSON.stringify(status)}`);
    expect(status).toMatchObject({ state: "off", reason: "extension_missing" });
    const off = await enhance(AURORA_NEW);
    console.log(
      `READBACK off run=${off.id} status=${off.status} error=${off.errorKind} retrieval=${JSON.stringify(off.retrieval)}`,
    );
    expect(off.status).toBe("succeeded");
    expect(off.errorKind).toBeNull();
    expect(off.retrieval).toBeNull();
    const offPrompts = promptsOf(off.id);
    expect(offPrompts.some((p) => p.node === "summarize")).toBe(true);
    expect(offPrompts.some((p) => p.node === "correctChunk")).toBe(true);
    for (const p of offPrompts) expect(p.text).not.toContain(LABEL);
  } finally {
    renameSync(`${VEC_DYLIB}.off`, VEC_DYLIB);
  }
});
