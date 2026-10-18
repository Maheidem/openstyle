import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// The only code that hashes a transcript (specs/meeting-enhance-agentic.md
// 4.1 P11). `prepare`, the resume guard and the inspector reader call it and
// must get the same string from the same database. So it hashes database
// rows, not the merged transcript.

export interface HashRow {
  /** meeting_segments.id. Never empty. */
  id: string;
  /** The `text` column: raw, never a correction. Never blank. */
  text: string;
  /** The effective label: null for a "mic" row and for an undiarized row. */
  speakerLabel: string | null;
  /** The `enhanced_text` column. "" counts as null. */
  enhancedText: string | null;
  /** The confirmed `display_name` of the effective label, else null. */
  speakerName: string | null;
}

export type HashVariant = "enhance" | "summarize" | "chain";
export type RunStage = "enhance" | "summarize";

/**
 * "summarize" when `stages` has no "enhance". "chain" when it has both:
 * Enhance chains into Summarize. Else "enhance".
 */
export function hashVariantOf(stages: readonly RunStage[]): HashVariant {
  if (!stages.includes("enhance")) return "summarize";
  return stages.includes("summarize") ? "chain" : "enhance";
}

interface SegmentDbRow {
  id: string;
  source: string;
  text: string | null;
  speaker_label: string | null;
  enhanced_text: string | null;
}

interface SpeakerDbRow {
  speaker_label: string;
  display_name: string | null;
  merged_into: string | null;
}

/**
 * Read the rows of one meeting that the hash covers. Segments with status
 * `ok`, in the order of the transcript loader. A segment with no id or a
 * blank text is skipped. The effective label follows `resolveSpeakerNames`:
 * only a `system` row with a stored label has one, and `merged_into` replaces
 * it (one hop).
 */
export function loadHashRows(db: DatabaseSync, meetingId: string): HashRow[] {
  const segments = db
    .prepare(
      `SELECT id, source, text, speaker_label, enhanced_text
         FROM meeting_segments
        WHERE meeting_id = ? AND status = 'ok'
        ORDER BY idx, start_ms, id`,
    )
    .all(meetingId) as unknown as SegmentDbRow[];
  const speakers = db
    .prepare(
      `SELECT speaker_label, display_name, merged_into
         FROM meeting_speakers WHERE meeting_id = ?`,
    )
    .all(meetingId) as unknown as SpeakerDbRow[];
  const byLabel = new Map(speakers.map((s) => [s.speaker_label, s]));

  const rows: HashRow[] = [];
  for (const seg of segments) {
    if (!seg.id || !seg.text || seg.text.trim() === "") continue;
    let speakerLabel: string | null = null;
    let speakerName: string | null = null;
    if (seg.source === "system" && seg.speaker_label) {
      speakerLabel =
        byLabel.get(seg.speaker_label)?.merged_into ?? seg.speaker_label;
      speakerName = byLabel.get(speakerLabel)?.display_name || null;
    }
    rows.push({
      id: seg.id,
      text: seg.text,
      speakerLabel,
      enhancedText: seg.enhanced_text || null,
      speakerName,
    });
  }
  return rows;
}

/**
 * Variant `enhance`: ids, raw text, effective labels. `summarize` adds the
 * stored `enhanced_text` and the confirmed name (the fields the summary
 * prints). `chain` adds the confirmed name only, because the chained run
 * writes `enhanced_text` itself.
 */
export function inputHash(
  rows: readonly HashRow[],
  variant: HashVariant,
): string {
  const tuples = rows.map((r) =>
    variant === "enhance"
      ? [r.id, r.text, r.speakerLabel]
      : variant === "chain"
        ? [r.id, r.text, r.speakerLabel, r.speakerName]
        : [r.id, r.text, r.speakerLabel, r.enhancedText, r.speakerName],
  );
  return createHash("sha256")
    .update(JSON.stringify([variant, tuples]), "utf8")
    .digest("hex");
}
