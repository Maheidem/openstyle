import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import {
  closeApp,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./helpers/e2e-app";

// ---------------------------------------------------------------------------
// model-picker-groups: runtime evidence for the grouped model pickers
// (specs/model-picker-groups.md section 11.2 E). Every step drives the real
// renderer, writes a numbered PNG into EVIDENCE_DIR and adds a record to
// `manifest.json` there. A step that is not observed is a FAIL.
//
// ISOLATION: the packaged /Applications/Openstyle.app can own port 4649. This
// suite never binds that port. It uses an isolated standalone server (its own,
// or the one named by OPENSTYLE_E2E_SERVER_URL and OPENSTYLE_E2E_SERVER_TOKEN)
// and points the app at it with `serverUrl` and `serverToken` in settings.json.
// The manifest records every renderer request to :4649.
//
// Own-server data: when the isolated server has no own server yet, the suite
// adds a loopback fake with the six oMLX models of specs section 4.1. With
// OPENSTYLE_E2E_SERVER_URL the suite uses the servers that already exist, for
// example a migrated copy of a real database that points at a real oMLX.
//
// Run:
//   OPENSTYLE_EVIDENCE_DIR=/abs/dir \
//     pnpm --filter @openstyle/electron test:e2e tests/model-picker-groups.test.ts
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

const EVIDENCE_DIR =
  process.env.OPENSTYLE_EVIDENCE_DIR ??
  join(tmpdir(), "openstyle-model-picker-groups-evidence");

interface StepRecord {
  step: string;
  assertion: string;
  result: "PASS" | "FAIL";
  detail: string;
}
interface ShotRecord {
  file: string;
  step: string;
  expected: string;
}
interface ServerRow {
  id: string;
  name: string;
  base_url: string;
  reachable: boolean;
  models: { id: string; kind: string }[];
}

let app: ElectronApplication | undefined;
let page: Page;
const records: StepRecord[] = [];
const shots: ShotRecord[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

let userDataDir = "";
let serverUrl = "";
let serverToken = "";
let serverProcess: ChildProcess | undefined;
let fakeModelServer: Server | undefined;
let ownServer: ServerRow;

const SPEECH_MODEL = "Qwen3-ASR";
const TTS_MODEL = "Qwen3-TTS";
const CHAT_MODEL = "Qwen3.8-27B";
const OTHER_MODELS = [
  "Qwen3-Embedding",
  "Qwen3-Reranker",
  TTS_MODEL,
  "MarkItDown",
];
const CLOUD_MODEL_NAME = "GPT-4o mini";

// The six models of specs section 4.1: `/v1/models` ids are the aliases and
// `/v1/models/status` has the type.
const FAKE_MODELS = [
  ["Qwen3-ASR", "Qwen3-ASR-1.7B-8bit", "audio_stt"],
  ["Qwen3-Embedding", "Qwen3-Embedding-8B-MLX-oQ4", "embedding"],
  ["Qwen3.8-27B", "Qwen3.8-27B-AWQ-5.0bpw", "vlm"],
  ["Qwen3-Reranker", "Qwen3-Reranker-0.6B-mlx-8Bit", "reranker"],
  ["Qwen3-TTS", "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", "audio_tts"],
  ["MarkItDown", "MarkItDown", "markitdown"],
] as const;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${serverToken}`,
    "Content-Type": "application/json",
  };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${serverUrl}/api${path}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function listServers(): Promise<ServerRow[]> {
  const res = await api("GET", "/servers");
  expect(res.status).toBe(200);
  return (await res.json()) as ServerRow[];
}

async function setDefault(
  type: "voice" | "llm",
  modelId: string,
  name: string,
): Promise<void> {
  const res = await api("POST", "/models/configured", {
    provider: "server",
    model_id: `server/${ownServer.id}/${modelId}`,
    model_name: name,
    type,
    is_default: true,
  });
  expect(res.status).toBe(201);
}

function check(
  step: string,
  assertion: string,
  ok: boolean,
  detail: string,
): void {
  records.push({ step, assertion, result: ok ? "PASS" : "FAIL", detail });
  console.log(`[${step}] ${ok ? "PASS" : "FAIL"}: ${assertion} :: ${detail}`);
}

async function shot(
  id: string,
  slug: string,
  step: string,
  expected: string,
): Promise<void> {
  const file = `S${id}-${slug}.png`;
  // Let the dialog animation finish, so the PNG shows the settled screen.
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(EVIDENCE_DIR, file) });
  shots.push({ file, step, expected });
}

function dialog(): Locator {
  return page.getByRole("dialog");
}

async function dialogText(): Promise<string> {
  return await dialog().innerText();
}

async function openModels(): Promise<void> {
  await page.getByRole("link", { name: "Models" }).first().click();
  await page.waitForURL(/\/settings\/models/, { timeout: 20_000 });
  await expect(page.getByText("Transcription · required")).toBeVisible({
    timeout: 30_000,
  });
}

async function reloadModels(): Promise<void> {
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("Transcription · required")).toBeVisible({
    timeout: 30_000,
  });
}

async function closeDialog(): Promise<void> {
  if ((await dialog().count()) === 0) return;
  await dialog().getByRole("button", { name: "Close" }).first().click();
  await expect(dialog()).toHaveCount(0);
}

async function openVoicePicker(): Promise<void> {
  await page
    .getByRole("button", { name: "Change voice transcription model" })
    .click();
  await expect(dialog()).toBeVisible();
}

async function openLlmPicker(): Promise<void> {
  await page
    .getByRole("button", { name: "Change", exact: true })
    .first()
    .click();
  await expect(dialog()).toBeVisible();
}

async function pickerRows(): Promise<string[]> {
  return await dialog()
    .getByRole("button", { name: /^Browse the models/ })
    .evaluateAll((els) =>
      els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()),
    );
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-picker-groups-e2e-"));

  if (process.env.OPENSTYLE_E2E_SERVER_URL) {
    serverUrl = process.env.OPENSTYLE_E2E_SERVER_URL;
    serverToken = process.env.OPENSTYLE_E2E_SERVER_TOKEN ?? "";
  } else {
    const port = await freePort();
    serverToken = `e2e-${randomUUID()}`;
    serverUrl = `http://127.0.0.1:${port}`;
    const dbPath = join(userDataDir, "freestyle.db");
    const logPath = join(EVIDENCE_DIR, "server.log");
    await new Promise<void>((res, rej) => {
      const child = spawn(
        process.execPath,
        [resolve(__dirname, "../../server/dist/startup.js")],
        {
          cwd: resolve(__dirname, ".."),
          env: {
            ...process.env,
            HOST: "127.0.0.1",
            PORT: String(port),
            OPENSTYLE_DB_PATH: dbPath,
            FREESTYLE_DB_PATH: dbPath,
            OPENSTYLE_AUTH_TOKEN: serverToken,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      serverProcess = child;
      const onData = (buf: Buffer) => {
        const s = buf.toString();
        appendFileSync(logPath, s);
        if (/server running on/.test(s)) res();
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", (code) =>
        rej(new Error(`isolated server exited early (code ${code})`)),
      );
      setTimeout(
        () => rej(new Error("isolated server did not start within 30s")),
        30_000,
      );
    });
  }

  // Own server: use the existing one, or add the loopback fake.
  let servers = await listServers();
  if (servers.length === 0) {
    fakeModelServer = createHttpServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.startsWith("/v1/models/status")) {
        res.end(
          JSON.stringify({
            models: FAKE_MODELS.map(([alias, id, type]) => ({
              id,
              model_alias: alias,
              model_type: type,
              is_hidden: false,
            })),
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({ data: FAKE_MODELS.map(([alias]) => ({ id: alias })) }),
      );
    });
    const fakePort = await new Promise<number>((res) => {
      fakeModelServer?.listen(0, "127.0.0.1", () => {
        const address = fakeModelServer?.address();
        res(typeof address === "object" && address ? address.port : 0);
      });
    });
    const added = await api("POST", "/servers", {
      url: `http://127.0.0.1:${fakePort}`,
    });
    expect(added.status).toBe(201);
    servers = await listServers();
  }
  expect(servers).toHaveLength(1);
  ownServer = servers[0];

  // Seed: the chat default, a cloud chat model for the per-task override
  // select, advanced mode (it shows that section) and a finished onboarding.
  await setDefault("llm", CHAT_MODEL, CHAT_MODEL);
  await setDefault("voice", SPEECH_MODEL, SPEECH_MODEL);
  const cloud = await api("POST", "/models/configured", {
    provider: "openai",
    model_id: "openai/gpt-4o-mini",
    model_name: CLOUD_MODEL_NAME,
    type: "llm",
    is_default: false,
  });
  expect(cloud.status).toBe(201);
  const advanced = await api("PUT", "/settings/advanced_mode", {
    value: "true",
  });
  expect(advanced.status).toBe(200);

  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true, serverUrl, serverToken }),
  );

  app = await launchOpenstyle({ userDataDir, timeout: 60_000 });
  page = await waitForDashboardWindow(app, 25_000);
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  try {
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
  } catch {
    await page.waitForLoadState("load", { timeout: 10_000 });
  }
});

test.afterAll(async () => {
  let port4649: string[] = [];
  try {
    port4649 = await page.evaluate(() =>
      (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .map((e) => e.name)
        .filter((n) => n.includes(":4649")),
    );
  } catch {
    port4649 = ["<evaluate failed>"];
  }
  writeFileSync(
    join(EVIDENCE_DIR, "manifest.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        serverUrl,
        ownServer,
        rendererRequestsToPort4649: port4649,
        shots,
        records,
        failures: records.filter((r) => r.result === "FAIL").length,
        consoleErrors,
        pageErrors,
      },
      null,
      2,
    ),
  );
  if (app) await closeApp(app);
  serverProcess?.kill();
  fakeModelServer?.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

test("00 the app talks to the isolated server", async () => {
  const resolvedUrl = await page.evaluate(() =>
    (
      window as unknown as { api: { getServerUrl(): string } }
    ).api.getServerUrl(),
  );
  expect(resolvedUrl).toBe(serverUrl);
  check("00", "app resolved the isolated server URL", true, serverUrl);
  await openModels();
});

test("01 transcription picker shows three rows", async () => {
  await openVoicePicker();
  const rows = await pickerRows();
  const titles = ["Built into Openstyle", "Your own server", "Cloud provider"];
  check(
    "01",
    "three rows, in order",
    rows.length === 3 && titles.every((t, i) => rows[i].startsWith(t)),
    JSON.stringify(rows),
  );
  expect(rows).toHaveLength(3);
  titles.forEach((t, i) => {
    expect(rows[i].startsWith(t)).toBe(true);
  });
  check(
    "01",
    "no brand name in a row title",
    !rows.some((r) => /oMLX|Whisper|OpenAI/.test(r.split("·")[0])),
    "titles use group names",
  );
  await shot(
    "01",
    "transcription-picker",
    "Transcription picker",
    "Three rows: Built into Openstyle, Your own server (active, with the selected model as hint), Cloud provider.",
  );
});

test("02 own-server screen: one server, only the speech model", async () => {
  await dialog()
    .getByRole("button", { name: /Browse the models of your own/ })
    .click();
  const text = await dialogText();
  check(
    "02",
    "one server row with its address",
    text.includes(ownServer.name) && text.includes(ownServer.base_url),
    `${ownServer.name} ${ownServer.base_url}`,
  );
  expect(text).toContain(ownServer.name);
  expect(text).toContain(SPEECH_MODEL);
  const others = [CHAT_MODEL, ...OTHER_MODELS].filter((n) => text.includes(n));
  check(
    "02",
    "only Qwen3-ASR is listed",
    others.length === 0,
    others.length ? `also listed: ${others.join(", ")}` : "5 models hidden",
  );
  expect(others).toEqual([]);
  await expect(
    dialog().getByRole("button", { name: /Show all models \(5 more\)/ }),
  ).toBeVisible();
  await shot(
    "02",
    "own-server-speech-only",
    "Own-server screen, transcription",
    "Servers part with one server row, then one model row Qwen3-ASR (selected) and the button Show all models (5 more).",
  );
});

test("03 show all models reveals the other five with kind badges", async () => {
  // A taller window shows all six rows in one PNG.
  await app?.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes("app://renderer"))
      ?.setContentSize(1152, 1000);
  });
  await dialog()
    .getByRole("button", { name: /Show all models/ })
    .click();
  const text = await dialogText();
  const names = [SPEECH_MODEL, CHAT_MODEL, ...OTHER_MODELS];
  const missing = names.filter((n) => !text.includes(n));
  check(
    "03",
    "all six models listed",
    missing.length === 0,
    `missing: ${missing.join(", ") || "none"}`,
  );
  expect(missing).toEqual([]);
  const badges = ["Chat", "Embedding", "Reranker", "Text to speech", "Other"];
  const noBadge = badges.filter((b) => !text.includes(b));
  check(
    "03",
    "kind badges for the five non-speech models",
    noBadge.length === 0,
    `missing badges: ${noBadge.join(", ") || "none"}`,
  );
  expect(noBadge).toEqual([]);
  await shot(
    "03",
    "show-all-models",
    "Show all models",
    "Six model rows. Qwen3-ASR has no badge. The other five show Chat, Embedding, Reranker, Text to speech and Other.",
  );
});

test("04 LLM picker shows two rows and the chat model", async () => {
  await closeDialog();
  await openLlmPicker();
  const rows = await pickerRows();
  check(
    "04",
    "two rows: Your own server and Cloud provider, no built-in row",
    rows.length === 2 &&
      rows[0].startsWith("Your own server") &&
      rows[1].startsWith("Cloud provider"),
    JSON.stringify(rows),
  );
  expect(rows).toHaveLength(2);
  await shot(
    "04",
    "llm-picker",
    "LLM picker",
    "Two rows only: Your own server (active, hint Qwen3.8-27B) and Cloud provider.",
  );
  await dialog()
    .getByRole("button", { name: /Browse the models of your own/ })
    .click();
  const text = await dialogText();
  const hidden = [SPEECH_MODEL, ...OTHER_MODELS].filter((n) =>
    text.includes(n),
  );
  check(
    "04",
    "own-server list shows Qwen3.8-27B and hides the non-chat models",
    text.includes(CHAT_MODEL) && hidden.length === 0,
    hidden.length ? `also listed: ${hidden.join(", ")}` : "chat model only",
  );
  expect(text).toContain(CHAT_MODEL);
  expect(hidden).toEqual([]);
  await shot(
    "04",
    "llm-own-server",
    "Own-server screen, LLM role",
    "One server row and one model row Qwen3.8-27B (selected). Show all models (5 more).",
  );
});

test("05 cloud screen has no URL field", async () => {
  await dialog().getByRole("button", { name: "Back to simple view" }).click();
  await dialog()
    .getByRole("button", { name: /Browse the models of cloud/ })
    .click();
  const inputs = await dialog().locator("input").count();
  const text = await dialogText();
  check(
    "05",
    "the only input is the search box",
    inputs === 1 && !/OpenAI-compatible|Base URL|http:\/\//i.test(text),
    `inputs=${inputs}`,
  );
  expect(inputs).toBe(1);
  expect(text).toContain("Cloud providers");
  await shot(
    "05",
    "cloud-screen",
    "Cloud providers screen",
    "Title Cloud providers, a search box and model rows. No address or URL field.",
  );
  await closeDialog();
});

test("06 a selected text-to-speech model shows the warning", async () => {
  await setDefault("voice", TTS_MODEL, TTS_MODEL);
  await reloadModels();
  const warning = "This model cannot transcribe. Pick a speech-to-text model.";
  await expect(page.getByText(warning).first()).toBeVisible({
    timeout: 20_000,
  });
  check(
    "06",
    "Models page pair card shows the cannot-transcribe line",
    true,
    warning,
  );
  await shot(
    "06",
    "tts-warning-pair-card",
    "Pair card with Qwen3-TTS selected",
    "Transcription card shows Qwen3-TTS, the via line with the server name and the red warning line.",
  );
  await openVoicePicker();
  await dialog()
    .getByRole("button", { name: /Browse the models of your own/ })
    .click();
  const text = await dialogText();
  check(
    "06",
    "the selected model stays listed and carries the warning",
    text.includes(TTS_MODEL) && text.includes(warning),
    "Qwen3-TTS row with warning",
  );
  expect(text).toContain(TTS_MODEL);
  expect(text).toContain(warning);
  await shot(
    "06",
    "tts-warning-list",
    "Own-server list with Qwen3-TTS selected",
    "Qwen3-ASR and the selected Qwen3-TTS (kind badge, warning line) are listed.",
  );
  await closeDialog();

  // One-time dashboard notice (spec 6.3, open question 4).
  await page.getByRole("link", { name: "Transcriptions" }).first().click();
  await expect(
    page.getByText("Your transcription model cannot transcribe"),
  ).toBeVisible({ timeout: 20_000 });
  check("06", "Today page shows the one-time notice", true, "notice visible");
  await shot(
    "06",
    "tts-notice-today",
    "Today page notice",
    "Yellow notice: Your transcription model cannot transcribe, with Open Models and Dismiss.",
  );
  await openModels();
});

test("07 adding a server with a bad address shows the error", async () => {
  const before = (await listServers()).length;
  await openVoicePicker();
  await dialog()
    .getByRole("button", { name: /Browse the models of your own/ })
    .click();
  await dialog().getByRole("button", { name: "Add server" }).click();
  await dialog().getByLabel("Address").fill("http://127.0.0.1:9");
  await dialog().getByRole("button", { name: "Connect" }).click();
  const unreachable = "Not reachable. Check that the server is running.";
  await expect(dialog().getByText(unreachable).first()).toBeVisible({
    timeout: 20_000,
  });
  const after = (await listServers()).length;
  check(
    "07",
    "unreachable address shows the error and saves nothing",
    after === before,
    `servers before=${before} after=${after}`,
  );
  expect(after).toBe(before);
  await shot(
    "07",
    "add-server-error",
    "Add server with a bad address",
    "Add form open with the red text: Not reachable. Check that the server is running. The server list is unchanged.",
  );

  await dialog().getByLabel("Address").fill(ownServer.base_url);
  await dialog().getByRole("button", { name: "Connect" }).click();
  await expect(
    dialog().getByText("This server is already in your list."),
  ).toBeVisible({ timeout: 20_000 });
  check(
    "07",
    "the address of a listed server shows the duplicate error",
    true,
    ownServer.base_url,
  );
  await shot(
    "07",
    "add-server-duplicate",
    "Add server with a duplicate address",
    "Add form with the red text: This server is already in your list.",
  );
  await closeDialog();
});

test("08 per-task override select shows the two groups", async () => {
  await setDefault("voice", SPEECH_MODEL, SPEECH_MODEL);
  await reloadModels();
  const section = page
    .locator("section")
    .filter({ hasText: "Where your models work" });
  await section
    .locator("button")
    .filter({ hasText: "Fast rewrites while you dictate" })
    .first()
    .click();
  const trigger = section.getByRole("combobox").last();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  const text = await list.innerText();
  const ok =
    text.includes("Your own server") &&
    text.includes("Cloud provider") &&
    text.includes(CHAT_MODEL) &&
    text.includes(CLOUD_MODEL_NAME) &&
    text.indexOf("Your own server") < text.indexOf("Cloud provider");
  check(
    "08",
    "two group labels with their models",
    ok,
    text.replace(/\s+/g, " "),
  );
  expect(ok).toBe(true);
  await shot(
    "08",
    "task-override-groups",
    "Per-task override select",
    "Open list: Use default model, group Your own server (Qwen3.8-27B with the server name), group Cloud provider (GPT-4o mini via OpenAI).",
  );
  await page.keyboard.press("Escape");
});
