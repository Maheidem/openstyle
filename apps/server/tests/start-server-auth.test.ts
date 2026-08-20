import { afterEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/index.js";
import { startServer } from "../src/index.js";

// Exercises the real startServer() entrypoint end-to-end (a real bind + real
// HTTP requests), not just the authMiddleware/cors() pieces in isolation —
// this is what actually proves the token-generation + trusted-origin-fallback
// wiring in startServer() itself (index.ts) is correct, since every other
// test file drives createApp() directly and never calls startServer().
let running: RunningServer | undefined;

afterEach(async () => {
  if (!running) return;
  await new Promise<void>((resolve) => running?.server.close(() => resolve()));
  running = undefined;
});

describe("startServer() — loopback bind, no explicit token", () => {
  it("mints a strong random token and enables the trusted-origin fallback", async () => {
    running = await startServer({ host: "127.0.0.1", port: 0 });

    // 256 bits, hex-encoded.
    expect(running.token).toMatch(/^[0-9a-f]{64}$/);

    const base = `http://127.0.0.1:${running.port}`;

    const trusted = await fetch(`${base}/api/settings`, {
      headers: { origin: "app://renderer" },
    });
    expect(trusted.status).toBe(200);
    expect(trusted.headers.get("access-control-allow-origin")).toBe(
      "app://renderer",
    );

    const foreign = await fetch(`${base}/api/settings`, {
      headers: { origin: "https://evil.com" },
    });
    expect(foreign.status).toBe(401);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const bearer = await fetch(`${base}/api/settings`, {
      headers: { Authorization: `Bearer ${running.token}` },
    });
    expect(bearer.status).toBe(200);

    const neither = await fetch(`${base}/api/settings`, {
      headers: { origin: "https://evil.com" },
      // No token, foreign origin — must be refused even though the port is
      // reachable (loopback network access alone is not authorization).
    });
    expect(neither.status).toBe(401);
  });
});

describe("startServer() — loopback bind, explicit token supplied", () => {
  it("disables the trusted-origin fallback: bearer token only, full stop", async () => {
    running = await startServer({
      host: "127.0.0.1",
      port: 0,
      token: "a-fixed-explicit-token",
    });

    expect(running.token).toBe("a-fixed-explicit-token");

    const base = `http://127.0.0.1:${running.port}`;

    // Even a trusted app:// origin no longer gets in for free once an
    // operator has explicitly configured a token.
    const trustedNoToken = await fetch(`${base}/api/settings`, {
      headers: { origin: "app://renderer" },
    });
    expect(trustedNoToken.status).toBe(401);

    const withToken = await fetch(`${base}/api/settings`, {
      headers: { Authorization: "Bearer a-fixed-explicit-token" },
    });
    expect(withToken.status).toBe(200);
  });
});

describe("startServer() — loopback bind, no explicit token, tokenIsRetrievable", () => {
  it("disables the fallback for a caller that can hand the token to its operator (startup.ts's shape)", async () => {
    running = await startServer({
      host: "127.0.0.1",
      port: 0,
      tokenIsRetrievable: true,
    });

    expect(running.token).toMatch(/^[0-9a-f]{64}$/);

    const base = `http://127.0.0.1:${running.port}`;

    // Unlike the plain loopback-no-token case above, a trusted origin alone
    // is not enough — this caller (startup.ts) prints the token to its own
    // log, so the fallback that exists only for Electron's lack of a channel
    // does not apply here.
    const trustedNoToken = await fetch(`${base}/api/settings`, {
      headers: { origin: "app://renderer" },
    });
    expect(trustedNoToken.status).toBe(401);

    const withToken = await fetch(`${base}/api/settings`, {
      headers: { Authorization: `Bearer ${running.token}` },
    });
    expect(withToken.status).toBe(200);
  });
});

describe("startServer() — non-loopback bind, no explicit token", () => {
  it("still mints a token but disables the trusted-origin fallback", async () => {
    running = await startServer({ host: "0.0.0.0", port: 0 });

    expect(running.token).toMatch(/^[0-9a-f]{64}$/);

    const base = `http://127.0.0.1:${running.port}`;

    // A non-loopback bind never gets the origin exemption, auto-generated
    // token or not.
    const trustedNoToken = await fetch(`${base}/api/settings`, {
      headers: { origin: "app://renderer" },
    });
    expect(trustedNoToken.status).toBe(401);

    const withToken = await fetch(`${base}/api/settings`, {
      headers: { Authorization: `Bearer ${running.token}` },
    });
    expect(withToken.status).toBe(200);
  });
});
