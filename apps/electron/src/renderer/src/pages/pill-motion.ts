// Size and timing constants that the pill code and the pill CSS share.
// Keep them here so the JS timers and the CSS animations use the same values.

/** Peak bar height. Kept well under PILL_HEIGHT so the waveform never
 * crowds the capsule's edge, even at full volume. */
export const SVG_HEIGHT = 14;

export const CHECK_PATH_LENGTH = 11.7;
export const CLOSE_DUR_MS = 110;
export const CHECK_AT_MS = 90;
export const CHECK_DRAW_MS = 150;
const CHECK_HOLD_MS = 320;
export const CHECK_LEAVE_AT_MS = CHECK_AT_MS + CHECK_DRAW_MS + CHECK_HOLD_MS;
const CHECK_LEAVE_MS = 110;
export const DELIVERED_TOTAL_MS = CHECK_LEAVE_AT_MS + CHECK_LEAVE_MS;
export const CANCELLED_MS = 140;
export const QUIET_MS = 120;

export const CANCEL_SIZE = 16;

/**
 * Status sits at the other end of the capsule, in a mark the same size as the
 * cancel one — a spinner while something is still working, an alert once it
 * isn't. The distinction between the two ends is action (left) vs state
 * (right), which is also why this one is a circular silhouette rather than a
 * bare glyph. The slot is the mark plus the gap to the capsule's edge.
 */
export const STATUS_GAP = 6;
export const STATUS_SLOT = CANCEL_SIZE + STATUS_GAP;

/** Cream ink, unchanged by the reskin — the design system's pill-dark/
 * pill-cream pair for this always-dark capsule already matches this value. */
export const INK = "#F5F1E4";

// No drop shadow: the capsule and cards sit flush on whatever is behind
// them, separated by their hairline border alone.
export const PILL_SHADOW = "none";
