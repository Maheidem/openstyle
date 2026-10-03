// Pure waveform maths for the pill. No React and no DOM, so it is easy to test.

/**
 * Response curve for the recording waveform, applied to the raw voice level.
 *
 * `getByteFrequencyData` is already dB-scaled, and the old mapping (a linear
 * gain with a hard clamp) ran straight into its ceiling: anything above a
 * soft voice pinned every bar to full height, which both looked cramped
 * against the capsule and threw away all the dynamics.
 *
 * These drive a saturating exponential instead — steep at the bottom so a
 * whisper already reaches roughly half height, then flattening toward
 * BAR_CEILING, which no amount of volume quite reaches.
 *
 * BAR_NOISE_FLOOR is subtracted first so room tone still renders as the
 * resting dots rather than a permanent low ripple. It and BAR_GAIN are the
 * two worth re-tuning against a real mic.
 */
export const BAR_NOISE_FLOOR = 0.05;
const BAR_GAIN = 8;
const BAR_CEILING = 0.82;

/**
 * Random spread that gives the waveform texture instead of a flat plateau
 * while you talk. Two components, because one alone doesn't cover the range:
 *
 * `scale` multiplies the level *before* the response curve. An upward kick is
 * compressed by the saturation rather than clipping flat against the ceiling,
 * and the effect scales with loudness for free — a jittered room tone still
 * lands under the resting-dot threshold, so silence stays still. But the same
 * saturation flattens it out again once you're loud.
 *
 * `trim` then takes a downward-only bite out of the height *after* the curve,
 * which is what keeps the peaks alive where the curve has gone flat. Only ever
 * subtracting means the ceiling still holds.
 *
 * Both are drawn once per sample rather than per frame, so the values freeze
 * into the row and travel left with it. Re-rolling every frame would read as
 * flicker rather than as waveform texture.
 */
const BAR_JITTER = 0.35;
const BAR_TRIM = 0.14;

export interface BarJitter {
  scale: number;
  trim: number;
}

export function nextJitter(): BarJitter {
  return {
    scale: 1 + (Math.random() * 2 - 1) * BAR_JITTER,
    trim: Math.random() * BAR_TRIM,
  };
}

/** Maps one sampled voice level, plus that sample's jitter, to a bar height. */
export function barHeightFor(voiceLevel: number, jitter: BarJitter): number {
  const excess = Math.max(0, voiceLevel * jitter.scale - BAR_NOISE_FLOOR);
  return BAR_CEILING * (1 - Math.exp(-BAR_GAIN * excess)) * (1 - jitter.trim);
}

/**
 * Advances `bars` one frame toward `targets`, in place — this runs at 60fps,
 * so it deliberately doesn't allocate. Separate rise and fall rates let a
 * waveform snap up to a peak and settle back more gently; pass the same value
 * for both to ease symmetrically.
 */
export function easeBars(
  bars: number[],
  targets: number[],
  rise: number,
  fall: number,
): void {
  for (let i = 0; i < bars.length; i++) {
    const target = targets[i] ?? 0;
    bars[i] += (target - bars[i]) * (target > bars[i] ? rise : fall);
  }
}
