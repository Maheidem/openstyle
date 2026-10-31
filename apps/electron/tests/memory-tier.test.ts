import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
// Memory-tier load (specs/live-chat.md section 7, .claude/skills/memory-tier-test).
// This spec is the load half of scripts/memory-tier-test.sh. It does nothing
// without OPENSTYLE_MEMTIER_OUT. The shell script samples the memory of the
// process tree. This spec runs the app:
//   - live chat ON, real local ASR and chat model, fake mic audio
//     (OPENSTYLE_E2E_FAKE_MEETING_AUDIO, a long fictional script);
//   - GET /live every second: the lag of each new line, behind the audio;
//   - one chat question every OPENSTYLE_MEMTIER_ASK_S seconds;
//   - for OPENSTYLE_MEMTIER_MINUTES minutes, then Stop.
// It writes live.csv, latency.csv, chat.csv and app.pid into the out folder.
// Fictional data only. Run it through the Test Runner, in quiet mode, under the
// GPU lock.
// ---------------------------------------------------------------------------

const OUT = process.env.OPENSTYLE_MEMTIER_OUT;
const MINUTES = Number(process.env.OPENSTYLE_MEMTIER_MINUTES ?? "30");
const ASK_S = Number(process.env.OPENSTYLE_MEMTIER_ASK_S ?? "120");
const ASR = "qwen3-1.7b-8bit";
const LLM = "gemma-4-e2b-qat-4bit";
const QUESTIONS = [
  "What was the last topic they talked about?",
  "Which date did they mention most recently?",
  "Who is responsible for the next step?",
  "What did they say about the budget?",
];

test.skip(
  !OUT || process.platform !== "darwin",
  "needs OPENSTYLE_MEMTIER_OUT (run scripts/memory-tier-test.sh)",
);
test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let dashboard: Page;
let userDataDir: string;
let base: string;

function out(name: string): string {
  return join(OUT as string, name);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok)
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

test.beforeAll(async () => {
  mkdirSync(out("."), { recursive: true });
  for (const [file, head] of [
    ["live.csv", "t_s,http_ms,status,reason,lines,finals"],
    ["latency.csv", "t_s,kind,lag_ms"],
    ["chat.csv", "t_s,http,wall_ms,server_ms,cold,answer_chars,cites"],
  ] as const) {
    writeFileSync(out(file), `${head}\n`);
  }
  userDataDir = mkdtempSync(join(tmpdir(), "openstyle-e2e-memtier-"));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  app = await launchOpenstyle({
    userDataDir,
    env: { OPENSTYLE_E2E_FAKE_MEETING_CAPTURE: "1" },
  });
  dashboard = await waitForDashboardWindow(app, 20_000);
  base = embeddedServerUrl(app);
  // The shell script builds the process tree from this PID.
  writeFileSync(out("app.pid"), String(app.process().pid));
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  // Keep the app logs as evidence for the OOM check. The data is fictional.
  const logs = join(userDataDir, "logs");
  if (OUT && existsSync(logs)) {
    cpSync(logs, out("app-logs"), { recursive: true });
  }
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test("live chat load for N minutes", async () => {
  test.setTimeout((MINUTES + 12) * 60_000);

  // Settings and models. Defaults stay as shipped, except the live setting.
  await api("/api/settings/live_chat_enabled", {
    method: "PUT",
    body: JSON.stringify({ value: "true" }),
  });
  await api("/api/settings/meeting_enhance_prompt_seen", {
    method: "PUT",
    body: JSON.stringify({ value: "true" }),
  });
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

  // Optional search model (project memory). Not fatal when it is missing.
  if (process.env.OPENSTYLE_MLX_EMBED_WORKER) {
    try {
      await dashboard.goto("app://renderer/settings/models");
      const section = dashboard.getByTestId("search-model-section");
      await expect(section).toBeVisible({ timeout: 20_000 });
      const use = section.getByRole("button", { name: "Use", exact: true });
      await expect(use).toBeVisible({ timeout: 30_000 });
      await use.click();
      await expect(section).toContainText("Selected", { timeout: 60_000 });
      console.log("MEMTIER search model: selected");
    } catch (error) {
      console.log(
        `MEMTIER search model: not selected (${String(error).slice(0, 120)})`,
      );
    }
  }

  // Start the meeting like a user.
  await dashboard.goto("app://renderer/meetings");
  await dashboard
    .getByRole("button", { name: "Start recording" })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        dashboard.evaluate(
          async () => (await window.api.getMeetingStatus()).status,
        ),
      { timeout: 20_000 },
    )
    .toBe("recording");
  const id = await dashboard.evaluate(
    async () => (await window.api.getMeetingStatus()).meetingId as string,
  );
  const t0 = Date.now();
  const since = () => Math.round((Date.now() - t0) / 1000);
  console.log(`MEMTIER meeting started id=${id}`);

  type Line = {
    source: string;
    startMs: number;
    endMs: number;
    final: boolean;
  };
  const seen = new Map<string, boolean>(); // key -> final already counted
  let nextAsk = 90_000;
  let askIndex = 0;
  const pending: Promise<void>[] = [];

  const ask = async () => {
    const question = QUESTIONS[askIndex++ % QUESTIONS.length];
    const at = since();
    const began = Date.now();
    try {
      const res = await fetch(`${base}/api/meetings/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: AbortSignal.timeout(170_000),
      });
      const wall = Date.now() - began;
      const body = res.ok
        ? ((await res.json()) as {
            answer?: string;
            cites?: unknown[];
            ms?: number;
            cold?: boolean;
          })
        : {};
      appendFileSync(
        out("chat.csv"),
        `${at},${res.status},${wall},${body.ms ?? ""},${body.cold ?? ""},${body.answer?.length ?? 0},${body.cites?.length ?? 0}\n`,
      );
    } catch (error) {
      appendFileSync(
        out("chat.csv"),
        `${at},error:${String(error).slice(0, 40).replace(/[,\n]/g, " ")},${Date.now() - began},,,,\n`,
      );
    }
  };

  const deadline = t0 + MINUTES * 60_000;
  while (Date.now() < deadline) {
    const tick = Date.now();
    const elapsed = tick - t0;
    try {
      const res = await fetch(`${base}/api/meetings/${id}/live`, {
        signal: AbortSignal.timeout(10_000),
      });
      const http = Date.now() - tick;
      const live = (await res.json()) as {
        status: string;
        reason?: string;
        lines: Line[];
      };
      const finals = live.lines.filter((l) => l.final).length;
      appendFileSync(
        out("live.csv"),
        `${since()},${http},${live.status},${live.reason ?? ""},${live.lines.length},${finals}\n`,
      );
      for (const line of live.lines) {
        const key = `${line.source}:${line.startMs}`;
        const lag = Math.round(elapsed - line.endMs);
        if (!seen.has(key)) {
          seen.set(key, line.final);
          appendFileSync(
            out("latency.csv"),
            `${since()},${line.final ? "final" : "partial"},${lag}\n`,
          );
        } else if (line.final && seen.get(key) === false) {
          seen.set(key, true);
          appendFileSync(out("latency.csv"), `${since()},final,${lag}\n`);
        }
      }
    } catch (error) {
      appendFileSync(
        out("live.csv"),
        `${since()},,error:${String(error).slice(0, 40).replace(/[,\n]/g, " ")},,,\n`,
      );
    }
    if (elapsed >= nextAsk) {
      nextAsk += ASK_S * 1000;
      pending.push(ask());
    }
    const wait = 1000 - (Date.now() - tick);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  await Promise.allSettled(pending);
  await dashboard
    .getByRole("button", { name: "Stop", exact: true })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        dashboard.evaluate(
          async () => (await window.api.getMeetingStatus()).status,
        ),
      { timeout: 60_000 },
    )
    .toBe("idle");
  writeFileSync(out("spec.done"), `${new Date().toISOString()}\n`);
});
