import type { DatabaseSync } from "node:sqlite";

// One builder of fictional meetings for every level of test and for the live
// scripts (specs/meeting-enhance-agentic.md 10.2 rule 1). It imports no vitest
// and no server module except types. All names and text are made up.

export interface MeetingFixtureInput {
  /** Number of chunks. A chunk is `segmentsPerChunk` consecutive segments. */
  chunks: number;
  /** Speakers, "Me" included. At least 1. */
  speakers: number;
  /** Add a made-up self-introduction line for the last speaker. */
  selfIntroduction?: boolean;
  /** Segments in one chunk. Default 4. */
  segmentsPerChunk?: number;
  /** Meeting id. Default `fixture-meeting`. */
  meetingId?: string;
}

export interface FixtureSegment {
  id: string;
  meetingId: string;
  source: "mic" | "system";
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  /** The diarizer label ("2" for "Them 2"). null for the mic. */
  speakerLabel: string | null;
}

export interface FixtureAttendee {
  name: string;
  email: string;
  isOrganizer: boolean;
}

export interface MeetingFixture {
  meeting: {
    id: string;
    title: string;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    status: "transcribed";
    language: "en";
    context: string;
  };
  segments: FixtureSegment[];
  /** Segment ids of each chunk, in order. */
  segmentIdsByChunk: string[][];
  /** The made-up calendar link. Its names must never reach a prompt. */
  calendar: {
    id: string;
    title: string;
    start: number;
    end: number;
    url: string | null;
    attendees: FixtureAttendee[];
  };
  /** The made-up name in the self-introduction line, else null. */
  introducedName: string | null;
}

const LINES = [
  "We should look at the rollout plan for the new dashboard before Friday.",
  "The load test showed the export job takes about four minutes on the big sample.",
  "I would like to keep the weekly review short and focus on blockers only.",
  "Can we move the vendor call to Thursday so the data team can join as well?",
  "The migration script needs one more pass before we run it on the full set.",
  "Let us write the decision into the shared notes so nobody has to ask again.",
  "The error rate dropped after the cache change, which is a good sign for launch.",
  "We still need an owner for the onboarding checklist and a date for the review.",
  "I think the second option is cheaper, but it adds a step for the support team.",
  "Please send the draft to the group tomorrow morning and we will comment by noon.",
];

const ATTENDEES: FixtureAttendee[] = [
  { name: "Jordan Vale", email: "jordan.vale@example.test", isOrganizer: true },
  {
    name: "Casey Marlow",
    email: "casey.marlow@example.test",
    isOrganizer: false,
  },
  {
    name: "Riley Quinn",
    email: "riley.quinn@example.test",
    isOrganizer: false,
  },
];

/** Build the rows of a fictional meeting. Pure: the same input gives the same rows. */
export function buildMeetingFixture(
  input: MeetingFixtureInput,
): MeetingFixture {
  const perChunk = input.segmentsPerChunk ?? 4;
  const meetingId = input.meetingId ?? "fixture-meeting";
  const speakers = Math.max(1, input.speakers);
  const total = Math.max(1, input.chunks) * perChunk;
  const startedAt = 1_760_000_000_000;
  const stepMs = 12_000;
  const introducedName =
    input.selfIntroduction && speakers > 1 ? "Morgan Ellis" : null;
  const introIndex = introducedName ? total - 2 : -1;

  const segments: FixtureSegment[] = [];
  for (let i = 0; i < total; i++) {
    // Speaker 0 is the mic ("Me"). Speaker n >= 1 is "Them n+1".
    const speaker = i % speakers;
    const label = speaker === 0 ? null : String(speaker + 1);
    const text =
      i === introIndex
        ? `Hi everyone, I am ${introducedName} and I run the data team.`
        : `${LINES[i % LINES.length]} (${i + 1})`;
    segments.push({
      id: `${meetingId}-seg-${i}`,
      meetingId,
      source: speaker === 0 ? "mic" : "system",
      idx: i,
      startMs: i * stepMs,
      endMs: i * stepMs + stepMs - 2_000,
      text,
      speakerLabel: label,
    });
  }
  // A self-introduction needs a Them speaker: put it on the last Them label.
  if (introducedName) {
    const line = segments[introIndex];
    if (line && line.source === "mic") {
      line.source = "system";
      line.speakerLabel = String(speakers);
    }
  }

  const segmentIdsByChunk: string[][] = [];
  for (let c = 0; c < total / perChunk; c++) {
    segmentIdsByChunk.push(
      segments.slice(c * perChunk, (c + 1) * perChunk).map((s) => s.id),
    );
  }

  const durationMs = total * stepMs;
  return {
    meeting: {
      id: meetingId,
      title: "Rollout planning",
      startedAt,
      endedAt: startedAt + durationMs,
      durationMs,
      status: "transcribed",
      language: "en",
      context: "Weekly planning call of a made-up product team.",
    },
    segments,
    segmentIdsByChunk,
    calendar: {
      id: `${meetingId}-event`,
      title: "Rollout planning",
      start: startedAt,
      end: startedAt + durationMs,
      url: null,
      attendees: ATTENDEES,
    },
    introducedName,
  };
}

/** Write the fixture with `node:sqlite` (the pattern of scripts/site-captures/seed-data.mjs). */
export function writeMeetingFixture(
  db: DatabaseSync,
  f: MeetingFixture,
  opts: { withCalendar?: boolean } = {},
): void {
  const m = f.meeting;
  db.prepare(
    `INSERT INTO meetings
       (id, title, started_at, ended_at, duration_ms, status, audio_dir,
        stt_provider, stt_model, language, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'local-mlx', 'fixture-model', ?, ?, ?)`,
  ).run(
    m.id,
    m.title,
    m.startedAt,
    m.endedAt,
    m.durationMs,
    m.status,
    m.language,
    m.context,
    m.startedAt,
  );
  if (opts.withCalendar) {
    const c = f.calendar;
    db.prepare(
      `UPDATE meetings SET calendar_event_id = ?, calendar_title = ?,
         calendar_start = ?, calendar_end = ?, calendar_url = ?,
         calendar_attendees = ? WHERE id = ?`,
    ).run(
      c.id,
      c.title,
      c.start,
      c.end,
      c.url,
      JSON.stringify(c.attendees),
      m.id,
    );
  }
  const insert = db.prepare(
    `INSERT INTO meeting_segments
       (id, meeting_id, source, idx, start_ms, end_ms, text, status, speaker_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
  );
  for (const s of f.segments) {
    insert.run(
      s.id,
      s.meetingId,
      s.source,
      s.idx,
      s.startMs,
      s.endMs,
      s.text,
      s.speakerLabel,
    );
  }
}
