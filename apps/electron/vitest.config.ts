import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
  test: {
    globals: true,
    // tests/preload-channels.test.ts is a pure-node vitest suite that lives
    // beside the Playwright e2e files (it parses source, launches nothing);
    // it is included explicitly here and ignored by name in
    // playwright.config.ts so exactly one runner picks it up.
    include: ["src/renderer/**/*.test.ts", "tests/preload-channels.test.ts"],
    environment: "node",
  },
});
