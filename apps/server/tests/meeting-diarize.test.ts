import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignSpeakerLabels,
  type DiarizerSegment,
  getFluidAudioDiarizeBinaryPath,
  getFluidAudioModelsDirPath,
  type WhisperSegmentForDiarization,
} from "../src/lib/meetings/diarize.js";

function w(
  id: string,
  startMs: number,
  endMs: number,
): WhisperSegmentForDiarization {
  return { id, startMs, endMs };
}

/** Diarizer segment; times given in seconds, matching the helper's JSON contract. */
function d(speakerId: string, startS: number, endS: number): DiarizerSegment {
  return { speakerId, startTimeSeconds: startS, endTimeSeconds: endS };
}

describe("assignSpeakerLabels", () => {
  it("assigns the correct label for perfect 1:1 overlap", () => {
    const whisper = [w("s1", 0, 2000), w("s2", 2000, 4000)];
    const diar = [d("A", 0, 2), d("B", 2, 4)];
    expect(assignSpeakerLabels(whisper, diar)).toEqual([
      { id: "s1", speakerLabel: "1" },
      { id: "s2", speakerLabel: "2" },
    ]);
  });

  it("picks the majority-overlap winner when a segment straddles two speakers unevenly", () => {
    // w1 overlaps A by 2000ms, B by 1000ms — A wins.
    const whisper = [w("s1", 0, 3000)];
    const diar = [d("A", 0, 2), d("B", 2, 4)];
    expect(assignSpeakerLabels(whisper, diar)).toEqual([
      { id: "s1", speakerLabel: "1" },
    ]);
  });

  it("breaks an exact-overlap tie by the closer midpoint", () => {
    // w1 establishes "Est" as speaker index 1. w2 ties 1000ms overlap between
    // Est (mid distance 500ms) and a brand-new speaker B (mid distance 0ms)
    // — B's closer midpoint should win despite Est being the established,
    // earlier-registered speaker.
    const whisper = [w("w1", 100_000, 101_000), w("w2", 0, 2000)];
    const diar = [d("Est", 100, 101), d("Est", 0, 1), d("B", 0.5, 1.5)];
    expect(assignSpeakerLabels(whisper, diar)).toEqual([
      { id: "w1", speakerLabel: "1" },
      { id: "w2", speakerLabel: "2" },
    ]);
  });

  it("breaks a symmetric overlap+midpoint tie by the earlier diarizer segment", () => {
    // w1 establishes "Est" as speaker index 1. w2 ties both overlap (1000ms)
    // and midpoint distance (1500ms) between Est (startMs 0) and a brand-new
    // speaker "New" (startMs 3000) — the earlier segment (Est) should win.
    const whisper = [w("w1", 100_000, 101_000), w("w2", 0, 4000)];
    const diar = [d("Est", 100, 101), d("Est", 0, 1), d("New", 3, 4)];
    expect(assignSpeakerLabels(whisper, diar)).toEqual([
      { id: "w1", speakerLabel: "1" },
      { id: "w2", speakerLabel: "1" },
    ]);
  });

  it("falls back to nearest-neighbor within the 2000ms window when overlap is zero", () => {
    // w1 (0-1000ms) sits entirely inside a diarizer gap; nearest diarizer
    // segment starts at 2500ms, 1500ms away — within the window.
    const whisper = [w("s1", 0, 1000)];
    const diar = [d("A", 2.5, 3.5)];
    expect(assignSpeakerLabels(whisper, diar)).toEqual([
      { id: "s1", speakerLabel: "1" },
    ]);
  });

  it("leaves speaker_label null when nothing is within the fallback window", () => {
    // Nearest diarizer segment is 4000ms away — outside the 2000ms window.
    const whisper = [w("s1", 0, 1000)];
    const diar = [d("A", 5, 6)];
    expect(assignSpeakerLabels(whisper, diar)).toEqual([
      { id: "s1", speakerLabel: null },
    ]);
  });

  it("numbers labels by first-appearance-in-time, not raw speakerId order", () => {
    // S2 speaks first (0-1000ms); S1 speaks second (2000-3000ms). S2 must
    // get "1" despite being second in the diarizer's raw speakerId order and
    // second in the diar array.
    const whisper = [w("w1", 0, 1000), w("w2", 2000, 3000)];
    const diar = [d("S1", 2, 3), d("S2", 0, 1)];
    expect(assignSpeakerLabels(whisper, diar)).toEqual([
      { id: "w1", speakerLabel: "1" },
      { id: "w2", speakerLabel: "2" },
    ]);
  });

  it('labels a single-speaker meeting "1", not bare null (collapse rule)', () => {
    const whisper = [w("w1", 0, 1000), w("w2", 2000, 3000)];
    const diar = [d("S1", 0, 1), d("S1", 2, 3)];
    expect(assignSpeakerLabels(whisper, diar)).toEqual([
      { id: "w1", speakerLabel: "1" },
      { id: "w2", speakerLabel: "1" },
    ]);
  });

  it("leaves every row null when the diarizer produces no output", () => {
    const whisper = [w("w1", 0, 1000), w("w2", 2000, 3000)];
    expect(assignSpeakerLabels(whisper, [])).toEqual([
      { id: "w1", speakerLabel: null },
      { id: "w2", speakerLabel: null },
    ]);
  });
});

// -----------------------------------------------------------------------
// Path resolution — regression test for the dev-mode resolver bug: both
// resolvers used to gate on `process.resourcesPath` truthiness to decide
// "am I packaged", but Electron always sets `resourcesPath` in the main
// process (it points at Electron's own bundled Resources/ dir, not the
// app's), so `npm run dev` always took the "packaged" branch and always
// missed. The fix builds a candidate list and returns the first path that
// actually exists on disk, mirroring `mlxAsrWorkerCandidates()`
// (apps/server/src/lib/mlx-asr/python.ts).
// -----------------------------------------------------------------------
describe("path resolution", () => {
  const originalCwd = process.cwd();
  let tmpRoot: string | undefined;

  afterEach(() => {
    process.chdir(originalCwd);
    delete (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath;
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  function makeDevBundle(): string {
    const root = mkdtempSync(join(tmpdir(), "diarize-dev-"));
    const binDir = join(
      root,
      "resources",
      "bin",
      `${process.platform}-${process.arch}`,
    );
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "fluidaudio-diarize"), "#!/bin/sh\n");
    const modelsDir = join(root, "resources", "models", "speaker-diarization");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, "marker"), "");
    return root;
  }

  it("falls back to the cwd-relative dev path when resourcesPath points at a dir without the bundle (Electron dev mode)", () => {
    tmpRoot = makeDevBundle();
    process.chdir(tmpRoot);
    // Re-read via process.cwd() (not the pre-chdir tmpRoot string): on macOS
    // /tmp is a symlink to /private/tmp, and chdir resolves it.
    const cwd = process.cwd();

    // Simulates Electron main process in dev: resourcesPath is always set,
    // but points at Electron's own framework Resources/ dir, which has no
    // bin/ or models/ for this app.
    const fakeElectronResources = mkdtempSync(
      join(tmpdir(), "electron-resources-"),
    );
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath =
      fakeElectronResources;

    try {
      const binaryPath = getFluidAudioDiarizeBinaryPath();
      expect(binaryPath).toBe(
        join(
          cwd,
          "resources",
          "bin",
          `${process.platform}-${process.arch}`,
          "fluidaudio-diarize",
        ),
      );

      const modelsDir = getFluidAudioModelsDirPath();
      expect(modelsDir).toBe(join(cwd, "resources", "models"));
    } finally {
      rmSync(fakeElectronResources, { recursive: true, force: true });
    }
  });

  it("resolves the cwd-relative dev path when resourcesPath is unset (plain Node)", () => {
    tmpRoot = makeDevBundle();
    process.chdir(tmpRoot);
    delete (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath;
    // See the previous test: process.cwd() resolves symlinks (macOS /tmp),
    // the pre-chdir tmpRoot string doesn't.
    const cwd = process.cwd();

    expect(getFluidAudioDiarizeBinaryPath()).toBe(
      join(
        cwd,
        "resources",
        "bin",
        `${process.platform}-${process.arch}`,
        "fluidaudio-diarize",
      ),
    );
    expect(getFluidAudioModelsDirPath()).toBe(join(cwd, "resources", "models"));
  });

  it("prefers the resourcesPath candidate when it actually holds the bundle (packaged build)", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "diarize-packaged-"));
    const binDir = join(tmpRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "fluidaudio-diarize"), "#!/bin/sh\n");
    const modelsDir = join(tmpRoot, "models", "speaker-diarization");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, "marker"), "");

    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath =
      tmpRoot;
    // cwd has no resources/ dir at all, so the only way this resolves is via
    // the resourcesPath candidate.
    const emptyCwd = mkdtempSync(join(tmpdir(), "diarize-empty-cwd-"));
    process.chdir(emptyCwd);

    try {
      expect(getFluidAudioDiarizeBinaryPath()).toBe(
        join(tmpRoot, "bin", "fluidaudio-diarize"),
      );
      expect(getFluidAudioModelsDirPath()).toBe(join(tmpRoot, "models"));
    } finally {
      rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  it("returns null when neither candidate has the bundle", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "diarize-missing-"));
    process.chdir(tmpRoot);
    delete (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath;

    expect(getFluidAudioDiarizeBinaryPath()).toBeNull();
    expect(getFluidAudioModelsDirPath()).toBeNull();
  });
});
