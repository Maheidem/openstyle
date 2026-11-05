import { describe, expect, it } from "vitest";
import type { LocalLlmItem } from "./models";
import {
  type DownloadLine,
  GIB,
  languageOutsideQwen,
  lowDisk,
  minutesLeft,
  nextStep,
  planDownload,
  prevStep,
  recommendText,
  recommendVoice,
  resumeStep,
  STEP,
  stepCounter,
  summarizeDownloads,
} from "./onboarding";

const QWEN = ["en", "es", "fr", "de", "pt", "ja", "zh", "nl"];

describe("recommendVoice", () => {
  const mac = { appleSilicon: true, ramBytes: 16 * GIB, qwenLanguages: QWEN };

  it("picks Qwen3 Fast when every language is in the Qwen3 set", () => {
    expect(recommendVoice({ ...mac, languages: ["en", "pt"] })).toEqual({
      engine: "mlx",
      defId: "qwen3-0.6b-8bit",
    });
  });

  it("picks Whisper Balanced when one language is outside the Qwen3 set", () => {
    expect(recommendVoice({ ...mac, languages: ["en", "uk"] })).toEqual({
      engine: "whisper",
      defId: "small-q5_1",
    });
  });

  it("picks Whisper Balanced for auto-detect", () => {
    expect(recommendVoice({ ...mac, languages: [] }).engine).toBe("whisper");
  });

  it("picks Whisper Balanced on an Intel Mac", () => {
    expect(
      recommendVoice({
        ...mac,
        appleSilicon: false,
        qwenLanguages: null,
        languages: ["en"],
      }).engine,
    ).toBe("whisper");
  });

  it("picks Whisper Balanced below 8 GiB of RAM, and Qwen3 at exactly 8 GiB", () => {
    expect(
      recommendVoice({ ...mac, ramBytes: 4 * GIB, languages: ["en"] }).engine,
    ).toBe("whisper");
    expect(
      recommendVoice({ ...mac, ramBytes: 8 * GIB, languages: ["en"] }).engine,
    ).toBe("mlx");
  });

  it("does not read a missing profile as a Qwen3 Mac", () => {
    expect(
      recommendVoice({ ...mac, ramBytes: null, languages: ["en"] }).engine,
    ).toBe("whisper");
  });
});

describe("languageOutsideQwen", () => {
  it("warns for a Qwen3 pick with a language outside the set", () => {
    const pick = { engine: "mlx", defId: "qwen3-0.6b-8bit" } as const;
    expect(
      languageOutsideQwen({
        pick,
        languages: ["en", "uk"],
        qwenLanguages: QWEN,
      }),
    ).toBe(true);
    expect(
      languageOutsideQwen({ pick, languages: ["en"], qwenLanguages: QWEN }),
    ).toBe(false);
  });

  it("never warns for Whisper", () => {
    expect(
      languageOutsideQwen({
        pick: { engine: "whisper", defId: "small-q5_1" },
        languages: ["uk"],
        qwenLanguages: QWEN,
      }),
    ).toBe(false);
  });
});

function llm(
  id: string,
  label: "runs_well" | "tight" | "wont_fit",
  recommended = false,
): LocalLlmItem {
  return {
    key: id,
    defId: id,
    name: id,
    sizeBytes: 4 * GIB,
    recommended,
    selected: false,
    status: "not_downloaded",
    state: {} as LocalLlmItem["state"],
    fit: { label } as LocalLlmItem["fit"],
  };
}

describe("recommendText", () => {
  it("takes the recommended model", () => {
    expect(
      recommendText([llm("a", "runs_well"), llm("b", "tight", true)])?.defId,
    ).toBe("b");
  });

  it("takes the first model that fits when the recommended one does not", () => {
    expect(
      recommendText([
        llm("big", "wont_fit"),
        llm("rec", "wont_fit", true),
        llm("small", "tight"),
      ])?.defId,
    ).toBe("small");
  });

  it("gives null when nothing fits or the list is empty", () => {
    expect(recommendText([llm("x", "wont_fit", true)])).toBeNull();
    expect(recommendText([])).toBeNull();
  });
});

describe("planDownload", () => {
  const worker = 174_000_000;

  it("adds the worker once for the recommended pair", () => {
    const plan = planDownload({
      voice: { engine: "mlx", sizeBytes: 1_010_773_761, ready: false },
      text: { sizeBytes: 4_361_680_121, ready: false },
      mlxWorkerBytes: worker,
    });
    expect(plan.total).toBe(1_010_773_761 + worker + 4_361_680_121);
  });

  it("adds no worker for Whisper alone", () => {
    const plan = planDownload({
      voice: { engine: "whisper", sizeBytes: 181_000_000, ready: false },
      text: null,
      mlxWorkerBytes: worker,
    });
    expect(plan).toEqual({
      voiceBytes: 181_000_000,
      workerBytes: 0,
      textBytes: 0,
      total: 181_000_000,
    });
  });

  it("needs the worker for a text model next to a Whisper voice model", () => {
    const plan = planDownload({
      voice: { engine: "whisper", sizeBytes: 181_000_000, ready: false },
      text: { sizeBytes: 1_000, ready: false },
      mlxWorkerBytes: worker,
    });
    expect(plan.workerBytes).toBe(worker);
  });

  it("is 0 when voice and text are remote or ready", () => {
    expect(
      planDownload({ voice: null, text: null, mlxWorkerBytes: worker }).total,
    ).toBe(0);
    expect(
      planDownload({
        voice: { engine: "mlx", sizeBytes: 1, ready: true },
        text: { sizeBytes: 1, ready: true },
        mlxWorkerBytes: worker,
      }).total,
    ).toBe(0);
  });
});

describe("lowDisk", () => {
  const plan = { voiceBytes: 1, workerBytes: 0, textBytes: 0, total: 1_000 };
  it("warns below 1.5 times the download", () => {
    expect(lowDisk(plan, 1_400)).toEqual({ need: 1_500, have: 1_400 });
  });
  it("is quiet with enough room, an unknown disk, or no download", () => {
    expect(lowDisk(plan, 1_500)).toBeNull();
    expect(lowDisk(plan, null)).toBeNull();
    expect(lowDisk({ ...plan, total: 0 }, 1)).toBeNull();
  });
});

describe("step flow", () => {
  const all = { meetings: true, voiceLater: false };

  it("walks the full list", () => {
    const seen: number[] = [STEP.welcome];
    while (seen[seen.length - 1] !== STEP.ready) {
      seen.push(nextStep(seen[seen.length - 1], all));
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("skips Try it after Decide later", () => {
    const o = { meetings: true, voiceLater: true };
    expect(nextStep(STEP.permissions, o)).toBe(STEP.name);
    expect(prevStep(STEP.name, o)).toBe(STEP.permissions);
  });

  it("skips Name and Enhance without the meetings flag", () => {
    const o = { meetings: false, voiceLater: false };
    expect(nextStep(STEP.tryIt, o)).toBe(STEP.ready);
    expect(prevStep(STEP.ready, o)).toBe(STEP.tryIt);
  });

  it("counts the visible steps only", () => {
    expect(stepCounter(STEP.language, all)).toEqual({ index: 1, total: 6 });
    expect(stepCounter(STEP.enhance, all)).toEqual({ index: 6, total: 6 });
    expect(
      stepCounter(STEP.tryIt, { meetings: false, voiceLater: false }),
    ).toEqual({ index: 4, total: 4 });
    expect(stepCounter(STEP.welcome, all)).toBeNull();
    expect(stepCounter(STEP.ready, all)).toBeNull();
  });

  it("resumes at the saved step, and moves on from a hidden one", () => {
    expect(resumeStep(0, all)).toBe(STEP.welcome);
    expect(resumeStep(3, all)).toBe(STEP.permissions);
    expect(resumeStep(7, all)).toBe(STEP.ready);
    expect(resumeStep(STEP.tryIt, { meetings: true, voiceLater: true })).toBe(
      STEP.name,
    );
    expect(resumeStep(STEP.name, { meetings: false, voiceLater: false })).toBe(
      STEP.ready,
    );
  });
});

describe("summarizeDownloads", () => {
  const line = (over: Partial<DownloadLine>): DownloadLine => ({
    kind: "voice",
    name: "Qwen3 Fast",
    status: "not_downloaded",
    bytesDownloaded: 0,
    bytesTotal: 1_000,
    speedBps: 0,
    ...over,
  });

  it("is idle before the button", () => {
    expect(summarizeDownloads([line({})], false).state).toBe("idle");
    expect(summarizeDownloads([], true).state).toBe("idle");
  });

  it("shows progress and time left", () => {
    const s = summarizeDownloads(
      [line({ status: "downloading", bytesDownloaded: 500, speedBps: 10 })],
      true,
    );
    expect(s.state).toBe("running");
    expect(s.percent).toBe(50);
    expect(s.secondsLeft).toBe(50);
    expect(minutesLeft(s.secondsLeft)).toBe(1);
  });

  it("is done when every line is ready", () => {
    expect(
      summarizeDownloads(
        [line({ status: "ready" }), line({ kind: "text", status: "ready" })],
        true,
      ).state,
    ).toBe("done");
  });

  it("is stopped after a quit: started, nothing runs, not ready", () => {
    expect(summarizeDownloads([line({})], true).state).toBe("failed");
  });

  it("is failed on an error line", () => {
    const s = summarizeDownloads(
      [line({ status: "error", error: "no network" })],
      true,
    );
    expect(s.state).toBe("failed");
    expect(s.error).toBe("no network");
  });
});
