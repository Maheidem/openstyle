import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createAppLogger } from "@openstyle/utils";
import { SYNC_JSON } from "@openstyle/validations";
import { getDb } from "../db.js";
import { notifyMeetingChanged } from "../search/notify.js";
import { loadVocabularyTerms } from "../vocabulary.js";
import {
  formatTranscriptMarkdown,
  type MergedSegment,
  mergeTranscript,
  type SyncData,
  type TranscriptSegment,
} from "./merge.js";
import { resolveSpeakerNames } from "./speaker-names.js";
import { type MeetingRow, parseAttendees } from "./store.js";

// Transcript loading and export, moved out of the meetings route so the
// workflow runner can import them (specs/meeting-enhance-agentic.md 3.1). No
// behavior change.

const log = createAppLogger("meetings");

/**
 * Map the recorder's `sync.json` journal (meeting-recorder.ts SyncJournal)
 * onto the merge helper's SyncData: per-channel t0 epochs plus the system
 * helper's wallclock/sample markers.
 */
function loadSyncData(audioDir: string): SyncData | undefined {
  try {
    const j = JSON.parse(readFileSync(join(audioDir, SYNC_JSON), "utf8")) as {
      sampleRate?: number;
      micT0?: number | null;
      systemT0?: number | null;
      syncMarkers?: Array<{ wallclockMs?: number; totalSamples?: number }>;
      sharedClock?: boolean;
    };
    if (!Number.isFinite(j.sampleRate)) return undefined;
    const sync: SyncData = {
      sampleRate: j.sampleRate as number,
      epochs: [],
      syncMarkers: [],
    };
    if (typeof j.micT0 === "number") {
      sync.epochs?.push({ channel: "mic", t0WallclockMs: j.micT0 });
    }
    if (typeof j.systemT0 === "number") {
      sync.epochs?.push({ channel: "system", t0WallclockMs: j.systemT0 });
    }
    // One native helper recorded both channels on one clock. They cannot
    // drift apart. A correction of one channel would only create an offset.
    const markers = j.sharedClock === true ? [] : (j.syncMarkers ?? []);
    for (const m of markers) {
      if (
        typeof m.wallclockMs === "number" &&
        typeof m.totalSamples === "number"
      ) {
        // Markers come from the system-audio helper only.
        sync.syncMarkers?.push({
          channel: "system",
          wallclockMs: m.wallclockMs,
          totalSamples: m.totalSamples,
        });
      }
    }
    return sync;
  } catch {
    return undefined;
  }
}

export interface SegmentRow {
  id?: string;
  source: "mic" | "system";
  start_ms: number;
  end_ms: number;
  text: string | null;
  status: string | null;
  /** Diarization label (system channel only, spec §6). Optional: the
   * retry-failed handler's SELECT doesn't fetch it, and mic rows never have
   * one. */
  speaker_label?: string | null;
  /** LLM-corrected text, Phase C §6.1. Optional: the retry-failed handler's
   * SELECT doesn't fetch it. */
  enhanced_text?: string | null;
}

/** Rebuild the merged Me/Them transcript from persisted segments + sync.json. */
export function loadMergedTranscript(
  meetingId: string,
  audioDir: string | null,
  db: DatabaseSync = getDb(),
): MergedSegment[] {
  const rows = db
    .prepare(
      `SELECT id, source, start_ms, end_ms, text, status, speaker_label, enhanced_text
       FROM meeting_segments WHERE meeting_id = ? ORDER BY idx, start_ms, id`,
    )
    .all(meetingId) as unknown as SegmentRow[];
  const channel = (source: "mic" | "system"): TranscriptSegment[] =>
    rows
      .filter((r) => r.source === source && r.status === "ok" && r.text)
      .map((r) => ({
        startMs: r.start_ms,
        endMs: r.end_ms,
        text: r.text as string,
        ...(r.speaker_label ? { speakerLabel: r.speaker_label } : {}),
        ...(r.id ? { id: r.id } : {}),
        ...(r.enhanced_text ? { enhancedText: r.enhanced_text } : {}),
      }));
  const sync = audioDir ? loadSyncData(audioDir) : undefined;
  // Phase A1 backstop (specs/meeting-transcription-quality.md §3.1): checks
  // against the *current* vocabulary, not whatever it was at transcription
  // time — best-effort for rows persisted before persistChunk's own leak
  // check existed, or whose leak check false-negatived at persist time.
  const merged = mergeTranscript(
    channel("mic"),
    channel("system"),
    sync,
    loadVocabularyTerms(),
  );
  // Meeting speaker naming (specs/meeting-speaker-naming.md §4): a
  // post-process pass over the already-built merged transcript, never a
  // change to mergeTranscript's own pure contract. Every consumer of this
  // function — transcript UI, Enhance input, Summarize input, markdown
  // export — goes through here, so this one call covers all of them.
  const speakerRows = db
    .prepare(
      "SELECT speaker_label, display_name, merged_into FROM meeting_speakers WHERE meeting_id = ?",
    )
    .all(meetingId) as unknown as {
    speaker_label: string;
    display_name: string | null;
    merged_into: string | null;
  }[];
  resolveSpeakerNames(
    merged,
    speakerRows.map((r) => ({
      speakerLabel: r.speaker_label,
      displayName: r.display_name,
      mergedInto: r.merged_into,
    })),
  );
  return merged;
}

/**
 * Write the merged transcript as `transcript.md` into the meeting's audio
 * dir so the folder is self-contained. Best-effort: a write failure (e.g.
 * the dir was purged mid-job) never fails the surrounding job.
 *
 * Phase C (specs/meeting-transcription-quality.md §6.8, amended
 * 2026-08-27): `transcript.md` is always the RAW transcript — Enhance must
 * never touch it, regardless of which route triggers this write. When any
 * segment carries `enhancedText`, a second sibling file,
 * `transcript-enhanced.md`, is written (or overwritten) alongside it; it
 * does not exist until the first successful Enhance run.
 */
export function writeTranscriptMarkdown(
  meetingId: string,
  audioDir: string,
  db: DatabaseSync = getDb(),
): void {
  // Every site that changes meeting text writes this file, so this is the
  // change hint of the search index (specs/local-semantic-search.md 6.2).
  notifyMeetingChanged(meetingId);
  try {
    const merged = loadMergedTranscript(meetingId, audioDir, db);
    writeFileSync(
      join(audioDir, "transcript.md"),
      formatTranscriptMarkdown(merged),
      "utf8",
    );
    if (merged.some((s) => s.enhancedText !== undefined)) {
      writeFileSync(
        join(audioDir, "transcript-enhanced.md"),
        formatTranscriptMarkdown(merged, true),
        "utf8",
      );
    }
  } catch (err) {
    log.warn(
      `meeting ${meetingId}: failed to write transcript.md: ${String(err)}`,
    );
  }
}

/** Attendee names for the naming prompt. Names only, never emails. */
export function attendeeNamesOf(row: MeetingRow | undefined): string[] {
  if (!row) return [];
  return parseAttendees(row)
    .map((a) => a.name)
    .filter((n) => n.trim().length > 0);
}
