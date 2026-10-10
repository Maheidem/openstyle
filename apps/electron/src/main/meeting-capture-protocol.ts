/**
 * Meeting Capture Frame Parser
 *
 * Reads the binary frames that the macos-meeting-capture helper writes to
 * stdout. Each frame has three parts:
 *   1 byte   channel: 0x4d ('M', mic) or 0x53 ('S', system)
 *   4 bytes  payload length, uint32, little-endian
 *   N bytes  payload, PCM16 little-endian, mono, 16 kHz
 *
 * A pipe chunk can end in the middle of a frame. One chunk can also hold
 * several frames. The parser keeps its state between pushes.
 */

export type MeetingCaptureChannel = "M" | "S";

export interface MeetingCaptureFrameParser {
  /** Feeds one stdout chunk. Throws on an unknown channel byte. */
  push(chunk: Buffer): void;
}

const HEADER_BYTES = 5;
const CHANNEL_BYTES: Record<number, MeetingCaptureChannel> = {
  77: "M",
  83: "S",
};

/**
 * Creates a parser. It calls `onFrame` once for each complete frame, in
 * stream order. The payload is a copy that the caller may keep.
 *
 * An unknown channel byte means the stream is out of step. The parser
 * clears its state and throws. The caller must then stop the helper.
 */
export function createFrameParser(
  onFrame: (channel: MeetingCaptureChannel, pcm: Buffer) => void,
): MeetingCaptureFrameParser {
  const header = Buffer.alloc(HEADER_BYTES);
  let headerFill = 0;

  // Set only while a payload is being read.
  let channel: MeetingCaptureChannel | null = null;
  let payloadLength = 0;
  let payloadFill = 0;
  let payloadParts: Buffer[] = [];

  const resetPayload = (): void => {
    channel = null;
    payloadLength = 0;
    payloadFill = 0;
    payloadParts = [];
  };

  const emitFrame = (): void => {
    const pcm =
      payloadParts.length === 1
        ? payloadParts[0]
        : Buffer.concat(payloadParts, payloadLength);
    const frameChannel = channel as MeetingCaptureChannel;
    resetPayload();
    onFrame(frameChannel, pcm);
  };

  return {
    push(chunk: Buffer): void {
      let offset = 0;
      while (offset < chunk.length) {
        if (channel === null) {
          // Check the channel byte as soon as it arrives.
          if (headerFill === 0) {
            const code = chunk[offset];
            if (CHANNEL_BYTES[code] === undefined) {
              throw new Error(
                `Unknown meeting capture channel byte 0x${code.toString(16)}`,
              );
            }
          }
          // Read the rest of the header. It can span several chunks.
          const take = Math.min(
            HEADER_BYTES - headerFill,
            chunk.length - offset,
          );
          chunk.copy(header, headerFill, offset, offset + take);
          headerFill += take;
          offset += take;
          if (headerFill < HEADER_BYTES) return;

          headerFill = 0;
          channel = CHANNEL_BYTES[header[0]];
          payloadLength = header.readUInt32LE(1);
          if (payloadLength === 0) emitFrame();
        } else {
          // Read the payload. It can span several chunks.
          const take = Math.min(
            payloadLength - payloadFill,
            chunk.length - offset,
          );
          payloadParts.push(Buffer.from(chunk.subarray(offset, offset + take)));
          payloadFill += take;
          offset += take;
          if (payloadFill === payloadLength) emitFrame();
        }
      }
    },
  };
}
