import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { withPickerFile } from "./e2e-helpers";
import {
  closeApp,
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";
import { openMeeting, seedMeeting } from "./helpers/enhance-fixture";
import { pcm16Wav } from "./helpers/wav";

// ---------------------------------------------------------------------------
// Meetings with no AI model (#229). The app has a voice model and NO default
// LLM row. The spec proves in the real app:
//   1. the one-time auto-Enhance prompt has no "Turn on" button;
//   2. the detail view disables Enhance and Summarize, shows one hint line,
//      and hides the notice of an old failed run (errorKind
//      model_unavailable);
//   3. the auto-Enhance popover has a disabled switch and the same hint;
//   4. POST enhance and summarize answer 409 {code: "no_llm"} and write no run;
//   5. a real transcription (fake own STT server) with auto-run "true" ends
//      in `transcribed`, logs the skip line, and starts no run;
//   6. control: with a default LLM added, the same old run shows its notice
//      and the hint goes away.
// All data is fictional. Screenshots go to OPENSTYLE_EVIDENCE_DIR when set.
// ---------------------------------------------------------------------------

const HINT = "Add an AI model in Settings > Models to use Enhance and Summary.";
const STT_TEXT = "We agreed to ship the beta to the pilot team on Monday.";
const SEEDED_ID = "e2e-no-llm";
const SEEDED_TITLE = "Quarterly roadmap review";

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let base: string;
let sttServerId: string;
const output: string[] = [];

let stt: Server | undefined;
let sttPort = 0;
const sttSockets = new Set<Socket>();

function startStt(): Promise<void> {
  return new Promise((done) => {
    stt = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        const isStatus = req.url.startsWith("/v1/models/status");
        res.writeHead(isStatus ? 404 : 200, {
          "Content-Type": "application/json",
        });
        res.end(
          isStatus ? "{}" : JSON.stringify({ data: [{ id: "fake-stt" }] }),
        );
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: STT_TEXT }));
      });
    });
    stt.on("connection", (socket) => {
      sttSockets.add(socket);
      socket.on("close", () => sttSockets.delete(socket));
    });
    stt.listen(0, "127.0.0.1", () => {
      const address = stt?.address();
      sttPort = typeof address === "object" && address ? address.port : 0;
      done();
    });
  });
}

async function stopStt(): Promise<void> {
  if (!stt) return;
  for (const socket of sttSockets) socket.destroy();
  await new Promise<void>((done) => stt?.close(() => done()));
  stt = undefined;
}

function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function putSetting(key: string, value: string): Promise<void> {
  const res = await api("PUT", `/settings/${key}`, { value });
  expect(res.status, `PUT /api/settings/${key}`).toBe(200);
}

/** Rows of llm_runs for one meeting, read from the isolated DB. */
function runCount(meetingId: string): number {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"), {
    readOnly: true,
  });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return (
      db
        .prepare("SELECT count(*) AS n FROM llm_runs WHERE meeting_id = ?")
        .get(meetingId) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

/** An old failed Enhance run: the default LLM was gone at that time. */
function seedFailedRun(meetingId: string): void {
  const db = new DatabaseSync(join(userDataDir, "freestyle.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const at = Date.now() - 86_400_000;
    db.prepare(
      `INSERT INTO llm_runs
         (id, scope, scope_id, meeting_id, kind, started_by, status,
          graph_version, input_hash, resume_count, result_json, lost_records,
          error_kind, error_detail, started_at, updated_at, finished_at)
       VALUES (?, 'meeting', ?, ?, 'enhance', 'auto', 'failed', 1, NULL, 0,
               NULL, 0, 'model_unavailable', 'No default LLM', ?, ?, ?)`,
    ).run(`${meetingId}-old-run`, meetingId, meetingId, at, at, at);
  } finally {
    db.close();
  }
}

async function shoot(name: string): Promise<void> {
  const dir = process.env.OPENSTYLE_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  // Let the open animation of a dialog or popover end.
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(dir, `no-llm-${name}.png`) });
}

/** Two 1 s 440 Hz bursts with a 6 s gap (tests/meeting-cancel-transcribe). */
function writeTwoBurstWav(path: string): void {
  const rate = 16_000;
  const samples = new Int16Array(10 * rate);
  for (const startMs of [2000, 9000]) {
    const from = (startMs / 1000) * rate;
    for (let i = from; i < from + rate && i < samples.length; i++) {
      samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate));
    }
  }
  writeFileSync(path, pcm16Wav(samples, rate));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await startStt();
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-no-llm-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  app = await launchOpenstyle({ userDataDir });
  // The server process writes its log lines to the stdout of main.
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  }
  page = await waitForDashboardWindow(app, 15_000);
  try {
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  } catch {
    await page.waitForLoadState("load", { timeout: 10_000 });
  }
  // Main's boot orphan sweep runs 3 s after the server starts.
  await new Promise((r) => setTimeout(r, 3500));
  base = embeddedServerUrl(app);

  // A voice model on an own server. No LLM row.
  const added = await api("POST", "/servers", {
    url: `http://127.0.0.1:${sttPort}`,
  });
  expect(added.status, "POST /api/servers").toBe(201);
  const { id: serverId } = (await added.json()) as { id: string };
  sttServerId = serverId;
  const voice = await api("POST", "/models/configured", {
    provider: "server",
    model_id: `server/${serverId}/fake-stt`,
    model_name: "Fake STT",
    type: "voice",
    is_default: true,
  });
  expect(voice.ok, "POST /api/models/configured").toBe(true);
  const models = (await (
    await api("GET", "/models/configured")
  ).json()) as Array<{ type: string; is_default: number }>;
  expect(models.filter((m) => m.type === "llm")).toEqual([]);

  seedMeeting(userDataDir, SEEDED_ID, SEEDED_TITLE, [
    {
      source: "mic",
      label: null,
      text: "Let us go through the roadmap for the next quarter.",
    },
    {
      source: "system",
      label: "1",
      text: "The search page comes first, then the export feature.",
    },
  ]);
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  await stopStt();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test("the auto-Enhance prompt has no Turn on button", async () => {
  await page.reload();
  await page.waitForLoadState("load");
  await page.getByRole("link", { name: "Meetings" }).click();
  await page.waitForURL(/\/meetings/);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText("Enhance transcripts automatically?");
  await expect(page.getByTestId("enhance-prompt-not-now")).toBeVisible();
  await expect(page.getByTestId("enhance-prompt-turn-on")).toHaveCount(0);
  await shoot("1-prompt-dialog");
  await page.getByTestId("enhance-prompt-not-now").click();
  await expect(dialog).toHaveCount(0);
});

test("detail view: buttons disabled, one hint, no notice of an old failed run", async () => {
  seedFailedRun(SEEDED_ID);
  const runs = (await (
    await api("GET", `/meetings/${SEEDED_ID}/llm-runs?latest=1`)
  ).json()) as { runs: Array<{ status: string; errorKind: string | null }> };
  expect(runs.runs.map((r) => [r.status, r.errorKind])).toEqual([
    ["failed", "model_unavailable"],
  ]);

  await openMeeting(page, SEEDED_TITLE);
  const enhance = page.getByRole("button", { name: "Enhance", exact: true });
  const summarize = page.getByRole("button", {
    name: "Summarize",
    exact: true,
  });
  await expect(enhance).toBeVisible({ timeout: 10_000 });
  await expect(enhance).toBeDisabled();
  await expect(summarize).toBeDisabled();
  await expect(page.getByText(HINT, { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("meetings-run-notice-enhance")).toHaveCount(0);
  await expect(page.getByTestId("meetings-run-notice-summarize")).toHaveCount(
    0,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await shoot("2-detail");
});

test("auto-Enhance popover: switch disabled and the hint", async () => {
  await page.getByRole("button", { name: "Auto Enhance" }).first().click();
  const popover = page.locator("[data-radix-popper-content-wrapper]");
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("switch")).toBeDisabled();
  await expect(popover.getByText(HINT, { exact: true })).toBeVisible();
  await shoot("3-popover");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});

test("POST enhance and summarize answer 409 no_llm and write no run", async () => {
  const before = runCount(SEEDED_ID);
  for (const route of ["enhance", "summarize"]) {
    const res = await api("POST", `/meetings/${SEEDED_ID}/${route}`);
    const body = (await res.json()) as { code?: string; error?: string };
    console.log(`POST ${route} -> ${res.status} ${JSON.stringify(body)}`);
    expect(res.status).toBe(409);
    expect(body.code).toBe("no_llm");
  }
  // Only the seeded old run exists.
  expect(before).toBe(1);
  expect(runCount(SEEDED_ID)).toBe(1);
});

test("a transcription with auto-run on starts no run", async () => {
  test.setTimeout(120_000);
  await putSetting("meeting_enhance_auto_run", "true");
  await page.reload();
  await page.waitForLoadState("load");
  await page.getByRole("link", { name: "Meetings" }).click();
  await page.waitForURL(/\/meetings/);

  const wavPath = join(userDataDir, "Design critique.wav");
  writeTwoBurstWav(wavPath);
  await withPickerFile(
    app,
    "OPENSTYLE_E2E_MEETING_IMPORT_FILE",
    wavPath,
    async () => {
      await page.getByTestId("meetings-import-choose-file").click();
      await expect
        .poll(
          async () => {
            const list = (await (await api("GET", "/meetings")).json()) as {
              items: Array<{ title: string | null; status: string }>;
            };
            return list.items.find((m) => m.title === "Design critique")
              ?.status;
          },
          { timeout: 60_000 },
        )
        .toBe("transcribed");
    },
  );
  const list = (await (await api("GET", "/meetings")).json()) as {
    items: Array<{ id: string; title: string | null }>;
  };
  const id = list.items.find((m) => m.title === "Design critique")?.id ?? "";
  const line = `meeting ${id}: no default LLM, skipping auto Enhance`;
  await expect
    .poll(() => output.join("").includes(line), { timeout: 10_000 })
    .toBe(true);
  // Give a late run time to show up, then read the DB.
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`imported meeting ${id}: llm_runs = ${runCount(id)}`);
  console.log(`log line found: ${line}`);
  expect(runCount(id)).toBe(0);

  await openMeeting(page, "Design critique");
  await expect(page.getByText(HINT, { exact: true })).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(
    page.getByRole("button", { name: "Summarize", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await shoot("4-transcribed-detail");
});

test("control: with a default LLM the old run shows its notice", async () => {
  // The same own server; nothing calls the model in this test.
  const llm = await api("POST", "/models/configured", {
    provider: "server",
    model_id: `server/${sttServerId}/fake-stt`,
    model_name: "Fake LLM",
    type: "llm",
    is_default: true,
  });
  expect(llm.ok, "POST /api/models/configured llm").toBe(true);

  await openMeeting(page, SEEDED_TITLE);
  await expect(page.getByTestId("meetings-run-notice-enhance")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(HINT, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Enhance", exact: true }),
  ).toBeEnabled();
  await shoot("5-control-with-llm");
});
