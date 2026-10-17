import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_REPAIR_TMP } from "@openstyle/validations";
import { describe, expect, it, onTestFinished } from "vitest";
import { createResampler } from "../src/lib/audio/resample.js";
import {
  readWavInfo,
  readWavPcm16,
  wavDurationMs,
} from "../src/lib/audio/wav.js";
import {
  matchRateMismatch,
  planTrackRepair,
  RATE_MATCH_TOLERANCE,
  repairSystemTrack,
  trackRepairState,
} from "../src/lib/meetings/track-repair.js";
import { writeSqueezedMeeting } from "./helpers/squeezed-meeting.js";

// Issue #170: a system track that was converted with the wrong input rate.

const RATE = 16000;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "track-repair-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJournal(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "sync.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Upward zero crossings per second over the first second of `pcm`. */
function crossingsPerSecond(pcm: Int16Array): number {
  let count = 0;
  for (let i = 1; i < Math.min(pcm.length, RATE); i++) {
    if (pcm[i - 1] < 0 && pcm[i] >= 0) count++;
  }
  return count;
}

/** A sync.json body for planTrackRepair, with one 60 s SYNC interval. */
function journal(opts: {
  mic: number;
  system: number;
  systemPerInterval?: number[];
  sharedClock?: boolean;
  epochs?: { reason: string }[];
  repair?: unknown;
}): Record<string, unknown> {
  const perInterval = opts.systemPerInterval ?? [
    (opts.system / opts.mic) * 60 * RATE,
  ];
  let total = 0;
  const syncMarkers = [{ wallclockMs: 0, totalSamples: 0 }];
  for (const [i, n] of perInterval.entries()) {
    total += n;
    syncMarkers.push({ wallclockMs: (i + 1) * 60_000, totalSamples: total });
  }
  return {
    sampleRate: RATE,
    micSamples: opts.mic,
    systemSamples: opts.system,
    syncMarkers,
    sharedClock: opts.sharedClock ?? true,
    epochs: opts.epochs ?? [{ reason: "start" }],
    ...(opts.repair !== undefined ? { repair: opts.repair } : {}),
  };
}

describe("matchRateMismatch", () => {
  it("matches the issue #170 ratio to 16 kHz read as 48 kHz", () => {
    expect(matchRateMismatch(0.3333)).toEqual({
      fromRate: 48000,
      toRate: 16000,
    });
    expect(matchRateMismatch(1 / 3)).toEqual({
      fromRate: 48000,
      toRate: 16000,
    });
  });

  it("matches 0.919 to 44.1 kHz read as 48 kHz", () => {
    expect(matchRateMismatch(0.919)).toEqual({
      fromRate: 48000,
      toRate: 44100,
    });
  });

  it("matches a longer system track the other way round", () => {
    expect(matchRateMismatch(3)).toEqual({ fromRate: 16000, toRate: 48000 });
  });

  it("does not match a ratio that no rate pair explains", () => {
    expect(matchRateMismatch(0.8)).toBeNull();
    expect(matchRateMismatch(0.6)).toBeNull();
    expect(matchRateMismatch(1)).toBeNull();
    expect(matchRateMismatch(0)).toBeNull();
    expect(matchRateMismatch(Number.NaN)).toBeNull();
  });

  it("accepts a difference up to the tolerance and not more", () => {
    const third = 1 / 3;
    expect(
      matchRateMismatch(third * (1 + 0.9 * RATE_MATCH_TOLERANCE)),
    ).not.toBeNull();
    expect(
      matchRateMismatch(third * (1 + 1.1 * RATE_MATCH_TOLERANCE)),
    ).toBeNull();
  });
});

describe("planTrackRepair", () => {
  it("plans a repair for a uniform 1/3 recording", () => {
    const mic = 600 * RATE;
    expect(planTrackRepair(journal({ mic, system: mic / 3 }))).toEqual({
      fromRate: 48000,
      toRate: 16000,
    });
  });

  it("plans no repair when one SYNC interval runs at another rate", () => {
    // A mic lost after 2 minutes of a 1/3 recording: the total ratio is 2/3
    // (a candidate factor), but the system track itself ran at real speed
    // in the last minute. One factor for the whole file would be wrong.
    const mic = 180 * RATE;
    const third = 60 * RATE * (1 / 3);
    expect(
      planTrackRepair(
        journal({
          mic,
          system: (2 / 3) * mic,
          systemPerInterval: [third, third, 60 * RATE],
        }),
      ),
    ).toBeNull();
  });

  it("plans no repair without one shared clock, after a fallback, or twice", () => {
    const mic = 600 * RATE;
    const system = mic / 3;
    expect(
      planTrackRepair(journal({ mic, system, sharedClock: false })),
    ).toBeNull();
    expect(
      planTrackRepair(
        journal({
          mic,
          system,
          epochs: [{ reason: "start" }, { reason: "fallback" }],
        }),
      ),
    ).toBeNull();
    expect(
      planTrackRepair(
        journal({ mic, system, repair: { fromRate: 48000, toRate: 16000 } }),
      ),
    ).toBeNull();
  });

  it("plans no repair without a SYNC interval to check", () => {
    const mic = 600 * RATE;
    const body = journal({ mic, system: mic / 3 });
    body.syncMarkers = [{ wallclockMs: 0, totalSamples: 0 }];
    expect(planTrackRepair(body)).toBeNull();
  });

  it("plans no repair for a good ratio or an unknown bad ratio", () => {
    const mic = 600 * RATE;
    expect(planTrackRepair(journal({ mic, system: mic }))).toBeNull();
    expect(planTrackRepair(journal({ mic, system: 0.8 * mic }))).toBeNull();
  });
});

describe("trackRepairState", () => {
  it("gives the pending repair, the done repair, or the warning", () => {
    const mic = 600 * RATE;
    expect(trackRepairState(journal({ mic, system: mic / 3 }))).toEqual({
      ratioWarning: null,
      repair: { fromRate: 48000, toRate: 16000, repaired: false },
    });
    expect(
      trackRepairState(
        journal({
          mic,
          system: mic,
          repair: { fromRate: 48000, toRate: 16000 },
        }),
      ),
    ).toEqual({
      ratioWarning: null,
      repair: { fromRate: 48000, toRate: 16000, repaired: true },
    });
    const unknown = trackRepairState(journal({ mic, system: 0.8 * mic }));
    expect(unknown.repair).toBeNull();
    expect(unknown.ratioWarning).toBeCloseTo(0.8, 5);
  });
});

describe("createResampler", () => {
  function resampleAll(
    input: Int16Array,
    up: number,
    down: number,
  ): Int16Array {
    const r = createResampler(input, up, down);
    const out = new Int16Array(r.total);
    let at = 0;
    const block = new Int16Array(1000);
    for (let n = r.read(block); n > 0; n = r.read(block)) {
      out.set(block.subarray(0, n), at);
      at += n;
    }
    expect(at).toBe(r.total);
    return out;
  }

  it("gives the exact length for each rational factor", () => {
    const input = new Int16Array(14_700);
    expect(createResampler(input, 3, 1).total).toBe(44_100);
    expect(createResampler(input, 48000, 44100).total).toBe(16_000);
    expect(createResampler(input, 1, 3).total).toBe(4_900);
  });

  it("keeps the frequency of a tone in real time", () => {
    // 900 Hz in the squeezed track is 300 Hz in real time.
    const input = new Int16Array(RATE);
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.round(8000 * Math.sin((2 * Math.PI * 900 * i) / RATE));
    }
    const out = resampleAll(input, 3, 1);
    expect(crossingsPerSecond(out)).toBeGreaterThanOrEqual(299);
    expect(crossingsPerSecond(out)).toBeLessThanOrEqual(301);
  });

  it("removes a tone above the new Nyquist rate when it downsamples", () => {
    // 6 kHz is above 8 kHz / 3. Without the low-pass it would alias.
    const input = new Int16Array(RATE);
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.round(8000 * Math.sin((2 * Math.PI * 6000 * i) / RATE));
    }
    const out = resampleAll(input, 1, 3);
    let peak = 0;
    for (let i = 200; i < out.length - 200; i++) {
      peak = Math.max(peak, Math.abs(out[i]));
    }
    expect(peak).toBeLessThan(80); // below 1 % of the input amplitude
  });
});

describe("repairSystemTrack", () => {
  it("repairs a 1/3 system track once, keeps the original and updates sync.json", () => {
    const dir = tempDir();
    const counts = writeSqueezedMeeting(dir, {
      seconds: 90,
      actualRate: 16000,
      assumedRate: 48000,
    });
    const originalBytes = readFileSync(join(dir, "system.wav"));

    const repair = repairSystemTrack(dir);
    expect(repair).toMatchObject({
      fromRate: 48000,
      toRate: 16000,
      originalSystemSamples: counts.systemSamples,
    });
    expect(repair?.factor).toBeCloseTo(1 / 3, 10);

    // The repaired track is as long as the mic track, within 0.5 %.
    const micMs = wavDurationMs(readWavInfo(join(dir, "mic.wav")));
    const systemMs = wavDurationMs(readWavInfo(join(dir, "system.wav")));
    expect(Math.abs(systemMs - micMs) / micMs).toBeLessThan(0.005);
    // And the tone is back at its real frequency (300 Hz, was 900 Hz).
    const repaired = readWavPcm16(join(dir, "system.wav"));
    expect(
      crossingsPerSecond(repaired?.pcm ?? new Int16Array()),
    ).toBeGreaterThanOrEqual(299);
    expect(
      crossingsPerSecond(repaired?.pcm ?? new Int16Array()),
    ).toBeLessThanOrEqual(301);

    // The original stays, byte for byte.
    expect(
      readFileSync(join(dir, "system.original.wav")).equals(originalBytes),
    ).toBe(true);

    // sync.json has the new count and the repair record.
    const after = readJournal(dir);
    expect(after.systemSamples).toBe(counts.systemSamples * 3);
    expect(after.micSamples).toBe(counts.micSamples);
    expect(after.repair).toEqual(repair);
    expect(trackRepairState(after).repair).toEqual({
      fromRate: 48000,
      toRate: 16000,
      repaired: true,
    });

    // A second run changes nothing.
    const systemBytes = readFileSync(join(dir, "system.wav"));
    const syncText = readFileSync(join(dir, "sync.json"), "utf8");
    expect(repairSystemTrack(dir)).toBeNull();
    expect(readFileSync(join(dir, "system.wav")).equals(systemBytes)).toBe(
      true,
    );
    expect(
      readFileSync(join(dir, "system.original.wav")).equals(originalBytes),
    ).toBe(true);
    expect(readFileSync(join(dir, "sync.json"), "utf8")).toBe(syncText);
    expect(existsSync(join(dir, SYSTEM_REPAIR_TMP))).toBe(false);
  });

  it("repairs 44.1 kHz read as 48 kHz", () => {
    const dir = tempDir();
    writeSqueezedMeeting(dir, {
      seconds: 70,
      actualRate: 44100,
      assumedRate: 48000,
    });
    expect(repairSystemTrack(dir)).toMatchObject({
      fromRate: 48000,
      toRate: 44100,
    });
    const micMs = wavDurationMs(readWavInfo(join(dir, "mic.wav")));
    const systemMs = wavDurationMs(readWavInfo(join(dir, "system.wav")));
    expect(Math.abs(systemMs - micMs) / micMs).toBeLessThan(0.005);
  });

  it("finishes a repair that stopped after the original was kept", () => {
    const dir = tempDir();
    writeSqueezedMeeting(dir, {
      seconds: 70,
      actualRate: 16000,
      assumedRate: 48000,
    });
    const originalBytes = readFileSync(join(dir, "system.wav"));
    // The earlier run renamed system.wav and then stopped.
    renameSync(join(dir, "system.wav"), join(dir, "system.original.wav"));

    expect(repairSystemTrack(dir)).not.toBeNull();
    expect(
      readFileSync(join(dir, "system.original.wav")).equals(originalBytes),
    ).toBe(true);
    const micMs = wavDurationMs(readWavInfo(join(dir, "mic.wav")));
    const systemMs = wavDurationMs(readWavInfo(join(dir, "system.wav")));
    expect(Math.abs(systemMs - micMs) / micMs).toBeLessThan(0.005);
  });

  it("deletes a stale temp file at the start of a repair", () => {
    const dir = tempDir();
    writeSqueezedMeeting(dir, {
      seconds: 70,
      actualRate: 16000,
      assumedRate: 48000,
    });
    // An earlier repair stopped half way and left a partial temp file. It is
    // read-only, so a write to the same path would fail.
    const stale = join(dir, SYSTEM_REPAIR_TMP);
    writeFileSync(stale, Buffer.alloc(4096, 7));
    chmodSync(stale, 0o444);

    expect(repairSystemTrack(dir)).not.toBeNull();
    expect(existsSync(stale)).toBe(false);
    const micMs = wavDurationMs(readWavInfo(join(dir, "mic.wav")));
    const systemMs = wavDurationMs(readWavInfo(join(dir, "system.wav")));
    expect(Math.abs(systemMs - micMs) / micMs).toBeLessThan(0.005);
  });

  it("leaves the track as it was after a failure, shows the warning, and repairs on the next run", () => {
    const dir = tempDir();
    writeSqueezedMeeting(dir, {
      seconds: 70,
      actualRate: 16000,
      assumedRate: 48000,
    });
    const before = readFileSync(join(dir, "system.wav"));
    // A directory in the place of the temp file makes the write fail.
    mkdirSync(join(dir, SYSTEM_REPAIR_TMP));

    expect(() => repairSystemTrack(dir)).toThrow();
    expect(readFileSync(join(dir, "system.wav")).equals(before)).toBe(true);
    expect(existsSync(join(dir, "system.original.wav"))).toBe(false);
    const failed = readJournal(dir);
    expect(failed.repairError).toBeDefined();
    const state = trackRepairState(failed);
    expect(state.repair).toBeNull();
    expect(state.ratioWarning).toBeCloseTo(1 / 3, 3);

    rmSync(join(dir, SYSTEM_REPAIR_TMP), { recursive: true });
    expect(repairSystemTrack(dir)).not.toBeNull();
    const fixed = readJournal(dir);
    expect(fixed.repairError).toBeUndefined();
    expect(trackRepairState(fixed).repair).toMatchObject({ repaired: true });
  });

  it("does nothing for a good recording or a folder without sync.json", () => {
    const dir = tempDir();
    writeSqueezedMeeting(dir, {
      seconds: 70,
      actualRate: 48000,
      assumedRate: 48000,
    });
    const before = readFileSync(join(dir, "system.wav"));
    expect(repairSystemTrack(dir)).toBeNull();
    expect(readFileSync(join(dir, "system.wav")).equals(before)).toBe(true);
    expect(existsSync(join(dir, "system.original.wav"))).toBe(false);
    expect(repairSystemTrack(tempDir())).toBeNull();
  });
});
