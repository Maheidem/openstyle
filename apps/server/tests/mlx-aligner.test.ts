/**
 * I4b (specs/meeting-transcription-v2.md §3.6): the aligner helper's
 * language mapping and the automatic-download gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import {
  _resetAlignerDownloadFlag,
  ALIGNER_SUPPORTED_LANGUAGES,
  alignerLanguageFor,
  maybeStartAlignerDownload,
  shouldStartAlignerDownload,
} from "../src/lib/mlx-asr/aligner.js";

// The gate's platform inputs are host-dependent (Apple silicon + MLX
// runtime); force them on so the once-flag test is platform-neutral
// (Linux CI has neither). Everything else in those modules stays real.
vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));
vi.mock("../src/lib/mlx-asr/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/server.js")>()),
  canRunMlxAsr: () => true,
}));

describe("aligner language mapping (I4b, §3.6)", () => {
  it("maps the app's codes to the aligner's 11 names", () => {
    // The 11 names come from the model's config.json support_languages
    // (checked 2026-10-07) and must stay the source of truth.
    expect(ALIGNER_SUPPORTED_LANGUAGES).toHaveLength(11);
    // Portuguese IS supported — the owner's meetings mix it with English.
    expect(alignerLanguageFor("pt")).toBe("Portuguese");
    expect(alignerLanguageFor("pt-PT")).toBe("Portuguese");
    expect(alignerLanguageFor("en")).toBe("English");
    expect(alignerLanguageFor("ES")).toBe("Spanish");
    expect(alignerLanguageFor("de")).toBe("German");
    expect(alignerLanguageFor("fr")).toBe("French");
    expect(alignerLanguageFor("it")).toBe("Italian");
    expect(alignerLanguageFor("ru")).toBe("Russian");
    expect(alignerLanguageFor("ja")).toBe("Japanese");
    expect(alignerLanguageFor("ko")).toBe("Korean");
    expect(alignerLanguageFor("zh")).toBe("Chinese");
    expect(alignerLanguageFor("zh-CN")).toBe("Chinese");
    expect(alignerLanguageFor("yue")).toBe("Cantonese");
  });

  it("is null for languages the aligner does not cover", () => {
    expect(alignerLanguageFor("nl")).toBeNull();
    expect(alignerLanguageFor("tr")).toBeNull();
    expect(alignerLanguageFor("")).toBeNull();
  });
});

describe("shouldStartAlignerDownload (I4b, §3.6 step 1)", () => {
  const base = {
    appleSilicon: true,
    canRun: true,
    diarizationOn: true,
    hasMeeting: true,
    alreadyStarted: false,
  };

  it("starts only on Apple silicon with the runtime, diarization on, a meeting, and once", () => {
    expect(shouldStartAlignerDownload(base)).toBe(true);
    expect(shouldStartAlignerDownload({ ...base, appleSilicon: false })).toBe(
      false,
    );
    expect(shouldStartAlignerDownload({ ...base, canRun: false })).toBe(false);
    expect(shouldStartAlignerDownload({ ...base, diarizationOn: false })).toBe(
      false,
    );
    expect(shouldStartAlignerDownload({ ...base, hasMeeting: false })).toBe(
      false,
    );
    expect(shouldStartAlignerDownload({ ...base, alreadyStarted: true })).toBe(
      false,
    );
  });
});

describe("maybeStartAlignerDownload (I4b, §3.6 step 1)", () => {
  beforeEach(() => _resetAlignerDownloadFlag());

  it("starts the download once and never twice (the once flag)", () => {
    // Seed a meeting row so the "a meeting exists" gate input is true
    // (the test DB is otherwise empty); diarization is default-on.
    getDb()
      .prepare(
        "INSERT INTO meetings (id, status, audio_dir, duration_ms) VALUES (?, 'recorded', ?, 1000)",
      )
      .run("aligner-test-meeting", "/tmp");
    const calls: string[] = [];
    const first = maybeStartAlignerDownload({
      download: (id) => {
        calls.push(id);
        return Promise.resolve();
      },
    });
    const second = maybeStartAlignerDownload({
      download: (id) => {
        calls.push(id);
        return Promise.resolve();
      },
    });
    // Synchronously: the flag flips before the download is even called.
    expect(second).toBe(false);
    expect(first).toBe(true); // Apple silicon + runtime + diarization on + meeting
    expect(calls).toEqual(["qwen3-forced-aligner-0.6b-8bit"]);
  });
});
