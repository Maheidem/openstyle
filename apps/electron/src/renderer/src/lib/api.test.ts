import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The port of the installed app. A renderer of another app (Openstyle Dev, a
// test app) must never send a request to it.
const INSTALLED_APP_PORT = 4649;
const OWN_PORT = 4711;

type Api = typeof import("./api");

let fetchUrls: string[];

function stubWindow(getServerPort: () => Promise<number>): void {
  vi.stubGlobal("window", {
    api: {
      getServerUrl: async () => "",
      getServerToken: async () => "",
      getServerPort,
    },
  });
}

async function loadApi(): Promise<Api> {
  vi.resetModules();
  return import("./api");
}

beforeEach(() => {
  fetchUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      fetchUrls.push(input instanceof Request ? input.url : String(input));
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderer API base", () => {
  it("holds a request made before main gives the port, then sends it to the own port", async () => {
    let answerPort: (port: number) => void = () => {};
    stubWindow(
      () =>
        new Promise<number>((resolve) => {
          answerPort = resolve;
        }),
    );
    const api = await loadApi();

    const request = api.getClient().api.settings.$get();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchUrls).toEqual([]);

    answerPort(OWN_PORT);
    const res = await request;

    expect(res.ok).toBe(true);
    expect(fetchUrls).toContain(`http://127.0.0.1:${OWN_PORT}/api/settings`);
    expect(
      fetchUrls.some((url) => url.includes(`:${INSTALLED_APP_PORT}`)),
    ).toBe(false);
  });

  it("fails a request when the port lookup fails, and tries the lookup again on the next request", async () => {
    const getServerPort = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("The server port is not known yet"))
      .mockResolvedValue(OWN_PORT);
    stubWindow(getServerPort);
    const api = await loadApi();

    await expect(api.apiFetch("/api/history")).rejects.toThrow();
    expect(fetchUrls).toEqual([]);
    expect(api.hasApiBase()).toBe(false);
    expect(() => api.getApiBase()).toThrow();

    const res = await api.getClient().api.settings.$get();

    expect(res.ok).toBe(true);
    expect(getServerPort).toHaveBeenCalledTimes(2);
    expect(api.getApiBase()).toBe(`http://127.0.0.1:${OWN_PORT}`);
    expect(
      fetchUrls.some((url) => url.includes(`:${INSTALLED_APP_PORT}`)),
    ).toBe(false);
  });
});
