import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db.js";
import {
  type DiarizeDeps,
  runDiarizationPass,
} from "../src/lib/meetings/diarize.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  getDb().exec("DELETE FROM meeting_segments");
  getDb().exec("DELETE FROM meetings");
});

/** A meeting dir with a real (empty PCM) system.wav — content is never
 * parsed by these tests since execFile is faked. */
function makeMeetingAudioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-diarize-test-"));
  dirs.push(dir);
  writeFileSync(join(dir, "system.wav"), Buffer.alloc(44));
  return dir;
}

function insertMeeting(id: string, durationMs = 60_000): void {
  getDb()
    .prepare(
      `INSERT INTO meetings (id, title, status, duration_ms, created_at)
       VALUES (?, 'Test meeting', 'transcribing', ?, ?)`,
    )
    .run(id, durationMs, Date.now());
}

function insertSystemSegment(
  id: string,
  meetingId: string,
  idx: number,
  startMs: number,
  endMs: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
       VALUES (?, ?, 'system', ?, ?, ?, 'hello', 'ok')`,
    )
    .run(id, meetingId, idx, startMs, endMs);
}

function speakerLabels(meetingId: string): (string | null)[] {
  return (
    getDb()
      .prepare(
        "SELECT speaker_label FROM meeting_segments WHERE meeting_id = ? ORDER BY idx",
      )
      .all(meetingId) as { speaker_label: string | null }[]
  ).map((r) => r.speaker_label);
}

/** Fake execFile: routes --probe and the real-run invocation to canned results. */
function makeFakeExecFile(opts: {
  probeStdout?: string;
  probeThrows?: Error;
  runStdout?: string;
  runThrows?: Error;
}): DiarizeDeps["execFile"] {
  return async (_file, args) => {
    if (args[0] === "--probe") {
      if (opts.probeThrows) throw opts.probeThrows;
      return { stdout: opts.probeStdout ?? "READY", stderr: "" };
    }
    if (opts.runThrows) throw opts.runThrows;
    return { stdout: opts.runStdout ?? "[]", stderr: "" };
  };
}

/** Base deps every test starts from: binary + models bundle both resolve,
 * only execFile varies per case. Models are pre-bundled (spec §4, amended
 * 2026-08-25) — resolveModelsDirPath mirrors resolveBinaryPath's null =
 * missing/build-gap contract. */
function baseDeps(execFile: DiarizeDeps["execFile"]): DiarizeDeps {
  return {
    resolveBinaryPath: () => "/fake/fluidaudio-diarize",
    resolveModelsDirPath: () => "/fake/resources/models",
    execFile,
  };
}

describe("runDiarizationPass", () => {
  it("skips (no writes) when the binary isn't found", async () => {
    const dir = makeMeetingAudioDir();
    insertMeeting("m1");
    insertSystemSegment("s1", "m1", 0, 0, 1000);

    const deps: DiarizeDeps = {
      ...baseDeps(makeFakeExecFile({})),
      resolveBinaryPath: () => null,
    };
    await expect(runDiarizationPass("m1", dir, deps)).resolves.toBeUndefined();
    expect(speakerLabels("m1")).toEqual([null]);
  });

  it("skips (no writes) when the models bundle is missing", async () => {
    const dir = makeMeetingAudioDir();
    insertMeeting("m1");
    insertSystemSegment("s1", "m1", 0, 0, 1000);

    const deps: DiarizeDeps = {
      ...baseDeps(makeFakeExecFile({})),
      resolveModelsDirPath: () => null,
    };
    await expect(runDiarizationPass("m1", dir, deps)).resolves.toBeUndefined();
    expect(speakerLabels("m1")).toEqual([null]);
  });

  it("skips (no writes) when the probe reports NOT_READY", async () => {
    const dir = makeMeetingAudioDir();
    insertMeeting("m1");
    insertSystemSegment("s1", "m1", 0, 0, 1000);

    const deps = baseDeps(makeFakeExecFile({ probeStdout: "NOT_READY" }));
    await runDiarizationPass("m1", dir, deps);
    expect(speakerLabels("m1")).toEqual([null]);
  });

  it("skips (no writes, no throw) when the helper returns malformed JSON", async () => {
    const dir = makeMeetingAudioDir();
    insertMeeting("m1");
    insertSystemSegment("s1", "m1", 0, 0, 1000);

    const deps = baseDeps(makeFakeExecFile({ runStdout: "not json" }));
    await expect(runDiarizationPass("m1", dir, deps)).resolves.toBeUndefined();
    expect(speakerLabels("m1")).toEqual([null]);
  });

  it("skips (no throw) when the real run invocation rejects", async () => {
    const dir = makeMeetingAudioDir();
    insertMeeting("m1");
    insertSystemSegment("s1", "m1", 0, 0, 1000);

    const deps = baseDeps(
      makeFakeExecFile({ runThrows: new Error("ETIMEDOUT") }),
    );
    await expect(runDiarizationPass("m1", dir, deps)).resolves.toBeUndefined();
    expect(speakerLabels("m1")).toEqual([null]);
  });

  it("passes --models-dir on both the probe and the real-run invocation", async () => {
    const dir = makeMeetingAudioDir();
    insertMeeting("m1");
    insertSystemSegment("s1", "m1", 0, 0, 1000);

    const calls: string[][] = [];
    const deps = baseDeps(async (_file, args) => {
      calls.push(args);
      if (args[0] === "--probe") return { stdout: "READY", stderr: "" };
      return { stdout: "[]", stderr: "" };
    });
    await runDiarizationPass("m1", dir, deps);

    expect(calls).toEqual([
      ["--probe", "--models-dir", "/fake/resources/models"],
      [`${dir}/system.wav`, "--models-dir", "/fake/resources/models"],
    ]);
  });

  it("persists speaker labels for a valid diarizer JSON response", async () => {
    const dir = makeMeetingAudioDir();
    insertMeeting("m1");
    insertSystemSegment("s1", "m1", 0, 0, 1000);
    insertSystemSegment("s2", "m1", 1, 2000, 3000);

    const diarJson = JSON.stringify([
      {
        speakerId: "A",
        startTimeSeconds: 0,
        endTimeSeconds: 1,
        qualityScore: 0.9,
      },
      {
        speakerId: "B",
        startTimeSeconds: 2,
        endTimeSeconds: 3,
        qualityScore: 0.9,
      },
    ]);
    const deps = baseDeps(makeFakeExecFile({ runStdout: diarJson }));
    await runDiarizationPass("m1", dir, deps);
    expect(speakerLabels("m1")).toEqual(["1", "2"]);
  });
});
