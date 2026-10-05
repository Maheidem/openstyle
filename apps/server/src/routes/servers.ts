import { zValidator } from "@hono/zod-validator";
import { addServerSchema, normalizeOmlxRoot } from "@openstyle/validations";
import { Hono } from "hono";
import {
  deleteOwnServer,
  findOwnServerByUrl,
  insertOwnServer,
  listOwnServers,
  type OwnServer,
  updateOwnServerFlavor,
} from "../lib/own-servers.js";
import {
  probeServer,
  type ServerFlavor,
  type ServerModel,
  ServerProbeError,
} from "../lib/server-models.js";

const FLAVOR_LABELS: Record<ServerFlavor, string> = {
  omlx: "oMLX",
  openai: "OpenAI-compatible",
};

/** Computed, never stored: "{flavor} ({host:port})". */
function serverName(baseUrl: string, flavor: ServerFlavor): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // Keep the raw text for an address that does not parse.
  }
  return `${FLAVOR_LABELS[flavor]} (${host})`;
}

function storedFlavor(server: OwnServer): ServerFlavor {
  return server.flavor === "omlx" ? "omlx" : "openai";
}

interface ServerView {
  id: string;
  name: string;
  base_url: string;
  has_key: boolean;
  flavor: ServerFlavor;
  reachable: boolean;
  error?: string;
  models: ServerModel[];
}

/** The API shape of one server. It never holds the key. */
function toView(
  server: OwnServer,
  probe: { flavor: ServerFlavor; models: ServerModel[] } | { error: string },
): ServerView {
  const base = {
    id: server.id,
    base_url: server.base_url,
    has_key: !!server.api_key,
  };
  if ("error" in probe) {
    const flavor = storedFlavor(server);
    return {
      ...base,
      name: serverName(server.base_url, flavor),
      flavor,
      reachable: false,
      error: probe.error,
      models: [],
    };
  }
  return {
    ...base,
    name: serverName(server.base_url, probe.flavor),
    flavor: probe.flavor,
    reachable: true,
    models: probe.models,
  };
}

async function probeView(server: OwnServer): Promise<ServerView> {
  try {
    const result = await probeServer(server.base_url, server.api_key);
    if (result.flavor !== server.flavor) {
      updateOwnServerFlavor(server.id, result.flavor);
    }
    return toView(server, result);
  } catch (err) {
    if (err instanceof ServerProbeError) {
      return toView(server, { error: err.code });
    }
    throw err;
  }
}

const servers = new Hono()
  .get("/", async (c) => {
    const views = await Promise.all(listOwnServers().map(probeView));
    return c.json(views);
  })
  .post("/", zValidator("json", addServerSchema), async (c) => {
    const body = c.req.valid("json");
    const baseUrl = normalizeOmlxRoot(body.url);
    const apiKey = body.api_key?.trim() || null;

    const existing = findOwnServerByUrl(baseUrl);
    if (existing) {
      return c.json({ code: "duplicate" as const, id: existing.id }, 409);
    }

    // Probe first and save only when it passes (section 5.3).
    let probe: Awaited<ReturnType<typeof probeServer>>;
    try {
      probe = await probeServer(baseUrl, apiKey);
    } catch (err) {
      if (err instanceof ServerProbeError) {
        return c.json({ error: err.code, message: err.message }, 502);
      }
      throw err;
    }

    const server = insertOwnServer({ baseUrl, apiKey, flavor: probe.flavor });
    return c.json(toView(server, probe), 201);
  })
  .delete("/:id", (c) => {
    deleteOwnServer(c.req.param("id"));
    return c.json({ ok: true });
  });

export default servers;
