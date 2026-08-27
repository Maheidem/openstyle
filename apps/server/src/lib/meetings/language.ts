/**
 * Meeting-level transcription language resolution (Phase A2,
 * specs/meeting-transcription-quality.md §3.2).
 *
 * `resolveConfig()` (`transcriber.ts`) pins whatever `getLanguagesSetting()`
 * returns at index [0] on every chunk — correct for a single declared
 * language, wrong for a multi-language user (e.g. `["en", "pt"]`): every
 * secondary language is silently discarded and a non-primary-language call
 * gets *translated* into the primary language instead of transcribed
 * (investigation finding #2). This module resolves the correct language
 * **once per meeting** (not once per job run — including re-transcribe) and
 * persists it to `meetings.language`, so every later job for the same
 * meeting reuses the decision without re-probing.
 */

import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { getDb } from "../db.js";
import { waitForDictationIdle } from "../dictation-activity.js";
import { getLanguagesSetting } from "../language.js";
import type {
  TranscribeOptions,
  TranscriptionProvider,
} from "../streaming/types.js";
import { WHISPER_PROVIDER_ID } from "../whisper/constants.js";
import type { Segment } from "./segmenter.js";
import type { SttConfig } from "./transcriber.js";
import { parseWavHeader, sliceWav } from "./transcriber.js";

const log = createAppLogger("meeting-language");

/**
 * Ranked language-ID candidate, shaped like `tinyld`'s `detectAll` output
 * (ISO-639-1 codes) so a test double can stand in without importing tinyld.
 */
export interface LidCandidate {
  lang: string;
  accuracy: number;
}

/** Injectable text-based language-ID function — real impl is tinyld's `detectAll`. */
export type DetectAllFn = (text: string) => LidCandidate[];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Read the already-resolved (or user-set) language for a meeting, if any. */
export function readMeetingLanguage(meetingId: string): string | undefined {
  const row = getDb()
    .prepare("SELECT language FROM meetings WHERE id = ?")
    .get(meetingId) as { language: string | null } | undefined;
  return row?.language ?? undefined;
}

/** Persist the resolved (or user-set) language for a meeting. */
export function persistMeetingLanguage(
  meetingId: string,
  language: string,
): void {
  getDb()
    .prepare("UPDATE meetings SET language = ? WHERE id = ?")
    .run(language, meetingId);
}

// ---------------------------------------------------------------------------
// Probe segment selection
// ---------------------------------------------------------------------------

export interface ProbeSegment {
  source: "mic" | "system";
  startMs: number;
  endMs: number;
}

/**
 * Pick the longest early segment across both channels to use as the
 * language-ID probe — long enough to give text-based LID real signal, early
 * enough to resolve the language before most of the meeting has already
 * been (mis-)transcribed.
 */
export function pickProbeSegment(
  mic: Segment[],
  system: Segment[],
): ProbeSegment | null {
  const EARLY_COUNT = 10;
  const MIN_PROBE_MS = 1000;
  const candidates: ProbeSegment[] = [
    ...mic.slice(0, EARLY_COUNT).map((s) => ({ source: "mic" as const, ...s })),
    ...system
      .slice(0, EARLY_COUNT)
      .map((s) => ({ source: "system" as const, ...s })),
  ];
  if (candidates.length === 0) return null;
  const long = candidates.filter((c) => c.endMs - c.startMs >= MIN_PROBE_MS);
  const pool = long.length > 0 ? long : candidates; // permissive: use whatever exists
  return pool.reduce((best, c) =>
    c.endMs - c.startMs > best.endMs - best.startMs ? c : best,
  );
}

/** Slice a probe segment's audio out of the meeting's mic.wav/system.wav. */
export function sliceProbeAudio(
  audioDir: string,
  probe: ProbeSegment,
): Uint8Array {
  const path = join(
    audioDir,
    probe.source === "mic" ? "mic.wav" : "system.wav",
  );
  const fd = openSync(path, "r");
  try {
    const info = parseWavHeader(fd);
    return sliceWav(fd, info, probe.startMs, probe.endMs);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Text-based LID over the declared set
// ---------------------------------------------------------------------------

/**
 * No confirmed way to *constrain* tinyld's `detectAll` to a candidate list
 * in its published API, so this ranks over the **full** result and picks
 * the highest-ranked entry that's in the user's declared set, rather than
 * assuming an `only`-style option exists.
 *
 * Coverage note (implementation task from spec §3.2.1, verified): tinyld's
 * `supportedLanguages` (mapped through its `toISO2`) covers every code in
 * `ISO_LANGUAGE_NAMES` (`lib/language.ts`) except `ms` (Malay) — for a user
 * who declares `ms` alongside another language, detection can never surface
 * `ms` as a candidate and resolution always falls back to `declared[0]`
 * (documented in the failure-mode table, §4: "no candidate from the
 * declared set" is an accepted, logged fallback, not a crash).
 */
export function pickDeclaredLanguage(
  text: string,
  declared: string[],
  detectAll: DetectAllFn,
): string | null {
  const ranked = detectAll(text);
  const hit = ranked.find((r) => declared.includes(r.lang));
  return hit?.lang ?? null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveMeetingLanguageInput {
  meetingId: string;
  audioDir: string;
  provider: TranscriptionProvider;
  config: Pick<SttConfig, "providerId" | "modelId" | "apiKey">;
  micSegments: Segment[];
  systemSegments: Segment[];
  /** Same dictation-yield lease `MeetingTranscriber` uses. */
  isDictationActive?: () => boolean;
  /** Injected for tests; defaults to tinyld's `detectAll` (lazy-imported). */
  detectAll?: DetectAllFn;
}

/**
 * Resolve the transcription language for a meeting, once. Reuses
 * `meetings.language` if already set (by a prior run or a user edit) —
 * sticky until the user explicitly changes it, unlike diarization, because
 * language rarely changes meeting-to-meeting for the same user and a wrong
 * guess is directly fixable by hand.
 */
export async function resolveMeetingLanguage(
  input: ResolveMeetingLanguageInput,
): Promise<string | undefined> {
  const existing = readMeetingLanguage(input.meetingId);
  if (existing) return existing;

  const declared = getLanguagesSetting();
  if (declared.length === 0) return undefined; // unchanged: per-chunk auto
  if (declared.length === 1) {
    persistMeetingLanguage(input.meetingId, declared[0]);
    return declared[0];
  }

  const probe = pickProbeSegment(input.micSegments, input.systemSegments);
  const fallback = declared[0]; // first-declared wins when detection can't decide
  if (!probe) {
    log.warn(
      `meeting ${input.meetingId}: no probe segment available, defaulting to ${fallback}`,
    );
    persistMeetingLanguage(input.meetingId, fallback);
    return fallback;
  }

  let text = "";
  try {
    if (input.config.providerId === WHISPER_PROVIDER_ID) {
      // Same shared-ANE-resource yield contract as every other whisper-local
      // call in this pipeline — the probe is one more transcription call and
      // must not fire mid-dictation.
      await waitForDictationIdle({
        isDictationActive: input.isDictationActive,
      });
    }
    const audio = sliceProbeAudio(input.audioDir, probe);
    const opts: TranscribeOptions = {
      audio,
      model: input.config.modelId,
      apiKey: input.config.apiKey,
      language: undefined, // auto — the whole point is to observe what the model does unpinned
      bias: null, // never bias the probe: vocabulary words would skew language ID
    };
    const result = await input.provider.transcribe(opts);
    text = result.text.trim();
  } catch (err) {
    log.warn(
      `meeting ${input.meetingId}: language probe failed, defaulting to ${fallback}: ${String(err)}`,
    );
  }

  let resolved = fallback;
  if (text) {
    const detectAll = input.detectAll ?? (await defaultDetectAll());
    resolved = pickDeclaredLanguage(text, declared, detectAll) ?? fallback;
  }
  persistMeetingLanguage(input.meetingId, resolved);
  return resolved;
}

/** Lazy import so tinyld (a real dependency, but only needed on this path) never loads for single/zero-language users. */
async function defaultDetectAll(): Promise<DetectAllFn> {
  const { detectAll } = await import("tinyld");
  return detectAll;
}
