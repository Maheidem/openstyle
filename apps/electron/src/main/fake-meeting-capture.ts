import { readFileSync } from "node:fs";

/**
 * E2E seam for Meeting Mode. With OPENSTYLE_E2E=1 and
 * OPENSTYLE_E2E_FAKE_MEETING_CAPTURE=1, the recorder writes silence to both
 * tracks. It opens no audio device, starts no native helper and runs no
 * permission probe, so no macOS privacy dialog can appear. This also lets a
 * Linux CI run record a meeting. A run without OPENSTYLE_E2E=1 ignores the
 * flag.
 */
export function isFakeMeetingCapture(): boolean {
  return (
    process.env.OPENSTYLE_E2E === "1" &&
    process.env.OPENSTYLE_E2E_FAKE_MEETING_CAPTURE === "1"
  );
}

/**
 * Optional audio for the fake capture (issue #375). With
 * OPENSTYLE_E2E_FAKE_MEETING_AUDIO=<16 kHz mono s16 WAV>, the recorder
 * streams this file in real time into the mic track instead of silence. The
 * system track stays silent. It needs OPENSTYLE_E2E=1 too. Returns the PCM
 * bytes, or null when the seam is off or the file is not usable.
 */
export function readFakeMeetingAudioPcm(): Buffer | null {
  const path = process.env.OPENSTYLE_E2E_FAKE_MEETING_AUDIO;
  if (!path || !isFakeMeetingCapture()) return null;
  const wav = readFileSync(path);
  // Find the "data" chunk. Skip the other chunks.
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      return wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}
