import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CalendarEvent } from "@openstyle/validations";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { parseAttendees } from "../src/lib/meetings/store.js";
import { __setMeetingsTestOverrides } from "../src/routes/meetings.js";
import { jsonRequest, postEmpty } from "./helpers/http.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";
import { runnerHarness, waitForNoJob } from "./helpers/runner-helpers.js";
import { seedTestModel } from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const app = createApp();

// Fictional data only.
const EVENT: CalendarEvent = {
  id: "evt-1",
  title: "Weekly sync",
  start: 1_700_000_000_000,
  end: 1_700_003_600_000,
  url: "https://meet.example.test/abc",
  attendees: [
    { name: "Ana Souza", email: "ana@example.test", isOrganizer: true },
    { name: "Bruno Lima", email: "bruno@example.test", isOrganizer: false },
  ],
};

let audioDir: string;
beforeAll(() => {
  audioDir = mkdtempSync(join(tmpdir(), "meeting-cal-"));
});
afterAll(() => {
  rmSync(audioDir, { recursive: true, force: true });
});
afterEach(() => {
  resetMeetingTables();
  __setMeetingsTestOverrides();
});

async function start(body: Record<string, unknown>): Promise<Response> {
  return jsonRequest(app, "POST", "/api/meetings/start", {
    id: "m1",
    audio_dir: audioDir,
    started_at: 1_700_000_000_000,
    ...body,
  });
}

async function getMeeting(id = "m1"): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/meetings/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("list and detail responses", () => {
  it("never carry the raw calendar columns or emails in the list", async () => {
    await start({ calendar: EVENT });
    const list = await app.request("/api/meetings");
    const text = await list.text();
    expect(text).not.toContain("calendar_attendees");
    expect(text).not.toContain("@example.test");
    const detail = await getMeeting();
    expect(detail).not.toHaveProperty("calendar_attendees");
    expect(detail.calendar).not.toBeNull();
  });
});

describe("POST /api/meetings/start with a calendar event", () => {
  it("stores the event and takes its title when none is given", async () => {
    expect((await start({ calendar: EVENT })).status).toBe(200);
    const m = await getMeeting();
    expect(m.title).toBe("Weekly sync");
    expect(m.calendar).toEqual(EVENT);
  });

  it("keeps an explicit title", async () => {
    await start({ title: "My own title", calendar: EVENT });
    expect((await getMeeting()).title).toBe("My own title");
  });

  it("works with no calendar (calendar is null)", async () => {
    await start({});
    const m = await getMeeting();
    expect(m.title).toBeNull();
    expect(m.calendar).toBeNull();
  });

  it("rejects more than 200 attendees", async () => {
    const attendees = Array.from({ length: 201 }, (_, i) => ({
      name: `P${i}`,
      email: `p${i}@example.test`,
      isOrganizer: false,
    }));
    const res = await start({ calendar: { ...EVENT, attendees } });
    expect(res.status).toBe(400);
  });
});

describe("PUT and DELETE /api/meetings/:id/calendar", () => {
  it("links an event and fills an empty title", async () => {
    await start({});
    const res = await jsonRequest(
      app,
      "PUT",
      "/api/meetings/m1/calendar",
      EVENT,
    );
    expect(res.status).toBe(200);
    const m = await getMeeting();
    expect(m.title).toBe("Weekly sync");
    expect(m.calendar).toEqual(EVENT);
  });

  it("does not overwrite a title the user typed", async () => {
    await start({ title: "Mine" });
    await jsonRequest(app, "PUT", "/api/meetings/m1/calendar", EVENT);
    expect((await getMeeting()).title).toBe("Mine");
  });

  it("changing the event updates an inherited title", async () => {
    await start({ calendar: EVENT });
    await jsonRequest(app, "PUT", "/api/meetings/m1/calendar", {
      ...EVENT,
      id: "evt-2",
      title: "Other meeting",
    });
    const m = await getMeeting();
    expect(m.title).toBe("Other meeting");
    expect((m.calendar as CalendarEvent).id).toBe("evt-2");
  });

  it("404s for an unknown meeting", async () => {
    const put = await jsonRequest(
      app,
      "PUT",
      "/api/meetings/nope/calendar",
      EVENT,
    );
    expect(put.status).toBe(404);
    const del = await app.request("/api/meetings/nope/calendar", {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
  });

  it("unlink clears the six columns and resets an inherited title", async () => {
    await start({ calendar: EVENT });
    const res = await app.request("/api/meetings/m1/calendar", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const m = await getMeeting();
    expect(m.calendar).toBeNull();
    expect(m.title).toBeNull();
    const row = getDb()
      .prepare("SELECT * FROM meetings WHERE id = 'm1'")
      .get() as Record<string, unknown>;
    for (const k of [
      "calendar_event_id",
      "calendar_title",
      "calendar_start",
      "calendar_end",
      "calendar_url",
      "calendar_attendees",
    ]) {
      expect(row[k]).toBeNull();
    }
  });

  it("unlink keeps a title the user edited", async () => {
    await start({ calendar: EVENT });
    await jsonRequest(app, "PATCH", "/api/meetings/m1", { title: "Edited" });
    await app.request("/api/meetings/m1/calendar", { method: "DELETE" });
    expect((await getMeeting()).title).toBe("Edited");
  });
});

describe("parseAttendees", () => {
  it("returns [] for null, bad JSON and non-arrays", () => {
    expect(parseAttendees({ calendar_attendees: null })).toEqual([]);
    expect(parseAttendees({ calendar_attendees: "{oops" })).toEqual([]);
    expect(parseAttendees({ calendar_attendees: '{"a":1}' })).toEqual([]);
  });
});

describe("speaker naming reads the attendee names", () => {
  beforeEach(() => {
    seedTestModel();
  });

  it("the enhance route runs the workflow and no request holds an attendee name or email", async () => {
    await start({ calendar: EVENT });
    getDb()
      .prepare("UPDATE meetings SET status = 'transcribed' WHERE id = 'm1'")
      .run();
    insertSegment({
      id: "m1:mic:0",
      meetingId: "m1",
      source: "mic",
      idx: 0,
      startMs: 0,
      endMs: 2000,
      text: "hello there",
    });
    const h = runnerHarness();
    __setMeetingsTestOverrides({ workflowDeps: h.deps });
    const res = await postEmpty(app, "/api/meetings/m1/enhance");
    expect(res.status).toBe(202);
    await waitForNoJob("m1");
    expect(h.requests.length).toBeGreaterThan(0);
    for (const r of h.requests) {
      const text = `${r.system}\n${r.user}`;
      expect(text).not.toContain("@");
      expect(text).not.toContain("Ana Souza");
      expect(text).not.toContain("Bruno Lima");
    }
  });
});
