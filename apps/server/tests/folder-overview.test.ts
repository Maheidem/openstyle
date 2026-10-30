// The folder Overview (issue #374). The real routes run over the test
// database. All meeting text is fictional.
import { folderOverviewSchema } from "@openstyle/validations";
import { beforeEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import {
  actionItemKey,
  gistOf,
  groupItems,
  normalizeItemText,
  parseSummary,
  type RawItem,
} from "../src/lib/meetings/folder-overview.js";
import { jsonRequest } from "./helpers/http.js";
import { insertSpeaker, resetMeetingTables } from "./helpers/meetings-db.js";

const app = createApp();
const base = "/api/meetings/folders";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

beforeEach(() => {
  resetMeetingTables();
  getDb().exec("DELETE FROM folder_action_item_state");
});

function addFolder(id: string, name = id) {
  getDb()
    .prepare(
      `INSERT INTO meeting_folders (id, name, description, created_at, updated_at)
       VALUES (?, ?, 'Tide alerts for boat owners', 1, 1)`,
    )
    .run(id, name);
}

interface SeedSummary {
  overview?: string;
  keyPoints?: string[];
  decisions?: string[];
  actionItems?: { task: string; owner: string | null; due: string | null }[];
  openQuestions?: string[];
}

function addMeeting(o: {
  id: string;
  folder: string | null;
  day: number;
  title?: string;
  summary?: SeedSummary;
  markdown?: string;
  attendees?: { name: string; email?: string }[];
}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO meetings (id, title, status, started_at, duration_ms, created_at, folder_id, calendar_attendees)
     VALUES (?, ?, ?, ?, 60000, ?, ?, ?)`,
  ).run(
    o.id,
    o.title ?? o.id,
    o.summary || o.markdown ? "summarized" : "transcribed",
    T0 + o.day * DAY,
    T0 + o.day * DAY,
    o.folder,
    o.attendees ? JSON.stringify(o.attendees) : null,
  );
  if (o.summary || o.markdown) saveSummary(o.id, o.summary, o.markdown);
}

function saveSummary(id: string, summary?: SeedSummary, markdown?: string) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO meeting_summaries (meeting_id, markdown, summary_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      id,
      markdown ?? null,
      summary
        ? JSON.stringify({
            overview: "",
            keyPoints: [],
            decisions: [],
            actionItems: [],
            openQuestions: [],
            ...summary,
          })
        : null,
      Date.now(),
    );
}

const task = (
  t: string,
  owner: string | null = null,
  due: string | null = null,
) => ({
  task: t,
  owner,
  due,
});

async function overview(id = "f1") {
  const res = await app.request(`${base}/${id}/overview`);
  expect(res.status).toBe(200);
  return folderOverviewSchema.parse(await res.json());
}

const put = (key: string, done: boolean, folder = "f1") =>
  jsonRequest(app, "PUT", `${base}/${folder}/action-items/${key}`, { done });

const src = (id: string, day: number): RawItem["source"] => ({
  meeting_id: id,
  title: id,
  started_at: T0 + day * DAY,
});
const raw = (
  id: string,
  day: number,
  text: string,
  owner: string | null = null,
  due: string | null = null,
): RawItem => ({ text, owner, due, source: src(id, day) });

describe("groupItems (the de-dup rule)", () => {
  it("merges equal text, case and spaces aside", () => {
    const groups = groupItems(
      [
        raw("a", 1, "Ship the beta in May"),
        raw("b", 2, "  ship the  beta in may "),
      ],
      false,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sources.map((s) => s.meeting_id)).toEqual(["b", "a"]);
  });

  it("merges near duplicates and keeps the oldest wording", () => {
    const groups = groupItems(
      [
        raw("a", 1, "Use React Native for the mobile app"),
        raw("b", 2, "Use React Native for the whole mobile app"),
      ],
      false,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.text).toBe("Use React Native for the mobile app");
  });

  it("keeps different decisions apart", () => {
    const groups = groupItems(
      [
        raw("a", 1, "Ship the Android app on Friday"),
        raw("b", 2, "Ship the iOS app on Friday"),
        raw("c", 3, "Hire a second designer"),
      ],
      false,
    );
    expect(groups).toHaveLength(3);
  });

  it("keeps entries apart that differ in a number", () => {
    const groups = groupItems(
      [
        raw("a", 1, "Send alerts only for storms above force 6"),
        raw("b", 2, "Send alerts only for storms above force 7"),
        raw("c", 3, "Send alerts only for storms above force 6"),
      ],
      false,
    );
    expect(groups.map((g) => g.text)).toEqual([
      "Send alerts only for storms above force 6",
      "Send alerts only for storms above force 7",
    ]);
    expect(groups[0]?.sources).toHaveLength(2);
  });

  it("keeps a short entry apart unless the text is equal", () => {
    expect(
      groupItems([raw("a", 1, "Go live"), raw("b", 2, "Go live now")], false),
    ).toHaveLength(2);
  });

  it("sorts groups by the newest source, newest first", () => {
    const groups = groupItems(
      [
        raw("a", 1, "Plan the beta launch event"),
        raw("b", 2, "Order new buoy sensors"),
        raw("c", 3, "Plan the beta launch event"),
      ],
      false,
    );
    expect(groups.map((g) => g.text)).toEqual([
      "Plan the beta launch event",
      "Order new buoy sensors",
    ]);
  });

  it("needs the owner and due to agree for action items", () => {
    const text = "Send the pricing sheet to the harbor office";
    const split = groupItems(
      [raw("a", 1, text, "Ana"), raw("b", 2, text, "Ben")],
      true,
    );
    expect(split).toHaveLength(2);
    const merged = groupItems(
      [raw("a", 1, text, "Ana", null), raw("b", 2, text, null, "Friday")],
      true,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ owner: "Ana", due: "Friday" });
  });

  it("takes the newest owner and due", () => {
    const text = "Send the pricing sheet to the harbor office";
    const g = groupItems(
      [raw("a", 1, text, "Ana", "Monday"), raw("b", 2, text, "Ana", "Friday")],
      true,
    );
    expect(g[0]).toMatchObject({ owner: "Ana", due: "Friday" });
  });
});

describe("action item key", () => {
  it("is 16 hex characters and stable for the same meeting and task", () => {
    const key = actionItemKey("m1", "Book the demo room");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(actionItemKey("m1", "  book the DEMO room ")).toBe(key);
  });

  it("changes with the meeting or the task text", () => {
    const key = actionItemKey("m1", "Book the demo room");
    expect(actionItemKey("m2", "Book the demo room")).not.toBe(key);
    expect(actionItemKey("m1", "Book a demo room")).not.toBe(key);
    expect(normalizeItemText(" A  b ")).toBe("a b");
  });
});

describe("summary helpers", () => {
  it("parses the lists and skips bad entries", () => {
    const s = parseSummary(
      JSON.stringify({
        overview: " Hi. ",
        decisions: ["a", 3, " "],
        actionItems: [{ task: "x", owner: "", due: "Fri" }, { task: 5 }, null],
      }),
    );
    expect(s?.decisions).toEqual(["a"]);
    expect(s?.actionItems).toEqual([{ task: "x", owner: null, due: "Fri" }]);
    expect(parseSummary("not json")).toBeNull();
    expect(parseSummary(null)).toBeNull();
  });

  it("cuts the gist from the overview, key points or markdown", () => {
    expect(
      gistOf(
        parseSummary(JSON.stringify({ overview: "We met. Second sentence." })),
        null,
      ),
    ).toBe("We met.");
    expect(
      gistOf(parseSummary(JSON.stringify({ keyPoints: ["Point one"] })), null),
    ).toBe("Point one");
    expect(gistOf(null, "## Notes\n\nPlain line")).toBe("Notes");
    expect(gistOf(null, null)).toBeNull();
    const long = gistOf(
      parseSummary(JSON.stringify({ overview: `${"word ".repeat(80)}end` })),
      null,
    );
    expect((long ?? "").length).toBeLessThanOrEqual(160);
  });
});

describe("GET /folders/:id/overview", () => {
  it("answers 404 for an unknown folder", async () => {
    const res = await app.request(`${base}/nope/overview`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "folder_not_found" });
  });

  it("answers an empty folder with empty lists", async () => {
    addFolder("f1");
    const o = await overview();
    expect(o.counts).toMatchObject({ meetings: 0, summarized: 0 });
    expect(o.timeline).toEqual([]);
    expect(o.decisions).toEqual([]);
    expect(o.action_items).toEqual([]);
    expect(o.last_activity).toBeNull();
    expect(o.folder.description).toBe("Tide alerts for boat owners");
  });

  function seed() {
    addFolder("f1");
    addFolder("f2");
    addMeeting({
      id: "m1",
      folder: "f1",
      day: 1,
      title: "Kickoff",
      summary: {
        overview: "We set the goal for the app. More text.",
        decisions: ["Use React Native for the mobile app"],
        actionItems: [
          task("Send the pricing sheet to the harbor office", "Ana"),
        ],
        openQuestions: ["Who pays for the buoy data feed?"],
      },
      attendees: [
        { name: "Ana Reyes" },
        { name: "Ben Ito", email: "b@x.test" },
      ],
    });
    addMeeting({
      id: "m2",
      folder: "f1",
      day: 3,
      title: "Beta plan",
      summary: {
        keyPoints: ["Beta starts in May"],
        decisions: [
          "Use React Native for the whole mobile app",
          "Close the beta to 50 boat owners",
        ],
        actionItems: [
          task("Send the pricing sheet to the harbor office", "Ana", "Friday"),
          task("Write the push alert texts"),
        ],
        openQuestions: ["Who pays for the buoy data feed?"],
      },
      attendees: [{ name: "ana reyes" }],
    });
    addMeeting({
      id: "m3",
      folder: "f1",
      day: 5,
      title: "Raw notes",
      markdown: "# Raw\n\nline",
    });
    addMeeting({ id: "m4", folder: "f1", day: 6, title: "No summary" });
    addMeeting({
      id: "other",
      folder: "f2",
      day: 2,
      summary: { decisions: ["Other folder decision"] },
    });
    insertSpeaker("m1", "S1", { displayName: "Ana Reyes" });
    insertSpeaker("m1", "S2", { displayName: null });
    insertSpeaker("m2", "S1", { displayName: "Carla" });
    insertSpeaker("m2", "S2", { displayName: "Carla B", mergedInto: "S1" });
    const db = getDb();
    db.exec(
      "INSERT INTO tags (id, name, created_at) VALUES ('t1','beta',1),('t2','mobile',1)",
    );
    db.exec(
      "INSERT INTO meeting_tags (meeting_id, tag_id, source, created_at) VALUES ('m1','t1','user',1),('m2','t1','user',1),('m2','t2','user',1),('other','t2','user',1)",
    );
  }

  it("de-duplicates decisions and action items with their sources", async () => {
    seed();
    const o = await overview();
    expect(o.decisions.map((d) => d.text)).toEqual([
      "Close the beta to 50 boat owners",
      "Use React Native for the mobile app",
    ]);
    const merged = o.decisions[1];
    expect(merged?.sources.map((s) => s.meeting_id)).toEqual(["m2", "m1"]);
    expect(o.action_items.map((a) => a.text)).toEqual([
      "Write the push alert texts",
      "Send the pricing sheet to the harbor office",
    ]);
    expect(o.action_items[1]).toMatchObject({
      owner: "Ana",
      due: "Friday",
      done: false,
    });
    expect(o.action_items[1]?.sources.map((s) => s.meeting_id)).toEqual([
      "m2",
      "m1",
    ]);
    expect(o.open_questions).toHaveLength(1);
    expect(o.open_questions[0]?.sources).toHaveLength(2);
  });

  it("reports counts, timeline, people, tags and the folder scope", async () => {
    seed();
    const o = await overview();
    expect(o.counts).toMatchObject({
      meetings: 4,
      summarized: 3,
      total_duration_ms: 240000,
      first_meeting_at: T0 + DAY,
      last_meeting_at: T0 + 6 * DAY,
    });
    expect(
      o.counts.stage_counts.summarize.ready +
        o.counts.stage_counts.summarize.blocked,
    ).toBeGreaterThanOrEqual(0);
    expect(o.timeline.map((t) => t.meeting_id)).toEqual([
      "m4",
      "m3",
      "m2",
      "m1",
    ]);
    expect(o.timeline.map((t) => t.gist)).toEqual([
      null,
      "Raw",
      "Beta starts in May",
      "We set the goal for the app.",
    ]);
    expect(o.people).toEqual([
      { name: "Ana Reyes", meeting_count: 2 },
      { name: "Ben Ito", meeting_count: 1 },
      { name: "Carla", meeting_count: 1 },
    ]);
    expect(o.tags).toEqual([
      { name: "beta", meeting_count: 2 },
      { name: "mobile", meeting_count: 1 },
    ]);
    expect(JSON.stringify(o)).not.toContain("Other folder decision");
    expect(o.last_activity).toBeGreaterThan(T0 + 6 * DAY);
  });

  it("changes after a re-summarize and after a move", async () => {
    seed();
    saveSummary("m2", { decisions: ["Hire a second designer"] });
    let o = await overview();
    expect(o.decisions.map((d) => d.text)).toContain("Hire a second designer");
    expect(o.action_items.map((a) => a.text)).toEqual([
      "Send the pricing sheet to the harbor office",
    ]);
    getDb()
      .prepare("UPDATE meetings SET folder_id = 'f2' WHERE id = 'm1'")
      .run();
    o = await overview();
    expect(o.decisions.map((d) => d.text)).toEqual(["Hire a second designer"]);
    expect(o.action_items).toEqual([]);
  });
});

describe("PUT /folders/:id/action-items/:key", () => {
  function twoMeetings() {
    addFolder("f1");
    addMeeting({
      id: "m1",
      folder: "f1",
      day: 1,
      summary: {
        actionItems: [task("Book the demo room for the beta launch")],
      },
    });
    addMeeting({
      id: "m2",
      folder: "f1",
      day: 2,
      summary: {
        actionItems: [task("Book the demo room for the beta launch")],
      },
    });
  }

  it("marks an item done and open again, and the mark persists", async () => {
    twoMeetings();
    const [item] = (await overview()).action_items;
    expect(item?.key).toBe(
      actionItemKey("m1", "Book the demo room for the beta launch"),
    );
    const res = await put(item?.key ?? "", true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: item?.key, done: true });
    expect((await overview()).action_items[0]?.done).toBe(true);
    await put(item?.key ?? "", false);
    expect((await overview()).action_items[0]?.done).toBe(false);
  });

  it("keeps the mark when a newer meeting repeats the item", async () => {
    addFolder("f1");
    addMeeting({
      id: "m1",
      folder: "f1",
      day: 1,
      summary: {
        actionItems: [task("Book the demo room for the beta launch")],
      },
    });
    const [item] = (await overview()).action_items;
    await put(item?.key ?? "", true);
    addMeeting({
      id: "m2",
      folder: "f1",
      day: 2,
      summary: {
        actionItems: [task("Book the demo room for the beta launch")],
      },
    });
    const after = (await overview()).action_items;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ key: item?.key, done: true });
    expect(after[0]?.sources).toHaveLength(2);
  });

  it("keeps the mark when a re-summarize writes the same task", async () => {
    twoMeetings();
    const [item] = (await overview()).action_items;
    await put(item?.key ?? "", true);
    saveSummary("m1", {
      actionItems: [task("  BOOK the demo room for the beta launch ")],
    });
    expect((await overview()).action_items[0]?.done).toBe(true);
  });

  it("opens the item again when a re-summarize writes new text", async () => {
    addFolder("f1");
    addMeeting({
      id: "m1",
      folder: "f1",
      day: 1,
      summary: {
        actionItems: [task("Book the demo room for the beta launch")],
      },
    });
    const [item] = (await overview()).action_items;
    await put(item?.key ?? "", true);
    saveSummary("m1", {
      actionItems: [task("Reserve the big room for the beta launch day")],
    });
    const [after] = (await overview()).action_items;
    expect(after?.done).toBe(false);
    expect(after?.key).not.toBe(item?.key);
  });

  it("answers 404 and 400 for bad requests", async () => {
    twoMeetings();
    const key = actionItemKey("m1", "Book the demo room for the beta launch");
    expect((await put(key, true, "nope")).status).toBe(404);
    const missing = await put("0123456789abcdef", true);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "item_not_found" });
    expect((await put("short", true)).status).toBe(400);
    const bad = await jsonRequest(
      app,
      "PUT",
      `${base}/f1/action-items/${key}`,
      {
        done: "yes",
      },
    );
    expect(bad.status).toBe(400);
  });

  it("deletes the marks with the folder", async () => {
    twoMeetings();
    const [item] = (await overview()).action_items;
    await put(item?.key ?? "", true);
    getDb().exec("DELETE FROM meetings");
    expect((await app.request(`${base}/f1`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM folder_action_item_state")
        .get(),
    ).toEqual({ n: 0 });
  });
});
