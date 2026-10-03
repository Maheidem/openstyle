export const MLX_KEEP_ALIVE_DEFAULT_MINUTES = 10;
export const MLX_KEEP_ALIVE_MAX_MINUTES = 10;
// Sentinel meaning "always on" (never unload the model). Stored as -1.
export const MLX_KEEP_ALIVE_ALWAYS = -1;

/** Clamps a stored keep-alive value to 0..max minutes, or the "always" sentinel. */
export function clampMlxKeepAliveMinutes(value: number): number {
  if (!Number.isFinite(value)) return MLX_KEEP_ALIVE_DEFAULT_MINUTES;
  // Any negative value is the "always on" sentinel (never unload).
  if (Math.round(value) < 0) return MLX_KEEP_ALIVE_ALWAYS;
  return Math.min(Math.max(Math.round(value), 0), MLX_KEEP_ALIVE_MAX_MINUTES);
}
