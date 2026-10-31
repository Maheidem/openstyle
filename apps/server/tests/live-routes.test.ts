// Live mode fixes (issue #375): the routes. Stop keeps the live transcript,
// and the chat is saved with the meeting. Fictional audio (noise) and a stub
// ASR model.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIC_WAV, SYSTEM_WAV } from "@openstyle/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { hasJob } from "../src/lib/meetings/job-registry.js";
import { appendChatPair } from "../src/lib/meetings/live/chat-store.js";
import {
  type LiveDeps,
  startLive,
  stopLive,
} from "../src/lib/meetings/live/loop.js";
import { getLive } from "../src/lib/meetings/live/store.js";
import { LIVE_SAMPLE_RATE } from "../src/lib/meetings/live/tail.js";
import { jsonRequest } from "./helpers/http.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";

const app = createApp();
const RATE = LIVE_SAMPLE_RATE;

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * RATE));
}

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

function stubDeps(): LiveDeps {
  let n = 0;
  return {
    isEnabled: () => true,
    resolveModel: async () => ({
      modelId: "qwen3-test",
      declared: ["pt"],
      language: "pt",
    }),
    transcribe: vi.fn(async () => `live words ${++n}`),
    detectSpeech: vi.fn(async () => null),
    detectLanguage: vi.fn(async () => null),
    persistLanguage: vi.fn(),
    isDictationActive: () => false,
    tickMs: 20,
  };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met");
}

describe("live routes", () => {
  let dir = "";
  beforeEach(() => {
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), "openstyle-live-routes-"));
    writeSetting("meeting_diarization_enabled", "false");
  });
  afterEach(async () => {
    await stopLive("m-live");
    resetMeetingTables();
    deleteSetting("meeting_diarization_enabled");
    deleteSetting("live_chat_enabled");
    rmSync(dir, { recursive: true, force: true });
  });

  async function startMeeting(): Promise<void> {
    const res = await jsonRequest(app, "POST", "/api/meetings/start", {
      id: "m-live",
      audio_dir: dir,
      started_at: Date.now(),
    });
    expect(res.status).toBe(200);
  }

  it("Stop saves the live lines as the transcript and marks the meeting", async () => {
    // Speech runs to the end of the file: an open tail that Stop must read.
    growingWav(
      join(dir, MIC_WAV),
      concat(silence(300), speech(1500), silence(3000), speech(2000, 3)),
    );
    growingWav(join(dir, SYSTEM_WAV), silence(6800));
    await startMeeting();
    await startLive("m-live", dir, stubDeps());
    await waitFor(() => (getLive("m-live")?.lines.length ?? 0) > 0);
    const stop = await jsonRequest(app, "POST", "/api/meetings/m-live/stop", {
      ended_at: Date.now(),
      duration_ms: 6800,
      status: "recorded",
    });
    expect(stop.status).toBe(200);
    const detail = (await (
      await app.request("/api/meetings/m-live")
    ).json()) as { status: string; transcript_source: string | null };
    expect(detail.status).toBe("transcribed");
    expect(detail.transcript_source).toBe("live");
    const rows = getDb()
      .prepare(
        "SELECT source, text, status FROM meeting_segments WHERE meeting_id = 'm-live' ORDER BY start_ms",
      )
      .all() as { source: string; text: string; status: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === "mic" && r.status === "ok")).toBe(
      true,
    );
    // The speaker job ends and frees the slot.
    await waitFor(() => !hasJob("m-live"));
    // The transcript is readable at once.
    const transcript = (await (
      await app.request("/api/meetings/m-live/transcript")
    ).json()) as { segments: { text: string }[] };
    expect(transcript.segments.length).toBeGreaterThan(0);
  });

  it("a failed stop keeps no live transcript", async () => {
    growingWav(join(dir, MIC_WAV), concat(silence(300), speech(2000)));
    growingWav(join(dir, SYSTEM_WAV), silence(2300));
    await startMeeting();
    await startLive("m-live", dir, stubDeps());
    const stop = await jsonRequest(app, "POST", "/api/meetings/m-live/stop", {
      ended_at: Date.now(),
      duration_ms: 2300,
      status: "failed",
      error: "capture failed",
    });
    expect(stop.status).toBe(200);
    const detail = (await (
      await app.request("/api/meetings/m-live")
    ).json()) as { status: string; transcript_source: string | null };
    expect(detail.status).toBe("failed");
    expect(detail.transcript_source).toBeNull();
    expect(
      getDb().prepare("SELECT COUNT(*) AS c FROM meeting_segments").get(),
    ).toEqual({ c: 0 });
  });

  it("a stop with no live loop leaves the meeting recorded", async () => {
    await startMeeting();
    const stop = await jsonRequest(app, "POST", "/api/meetings/m-live/stop", {
      ended_at: Date.now(),
      duration_ms: 1000,
    });
    expect(stop.status).toBe(200);
    const detail = (await (
      await app.request("/api/meetings/m-live")
    ).json()) as { status: string };
    expect(detail.status).toBe("recorded");
  });

  it("returns the saved chat, also when the setting is off", async () => {
    await startMeeting();
    appendChatPair(getDb(), "m-live", {
      question: "Who owns the beta?",
      answer: "Dana owns it.",
      cites: [{ label: "L1", kind: "live", timeMs: 4000 }],
      ms: 200,
    });
    const res = await app.request("/api/meetings/m-live/chat");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: { role: string; content: string; cites: unknown[] }[];
    };
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Who owns the beta?"],
      ["assistant", "Dana owns it."],
    ]);
    expect(body.messages[1].cites).toEqual([
      { label: "L1", kind: "live", timeMs: 4000 },
    ]);
  });

  it("answers 404 for the chat of an unknown meeting", async () => {
    expect((await app.request("/api/meetings/nope/chat")).status).toBe(404);
  });

  it("a question needs the setting on", async () => {
    await startMeeting();
    const res = await jsonRequest(app, "POST", "/api/meetings/m-live/chat", {
      question: "Anything?",
    });
    expect(res.status).toBe(409);
  });
});
