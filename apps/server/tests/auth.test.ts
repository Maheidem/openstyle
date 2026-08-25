import { afterEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { setAuthToken } from "../src/lib/auth.js";

// authMiddleware is wired directly into createApp(), so no token = open server.
const app = createApp();

const TOKEN = "test-secret";

afterEach(() => {
  // Reset so other suites (and cases) run unauthenticated.
  setAuthToken("");
});

describe("Bearer auth", () => {
  it("is disabled by default (no token configured)", async () => {
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
  });

  it("leaves /api/health open even when a token is set", async () => {
    setAuthToken(TOKEN);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  it("rejects requests without a token", async () => {
    setAuthToken(TOKEN);
    const res = await app.request("/api/settings");
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    setAuthToken(TOKEN);
    const res = await app.request("/api/settings", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests with the correct token", async () => {
    setAuthToken(TOKEN);
    const res = await app.request("/api/settings", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a websocket upgrade with the wrong ?token=", async () => {
    setAuthToken(TOKEN);
    const res = await app.request("/stream?token=wrong", {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a websocket upgrade with the correct ?token=", async () => {
    setAuthToken(TOKEN);
    const res = await app.request(`/stream?token=${TOKEN}`, {
      headers: { upgrade: "websocket" },
    });
    // Not 401 — the auth gate passed (the upgrade itself may still fail later).
    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Trusted-origin fallback — the loopback-embedded-server scheme startServer()
// enables (see index.ts) so the Electron desktop app, which has no channel
// today to receive a freshly-minted per-boot token, keeps working even though
// auth is now always on. These tests drive the fallback directly via
// setAuthToken's second argument, the same way startServer() does.
// ---------------------------------------------------------------------------

describe("Bearer auth — trusted-origin fallback (loopback embedded server)", () => {
  it("rejects an unauthenticated request when the fallback is off (default)", async () => {
    setAuthToken(TOKEN);
    const res = await app.request("/api/settings", {
      headers: { origin: "app://renderer" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a trusted app:// origin with no token when the fallback is on", async () => {
    setAuthToken(TOKEN, { allowTrustedOriginFallback: true });
    const res = await app.request("/api/settings", {
      headers: { origin: "app://renderer" },
    });
    expect(res.status).toBe(200);
  });

  it("accepts a trusted loopback dev-server origin with no token when the fallback is on", async () => {
    setAuthToken(TOKEN, { allowTrustedOriginFallback: true });
    const res = await app.request("/api/settings", {
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
  });

  it("accepts a request with no Origin header when the fallback is on (Electron main process)", async () => {
    setAuthToken(TOKEN, { allowTrustedOriginFallback: true });
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
  });

  it("still rejects a foreign origin with no token even when the fallback is on", async () => {
    setAuthToken(TOKEN, { allowTrustedOriginFallback: true });
    const res = await app.request("/api/settings", {
      headers: { origin: "https://evil.com" },
    });
    expect(res.status).toBe(401);
  });

  it("still accepts the real bearer token when the fallback is on and the origin is untrusted", async () => {
    setAuthToken(TOKEN, { allowTrustedOriginFallback: true });
    const res = await app.request("/api/settings", {
      headers: {
        origin: "https://evil.com",
        Authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("a later setAuthToken() call without the option resets the fallback off", async () => {
    setAuthToken(TOKEN, { allowTrustedOriginFallback: true });
    setAuthToken(TOKEN);
    const res = await app.request("/api/settings", {
      headers: { origin: "app://renderer" },
    });
    expect(res.status).toBe(401);
  });

  it("exempts a websocket upgrade from a trusted origin with no ?token= when the fallback is on", async () => {
    setAuthToken(TOKEN, { allowTrustedOriginFallback: true });
    const res = await app.request("/stream", {
      headers: { upgrade: "websocket", origin: "app://renderer" },
    });
    expect(res.status).not.toBe(401);
  });
});
