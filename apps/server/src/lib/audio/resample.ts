/**
 * Rational resampler for mono PCM16, in plain TypeScript (issue #170 track
 * repair). No ffmpeg, so it runs the same on every platform and in tests.
 *
 * Output rate = input rate × up / down, with the exact integer factor.
 * Each output sample is a windowed-sinc interpolation (Blackman window) of
 * the input. The low-pass cutoff is the lower of the two Nyquist rates, so a
 * downsample does not alias. One filter per phase is computed once.
 */

/** Zero crossings of the sinc on each side, at the cutoff frequency. */
const ZERO_CROSSINGS = 12;

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x;
}

/** Number of output samples for `inputLength` input samples. */
export function resampledLength(
  inputLength: number,
  up: number,
  down: number,
): number {
  return Math.floor((inputLength * up) / down);
}

export interface Resampler {
  /** Number of output samples in all. */
  readonly total: number;
  /**
   * Writes the next output samples into `out`, from the start of `out`.
   * Returns how many it wrote. 0 means the output is complete.
   */
  read(out: Int16Array): number;
}

/**
 * Makes a resampler for `input` by `up / down` (positive integers). The
 * caller pulls the output block by block, so it can write each block to a
 * file and let other work run between blocks.
 */
export function createResampler(
  input: Int16Array,
  up: number,
  down: number,
): Resampler {
  if (!Number.isInteger(up) || !Number.isInteger(down) || up < 1 || down < 1) {
    throw new Error(`resample factor must be positive integers: ${up}/${down}`);
  }
  const g = gcd(up, down);
  const L = up / g;
  const M = down / g;
  const total = resampledLength(input.length, L, M);

  // Cutoff in cycles per input sample (0.5 = the Nyquist rate of the input).
  const cutoff = 0.5 * Math.min(1, L / M);
  // Half width of the kernel, in input samples.
  const half = Math.ceil(ZERO_CROSSINGS / (2 * cutoff));
  const taps = 2 * half;

  // Filter for phase p: the output sample sits p/L input samples after the
  // input sample i0. Tap j reads input[i0 - half + 1 + j].
  const bank = new Float32Array(L * taps);
  for (let p = 0; p < L; p++) {
    const frac = p / L;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const t = j - half + 1 - frac;
      const x = 2 * cutoff * t;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w =
        Math.abs(t) >= half
          ? 0
          : 0.42 +
            0.5 * Math.cos((Math.PI * t) / half) +
            0.08 * Math.cos((2 * Math.PI * t) / half);
      const v = sinc * w;
      bank[p * taps + j] = v;
      sum += v;
    }
    // Unity gain at 0 Hz for every phase.
    for (let j = 0; j < taps; j++) bank[p * taps + j] /= sum;
  }

  const n = input.length;
  let next = 0;
  return {
    total,
    read(out: Int16Array): number {
      const count = Math.min(out.length, total - next);
      for (let c = 0; c < count; c++) {
        const pos = (next + c) * M;
        const i0 = Math.floor(pos / L);
        const off = (pos - i0 * L) * taps;
        const base = i0 - half + 1;
        let acc = 0;
        if (base >= 0 && base + taps <= n) {
          for (let j = 0; j < taps; j++) acc += input[base + j] * bank[off + j];
        } else {
          // Near the ends: samples outside the input count as silence.
          for (let j = 0; j < taps; j++) {
            const idx = base + j;
            if (idx >= 0 && idx < n) acc += input[idx] * bank[off + j];
          }
        }
        const s = Math.round(acc);
        out[c] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
      }
      next += count;
      return count;
    },
  };
}
