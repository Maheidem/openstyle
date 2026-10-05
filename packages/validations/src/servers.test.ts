import { describe, expect, it } from "vitest";
import {
  addServerSchema,
  parseServerModelId,
  serverKey,
  serverModelId,
} from "./servers.js";

describe("serverKey", () => {
  it("folds localhost, 127.0.0.1 and [::1] to one host", () => {
    const key = serverKey("http://127.0.0.1:8123");
    expect(serverKey("http://localhost:8123")).toBe(key);
    expect(serverKey("http://[::1]:8123")).toBe(key);
  });

  it("ignores /v1, trailing slashes and case", () => {
    const key = serverKey("http://127.0.0.1:8123");
    expect(serverKey("http://127.0.0.1:8123/v1")).toBe(key);
    expect(serverKey("  http://127.0.0.1:8123/v1/  ")).toBe(key);
    expect(serverKey("HTTP://LocalHost:8123/v1")).toBe(key);
    expect(serverKey("http://127.0.0.1:8123/v1/audio/transcriptions")).toBe(
      key,
    );
  });

  it("gives a missing port the default port of the scheme", () => {
    expect(serverKey("https://engine")).toBe(serverKey("https://engine:443"));
    expect(serverKey("http://engine")).toBe(serverKey("http://engine:80"));
    expect(serverKey("http://engine")).not.toBe(serverKey("https://engine"));
  });

  it("keeps http and https on one port apart", () => {
    expect(serverKey("http://h:8123")).not.toBe(serverKey("https://h:8123"));
  });

  it("keeps two proxy paths on one host apart", () => {
    expect(serverKey("https://gw/a/v1")).not.toBe(serverKey("https://gw/b/v1"));
    expect(serverKey("https://gw/a/v1")).toBe(serverKey("https://gw/a"));
  });

  it("does not throw on an address that does not parse", () => {
    expect(serverKey("Not A Url")).toBe("not a url");
  });
});

describe("server model ids", () => {
  it("builds and parses an id", () => {
    const id = serverModelId("srv_0a1b2c3d", "Qwen3-ASR");
    expect(id).toBe("server/srv_0a1b2c3d/Qwen3-ASR");
    expect(parseServerModelId(id)).toEqual({
      serverId: "srv_0a1b2c3d",
      model: "Qwen3-ASR",
    });
  });

  it("keeps every slash after the server id inside the model id", () => {
    expect(parseServerModelId("server/srv_0a1b2c3d/qwen/qwen3-4b")).toEqual({
      serverId: "srv_0a1b2c3d",
      model: "qwen/qwen3-4b",
    });
  });

  it("parses an id that the provider prefix was already stripped from", () => {
    expect(parseServerModelId("srv_0a1b2c3d/qwen/qwen3-4b")).toEqual({
      serverId: "srv_0a1b2c3d",
      model: "qwen/qwen3-4b",
    });
  });

  it.each([
    [""],
    ["Qwen3-ASR"],
    ["server/"],
    ["server/srv_0a1b2c3d"],
    ["server/srv_0a1b2c3d/"],
    ["server//model"],
  ])("returns null for %j", (id) => {
    expect(parseServerModelId(id)).toBeNull();
  });
});

describe("addServerSchema", () => {
  it("accepts an http or https address and an optional key", () => {
    expect(
      addServerSchema.safeParse({ url: "http://127.0.0.1:8123" }).success,
    ).toBe(true);
    expect(
      addServerSchema.safeParse({ url: "https://gw.test/v1", api_key: "k" })
        .success,
    ).toBe(true);
  });

  it.each([
    [""],
    ["not-a-url"],
    ["127.0.0.1:8123"],
    ["ftp://example.com"],
  ])("rejects %j", (url) => {
    expect(addServerSchema.safeParse({ url }).success).toBe(false);
  });
});
