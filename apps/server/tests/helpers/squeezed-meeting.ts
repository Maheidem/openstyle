import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWav } from "./wav.js";

const RATE = 16000;

/** PCM16 of a sine tone. Sample i sits at real time i / samplesPerSecond. */
function tone(count: number, hz: number, samplesPerSecond: number): Buffer {
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const v = Math.round(
      8000 * Math.sin((2 * Math.PI * hz * i) / samplesPerSecond),
    );
    data.writeInt16LE(v, i * 2);
  }
  return data;
}

/**
 * Writes a meeting folder as the old meeting helper made it when the buffers
 * ran at `actualRate` but it converted them as `assumedRate` (issue #170):
 * mic.wav at the real speed, system.wav with `actualRate / assumedRate` of
 * the samples (the same tone, squeezed in time), and a sync.json with the
 * counts, a SYNC marker every 60 s, and one shared clock.
 * Returns the sample counts.
 */
export function writeSqueezedMeeting(
  dir: string,
  opts: {
    seconds: number;
    actualRate: number;
    assumedRate: number;
    toneHz?: number;
  },
): { micSamples: number; systemSamples: number } {
  const factor = opts.actualRate / opts.assumedRate;
  const toneHz = opts.toneHz ?? 300;
  const micSamples = opts.seconds * RATE;
  const systemSamples = Math.round(micSamples * factor);
  writeFileSync(
    join(dir, "mic.wav"),
    buildWav({ data: tone(micSamples, toneHz, RATE) }),
  );
  // Stored sample i of the squeezed track covers real time i / (RATE × factor).
  writeFileSync(
    join(dir, "system.wav"),
    buildWav({ data: tone(systemSamples, toneHz, RATE * factor) }),
  );
  const t0 = 1_700_000_000_000;
  const syncMarkers: { wallclockMs: number; totalSamples: number }[] = [];
  for (let s = 0; s <= opts.seconds; s += 60) {
    syncMarkers.push({
      wallclockMs: t0 + s * 1000,
      totalSamples: Math.round(s * RATE * factor),
    });
  }
  writeFileSync(
    join(dir, "sync.json"),
    `${JSON.stringify(
      {
        meetingId: "squeezed",
        sampleRate: RATE,
        micT0: t0,
        systemT0: t0,
        micSamples,
        systemSamples,
        syncMarkers,
        sharedClock: true,
        droppedFrames: 0,
        epochs: [
          { reason: "start", wallclockMs: t0, micSamples: 0, systemSamples: 0 },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { micSamples, systemSamples };
}
