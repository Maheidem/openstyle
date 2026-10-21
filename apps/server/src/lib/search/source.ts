import type { DatabaseSync } from "node:sqlite";
import { loadMergedTranscript } from "../meetings/transcript-io.js";
import { CHUNKER_VERSION, type ChunkSegment, sha256Json } from "./chunker.js";

// The chunker input of one meeting (specs/local-semantic-search.md 4.1, S8):
// the merged transcript (echo and hallucination rows removed),
// `enhancedText ?? text` per segment, no speaker label (S7).

export interface MeetingSource {
  meetingId: string;
  /** COALESCE(meetings.folder_id, '') (S2). */
  folderKey: string;
  language: string | null;
  status: string;
  segments: ChunkSegment[];
}

export function loadMeetingSource(
  db: DatabaseSync,
  meetingId: string,
): MeetingSource | null {
  const row = db
    .prepare(
      "SELECT id, folder_id, language, status, audio_dir FROM meetings WHERE id = ?",
    )
    .get(meetingId) as
    | {
        id: string;
        folder_id: string | null;
        language: string | null;
        status: string;
        audio_dir: string | null;
      }
    | undefined;
  if (!row) return null;
  const segments: ChunkSegment[] = [];
  for (const s of loadMergedTranscript(meetingId, row.audio_dir, db)) {
    const text = s.enhancedText ?? s.text;
    if (!s.id || !text || text.trim().length === 0) continue;
    segments.push({ id: s.id, text, startMs: s.startMs, endMs: s.endMs });
  }
  return {
    meetingId,
    folderKey: row.folder_id ?? "",
    language: row.language,
    status: row.status,
    segments,
  };
}

/** sha256(JSON [CHUNKER_VERSION, modelId, [[segmentId, text], ...]]) (6.3). */
export function sourceHash(
  segments: readonly ChunkSegment[],
  modelId: string,
): string {
  return sha256Json([
    CHUNKER_VERSION,
    modelId,
    segments.map((s) => [s.id, s.text]),
  ]);
}
