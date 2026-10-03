import { writeFileSync } from "node:fs";

/** Builds a mono, 16-bit PCM WAV file (44-byte header, then the samples). */
export function pcm16Wav(samples: Int16Array, sampleRate = 16_000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const dataSize = samples.length * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}

/** Writes a minimal valid 1 s, 16 kHz mono, 16-bit PCM WAV file (silence). */
export function writeSilentWav(path: string): void {
  writeFileSync(path, pcm16Wav(new Int16Array(16_000)));
}
