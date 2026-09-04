import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Directory name under `~/.cache` holding downloaded models and the MLX worker
 * runtime.
 *
 * Deliberately still "freestyle" after the Openstyle rename. This cache holds
 * multi-gigabyte Whisper models and the ~320 MB MLX worker; renaming it would
 * orphan every existing install's downloads and silently re-fetch all of them.
 *
 * Migrating it was considered and rejected. The paths below are read from many
 * call sites across two entry points (the `openstyle-server` bin and the
 * in-process server Electron starts), and the server ships through
 * `pkgroll --minify`, so a rename would have to bet gigabytes of re-downloads on
 * module-initialisation order surviving bundling. Keeping a stable cache name
 * costs one comment; getting the migration subtly wrong costs the user's
 * downloads. This is a cache directory, not user data — its name carries no
 * branding a user ever sees.
 */
export const MODEL_CACHE_DIR_NAME = "freestyle";

/** Absolute path inside the shared on-disk model cache. */
export function modelCacheDir(...segments: string[]): string {
  return join(homedir(), ".cache", MODEL_CACHE_DIR_NAME, ...segments);
}

/*
 * Below this point: see local-model-dirs.ts for the aggregate "everywhere
 * local models live on disk" helper (Settings disk usage). Kept in a separate
 * module because it must import the mlx-asr constants, which import this
 * file — colocating it here would create an import cycle.
 */
