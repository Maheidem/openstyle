import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // tests/preload-channels.test.ts is a vitest suite (source parsing, no
  // Electron launch) that merely lives beside the e2e files — vitest runs it
  // (vitest.config.ts includes it explicitly), Playwright must not.
  testIgnore: /preload-channels\.test\.ts$/,
  timeout: 60_000,
  // Launching and quitting a real Electron app is occasionally flaky on CI
  // runners (a hung quit shows up as a test timeout plus a worker teardown
  // timeout). Retry there so one bad launch doesn't red-line the whole run;
  // locally we keep 0 so flakes stay visible.
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Electron tests must run serially
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});
