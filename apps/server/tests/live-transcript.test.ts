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
  type LiveModel,
  pickLiveAsrModel,
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

describe("pickLiveAsrModel", () => {
  const mlxMeeting = { provider: "local-mlx", modelId: "local-mlx/meeting-m" };
  const mlxDictation = { provider: "local-mlx", model_id: "local-mlx/dict-m" };

  it("uses the meeting model when it is local MLX", () => {
    expect(pickLiveAsrModel(mlxMeeting, mlxDictation)).toEqual({
      modelId: "local-mlx/meeting-m",
    });
  });

  it("uses the dictation model when the meeting model is not local MLX", () => {
    for (const provider of ["whisper", "server", "openai"]) {
      expect(
        pickLiveAsrModel({ provider, modelId: `${provider}/x` }, mlxDictation),
      ).toEqual({ modelId: "local-mlx/dict-m" });
    }
  });

  it("uses the dictation model when the meeting model cannot be resolved", () => {
    expect(pickLiveAsrModel(null, mlxDictation)).toEqual({
      modelId: "local-mlx/dict-m",
    });
  });

  it("is provider_not_local when no model is local MLX", () => {
    const whisper = { provider: "whisper", model_id: "whisper/base" };
    expect(
      pickLiveAsrModel({ provider: "server", modelId: "s/m" }, whisper),
    ).toEqual({ unavailable: "provider_not_local" });
    expect(pickLiveAsrModel(null, null)).toEqual({
      unavailable: "provider_not_local",
    });
  });
});

/** Mic audio with 11 phrases of 2.5 s speech and 3.5 s pause: 27.5 s speech. */
function phrases(count = 11): Int16Array {
  const parts: Int16Array[] = [silence(300)];
  for (let i = 0; i < count; i++) {
    parts.push(speech(2500, i + 1), silence(3500));
  }
  return concat(...parts);
}

describe("live language lock", () => {
  let dir = "";
  const calls: { language: string | undefined; ms: number }[] = [];
  let dictation = false;

  function deps(model: LiveModel): LiveDeps {
    return {
      isEnabled: () => true,
      resolveModel: async () => model,
      transcribe: vi.fn(async ({ pcm, language }) => {
        calls.push({ language, ms: pcm.byteLength / 32 });
        return `${language ?? "auto"} words ${calls.length}`;
      }),
      detectSpeech: vi.fn(async () => null),
      detectLanguage: vi.fn(async () => "pt"),
      persistLanguage: vi.fn(),
      isDictationActive: () => dictation,
      tickMs: 20,
    };
  }

  beforeEach(() => {
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), "openstyle-live-lang-"));
    calls.length = 0;
    dictation = false;
    growingWav(join(dir, MIC_WAV), phrases());
    growingWav(join(dir, SYSTEM_WAV), silence(70_000));
  });
  afterEach(async () => {
    await stopLive("m-lang");
    rmSync(dir, { recursive: true, force: true });
  });

  it("locks the language after the first speech and reads the early lines again", async () => {
    const d = deps({ modelId: "qwen3-test", declared: [] });
    await startLive("m-lang", dir, d);
    await vi.waitFor(() => expect(d.detectLanguage).toHaveBeenCalledTimes(1), {
      timeout: 4000,
    });
    // Every line ends with the locked language, also the early ones.
    await vi.waitFor(
      () => {
        const finals = getLive("m-lang")?.lines.filter((l) => l.final) ?? [];
        expect(finals.length).toBeGreaterThanOrEqual(8);
        expect(finals.every((l) => l.text.startsWith("pt "))).toBe(true);
      },
      { timeout: 4000 },
    );
    // The first reads ran with auto language. All later reads are locked.
    const firstLocked = calls.findIndex((c) => c.language === "pt");
    expect(firstLocked).toBeGreaterThan(0);
    expect(
      calls.slice(0, firstLocked).every((c) => c.language === undefined),
    ).toBe(true);
    expect(calls.slice(firstLocked).every((c) => c.language === "pt")).toBe(
      true,
    );
    // Auto language is not saved with the meeting.
    expect(d.persistLanguage).not.toHaveBeenCalled();
    expect(d.detectLanguage).toHaveBeenCalledTimes(1);
  });

  it("locks from the open tail without waiting for it to close", async () => {
    // One long phrase that is still open: 12 s of speech to the end of the file.
    growingWav(join(dir, MIC_WAV), concat(silence(300), speech(12_000)));
    growingWav(join(dir, SYSTEM_WAV), silence(12_300));
    const d = deps({ modelId: "qwen3-test", declared: [] });
    await startLive("m-lang", dir, d);
    await vi.waitFor(() => expect(d.detectLanguage).toHaveBeenCalledTimes(1), {
      timeout: 4000,
    });
    expect(vi.mocked(d.detectLanguage).mock.calls[0][0].text).toContain(
      "words",
    );
    await vi.waitFor(() =>
      expect(calls.some((c) => c.language === "pt")).toBe(true),
    );
  });

  it("uses the known language from the first read and does not detect", async () => {
    const d = deps({ modelId: "qwen3-test", declared: ["en"], language: "en" });
    await startLive("m-lang", dir, d);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(3));
    expect(calls.every((c) => c.language === "en")).toBe(true);
    expect(d.detectLanguage).not.toHaveBeenCalled();
  });

  it("saves the locked language when the setting lists more than one", async () => {
    const d = deps({ modelId: "qwen3-test", declared: ["en", "pt"] });
    await startLive("m-lang", dir, d);
    await vi.waitFor(() =>
      expect(d.persistLanguage).toHaveBeenCalledWith("m-lang", "pt"),
    );
    expect(d.detectLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ declared: ["en", "pt"] }),
    );
  });

  it("falls back to the first declared language when the text does not decide", async () => {
    const d = deps({ modelId: "qwen3-test", declared: ["en", "pt"] });
    d.detectLanguage = vi.fn(async () => null);
    await startLive("m-lang", dir, d);
    await vi.waitFor(() =>
      expect(d.persistLanguage).toHaveBeenCalledWith("m-lang", "en"),
    );
  });

  it("waits for more speech when auto language is not decided", async () => {
    const d = deps({ modelId: "qwen3-test", declared: [] });
    d.detectLanguage = vi.fn(async () => null);
    await startLive("m-lang", dir, d);
    await vi.waitFor(() =>
      expect(vi.mocked(d.detectLanguage).mock.calls.length).toBeGreaterThan(1),
    );
    expect(calls.every((c) => c.language === undefined)).toBe(true);
  });
});

describe("live loop", () => {
  let dir = "";
  const texts: string[] = [];
  let dictation = false;
  let enabled = true;
  const languages: (string | undefined)[] = [];
  let model: Awaited<ReturnType<LiveDeps["resolveModel"]>> = {
    modelId: "qwen3-test",
    declared: [],
  };

  function deps(): LiveDeps {
    return {
      isEnabled: () => enabled,
      resolveModel: async () => model,
      transcribe: vi.fn(async ({ pcm, language }) => {
        const text = `words ${texts.length + 1} (${pcm.byteLength} bytes)`;
        texts.push(text);
        languages.push(language);
        return text;
      }),
      // No VAD data: the loop uses the voiced gate only.
      detectSpeech: vi.fn(async () => null),
      detectLanguage: vi.fn(async () => "pt"),
      persistLanguage: vi.fn(),
      isDictationActive: () => dictation,
      tickMs: 20,
    };
  }

  beforeEach(() => {
    // The test setup installs fake timers. The loop needs real ones.
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), "openstyle-live-loop-"));
    texts.length = 0;
    languages.length = 0;
    dictation = false;
    enabled = true;
    model = { modelId: "qwen3-test", declared: [] };
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

  it("does not read a segment that the VAD says has no speech", async () => {
    // Loud noise on both channels, but Silero finds no speech span.
    growingWav(
      join(dir, MIC_WAV),
      concat(silence(300), speech(1500), silence(3000)),
    );
    growingWav(
      join(dir, SYSTEM_WAV),
      concat(silence(300), speech(1500), silence(3000)),
    );
    const d = deps();
    d.detectSpeech = vi.fn(async () => []);
    await startLive("m-loop", dir, d);
    await vi.waitFor(() => expect(d.detectSpeech).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 150));
    expect(d.transcribe).not.toHaveBeenCalled();
    expect(getLive("m-loop")?.lines).toHaveLength(0);
  });

  it("does not read a long segment that holds only a blip of speech", async () => {
    // 10 s of loud noise with 400 ms of speech span (4 percent).
    growingWav(
      join(dir, MIC_WAV),
      concat(silence(300), speech(10_000), silence(3000)),
    );
    growingWav(join(dir, SYSTEM_WAV), silence(13_300));
    const d = deps();
    d.detectSpeech = vi.fn(async () => [{ startMs: 5000, endMs: 5400 }]);
    await startLive("m-loop", dir, d);
    await vi.waitFor(() => expect(d.detectSpeech).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 150));
    expect(d.transcribe).not.toHaveBeenCalled();
  });

  it("reads a segment that the VAD says has speech", async () => {
    growingWav(
      join(dir, MIC_WAV),
      concat(silence(300), speech(1500), silence(3000)),
    );
    growingWav(join(dir, SYSTEM_WAV), silence(4000));
    const d = deps();
    d.detectSpeech = vi.fn(async () => [{ startMs: 300, endMs: 1800 }]);
    await startLive("m-loop", dir, d);
    await vi.waitFor(() =>
      expect(getLive("m-loop")?.lines.filter((l) => l.final)).toHaveLength(1),
    );
  });

  it("does not run the VAD on a window with no segment", async () => {
    growingWav(join(dir, MIC_WAV), silence(30_000));
    growingWav(join(dir, SYSTEM_WAV), silence(30_000));
    const d = deps();
    await startLive("m-loop", dir, d);
    await new Promise((r) => setTimeout(r, 150));
    expect(d.detectSpeech).not.toHaveBeenCalled();
    expect(d.transcribe).not.toHaveBeenCalled();
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

  it("reads the open tail at Stop and gives the lines to the caller", async () => {
    // The speech runs to the end of the file, so it is still an open tail.
    growingWav(join(dir, MIC_WAV), concat(silence(300), speech(2000)));
    growingWav(join(dir, SYSTEM_WAV), silence(2300));
    const d = deps();
    d.tickMs = 60_000; // no tick before Stop
    await startLive("m-loop", dir, d);
    const stopped = await stopLive("m-loop", { flush: true });
    expect(stopped.modelId).toBe("qwen3-test");
    expect(stopped.lines).toHaveLength(1);
    expect(stopped.lines[0]).toMatchObject({ source: "mic", final: true });
    expect(getLive("m-loop")).toBeNull();
  });

  it("gives no lines at Stop without flush when no tick ran", async () => {
    growingWav(join(dir, MIC_WAV), concat(silence(300), speech(2000)));
    growingWav(join(dir, SYSTEM_WAV), silence(2300));
    const d = deps();
    d.tickMs = 60_000;
    await startLive("m-loop", dir, d);
    const stopped = await stopLive("m-loop");
    expect(stopped.lines).toEqual([]);
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
