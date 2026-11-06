import { existsSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { dirname } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  AppShellTimeoutError,
  NoAppShellError,
  requestAppSettings,
} from "../lib/app-settings-bridge.js";
import { getFreeSpace } from "../lib/disk.js";
import {
  hfCacheRoot,
  isAppleSiliconMac,
  MLX_ASR_PROVIDER_ID,
} from "../lib/mlx-asr/constants.js";
import { getMlxCatalogModels } from "../lib/mlx-asr/models.js";
import {
  isManagedMlxRuntimeAvailable,
  isMlxRuntimeInstallable,
  MLX_WORKER_ARCHIVE_BYTES,
} from "../lib/mlx-asr/runtime.js";
import { canRunMlxAsr } from "../lib/mlx-asr/server.js";
import { computeVoiceFit, fitMachine } from "../lib/mlx-llm/fit.js";
import { WHISPER_PROVIDER_ID } from "../lib/whisper/constants.js";
import { getCatalogModels } from "../lib/whisper/models.js";

/** The nearest folder above `path` that exists (the cache folder may not exist yet). */
function nearestExistingDir(path: string): string {
  let dir = path;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return homedir();
    dir = parent;
  }
  return dir;
}

// A change of the app-shell settings (specs/mcp.md 6.4). A custom pill
// position is a drag in the app, so the four presets are the only values.
const appSettingsPatchSchema = z
  .object({
    pill_position: z
      .enum(["top-center", "top-right", "bottom-center", "bottom-right"])
      .optional(),
    auto_update: z.boolean().optional(),
    update_channel: z.enum(["stable", "dev"]).optional(),
    launch_at_login: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message:
      "Provide pill_position, auto_update, update_channel or launch_at_login",
  });

/** Ask main, and turn each failure into an HTTP error. */
async function appSettingsAnswer(
  patch: z.infer<typeof appSettingsPatchSchema> | null,
) {
  try {
    return { status: 200 as const, body: await requestAppSettings(patch) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      status:
        err instanceof NoAppShellError
          ? (503 as const)
          : err instanceof AppShellTimeoutError
            ? (504 as const)
            : (500 as const),
      body: { error },
    };
  }
}

const system = new Hono()
  // The app-shell settings, read and change (specs/mcp.md 6.4).
  .get("/app-settings", async (c) => {
    const answer = await appSettingsAnswer(null);
    return c.json(answer.body, answer.status);
  })
  .put(
    "/app-settings",
    zValidator("json", appSettingsPatchSchema),
    async (c) => {
      const answer = await appSettingsAnswer(c.req.valid("json"));
      return c.json(answer.body, answer.status);
    },
  )
  // What the onboarding needs to know about this Mac (specs/onboarding.md).
  .get("/profile", async (c) => {
    const { ramBytes } = fitMachine(null);
    const voiceFit: Record<string, "runs_well" | "tight" | "wont_fit"> = {};
    for (const m of getCatalogModels()) {
      voiceFit[`${WHISPER_PROVIDER_ID}/${m.id}`] = computeVoiceFit(
        m.ramRequired,
        ramBytes,
      );
    }
    if (isAppleSiliconMac()) {
      for (const m of getMlxCatalogModels()) {
        voiceFit[`${MLX_ASR_PROVIDER_ID}/${m.id}`] = computeVoiceFit(
          m.ramRequired,
          ramBytes,
        );
      }
    }
    return c.json({
      appleSilicon: isAppleSiliconMac(),
      // The MLX worker that the first MLX model download installs. 0 when the
      // worker is there already or this Mac cannot install it.
      mlxWorkerBytes:
        isMlxRuntimeInstallable() &&
        !canRunMlxAsr() &&
        !isManagedMlxRuntimeAvailable()
          ? MLX_WORKER_ARCHIVE_BYTES
          : 0,
      chip: cpus()[0]?.model ?? null,
      ramBytes,
      freeDiskBytes: await getFreeSpace(nearestExistingDir(hfCacheRoot())),
      voiceFit,
    });
  });

export default system;
