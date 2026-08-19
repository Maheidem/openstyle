import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@openstyle/validations": resolve(
        __dirname,
        "../../packages/validations/src/index.ts",
      ),
      "@openstyle/sdk": resolve(__dirname, "../../packages/sdk/src/index.ts"),
      "@openstyle/utils": resolve(
        __dirname,
        "../../packages/utils/src/index.ts",
      ),
      "@openstyle/stt": resolve(__dirname, "../../packages/stt/src/index.ts"),
    },
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 10_000,
    pool: "forks",
  },
});
