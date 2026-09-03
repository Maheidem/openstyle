import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";

// ---------------------------------------------------------------------------
// Mocks (hoisted so the route module sees it at import time). Only the
// ffmpeg decode seam is faked — the DB and the filesystem are real, so the
// 409 dir guard, the INSERT, and the on-disk system.wav are all exercised.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  decode: vi.fn(),
}));

vi.mock("../src/lib/audio/decode.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/lib/audio/decode.js")>();
  return { ...real, decodeToWav16kMono: mocks.decode };
});

const { AudioDecodeError } = await import("../src/lib/audio/decode.js");
const { createMeetingsImportRoute } = await import(
  "../src/routes/meetings-import.js"
);
const { default: createApp } = await import("../src/index.js");
const app = createApp();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000;

/** Canonical 44-byte-header 16 kHz mono PCM16 WAV of `samples` samples
 * (silence — the route never transcribes, so content is irrelevant; only
 * `needsDecode` must see the canonical shape). */
function buildWav(samples = 16000): Buffer {
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let tempRoots: string[] = [];

/** A not-yet-existing absolute `<root>/<uuid>` audio_dir, plus cleanup. */
function meetingDir(id: string): string {
  const root = mkdtempSync(join(tmpdir(), "meeting-import-test-"));
  tempRoots.push(root);
  return join(root, id);
}

function importForm(opts: {
  name: string;
  bytes: Uint8Array;
  id: string;
  audioDir: string;
  title?: string;
  startedAt?: number;
}): FormData {
  const form = new FormData();
  form.append("audio", new File([opts.bytes], opts.name));
  form.append("id", opts.id);
  form.append("audio_dir", opts.audioDir);
  if (opts.title !== undefined) form.append("title", opts.title);
  if (opts.startedAt !== undefined)
    form.append("started_at", String(opts.startedAt));
  return form;
}

function postImport(
  body: BodyInit,
  headers: Record<string, string> = {},
  target: { request: typeof app.request } = app,
): Promise<Response> {
  return target.request("/api/meetings/import", {
    method: "POST",
    headers,
    body,
  });
}

function meetingRow(id: string): Record<string, unknown> | undefined {
  return getDb().prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/meetings/import", () => {
  beforeEach(() => {
    // Real timers: the route awaits real async I/O (formData, arrayBuffer).
    vi.useRealTimers();
    vi.clearAllMocks();
    getDb().exec("DELETE FROM meetings");
  });

  afterEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    for (const root of tempRoots)
      rmSync(root, { recursive: true, force: true });
    tempRoots = [];
  });

  it("201 for a canonical WAV: pass-through (no decode), row + system.wav + GET /:id shape", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const dir = meetingDir(id);
    const wav = buildWav(16_000); // exactly 1 s
    const before = Date.now();

    const res = await postImport(
      importForm({ name: "standup.wav", bytes: wav, id, audioDir: dir }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      id,
      title: "standup",
      status: "recorded",
      audio_dir: dir,
      duration_ms: 1000,
      stt_provider: null,
      stt_model: null,
      language: null,
      context: null,
      error: null,
      job: null,
      segment_counts: { total: 0, failed: 0 },
      summary: null,
    });
    expect(body.started_at).toBeGreaterThanOrEqual(before);
    expect(body.ended_at).toBe(body.started_at + 1000);
    expect(body.created_at).toBeGreaterThanOrEqual(before);

    // Pass-through: decode never invoked, bytes land verbatim.
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "system.wav")).equals(wav)).toBe(true);

    // The persisted row matches the response payload.
    const row = meetingRow(id);
    expect(row).toMatchObject({
      id,
      title: "standup",
      status: "recorded",
      audio_dir: dir,
      duration_ms: 1000,
      started_at: body.started_at,
      ended_at: body.ended_at,
      created_at: body.created_at,
    });

    // Response shape equals GET /:id for the fresh meeting.
    const getRes = await app.request(`/api/meetings/${id}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(body);
  });

  it("an explicit title form field wins over the filename stem", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const dir = meetingDir(id);
    const res = await postImport(
      importForm({
        name: "call.wav",
        bytes: buildWav(1600), // 100 ms
        id,
        audioDir: dir,
        title: "  Weekly sync  ",
      }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: "Weekly sync" });
    expect(meetingRow(id)?.title).toBe("Weekly sync");
  });

  it("a blank title falls back to the filename stem", async () => {
    const id = "3f0d3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a";
    const dir = meetingDir(id);
    const res = await postImport(
      importForm({
        name: "memo.wav",
        bytes: buildWav(1600),
        id,
        audioDir: dir,
        title: "   ",
      }),
    );

    expect(res.status).toBe(201);
    expect(meetingRow(id)?.title).toBe("memo");
  });

  it("started_at is honored and ended_at = started_at + duration_ms", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const dir = meetingDir(id);
    const startedAt = 1_700_000_000_000;
    const res = await postImport(
      importForm({
        name: "old.wav",
        bytes: buildWav(32_000), // 2 s
        id,
        audioDir: dir,
        startedAt,
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      started_at: startedAt,
      ended_at: startedAt + 2000,
      duration_ms: 2000,
    });
  });

  it("a valid-but-empty (0-sample) WAV imports as a 0-duration meeting", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const dir = meetingDir(id);
    const res = await postImport(
      importForm({ name: "empty.wav", bytes: buildWav(0), id, audioDir: dir }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ duration_ms: 0 });
    expect(meetingRow(id)).toMatchObject({
      duration_ms: 0,
      status: "recorded",
    });
    expect(existsSync(join(dir, "system.wav"))).toBe(true);
  });

  it("415 for an unsupported extension, before any decode or dir work", async () => {
    const id = "66666666-6666-4666-8666-666666666666";
    const dir = meetingDir(id);
    const res = await postImport(
      importForm({ name: "notes.txt", bytes: buildWav(), id, audioDir: dir }),
    );

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      error: "Unsupported file type",
      detail: "Accepted extensions: wav, mp3, m4a, aac, ogg, mp4",
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(meetingRow(id)).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it("413 with PAYLOAD_TOO_LARGE when the body exceeds the limit", async () => {
    const mini = new Hono().route(
      "/api/meetings",
      createMeetingsImportRoute({ maxBytes: 1024 }),
    );
    const id = "77777777-7777-4777-8777-777777777777";
    const res = await postImport(
      importForm({
        name: "big.wav",
        bytes: buildWav(1024), // 2 KiB of samples — well over a 1 KiB limit
        id,
        audioDir: meetingDir(id),
      }),
      {},
      mini,
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "File too large",
      detail: "Maximum upload size is 1 KiB",
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(meetingRow(id)).toBeUndefined();
  });

  it("409 when a meetings row with the id already exists", async () => {
    const id = "88888888-8888-4888-8888-888888888888";
    const dir = meetingDir(id);
    getDb()
      .prepare(
        `INSERT INTO meetings (id, title, started_at, status, audio_dir, created_at)
         VALUES (?, 'existing', 0, 'recorded', ?, 0)`,
      )
      .run(id, dir);

    const res = await postImport(
      importForm({ name: "clip.wav", bytes: buildWav(), id, audioDir: dir }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "A meeting with this id already exists",
    });
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "system.wav"))).toBe(false);
  });

  it("409 when the target directory exists and is non-empty", async () => {
    const id = "99999999-9999-4999-8999-999999999999";
    const dir = meetingDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mic.wav"), buildWav()); // a live recording's dir

    const res = await postImport(
      importForm({ name: "clip.wav", bytes: buildWav(), id, audioDir: dir }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Audio directory already exists and is not empty",
    });
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(meetingRow(id)).toBeUndefined();
  });

  it("201 when the target directory exists but is empty", async () => {
    const id = "aaaa1aaa-1aaa-4aaa-8aaa-1aaa1aaa1aaa";
    const dir = meetingDir(id);
    mkdirSync(dir, { recursive: true });

    const res = await postImport(
      importForm({
        name: "clip.wav",
        bytes: buildWav(1600),
        id,
        audioDir: dir,
      }),
    );

    expect(res.status).toBe(201);
    expect(meetingRow(id)).toMatchObject({ id, status: "recorded" });
    expect(existsSync(join(dir, "system.wav"))).toBe(true);
  });

  it("400 for a non-UUID id", async () => {
    const res = await postImport(
      importForm({
        name: "clip.wav",
        bytes: buildWav(),
        id: "not-a-uuid",
        audioDir: "/tmp/not-a-uuid",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "id must be a UUID" });
    expect(meetingRow("not-a-uuid")).toBeUndefined();
  });

  it("400 for a relative audio_dir", async () => {
    const id = "bbbb2bbb-2bbb-4bbb-8bbb-2bbb2bbb2bbb";
    const res = await postImport(
      importForm({
        name: "clip.wav",
        bytes: buildWav(),
        id,
        audioDir: `meetings/${id}`,
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "audio_dir must be an absolute path whose basename equals id",
    });
  });

  it("400 when basename(audio_dir) !== id", async () => {
    const id = "cccc3ccc-3ccc-4ccc-8ccc-3ccc3ccc3ccc";
    const res = await postImport(
      importForm({
        name: "clip.wav",
        bytes: buildWav(),
        id,
        audioDir: "/tmp/some-other-id",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "audio_dir must be an absolute path whose basename equals id",
    });
  });

  it("400 for a title over 512 chars and a non-integer started_at", async () => {
    const id = "dddd4ddd-4ddd-4ddd-8ddd-4ddd4ddd4ddd";
    const long = await postImport(
      importForm({
        name: "clip.wav",
        bytes: buildWav(),
        id,
        audioDir: meetingDir(id),
        title: "x".repeat(513),
      }),
    );
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({
      error: "title must be at most 512 characters",
    });

    const badStart = await postImport(
      importForm({
        name: "clip.wav",
        bytes: buildWav(),
        id,
        audioDir: meetingDir(id),
        startedAt: Number.NaN,
      }),
    );
    expect(badStart.status).toBe(400);
    expect(await badStart.json()).toEqual({
      error: "started_at must be an integer (ms since epoch)",
    });
  });

  it("400 when the audio part is missing or the body is not multipart", async () => {
    const id = "eeee5eee-5eee-4eee-8eee-5eee5eee5eee";
    const form = importForm({
      name: "clip.wav",
      bytes: buildWav(),
      id,
      audioDir: meetingDir(id),
    });
    form.delete("audio");
    const missing = await postImport(form);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "audio field missing or not a file",
    });

    const raw = await postImport(buildWav(), {
      "Content-Type": "application/octet-stream",
    });
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({
      error: "Expected multipart/form-data",
    });
    expect(meetingRow(id)).toBeUndefined();
  });

  it("201 for a decodable container: decode called with original bytes, duration from the decoded WAV", async () => {
    const id = "ffff6fff-6fff-4fff-8fff-6fff6fff6fff";
    const dir = meetingDir(id);
    const input = new Uint8Array(512);
    for (let i = 0; i < input.length; i++) input[i] = (i * 31) & 0xff;
    const decoded = buildWav(8000); // 0.5 s
    mocks.decode.mockResolvedValue(decoded);

    const res = await postImport(
      importForm({ name: "memo.m4a", bytes: input, id, audioDir: dir }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ duration_ms: 500 });
    expect(body.ended_at).toBe(body.started_at + 500);

    expect(mocks.decode).toHaveBeenCalledTimes(1);
    expect(
      Buffer.from(mocks.decode.mock.calls[0][0] as Uint8Array).equals(
        Buffer.from(input),
      ),
    ).toBe(true);
    // The decoded (canonical) bytes are what lands on disk.
    expect(readFileSync(join(dir, "system.wav")).equals(decoded)).toBe(true);
    expect(meetingRow(id)).toMatchObject({ title: "memo", duration_ms: 500 });
  });

  it("422 with a fixed detail (no ffmpeg stderr) when decoding fails, and persists nothing", async () => {
    const id = "1a2b3c4d-5e6f-4a7b-8c9d-1a2b3c4d5e6f";
    const dir = meetingDir(id);
    mocks.decode.mockRejectedValue(
      new AudioDecodeError(
        "ffmpeg exited with code 1: /var/tmp/openstyle-decode-abc/input: Invalid data",
        "decode_failed",
      ),
    );

    const res = await postImport(
      importForm({
        name: "song.mp3",
        bytes: new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0]),
        id,
        audioDir: dir,
      }),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "Audio decode failed",
      detail: "ffmpeg could not decode the file",
      code: "AUDIO_DECODE_FAILED",
      reason: "decode_failed",
    });
    expect(meetingRow(id)).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it("500 with the created dir cleaned up when the INSERT fails after the write", async () => {
    const id = "2b3c4d5e-6f7a-4b8c-9d0e-2b3c4d5e6f7a";
    const dir = meetingDir(id);
    const db = getDb();
    db.exec(
      `CREATE TRIGGER import_insert_fail
       BEFORE INSERT ON meetings
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );

    try {
      const res = await postImport(
        importForm({
          name: "clip.wav",
          bytes: buildWav(1600),
          id,
          audioDir: dir,
        }),
      );

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal server error" });
      // No half-written meeting: the row is absent and the dir is gone, so
      // a retry isn't 409-blocked.
      expect(meetingRow(id)).toBeUndefined();
      expect(existsSync(dir)).toBe(false);
    } finally {
      db.exec("DROP TRIGGER import_insert_fail");
    }
  });
});
