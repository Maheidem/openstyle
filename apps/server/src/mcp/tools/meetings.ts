// MCP tools for meetings, tags, the live transcript, transcripts, speakers,
// summaries and jobs. Each tool calls a route of routes/meetings.ts,
// routes/search.ts or routes/jobs.ts. The write routes of PR 3 (attendees,
// enhanced segments, summary) give 409 themselves while a job runs.
import { z } from "zod";
import {
  assertNoJob,
  confirmArg,
  defineTool,
  expectOk,
  query,
  seg,
  ToolError,
} from "./define.js";

const meetingId = z
  .string()
  .min(1)
  .describe("The meeting id (from list_meetings).");

const LIVE_OFF_MESSAGE =
  "Live transcription is off. Turn it on with set_setting live_chat_enabled=true; it starts with the next recording.";
const NO_RECORDING_MESSAGE = "No recording is running";

interface LiveLine {
  source: "mic" | "system";
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
}

const listMeetings = defineTool({
  name: "list_meetings",
  description:
    "List the meetings, newest first (at most 200). Each item has the id, title, status, times and the running job.",
  kind: "read",
  idempotent: true,
  input: z.object({
    folder_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Only the meetings of this folder. "none" gives the meetings with no folder.',
      ),
  }),
  run: async ({ folder_id }, { api }) => ({
    data: expectOk(await api("GET", `/api/meetings${query({ folder_id })}`)),
  }),
});

const getMeeting = defineTool({
  name: "get_meeting",
  description:
    "Get one meeting: title, status, language, context, tags, calendar event, summary and the running job.",
  kind: "read",
  idempotent: true,
  input: z.object({ meeting_id: meetingId }),
  run: async ({ meeting_id }, { api }) => ({
    data: expectOk(await api("GET", `/api/meetings/${seg(meeting_id)}`)),
  }),
});

const updateMeeting = defineTool({
  name: "update_meeting",
  description:
    "Change the title, the language or the context notes of a meeting. Give at least one field. Fields you do not give stay the same.",
  kind: "write",
  idempotent: true,
  input: z.object({
    meeting_id: meetingId,
    title: z.string().min(1).max(512).optional().describe("The new title."),
    language: z
      .string()
      .min(2)
      .max(8)
      .nullable()
      .optional()
      .describe(
        'The transcription language code, for example "en". null clears it.',
      ),
    context: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe(
        "Free-text notes about the meeting. Summary and speaker naming use them. null or empty clears them.",
      ),
  }),
  run: async ({ meeting_id, ...fields }, { api }) => {
    assertNoJob(meeting_id);
    const data = expectOk(
      await api("PATCH", `/api/meetings/${seg(meeting_id)}`, fields),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const setCalendarLink = defineTool({
  name: "set_calendar_link",
  description:
    "Link a meeting to a calendar event, or remove the link with event: null. An empty title, or a title that came from the old event, takes the event title.",
  kind: "write",
  idempotent: true,
  input: z.object({
    meeting_id: meetingId,
    event: z
      .object({
        id: z.string().min(1).max(512).describe("The calendar event id."),
        title: z.string().max(512).describe("The event title."),
        start: z
          .number()
          .int()
          .describe("The event start, epoch milliseconds."),
        end: z.number().int().describe("The event end, epoch milliseconds."),
        url: z
          .string()
          .max(2048)
          .nullable()
          .describe("The meeting link, or null."),
        attendees: z
          .array(
            z.object({
              name: z.string().max(200),
              email: z.string().max(320),
              isOrganizer: z.boolean(),
            }),
          )
          .describe("The attendees of the event."),
      })
      .nullable()
      .describe("The event to link, or null to remove the link."),
  }),
  run: async ({ meeting_id, event }, { api }) => {
    assertNoJob(meeting_id);
    const path = `/api/meetings/${seg(meeting_id)}/calendar`;
    const data = expectOk(
      event === null
        ? await api("DELETE", path)
        : await api("PUT", path, event),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const setAttendees = defineTool({
  name: "set_attendees",
  description:
    "Set the full attendee list of a meeting by hand. It needs no calendar event, and a linked event stays linked. Speaker naming uses the names. An empty list removes all attendees.",
  kind: "write",
  idempotent: true,
  input: z.object({
    meeting_id: meetingId,
    attendees: z
      .array(
        z.object({
          name: z.string().min(1).max(200).describe("The attendee name."),
          email: z
            .string()
            .max(320)
            .optional()
            .describe("The attendee email, if known."),
        }),
      )
      .max(200)
      .describe("All attendees of the meeting."),
  }),
  run: async ({ meeting_id, attendees }, { api }) => {
    const data = expectOk(
      await api("PUT", `/api/meetings/${seg(meeting_id)}/attendees`, {
        attendees,
      }),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const listTags = defineTool({
  name: "list_tags",
  description:
    "List all meeting tags with the number of meetings for each tag.",
  kind: "read",
  idempotent: true,
  input: z.object({}),
  run: async (_args, { api }) => ({
    data: expectOk(await api("GET", "/api/meetings/tags")),
  }),
});

const setMeetingTags = defineTool({
  name: "set_meeting_tags",
  description:
    "Set the full tag list of a meeting. The list replaces the old tags. An empty list removes all tags.",
  kind: "write",
  idempotent: true,
  input: z.object({
    meeting_id: meetingId,
    tags: z
      .array(z.string())
      .describe("All tag names that the meeting must have."),
  }),
  run: async ({ meeting_id, tags }, { api }) => {
    assertNoJob(meeting_id);
    const data = expectOk(
      await api("PUT", `/api/meetings/${seg(meeting_id)}/tags`, { tags }),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const moveMeetings = defineTool({
  name: "move_meetings",
  description:
    "Move meetings into a folder, or out of all folders with folder_id: null.",
  kind: "write",
  idempotent: true,
  input: z.object({
    meeting_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(200)
      .describe("The meetings to move."),
    folder_id: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "The target folder id (from list_folders), or null for no folder.",
      ),
  }),
  run: async ({ meeting_ids, folder_id }, { api }) => {
    for (const id of meeting_ids) assertNoJob(id);
    const data = expectOk(
      await api("POST", "/api/meetings/move", { meeting_ids, folder_id }),
    );
    return { data, change: { kind: "meeting", ids: meeting_ids } };
  },
});

const deleteMeeting = defineTool({
  name: "delete_meeting",
  description:
    "Delete a meeting with its audio, transcript and summary. This cannot be undone. A running job on it stops.",
  kind: "delete",
  idempotent: true,
  input: z.object({ meeting_id: meetingId, confirm: confirmArg }),
  run: async ({ meeting_id }, { api }) => {
    expectOk(await api("GET", `/api/meetings/${seg(meeting_id)}`));
    const data = expectOk(
      await api("DELETE", `/api/meetings/${seg(meeting_id)}`),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const searchMeetings = defineTool({
  name: "search_meetings",
  description:
    "Search the meetings by meaning (transcript, title, tags, summary). Gives the best hits with a snippet. When search is off, the answer gives the reason.",
  kind: "read",
  idempotent: true,
  input: z.object({
    query: z.string().min(1).describe("The search text."),
    folder_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Search only in this folder. "none" searches the meetings with no folder.',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Only meetings with one of these tags."),
    k: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("The number of hits. The default is 10."),
  }),
  run: async (args, { api }) => ({
    data: expectOk(await api("POST", "/api/search/meetings", args)),
  }),
});

const getLiveTranscript = defineTool({
  name: "get_live_transcript",
  description:
    "Read the live transcript of the meeting that records now. To follow it, call again with since_ms set to the cursor_ms of the last answer: you then get only the new final lines. partial holds the open line of each channel (mic is the user, system is the others).",
  kind: "read",
  idempotent: true,
  input: z.object({
    meeting_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The recording meeting. Leave it out to use the meeting that records now.",
      ),
    since_ms: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Give only the final lines that end after this time (ms from the recording start).",
      ),
  }),
  run: async ({ meeting_id, since_ms = 0 }, { api }) => {
    const live = await api("GET", "/api/settings/live_chat_enabled");
    const liveOn =
      live.ok && (live.data as { value?: string }).value === "true";
    if (!liveOn) throw new ToolError(LIVE_OFF_MESSAGE);
    let id = meeting_id;
    if (id === undefined) {
      const list = expectOk(await api("GET", "/api/meetings")) as {
        items: { id: string; status: string }[];
      };
      id = list.items.find((m) => m.status === "recording")?.id;
      if (id === undefined) throw new ToolError(NO_RECORDING_MESSAGE);
    } else {
      const meeting = expectOk(
        await api("GET", `/api/meetings/${seg(id)}`),
      ) as { status: string };
      if (meeting.status !== "recording") {
        throw new ToolError(`${NO_RECORDING_MESSAGE} for this meeting`);
      }
    }
    const snapshot = expectOk(
      await api("GET", `/api/meetings/${seg(id)}/live`),
    ) as {
      status: string;
      reason?: string;
      lines: LiveLine[];
      skippedTicks: number;
    };
    if (snapshot.status === "off") throw new ToolError(LIVE_OFF_MESSAGE);
    const finals = snapshot.lines.filter((l) => l.final);
    const cursor = finals.reduce((max, l) => Math.max(max, l.endMs), since_ms);
    return {
      data: {
        meeting_id: id,
        status: snapshot.status,
        reason: snapshot.reason ?? null,
        lines: finals.filter((l) => l.endMs > since_ms),
        partial: snapshot.lines.filter((l) => !l.final),
        cursor_ms: cursor,
        skipped_ticks: snapshot.skippedTicks,
      },
    };
  },
});

const getTranscript = defineTool({
  name: "get_transcript",
  description:
    "Read the transcript of a meeting, one page at a time, in time order. Each segment has the speaker, the times, the raw text and the enhanced text. The answer also lists the speaker labels. Call again with offset = next_offset until next_offset is null.",
  kind: "read",
  idempotent: true,
  input: z.object({
    meeting_id: meetingId,
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The first segment to give. The default is 0."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "The number of segments to give, 1 to 1000. The default is 200.",
      ),
  }),
  run: async ({ meeting_id, offset = 0, limit = 200 }, { api }) => {
    const transcript = expectOk(
      await api("GET", `/api/meetings/${seg(meeting_id)}/transcript`),
    ) as { segments: unknown[] };
    const speakers = expectOk(
      await api("GET", `/api/meetings/${seg(meeting_id)}/speakers`),
    );
    const total = transcript.segments.length;
    const end = Math.min(offset + limit, total);
    return {
      data: {
        total,
        offset,
        limit,
        next_offset: end < total ? end : null,
        segments: transcript.segments.slice(offset, end),
        speakers,
      },
    };
  },
});

const setEnhancedSegments = defineTool({
  name: "set_enhanced_segments",
  description:
    "Write the enhanced (fixed) text of transcript segments, for example to correct names. The raw ASR text never changes. The segment ids come from get_transcript. null or an empty text removes the enhanced text of a segment.",
  kind: "write",
  idempotent: true,
  input: z.object({
    meeting_id: meetingId,
    segments: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .describe("The segment id (from get_transcript)."),
            enhanced_text: z
              .string()
              .max(20_000)
              .nullable()
              .describe("The fixed text of the segment, or null."),
          })
          .strict(),
      )
      .min(1)
      .max(5000)
      .describe("The segments to change. Other segments stay the same."),
  }),
  run: async ({ meeting_id, segments }, { api }) => {
    const data = expectOk(
      await api("PUT", `/api/meetings/${seg(meeting_id)}/enhanced-segments`, {
        segments,
      }),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const updateSpeaker = defineTool({
  name: "update_speaker",
  description:
    "Name a speaker of a meeting, or merge one speaker label into another. The labels come from get_transcript (speakers).",
  kind: "write",
  idempotent: true,
  input: z.object({
    meeting_id: meetingId,
    label: z.string().min(1).describe('The speaker label, for example "S1".'),
    display_name: z
      .string()
      .min(1)
      .max(80)
      .nullable()
      .optional()
      .describe("The real name of the speaker. null clears it."),
    merged_into: z
      .string()
      .min(1)
      .max(16)
      .nullable()
      .optional()
      .describe("Merge this label into that label. null removes the merge."),
  }),
  run: async ({ meeting_id, label, display_name, merged_into }, { api }) => {
    assertNoJob(meeting_id);
    const data = expectOk(
      await api(
        "PATCH",
        `/api/meetings/${seg(meeting_id)}/speakers/${seg(label)}`,
        { displayName: display_name, mergedInto: merged_into },
      ),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const getSummaryVersions = defineTool({
  name: "get_summary_versions",
  description:
    "List the older summaries of a meeting, newest first. The current summary is in get_meeting.",
  kind: "read",
  idempotent: true,
  input: z.object({ meeting_id: meetingId }),
  run: async ({ meeting_id }, { api }) => ({
    data: expectOk(
      await api("GET", `/api/meetings/${seg(meeting_id)}/summary-versions`),
    ),
  }),
});

const summaryText = z.string().max(1500);
const setSummary = defineTool({
  name: "set_summary",
  description:
    "Replace the summary of a meeting with your own. The old summary stays in get_summary_versions. Give the Markdown text and the same content as summary_json; the folder Overview reads its action items, decisions and open questions.",
  kind: "write",
  idempotent: false,
  input: z.object({
    meeting_id: meetingId,
    markdown: z
      .string()
      .min(1)
      .max(200_000)
      .describe("The summary as Markdown, as the app shows it."),
    summary_json: z
      .object({
        overview: summaryText.describe("A short overview paragraph."),
        keyPoints: z.array(summaryText).describe("The key points."),
        decisions: z.array(summaryText).describe("The decisions."),
        actionItems: z
          .array(
            z.object({
              task: summaryText.describe("The task."),
              owner: z
                .string()
                .max(80)
                .nullable()
                .describe("Who does it, or null."),
              due: z
                .string()
                .max(80)
                .nullable()
                .describe('When, as spoken ("next Friday"), or null.'),
            }),
          )
          .describe("The action items."),
        openQuestions: z.array(summaryText).describe("The open questions."),
      })
      .describe("The summary fields."),
  }),
  run: async ({ meeting_id, markdown, summary_json }, { api, agent }) => {
    const data = expectOk(
      await api("PUT", `/api/meetings/${seg(meeting_id)}/summary`, {
        markdown,
        summary_json,
        agent,
      }),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const JOB_PATHS = {
  enhance: "enhance",
  summarize: "summarize",
  transcribe: "transcribe",
  retry_failed: "retry-failed",
  diarize: "diarize",
} as const;

const startMeetingJob = defineTool({
  name: "start_meeting_job",
  description:
    "Start a job on a meeting: transcribe (full new pass), retry_failed (only failed chunks), diarize (find speakers), enhance (fix the transcript, then summarize) or summarize. Most jobs run in the background: follow them with list_jobs or get_meeting.",
  kind: "write",
  idempotent: false,
  input: z.object({
    meeting_id: meetingId,
    kind: z
      .enum(["enhance", "summarize", "transcribe", "retry_failed", "diarize"])
      .describe("The job to start."),
  }),
  run: async ({ meeting_id, kind }, { api }) => {
    const data = expectOk(
      await api("POST", `/api/meetings/${seg(meeting_id)}/${JOB_PATHS[kind]}`),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const cancelMeetingJob = defineTool({
  name: "cancel_meeting_job",
  description:
    "Ask the running job of a meeting to stop. Finished parts stay. Speaker identification cannot stop.",
  kind: "write",
  idempotent: true,
  input: z.object({ meeting_id: meetingId }),
  run: async ({ meeting_id }, { api }) => {
    const data = expectOk(
      await api("POST", `/api/meetings/${seg(meeting_id)}/cancel-transcribe`),
    );
    return { data, change: { kind: "meeting", ids: [meeting_id] } };
  },
});

const listJobs = defineTool({
  name: "list_jobs",
  description:
    "List the meeting jobs that run or wait, and the state of the built-in models.",
  kind: "read",
  idempotent: true,
  input: z.object({}),
  run: async (_args, { api }) => ({
    data: expectOk(await api("GET", "/api/jobs")),
  }),
});

export const meetingTools = [
  listMeetings,
  getMeeting,
  updateMeeting,
  setCalendarLink,
  setAttendees,
  listTags,
  setMeetingTags,
  moveMeetings,
  deleteMeeting,
  searchMeetings,
  getLiveTranscript,
  getTranscript,
  setEnhancedSegments,
  updateSpeaker,
  getSummaryVersions,
  setSummary,
  startMeetingJob,
  cancelMeetingJob,
  listJobs,
];
