import { z } from "zod/v3";

/** Default loopback port of the Openstyle server. */
export const DEFAULT_SERVER_PORT = 4649;

/**
 * True when a `/api/health` body shows an Openstyle server (and not another
 * service that holds the port).
 * Accepts the legacy "freestyle" identity too so a not-yet-updated
 * standalone/remote server (auto-update is on by default, but a
 * separately-deployed apps/server may lag) is still recognized.
 */
export function isOpenstyleHealthBody(body: {
  status?: string;
  name?: string;
}): boolean {
  return (
    body.status === "ok" &&
    (body.name === "openstyle" || body.name === "freestyle")
  );
}

/**
 * Server URL for the desktop app. An empty string means "use the built-in
 * local server"; otherwise it must be a valid URL. Trailing slashes are
 * stripped so callers can append paths cleanly.
 */
export const serverUrlSchema = z
  .string()
  .trim()
  .refine(
    (v) => v === "" || z.string().url().safeParse(v).success,
    "Must be a valid URL",
  )
  // Normalize via the URL parser (lowercases scheme/host so the renderer's
  // http->ws rewrite is reliable), then drop any trailing slash.
  .transform((v) => {
    if (v === "") return "";
    try {
      return new URL(v).href.replace(/\/+$/, "");
    } catch {
      return v.replace(/\/+$/, "");
    }
  });
