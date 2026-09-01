import { describe, expect, it } from "vitest";
import {
  classifyImportError,
  importExtensionOf,
  isImportableFile,
} from "./import-audio";

describe("importExtensionOf", () => {
  it("returns the lowercase extension", () => {
    expect(importExtensionOf("recording.wav")).toBe("wav");
  });

  it("lowercases mixed-case extensions", () => {
    expect(importExtensionOf("recording.WAV")).toBe("wav");
  });

  it("returns null when there is no extension", () => {
    expect(importExtensionOf("noext")).toBeNull();
  });

  it("returns null when the name ends with a dot", () => {
    expect(importExtensionOf("trailing.")).toBeNull();
  });

  it("takes only the last extension for multi-dot names", () => {
    expect(importExtensionOf("archive.tar.gz")).toBe("gz");
  });
});

describe("isImportableFile", () => {
  it.each(["wav", "mp3", "m4a", "aac", "ogg", "mp4"])("accepts .%s", (ext) => {
    expect(isImportableFile(`recording.${ext}`)).toBe(true);
  });

  it("accepts uppercase extensions", () => {
    expect(isImportableFile("recording.WAV")).toBe(true);
  });

  it("rejects unsupported extensions", () => {
    expect(isImportableFile("note.txt")).toBe(false);
  });

  it("rejects files with no extension", () => {
    expect(isImportableFile("noext")).toBe(false);
  });

  it("rejects multi-dot files whose final extension is unsupported", () => {
    expect(isImportableFile("archive.tar.gz")).toBe(false);
  });
});

describe("classifyImportError", () => {
  it("classifies missing status as network", () => {
    expect(classifyImportError({})).toBe("network");
  });

  it("classifies 415 as unsupported_format", () => {
    expect(classifyImportError({ status: 415 })).toBe("unsupported_format");
  });

  it("classifies UNSUPPORTED_MEDIA_TYPE code as unsupported_format", () => {
    expect(
      classifyImportError({ status: 400, code: "UNSUPPORTED_MEDIA_TYPE" }),
    ).toBe("unsupported_format");
  });

  it("classifies 413 as too_large", () => {
    expect(classifyImportError({ status: 413 })).toBe("too_large");
  });

  it("classifies PAYLOAD_TOO_LARGE code as too_large", () => {
    expect(
      classifyImportError({ status: 400, code: "PAYLOAD_TOO_LARGE" }),
    ).toBe("too_large");
  });

  it("classifies 422 as decode", () => {
    expect(classifyImportError({ status: 422 })).toBe("decode");
  });

  it("classifies AUDIO_DECODE_FAILED code as decode", () => {
    expect(
      classifyImportError({ status: 400, code: "AUDIO_DECODE_FAILED" }),
    ).toBe("decode");
  });

  it("classifies plain 400 as config", () => {
    expect(classifyImportError({ status: 400 })).toBe("config");
  });

  it("classifies 500 as transcription", () => {
    expect(classifyImportError({ status: 500 })).toBe("transcription");
  });

  it("classifies unknown statuses as unknown", () => {
    expect(classifyImportError({ status: 999 })).toBe("unknown");
  });
});
