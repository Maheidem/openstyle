import { z } from "zod/v3";
import { normalizeOmlxRoot } from "./omlx.js";

/** What a model can do. Section 4.3 of `specs/model-picker-groups.md`. */
export const SERVER_MODEL_KINDS = [
  "speech",
  "llm",
  "embedding",
  "rerank",
  "tts",
  "other",
  "unknown",
] as const;

export type ServerModelKind = (typeof SERVER_MODEL_KINDS)[number];

/** Where a model kind came from: server data or the name rules. */
export type ServerKindSource = "server" | "name";

/** Body for `POST /api/servers`. */
export const addServerSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Address is required")
    .max(2048)
    .refine(
      (value) => {
        try {
          return ["http:", "https:"].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: "Must be a valid http:// or https:// address" },
    ),
  api_key: z.string().max(2048).optional(),
});

export type AddServerInput = z.infer<typeof addServerSchema>;

/** The own-server provider id. The model id is `server/<serverId>/<modelId>`. */
export const SERVER_PROVIDER_ID = "server";

/**
 * Split a configured server model id into the server id and the model id.
 * The server id ends at the first `/` after the `server/` prefix. The model id
 * is the rest and may hold more `/` (LM Studio uses `publisher/name`).
 * Returns null when the id has no server part.
 */
export function parseServerModelId(
  modelId: string,
): { serverId: string; model: string } | null {
  const rest = modelId.startsWith(`${SERVER_PROVIDER_ID}/`)
    ? modelId.slice(SERVER_PROVIDER_ID.length + 1)
    : modelId;
  const idx = rest.indexOf("/");
  if (idx <= 0 || idx === rest.length - 1) return null;
  return { serverId: rest.slice(0, idx), model: rest.slice(idx + 1) };
}

/** Build a configured server model id. */
export function serverModelId(serverId: string, model: string): string {
  return `${SERVER_PROVIDER_ID}/${serverId}/${model}`;
}

/**
 * The identity of a server: the lowercased root with scheme, host, port and
 * path. `localhost`, `127.0.0.1` and `[::1]` are one host. A missing port is
 * the default port of the scheme. `http` and `https` on one port are two
 * servers. Two proxy paths on one host are two servers.
 */
export function serverKey(input: string): string {
  const root = normalizeOmlxRoot(input);
  let url: URL;
  try {
    url = new URL(root);
  } catch {
    return root.toLowerCase();
  }
  let host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    host = "127.0.0.1";
  }
  const secure = url.protocol === "https:";
  const port = url.port || (secure ? "443" : "80");
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  return `${url.protocol}//${host}:${port}${path}`;
}
