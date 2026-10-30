// Live transcript (issue #375, specs/live-chat.md section 1): tail planning,
// the growing-WAV reader, the store and the loop. Fictional audio only (noise
// bursts). The ASR model is a stub.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIC_WAV, SYSTEM_WAV } from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLiveRunning,
  type LiveDeps,
  startLive,
  stopLive,
} from "../src/lib/meetings/live/loop.js";
import {
  getLive,
  openLive,
  setLiveStatus,
  setPartialLine,
} from "../src/lib/meetings/live/store.js";
import {
  CLOSE_AFTER_MS,
  LIVE_SAMPLE_RATE,
  MAX_OPEN_MS,
  planTail,
  readPcmFrom,
  slicePcm,
} from "../src/lib/meetings/live/tail.js";

const RATE = LIVE_SAMPLE_RATE;

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * RATE));
}

/** Loud noise: counts as speech for the gate. Deterministic. */
function speech(ms: number, seed = 7): Int16Array {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Int16Array(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = Math.round((state / 0xffffffff - 0.5) * 12000);
  }
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A growing WAV like the recorder writes: header says 0 bytes of data. */
function growingWav(path: string, pcm: Int16Array): void {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  writeFileSync(path, Buffer.concat([header, Buffer.from(pcm.buffer)]));
}

describe("readPcmFrom", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openstyle-live-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads from byte 44 to the end although the header says 0 bytes", () => {
    const path = join(dir, MIC_WAV);
    growingWav(path, speech(1000));
    expect(readPcmFrom(path, 0)?.length).toBe(RATE);
    appendFileSync(path, Buffer.from(speech(500).buffer));
    expect(readPcmFrom(path, 0)?.length).toBe(RATE * 1.5);
  });

  it("starts at the cursor and returns null for a missing file", () => {
    const path = join(dir, MIC_WAV);
    growingWav(path, speech(2000));
    expect(readPcmFrom(path, 1500)?.length).toBe(RATE * 0.5);
    expect(readPcmFrom(join(dir, "none.wav"), 0)).toBeNull();
  });
});

describe("planTail", () => {
  it("closes a segment that ended long ago and keeps the growing one open", () => {
    const pcm = concat(silence(500), speech(1500), silence(3000), speech(800));
    const plan = planTail(pcm, 0);
    expect(plan.closed).toHaveLength(1);
    expect(plan.closed[0].startMs).toBeLessThan(700);
    expect(plan.open).not.toBeNull();
    expect(plan.open?.startMs).toBeGreaterThan(4500);
  });

  it("keeps a segment open until 800 ms have passed", () => {
    const quiet = CLOSE_AFTER_MS + 1500;
    const open = planTail(concat(silence(300), speech(1500), silence(400)), 0);
    expect(open.closed).toHaveLength(0);
    expect(open.open).not.toBeNull();
    const closed = planTail(
      concat(silence(300), speech(1500), silence(quiet)),
      0,
    );
    expect(closed.closed).toHaveLength(1);
    expect(closed.open).toBeNull();
  });

  it("adds the cursor to every time", () => {
    const plan = planTail(
      concat(silence(300), speech(1000), silence(3000)),
      60_000,
    );
    expect(plan.closed[0].startMs).toBeGreaterThanOrEqual(60_000);
  });

  it("cuts an open tail that is longer than 20 s at a quiet frame", () => {
    // 30 s of speech with a short dip every 3 s (the gate stays open).
    const parts: Int16Array[] = [];
    for (let k = 0; k < 10; k++) parts.push(speech(2900, k + 1), silence(100));
    const plan = planTail(concat(...parts), 0);
    const all = [...plan.closed, ...(plan.open ? [plan.open] : [])];
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const seg of all) {
      expect(seg.endMs - seg.startMs).toBeLessThanOrEqual(MAX_OPEN_MS);
    }
  });

  it("slices the PCM of a segment", () => {
    const pcm = concat(silence(1000), speech(1000));
    const bytes = slicePcm(pcm, 0, { startMs: 1000, endMs: 2000 });
    expect(bytes.byteLength).toBe(RATE * 2);
  });
});

describe("live store", () => {
  it("keeps one partial for each channel and drops the entry", () => {
    openLive("m1");
    setPartialLine("m1", "mic", {
      source: "mic",
      startMs: 0,
      endMs: 1,
      text: "a",
    });
    setPartialLine("m1", "mic", {
      source: "mic",
      startMs: 0,
      endMs: 2,
      text: "ab",
    });
    setLiveStatus("m1", "ready");
    expect(getLive("m1")?.lines).toHaveLength(1);
    expect(getLive("m1")?.lines[0].text).toBe("ab");
    expect(getLive("m1")?.status).toBe("ready");
  });

  it("returns null for an unknown meeting", () => {
    expect(getLive("nope")).toBeNull();
  });
});

describe("live loop", () => {
  let dir = "";
  const texts: string[] = [];
  let dictation = false;
  let enabled = true;
  let model: Awaited<ReturnType<LiveDeps["resolveModel"]>> = {
    modelId: "qwen3-test",
  };

  function deps(): LiveDeps {
    return {
      isEnabled: () => enabled,
      resolveModel: async () => model,
      transcribe: vi.fn(async ({ pcm }) => {
        const text = `words ${texts.length + 1} (${pcm.byteLength} bytes)`;
        texts.push(text);
        return text;
      }),
      isDictationActive: () => dictation,
      tickMs: 20,
    };
  }

  beforeEach(() => {
    // The test setup installs fake timers. The loop needs real ones.
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), "openstyle-live-loop-"));
    texts.length = 0;
    dictation = false;
    enabled = true;
    model = { modelId: "qwen3-test" };
  });
  afterEach(async () => {
    await stopLive("m-loop");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing while the setting is off", async () => {
    enabled = false;
    await startLive("m-loop", dir, deps());
    expect(isLiveRunning("m-loop")).toBe(false);
    expect(getLive("m-loop")).toBeNull();
  });

  it("makes a segment final once and moves the cursor", async () => {
    growingWav(
      join(dir, MIC_WAV),
      concat(silence(300), speech(1500), silence(3000)),
    );
    growingWav(join(dir, SYSTEM_WAV), silence(4000));
    await startLive("m-loop", dir, deps());
    await vi.waitFor(() =>
      expect(getLive("m-loop")?.lines.filter((l) => l.final)).toHaveLength(1),
    );
    const calls = texts.length;
    await new Promise((r) => setTimeout(r, 150));
    // No second read of the same segment, and no duplicate line.
    expect(texts.length).toBe(calls);
    expect(getLive("m-loop")?.lines.filter((l) => l.final)).toHaveLength(1);
    expect(getLive("m-loop")?.lines[0].source).toBe("mic");
  });

  it("shows the open tail as a partial that the next tick replaces", async () => {
    growingWav(join(dir, MIC_WAV), concat(silence(300), speech(1200)));
    growingWav(join(dir, SYSTEM_WAV), silence(2000));
    await startLive("m-loop", dir, deps());
    await vi.waitFor(() =>
      expect(getLive("m-loop")?.lines.some((l) => !l.final)).toBe(true),
    );
    appendFileSync(join(dir, MIC_WAV), Buffer.from(speech(500, 3).buffer));
    await vi.waitFor(() => expect(texts.length).toBeGreaterThan(1));
    expect(getLive("m-loop")?.lines.filter((l) => !l.final)).toHaveLength(1);
  });

  it("skips a tick while a dictation runs and counts it", async () => {
    growingWav(
      join(dir, MIC_WAV),
      concat(silence(300), speech(1500), silence(3000)),
    );
    growingWav(join(dir, SYSTEM_WAV), silence(4000));
    dictation = true;
    await startLive("m-loop", dir, deps());
    await vi.waitFor(() =>
      expect(getLive("m-loop")?.skippedTicks).toBeGreaterThanOrEqual(2),
    );
    expect(texts).toHaveLength(0);
    dictation = false;
    await vi.waitFor(() => expect(texts.length).toBeGreaterThan(0));
  });

  it("drops mic segments with too little speech", async () => {
    // A very short click: under the voiced gate.
    growingWav(
      join(dir, MIC_WAV),
      concat(silence(500), speech(20), silence(3000)),
    );
    growingWav(join(dir, SYSTEM_WAV), silence(4000));
    await startLive("m-loop", dir, deps());
    await new Promise((r) => setTimeout(r, 200));
    expect(texts).toHaveLength(0);
  });

  it("drops a hallucination", async () => {
    growingWav(
      join(dir, MIC_WAV),
      concat(silence(300), speech(1500), silence(3000)),
    );
    growingWav(join(dir, SYSTEM_WAV), silence(4000));
    const d = deps();
    d.transcribe = vi.fn(async () => "Thank you.");
    await startLive("m-loop", dir, d);
    await vi.waitFor(() => expect(d.transcribe).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 100));
    expect(getLive("m-loop")?.lines.filter((l) => l.final)).toHaveLength(0);
  });

  it("is unavailable when the model cannot be used", async () => {
    model = { unavailable: "provider_not_local" };
    await startLive("m-loop", dir, deps());
    expect(isLiveRunning("m-loop")).toBe(false);
    expect(getLive("m-loop")).toMatchObject({
      status: "unavailable",
      reason: "provider_not_local",
    });
  });

  it("waits for a running tick on stop and drops the entry", async () => {
    growingWav(
      join(dir, MIC_WAV),
      concat(silence(300), speech(1500), silence(3000)),
    );
    growingWav(join(dir, SYSTEM_WAV), silence(4000));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const d = deps();
    d.transcribe = vi.fn(async () => {
      await gate;
      return "late words";
    });
    await startLive("m-loop", dir, d);
    await vi.waitFor(() => expect(d.transcribe).toHaveBeenCalled());
    let stopped = false;
    const stopping = stopLive("m-loop").then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(isLiveRunning("m-loop")).toBe(false);
    expect(getLive("m-loop")).toBeNull();
  });
});
