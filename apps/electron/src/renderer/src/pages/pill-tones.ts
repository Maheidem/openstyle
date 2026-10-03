// Pill sound and the module state that the pill reads on each recording.
// The settings listeners in app.tsx write this state with the setters.

import type { AudioPlaybackMode } from "../../../shared/audio-playback";

let _soundEnabled = true;
let _outputMode = "paste";
let _audioPlaybackMode: AudioPlaybackMode = "off";
let _toneCtx: AudioContext | null = null;

export function setSoundEnabled(enabled: boolean): void {
  _soundEnabled = enabled;
}

export function getOutputMode(): string {
  return _outputMode;
}

export function setOutputMode(mode: string): void {
  _outputMode = mode;
}

export function getAudioPlaybackMode(): AudioPlaybackMode {
  return _audioPlaybackMode;
}

export function setAudioPlaybackMode(mode: AudioPlaybackMode): void {
  _audioPlaybackMode = mode;
}

function getToneCtx(): AudioContext {
  if (!_toneCtx || _toneCtx.state === "closed") _toneCtx = new AudioContext();
  return _toneCtx;
}

type TonePreset = "start" | "stop";
const TONE_PRESETS: Record<TonePreset, { freq: number; ms: number }> = {
  start: { freq: 347, ms: 125 }, // F4
  stop: { freq: 255, ms: 125 }, // C4
};

export async function playTone(
  preset: TonePreset,
  volume = 0.16,
): Promise<void> {
  if (!_soundEnabled) return;
  const { freq, ms } = TONE_PRESETS[preset];
  try {
    const ctx = getToneCtx();
    if (ctx.state === "suspended") await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const now = ctx.currentTime;
    const dur = ms / 1000;
    const attack = Math.min(0.02, dur * 0.25);
    const g = gain.gain;
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(volume, now + attack);
    g.exponentialRampToValueAtTime(0.001, now + dur);
    g.linearRampToValueAtTime(0, now + dur + 0.012);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  } catch {}
}
