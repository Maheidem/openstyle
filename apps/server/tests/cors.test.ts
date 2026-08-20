import { afterEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { setAuthToken } from "../src/lib/auth.js";

// createApp() alone (no startServer()) leaves auth off — see auth.test.ts —
// so these requests exercise CORS in isolation without a token in the way.
const app = createApp();

describe("CORS allowlist", () => {
  it("does not set Access-Control-Allow-Origin for a foreign origin", async () => {
    const res = await app.request("/api/settings", {
      headers: { origin: "https://evil.com" },
    });
    expect(res.status).toBe(200); // the request itself still reaches the app...
    // ...but a browser can't read it: no header means no read access.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not set Access-Control-Allow-Origin for a foreign origin on a preflight", async () => {
    const res = await app.request("/api/settings/foo", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.com",
        "Access-Control-Request-Method": "PUT",
      },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("echoes back the packaged app's app:// origin", async () => {
    const res = await app.request("/api/settings", {
      headers: { origin: "app://renderer" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "app://renderer",
    );
  });

  it("echoes back a loopback http origin (e.g. the Vite dev server) regardless of port", async () => {
    const res = await app.request("/api/settings", {
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
  });

  it("echoes back a 127.0.0.1 origin", async () => {
    const res = await app.request("/api/settings", {
      headers: { origin: "http://127.0.0.1:4649" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://127.0.0.1:4649",
    );
  });

  it("sets no CORS header at all for a same-origin request with no Origin header", async () => {
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("CORS allowlist on the error path (onError / HTTPException)", () => {
  // bearerAuth's 401 (and any other HTTPException) is thrown, not returned,
  // so it's handled by onError rather than the normal cors() middleware
  // return path — that handler has its own, separate origin check to keep in
  // sync. See index.ts's onError.
  afterEach(() => {
    setAuthToken("");
  });

  it("does not echo a foreign origin back on a 401 error response", async () => {
    setAuthToken("secret-token");
    const res = await app.request("/api/settings", {
      headers: { origin: "https://evil.com" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("still echoes a trusted origin back on a 401 error response", async () => {
    setAuthToken("secret-token");
    const res = await app.request("/api/settings", {
      headers: { origin: "app://renderer" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "app://renderer",
    );
  });
});
