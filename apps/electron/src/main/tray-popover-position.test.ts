import { describe, expect, it } from "vitest";
import { trayPopoverPosition } from "./tray-popover-position";

const size = { width: 320, height: 400 };
// A 1512x982 display with a 33 px menu bar.
const workArea = { x: 0, y: 33, width: 1512, height: 949 };

describe("trayPopoverPosition", () => {
  it("centers the popover below the menu bar icon", () => {
    const icon = { x: 1200, y: 0, width: 30, height: 33 };
    expect(trayPopoverPosition(icon, workArea, size)).toEqual({
      x: 1055,
      y: 39,
    });
  });

  it("keeps the popover inside the right edge of the work area", () => {
    const icon = { x: 1480, y: 0, width: 30, height: 33 };
    expect(trayPopoverPosition(icon, workArea, size).x).toBe(1184);
  });

  it("uses the display of the icon on a second display at a negative x", () => {
    const left = { x: -1920, y: 25, width: 1920, height: 1055 };
    const icon = { x: -300, y: 0, width: 30, height: 25 };
    expect(trayPopoverPosition(icon, left, size)).toEqual({ x: -445, y: 31 });
  });

  it("goes above an icon in a bottom taskbar", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const icon = { x: 1700, y: 1044, width: 24, height: 32 };
    expect(trayPopoverPosition(icon, area, size)).toEqual({ x: 1552, y: 632 });
  });

  it("goes to the top-right corner when the icon has no bounds", () => {
    const icon = { x: 0, y: 0, width: 0, height: 0 };
    expect(trayPopoverPosition(icon, workArea, size)).toEqual({
      x: 1184,
      y: 39,
    });
    expect(trayPopoverPosition(null, workArea, size)).toEqual({
      x: 1184,
      y: 39,
    });
  });
});
