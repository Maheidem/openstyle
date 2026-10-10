import { describe, expect, it } from "vitest";
import {
  createFrameParser,
  type MeetingCaptureChannel,
} from "./meeting-capture-protocol";

/** Builds one wire frame: channel byte, uint32 LE length, payload. */
function frame(channel: "M" | "S", payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = channel.charCodeAt(0);
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

type Received = { channel: MeetingCaptureChannel; pcm: Buffer };

/** Creates a parser that records every frame it emits. */
function recorder() {
  const frames: Received[] = [];
  const parser = createFrameParser((channel, pcm) => {
    frames.push({ channel, pcm });
  });
  return { frames, parser };
}

const samplePayload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

describe("createFrameParser", () => {
  it("emits one frame that arrives in one chunk", () => {
    const { frames, parser } = recorder();
    parser.push(frame("M", samplePayload));

    expect(frames).toEqual([{ channel: "M", pcm: samplePayload }]);
  });

  it("emits the frame once when split at every byte position", () => {
    const wire = frame("S", samplePayload);

    for (let split = 0; split <= wire.length; split++) {
      const { frames, parser } = recorder();
      parser.push(wire.subarray(0, split));
      parser.push(wire.subarray(split));

      expect(frames, `split at byte ${split}`).toEqual([
        { channel: "S", pcm: samplePayload },
      ]);
    }
  });

  it("emits the frame when fed one byte at a time", () => {
    const { frames, parser } = recorder();
    const wire = frame("M", samplePayload);
    for (const byte of wire) {
      parser.push(Buffer.from([byte]));
    }

    expect(frames).toEqual([{ channel: "M", pcm: samplePayload }]);
  });

  it("emits several frames that arrive in one chunk", () => {
    const { frames, parser } = recorder();
    const first = Buffer.from([10, 11]);
    const second = Buffer.from([20, 21, 22]);
    const third = Buffer.from([30]);
    parser.push(
      Buffer.concat([frame("M", first), frame("S", second), frame("M", third)]),
    );

    expect(frames).toEqual([
      { channel: "M", pcm: first },
      { channel: "S", pcm: second },
      { channel: "M", pcm: third },
    ]);
  });

  it("keeps the order of mixed M and S frames across chunks", () => {
    const { frames, parser } = recorder();
    const wire = Buffer.concat([
      frame("M", Buffer.from([1])),
      frame("S", Buffer.from([2, 2])),
      frame("S", Buffer.from([3, 3, 3])),
      frame("M", Buffer.from([4, 4, 4, 4])),
      frame("S", Buffer.from([5])),
    ]);
    // Cut into 3-byte pieces so frames break across chunks.
    for (let i = 0; i < wire.length; i += 3) {
      parser.push(wire.subarray(i, i + 3));
    }

    expect(frames.map((f) => f.channel)).toEqual(["M", "S", "S", "M", "S"]);
    expect(frames.map((f) => [...f.pcm])).toEqual([
      [1],
      [2, 2],
      [3, 3, 3],
      [4, 4, 4, 4],
      [5],
    ]);
  });

  it("emits a zero-length payload with no data bytes", () => {
    const { frames, parser } = recorder();
    parser.push(frame("M", Buffer.alloc(0)));
    parser.push(frame("S", samplePayload));
    parser.push(frame("S", Buffer.alloc(0)));

    expect(frames).toEqual([
      { channel: "M", pcm: Buffer.alloc(0) },
      { channel: "S", pcm: samplePayload },
      { channel: "S", pcm: Buffer.alloc(0) },
    ]);
  });

  it("emits a zero-length payload when its header is split", () => {
    const { frames, parser } = recorder();
    const wire = frame("M", Buffer.alloc(0));
    parser.push(wire.subarray(0, 2));
    expect(frames).toEqual([]);
    parser.push(wire.subarray(2));

    expect(frames).toEqual([{ channel: "M", pcm: Buffer.alloc(0) }]);
  });

  it("throws on an unknown channel byte", () => {
    const { frames, parser } = recorder();
    const bad = Buffer.from([0x58, 0, 0, 0, 0]); // 'X', length 0

    expect(() => parser.push(bad)).toThrow(/channel byte 0x58/);
    expect(frames).toEqual([]);
  });

  it("throws on an unknown channel byte that follows a valid frame", () => {
    const { frames, parser } = recorder();
    parser.push(frame("M", samplePayload));

    expect(() => parser.push(Buffer.from([0x00]))).toThrow(/channel byte 0x0/);
    expect(frames).toEqual([{ channel: "M", pcm: samplePayload }]);
  });

  it("emits a large 1 MB payload intact when delivered in 64 KB chunks", () => {
    const size = 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
      payload[i] = (i * 31) & 0xff;
    }
    const wire = frame("S", payload);

    const { frames, parser } = recorder();
    const chunkSize = 64 * 1024;
    for (let i = 0; i < wire.length; i += chunkSize) {
      parser.push(wire.subarray(i, i + chunkSize));
    }

    expect(frames).toHaveLength(1);
    expect(frames[0].channel).toBe("S");
    expect(frames[0].pcm.length).toBe(size);
    expect(frames[0].pcm.equals(payload)).toBe(true);
  });
});
