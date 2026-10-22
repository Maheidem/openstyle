import type { DatabaseSync } from "node:sqlite";
import { getMeetingTags } from "../meetings/tags.js";
import { loadMergedTranscript } from "../meetings/transcript-io.js";
import {
  buildChunks,
  CHUNKER_VERSION,
  type Chunk,
  type ChunkKind,
  type ChunkSegment,
  chunkTextHash,
  estimateEmbedTokens,
  sha256Json,
} from "./chunker.js";

// The chunker input of one meeting (specs/local-semantic-search.md 4.1, S8):
// the merged transcript (echo and hallucination rows removed),
// `enhancedText ?? text` per segment, no speaker label (S7). Also the title,
// the tags and the summary (4.6, #286).

export interface MeetingSource {
  meetingId: string;
  /** COALESCE(meetings.folder_id, '') (S2). */
  folderKey: string;
  language: string | null;
  status: string;
  segments: ChunkSegment[];
  title: string | null;
  tags: string[];
  /** meeting_summaries.markdown, or null. */
  summary: string | null;
}

/** A chunk with its kind (3.2). */
export interface IndexChunk extends Chunk {
  kind: ChunkKind;
}

export function loadMeetingSource(
  db: DatabaseSync,
  meetingId: string,
): MeetingSource | null {
  const row = db
    .prepare(
      "SELECT id, folder_id, language, status, audio_dir, title FROM meetings WHERE id = ?",
    )
    .get(meetingId) as
    | {
        id: string;
        folder_id: string | null;
        language: string | null;
        status: string;
        audio_dir: string | null;
        title: string | null;
      }
    | undefined;
  if (!row) return null;
  const segments: ChunkSegment[] = [];
  for (const s of loadMergedTranscript(meetingId, row.audio_dir, db)) {
    const text = s.enhancedText ?? s.text;
    if (!s.id || !text || text.trim().length === 0) continue;
    segments.push({ id: s.id, text, startMs: s.startMs, endMs: s.endMs });
  }
  const summary = db
    .prepare("SELECT markdown FROM meeting_summaries WHERE meeting_id = ?")
    .get(meetingId) as { markdown: string | null } | undefined;
  return {
    meetingId,
    folderKey: row.folder_id ?? "",
    language: row.language,
    status: row.status,
    segments,
    title: row.title,
    tags: getMeetingTags(meetingId, db),
    summary: summary?.markdown?.trim() ? summary.markdown : null,
  };
}

/**
 * The text of the meta chunk (4.6): the title, then the tags. The document
 * prompt stays `title: none | text: ` (D9): the spike showed lower recall
 * with the meeting title in `title:`, so the title goes in the text.
 * null when the meeting has no title and no tags.
 */
export function metaText(
  title: string | null,
  tags: readonly string[],
): string | null {
  const lines: string[] = [];
  if (title?.trim()) lines.push(title.trim());
  if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * All chunks of one meeting (4.6): the transcript chunks in transcript order
 * (ordinal 0..n-1), then one meta chunk, then the summary chunks. The
 * summary is one long segment for the chunker, so it is cut by sentences
 * with the same sizes as a transcript. A meta or summary chunk has no times.
 */
export function buildMeetingChunks(src: MeetingSource): IndexChunk[] {
  const out: IndexChunk[] = buildChunks(src.segments, src.language).map(
    (c) => ({ ...c, kind: "transcript" }),
  );
  const add = (c: Chunk, kind: ChunkKind) =>
    out.push({
      ...c,
      ordinal: out.length,
      segmentIds: [],
      startMs: null,
      endMs: null,
      textHash: chunkTextHash(c.text, kind),
      kind,
    });
  const meta = metaText(src.title, src.tags);
  if (meta) {
    add(
      {
        ordinal: 0,
        segmentIds: [],
        charStart: 0,
        charEnd: null,
        startMs: null,
        endMs: null,
        text: meta,
        tokenEstimate: estimateEmbedTokens(meta),
        textHash: "",
      },
      "meta",
    );
  }
  if (src.summary) {
    const summary = [
      { id: "summary", text: src.summary, startMs: null, endMs: null },
    ];
    for (const c of buildChunks(summary, src.language)) add(c, "summary");
  }
  return out;
}

/**
 * sha256(JSON [CHUNKER_VERSION, modelId, [[segmentId, text], ...], meta
 * text, summary]) (6.3). Any change of the text, title, tags or summary
 * changes it. The text hash of each chunk then decides what is embedded
 * again (D5): a tag change embeds only the meta chunk.
 */
export function sourceHash(src: MeetingSource, modelId: string): string {
  return sha256Json([
    CHUNKER_VERSION,
    modelId,
    src.segments.map((s) => [s.id, s.text]),
    metaText(src.title, src.tags),
    src.summary,
  ]);
}
