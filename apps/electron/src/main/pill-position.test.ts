import { describe, expect, it } from "vitest";
import {
  APP_HEIGHT,
  APP_WIDTH,
  type PillDisplay,
  type PillRect,
  presetPositionForDisplay,
  resolveCustomPosition,
} from "./pill-position";

function display(id: number, x: number, y: number, w: number, h: number) {
  const rect: PillRect = { x, y, width: w, height: h };
  return { id, bounds: rect, workArea: rect } satisfies PillDisplay;
}

const main = display(1, 0, 0, 1000, 800);
const side = display(2, 1000, 0, 2000, 1000);

describe("presetPositionForDisplay", () => {
  it("places the preset slots on macOS", () => {
    const at = (p: string) => presetPositionForDisplay(main, p, "darwin");
    expect(at("top-center")).toEqual({ x: 420, y: 0 });
    expect(at("top-right")).toEqual({ x: 840, y: 0 });
    expect(at("bottom-right")).toEqual({ x: 840, y: 800 - APP_HEIGHT - 8 });
    expect(at("bottom-center")).toEqual({ x: 420, y: 800 - APP_HEIGHT - 8 });
  });

  it("uses the bottom-center slot for an unknown preset", () => {
    expect(presetPositionForDisplay(main, "nonsense", "darwin")).toEqual(
      presetPositionForDisplay(main, "bottom-center", "darwin"),
    );
  });

  it("overlaps a taskbar on other platforms", () => {
    const withBar = {
      id: 3,
      bounds: { x: 0, y: 0, width: 1000, height: 840 },
      workArea: { x: 0, y: 0, width: 1000, height: 800 },
    };
    expect(presetPositionForDisplay(withBar, "bottom-center", "win32").y).toBe(
      800 - APP_HEIGHT + 14,
    );
    expect(presetPositionForDisplay(main, "bottom-center", "win32").y).toBe(
      800 - APP_HEIGHT - 8,
    );
  });
});

describe("resolveCustomPosition", () => {
  const matching = (rect: PillRect) => (rect.x >= 1000 ? side : main);

  it("keeps the slot when it is on the active display", () => {
    expect(
      resolveCustomPosition({ x: 100, y: 200 }, main, matching, "darwin"),
    ).toEqual({ pos: { x: 100, y: 200 }, offscreen: false });
  });

  it("carries the fractional position to another display", () => {
    // Slot at the right edge and the vertical middle of the main display.
    const custom = { x: 1000 - APP_WIDTH, y: (800 - APP_HEIGHT) / 2 };
    expect(resolveCustomPosition(custom, side, matching, "darwin")).toEqual({
      pos: {
        x: 1000 + 2000 - APP_WIDTH,
        y: Math.round((1000 - APP_HEIGHT) / 2),
      },
      offscreen: false,
    });
  });

  it("reports an off-screen slot and uses the default preset", () => {
    expect(
      resolveCustomPosition({ x: 5000, y: 10 }, main, () => main, "darwin"),
    ).toEqual({
      pos: presetPositionForDisplay(main, "bottom-center", "darwin"),
      offscreen: true,
    });
  });

  it("uses the default preset without a reset for a missing slot", () => {
    const expected = presetPositionForDisplay(main, "bottom-center", "darwin");
    expect(resolveCustomPosition(undefined, main, matching, "darwin")).toEqual({
      pos: expected,
      offscreen: false,
    });
    expect(
      resolveCustomPosition(
        { x: "1" as unknown as number, y: 2 },
        main,
        matching,
        "darwin",
      ),
    ).toEqual({ pos: expected, offscreen: false });
  });
});
