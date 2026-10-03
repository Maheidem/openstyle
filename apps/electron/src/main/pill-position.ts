/**
 * Pure pill slot math. This file has no Electron import, so vitest can load
 * it. The display types below are structural: an Electron `Display` fits them.
 */

/**
 * The pill's own slot: every position in the main process is computed against
 * these dimensions, whatever size the window currently is.
 */
export const APP_WIDTH = 160;
export const APP_HEIGHT = 60;

export interface PillRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PillDisplay {
  id: number;
  bounds: PillRect;
  workArea: PillRect;
}

export interface PillPoint {
  x: number;
  y: number;
}

// Computes a preset pill slot for a specific display. The pill is aligned
// inside the window via CSS (justify-center or justify-end).
export function presetPositionForDisplay(
  display: PillDisplay,
  position: string,
  platform: string = process.platform,
): PillPoint {
  const { x: waX, y: waY, width, height } = display.workArea;
  const bottomInset = Math.max(
    0,
    display.bounds.y + display.bounds.height - (waY + height),
  );
  const overlap = platform !== "darwin" && bottomInset > 0 ? 14 : -8;
  const centerX = waX + Math.round((width - APP_WIDTH) / 2);
  const rightX = waX + width - APP_WIDTH;
  const bottomY = waY + height - APP_HEIGHT + overlap;

  switch (position) {
    case "top-center":
      return { x: centerX, y: waY };
    case "top-right":
      return { x: rightX, y: waY };
    case "bottom-right":
      return { x: rightX, y: bottomY };
    default:
      return { x: centerX, y: bottomY };
  }
}

/**
 * Resolves a saved custom slot. `offscreen` is true when the saved slot lies
 * outside its display. The caller must then reset the saved position. A
 * missing or non-numeric slot uses the default preset and is not offscreen.
 */
export function resolveCustomPosition(
  custom: Partial<PillPoint> | undefined,
  activeDisplay: PillDisplay,
  displayMatching: (rect: PillRect) => PillDisplay,
  platform: string = process.platform,
): { pos: PillPoint; offscreen: boolean } {
  const fallback = presetPositionForDisplay(
    activeDisplay,
    "bottom-center",
    platform,
  );
  if (!custom || typeof custom.x !== "number" || typeof custom.y !== "number") {
    return { pos: fallback, offscreen: false };
  }
  const { x: cx, y: cy } = custom;
  const display = displayMatching({
    x: cx,
    y: cy,
    width: APP_WIDTH,
    height: APP_HEIGHT,
  });
  const wa = display.workArea;
  if (
    !(
      cx >= wa.x &&
      cx + APP_WIDTH <= wa.x + wa.width &&
      cy >= wa.y &&
      cy <= wa.y + wa.height
    )
  ) {
    return { pos: fallback, offscreen: true };
  }
  // A custom slot is the user's *offset*, not an absolute point on one
  // monitor: when the cursor is on a different display, carry the same
  // fractional position over so the pill follows them there.
  if (display.id === activeDisplay.id) {
    return { pos: { x: cx, y: cy }, offscreen: false };
  }
  const activeWa = activeDisplay.workArea;
  const fx = wa.width > APP_WIDTH ? (cx - wa.x) / (wa.width - APP_WIDTH) : 0.5;
  const fy =
    wa.height > APP_HEIGHT ? (cy - wa.y) / (wa.height - APP_HEIGHT) : 1;
  return {
    pos: {
      x: Math.round(
        activeWa.x +
          Math.min(1, Math.max(0, fx)) * (activeWa.width - APP_WIDTH),
      ),
      y: Math.round(
        activeWa.y +
          Math.min(1, Math.max(0, fy)) * (activeWa.height - APP_HEIGHT),
      ),
    },
    offscreen: false,
  };
}
