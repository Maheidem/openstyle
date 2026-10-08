/**
 * The forced-aligner helper (specs/meeting-transcription-v2.md section 3.6).
 *
 * The aligner turns (audio, text, language) into word times so a mixed
 * speaker chunk can be split at the diarizer's change times. It is a HELPER
 * model: the user is never asked about it (owner decision 2026-10-07 — the
 * server downloads it in the background), it is never offered as a
 * transcription model (it is outside the catalog; `isNotTranscriber` keeps
 * it out of the picker too), and everything runs on this Mac.
 *
 * The aligner is MODEL-AGNOSTIC: it aligns the text the meeting's STT
 * provider produced — Qwen3-ASR on oMLX or local MLX, Parakeet, Whisper,
 * cloud — so the gate below never looks at the meeting's provider.
 */

import { createAppLogger } from "@openstyle/utils";
import { getDb } from "../db.js";
import { getMeetingDiarizationEnabledSetting } from "../meetings/diarize.js";
import {
  isAppleSiliconMac,
  MLX_ALIGNER_MODEL,
  MLX_ALIGNER_MODEL_ID,
} from "./constants.js";
import { isMlxModelDownloaded } from "./models.js";
import { canRunMlxAsr } from "./server.js";

const log = createAppLogger("mlx-aligner");

/**
 * The aligner's 11 supported languages, from the repo's `config.json`
 * (`support_languages`, `mlx-community/Qwen3-ForcedAligner-0.6B-8bit`,
 * checked 2026-10-07). Portuguese IS supported — the owner's meetings mix
 * Portuguese and English.
 */
export const ALIGNER_SUPPORTED_LANGUAGES: readonly string[] = [
  "Chinese",
  "Cantonese",
  "English",
  "German",
  "Spanish",
  "French",
  "Italian",
  "Portuguese",
  "Russian",
  "Korean",
  "Japanese",
];

/**
 * Map an app language code (ISO-639-1, `getLanguagesSetting` format) to the
 * aligner's language NAME, or null when the aligner cannot handle it.
 * `zh-*` variants count as Chinese; `yue` (Cantonese) is its own language.
 */
export function alignerLanguageFor(code: string): string | null {
  const c = code.trim().toLowerCase();
  if (!c) return null;
  const base = c.split("-")[0] ?? c;
  const map: Record<string, string> = {
    zh: "Chinese",
    yue: "Cantonese",
    en: "English",
    de: "German",
    es: "Spanish",
    fr: "French",
    it: "Italian",
    pt: "Portuguese",
    ru: "Russian",
    ko: "Korean",
    ja: "Japanese",
  };
  return map[base] ?? null;
}

/**
 * Whether the background aligner download should start (3.6 step 1). Pure,
 * so the "starts once, only on Apple silicon with diarization on" rule is
 * unit-testable. `alreadyStarted` is the module-level once flag.
 */
export function shouldStartAlignerDownload(input: {
  appleSilicon: boolean;
  /** MLX runtime/python usable by the worker (`canRunMlxAsr`). */
  canRun: boolean;
  diarizationOn: boolean;
  /** At least one meeting row exists (the model is for meetings only). */
  hasMeeting: boolean;
  alreadyStarted: boolean;
}): boolean {
  return (
    !input.alreadyStarted &&
    input.appleSilicon &&
    input.canRun &&
    input.diarizationOn &&
    input.hasMeeting
  );
}

let autoDownloadStarted = false;

/**
 * Start the automatic aligner download (3.6 step 1): the first time a
 * meeting job starts, or at server start when a meeting exists. Fire-and-
 * forget — a download failure only leaves meetings on the phase 4 fallback;
 * the next trigger attempt (a later job) starts it again while the download
 * state reports the error. Starts at most once per server process.
 */
export function maybeStartAlignerDownload(
  opts: { download?: (modelId: string) => Promise<void> } = {},
): boolean {
  let hasMeeting = true;
  try {
    const row = getDb().prepare("SELECT 1 FROM meetings LIMIT 1").get();
    hasMeeting = row !== undefined;
  } catch {
    // No open database (a test calling this directly): do not start.
    hasMeeting = false;
  }

  const go = shouldStartAlignerDownload({
    appleSilicon: isAppleSiliconMac(),
    canRun: canRunMlxAsr(),
    diarizationOn: getMeetingDiarizationEnabledSetting(),
    hasMeeting,
    alreadyStarted: autoDownloadStarted,
  });
  if (!go) return false;
  autoDownloadStarted = true;

  const download =
    opts.download ??
    ((modelId: string) => {
      // Tests must never start the real 1.2 GB download. The gate and
      // the once flag stay testable (an injected `download` runs);
      // only the REAL default refuses in the test environment.
      if (process.env.NODE_ENV === "test") return Promise.resolve();
      // Lazy import: models.js pulls the download machinery, and this
      // fires from server start where it must not slow the boot.
      return import("./models.js").then((m) => m.downloadMlxModel(modelId));
    });
  void download(MLX_ALIGNER_MODEL_ID).catch((err) => {
    log.warn(
      `aligner download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  return true;
}

/** Test seam: reset the once flag (module state). */
export function _resetAlignerDownloadFlag(): void {
  autoDownloadStarted = false;
}

/**
 * Is the aligner usable for a meeting right now? The worker can load it
 * only when the model files are on disk (3.6 step 4, first fallback
 * reason). Read-only; never triggers a download.
 */
export function isAlignerModelReady(): boolean {
  return isMlxModelDownloaded(MLX_ALIGNER_MODEL);
}

/** The model id the aligner worker loads (exported for the route). */
export { MLX_ALIGNER_MODEL_ID };
