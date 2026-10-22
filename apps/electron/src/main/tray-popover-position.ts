/**
 * Where the tray popover goes. It has no Electron import, so a unit test can
 * check it.
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The space between the menu bar (or taskbar) and the popover. */
const GAP = 6;
/** The smallest space between the popover and the edge of the work area. */
const EDGE = 8;

/**
 * The top-left point of the popover. The popover is centered on the tray icon
 * (`anchor`) and goes below it, or above it when the icon is in the bottom half
 * of the display (a Windows taskbar). The result always stays inside
 * `workArea`. With no icon bounds (Linux, or a test with no tray), the popover
 * goes to the top-right corner of the work area.
 */
export function trayPopoverPosition(
  anchor: Rect | null,
  workArea: Rect,
  size: { width: number; height: number },
): { x: number; y: number } {
  const minX = workArea.x + EDGE;
  const maxX = workArea.x + workArea.width - size.width - EDGE;
  const minY = workArea.y + GAP;
  const maxY = workArea.y + workArea.height - size.height - EDGE;
  const clamp = (value: number, min: number, max: number): number =>
    Math.round(Math.max(min, Math.min(value, max)));

  if (!anchor || anchor.width === 0 || anchor.height === 0) {
    return { x: clamp(maxX, minX, maxX), y: clamp(minY, minY, maxY) };
  }

  const x = anchor.x + anchor.width / 2 - size.width / 2;
  const anchorMiddle = anchor.y + anchor.height / 2;
  const below = anchorMiddle < workArea.y + workArea.height / 2;
  const y = below
    ? anchor.y + anchor.height + GAP
    : anchor.y - size.height - GAP;
  return { x: clamp(x, minX, maxX), y: clamp(y, minY, maxY) };
}
