import { afterEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";

const app = createApp();

const REDACTED = "••••••••";

function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function getStoredSetting(key: string): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function put(path: string, body: unknown) {
  return app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function clearSettings(...keys: string[]): void {
  const db = getDb();
  for (const key of keys) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}

describe("GET /api/settings redacts credential-shaped values", () => {
  afterEach(() => {
    clearSettings(
      "omlx_api_key",
      "local_llm_api_key",
      "openai_stt_api_key",
      "hotkey",
    );
  });

  it("masks a credential-shaped key's value in the bulk listing", async () => {
    setSetting("omlx_api_key", "sk-real-secret-value");

    const res = await app.request("/api/settings");
    const data = (await res.json()) as Record<string, string>;

    expect(data.omlx_api_key).toBe(REDACTED);
  });

  it("masks every known BYOK credential key", async () => {
    setSetting("local_llm_api_key", "sk-local-llm-secret");
    setSetting("openai_stt_api_key", "sk-openai-stt-secret");

    const res = await app.request("/api/settings");
    const data = (await res.json()) as Record<string, string>;

    expect(data.local_llm_api_key).toBe(REDACTED);
    expect(data.openai_stt_api_key).toBe(REDACTED);
  });

  it("does not mask hotkey — 'key' is a substring there, not a delimited segment", async () => {
    setSetting("hotkey", "F13");

    const res = await app.request("/api/settings");
    const data = (await res.json()) as Record<string, string>;

    expect(data.hotkey).toBe("F13");
  });

  it("leaves GET /api/settings/:key (the deliberate reveal path) unredacted", async () => {
    setSetting("local_llm_api_key", "sk-another-real-secret");

    const res = await app.request("/api/settings/local_llm_api_key");
    const data = (await res.json()) as { key: string; value: string };

    expect(data.value).toBe("sk-another-real-secret");
  });
});

describe("PUT /api/settings/:key sentinel guard on credential keys", () => {
  afterEach(() => {
    clearSettings("omlx_api_key", "hotkey");
  });

  it("stores a real credential value and echoes the response masked", async () => {
    const res = await put("/api/settings/omlx_api_key", {
      value: "sk-brand-new",
    });
    const body = (await res.json()) as { key: string; value: string };

    expect(res.status).toBe(200);
    expect(body.value).toBe(REDACTED);
    expect(getStoredSetting("omlx_api_key")).toBe("sk-brand-new");
  });

  it("treats a re-submitted placeholder as a no-op, preserving the real stored value", async () => {
    setSetting("omlx_api_key", "sk-original-value");

    const res = await put("/api/settings/omlx_api_key", { value: REDACTED });
    const body = (await res.json()) as { key: string; value: string };

    expect(res.status).toBe(200);
    expect(body.value).toBe(REDACTED);
    // Not overwritten with the literal placeholder text.
    expect(getStoredSetting("omlx_api_key")).toBe("sk-original-value");
  });

  it("a non-credential key is unaffected by the sentinel guard", async () => {
    const res = await put("/api/settings/hotkey", { value: "F14" });

    expect(res.status).toBe(200);
    expect(getStoredSetting("hotkey")).toBe("F14");
  });
});

describe("POST /api/settings/omlx/test resolves a re-submitted placeholder to the real key", () => {
  afterEach(() => {
    clearSettings("omlx_api_key");
    vi.restoreAllMocks();
  });

  function okResponse(): Response {
    return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("sends the real stored key, not the literal placeholder, when the field was untouched", async () => {
    setSetting("omlx_api_key", "sk-stored-real-key");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse());

    const res = await app.request("/api/settings/omlx/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:8123", api_key: REDACTED }),
    });

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-stored-real-key",
    );
  });

  it("sends a freshly typed key as-is rather than the stored one", async () => {
    setSetting("omlx_api_key", "sk-stored-real-key");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse());

    await app.request("/api/settings/omlx/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "http://127.0.0.1:8123",
        api_key: "sk-freshly-typed",
      }),
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-freshly-typed",
    );
  });
});
