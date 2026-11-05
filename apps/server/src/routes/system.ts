import { existsSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { dirname } from "node:path";
import { Hono } from "hono";
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

// What the onboarding needs to know about this Mac (specs/onboarding.md).
const system = new Hono().get("/profile", async (c) => {
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
