import { describe, expect, it } from "vitest";
import {
  clampMlxKeepAliveMinutes,
  MLX_KEEP_ALIVE_ALWAYS,
  MLX_KEEP_ALIVE_DEFAULT_MINUTES,
  MLX_KEEP_ALIVE_MAX_MINUTES,
} from "./mlx-keep-alive.js";

describe("clampMlxKeepAliveMinutes", () => {
  it("returns the default for a value that is not finite", () => {
    expect(clampMlxKeepAliveMinutes(Number.NaN)).toBe(
      MLX_KEEP_ALIVE_DEFAULT_MINUTES,
    );
    expect(clampMlxKeepAliveMinutes(Number.POSITIVE_INFINITY)).toBe(
      MLX_KEEP_ALIVE_DEFAULT_MINUTES,
    );
  });

  it("maps any negative value to the always sentinel", () => {
    expect(clampMlxKeepAliveMinutes(-1)).toBe(MLX_KEEP_ALIVE_ALWAYS);
    expect(clampMlxKeepAliveMinutes(-30)).toBe(MLX_KEEP_ALIVE_ALWAYS);
  });

  it("rounds and caps the value at the maximum", () => {
    expect(clampMlxKeepAliveMinutes(0)).toBe(0);
    expect(clampMlxKeepAliveMinutes(4.6)).toBe(5);
    expect(clampMlxKeepAliveMinutes(500)).toBe(MLX_KEEP_ALIVE_MAX_MINUTES);
  });
});
