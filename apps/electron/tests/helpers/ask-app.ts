import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import {
  embeddedServerUrl,
  launchOpenstyle,
  waitForDashboardWindow,
} from "./e2e-app";

// The isolated app of the Ask specs (tests/meeting-ask-tab.test.ts and
// tests/meeting-ask-p2.test.ts): a scratch profile with the Meetings flag on,
// and a small API client for the embedded server.

export interface Booted {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  base: string;
  api(method: string, path: string, body?: unknown): Promise<Response>;
}

/** The folder with the models--* folders of the scratch HF cache. */
export function hfCacheDir(): string {
  const root = process.env.OPENSTYLE_E2E_ASK_HF ?? "/tmp/chatp1/hf";
  return existsSync(join(root, "hub")) ? join(root, "hub") : root;
}

export async function boot(
  prefix: string,
  env: Record<string, string>,
): Promise<Booted> {
  const userDataDir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(userDataDir, "settings.json"),
    JSON.stringify({ onboardingComplete: true }),
  );
  writeFileSync(
    join(userDataDir, "config.freestyle.json"),
    JSON.stringify({ version: 1, flags: { meetings: true } }),
  );
  const app = await launchOpenstyle({ userDataDir, env });
  const page = await waitForDashboardWindow(app, 15_000);
  try {
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  } catch {
    await page.waitForLoadState("load", { timeout: 10_000 });
  }
  // The boot sweep of orphans runs 3 s after the start (main/index.ts). The
  // seeded meetings are not recording, but wait as the other specs do.
  await new Promise((r) => setTimeout(r, 3500));
  const base = embeddedServerUrl(app);
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, page, userDataDir, base, api };
}

export async function put(
  b: Booted,
  key: string,
  value: string,
): Promise<void> {
  const res = await b.api("PUT", `/settings/${key}`, { value });
  expect(res.status, `PUT /api/settings/${key}`).toBe(200);
}

export async function settingValue(
  b: Booted,
  key: string,
): Promise<string | undefined> {
  const all = (await (await b.api("GET", "/settings")).json()) as Record<
    string,
    string
  >;
  return all[key];
}
