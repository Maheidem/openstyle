import { describe, expect, it } from "vitest";
import {
  parsePluginsSetting,
  pluginEntryParts,
  pluginEntrySchema,
} from "./plugins.js";

describe("pluginEntrySchema", () => {
  it("accepts a bare local/npm specifier", () => {
    expect(pluginEntrySchema.safeParse("my-plugin").success).toBe(true);
    expect(pluginEntrySchema.safeParse("@scope/my-plugin").success).toBe(true);
    expect(
      pluginEntrySchema.safeParse("/Users/me/plugins/local.js").success,
    ).toBe(true);
  });

  it("accepts a [specifier, options] tuple", () => {
    const result = pluginEntrySchema.safeParse(["my-plugin", { foo: "bar" }]);
    expect(result.success).toBe(true);
  });

  it("rejects an http(s):// specifier", () => {
    const http = pluginEntrySchema.safeParse(
      "http://evil.example.com/payload.js",
    );
    expect(http.success).toBe(false);

    const https = pluginEntrySchema.safeParse(
      "https://evil.example.com/payload.js",
    );
    expect(https.success).toBe(false);
  });

  it("rejects a remote specifier inside the tuple form", () => {
    const result = pluginEntrySchema.safeParse([
      "https://evil.example.com/payload.js",
      { foo: "bar" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects other URL schemes, not just http(s)", () => {
    expect(
      pluginEntrySchema.safeParse("data:text/javascript,alert(1)").success,
    ).toBe(false);
    expect(pluginEntrySchema.safeParse("file:///etc/passwd").success).toBe(
      false,
    );
    expect(pluginEntrySchema.safeParse("node:child_process").success).toBe(
      false,
    );
  });

  it("rejects an empty string", () => {
    expect(pluginEntrySchema.safeParse("").success).toBe(false);
  });
});

describe("parsePluginsSetting", () => {
  it("returns [] for missing/empty/malformed JSON", () => {
    expect(parsePluginsSetting(null)).toEqual([]);
    expect(parsePluginsSetting(undefined)).toEqual([]);
    expect(parsePluginsSetting("")).toEqual([]);
    expect(parsePluginsSetting("not json")).toEqual([]);
    expect(parsePluginsSetting('{"not":"an array"}')).toEqual([]);
  });

  it("parses a list of valid entries", () => {
    const value = JSON.stringify([
      "my-plugin",
      ["other-plugin", { enabled: true }],
    ]);
    expect(parsePluginsSetting(value)).toEqual([
      "my-plugin",
      ["other-plugin", { enabled: true }],
    ]);
  });

  it("drops a remote-URL entry but keeps the other valid entries in the list", () => {
    // This is the load-bearing case: a single bad/legacy entry (e.g. one
    // written before this validation existed) must not wipe out every other
    // plugin the user has configured on next app startup.
    const value = JSON.stringify([
      "good-plugin-one",
      "http://evil.example.com/payload.js",
      "good-plugin-two",
    ]);
    expect(parsePluginsSetting(value)).toEqual([
      "good-plugin-one",
      "good-plugin-two",
    ]);
  });

  it("returns [] when every entry is invalid", () => {
    const value = JSON.stringify(["http://evil.example.com/payload.js", ""]);
    expect(parsePluginsSetting(value)).toEqual([]);
  });
});

describe("pluginEntryParts", () => {
  it("normalizes a bare string entry", () => {
    expect(pluginEntryParts("my-plugin")).toEqual({ specifier: "my-plugin" });
  });

  it("normalizes a tuple entry", () => {
    expect(pluginEntryParts(["my-plugin", { foo: "bar" }])).toEqual({
      specifier: "my-plugin",
      options: { foo: "bar" },
    });
  });
});
