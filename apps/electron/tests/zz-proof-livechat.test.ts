import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

// Throwaway proof of issue #375 (live transcript and chat). Never committed.
// Fictional data only. Run through the Test Runner under the GPU lock.

test.describe.configure({ mode: "serial" });

const S = "/tmp/livechat";
const SHOTS = process.env.OPENSTYLE_EVIDENCE_DIR ?? `${S}/evidence`;
const ASR = process.env.LIVE_ASR ?? "qwen3-1.7b-8bit";
const LLM = "gemma-4-e2b-qat-4bit";
const LATENCY_WAV = `${S}/audio/latency.wav`;
const LONG_WAV = `${S}/audio/long.wav`;
const DICTATION_WAV = `${S}/audio/dictation.wav`;
const USER_DATA = `${S}/ud`;
const ONLY = process.env.LIVE_ONLY ?? "";

const SENTENCES = JSON.parse(
  readFileSync(`${S}/audio/latency.json`, "utf8"),
) as { sentences: string[]; speechEndMs: number[] };
// One last word (or alternates) for each sentence. A line that holds it
// means the whole sentence is on screen.
const LAST_WORDS: string[][] = [
  ["kickoff"],
  ["14th", "fourteenth"],
  ["afternoon"],
  ["friday"],
  ["build"],
  ["week"],
  ["month"],
  ["morning"],
  ["launch"],
  ["today"],
  ["pages"],
  ["call"],
];

let app: ElectronApplication;
let page: Page;
let base: string;
let folderId = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status >= 300) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function put(key: string, value: string) {
  return api(`/api/settings/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

function db(): DatabaseSync {
  const d = new DatabaseSync(join(USER_DATA, "freestyle.db"));
  d.exec("PRAGMA busy_timeout = 5000");
  return d;
}

function readDb<T>(sql: string, ...params: (string | number)[]): T[] {
  const d = new DatabaseSync(join(USER_DATA, "freestyle.db"), {
    readOnly: true,
  });
  try {
    return d.prepare(sql).all(...params) as T[];
  } finally {
    d.close();
  }
}

async function shot(name: string, theme: "light" | "dark") {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
  }, theme);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
}

async function bothThemes(name: string) {
  await shot(name, "light");
  await shot(name, "dark");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

function note(line: string) {
  console.log(`PROOF ${line}`);
  mkdirSync(SHOTS, { recursive: true });
  appendFileSync(join(SHOTS, "proof.log"), `${line}\n`);
}

async function setAudio(path: string) {
  await app.evaluate((_e, p) => {
    process.env.OPENSTYLE_E2E_FAKE_MEETING_AUDIO = p;
  }, path);
}

async function openFolder() {
  await page.goto("app://renderer/meetings");
  const rail = page.getByRole("complementary", {
    name: "Meetings and folders",
  });
  await rail
    .getByRole("button", { name: "Larkspur", exact: true })
    .first()
    .click();
}

async function startRecording(): Promise<{
  id: string;
  micT0: number;
  startClickAt: number;
}> {
  await openFolder();
  const startClickAt = Date.now();
  await page.getByRole("button", { name: "Start recording" }).first().click();
  await expect
    .poll(
      async () =>
        page.evaluate(async () => (await window.api.getMeetingStatus()).status),
      { timeout: 20_000 },
    )
    .toBe("recording");
  const id = await page.evaluate(
    async () => (await window.api.getMeetingStatus()).meetingId as string,
  );
  const dir = readDb<{ audio_dir: string }>(
    "SELECT audio_dir FROM meetings WHERE id = ?",
    id,
  )[0].audio_dir;
  let micT0: number | null = null;
  for (let i = 0; i < 100 && micT0 === null; i++) {
    try {
      micT0 = JSON.parse(readFileSync(join(dir, "sync.json"), "utf8")).micT0;
    } catch {
      // not written yet
    }
    if (micT0 === null) await sleep(100);
  }
  if (micT0 === null) throw new Error("no micT0");
  return { id, micT0, startClickAt };
}

async function stopRecording(id: string) {
  await page.getByRole("button", { name: "Stop", exact: true }).first().click();
  await expect
    .poll(
      async () =>
        page.evaluate(async () => (await window.api.getMeetingStatus()).status),
      { timeout: 30_000 },
    )
    .toBe("idle");
  return id;
}

interface Snap {
  t: number;
  status: string;
  lines: { source: string; startMs: number; text: string; final: boolean }[];
  skippedTicks: number;
}

async function liveSnap(id: string): Promise<Snap> {
  const j = await api<Omit<Snap, "t">>(`/api/meetings/${id}/live`);
  return { t: Date.now(), ...j };
}

/** Poll GET /live until `stop` says so. Returns all snapshots. */
function startPoller(id: string, snaps: Snap[]) {
  let on = true;
  const done = (async () => {
    while (on) {
      try {
        snaps.push(await liveSnap(id));
      } catch {
        // ignore
      }
      await sleep(250);
    }
  })();
  return async () => {
    on = false;
    await done;
  };
}

function firstSeen(
  snaps: Snap[],
  words: string[],
  finalOnly: boolean,
): number | null {
  for (const s of snaps) {
    for (const l of s.lines) {
      if (finalOnly && !l.final) continue;
      const n = norm(l.text);
      if (words.some((w) => n.includes(w))) return s.t;
    }
  }
  return null;
}

function pct(arr: number[], p: number) {
  const a = [...arr].sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
}

async function chat(
  id: string,
  question: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
) {
  const t0 = Date.now();
  const res = await fetch(`${base}/api/meetings/${id}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });
  const body = (await res.json()) as {
    answer?: string;
    cites?: { label: string; kind: string; title?: string }[];
    ms?: number;
    cold?: boolean;
    error?: string;
    reason?: string;
  };
  return { status: res.status, body, totalMs: Date.now() - t0 };
}

async function waitTranscribed(id: string, timeoutMs = 6 * 60_000) {
  await expect
    .poll(
      () =>
        readDb<{ status: string }>(
          "SELECT status FROM meetings WHERE id = ?",
          id,
        )[0]?.status,
      { timeout: timeoutMs, intervals: [2000] },
    )
    .toMatch(/transcribed|failed/);
}

function serverLog(): string {
  const p = join(USER_DATA, "logs", "openstyle-server.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

test.beforeAll(async () => {
  rmSync(USER_DATA, { recursive: true, force: true });
  mkdirSync(USER_DATA, { recursive: true });
  writeFileSync(
    join(USER_DATA, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(USER_DATA, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  app = await launchOpenstyle({
    userDataDir: USER_DATA,
    timeout: 90_000,
    env: {
      OPENSTYLE_E2E_FAKE_MEETING_CAPTURE: "1",
      OPENSTYLE_E2E_FAKE_MEETING_AUDIO: LATENCY_WAV,
    },
  });
  page = await waitForDashboardWindow(app, 30_000);
  base = embeddedServerUrl(app);
  await page.setViewportSize({ width: 1180, height: 820 });
  for (const [k, v] of [
    ["meeting_enhance_prompt_seen", "true"],
    ["advanced_mode", "true"],
    ["mlx_llm_keep_alive_minutes", "-1"],
    ["meeting_diarization_enabled", "false"],
  ]) {
    await put(k, v);
  }
  await api("/api/models/configured", {
    method: "POST",
    body: JSON.stringify({
      provider: "local-mlx",
      model_id: `local-mlx/${ASR}`,
      model_name: ASR,
      type: "voice",
      is_default: true,
    }),
  });
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
  const f = await api<{ id: string }>("/api/meetings/folders", {
    method: "POST",
    body: JSON.stringify({ name: "Larkspur" }),
  });
  folderId = f.id;
  const d = db();
  d.prepare("UPDATE meeting_folders SET description = ? WHERE id = ?").run(
    "Project Larkspur: the beta launch of the mobile app. Dana leads the project.",
    folderId,
  );
  const now = Date.now();
  const seeds = [
    {
      id: "larkspur-budget-review",
      title: "Larkspur budget review",
      daysAgo: 3,
      lines: [
        ["Me", "Dana, where are we on the budget for Larkspur?"],
        ["Them", "The budget for Larkspur is 12 thousand dollars in total."],
        ["Me", "Good. Then we keep the plan as it is."],
      ],
      summary:
        "## Decisions\n- The budget for Larkspur is 12 thousand dollars in total.\n- The plan stays as it is.\n",
    },
    {
      id: "larkspur-kickoff-notes",
      title: "Larkspur kickoff notes",
      daysAgo: 9,
      lines: [
        ["Me", "Let us list the goals for Larkspur."],
        ["Them", "We want a small beta with fifty testers."],
      ],
      summary:
        "## Goals\n- A small beta of Larkspur with fifty testers.\n- Dana owns the plan.\n",
    },
  ];
  for (const m of seeds) {
    const at = now - m.daysAgo * 86_400_000;
    d.prepare(
      `INSERT INTO meetings (id, title, status, started_at, created_at, duration_ms, folder_id, language)
       VALUES (?, ?, 'transcribed', ?, ?, 60000, ?, 'en')`,
    ).run(m.id, m.title, at, at, folderId);
    m.lines.forEach(([who, text], j) => {
      d.prepare(
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
    d.prepare(
      "INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES (?, ?, ?)",
    ).run(m.id, m.summary, at);
  }
  d.close();
});

test.afterAll(async () => {
  if (app) await closeApp(app);
});

test("00 search index of the past meetings", async () => {
  test.skip(!!ONLY && ONLY !== "all" && !/00/.test(ONLY), "filtered");
  test.setTimeout(30 * 60_000);
  await page.goto("app://renderer/settings/models");
  const section = page.getByTestId("search-model-section");
  await expect(section).toBeVisible({ timeout: 30_000 });
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
    .toBe(2);
  const st = await api<unknown>("/api/search/status");
  note(`index ready: ${JSON.stringify(st)}`);
});

test("A flag off: no panel, no live loop", async () => {
  test.setTimeout(3 * 60_000);
  const flag = await api<{ value?: string }>("/api/settings/live_chat_enabled");
  note(`flag before: ${JSON.stringify(flag)}`);
  const rec = await startRecording();
  await sleep(8000);
  await expect(page.getByTestId("meeting-recording-elapsed")).toBeVisible();
  expect(await page.getByTestId("live-transcript").count()).toBe(0);
  expect(await page.getByTestId("live-chat").count()).toBe(0);
  const live = await api<{ status: string; lines: unknown[] }>(
    `/api/meetings/${rec.id}/live`,
  );
  expect(live.status).toBe("off");
  expect(serverLog()).not.toContain("Live loop started");
  const chatRes = await chat(rec.id, "anything?");
  note(
    `A chat with flag off -> ${chatRes.status} ${JSON.stringify(chatRes.body)}`,
  );
  expect(chatRes.status).toBe(409);
  await bothThemes("A-flag-off-recording");
  note(
    `A flag off: live=${JSON.stringify(live)}, "Live loop started" in log: ${serverLog().includes("Live loop started")}`,
  );
  await stopRecording(rec.id);
  await waitTranscribed(rec.id);
});

test("A2 the Settings toggle turns the flag on", async () => {
  await page.goto("app://renderer/settings#meetings");
  const sw = page.locator("#settings-live-chat");
  await expect(sw).toBeVisible({ timeout: 20_000 });
  await sw.scrollIntoViewIfNeeded();
  await bothThemes("A2-settings-toggle-off");
  await sw.click();
  await expect
    .poll(
      async () =>
        (await api<{ value?: string }>("/api/settings/live_chat_enabled"))
          .value,
      { timeout: 10_000 },
    )
    .toBe("true");
  await bothThemes("A2-settings-toggle-on");
  note("A2 toggle on: GET /api/settings/live_chat_enabled = true");
});

test("B1 latency over 12 fictional sentences", async () => {
  test.skip(ONLY !== "" && ONLY !== "all" && !/B1/.test(ONLY), "filtered");
  test.setTimeout(10 * 60_000);
  await setAudio(LATENCY_WAV);
  const rec = await startRecording();
  const snaps: Snap[] = [];
  const stopPoll = startPoller(rec.id, snaps);
  const t0 = rec.micT0;

  // Screenshots: the first moment with a partial line, and later a final line.
  let shotPartial = false;
  let shotFinal = false;
  const end = t0 + 95_000;
  while (Date.now() < end) {
    const last = snaps[snaps.length - 1];
    if (last && !shotPartial && last.lines.some((l) => !l.final)) {
      await expect(page.getByTestId("live-partial").first()).toBeVisible({
        timeout: 5000,
      });
      await bothThemes("B1-live-partial");
      shotPartial = true;
    }
    if (
      last &&
      !shotFinal &&
      last.lines.filter((l) => l.final).length >= 3 &&
      last.lines.some((l) => !l.final)
    ) {
      await expect(page.getByTestId("live-line").first()).toBeVisible({
        timeout: 5000,
      });
      await bothThemes("B1-live-final-and-partial");
      shotFinal = true;
    }
    await sleep(500);
  }

  // Dictation during live (proof 6): three requests in a row while the loop runs.
  const wav = readFileSync(DICTATION_WAV);
  const before = (await liveSnap(rec.id)).skippedTicks;
  const dict: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const res = await fetch(`${base}/api/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "x-skip-post-process": "true",
      },
      body: wav,
    });
    const j = (await res.json()) as { text?: string; raw?: string };
    dict.push(
      `${res.status} ${Date.now() - t}ms ${JSON.stringify(j).slice(0, 120)}`,
    );
    await sleep(500);
  }
  await sleep(2500);
  const after = (await liveSnap(rec.id)).skippedTicks;
  note(`B1 dictation x3 during live: ${dict.join(" | ")}`);
  note(`B1 skippedTicks before=${before} after=${after}`);

  await stopPoll();
  const finals = snaps[snaps.length - 1].lines.filter((l) => l.final);
  const partialLat: number[] = [];
  const finalLat: number[] = [];
  const rows: string[] = [];
  SENTENCES.speechEndMs.forEach((endMs, i) => {
    const endAt = t0 + endMs;
    const p = firstSeen(snaps, LAST_WORDS[i], false);
    const f = firstSeen(snaps, LAST_WORDS[i], true);
    const pl = p === null ? null : p - endAt;
    const fl = f === null ? null : f - endAt;
    if (pl !== null) partialLat.push(pl);
    if (fl !== null) finalLat.push(fl);
    rows.push(
      `s${i + 1} end=${(endMs / 1000).toFixed(1)}s partial=${pl}ms final=${fl}ms "${SENTENCES.sentences[i]}"`,
    );
  });
  note(`B1 ASR model ${ASR}, ${snaps.length} polls`);
  for (const r of rows) note(`B1 ${r}`);
  note(
    `B1 partial latency n=${partialLat.length} p50=${pct(partialLat, 50)}ms p95=${pct(partialLat, 95)}ms | final latency n=${finalLat.length} p50=${pct(finalLat, 50)}ms p95=${pct(finalLat, 95)}ms`,
  );
  // Duplicate check on the last snapshot (proof 5).
  const keys = finals.map((l) => `${l.source}:${l.startMs}`);
  note(
    `B1 final lines at the end: ${finals.length}, unique starts: ${new Set(keys).size}`,
  );
  writeFileSync(
    join(SHOTS, "B1-final-lines.json"),
    JSON.stringify(finals, null, 1),
  );
  expect(new Set(keys).size).toBe(keys.length);

  await stopRecording(rec.id);
  const afterStop = await api<{ status: string }>(
    `/api/meetings/${rec.id}/live`,
  );
  note(`B1 after stop: GET /live -> ${JSON.stringify(afterStop)}`);
  expect(afterStop.status).toBe("off");
  await waitTranscribed(rec.id);
  const segs = readDb<{ n: number }>(
    "SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id = ?",
    rec.id,
  )[0].n;
  const texts = readDb<{ text: string }>(
    "SELECT text FROM meeting_segments WHERE meeting_id = ? ORDER BY start_ms",
    rec.id,
  );
  note(
    `B1 final pass wrote ${segs} meeting_segments; first: ${JSON.stringify(texts.slice(0, 3))}`,
  );
  expect(segs).toBeGreaterThan(0);
  expect(finalLat.length).toBeGreaterThanOrEqual(10);
});

test("B2 chat: live tail, past meeting, not found", async () => {
  test.skip(ONLY !== "" && ONLY !== "all" && !/B2/.test(ONLY), "filtered");
  test.setTimeout(15 * 60_000);
  await setAudio(LATENCY_WAV);
  const rec = await startRecording();
  const snaps: Snap[] = [];
  const stopPoll = startPoller(rec.id, snaps);
  // Wait until the 14th is a final live line.
  await expect
    .poll(
      async () => {
        const s = snaps[snaps.length - 1];
        return (
          s?.lines.some((l) => l.final && /14th|fourteenth/i.test(l.text)) ??
          false
        );
      },
      { timeout: 90_000, intervals: [500] },
    )
    .toBe(true);

  // UI chat 1, light theme, cold model: warming and answer with chips.
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page
    .getByTestId("live-chat-input")
    .fill("What did Dana say about the beta date?");
  await page.getByTestId("live-chat-send").click();
  await expect(page.getByTestId("live-chat-warming")).toBeVisible({
    timeout: 20_000,
  });
  await shot("B2-chat-warming", "light");
  await expect(page.getByTestId("live-chat-assistant")).toBeVisible({
    timeout: 4 * 60_000,
  });
  const ans1 = await page.getByTestId("live-chat-assistant").innerText();
  note(`B2 UI chat 1 answer: ${ans1.replace(/\n/g, " | ")}`);
  await bothThemes("B2-chat-answer-live-chips");

  // API: live tail question. Total time as the person sees it.
  const live = await chat(rec.id, "What did Dana say about the beta date?");
  note(
    `B2 live tail chat: status=${live.status} totalMs=${live.totalMs} serverMs=${live.body.ms} cold=${live.body.cold} answer=${JSON.stringify(live.body.answer)} cites=${JSON.stringify(live.body.cites)}`,
  );
  expect(live.status).toBe(200);
  expect(live.body.answer ?? "").toMatch(/14th|fourteenth/i);
  expect(live.body.cites?.some((c) => c.kind === "live")).toBe(true);

  // Dark theme: stop the chat model so the next chat is cold again.
  await api("/api/mlx-llm/server/stop", { method: "POST", body: "{}" }).catch(
    (e) => note(`llm stop: ${String(e)}`),
  );
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page
    .getByTestId("live-chat-input")
    .fill("What is the Larkspur budget?");
  await page.getByTestId("live-chat-send").click();
  await expect(page.getByTestId("live-chat-warming")).toBeVisible({
    timeout: 20_000,
  });
  await shot("B2-chat-warming", "dark");
  await expect(page.getByTestId("live-chat-assistant")).toHaveCount(2, {
    timeout: 4 * 60_000,
  });
  const ans2 = await page.getByTestId("live-chat-assistant").last().innerText();
  note(`B2 UI chat 2 answer: ${ans2.replace(/\n/g, " | ")}`);
  await shot("B2-chat-answer-past-chips", "dark");
  await shot("B2-chat-answer-past-chips", "light");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  // API: past meeting.
  const past = await chat(rec.id, "What is the Larkspur budget?");
  note(
    `B2 past chat: status=${past.status} totalMs=${past.totalMs} serverMs=${past.body.ms} answer=${JSON.stringify(past.body.answer)} cites=${JSON.stringify(past.body.cites)}`,
  );
  expect(past.status).toBe(200);
  expect(past.body.answer ?? "").toMatch(
    /12 thousand|12,000|12000|twelve thousand/i,
  );
  expect(past.body.cites?.some((c) => c.kind === "past")).toBe(true);

  // API: not found.
  const nf = await chat(
    rec.id,
    "What color is the carpet in the Berlin office?",
  );
  note(
    `B2 not-found chat: status=${nf.status} totalMs=${nf.totalMs} answer=${JSON.stringify(nf.body.answer)} cites=${JSON.stringify(nf.body.cites)}`,
  );
  expect(nf.status).toBe(200);
  expect(nf.body.answer ?? "").toMatch(/not found/i);
  expect(nf.body.cites ?? []).toHaveLength(0);

  await stopPoll();
  await stopRecording(rec.id);
  await waitTranscribed(rec.id);
});

test("C unavailable states (non-local models)", async () => {
  test.skip(ONLY !== "" && ONLY !== "all" && !/C/.test(ONLY), "filtered");
  test.setTimeout(5 * 60_000);
  await api("/api/models/configured", {
    method: "POST",
    body: JSON.stringify({
      provider: "local-whisper",
      model_id: "local-whisper/base-q5_1",
      model_name: "base-q5_1",
      type: "voice",
      is_default: true,
    }),
  });
  await api("/api/models/configured", {
    method: "POST",
    body: JSON.stringify({
      provider: "openai",
      model_id: "openai/gpt-4o-mini",
      model_name: "gpt-4o-mini",
      type: "llm",
      is_default: true,
    }),
  });
  const rec = await startRecording();
  await expect(page.getByTestId("live-unavailable")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("live-chat-input").fill("hello?");
  await page.getByTestId("live-chat-send").click();
  await expect(page.getByTestId("live-chat-unavailable")).toBeVisible({
    timeout: 20_000,
  });
  await bothThemes("C-unavailable");
  note(`C live: ${JSON.stringify(await liveSnap(rec.id))}`);
  await stopRecording(rec.id);
  // Restore the local models.
  await api("/api/models/configured", {
    method: "POST",
    body: JSON.stringify({
      provider: "local-mlx",
      model_id: `local-mlx/${ASR}`,
      model_name: ASR,
      type: "voice",
      is_default: true,
    }),
  });
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
});

test("D ten minute memory run", async () => {
  test.skip(!/D/.test(ONLY), "only with LIVE_ONLY=D");
  test.setTimeout(30 * 60_000);
  await setAudio(LONG_WAV);
  const rec = await startRecording();
  const appPid = app.process().pid as number;
  const csv = join(SHOTS, "D-rss.csv");
  writeFileSync(csv, "t_s,main_mb,workers_mb,renderer_mb,total_mb,detail\n");
  const snaps: Snap[] = [];
  const stopPoll = startPoller(rec.id, snaps);
  const t0 = Date.now();
  let chatDone = false;
  const sample = () => {
    const out = execSync("ps -axo pid=,ppid=,rss=,command=", {
      encoding: "utf8",
    });
    let main = 0;
    let workers = 0;
    let renderer = 0;
    const detail: string[] = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const [, pid, ppid, rss, cmd] = m;
      const mb = Number(rss) / 1024;
      if (Number(pid) === appPid) main += mb;
      else if (Number(ppid) === appPid) {
        if (/mlx_asr_worker/.test(cmd)) {
          workers += mb;
          detail.push(`worker:${pid}:${Math.round(mb)}`);
        } else renderer += mb;
      }
    }
    // Workers may be grandchildren (a wrapper). Add any mlx worker whose
    // parent is a child of the app.
    const kids = new Set<number>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+/);
      if (m && Number(m[2]) === appPid) kids.add(Number(m[1]));
    }
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      if (kids.has(Number(m[2])) && /mlx_asr_worker/.test(m[4])) {
        workers += Number(m[3]) / 1024;
        detail.push(`gworker:${m[1]}:${Math.round(Number(m[3]) / 1024)}`);
      }
    }
    appendFileSync(
      csv,
      `${Math.round((Date.now() - t0) / 1000)},${Math.round(main)},${Math.round(workers)},${Math.round(renderer)},${Math.round(main + workers + renderer)},${detail.join(" ")}\n`,
    );
  };
  while (Date.now() < t0 + 10 * 60_000 + 5000) {
    sample();
    if (!chatDone && Date.now() > t0 + 120_000) {
      chatDone = true;
      void chat(rec.id, "What did Dana say about the beta date?").then((r) =>
        note(
          `D chat at 2 min: ${r.status} ${r.totalMs}ms ${JSON.stringify(r.body.answer)}`,
        ),
      );
    }
    await sleep(5000);
  }
  await stopPoll();
  const finals = snaps[snaps.length - 1].lines.filter((l) => l.final);
  note(`D polls=${snaps.length} final lines at the end=${finals.length}`);
  await stopRecording(rec.id);
  sample();
  await waitTranscribed(rec.id, 20 * 60_000);
  sample();
  note("D done");
});

export type _Unused = Page;
