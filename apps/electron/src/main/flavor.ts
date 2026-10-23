import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The "Openstyle Dev" flavor: a local build from `pnpm dev:install`
 * (scripts/dev-install.sh). It runs next to the installed Openstyle.
 *
 * electron-builder writes `"openstyleFlavor": "dev"` into the packaged
 * package.json (`-c.extraMetadata.openstyleFlavor=dev`), together with
 * the product name "Openstyle Dev" and the bundle id com.openstyle.app.dev.
 * The product name gives the flavor its own userData and log folders.
 * Main reads the flag once at startup and then:
 * - never probes or reuses the server on port 4649 (server-host.ts),
 * - asks for DEV_SERVER_PORT first,
 * - gives the server its own model and MLX worker cache (devModelCacheDir),
 * - never checks for updates (updater.ts),
 * - shows "Openstyle Dev" as the app name and in the tray tooltip.
 * Without the field (every other build) nothing changes.
 */
export const DEV_FLAVOR_NAME = "Openstyle Dev";

/** The first port the dev flavor asks for. Never the default port 4649. */
export const DEV_SERVER_PORT = 4659;

/** True when the package.json in `appPath` marks the dev flavor. */
export function isDevFlavorApp(appPath: string): boolean {
  try {
    const pkg = JSON.parse(
      readFileSync(join(appPath, "package.json"), "utf8"),
    ) as { openstyleFlavor?: unknown };
    return pkg.openstyleFlavor === "dev";
  } catch {
    return false;
  }
}

/**
 * The model cache of the dev flavor (OPENSTYLE_MODEL_CACHE_DIR of the server).
 * The installed app uses ~/.cache/freestyle (apps/server/src/lib/model-cache.ts).
 */
export function devModelCacheDir(home = homedir()): string {
  return join(home, ".cache", "openstyle-dev");
}
