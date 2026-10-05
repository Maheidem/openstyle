import { serverModelId } from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { jsonRequest } from "./helpers/http.js";

const app = createApp();

/** What oMLX answers on /v1/models/status (trimmed to the used fields). */
const OMLX_STATUS = {
  models: [
    {
      id: "Qwen3-ASR-1.7B-8bit",
      model_alias: "Qwen3-ASR",
      model_type: "audio_stt",
    },
    {
      id: "Qwen3.8-27B-AWQ-5.0bpw",
      model_alias: "Qwen3.8-27B",
      model_type: "vlm",
    },
  ],
};
const OMLX_MODELS = { data: [{ id: "Qwen3-ASR" }, { id: "Qwen3.8-27B" }] };

interface ServerBody {
  id: string;
  name: string;
  base_url: string;
  has_key: boolean;
  flavor: string;
  reachable: boolean;
  error?: string;
  models: Array<{ id: string; kind: string; kind_source: string }>;
}

/**
 * Answer `/v1/models` and `/v1/models/status` for any host. `omlx: false`
 * makes the status call answer 404, like a plain OpenAI-compatible server.
 */
function mockHosts(options: { omlx?: boolean; modelsStatus?: number } = {}) {
  const { omlx = true, modelsStatus = 200 } = options;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models/status")) {
        return omlx
          ? new Response(JSON.stringify(OMLX_STATUS), { status: 200 })
          : new Response("", { status: 404 });
      }
      if (url.endsWith("/v1/models")) {
        return modelsStatus === 200
          ? new Response(JSON.stringify(OMLX_MODELS), { status: 200 })
          : new Response("", { status: modelsStatus });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
}

const post = (body: unknown) => jsonRequest(app, "POST", "/api/servers", body);

async function list(): Promise<ServerBody[]> {
  const res = await app.request("/api/servers");
  expect(res.status).toBe(200);
  return (await res.json()) as ServerBody[];
}

beforeEach(() => {
  getDb().exec("DELETE FROM own_servers");
  getDb().exec("DELETE FROM model_configs");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/servers", () => {
  it("probes, saves and returns the server with its models (oMLX flavor)", async () => {
    mockHosts();

    const res = await post({ url: "http://localhost:8123/v1" });

    expect(res.status).toBe(201);
    const body = (await res.json()) as ServerBody;
    expect(body).toMatchObject({
      name: "oMLX (localhost:8123)",
      base_url: "http://localhost:8123",
      has_key: false,
      flavor: "omlx",
      reachable: true,
      models: [
        { id: "Qwen3-ASR", kind: "speech", kind_source: "server" },
        { id: "Qwen3.8-27B", kind: "llm", kind_source: "server" },
      ],
    });
    expect(body.id).toMatch(/^srv_[0-9a-f]{8}$/);
    expect(await list()).toHaveLength(1);
  });

  it("sets the OpenAI-compatible flavor when /v1/models/status is missing", async () => {
    mockHosts({ omlx: false });

    const res = await post({ url: "http://127.0.0.1:1234" });

    expect(res.status).toBe(201);
    const body = (await res.json()) as ServerBody;
    expect(body.flavor).toBe("openai");
    expect(body.name).toBe("OpenAI-compatible (127.0.0.1:1234)");
    expect(body.models.map((m) => m.kind_source)).toEqual(["name", "name"]);
  });

  it("sends the key to the probe and never returns it", async () => {
    const spy = mockHosts();

    const res = await post({
      url: "http://127.0.0.1:8123",
      api_key: "sk-super-secret",
    });

    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("sk-super-secret");
    expect(JSON.parse(text)).toMatchObject({ has_key: true });
    for (const call of spy.mock.calls) {
      expect((call[1] as RequestInit).headers).toEqual({
        Authorization: "Bearer sk-super-secret",
      });
    }
    // The key is stored, so the provider can use it.
    const stored = getDb().prepare("SELECT api_key FROM own_servers").get() as {
      api_key: string;
    };
    expect(stored.api_key).toBe("sk-super-secret");

    const listText = await (await app.request("/api/servers")).text();
    expect(listText).not.toContain("sk-super-secret");
    expect(JSON.parse(listText)[0]).toMatchObject({ has_key: true });
  });

  it("saves nothing when the probe gets 401", async () => {
    mockHosts({ modelsStatus: 401 });

    const res = await post({ url: "http://127.0.0.1:8123" });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
    expect(await list()).toEqual([]);
  });

  it("saves nothing when the address has no /v1/models (404)", async () => {
    mockHosts({ modelsStatus: 404 });

    const res = await post({ url: "http://127.0.0.1:8123" });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "not_openai" });
    expect(await list()).toEqual([]);
  });

  it("saves nothing when the server is not reachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );

    const res = await post({ url: "http://127.0.0.1:9" });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "unreachable" });
    expect(await list()).toEqual([]);
  });

  it("answers 409 with the id of the existing server for localhost against 127.0.0.1", async () => {
    mockHosts();
    const first = (await (
      await post({ url: "http://127.0.0.1:8123" })
    ).json()) as ServerBody;
    const spy = vi.mocked(globalThis.fetch);
    spy.mockClear();

    const res = await post({ url: "http://localhost:8123/v1/" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "duplicate", id: first.id });
    // The duplicate check needs no network call.
    expect(spy).not.toHaveBeenCalled();
    expect(await list()).toHaveLength(1);
  });

  it("treats http and https on one port as two servers", async () => {
    mockHosts();

    expect((await post({ url: "http://gw.test:8123" })).status).toBe(201);
    expect((await post({ url: "https://gw.test:8123" })).status).toBe(201);
    expect(await list()).toHaveLength(2);
  });

  it("treats two proxy paths on one host as two servers", async () => {
    mockHosts();

    expect((await post({ url: "https://gw.test/a/v1" })).status).toBe(201);
    expect((await post({ url: "https://gw.test/b/v1" })).status).toBe(201);
    expect(await list()).toHaveLength(2);
  });

  it.each([
    ["not-a-url"],
    ["ftp://example.com"],
    [""],
  ])("rejects the address %j with a 400", async (url) => {
    const res = await post({ url });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/servers", () => {
  it("returns an empty list with no server", async () => {
    expect(await list()).toEqual([]);
  });

  it("probes every server live, and marks an unreachable one", async () => {
    getDb()
      .prepare(
        "INSERT INTO own_servers (id, base_url, api_key, flavor, server_key) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "srv_up000000",
        "http://up.test:8123",
        null,
        "omlx",
        "http://up.test:8123",
      );
    getDb()
      .prepare(
        "INSERT INTO own_servers (id, base_url, api_key, flavor, server_key) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "srv_down0000",
        "http://down.test:8123",
        null,
        "openai",
        "http://down.test:8123",
      );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("http://down.test")) {
          throw new Error("connect ECONNREFUSED");
        }
        if (url.endsWith("/status")) {
          return new Response(JSON.stringify(OMLX_STATUS), { status: 200 });
        }
        return new Response(JSON.stringify(OMLX_MODELS), { status: 200 });
      },
    );

    const servers = await list();

    expect(servers).toHaveLength(2);
    const up = servers.find((s) => s.id === "srv_up000000");
    const down = servers.find((s) => s.id === "srv_down0000");
    expect(up).toMatchObject({ reachable: true, flavor: "omlx" });
    expect(up?.models).toHaveLength(2);
    expect(down).toMatchObject({
      reachable: false,
      error: "unreachable",
      flavor: "openai",
      models: [],
      name: "OpenAI-compatible (down.test:8123)",
    });
  });

  it("answers a 401 server with the unauthorized code", async () => {
    mockHosts({ modelsStatus: 401 });
    getDb()
      .prepare(
        "INSERT INTO own_servers (id, base_url, api_key, flavor, server_key) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "srv_lock0000",
        "http://lock.test",
        null,
        null,
        "http://lock.test:80",
      );

    const [server] = await list();

    expect(server).toMatchObject({ reachable: false, error: "unauthorized" });
  });

  it("updates the stored flavor when the live probe finds another one", async () => {
    getDb()
      .prepare(
        "INSERT INTO own_servers (id, base_url, api_key, flavor, server_key) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "srv_flav0000",
        "http://f.test:8123",
        null,
        "openai",
        "http://f.test:8123",
      );
    mockHosts({ omlx: true });

    await list();

    const row = getDb()
      .prepare("SELECT flavor FROM own_servers WHERE id = 'srv_flav0000'")
      .get() as { flavor: string };
    expect(row.flavor).toBe("omlx");
  });
});

describe("DELETE /api/servers/:id", () => {
  function seedConfig(modelId: string, provider: string, type: string): void {
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, ?, 0)",
      )
      .run(provider, modelId, modelId, type);
  }

  it("deletes the server and every model that points at it, and only those", async () => {
    mockHosts();
    const a = (await (
      await post({ url: "http://a.test:8123" })
    ).json()) as ServerBody;
    const b = (await (
      await post({ url: "http://b.test:8123" })
    ).json()) as ServerBody;
    seedConfig(serverModelId(a.id, "Qwen3-ASR"), "server", "voice");
    seedConfig(serverModelId(a.id, "qwen/qwen3-4b"), "server", "llm");
    seedConfig(serverModelId(b.id, "Qwen3-ASR"), "server", "voice");
    seedConfig("groq/whisper-large-v3", "groq", "voice");
    seedConfig("local-whisper/base", "local-whisper", "voice");

    const res = await app.request(`/api/servers/${a.id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await list()).map((s) => s.id)).toEqual([b.id]);
    const left = getDb()
      .prepare("SELECT model_id FROM model_configs ORDER BY id")
      .all() as Array<{ model_id: string }>;
    expect(left.map((r) => r.model_id)).toEqual([
      serverModelId(b.id, "Qwen3-ASR"),
      "groq/whisper-large-v3",
      "local-whisper/base",
    ]);
  });

  it("does not match another id by the LIKE wildcard", async () => {
    // "_" is a LIKE wildcard. "srv_a" must not match "srvXa/..." rows.
    getDb()
      .prepare(
        "INSERT INTO own_servers (id, base_url, api_key, flavor, server_key) VALUES ('srv_a', 'http://a.test', NULL, NULL, 'a')",
      )
      .run();
    seedConfig("server/srvXa/m", "server", "voice");

    await app.request("/api/servers/srv_a", { method: "DELETE" });

    const left = getDb()
      .prepare("SELECT model_id FROM model_configs")
      .all() as Array<{ model_id: string }>;
    expect(left.map((r) => r.model_id)).toEqual(["server/srvXa/m"]);
  });

  it("answers ok for an id that does not exist", async () => {
    const res = await app.request("/api/servers/srv_none0000", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
  });
});
