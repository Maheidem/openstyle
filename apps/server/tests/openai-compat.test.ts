import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelIds } from "../src/lib/openai-compat.js";

function stubFetch(make: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => make());
}

describe("fetchModelIds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the ids from data.data", async () => {
    stubFetch(() => Response.json({ data: [{ id: "a" }, { id: "b" }] }));

    await expect(fetchModelIds("http://x/v1/models")).resolves.toEqual([
      "a",
      "b",
    ]);
  });

  it("sends the Bearer header only when an api key is set", async () => {
    const spy = stubFetch(() => Response.json({ data: [] }));

    await fetchModelIds("http://x/v1/models", "secret");
    await fetchModelIds("http://x/v1/models");

    expect(spy.mock.calls[0][1]?.headers).toEqual({
      Authorization: "Bearer secret",
    });
    expect(spy.mock.calls[1][1]?.headers).toEqual({});
  });

  it("returns an empty list when data.data is not an array", async () => {
    stubFetch(() => Response.json({ data: "nope" }));

    await expect(fetchModelIds("http://x/v1/models")).resolves.toEqual([]);
  });

  it("throws the status and status text on a non-ok reply", async () => {
    stubFetch(
      () => new Response("", { status: 401, statusText: "Unauthorized" }),
    );

    await expect(fetchModelIds("http://x/v1/models")).rejects.toThrow(
      "Server returned 401: Unauthorized",
    );
  });

  it("passes a timeout signal to fetch", async () => {
    const spy = stubFetch(() => Response.json({ data: [] }));

    await fetchModelIds("http://x/v1/models", undefined, 1234);

    expect(spy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
