import { join } from "node:path";

/**
 * The folder for openstyle.log, openstyle-server.log and openstyle-trace.log.
 * Order: OPENSTYLE_LOG_DIR, then `<OPENSTYLE_USER_DATA>/logs`, then the
 * default (`app.getPath("logs")`). An isolated test run (own userData) thus
 * never writes into the installed app's log folder (issue #218).
 * The legacy FREESTYLE_* names are read as a fallback, as elsewhere in main.
 */
export function resolveLogsDir(
  env: NodeJS.ProcessEnv,
  defaultDir: string,
): string {
  const explicit = env.OPENSTYLE_LOG_DIR || env.FREESTYLE_LOG_DIR;
  if (explicit) return explicit;
  const userData = env.OPENSTYLE_USER_DATA ?? env.FREESTYLE_USER_DATA;
  if (userData) return join(userData, "logs");
  return defaultDir;
}
