import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: {}, app: { getPath: () => "/unused" } }));
vi.mock("./local-settings", () => ({ readSettings: () => ({}) }));

type ServerTarget = typeof import("./server-target");

let target: ServerTarget;

beforeEach(async () => {
  vi.resetModules();
  target = await import("./server-target");
});

describe("getServerPort", () => {
  it("waits until the boot code sets the port, and never answers with the default port first", async () => {
    let answer: number | undefined;
    const port = target.getServerPort().then((value) => {
      answer = value;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answer).toBeUndefined();

    target.setServerPort(4659);

    await expect(port).resolves.toBe(4659);
    await expect(target.getServerPort()).resolves.toBe(4659);
  });

  it("rejects when the port stays unknown, so that the renderer tries again", async () => {
    await expect(target.getServerPort(5)).rejects.toThrow(
      "The server port is not known yet",
    );
  });
});
