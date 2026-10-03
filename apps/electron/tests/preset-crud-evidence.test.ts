import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
// preset-crud-evidence — RUNTIME VISUAL EVIDENCE for preset management on
// the Models page (specs/llm-task-profiles.md §4 / §5 / §9.3 / §11).
//
// Why this file exists: `task-profiles-section.tsx`'s `PresetActionRow`
// (Edit params · Rename · Duplicate · Delete + Built-in/Yours badge) had
// never been seen rendered. A typecheck is not evidence. Every step below
// drives the real UI, writes a numbered PNG into EVIDENCE_DIR, and appends a
// structured record to `manifest.json` there. Anything not observed is
// recorded FAIL — never quietly asserted true.
//
// ISOLATION (load-bearing — the developer's real profile and the packaged
// /Applications/Openstyle.app are LIVE on this machine, and that app owns
// port 4649):
//   * This suite never binds 4649 and never reuses it. It starts its OWN
//     standalone server (`apps/server/dist/startup.js`, HOST=127.0.0.1,
//     PORT=<ephemeral>, explicit bearer token) against a throwaway userData +
//     DB under the OS temp dir, then points the app at it through the
//     documented `serverUrl`/`serverToken` profile escape hatch (the same
//     isolation `import-screen`/`meeting-import` spell
//     `OPENSTYLE_E2E_SERVER_URL`).
//   * The app's boot probe WILL find the foreign server on 4649 and set
//     `serverPort = 4649` (`src/main/index.ts:2821`) — which is exactly why
//     `serverUrl` is seeded: `getServerBaseUrl()` (`src/main/index.ts:361`)
//     and the renderer's `getApiBase()` (`src/renderer/src/lib/api.ts:26`)
//     both prefer a configured URL. Test 00 asserts the app resolved to OUR
//     server, and the manifest records whether any renderer request ever
//     touched :4649.
//   * The server runs with `cwd = apps/electron` per the AGENTS.md gotcha so
//     bundled ffmpeg / diarize candidate lists resolve (unused here, obeyed).
//
// Run:
//   OPENSTYLE_EVIDENCE_DIR=/abs/dir \
//     pnpm --filter @openstyle/electron test:e2e tests/preset-crud-evidence.test.ts
// (never `--` before the path — it silently drops the filter.)
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

const EVIDENCE_DIR =
  process.env.OPENSTYLE_EVIDENCE_DIR ??
  join(tmpdir(), "openstyle-preset-crud-evidence");

/** A free TCP port, asked of the OS rather than guessed. */
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

interface HttpRow {
  method: string;
  path: string;
  status: number;
  where: "renderer" | "harness";
}
interface AssertionRow {
  step: string;
  assertion: string;
  result: "PASS" | "FAIL";
  detail: string;
}
interface ShotRow {
  id: string;
  file: string;
  step: string;
  expected: string;
  result: "PASS" | "FAIL";
}

let app: ElectronApplication | undefined;
let page: Page;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const defectConsoleErrors: string[] = [];
const requestFailures: string[] = [];
const httpLog: HttpRow[] = [];
const shots: ShotRow[] = [];
const assertions: AssertionRow[] = [];
/** Requests we deliberately provoke while documenting a defect — kept out of
 *  the clean-session assertion so the defect is reported, not hidden. */
const defectRequestFailures: string[] = [];
let swallowingRequestFailures = false;
const blobs: Record<
  string,
  { step: string; key: string; value: string | null }
> = {};

let userDataDir = "";
let serverUrl = "";
let serverToken = "";
let server: ChildProcess | undefined;
let serverLogPath = "";

// Seeded state. Ids are genuine `user_<uuid>` so the "never print a raw
// uuid" assertion has something real to catch.
const P1 = {
  id: `user_${randomUUID()}`,
  name: "Careful cleanup",
  params: {
    temperature: 0.3,
    max_tokens: 512,
    top_p: 0.9,
    presence_penalty: 0.1,
    chat_template_kwargs: { enable_thinking: true },
  },
};
const P2 = {
  id: `user_${randomUUID()}`,
  name: "Punchy remix",
  params: { temperature: 0.7, max_tokens: 1024, top_p: 0.95 },
};
const RENAMED = "Careful cleanup v2";
const GHOST_ID = `user_${randomUUID()}`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${serverToken}` };
}

async function apiPut(key: string, value: string): Promise<number> {
  const res = await fetch(`${serverUrl}/api/settings/${key}`, {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  httpLog.push({
    method: "PUT",
    path: `/api/settings/${key}`,
    status: res.status,
    where: "harness",
  });
  return res.status;
}

async function apiGet(key: string): Promise<string | null> {
  const res = await fetch(`${serverUrl}/api/settings/${key}`, {
    headers: headers(),
  });
  httpLog.push({
    method: "GET",
    path: `/api/settings/${key}`,
    status: res.status,
    where: "harness",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${key} -> ${res.status}`);
  return ((await res.json()) as { value: string }).value;
}

type Assignments = Record<
  string,
  {
    mode?: string;
    presetId?: string;
    modelOverride?: { provider: string; model_id: string };
  }
>;
type PresetBlob = {
  presets: { id: string; name: string; params: Record<string, unknown> }[];
};

function parseAssignments(v: string | null): Assignments {
  return v ? (JSON.parse(v) as Assignments) : {};
}
function parsePresets(v: string | null): PresetBlob {
  return v ? (JSON.parse(v) as PresetBlob) : { presets: [] };
}
function presetNames(v: string | null): string[] {
  return parsePresets(v).presets.map((p) => p.name);
}

/** Read both blobs back and stash them in the manifest under `step`. */
async function snapshot(
  step: string,
): Promise<{ presets: string | null; assignments: string | null }> {
  const presets = await apiGet("llm_parameter_presets");
  const assignments = await apiGet("llm_task_assignments");
  blobs[`${step}:llm_parameter_presets`] = {
    step,
    key: "llm_parameter_presets",
    value: presets,
  };
  blobs[`${step}:llm_task_assignments`] = {
    step,
    key: "llm_task_assignments",
    value: assignments,
  };
  return { presets, assignments };
}

function record(
  step: string,
  assertion: string,
  ok: boolean,
  detail: string,
): void {
  assertions.push({ step, assertion, result: ok ? "PASS" : "FAIL", detail });
  console.log(`[${step}] ${ok ? "PASS" : "FAIL"} — ${assertion} :: ${detail}`);
}

/**
 * The expanded task panel. `task-profiles-section.tsx` renders it as
 * `div.border-border.bg-muted\/20...` directly under the row header button;
 * scoping here is what keeps "Auto"/"Delete" from matching the collapsed rows
 * (a collapsed row with mode auto also renders the literal word "Auto") and
 * from matching the Models page's other Delete buttons.
 */
function panel(): Locator {
  return section().locator('div[class*="bg-muted"]').first();
}
function section(): Locator {
  return page.locator("section").filter({ hasText: "Where your models work" });
}

async function capture(
  id: string,
  slug: string,
  step: string,
  expected: string,
  target: Page | Locator,
): Promise<void> {
  const file = `S${id}-${slug}.png`;
  const path = join(EVIDENCE_DIR, file);
  let result: "PASS" | "FAIL" = "PASS";
  try {
    // element screenshots need the element in view
    if (target !== page) await (target as Locator).scrollIntoViewIfNeeded();
    await (target as Page).screenshot({ path });
  } catch (err) {
    result = "FAIL";
    console.log(`[shot S${id}] capture FAILED: ${String(err).slice(0, 200)}`);
  }
  shots.push({ id, file, step, expected, result });
}

function waitForSettingsPut(key: string, timeout = 20_000) {
  return page.waitForResponse(
    (r) =>
      r.url().includes(`/api/settings/${key}`) &&
      r.request().method() === "PUT",
    { timeout },
  );
}

/** Deterministic wait on the persisted blob rather than a blind sleep. */
async function blobWait(
  key: string,
  check: (v: string | null) => boolean,
  timeout = 20_000,
): Promise<string | null> {
  const deadline = Date.now() + timeout;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await apiGet(key);
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
}

async function bodyText(): Promise<string> {
  return (await page.locator("body").innerText()) ?? "";
}

async function assertNoRawUuid(step: string, ids: string[]): Promise<void> {
  const text = await bodyText();
  const uuidHits = text.match(/user_[0-9a-f]{8}/gi) ?? [];
  const leaked = [
    ...new Set([...uuidHits, ...ids.filter((i) => i && text.includes(i))]),
  ];
  record(
    step,
    "rendered DOM text contains no raw user_<uuid>",
    leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(", ")}` : "body innerText clean",
  );
}

async function clickTrack(label: string): Promise<void> {
  // Radix ToggleGroup items are role=radio; re-clicking the active one fires
  // "" which `SegmentedControl` swallows — so no PUT would ever arrive.
  const item = panel().getByRole("radio", { name: label, exact: true }).first();
  if ((await item.getAttribute("data-state")) === "on") return;
  const p = waitForSettingsPut("llm_task_assignments");
  await item.click();
  expect(
    (await p).status(),
    `selecting '${label}' PUT /api/settings/llm_task_assignments`,
  ).toBe(200);
  await expect(panel().getByText(label, { exact: true }).first()).toBeVisible();
}

/**
 * The Delete button in the action row. NOTE: its accessible name is NOT
 * "Delete" — `PresetActionRow` sets `aria-label`
 * = `deletePresetAria` ("Delete preset {name}"), which overrides the visible
 * text for AT. Matching `exact: "Delete"` therefore misses it (found the hard
 * way, see the run log); regex on the visible stem is the honest selector.
 */
function deleteBtn(): Locator {
  return panel().getByRole("button", { name: /Delete/ });
}

/**
 * Every option label currently rendered in the Params segmented track, read
 * off the Radix items (`data-slot="toggle-group-item"`, `role="radio"`) —
 * not off `innerText`, so a label that leaks twice cannot hide a missing one.
 * This is the ledger the stale-option bug is measured against: the track's
 * options ARE the renderer's `userPresets` state, so the label list is a
 * direct read of that array.
 */
async function trackLabels(): Promise<string[]> {
  const items = panel().locator('[data-slot="toggle-group-item"]');
  return (await items.allInnerTexts()).map((s) => s.trim()).filter(Boolean);
}

/** `aria-checked` of one track option, for "is Auto actually selected". */
async function trackChecked(label: string): Promise<boolean | null> {
  const item = panel().getByRole("radio", { name: label, exact: true }).first();
  if ((await item.count()) === 0) return null;
  return (await item.getAttribute("aria-checked")) === "true";
}

/** Resize the real dashboard BrowserWindow (the default 1152x648 keeps the
 *  Params track in its 2-column `wrap` grid; the single-row flex variant only
 *  exists at >=1360px viewport). */
async function resizeDashboard(width: number, height: number): Promise<void> {
  await app?.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows().find(
        (x) =>
          x.getURL().includes("app://renderer") &&
          !x.getURL().includes("pill") &&
          !x.getURL().includes("bar.html"),
      );
      win?.setContentSize(w, h);
    },
    [width, height],
  );
}

/** Idempotent: the row header button TOGGLES, so clicking an already-open
 *  row would collapse it. */
async function expandCleanup(): Promise<void> {
  if ((await panel().getByText("Params", { exact: true }).count()) > 0) return;
  await section()
    .locator("button")
    .filter({ hasText: "Fast rewrites while you dictate" })
    .first()
    .click();
  await expect(panel().getByText("Params", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-preset-crud-e2e-"));
  const dbPath = join(userDataDir, "freestyle.db");
  serverLogPath = join(EVIDENCE_DIR, "server.log");

  // 1. isolated standalone server — ephemeral port, explicit bearer token so
  //    the trusted-origin fallback stays OFF and every call is authenticated.
  const port = await freePort();
  serverToken = `e2e-${randomUUID()}`;
  serverUrl = `http://127.0.0.1:${port}`;

  await new Promise<void>((res, rej) => {
    const child = spawn(
      process.execPath,
      [resolve(__dirname, "../../server/dist/startup.js")],
      {
        cwd: resolve(__dirname, ".."), // apps/electron (AGENTS.md resource gotcha)
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
    server = child;
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      appendFileSync(serverLogPath, s);
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

  // 2. seed BEFORE first render: advanced mode, two presets, one pinned task
  expect(await apiPut("advanced_mode", "true")).toBe(200);
  expect(
    await apiPut(
      "llm_parameter_presets",
      JSON.stringify({
        presets: [P1, P2].map((p) => ({
          ...p,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      }),
    ),
  ).toBe(200);
  expect(
    await apiPut(
      "llm_task_assignments",
      JSON.stringify({
        cleanup: { mode: "preset", presetId: P1.id },
        remix: { mode: "preset", presetId: P2.id },
      }),
    ),
  ).toBe(200);

  // A default LLM + a second one, so the Model override selector has real
  // options for the §6.3 "modelOverride survives the fork" proof.
  for (const [model_id, model_name, is_default] of [
    ["qwen3.8-flash", "Local Qwen Flash", true],
    ["qwen3.8-27b", "Local Qwen 27B", false],
  ] as const) {
    const r = await fetch(`${serverUrl}/api/models/configured`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "local-llm",
        model_id,
        model_name,
        type: "llm",
        is_default,
      }),
    });
    httpLog.push({
      method: "POST",
      path: "/api/models/configured",
      status: r.status,
      where: "harness",
    });
    expect(r.status, `seed model ${model_id}`).toBe(201);
  }

  // 3. main-process profile: skip onboarding, point at the isolated server.
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true, serverUrl, serverToken }),
  );

  // 4. launch the real app against out/main/index.js
  app = await launchOpenstyle({ userDataDir, timeout: 60_000 });
  page = await waitForDashboardWindow(app, 25_000);

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const line = `${msg.text()} @ ${msg.location()?.url ?? "?"}`;
    (swallowingRequestFailures ? defectConsoleErrors : consoleErrors).push(
      line,
    );
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("requestfailed", (req) => {
    const line = `${req.method()} ${req.url()} :: ${req.failure()?.errorText ?? "failed"}`;
    (swallowingRequestFailures ? defectRequestFailures : requestFailures).push(
      line,
    );
  });
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/")) return;
    httpLog.push({
      method: r.request().method(),
      path: u.pathname,
      status: r.status(),
      where: "renderer",
    });
  });

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

  const isolation: Record<string, unknown> = {
    foreignAppOn4649:
      "/Applications/Openstyle.app (PID alive — untouched, never killed)",
    strategy:
      "own standalone apps/server/dist/startup.js on an OS-assigned ephemeral loopback port with an explicit bearer token; app pointed at it via settings.json serverUrl/serverToken so getServerBaseUrl()/getApiBase() never fall back to 4649",
    rendererRequestsToPort4649: port4649,
    isolated: port4649.length === 0,
  };

  const manifest = {
    capturedAt: new Date().toISOString(),
    appVersion: (() => {
      try {
        return (
          JSON.parse(
            readFileSync(resolve(__dirname, "../package.json"), "utf-8"),
          ) as { version: string }
        ).version;
      } catch {
        return "unknown";
      }
    })(),
    evidenceDir: EVIDENCE_DIR,
    userDataDir,
    serverUrl,
    isolation,
    seeded: {
      presets: [P1, P2],
      assignments: {
        cleanup: { mode: "preset", presetId: P1.id },
        remix: { mode: "preset", presetId: P2.id },
      },
      configuredModels: [
        { provider: "local-llm", model_id: "qwen3.8-flash", is_default: true },
        { provider: "local-llm", model_id: "qwen3.8-27b", is_default: false },
      ],
    },
    blobs,
    shots,
    assertions,
    httpLog,
    consoleErrors,
    defectConsoleErrors,
    pageErrors,
    requestFailures,
    defectRequestFailures,
    visionReview: {
      status: "pending",
      note: "filled in by vision-review.mjs after capture",
    },
    knownGaps: ["placeholder — replaced by the handoff"],
  };

  writeFileSync(
    join(EVIDENCE_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  if (app) await closeApp(app);
  server?.kill("SIGTERM");
});

// ---------------------------------------------------------------------------
// 00 — isolation + navigation
// ---------------------------------------------------------------------------

test("00 app resolves to the ISOLATED server and reaches the Models page", async () => {
  // NOTE: `evaluate` structured-clones the result, so the bridge object
  // itself cannot cross the boundary — call it inside the page instead.
  const resolvedUrl = await page.evaluate(() =>
    (
      window as unknown as { api: { getServerUrl(): string } }
    ).api.getServerUrl(),
  );
  const resolvedToken = await page.evaluate(() =>
    (
      window as unknown as { api: { getServerToken(): string } }
    ).api.getServerToken(),
  );
  expect(resolvedUrl).toBe(serverUrl);
  expect(resolvedToken).toBe(serverToken);

  await page.getByRole("link", { name: "Models" }).first().click();
  await page.waitForURL(/\/settings\/models/, { timeout: 20_000 });
  await expect(
    page.getByText("Where your models work", { exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
  record(
    "00",
    "app talks to the throwaway isolated server (not the packaged app on :4649)",
    true,
    `serverUrl=${serverUrl}, userData=${userDataDir}`,
  );
});

// ---------------------------------------------------------------------------
// 01 — collapsed baseline
// ---------------------------------------------------------------------------

test("01 collapsed section, advanced mode ON — preset Badge visible in the row", async () => {
  const sec = section();
  await expect(sec).toBeVisible();
  const cleanupChip = sec.getByText("Careful cleanup", { exact: true }).first();
  const remixChip = sec.getByText("Punchy remix", { exact: true }).first();
  await expect(cleanupChip).toBeVisible({ timeout: 20_000 });
  await expect(remixChip).toBeVisible();

  const rows = await sec
    .getByText(
      /Fast rewrites while you dictate|Quick edits and the canvas agent|Long-form summaries after a meeting ends|Cleans up transcript text after a meeting/,
    )
    .count();
  record(
    "01",
    "all four task rows render (cleanup/remix/meetingSummarize/meetingEnhance)",
    rows === 4,
    `desc rows found=${rows}`,
  );
  record(
    "01",
    "collapsed Cleanup row shows the seeded preset name as a Badge",
    (await cleanupChip.innerText()) === "Careful cleanup",
    `chip="${await cleanupChip.innerText()}"`,
  );
  record(
    "01",
    "no task panel expanded at baseline (no Params label)",
    (await sec.getByText("Params", { exact: true }).count()) === 0,
    "Params label count=0",
  );

  await capture(
    "01",
    "collapsed-baseline",
    "Collapsed section, advanced mode ON",
    "Models page with the 'Where your models work' section collapsed: four rows; Cleanup shows a 'Careful cleanup' badge, Remix a 'Punchy remix' badge, the meeting rows show plain 'Auto'. No action row.",
    page,
  );

  await assertNoRawUuid("01", [P1.id, P2.id]);
});

// ---------------------------------------------------------------------------
// 02 — THE MONEY SHOT
// ---------------------------------------------------------------------------

test("02 cleanup row EXPANDED: Params track + full PresetActionRow + Yours badge", async () => {
  await expandCleanup();
  const p = panel();

  for (const label of [
    "Auto",
    "Careful cleanup",
    "Punchy remix",
    "Qwen thinking",
    "Qwen fast",
    "Custom…",
    "+ New preset",
  ]) {
    const ok = (await p.getByText(label, { exact: true }).count()) > 0;
    record(
      "02",
      `Params track renders option '${label}'`,
      ok,
      ok ? "present" : "MISSING from track",
    );
  }

  const seen: string[] = [];
  for (const l of ["Edit params", "Rename", "Duplicate", "Delete"]) {
    // `Delete` is only reachable via the regex — see `deleteBtn()`.
    const b = p
      .getByRole("button", { name: new RegExp(`^${l}( preset .*)?$`) })
      .first();
    seen.push(
      `${l}=${(await b.count()) > 0 && (await b.isVisible()) ? "present" : "MISSING"}`,
    );
  }
  record(
    "02",
    "PresetActionRow renders Edit params · Rename · Duplicate · Delete",
    seen.every((s) => s.endsWith("present")),
    seen.join(", "),
  );
  record(
    "02",
    "action row shows the 'Yours' badge for a user_* preset",
    (await p.getByText("Yours", { exact: true }).count()) > 0,
    "Yours badge present",
  );
  record(
    "02",
    "exactly one Delete button in the panel, rendered OUTSIDE the ToggleGroup track",
    (await deleteBtn().count()) === 1,
    `count=${await deleteBtn().count()}`,
  );

  await capture(
    "02",
    "expanded-user-actionrow",
    "Cleanup row expanded — MONEY SHOT",
    "Params segmented track with 'Careful cleanup' selected (dark pill); directly beneath it the PresetActionRow: 'Yours' badge, the preset name, and the four text buttons Edit params · Rename · Duplicate · Delete.",
    p,
  );

  writeFileSync(
    join(EVIDENCE_DIR, "dom-dump-expanded-cleanup.html"),
    await p.innerHTML(),
  );
  await assertNoRawUuid("02", [P1.id]);

  // The track is `grid grid-cols-2` until the viewport hits 1360px, then it
  // becomes a single-row flex. Capture both, since the shipped default window
  // (1152x648) only ever shows the grid form.
  const track = p.locator('div[class*="bg-secondary"]').first();
  record(
    "02",
    "at the default 1152px window the Params track renders as the 2-column wrap grid",
    (await track.evaluate((e) => getComputedStyle(e).display)) === "grid",
    `display=${await track.evaluate((e) => getComputedStyle(e).display)}; gridTemplateColumns=${await track.evaluate((e) => getComputedStyle(e).gridTemplateColumns)}`,
  );

  await resizeDashboard(1440, 900);
  await expect
    .poll(async () => track.evaluate((e) => getComputedStyle(e).display), {
      timeout: 15_000,
    })
    .toBe("flex");
  await capture(
    "02b",
    "track-single-row-1440",
    "Same row at a 1440px viewport",
    "The Params track's single-row flex variant at >=1360px: Auto · Qwen thinking · Qwen fast · Careful cleanup (selected) · Punchy remix · Custom… · + New preset on one line, with the action row beneath. Rest of the suite runs at this width.",
    section(),
  );
});

// ---------------------------------------------------------------------------
// 03 — builtin selected
// ---------------------------------------------------------------------------

test("03 builtin selected: primary button reads 'Duplicate to edit', there is NO Delete", async () => {
  await clickTrack("Qwen fast");
  const p = panel();

  const dup = p
    .getByRole("button", { name: "Duplicate to edit", exact: true })
    .first();
  await expect(dup).toBeVisible({ timeout: 10_000 });
  const del = await deleteBtn().count();
  const edit = await p
    .getByRole("button", { name: "Edit params", exact: true })
    .count();
  record(
    "03",
    "builtin row primary button reads 'Duplicate to edit'",
    await dup.isVisible(),
    "visible",
  );
  record(
    "03",
    "builtin row has NO Delete button of any label",
    del === 0,
    `Delete* count=${del}`,
  );
  record(
    "03",
    "builtin row does NOT use the plain 'Edit params' label",
    edit === 0,
    `Edit params count=${edit}`,
  );
  record(
    "03",
    "builtin row shows the 'Built-in' badge",
    (await p.getByText("Built-in", { exact: true }).count()) > 0,
    "Built-in badge present",
  );
  record(
    "03",
    "fork warning caption visible under the builtin action row",
    (await p.getByText(/saves a copy you own/).count()) > 0,
    "builtinAutoCopyNote rendered",
  );

  await capture(
    "03",
    "builtin-no-delete",
    "Cleanup row with builtin 'Qwen fast' selected",
    "'Qwen fast' selected in the track; action row badge reads 'Built-in'; buttons are 'Duplicate to edit' · Rename · Duplicate and there is deliberately NO Delete; fork warning caption beneath.",
    p,
  );

  await assertNoRawUuid("03", ["builtin:qwen-fast"]);
});

// ---------------------------------------------------------------------------
// 04 + 05 — edit params on the user's own preset
// ---------------------------------------------------------------------------

test("04 Edit params opens the inline JSON editor prefilled with real params", async () => {
  await clickTrack("Careful cleanup");
  const p = panel();
  await p
    .getByRole("button", { name: "Edit params", exact: true })
    .first()
    .click();

  const ta = p.locator("textarea").first();
  await expect(ta).toBeVisible({ timeout: 10_000 });
  const prefill = await ta.inputValue();
  record(
    "04",
    "inline JSON editor prefilled with the preset's real params",
    prefill.includes('"temperature": 0.3') &&
      prefill.includes("chat_template_kwargs"),
    `prefill starts: ${prefill.slice(0, 70).replace(/\n/g, "\\n")}`,
  );
  record(
    "04",
    "user_* edit exposes NO Name field (Rename is its own action)",
    (await p.locator("input[type='text'], input:not([type])").count()) === 0,
    `text inputs in panel=${await p.locator("input[type='text'], input:not([type])").count()}`,
  );
  record(
    "04",
    "Save button labelled plain 'Save' for a user preset",
    (await p.getByRole("button", { name: "Save", exact: true }).count()) > 0,
    "Save present",
  );

  await capture(
    "04",
    "edit-params-open",
    "Edit params — inline JSON editor open",
    "Inline raw-JSON editor under the action row prefilled with temperature 0.3 / max_tokens 512 / top_p 0.9 / chat_template_kwargs, plus Cancel + Save. No Name field (this preset is already owned).",
    p,
  );
});

test("05 saving an edited value persists — blob read back over the API", async () => {
  const p = panel();
  const ta = p.locator("textarea").first();
  const before = await ta.inputValue();
  await ta.fill(before.replace("0.3", "0.55"));

  const res = waitForSettingsPut("llm_parameter_presets");
  await p.getByRole("button", { name: "Save", exact: true }).first().click();
  expect((await res).status()).toBe(200);
  await expect(p.locator("textarea")).toHaveCount(0, { timeout: 15_000 });

  const blob = await blobWait(
    "llm_parameter_presets",
    (v) => !!v && v.includes("0.55"),
  );
  const { assignments } = await snapshot("05-after-edit-save");
  const edited = parsePresets(blob).presets.find((x) => x.id === P1.id);
  record(
    "05",
    "PUT /api/settings/llm_parameter_presets -> 200 and stored params hold temperature 0.55",
    !!edited && edited.params.temperature === 0.55,
    `stored temperature=${JSON.stringify(edited?.params?.temperature)}`,
  );
  record(
    "05",
    "cleanup still pinned to the same user_* preset after the edit",
    parseAssignments(assignments).cleanup?.presetId === P1.id,
    JSON.stringify(parseAssignments(assignments).cleanup),
  );
  record(
    "05",
    "editor closed itself on success (no stuck guard)",
    (await p.locator("textarea").count()) === 0,
    "textarea gone",
  );

  await capture(
    "05",
    "edit-params-saved",
    "After saving the edited params",
    "Editor closed; Cleanup row still selected on 'Careful cleanup' with the Yours badge and the four action buttons. Persisted params live in manifest.blobs['05-after-edit-save'].",
    p,
  );

  await assertNoRawUuid("05", [P1.id]);
});

// ---------------------------------------------------------------------------
// 06 — rename
// ---------------------------------------------------------------------------

test("06 Rename: inline input prefilled; save renames in the UI AND in the blob", async () => {
  const p = panel();
  await p.getByRole("button", { name: "Rename", exact: true }).first().click();
  const input = p.getByRole("textbox", { name: "Name" }).first();
  await expect(input).toBeVisible({ timeout: 10_000 });
  const prefill = await input.inputValue();
  record(
    "06",
    "rename input opens prefilled with the current name",
    prefill === "Careful cleanup",
    `value="${prefill}"`,
  );

  await capture(
    "06a",
    "rename-inline",
    "Rename — inline input with the current name",
    "Inline rename input holding 'Careful cleanup' (maxLength 60) with Cancel + Save, inside the expanded Cleanup row. No dialog — a string this short does not get one.",
    p,
  );

  await input.fill(RENAMED);
  const res = waitForSettingsPut("llm_parameter_presets");
  await p.getByRole("button", { name: "Save", exact: true }).first().click();
  expect((await res).status()).toBe(200);

  const blob = await blobWait(
    "llm_parameter_presets",
    (v) => !!v && v.includes(RENAMED),
  );
  await snapshot("06-after-rename");
  await expect(panel().getByText(RENAMED, { exact: true }).first()).toBeVisible(
    { timeout: 15_000 },
  );
  record(
    "06",
    "new name present in the persisted blob",
    !!blob && blob.includes(RENAMED),
    `names now: ${presetNames(blob).join(" | ")}`,
  );
  record(
    "06",
    "new name rendered in the Params track and the row badge",
    (await panel().getByText(RENAMED, { exact: true }).count()) >= 2,
    `${await panel().getByText(RENAMED, { exact: true }).count()} occurrences in panel`,
  );

  await capture(
    "06b",
    "renamed-saved",
    "After renaming",
    "Track option and row badge now read 'Careful cleanup v2'; the old name is gone from the track. Blob in manifest.blobs['06-after-rename'].",
    panel(),
  );
});

// ---------------------------------------------------------------------------
// 07 — duplicate
// ---------------------------------------------------------------------------

test("07 Duplicate creates a '… copy' preset in the picker AND in the blob", async () => {
  const p = panel();
  const before = parsePresets(await apiGet("llm_parameter_presets")).presets
    .length;

  const res = waitForSettingsPut("llm_parameter_presets");
  await p
    .getByRole("button", { name: "Duplicate", exact: true })
    .first()
    .click();
  expect((await res).status()).toBe(200);

  const blob = await blobWait(
    "llm_parameter_presets",
    (v) => !!v && v.includes(`${RENAMED} copy`),
  );
  const after = parsePresets(blob);
  const copy = after.presets.find((x) => x.name === `${RENAMED} copy`);
  record(
    "07",
    "duplicate appended a NEW user_* preset named '<name> copy'",
    !!copy &&
      copy.id.startsWith("user_") &&
      after.presets.length === before + 1,
    `count ${before} -> ${after.presets.length}; copy id ${copy?.id.slice(0, 10)}…`,
  );

  const opt = panel().getByText(`${RENAMED} copy`, { exact: true }).first();
  const optVisible = (await opt.count()) > 0;
  record(
    "07",
    "the copy appears as an option in the Params track",
    optVisible,
    optVisible ? "rendered" : "MISSING from track",
  );
  if (optVisible) await clickTrack(`${RENAMED} copy`);

  await snapshot("07-after-duplicate");
  await capture(
    "07",
    "duplicated-copy",
    "Duplicate — the new '… copy' preset",
    "Params track now lists 'Careful cleanup v2 copy' (selected) alongside Auto / Qwen thinking / Qwen fast / Punchy remix / Custom… / + New preset; action row shows Yours + Edit params · Rename · Duplicate · Delete.",
    panel(),
  );

  await assertNoRawUuid("07", [P1.id, P2.id, copy?.id ?? ""]);
});

// ---------------------------------------------------------------------------
// 08 + 09 — delete -> ConfirmDialog -> Auto
// ---------------------------------------------------------------------------

test("08 Delete opens the ConfirmDialog naming the affected task(s)", async () => {
  await clickTrack(RENAMED);

  // BEFORE shot (panel). Taken BEFORE the Delete click on purpose:
  // `ConfirmDialog` is modal and Radix `aria-hidden`s everything outside it,
  // so a `role=radio` query against the track finds nothing while it is
  // open. `trackLabels()` is a direct read of the renderer's `userPresets`
  // array — the before-half of the stale-option re-verification (S09/S09b
  // are the after-halves).
  const before = await trackLabels();
  const beforeChecked = await trackChecked(RENAMED);
  record(
    "08",
    "BEFORE delete: 'Careful cleanup v2' is a selected option in the track",
    before.includes(RENAMED) && beforeChecked === true,
    `labels=[${before.join(" · ")}]`,
  );
  await capture(
    "08b",
    "track-before-delete",
    "BEFORE deleting — option present + selected",
    "Params track immediately BEFORE the delete: 'Careful cleanup v2' is present and selected (dark pill), action row beneath it with Delete. Before-half of the stale-option re-verification.",
    panel(),
  );

  await deleteBtn().first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const title = await dialog
    .getByText("Delete preset?", { exact: true })
    .first()
    .innerText();
  const msg = (await dialog.innerText()).replace(/\s+/g, " ");

  record(
    "08",
    "confirm dialog titled 'Delete preset?' opens",
    title === "Delete preset?",
    `title="${title}"`,
  );
  record(
    "08",
    "dialog NAMES the affected task and says those tasks go back to Auto",
    msg.includes(RENAMED) && /Cleanup/i.test(msg) && /Auto/i.test(msg),
    `dialog: ${msg.slice(0, 220)}`,
  );

  await capture(
    "08",
    "delete-confirmdialog",
    "Delete → ConfirmDialog",
    "Modal 'Delete preset?' naming 'Careful cleanup v2', stating it is used by Cleanup and deleting switches that task back to Auto; Cancel + destructive Delete buttons.",
    page,
  );
});

test("09 confirming deletes it everywhere and the task falls back to Auto", async () => {
  const aRes = waitForSettingsPut("llm_task_assignments");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  expect((await aRes).status()).toBe(200);

  const presets = await blobWait(
    "llm_parameter_presets",
    (v) => !parsePresets(v).presets.some((x) => x.id === P1.id),
  );
  const assignments = await blobWait(
    "llm_task_assignments",
    (v) => parseAssignments(v).cleanup?.mode === "auto",
  );
  await snapshot("09-after-delete");

  record(
    "09",
    "deleted preset gone from the persisted blob",
    !parsePresets(presets).presets.some((x) => x.id === P1.id),
    `names now: ${presetNames(presets).join(" | ")}`,
  );
  record(
    "09",
    "cleanup assignment rewritten to {mode:'auto'} with no stale presetId",
    parseAssignments(assignments).cleanup?.mode === "auto" &&
      !parseAssignments(assignments).cleanup?.presetId,
    JSON.stringify(parseAssignments(assignments).cleanup),
  );

  // THE assertion pair this whole capture exists for. Strings are kept
  // byte-identical to the 2026-09-26 run that found the defect so the ledger
  // maps 1:1 across the before/after manifests.
  //
  // Mechanism (confirmed at code level, then FIXED): `deleteUserPreset()`
  // (`use-models.ts`) wrote both blobs and updated `taskAssignments` (via
  // `putTaskAssignments`) but never called `setUserPresets(plan.presets)`,
  // while the settings seed effect is one-shot
  // (`if (!s || settingsSeededRef.current) return`) — so `refreshSettingsCache()`'s
  // invalidation refetched the query but never re-seeded the state, and the
  // deleted preset stayed in `userPresets` → `mergedPresets` →
  // `segmentedOptions` for the life of the mount.
  const stale = panel().getByRole("radio", { name: RENAMED, exact: true });
  const staleCount = await stale.count();
  const labelsNow = await trackLabels();
  record(
    "09",
    "track option labels immediately after the delete committed",
    !labelsNow.includes(RENAMED),
    `labels=[${labelsNow.join(" · ")}]`,
  );
  record(
    "09",
    "Auto is the selected option after the delete",
    (await trackChecked("Auto")) === true,
    `aria-checked(Auto)=${await trackChecked("Auto")}`,
  );

  record(
    "09",
    "BUG: deleted preset must NOT remain an option in the Params track",
    staleCount === 0,
    staleCount === 0
      ? `FIXED — gone from the track; labels=[${labelsNow.join(" · ")}]`
      : `STALE OPTION STILL RENDERED (${staleCount}); outerHTML=${(await stale.first().evaluate((e) => e.outerHTML)).slice(0, 120)}`,
  );

  await capture(
    "09",
    "deleted-fallback-auto",
    "IMMEDIATELY after confirming deletion",
    "Params track immediately AFTER the delete: 'Careful cleanup v2' is ABSENT from the options, 'Auto' is selected, no PresetActionRow, no raw user_ id. Blobs in manifest.blobs['09-after-delete'].",
    panel(),
  );

  // Prove the absence is durable, not an enter-transition artifact of the
  // track re-laying itself out.
  let stillThere = staleCount;
  try {
    await expect
      .poll(
        async () =>
          panel().getByRole("radio", { name: RENAMED, exact: true }).count(),
        { timeout: 2_500, intervals: [500] },
      )
      .toBe(0);
  } catch {
    stillThere = await panel()
      .getByRole("radio", { name: RENAMED, exact: true })
      .count();
  }
  record(
    "09",
    "BUG: stale option is permanent (still present 2.5s after the delete committed)",
    stillThere === 0,
    stillThere === 0
      ? "FIXED — count after 2.5s = 0"
      : `count after 2.5s = ${stillThere}`,
  );

  record(
    "09",
    "action row gone (nothing selected → nothing to act on)",
    (await deleteBtn().count()) === 0,
    "no Delete* button in panel",
  );

  await capture(
    "09b",
    "deleted-option-absent-2-5s",
    "Same panel 2.5s later",
    "The same Params track 2.5s after the delete committed: 'Careful cleanup v2' is STILL absent, 'Auto' still selected — proof the fix is durable state, not a transition frame.",
    panel(),
  );

  await assertNoRawUuid("09", [P1.id]);
});

// ---------------------------------------------------------------------------
// 10 — dangling / missing preset
// ---------------------------------------------------------------------------

test("10 dangling assignment renders 'Preset no longer available', never a raw uuid", async () => {
  const prev = parseAssignments(await apiGet("llm_task_assignments"));
  // out-of-band write the UI's own delete path would never produce
  expect(
    await apiPut(
      "llm_task_assignments",
      JSON.stringify({
        ...prev,
        cleanup: { mode: "preset", presetId: GHOST_ID },
      }),
    ),
  ).toBe(200);

  // DEFECT B (observed): a real reload of a deep route renders a BLANK window.
  // `registerAppProtocol` (src/main/index.ts:453) serves index.html for
  // extension-less paths, but the built index.html references its assets
  // RELATIVELY (`./assets/…`) because no `base` is set on the renderer build,
  // so from /settings/models the browser asks for
  // /settings/models/assets/index-*.js — which has an extension, gets no SPA
  // fallback, resolves to a nonexistent file on disk, and `net.fetch` fails
  // with net::ERR_UNEXPECTED (observed verbatim — not a 404). React never
  // mounts.
  swallowingRequestFailures = true;
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2_000));
  const blankBody = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  const blankSections = await page.locator("section").count();
  record(
    "10d",
    "hard reload of /settings/models must re-render the app (DEFECT B: it renders BLANK)",
    blankBody.length > 0 && blankSections > 0,
    `url=${page.url()}; bodyText.length=${blankBody.length}; sections=${blankSections}; failedRequests=${defectRequestFailures.length}; consoleErrors=${defectConsoleErrors.length} — root cause: built index.html uses relative './assets/…' URLs while registerAppProtocol (src/main/index.ts:453) only SPA-falls-back for extension-less paths`,
  );
  await capture(
    "10d",
    "defect-blank-after-reload",
    "DEFECT: reload of a deep route",
    "DEFECT EVIDENCE: the whole window after pressing reload on /settings/models — chrome only / blank, React did not mount.",
    page,
  );

  // Workaround that stays inside the app: load the ROOT document (assets then
  // resolve correctly) and route to Models client-side. This is a genuine
  // fresh mount, so it also proves the dangling state survives a restart.
  await page.goto("app://renderer/", { waitUntil: "domcontentloaded" });
  swallowingRequestFailures = false;
  await expect(page.getByRole("link", { name: "Models" }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "Models" }).first().click();
  await page.waitForURL(/\/settings\/models/, { timeout: 20_000 });
  await section().waitFor({ state: "visible", timeout: 30_000 });
  await expandCleanup();
  const p = panel();

  // The dangling chip lives in the ROW HEADER (`TaskRow`'s header button),
  // never in the expanded panel — the panel only carries `presetMissingNote`.
  const badge = section()
    .getByText("Preset no longer available", { exact: true })
    .first();
  await expect(badge).toBeVisible({ timeout: 20_000 });
  record(
    "10",
    "explicit 'Preset no longer available' badge renders for a dangling presetId (fresh mount)",
    await badge.isVisible(),
    "badge visible in the row header",
  );

  const note = await p
    .getByText(/no longer exists/)
    .first()
    .innerText()
    .catch(() => "");
  record(
    "10",
    "explanatory note says the task runs on Auto defaults",
    note.length > 0,
    `note: ${note.slice(0, 160)}`,
  );
  record(
    "10",
    "no PresetActionRow for a preset that does not exist",
    (await p.getByRole("button", { name: "Rename", exact: true }).count()) ===
      0,
    "no action row",
  );

  await capture(
    "10",
    "dangling-missing-badge",
    "Dangling / missing-preset state",
    "Cleanup row badge reads 'Preset no longer available' (outline variant) and the panel explains the task runs on Auto defaults. The raw id user_… must appear nowhere.",
    section(),
  );

  const text = await bodyText();
  record(
    "10",
    "ghost id absent from rendered text",
    !text.includes(GHOST_ID),
    GHOST_ID,
  );
  await assertNoRawUuid("10", [GHOST_ID, P1.id, P2.id]);

  // leave the blob clean for the next step
  await apiPut("llm_task_assignments", JSON.stringify(prev));
});

// ---------------------------------------------------------------------------
// 11 — built-in fork path
// ---------------------------------------------------------------------------

test("11 builtin fork: editing 'Qwen fast' writes a new user_* copy, keeps modelOverride", async () => {
  await expandCleanup();
  await clickTrack("Qwen fast");
  const p = panel();

  // set a per-task model override BEFORE the fork (§6.3 preservation)
  await p.getByRole("combobox").first().click();
  const opt = page.getByRole("option", { name: /Local Qwen 27B/ }).first();
  await opt.waitFor({ state: "visible", timeout: 15_000 });
  const oRes = waitForSettingsPut("llm_task_assignments");
  await opt.click();
  expect((await oRes).status()).toBe(200);

  record(
    "11",
    "fork warning caption + 'Duplicate to edit' visible before forking",
    (await p.getByText(/saves a copy you own/).count()) > 0 &&
      (await p
        .getByRole("button", { name: "Duplicate to edit", exact: true })
        .count()) > 0,
    "warning + Duplicate to edit visible",
  );

  await capture(
    "11a",
    "builtin-fork-warning",
    "Built-in selected + model override set",
    "Cleanup row on builtin 'Qwen fast': Built-in badge, 'Duplicate to edit' · Rename · Duplicate (NO Delete), fork warning caption 'Editing or renaming saves a copy you own…', Model select showing 'Local Qwen 27B'.",
    section(),
  );

  const dup = p
    .getByRole("button", { name: "Duplicate to edit", exact: true })
    .first();
  await dup.click();
  const ta = panel().locator("textarea").first();
  await expect(ta).toBeVisible({ timeout: 10_000 });
  const nameInput = panel().locator("input").first();
  const forkName =
    (await nameInput.count()) > 0 ? await nameInput.inputValue() : "";
  record(
    "11",
    "builtin edit opens EDITABLE with a prefilled copy name + 'Save as copy'",
    forkName === "Qwen fast copy" &&
      (await panel()
        .getByRole("button", { name: "Save as copy", exact: true })
        .count()) > 0,
    `name="${forkName}"`,
  );

  await capture(
    "11b",
    "builtin-fork-editor",
    "Built-in fork editor",
    "Raw-JSON editor opened from 'Duplicate to edit' — editable, Name field prefilled 'Qwen fast copy', Save labelled 'Save as copy'.",
    panel(),
  );

  await ta.fill(
    (await ta.inputValue()).replace(
      '"temperature": 0.7',
      '"temperature": 0.42',
    ),
  );
  const before = parsePresets(await apiGet("llm_parameter_presets")).presets
    .length;
  const res = waitForSettingsPut("llm_parameter_presets");
  await panel()
    .getByRole("button", { name: "Save as copy", exact: true })
    .first()
    .click();
  expect((await res).status()).toBe(200);

  const blob = await blobWait(
    "llm_parameter_presets",
    (v) => !!v && v.includes("0.42"),
  );
  const fork = parsePresets(blob).presets.find((x) =>
    JSON.stringify(x).includes("0.42"),
  );
  const assignments = await blobWait(
    "llm_task_assignments",
    (v) => !!parseAssignments(v).cleanup?.presetId?.startsWith("user_"),
  );
  const cleanup = parseAssignments(assignments).cleanup;
  await snapshot("11-after-fork");

  record(
    "11",
    "fork wrote a NEW user_* preset (list grew by exactly one)",
    !!fork &&
      fork.id.startsWith("user_") &&
      parsePresets(blob).presets.length === before + 1,
    `count ${before} -> ${parsePresets(blob).presets.length}`,
  );
  record(
    "11",
    "cleanup task re-pointed at the new user_* copy",
    cleanup?.mode === "preset" && cleanup?.presetId === fork?.id,
    `cleanup=${JSON.stringify(cleanup)}`,
  );
  record(
    "11",
    "modelOverride survived the fork (§6.3)",
    JSON.stringify(cleanup?.modelOverride) ===
      JSON.stringify({ provider: "local-llm", model_id: "qwen3.8-27b" }),
    `modelOverride=${JSON.stringify(cleanup?.modelOverride)}`,
  );

  await expect(panel().getByText("Yours", { exact: true }).first()).toBeVisible(
    { timeout: 15_000 },
  );
  record(
    "11",
    "row badge flipped Built-in → Yours and Delete now exists",
    (await deleteBtn().count()) === 1,
    `Delete count=${await deleteBtn().count()}`,
  );

  await capture(
    "11c",
    "builtin-fork-landed",
    "After the fork",
    "Cleanup row owned by 'Qwen fast copy' — Yours badge, four user buttons including Delete, Model select still showing the Local Qwen 27B override.",
    panel(),
  );

  await assertNoRawUuid("11", [fork?.id ?? "", GHOST_ID]);
});

// ---------------------------------------------------------------------------
// 12 — session health
// ---------------------------------------------------------------------------

test("12 no console errors, no failed requests, no 4xx/5xx anywhere", async () => {
  const bad = httpLog.filter((r) => r.status >= 400);
  record(
    "12",
    "no HTTP 4xx/5xx during the whole session",
    bad.length === 0,
    bad.length
      ? bad.map((b) => `${b.method} ${b.path} ${b.status}`).join("; ")
      : `${httpLog.length} calls, all 2xx`,
  );
  record(
    "12",
    "no renderer console errors",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | ") || "none",
  );
  record(
    "12",
    "no unhandled page errors / rejections",
    pageErrors.length === 0,
    pageErrors.slice(0, 3).join(" | ") || "none",
  );
  record(
    "12",
    "no failed network requests",
    requestFailures.length === 0,
    requestFailures.slice(0, 3).join(" | ") || "none",
  );

  expect(bad, `HTTP failures: ${JSON.stringify(bad)}`).toHaveLength(0);
  expect(
    consoleErrors,
    `console errors: ${JSON.stringify(consoleErrors)}`,
  ).toHaveLength(0);
  expect(pageErrors, `page errors: ${JSON.stringify(pageErrors)}`).toHaveLength(
    0,
  );
});

// ---------------------------------------------------------------------------
// 13 — defect roll-up
//
// The capture steps deliberately `record()` rather than `expect()`, so one
// cosmetic miss cannot stop later screenshots. This is where the ledger is
// settled. OFF by default: this file's job is EVIDENCE, and a red suite would
// bury the 12 good captures; flip OPENSTYLE_EVIDENCE_STRICT=1 to make the
// suite fail on any recorded defect (that is the shape you would keep if the
// two open bugs below were fixed).
// ---------------------------------------------------------------------------

test("13 defect roll-up", async () => {
  const failed = assertions.filter((a) => a.result === "FAIL");
  const defectIds = failed.map((f) => `${f.step}: ${f.assertion}`);
  console.log(
    `\n===== DEFECT ROLL-UP =====\n${failed.length === 0 ? "no recorded defects" : defectIds.join("\n")}\n============================\n`,
  );
  record(
    "13",
    "no recorded product defects across steps 01-12",
    failed.length === 0,
    `${failed.length} defect(s)`,
  );
  writeFileSync(
    join(EVIDENCE_DIR, "defects.json"),
    JSON.stringify(
      { failed, defectRequestFailures, defectConsoleErrors },
      null,
      2,
    ),
  );

  if (process.env.OPENSTYLE_EVIDENCE_STRICT === "1") {
    expect(failed, `recorded defects:\n${defectIds.join("\n")}`).toHaveLength(
      0,
    );
  }
});
